// The database guard must run before PrismaClient is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../../scripts/test-db-env.cjs");

import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  cleanupImportWorld,
  EMPTY_DRAFT_JSON,
  FIXED_NOW,
  seedImportWorld,
  seedSession,
  type ImportWorld,
} from "../../test-utils/import-session-harness";
import {
  addProjectWithCard,
  addSoftDeletedAnchor,
  bootRecoveryApp,
  insertMany,
  receiptV1,
  seedApplied,
  sessionRow,
  UI_HEADERS,
  type RecoveryApp,
  type SnapshotLineSeed,
} from "../../test-utils/import-session-recovery-harness";

/**
 * B1b independent QA (test-only). Complements the builder's recovery specs with cases the
 * builder did not pin: applied-list keyset at scale for a RESTRICTED viewer, equal-timestamp
 * page boundaries, an ACL x corruption cross-product with a LITERAL expectation table,
 * executed SQL parameters, receipt immutability against REAL Expense/CFE rows, zero writes
 * (DB digest + recorded statements), log hygiene and concurrent CAS cancel of a corrupt draft.
 * Real PrismaService / JwtStrategy / global guards, default-OFF kill switch, injected clock.
 */
const PREFIX = "imp-b1b-qa";
const setup = new PrismaClient();
let world: ImportWorld;
let api: RecoveryApp;
let gone: { projectId: string; cardId: string };
jest.setTimeout(180_000);

const notFound = { code: "NOT_FOUND", retryable: false };
const invalidInput = { code: "INVALID_INPUT", retryable: false };
const ids = (reply: { json: any }): string[] =>
  reply.json.items.map((item: { id: string }) => item.id);
const list = (token: string, query = "") =>
  api.call("GET", `/import-sessions${query}`, { token });
const get = (token: string, id: string, suffix = "") =>
  api.call("GET", `/import-sessions/${id}${suffix}`, { token });
const cancel = (token: string, id: string, revision: number) =>
  api.call("POST", `/import-sessions/${id}/cancel`, {
    token,
    headers: UI_HEADERS,
    body: { expectedRevision: revision },
  });
const enc = encodeURIComponent;

async function pages(token: string, state: "active" | "applied") {
  const all: string[] = [];
  const sizes: number[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 40; guard++) {
    const reply: { status: number; json: any } = await list(
      token,
      `?state=${state}${cursor ? `&cursor=${enc(cursor)}` : ""}`,
    );
    expect(reply.status).toBe(200);
    sizes.push(reply.json.items.length);
    all.push(...ids(reply));
    cursor = reply.json.nextCursor;
    if (!cursor) break;
  }
  return { all, sizes };
}

/** An APPLIED row with a valid receipt; `hiddenTarget` adds the CASA project the restricted user cannot see. */
function appliedRow(
  ownerId: string,
  index: number,
  options: { hiddenTarget?: boolean; closedAt?: Date; createdAt?: Date } = {},
) {
  const row = sessionRow(world, ownerId, index, {
    state: "APPLIED",
    financialRequestId: randomUUID(),
    confirmedRevision: 1,
    confirmedSessionVersion: 0,
    confirmedAt: FIXED_NOW,
    proposalHash: "b".repeat(64),
    closedAt: options.closedAt ?? new Date(FIXED_NOW.getTime() - index * 1000),
    ...(options.createdAt ? { createdAt: options.createdAt } : {}),
  });
  row.receiptJson = JSON.stringify(
    receiptV1(row.id as string, world.projects.pessoal, [
      {
        sourceProjectId: world.projects.pessoal,
        targets: options.hiddenTarget
          ? [{ projectId: world.projects.casa, amountCents: 100 }]
          : [],
      },
    ]),
  );
  return row;
}

async function inChunks<T, R>(
  items: T[],
  size: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(run))));
  }
  return out;
}

/** Everything a read could conceivably touch, serialised in a stable order. */
async function digest(): Promise<string> {
  const scope = { tenantId: { in: [world.tenantId, world.otherTenantId] } };
  return JSON.stringify({
    sessions: await setup.importSession.findMany({ orderBy: { id: "asc" } }),
    artifacts: await setup.importSessionArtifact.findMany({
      where: scope,
      orderBy: { id: "asc" },
    }),
    users: await setup.user.findMany({
      where: scope,
      orderBy: { id: "asc" },
    }),
    tenants: await setup.tenant.findMany({
      where: { id: { in: [world.tenantId, world.otherTenantId] } },
      orderBy: { id: "asc" },
    }),
    expenses: await setup.expense.findMany({
      where: scope,
      orderBy: { id: "asc" },
    }),
    cashFlow: await setup.cashFlowEntry.findMany({
      where: scope,
      orderBy: { id: "asc" },
    }),
    activity: await setup.userActivityLog.count({ where: scope }),
  });
}

interface Recorded {
  sql: string;
  values: unknown[];
  kind: "read" | "write";
}
const WRITE_METHOD =
  /^(create|createMany|update|updateMany|upsert|delete|deleteMany)$/;

/** Wraps the REAL PrismaService transaction so every statement of a read is recorded, not mocked. */
function recordTransactions(): { statements: Recorded[]; restore: () => void } {
  const prisma = api.app.get(PrismaService);
  const original = prisma.$transaction.bind(prisma) as (
    fn: (tx: any) => Promise<unknown>,
    options?: unknown,
  ) => Promise<unknown>;
  const statements: Recorded[] = [];
  const wrap = (tx: any) =>
    new Proxy(tx, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (property === "$queryRaw") {
          return (strings: TemplateStringsArray, ...values: unknown[]) => {
            const flat = Prisma.sql(strings, ...values);
            statements.push({
              sql: flat.sql,
              values: flat.values,
              kind: "read",
            });
            return value.call(target, strings, ...values);
          };
        }
        if (
          typeof property === "string" &&
          /^\$(executeRaw|executeRawUnsafe|queryRawUnsafe)$/.test(property)
        ) {
          return (...args: unknown[]) => {
            statements.push({
              sql: String(property),
              values: args,
              kind: "write",
            });
            return value.apply(target, args);
          };
        }
        if (
          value &&
          typeof value === "object" &&
          typeof property === "string"
        ) {
          return new Proxy(value, {
            get(delegate, method) {
              const fn = Reflect.get(delegate, method);
              if (typeof method === "string" && typeof fn === "function") {
                return (...args: unknown[]) => {
                  statements.push({
                    sql: `${property}.${method}`,
                    values: args,
                    kind: WRITE_METHOD.test(method) ? "write" : "read",
                  });
                  return fn.apply(delegate, args);
                };
              }
              return fn;
            },
          });
        }
        return value;
      },
    });
  const spy = jest
    .spyOn(prisma, "$transaction")
    .mockImplementation(((
      fn: (tx: any) => Promise<unknown>,
      options?: unknown,
    ) => original((tx: any) => fn(wrap(tx)), options)) as any);
  return { statements, restore: () => spy.mockRestore() };
}

describe("B1b independent QA — recovery list and immutable receipt", () => {
  beforeAll(async () => {
    await setup.$connect();
    world = await seedImportWorld(setup, PREFIX);
    gone = await addSoftDeletedAnchor(setup, world, "qa");
    api = await bootRecoveryApp(setup);
  });
  afterAll(async () => {
    await api.close();
    await setup.cashFlowEntry.deleteMany({
      where: { tenantId: world.tenantId },
    });
    await cleanupImportWorld(setup, PREFIX);
    await setup.$disconnect();
  });
  beforeEach(async () => {
    api.clock.current = FIXED_NOW;
    await setup.cashFlowEntry.deleteMany({
      where: { tenantId: world.tenantId },
    });
    await setup.expense.deleteMany({ where: { tenantId: world.tenantId } });
    await setup.importSessionArtifact.deleteMany({
      where: { tenantId: world.tenantId },
    });
    await setup.importSession.deleteMany({
      where: { tenantId: { in: [world.tenantId, world.otherTenantId] } },
    });
    await setup.user.updateMany({
      where: { tenantId: world.tenantId },
      data: { sessionVersion: 0 },
    });
    await setup.user.updateMany({
      where: { id: { in: [world.users.restricted.id, world.users.peer.id] } },
      data: {
        allowedModules: JSON.stringify(["creditCards", "expenses"]),
        allowedProjects: JSON.stringify([world.projects.pessoal]),
        allowedProjectTypes: "[]",
      },
    });
  });

  describe("applied keyset at scale for a restricted viewer (ACL decided before LIMIT)", () => {
    // Literal oracle: row i has closedAt = now - i s, so the expected order is ascending i.
    it.each([
      [
        "160 hidden receipts NEWER than 30 visible ones",
        (i: number) => i >= 160 && i < 190,
        190,
      ],
      [
        "30 visible interleaved with 180 hidden (every 7th)",
        (i: number) => i % 7 === 0,
        210,
      ],
    ])(
      "%s: pages 25+5, exact ids, and every row's GET agrees",
      async (_l, visible, total) => {
        const R = world.users.restricted;
        const rows = Array.from({ length: total }, (_v, i) =>
          appliedRow(R.id, i, { hiddenTarget: !visible(i) }),
        );
        await insertMany(setup, rows);
        const expected = rows
          .filter((_row, i) => visible(i))
          .map((row) => row.id as string);
        expect(expected).toHaveLength(30);

        const token = await api.tokenFor(R);
        const { all, sizes } = await pages(token, "applied");
        expect(sizes).toEqual([25, 5]);
        expect(all).toEqual(expected);

        // Parity for EVERY row: listed <=> GET session 200 <=> GET result 200, else the opaque 404.
        const statuses = await inChunks(rows, 15, async (row) => {
          const id = row.id as string;
          const session = await get(token, id);
          const result = await get(token, id, "/result");
          return {
            id,
            session: session.status,
            result: result.status,
            body: session.json,
          };
        });
        for (const item of statuses) {
          const listed = expected.includes(item.id);
          expect([item.id, item.session, item.result]).toEqual([
            item.id,
            listed ? 200 : 404,
            listed ? 200 : 404,
          ]);
          if (!listed) expect(item.body).toMatchObject(notFound);
        }
      },
    );

    it("the owner (unrestricted) sees all 210 across pages: 25 x 8 + 10", async () => {
      const owner = world.users.owner;
      const rows = Array.from({ length: 210 }, (_v, i) =>
        appliedRow(owner.id, i, { hiddenTarget: i % 7 !== 0 }),
      );
      await insertMany(setup, rows);
      const { all, sizes } = await pages(await api.tokenFor(owner), "applied");
      expect(sizes).toEqual([25, 25, 25, 25, 25, 25, 25, 25, 10]);
      expect(all).toEqual(rows.map((row) => row.id as string));
    });
  });

  describe("equal sort keys across the page boundary (keyset tie-break by id DESC)", () => {
    it("60 active drafts with ONE createdAt: pages 25/25/10, no duplicate, no skip, id DESC", async () => {
      const owner = world.users.owner;
      const rows = Array.from({ length: 60 }, (_v, i) =>
        sessionRow(world, owner.id, i, { createdAt: FIXED_NOW }),
      );
      await insertMany(setup, rows);
      const expected = rows
        .map((row) => row.id as string)
        .sort()
        .reverse();
      const { all, sizes } = await pages(await api.tokenFor(owner), "active");
      expect(sizes).toEqual([25, 25, 10]);
      expect(all).toEqual(expected);
    });

    it("60 applied receipts with ONE closedAt and 15 hidden interleaved (restricted): 25+20, id DESC", async () => {
      const R = world.users.restricted;
      const rows = Array.from({ length: 60 }, (_v, i) =>
        appliedRow(R.id, i, {
          hiddenTarget: i % 4 === 0,
          closedAt: FIXED_NOW,
        }),
      );
      await insertMany(setup, rows);
      const expected = rows
        .filter((_row, i) => i % 4 !== 0)
        .map((row) => row.id as string)
        .sort()
        .reverse();
      expect(expected).toHaveLength(45);
      const { all, sizes } = await pages(await api.tokenFor(R), "applied");
      expect(sizes).toEqual([25, 20]);
      expect(all).toEqual(expected);
    });
  });

  describe("tenant/owner scoping and executed SQL", () => {
    it("newer rows of a peer (same tenant) and of another tenant never shrink the owner's page or feed the cursor", async () => {
      const owner = world.users.owner;
      const mine = Array.from({ length: 30 }, (_v, i) =>
        sessionRow(world, owner.id, 100 + i),
      );
      const peers = Array.from({ length: 60 }, (_v, i) =>
        sessionRow(world, world.users.peer.id, i),
      );
      const foreign = Array.from({ length: 60 }, (_v, i) =>
        sessionRow(world, world.users.foreign.id, i, {
          tenantId: world.otherTenantId,
          ownerProjectId: world.projects.foreign,
          cardId: world.cards.foreign,
        }),
      );
      await insertMany(setup, [...peers, ...foreign, ...mine]);
      const { all, sizes } = await pages(await api.tokenFor(owner), "active");
      expect(sizes).toEqual([25, 5]);
      expect(all).toEqual(mine.map((row) => row.id as string));
    });

    it("binds tenant and owner as parameters and both precede the LIMIT; the read issues no writer", async () => {
      const owner = world.users.owner;
      await insertMany(setup, [sessionRow(world, owner.id, 0)]);
      const token = await api.tokenFor(owner);
      const recording = recordTransactions();
      try {
        expect((await list(token)).status).toBe(200);
        expect((await list(token, "?state=applied")).status).toBe(200);
      } finally {
        recording.restore();
      }
      const raw = recording.statements.filter((s) =>
        /FROM import_sessions/.test(s.sql),
      );
      expect(raw).toHaveLength(2);
      for (const statement of raw) {
        const tenantAt = statement.sql.indexOf("s.tenant_id =");
        const ownerAt = statement.sql.indexOf("s.owner_user_id =");
        const limitAt = statement.sql.lastIndexOf("LIMIT");
        expect(tenantAt).toBeGreaterThan(-1);
        expect(ownerAt).toBeGreaterThan(tenantAt);
        expect(limitAt).toBeGreaterThan(ownerAt);
        expect(statement.values).toContain(world.tenantId);
        expect(statement.values).toContain(owner.id);
        expect(statement.values.indexOf(world.tenantId)).toBeLessThan(
          statement.values.indexOf(owner.id),
        );
        expect(statement.values[statement.values.length - 1]).toBe(26);
      }
      expect(recording.statements.filter((s) => s.kind === "write")).toEqual(
        [],
      );
      expect(
        recording.statements.some((s) =>
          /\b(INSERT|UPDATE|DELETE)\b/i.test(s.sql),
        ),
      ).toBe(false);
    });
  });

  describe("ACL x corruption cross-product (literal expectations; rule 5, no GET500/list-omit oracle)", () => {
    type Outcome = { get: 200 | 404 | 500; list: "include" | "omit" | 500 };
    interface Case {
      label: string;
      lines: () => SnapshotLineSeed[];
      mutate?: (receipt: Record<string, any>) => void;
      owner: Outcome;
      restricted: Outcome;
    }
    const P = () => world.projects.pessoal;
    const CASA = () => world.projects.casa;
    const withCasa = () => [
      {
        sourceProjectId: P(),
        targets: [{ projectId: CASA(), amountCents: 100 }],
      },
    ];
    const O500: Outcome = { get: 500, list: 500 };
    const HIDE: Outcome = { get: 404, list: "omit" };
    const OK: Outcome = { get: 200, list: "include" };
    const badMoney = (r: Record<string, any>) => {
      r["snapshot"].lines[0].totalCents = -1;
    };
    const badSchedule = (r: Record<string, any>) => {
      r["snapshot"].lines[0].schedule.occurrences[0].valor = 1;
    };
    const setParticipants = (value: unknown) => (r: Record<string, any>) => {
      r["snapshot"].participantProjectIds = value;
    };

    const cases: Case[] = [
      {
        label: "clean, only the anchor",
        lines: () => [{ sourceProjectId: P() }],
        owner: OK,
        restricted: OK,
      },
      {
        label: "clean, CASA target (outside the restricted grant)",
        lines: withCasa,
        owner: OK,
        restricted: HIDE,
      },
      {
        label: "CASA target + negative money",
        lines: withCasa,
        mutate: badMoney,
        owner: O500,
        restricted: HIDE,
      },
      {
        label: "CASA target + schedule that does not sum",
        lines: withCasa,
        mutate: badSchedule,
        owner: O500,
        restricted: HIDE,
      },
      {
        label: "CASA target + items not an array",
        lines: withCasa,
        mutate: (r) => {
          r["items"] = "x";
        },
        owner: O500,
        restricted: HIDE,
      },
      {
        label: "CASA target + unknown top-level key",
        lines: withCasa,
        mutate: (r) => {
          r["extra"] = 1;
        },
        owner: O500,
        restricted: HIDE,
      },
      {
        label: "CASA target + envelope unsorted with duplicate",
        lines: withCasa,
        mutate: (r) => setParticipants([CASA(), P(), CASA()])(r),
        owner: O500,
        restricted: HIDE,
      },
      {
        label: "anchor project missing from the envelope (only CASA listed)",
        lines: withCasa,
        mutate: (r) => {
          r["snapshot"].participantProjectIds = [CASA()];
        },
        owner: O500,
        restricted: HIDE,
      },
      {
        label: "anchor-only + negative money",
        lines: () => [{ sourceProjectId: P() }],
        mutate: badMoney,
        owner: O500,
        restricted: O500,
      },
      {
        label: "nonexistent participant + negative money",
        lines: () => [
          {
            sourceProjectId: P(),
            targets: [{ projectId: "nope-project", amountCents: 100 }],
          },
        ],
        mutate: badMoney,
        owner: HIDE,
        restricted: HIDE,
      },
      {
        label: "soft-deleted participant + negative money",
        lines: () => [
          {
            sourceProjectId: P(),
            targets: [{ projectId: gone.projectId, amountCents: 100 }],
          },
        ],
        mutate: badMoney,
        owner: HIDE,
        restricted: HIDE,
      },
      {
        label: "other-tenant participant + negative money",
        lines: () => [
          {
            sourceProjectId: P(),
            targets: [{ projectId: world.projects.foreign, amountCents: 100 }],
          },
        ],
        mutate: badMoney,
        owner: HIDE,
        restricted: HIDE,
      },
      {
        label: "empty-string participant (textual, absent) + negative money",
        lines: () => [{ sourceProjectId: P() }],
        mutate: (r) => {
          r["snapshot"].participantProjectIds = [""];
          badMoney(r);
        },
        owner: HIDE,
        restricted: HIDE,
      },
      {
        label: "10k-char participant id + negative money",
        lines: () => [{ sourceProjectId: P() }],
        mutate: (r) => {
          r["snapshot"].participantProjectIds = ["x".repeat(10_000)];
          badMoney(r);
        },
        owner: HIDE,
        restricted: HIDE,
      },
      {
        label: "envelope: snapshot removed",
        lines: () => [{ sourceProjectId: P() }],
        mutate: (r) => {
          delete r["snapshot"];
        },
        owner: O500,
        restricted: O500,
      },
      {
        label: "envelope: snapshot null",
        lines: () => [{ sourceProjectId: P() }],
        mutate: (r) => {
          r["snapshot"] = null;
        },
        owner: O500,
        restricted: O500,
      },
      {
        label: "envelope: snapshot is an array",
        lines: () => [{ sourceProjectId: P() }],
        mutate: (r) => {
          r["snapshot"] = [];
        },
        owner: O500,
        restricted: O500,
      },
      {
        label: "envelope: participants missing",
        lines: () => [{ sourceProjectId: P() }],
        mutate: (r) => {
          delete r["snapshot"].participantProjectIds;
        },
        owner: O500,
        restricted: O500,
      },
      {
        label: "envelope: participants is a string",
        lines: () => [{ sourceProjectId: P() }],
        mutate: setParticipants("pessoal"),
        owner: O500,
        restricted: O500,
      },
      {
        label: "envelope: participants is an object",
        lines: () => [{ sourceProjectId: P() }],
        mutate: setParticipants({ 0: "x" }),
        owner: O500,
        restricted: O500,
      },
      {
        label: "envelope: empty array",
        lines: () => [{ sourceProjectId: P() }],
        mutate: setParticipants([]),
        owner: O500,
        restricted: O500,
      },
      {
        label: "envelope: number element",
        lines: () => [{ sourceProjectId: P() }],
        mutate: setParticipants([1]),
        owner: O500,
        restricted: O500,
      },
      {
        label: "envelope: null element",
        lines: () => [{ sourceProjectId: P() }],
        mutate: setParticipants([null]),
        owner: O500,
        restricted: O500,
      },
      {
        label: "envelope: nested array element",
        lines: () => [{ sourceProjectId: P() }],
        mutate: setParticipants([["x"]]),
        owner: O500,
        restricted: O500,
      },
      {
        label: "envelope: hidden text + a number (non-text wins over hidden)",
        lines: withCasa,
        mutate: (r) => {
          r["snapshot"].participantProjectIds = [CASA(), 7];
        },
        owner: O500,
        restricted: O500,
      },
    ];

    it.each(cases.map((c) => [c.label, c] as const))(
      "%s",
      async (_label, testCase) => {
        for (const who of ["owner", "restricted"] as const) {
          await setup.importSession.deleteMany({
            where: { tenantId: world.tenantId },
          });
          const viewer = world.users[who];
          const seeded = await seedApplied(setup, world, {
            owner: viewer,
            participants: testCase.lines(),
            mutate: testCase.mutate,
          });
          const token = await api.tokenFor(viewer);
          const expected = testCase[who];
          const logging = jest
            .spyOn(Logger.prototype, "error")
            .mockImplementation(() => undefined);
          try {
            const session = await get(token, seeded.id);
            const result = await get(token, seeded.id, "/result");
            const listed = await list(token, "?state=applied");
            expect([who, "session", session.status]).toEqual([
              who,
              "session",
              expected.get,
            ]);
            expect([who, "result", result.status]).toEqual([
              who,
              "result",
              expected.get,
            ]);
            if (expected.list === "include") {
              expect([who, listed.status, ids(listed)]).toEqual([
                who,
                200,
                [seeded.id],
              ]);
            } else if (expected.list === "omit") {
              expect([who, listed.status, listed.json]).toEqual([
                who,
                200,
                {
                  items: [],
                  nextCursor: null,
                  entry: {
                    kind: "UNAVAILABLE",
                    version: 1,
                    reason: "NOT_ENABLED",
                  },
                },
              ]);
            } else {
              expect([who, listed.status, listed.json]).toEqual([
                who,
                500,
                { statusCode: 500, message: "Internal server error" },
              ]);
            }
            if (expected.get === 404)
              expect(session.json).toMatchObject(notFound);
            if (expected.get === 500)
              expect(session.json).toEqual({
                statusCode: 500,
                message: "Internal server error",
              });
          } finally {
            logging.mockRestore();
          }
        }
      },
    );

    it("a page mixing hidden+corrupt, authorised-corrupt and clean rows: the hidden one is omitted, the authorised-corrupt one is a 500 for the whole page", async () => {
      const R = world.users.restricted;
      const clean = await seedApplied(setup, world, { owner: R, index: 3 });
      await seedApplied(setup, world, {
        owner: R,
        index: 1,
        participants: withCasa(),
        mutate: badMoney,
      });
      const token = await api.tokenFor(R);
      expect(ids(await list(token, "?state=applied"))).toEqual([clean.id]);
      const spy = jest
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => undefined);
      try {
        await seedApplied(setup, world, {
          owner: R,
          index: 2,
          mutate: badMoney,
        });
        expect((await list(token, "?state=applied")).status).toBe(500);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("duplicate JSON keys: SQL (json_each) and JS (JSON.parse) may disagree — only the safe direction is pinned", () => {
    // SQLite reads the FIRST duplicate, JSON.parse the LAST. Receipts are server-written
    // (JSON.stringify never duplicates), so this is reachable only through a writer bug or a
    // hand edit. The invariant that must hold: a row the GET denies (404) never surfaces as a summary.
    it.each([
      ["hidden participants first, valid last", "first"],
      ["valid first, hidden participants last", "last"],
    ])("%s", async (_label, where) => {
      const R = world.users.restricted;
      const seeded = await seedApplied(setup, world, { owner: R });
      const valid = JSON.stringify(
        receiptV1(seeded.id, world.projects.pessoal, [
          { sourceProjectId: world.projects.pessoal },
        ]),
      );
      const hiddenEnvelope = `{"participantProjectIds":["${world.projects.casa}"]}`;
      const json =
        where === "first"
          ? `{"snapshot":${hiddenEnvelope},${valid.slice(1)}`
          : `${valid.slice(0, -1)},"snapshot":${hiddenEnvelope}}`;
      await setup.importSession.update({
        where: { id: seeded.id },
        data: { receiptJson: json },
      });
      const token = await api.tokenFor(R);
      const spy = jest
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => undefined);
      try {
        const listed = await list(token, "?state=applied");
        const session = await get(token, seeded.id);
        if (session.status === 404) {
          expect(listed.status === 200 ? ids(listed) : []).not.toContain(
            seeded.id,
          );
          expect(listed.text).not.toContain(seeded.id);
        }
        if (listed.status === 200 && ids(listed).includes(seeded.id)) {
          expect(session.status).not.toBe(404);
        }
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("project-shaped keys never reach ProjectAccessGuard on the five intake handlers", () => {
    // Contract: 400 uniform for the list, and for every other handler the extra key is IGNORED:
    // same status and bytes as the request without it, whatever the caller's role and whatever
    // the project id (in-tenant outside the grant, other tenant, nonexistent). The extras are
    // never an ACL selector either: owner/tenant/anchor/card ACL decides.
    const KEYS = ["projectId", "sourceProjectId", "targetProjectId"];
    type Who = "owner" | "restricted" | "unrestricted";
    const WHO: Who[] = ["owner", "restricted", "unrestricted"];
    const handlers = {
      get: (id: string, q: string) =>
        ["GET", `/import-sessions/${id}${q}`] as const,
      result: (id: string, q: string) =>
        ["GET", `/import-sessions/${id}/result${q}`] as const,
      cancel: (id: string, q: string) =>
        ["POST", `/import-sessions/${id}/cancel${q}`] as const,
      create: (_id: string, q: string) =>
        ["POST", `/import-sessions${q}`] as const,
    };
    const call = (
      token: string,
      handler: keyof typeof handlers,
      id: string,
      q: string,
    ) => {
      const [method, path] = handlers[handler](id, q);
      return api.call(method, path, {
        token,
        headers: UI_HEADERS,
        body:
          handler === "cancel"
            ? { expectedRevision: 99 }
            : handler === "create"
              ? {}
              : undefined,
      });
    };

    it.each(WHO)(
      "%s: list is the handler's 400 for every key and every project value, and 200 without the extra",
      async (who) => {
        const other = await addProjectWithCard(setup, world, `keys-${who}`);
        await setup.user.update({
          where: { id: world.users.peer.id },
          data: { allowedProjects: "[]" },
        });
        const user =
          who === "owner"
            ? world.users.owner
            : who === "restricted"
              ? world.users.restricted
              : world.users.peer;
        const token = await api.tokenFor(user);
        expect((await list(token)).status).toBe(200);
        for (const key of [...KEYS, "tenantId"]) {
          for (const value of [
            world.projects.pessoal,
            other.projectId,
            world.projects.foreign,
            "nope-project",
          ]) {
            for (const query of [
              `?${key}=${enc(value)}`,
              `?state=applied&${key}=${enc(value)}`,
            ]) {
              const reply = await list(token, query);
              expect([who, query, reply.status]).toEqual([who, query, 400]);
              expect(reply.json).toMatchObject(invalidInput);
            }
          }
        }
      },
    );

    it.each(WHO)(
      "%s: get/result/cancel/create ignore the extra (same status and body as without it), for own and for another owner's session",
      async (who) => {
        const other = await addProjectWithCard(setup, world, `ign-${who}`);
        await setup.user.update({
          where: { id: world.users.peer.id },
          data: { allowedProjects: "[]" },
        });
        const user =
          who === "owner"
            ? world.users.owner
            : who === "restricted"
              ? world.users.restricted
              : world.users.peer;
        const own = await seedSession(setup, world, { ownerUserId: user.id });
        const others = await seedSession(setup, world, {
          ownerUserId:
            who === "owner" ? world.users.restricted.id : world.users.owner.id,
        });
        const token = await api.tokenFor(user);
        const expectedBaseline = {
          get: { own: 200, others: 404 },
          result: { own: 200, others: 404 },
          cancel: { own: 409, others: 404 },
          create: { own: 503, others: 503 },
        } as const;
        for (const handler of Object.keys(handlers) as Array<
          keyof typeof handlers
        >) {
          for (const [label, id] of [
            ["own", own.id],
            ["others", others.id],
          ] as const) {
            const baseline = await call(token, handler, id, "");
            expect([who, handler, label, baseline.status]).toEqual([
              who,
              handler,
              label,
              expectedBaseline[handler][label],
            ]);
            for (const key of KEYS) {
              for (const value of [
                world.projects.pessoal,
                other.projectId,
                world.projects.foreign,
                "nope-project",
              ]) {
                const reply = await call(
                  token,
                  handler,
                  id,
                  `?${key}=${enc(value)}`,
                );
                expect([who, handler, label, key, value, reply.status]).toEqual(
                  [who, handler, label, key, value, baseline.status],
                );
                expect(reply.json).toEqual(baseline.json);
              }
            }
          }
        }
      },
    );

    it("extras never select the ACL: a hidden-participant receipt and a revoked card module stay 404 even when the extra names the caller's own granted project", async () => {
      const R = world.users.restricted;
      const hiddenReceipt = await seedApplied(setup, world, {
        owner: R,
        participants: [
          {
            sourceProjectId: world.projects.pessoal,
            targets: [{ projectId: world.projects.casa, amountCents: 100 }],
          },
        ],
      });
      const token = await api.tokenFor(R);
      for (const key of KEYS) {
        const q = `?${key}=${enc(world.projects.pessoal)}`;
        expect((await get(token, hiddenReceipt.id + q)).status).toBe(404);
        expect((await get(token, hiddenReceipt.id, `/result${q}`)).status).toBe(
          404,
        );
        // Applied stays a transition error for the authorised owner, extras or not.
        expect(
          (
            await api.call(
              "POST",
              `/import-sessions/${hiddenReceipt.id}/cancel${q}`,
              {
                token,
                headers: UI_HEADERS,
                body: { expectedRevision: 1 },
              },
            )
          ).status,
        ).toBe(409);
      }
      await setup.user.update({
        where: { id: R.id },
        data: { allowedModules: JSON.stringify(["expenses"]) },
      });
      const draft = await seedSession(setup, world, { ownerUserId: R.id });
      for (const key of KEYS) {
        expect(
          (
            await get(
              token,
              draft.id + `?${key}=${enc(world.projects.pessoal)}`,
            )
          ).status,
        ).toBe(404);
      }
    });

    it("auth still comes first: no token / revoked sessionVersion => 401 with project-shaped keys", async () => {
      const revoked = world.users.peer;
      const token = await api.tokenFor(revoked);
      await setup.user.update({
        where: { id: revoked.id },
        data: { sessionVersion: 9 },
      });
      for (const key of KEYS) {
        const q = `?${key}=${enc(world.projects.pessoal)}`;
        for (const t of [undefined, token]) {
          for (const path of [
            "/import-sessions",
            `/import-sessions/${randomUUID()}`,
          ]) {
            const reply = await api.call("GET", path + q, { token: t });
            expect([key, path.length, reply.status]).toEqual([
              key,
              path.length,
              401,
            ]);
          }
        }
      }
    });
  });

  describe("cursor age boundaries on the injected clock", () => {
    const thirty = async () => {
      const owner = world.users.owner;
      await insertMany(
        setup,
        Array.from({ length: 30 }, (_v, i) => sessionRow(world, owner.id, i)),
      );
      const token = await api.tokenFor(owner);
      const first = await list(token);
      return { token, cursor: first.json.nextCursor as string };
    };
    it.each([
      [-1, 400],
      [0, 200],
      [899_999, 200],
      [900_000, 400],
      [900_001, 400],
    ])(
      "cursor presented %i ms after it was issued => %i",
      async (delta, status) => {
        const { token, cursor } = await thirty();
        api.clock.current = new Date(FIXED_NOW.getTime() + delta);
        const reply = await list(token, `?cursor=${enc(cursor)}`);
        expect(reply.status).toBe(status);
        if (status === 400) expect(reply.json).toMatchObject(invalidInput);
      },
    );
  });

  describe("identity precedes the key gate over real HTTP; grants corruption is fail-closed 401", () => {
    const withWeakSecret = async (run: () => Promise<void>) => {
      const previous = {
        node: process.env["NODE_ENV"],
        secret: process.env["JWT_SECRET"],
      };
      try {
        process.env["NODE_ENV"] = "production";
        process.env["JWT_SECRET"] = "short";
        await run();
      } finally {
        if (previous.node === undefined) delete process.env["NODE_ENV"];
        else process.env["NODE_ENV"] = previous.node;
        if (previous.secret === undefined) delete process.env["JWT_SECRET"];
        else process.env["JWT_SECRET"] = previous.secret;
      }
    };

    it("revoked sessionVersion / soft-deleted user with an unsafe secret => 401; a valid actor => 503", async () => {
      const revoked = world.users.peer;
      const deleted = world.users.restricted;
      const valid = world.users.owner;
      const tokens = {
        revoked: await api.tokenFor(revoked),
        deleted: await api.tokenFor(deleted),
        valid: await api.tokenFor(valid),
      };
      await setup.user.update({
        where: { id: revoked.id },
        data: { sessionVersion: 5 },
      });
      await setup.user.update({
        where: { id: deleted.id },
        data: { deletedAt: new Date() },
      });
      try {
        await withWeakSecret(async () => {
          const a = await list(tokens.revoked);
          const b = await list(tokens.deleted);
          const c = await list(tokens.valid);
          expect([a.status, a.json?.code]).toEqual([401, "UNAUTHENTICATED"]);
          expect([b.status, b.json?.code]).toEqual([401, "UNAUTHENTICATED"]);
          expect([c.status, c.json?.code]).toEqual([
            503,
            "CAPABILITY_DISABLED",
          ]);
        });
      } finally {
        await setup.user.update({
          where: { id: deleted.id },
          data: { deletedAt: null },
        });
      }
    });

    it.each([
      ["allowedProjects", "not json"],
      ["allowedModules", '{"a":1}'],
      ["allowedProjectTypes", "[1,2]"],
      ["allowedProjects", ""],
    ])(
      "corrupted %s (%s) is a typed 401 on list, GET, result and cancel — never a 500 nor an empty grant",
      async (column, value) => {
        const R = world.users.restricted;
        const seeded = await seedSession(setup, world, { ownerUserId: R.id });
        const token = await api.tokenFor(R);
        await setup.user.update({
          where: { id: R.id },
          data: { [column]: value },
        });
        const replies = [
          await list(token),
          await get(token, seeded.id),
          await get(token, seeded.id, "/result"),
          await cancel(token, seeded.id, 1),
        ];
        for (const reply of replies) {
          expect([column, reply.status, reply.json?.code]).toEqual([
            column,
            401,
            "UNAUTHENTICATED",
          ]);
        }
        expect(
          (
            await setup.importSession.findUniqueOrThrow({
              where: { id: seeded.id },
            })
          ).state,
        ).toBe("DRAFT");
      },
    );
  });

  describe("receipt is immutable against REAL Expense/CFE rows", () => {
    it("editing, soft-deleting and hard-deleting the source Expense and its CFE leaves session, result and list byte-identical", async () => {
      const owner = world.users.owner;
      const seeded = await seedApplied(setup, world, { owner });
      const expenseId = "exp-line-1";
      await setup.expense.create({
        data: {
          id: expenseId,
          tenantId: world.tenantId,
          projectId: world.projects.pessoal,
          tipoDespesa: "MATERIAL_CONSTRUCAO",
          valor: 12_345,
          valorTotal: 12_345,
          formaPagamento: "A_VISTA",
        },
      });
      const flow = await setup.cashFlowEntry.create({
        data: {
          tenantId: world.tenantId,
          projectId: world.projects.pessoal,
          expenseId,
          valor: 12_345,
          tipo: "DESPESA",
          data: FIXED_NOW,
          categoria: "MATERIAL_CONSTRUCAO",
          status: "PLANEJADO",
        },
      });
      const token = await api.tokenFor(owner);
      const read = async () => [
        (await get(token, seeded.id)).text,
        (await get(token, seeded.id, "/result")).text,
        (await list(token, "?state=applied")).text,
      ];
      const before = await read();
      expect(before[0]).toContain('"totalCents":10000');
      expect(before[0]).not.toContain("12345");

      await setup.expense.update({
        where: { id: expenseId },
        data: { valor: 99_999, valorTotal: 99_999, tipoDespesa: "MARCENARIA" },
      });
      await setup.cashFlowEntry.update({
        where: { id: flow.id },
        data: { valor: 99_999 },
      });
      expect(await read()).toEqual(before);

      await setup.expense.update({
        where: { id: expenseId },
        data: { deletedAt: FIXED_NOW },
      });
      await setup.cashFlowEntry.update({
        where: { id: flow.id },
        data: { deletedAt: FIXED_NOW },
      });
      expect(await read()).toEqual(before);

      await setup.cashFlowEntry.delete({ where: { id: flow.id } });
      await setup.expense.delete({ where: { id: expenseId } });
      expect(await read()).toEqual(before);
    });
  });

  describe("reads write nothing (DB digest + recorded statements)", () => {
    it("list (both filters, second page), GET session/result, 404 and corrupt 500 leave every touched table identical", async () => {
      const owner = world.users.owner;
      const R = world.users.restricted;
      await insertMany(setup, [
        ...Array.from({ length: 30 }, (_v, i) =>
          sessionRow(world, owner.id, i),
        ),
        ...Array.from({ length: 30 }, (_v, i) => appliedRow(owner.id, i + 40)),
        appliedRow(R.id, 0, { hiddenTarget: true }),
      ]);
      const broken = await seedApplied(setup, world, {
        owner,
        index: 90,
        receiptJson: '{"snapshot":{"participantProjectIds":[]}}',
      });
      const applied = (
        await setup.importSession.findFirstOrThrow({
          where: {
            ownerUserId: owner.id,
            state: "APPLIED",
            NOT: { id: broken.id },
          },
        })
      ).id;
      const tokens = {
        owner: await api.tokenFor(owner),
        restricted: await api.tokenFor(R),
      };
      const before = await digest();
      const recording = recordTransactions();
      const spy = jest
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => undefined);
      try {
        for (const token of [tokens.owner, tokens.restricted]) {
          const first = await list(token);
          if (first.json?.nextCursor)
            await list(token, `?cursor=${enc(first.json.nextCursor)}`);
          await list(token, "?state=applied");
          await get(token, applied);
          await get(token, applied, "/result");
          await get(token, randomUUID());
          await get(token, broken.id);
        }
      } finally {
        spy.mockRestore();
        recording.restore();
      }
      expect(recording.statements.length).toBeGreaterThan(10);
      expect(recording.statements.filter((s) => s.kind === "write")).toEqual(
        [],
      );
      expect(
        recording.statements.filter((s) =>
          /\b(INSERT|UPDATE|DELETE)\b/i.test(s.sql),
        ),
      ).toEqual([]);
      expect(await digest()).toBe(before);
    });
  });

  describe("log hygiene", () => {
    it("corrupt receipt/draft, 503 gate and cancel log class/session/column only: no OCR sentinel, cursor, token nor secret", async () => {
      const owner = world.users.owner;
      const token = await api.tokenFor(owner);
      const SENTINEL = "SENTINEL_OCR_9f3c1a";
      const secret = process.env["JWT_SECRET"] ?? "dev-secret-change-me";
      const badReceipt = await seedApplied(setup, world, {
        owner,
        index: 5,
        mutate: (r) => {
          r["snapshot"].lines[0].titulo = SENTINEL;
          r["snapshot"].lines[0].totalCents = SENTINEL;
        },
      });
      const badDraft = await seedSession(setup, world, {
        ownerUserId: owner.id,
        draftJson: JSON.stringify({
          version: 1,
          lines: SENTINEL,
          ocr: SENTINEL,
        }),
      });
      await insertMany(
        setup,
        Array.from({ length: 30 }, (_v, i) =>
          sessionRow(world, owner.id, i + 10),
        ),
      );
      const firstPage = await list(token);
      const cursor = firstPage.json.nextCursor as string;

      const captured: string[] = [];
      const push = (...args: unknown[]) => {
        captured.push(
          args
            .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
            .join(" "),
        );
      };
      const spies = (
        ["error", "warn", "log", "debug", "verbose", "fatal"] as const
      ).map((m) =>
        jest.spyOn(Logger.prototype, m).mockImplementation(push as any),
      );
      const consoles = (["error", "warn", "log", "info", "debug"] as const).map(
        (m) => jest.spyOn(console, m).mockImplementation(push as any),
      );
      const previous = {
        node: process.env["NODE_ENV"],
        secret: process.env["JWT_SECRET"],
      };
      const responses: string[] = [];
      try {
        responses.push((await get(token, badReceipt.id)).text);
        responses.push((await get(token, badReceipt.id, "/result")).text);
        responses.push((await list(token, "?state=applied")).text);
        responses.push((await get(token, badDraft.id)).text);
        responses.push((await list(token, `?cursor=${enc(cursor)}`)).text);
        responses.push((await cancel(token, badDraft.id, 1)).text);
        process.env["NODE_ENV"] = "production";
        process.env["JWT_SECRET"] = "short";
        responses.push((await list(token, `?cursor=${enc(cursor)}`)).text);
      } finally {
        if (previous.node === undefined) delete process.env["NODE_ENV"];
        else process.env["NODE_ENV"] = previous.node;
        if (previous.secret === undefined) delete process.env["JWT_SECRET"];
        else process.env["JWT_SECRET"] = previous.secret;
        spies.forEach((s) => s.mockRestore());
        consoles.forEach((s) => s.mockRestore());
      }
      const log = captured.join("\n");
      expect(log).toContain(badReceipt.id);
      expect(log).toContain(badDraft.id);
      expect(log).toContain("ImportSessionCorruptStateError");
      for (const forbidden of [
        SENTINEL,
        cursor,
        token,
        secret,
        "short",
        "titulo",
        "totalCents",
        "Mercado",
      ]) {
        expect([forbidden.slice(0, 16), log.includes(forbidden)]).toEqual([
          forbidden.slice(0, 16),
          false,
        ]);
      }
      // The two 500 bodies are the generic envelope; none of the responses echoes the sentinel.
      for (const body of responses.slice(0, 5))
        expect(body).not.toContain(SENTINEL);
    });
  });

  describe("CANCEL of an APPLIED session (Security mediation on lines 395-435)", () => {
    // The owner with an authorised anchor and card gets the canonical transition error even
    // when a receipt participant was revoked (GET/result 404, list omitted): the error carries
    // ONLY the error-protocol fields and no financial payload; another owner or a revoked
    // anchor/card keeps the opaque 404.
    const PROTOCOL_KEYS = [
      "code",
      "currentRevision",
      "reason",
      "retryable",
      "sessionId",
    ];
    const FORBIDDEN_BODY =
      /receipt|proposal|snapshot|lines|titulo|totalCents|participant|items/i;
    const appliedState = (id: string) =>
      setup.importSession.findUniqueOrThrow({ where: { id } });

    it.each([
      ["clean receipt, every participant visible", false, undefined],
      ["participant revoked (CASA outside the grant)", true, undefined],
      [
        "participant revoked AND money corrupt",
        true,
        (r: Record<string, any>) => {
          r["snapshot"].lines[0].totalCents = -1;
        },
      ],
    ])(
      "%s: 409 ALREADY_APPLIED with protocol fields only, no write",
      async (_l, hidden, mutate) => {
        const R = world.users.restricted;
        const seeded = await seedApplied(setup, world, {
          owner: R,
          participants: [
            {
              sourceProjectId: world.projects.pessoal,
              targets: hidden
                ? [{ projectId: world.projects.casa, amountCents: 100 }]
                : [],
            },
          ],
          mutate,
        });
        const token = await api.tokenFor(R);
        const before = await appliedState(seeded.id);
        const logging = jest
          .spyOn(Logger.prototype, "error")
          .mockImplementation(() => undefined);
        try {
          for (const revision of [1, 99]) {
            const reply = await cancel(token, seeded.id, revision);
            expect([revision, reply.status]).toEqual([revision, 409]);
            expect(Object.keys(reply.json).sort()).toEqual(PROTOCOL_KEYS);
            expect(reply.json).toEqual({
              code: "ALREADY_APPLIED",
              retryable: false,
              sessionId: seeded.id,
              currentRevision: 1,
              reason: null,
            });
            expect(reply.text).not.toMatch(FORBIDDEN_BODY);
          }
          if (hidden) {
            // The read side of the same row stays opaque.
            expect((await get(token, seeded.id)).status).toBe(404);
            expect((await get(token, seeded.id, "/result")).status).toBe(404);
            expect(ids(await list(token, "?state=applied"))).toEqual([]);
          }
        } finally {
          logging.mockRestore();
        }
        expect(await appliedState(seeded.id)).toEqual(before);
      },
    );

    it("the applied list never offers CANCEL", async () => {
      const owner = world.users.owner;
      await insertMany(setup, [
        appliedRow(owner.id, 0),
        appliedRow(owner.id, 1),
      ]);
      const reply = await list(await api.tokenFor(owner), "?state=applied");
      expect(reply.json.items).toHaveLength(2);
      for (const item of reply.json.items) {
        expect(item.actions).toEqual(["READ_RESULT"]);
      }
    });

    it("stays the opaque 404 for another owner, a foreign tenant, a revoked anchor and a revoked card module", async () => {
      const R = world.users.restricted;
      const mine = await seedApplied(setup, world, { owner: R });
      const goneAnchor = await seedApplied(setup, world, {
        owner: world.users.owner,
        anchorProjectId: gone.projectId,
        cardId: gone.cardId,
      });
      const before = [
        await appliedState(mine.id),
        await appliedState(goneAnchor.id),
      ];

      for (const [who, id] of [
        [world.users.peer, mine.id],
        [world.users.foreign, mine.id],
        [world.users.owner, goneAnchor.id],
      ] as const) {
        const reply = await cancel(await api.tokenFor(who), id, 1);
        expect([who.id, reply.status]).toEqual([who.id, 404]);
        expect(reply.json).toMatchObject(notFound);
        expect(reply.text).not.toMatch(FORBIDDEN_BODY);
      }

      const token = await api.tokenFor(R);
      await setup.user.update({
        where: { id: R.id },
        data: { allowedModules: JSON.stringify(["expenses"]) },
      });
      const noCards = await cancel(token, mine.id, 1);
      expect([noCards.status, noCards.json?.code]).toEqual([404, "NOT_FOUND"]);
      expect([
        await appliedState(mine.id),
        await appliedState(goneAnchor.id),
      ]).toEqual(before);
    });
  });

  describe("CAS cancel of a corrupt draft (executed, concurrent)", () => {
    it("two concurrent cancels at revision 1: one CAS wins, final state CANCELLED at revision 2, no Expense/CFE effect, and the draft leaves the active list", async () => {
      const owner = world.users.owner;
      const seeded = await seedSession(setup, world, {
        ownerUserId: owner.id,
        draftJson: '{"version":1,"lines":"not-an-array"}',
      });
      const token = await api.tokenFor(owner);
      const summary = (await list(token)).json.items[0];
      expect([summary.id, summary.revision, summary.actions]).toEqual([
        seeded.id,
        1,
        ["CANCEL"],
      ]);
      const financialBefore = [
        await setup.expense.count({ where: { tenantId: world.tenantId } }),
        await setup.cashFlowEntry.count({
          where: { tenantId: world.tenantId },
        }),
      ];

      const outcomes = await Promise.all([
        cancel(token, seeded.id, summary.revision),
        cancel(token, seeded.id, summary.revision),
      ]);
      const statuses = outcomes.map((o) => o.status).sort();
      expect(statuses.every((s) => s === 200 || s === 409)).toBe(true);
      expect(statuses).toContain(200);
      for (const outcome of outcomes.filter((o) => o.status === 200)) {
        expect(outcome.json.state).toBe("CANCELLED");
      }

      const row = await setup.importSession.findUniqueOrThrow({
        where: { id: seeded.id },
      });
      expect([row.state, row.revision]).toEqual(["CANCELLED", 2]);
      expect(row.closedAt).not.toBeNull();
      // Terminal cancel purges the draft payload (corrupt or not) down to the empty draft.
      expect(row.draftJson).toBe(EMPTY_DRAFT_JSON);
      expect([
        await setup.expense.count({ where: { tenantId: world.tenantId } }),
        await setup.cashFlowEntry.count({
          where: { tenantId: world.tenantId },
        }),
      ]).toEqual(financialBefore);
      expect(ids(await list(token))).toEqual([]);

      // A late retry is an idempotent no-op: nothing renewed, revision unchanged.
      const late = await cancel(token, seeded.id, 1);
      expect([late.status, late.json?.state]).toEqual([200, "CANCELLED"]);
      expect(
        (
          await setup.importSession.findUniqueOrThrow({
            where: { id: seeded.id },
          })
        ).revision,
      ).toBe(2);
    });
  });
});
