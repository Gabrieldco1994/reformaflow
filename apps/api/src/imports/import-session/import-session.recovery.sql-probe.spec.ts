// The database guard must run before PrismaClient is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../../scripts/test-db-env.cjs");

import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  cleanupImportWorld,
  FIXED_NOW,
  seedImportWorld,
  seedSession,
  type ImportWorld,
} from "../../test-utils/import-session-harness";
import {
  addSoftDeletedAnchor,
  insertMany,
  sessionRow,
} from "../../test-utils/import-session-recovery-harness";

/**
 * B1b runtime probes (characterisation, GREEN): they pin the facts the list query design
 * rests on, measured on the real SQLite/Prisma runtime, not assumed.
 *
 *  1. JSON1 is available and the contract's visibility CASE behaves as specified.
 *  2. Prisma stores DateTime as INTEGER epoch milliseconds (never REAL/TEXT) and a Date bound
 *     in $queryRaw is compared as the same integer, so `expires_at > now` is strict to 1 ms.
 *  3. The list query seeks by (tenant_id, owner_user_id) with an existing index: no SCAN of
 *     import_sessions, even with thousands of rows and 150+ invisible rows before the first
 *     visible one. LIMIT 26 alone is NOT the proof: the plan and the measured time are.
 *  4. A Prisma interactive read transaction is one consistent snapshot against a concurrent
 *     writer (the reason the recovery reads share ONE read transaction).
 *
 * BUDGET (to be re-verified before activation, together with the throttle): with 14k rows in
 * the tenant and 5.4k for the owner, the first page of either list must stay under
 * LIST_BUDGET_MS median. Measured on the dev machine: ~2-3 ms, i.e. >80x of margin.
 */
const PREFIX = "imp-probe";
const LIST_BUDGET_MS = 250;
const setup = new PrismaClient();
/** SQLite integers come back as BigInt from raw queries. */
const plain = <T>(value: T): T =>
  JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? Number(v) : v)),
  );
let world: ImportWorld;
jest.setTimeout(120_000);

const VISIBLE_APPLIED =
  (all: number, allowedJson: string) => (tenantId: string, ownerId: string) =>
    setup.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT s.id FROM import_sessions s
     WHERE s.tenant_id = ? AND s.owner_user_id = ? AND s.state = 'APPLIED'
       AND CASE
         WHEN NOT json_valid(s.receipt_json) THEN 1
         WHEN json_type(s.receipt_json, '$.snapshot.participantProjectIds') IS NOT 'array' THEN 1
         WHEN EXISTS (SELECT 1 FROM json_each(s.receipt_json, '$.snapshot.participantProjectIds') q WHERE q.type <> 'text') THEN 1
         WHEN json_array_length(s.receipt_json, '$.snapshot.participantProjectIds') = 0 THEN 1
         ELSE NOT EXISTS (SELECT 1 FROM json_each(s.receipt_json, '$.snapshot.participantProjectIds') q
           WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.tenant_id = s.tenant_id AND p.id = q.value
             AND p.deleted_at IS NULL
             AND (? = 1 OR p.id IN (SELECT value FROM json_each(?)))))
       END = 1
     ORDER BY s.closed_at DESC, s.id DESC LIMIT 26`,
      tenantId,
      ownerId,
      all,
      allowedJson,
    );

const receiptWith = (participants: unknown) =>
  JSON.stringify({ snapshot: { participantProjectIds: participants } });
const appliedRow = (
  index: number,
  receiptJson: string,
  ownerId = () => world.users.owner.id,
) =>
  sessionRow(world, ownerId(), index, {
    state: "APPLIED",
    financialRequestId: randomUUID(),
    confirmedRevision: 1,
    confirmedSessionVersion: 0,
    confirmedAt: FIXED_NOW,
    proposalHash: "b".repeat(64),
    receiptJson,
    closedAt: new Date(FIXED_NOW.getTime() - index * 1000),
  });

describe("B1b runtime probes (JSON1, temporal storage, plan, budget, read snapshot)", () => {
  beforeAll(async () => {
    await setup.$connect();
    world = await seedImportWorld(setup, PREFIX);
  });
  afterAll(async () => {
    await cleanupImportWorld(setup, PREFIX);
    await setup.$disconnect();
  });
  beforeEach(async () => {
    await setup.importSession.deleteMany({
      where: { tenantId: { in: [world.tenantId, world.otherTenantId] } },
    });
  });

  describe("JSON1 and the visibility CASE", () => {
    it("has JSON1 functions and binds a JSON array parameter into json_each", async () => {
      const [row] = await setup.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT json_valid('{}') AS valid, json_type('{"a":["x",1]}','$.a') AS type,
                json_array_length('{"a":["x",1]}','$.a') AS length,
                (SELECT group_concat(type) FROM json_each('{"a":["x",1]}','$.a')) AS types`,
      );
      expect(plain(row)).toEqual({
        valid: 1,
        type: "array",
        length: 2,
        types: "text,integer",
      });
      const bound = JSON.stringify(["a", "b"]);
      const [hit] = await setup.$queryRaw<
        Array<{ c: bigint }>
      >`SELECT count(*) AS c FROM json_each(${bound}) WHERE value IN ('a')`;
      expect(Number(hit!.c)).toBe(1);
    });

    it("the database CHECK refuses syntactically invalid receipt JSON (fixtures must not disable it)", async () => {
      await expect(
        seedSession(setup, world, {
          state: "APPLIED",
          financialRequestId: randomUUID(),
          confirmedRevision: 1,
          confirmedSessionVersion: 0,
          confirmedAt: FIXED_NOW,
          proposalHash: "b".repeat(64),
          closedAt: FIXED_NOW,
          receiptJson: '{"snapshot": ',
        }),
      ).rejects.toThrow();
    });

    it("includes malformed-but-valid JSON (so the strict parser can answer 500) and excludes unauthorised participants", async () => {
      const ownerId = world.users.owner.id;
      const gone = await addSoftDeletedAnchor(setup, world, "probe");
      const cases: Array<[string, string, boolean]> = [
        ["valid pessoal", receiptWith([world.projects.pessoal]), true],
        [
          "valid pessoal+casa (ALL)",
          receiptWith([world.projects.pessoal, world.projects.casa]),
          true,
        ],
        [
          "participants not an array",
          JSON.stringify({ snapshot: { participantProjectIds: "x" } }),
          true,
        ],
        ["snapshot absent", "{}", true],
        ["non-text member", receiptWith([world.projects.pessoal, 7]), true],
        ["empty participants", receiptWith([]), true],
        [
          "soft-deleted participant",
          receiptWith([world.projects.pessoal, gone.projectId]),
          false,
        ],
        [
          "other-tenant participant",
          receiptWith([world.projects.pessoal, world.projects.foreign]),
          false,
        ],
        [
          "non-existent participant",
          receiptWith([world.projects.pessoal, "nope"]),
          false,
        ],
      ];
      await insertMany(
        setup,
        cases.map(([, json], index) => appliedRow(index, json)),
      );
      const visible = new Set(
        (await VISIBLE_APPLIED(1, "[]")(world.tenantId, ownerId)).map(
          (row) => row.id,
        ),
      );
      const rows = await setup.importSession.findMany({
        where: { tenantId: world.tenantId },
        orderBy: { closedAt: "desc" },
      });
      const byReceipt = new Map(rows.map((row) => [row.receiptJson, row.id]));
      for (const [label, json, expected] of cases) {
        expect([label, visible.has(byReceipt.get(json)!)]).toEqual([
          label,
          expected,
        ]);
      }
      // A restricted grant (pessoal only) hides the casa participant even though ALL sees it.
      const restricted = new Set(
        (
          await VISIBLE_APPLIED(0, JSON.stringify([world.projects.pessoal]))(
            world.tenantId,
            ownerId,
          )
        ).map((row) => row.id),
      );
      expect(restricted.has(byReceipt.get(cases[1]![1])!)).toBe(false);
      expect(restricted.has(byReceipt.get(cases[0]![1])!)).toBe(true);
    });
  });

  describe("temporal storage", () => {
    it("Prisma persists DateTime as INTEGER epoch ms and a bound Date compares strictly to the millisecond", async () => {
      const seeded = await seedSession(setup, world, {
        expiresAt: new Date(FIXED_NOW.getTime() + 1000),
      });
      const [types] = await setup.$queryRaw<
        Array<Record<string, unknown>>
      >`SELECT typeof(created_at) AS created, typeof(expires_at) AS expires, typeof(consented_at) AS consented, typeof(closed_at) AS closed, CAST(expires_at AS INTEGER) AS raw FROM import_sessions WHERE id = ${seeded.id}`;
      expect(plain(types)).toEqual({
        created: "integer",
        expires: "integer",
        consented: "integer",
        closed: "null",
        raw: FIXED_NOW.getTime() + 1000,
      });
      const edge = seeded.expiresAt;
      const count = async (at: Date) =>
        Number(
          (
            await setup.$queryRaw<
              Array<{ c: bigint }>
            >`SELECT count(*) AS c FROM import_sessions WHERE id = ${seeded.id} AND expires_at > ${at}`
          )[0]!.c,
        );
      expect([
        await count(new Date(edge.getTime() - 1)),
        await count(edge),
        await count(new Date(edge.getTime() + 1)),
      ]).toEqual([1, 0, 0]);
      const [bound] = await setup.$queryRaw<
        Array<{ t: string; v: number }>
      >`SELECT typeof(${edge}) AS t, ${edge} AS v`;
      expect(plain(bound)).toEqual({ t: "integer", v: edge.getTime() });
    });
  });

  describe("plan and measured cost with thousands of rows", () => {
    const owner = () => world.users.owner.id;
    const seedVolume = async () => {
      const gone = await addSoftDeletedAnchor(setup, world, "volume");
      const rows = [];
      // Owner: 3800 invisible-anchor drafts NEWER than 200 visible ones; 1000 cancelled.
      for (let i = 0; i < 3800; i++)
        rows.push(
          sessionRow(world, owner(), i, {
            ownerProjectId: gone.projectId,
            cardId: gone.cardId,
          }),
        );
      for (let i = 0; i < 200; i++)
        rows.push(sessionRow(world, owner(), 4000 + i));
      for (let i = 0; i < 1000; i++)
        rows.push(
          sessionRow(world, owner(), 5000 + i, {
            state: "CANCELLED",
            closedAt: FIXED_NOW,
          }),
        );
      // Owner applied: 2000 with an invisible participant NEWER than 100 visible ones.
      for (let i = 0; i < 2000; i++)
        rows.push(
          appliedRow(i, receiptWith([world.projects.pessoal, gone.projectId])),
        );
      for (let i = 2000; i < 2100; i++)
        rows.push(appliedRow(i, receiptWith([world.projects.pessoal])));
      // Noise: another user of the tenant and another tenant.
      for (let i = 0; i < 3000; i++)
        rows.push(sessionRow(world, world.users.peer.id, i));
      for (let i = 0; i < 4000; i++)
        rows.push(
          sessionRow(
            {
              ...world,
              tenantId: world.otherTenantId,
              projects: { ...world.projects, pessoal: world.projects.foreign },
              cards: { ...world.cards, pessoal: world.cards.foreign },
            },
            world.users.foreign.id,
            i,
          ),
        );
      await insertMany(setup, rows);
      return { gone, total: rows.length };
    };
    const median = async (run: () => Promise<unknown>) => {
      const samples: number[] = [];
      for (let i = 0; i < 5; i++) {
        const start = process.hrtime.bigint();
        await run();
        samples.push(Number(process.hrtime.bigint() - start) / 1e6);
      }
      return samples.sort((a, b) => a - b)[2]!;
    };
    const ACTIVE = `SELECT s.id FROM import_sessions s WHERE s.tenant_id = ? AND s.owner_user_id = ?
      AND s.state NOT IN ('APPLIED','CANCELLED','EXPIRED') AND s.expires_at > ?
      AND EXISTS (SELECT 1 FROM projects p WHERE p.tenant_id = s.tenant_id AND p.id = s.owner_project_id AND p.deleted_at IS NULL)
      AND EXISTS (SELECT 1 FROM credit_cards c WHERE c.tenant_id = s.tenant_id AND c.project_id = s.owner_project_id AND c.id = s.card_id AND c.deleted_at IS NULL)
      ORDER BY s.created_at DESC, s.id DESC LIMIT 26`;

    it("seeks by tenant+owner (no SCAN of import_sessions), never writes, and stays inside the budget", async () => {
      const { total } = await seedVolume();
      expect(total).toBeGreaterThan(14_000);
      const plan = (
        await setup.$queryRawUnsafe<Array<{ detail: string }>>(
          `EXPLAIN QUERY PLAN ${ACTIVE.replace(/\?/g, "1")}`,
        )
      ).map((row) => row.detail);
      const outer = plan.find(
        (detail) =>
          /import_sessions|\bs\b/.test(detail) &&
          /^(SEARCH|SCAN) s\b/.test(detail),
      );
      expect(outer).toMatch(
        /^SEARCH s USING (COVERING )?INDEX \S+ \(tenant_id=\? AND owner_user_id=\?/,
      );
      expect(plan.some((detail) => /^SCAN s\b/.test(detail))).toBe(false);

      const activeMs = await median(() =>
        setup.$queryRawUnsafe<Array<{ id: string }>>(
          ACTIVE,
          world.tenantId,
          owner(),
          FIXED_NOW,
        ),
      );
      const appliedMs = await median(() =>
        VISIBLE_APPLIED(1, "[]")(world.tenantId, owner()),
      );
      const emptyMs = await median(() =>
        setup.$queryRawUnsafe(
          ACTIVE,
          world.tenantId,
          world.users.restricted.id,
          FIXED_NOW,
        ),
      );
      // eslint-disable-next-line no-console
      console.log(
        `B1b list probe: active=${activeMs.toFixed(2)}ms applied=${appliedMs.toFixed(2)}ms ownerWithoutRows=${emptyMs.toFixed(2)}ms rows=${total}`,
      );
      expect(activeMs).toBeLessThan(LIST_BUDGET_MS);
      expect(appliedMs).toBeLessThan(LIST_BUDGET_MS);

      const first = await setup.$queryRawUnsafe<Array<{ id: string }>>(
        ACTIVE,
        world.tenantId,
        owner(),
        FIXED_NOW,
      );
      expect(first).toHaveLength(26); // 200 visible exist behind 3800 invisible ones: found, not truncated
    });
  });

  describe("read snapshot", () => {
    it("a Prisma interactive read transaction sees ONE snapshot while a second connection tries to write", async () => {
      const writer = new PrismaClient();
      try {
        await seedSession(setup, world, {});
        const inside = await setup.$transaction(async (tx) => {
          const before = await tx.importSession.count({
            where: { tenantId: world.tenantId },
          });
          let committed = false;
          const write = seedSession(writer, world, {}).then(() => {
            committed = true;
          });
          await new Promise((resolve) => setTimeout(resolve, 300));
          const after = await tx.importSession.count({
            where: { tenantId: world.tenantId },
          });
          return { before, after, committedDuringRead: committed, write };
        });
        await inside.write;
        expect([inside.before, inside.after]).toEqual([1, 1]);
        expect(
          await setup.importSession.count({
            where: { tenantId: world.tenantId },
          }),
        ).toBe(2);
      } finally {
        await writer.$disconnect();
      }
    });
  });
});
