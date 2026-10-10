// The database guard must run before PrismaClient is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../../scripts/test-db-env.cjs");

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";
import { Logger } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { ImportSessionService } from "./import-session.service";
import {
  authFor,
  cleanupImportWorld,
  FIXED_NOW,
  forgedAuthFor,
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
  type RecoveryApp,
} from "../../test-utils/import-session-recovery-harness";

/**
 * B1b RED — `GET /import-sessions?state=active|applied&cursor=` (list) and its parity with
 * GET session / GET result. Real PrismaService, real JwtStrategy and global guards, default
 * OFF kill switch, controllable clock. Contract: files/ai-import-contract-v1.md, section
 * "Recorte B1b" (sha256 faac058b…). Until the list route exists these fail with 404: that is
 * an ABSENT ROUTE, never a financial defect.
 */
const PREFIX = "imp-b1b-list";
const setup = new PrismaClient();
let world: ImportWorld;
let api: RecoveryApp;
jest.setTimeout(120_000);

const SUMMARY_KEYS = [
  "actions",
  "appliedAt",
  "attachmentCount",
  "cardId",
  "continuationSessionId",
  "createdAt",
  "expiresAt",
  "hasConfirmation",
  "id",
  "ownerProjectId",
  "revision",
  "state",
].sort();
const notFound = {
  code: "NOT_FOUND",
  retryable: false,
  sessionId: null,
  currentRevision: null,
  reason: null,
};
const invalidInput = {
  code: "INVALID_INPUT",
  retryable: false,
  sessionId: null,
  currentRevision: null,
  reason: null,
};

const list = (token: string, query = "") =>
  api.call("GET", `/import-sessions${query}`, { token });
async function allPages(token: string, state: "active" | "applied") {
  const ids: string[] = [];
  const pages: number[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 40; guard++) {
    const reply: { status: number; json: any } = await list(
      token,
      `?state=${state}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    expect(reply.status).toBe(200);
    pages.push(reply.json.items.length);
    ids.push(...reply.json.items.map((item: { id: string }) => item.id));
    cursor = reply.json.nextCursor;
    if (!cursor) break;
  }
  return { ids, pages };
}

describe("B1b RED — recovery list", () => {
  beforeAll(async () => {
    await setup.$connect();
    world = await seedImportWorld(setup, PREFIX);
    api = await bootRecoveryApp(setup);
  });
  afterAll(async () => {
    await api.close();
    await cleanupImportWorld(setup, PREFIX);
    await setup.$disconnect();
  });
  beforeEach(async () => {
    api.clock.current = FIXED_NOW;
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
      },
    });
  });

  describe("contract of the route", () => {
    it("is authenticated (typed 401), needs NO UI header, and works with the kill switch OFF", async () => {
      const anonymous = await api.call("GET", "/import-sessions");
      expect([anonymous.status, anonymous.json?.code]).toEqual([
        401,
        "UNAUTHENTICATED",
      ]);
      await seedSession(setup, world, { ownerUserId: world.users.owner.id });
      const reply = await list(await api.tokenFor(world.users.owner));
      expect(reply.status).toBe(200);
      expect(reply.json.items).toHaveLength(1);
      expect(reply.json.nextCursor).toBeNull();
    });

    it("defaults to active; any other state, duplicate/unknown query key or malformed value is 400 INVALID_INPUT", async () => {
      const token = await api.tokenFor(world.users.owner);
      const active = await seedSession(setup, world, {
        ownerUserId: world.users.owner.id,
      });
      expect(
        (await list(token)).json.items.map((item: { id: string }) => item.id),
      ).toEqual([active.id]);
      for (const query of [
        "?state=all",
        "?state=ACTIVE",
        "?state=",
        "?state=active&state=applied",
        "?state[]=active",
        "?tenantId=x",
        "?state=active&limit=100",
        "?cursor=",
        "?cursor=%00",
      ]) {
        const reply = await list(token, query);
        expect([query, reply.status, reply.json]).toEqual([
          query,
          400,
          invalidInput,
        ]);
      }
    });

    it("answers a page envelope with the exact summary keys and nothing private", async () => {
      const seeded = await seedSession(setup, world, {
        ownerUserId: world.users.owner.id,
        revision: 3,
        draftJson: JSON.stringify({
          version: 1,
          lines: [{ titulo: "SEGREDO-OCR" }],
          selectedLineIds: [],
          questions: [],
          scope: { observationIds: ["obs-secreta"], pendingAttachmentIds: [] },
        }),
        proposalHash: "c".repeat(64),
        preflightHash: "d".repeat(64),
      });
      const reply = await list(await api.tokenFor(world.users.owner));
      expect(reply.status).toBe(200);
      expect(Object.keys(reply.json).sort()).toEqual([
        "entry",
        "items",
        "nextCursor",
      ]);
      const [item] = reply.json.items;
      expect(Object.keys(item).sort()).toEqual(SUMMARY_KEYS);
      expect(item).toMatchObject({
        id: seeded.id,
        state: "DRAFT",
        revision: 3,
        cardId: world.cards.pessoal,
        ownerProjectId: world.projects.pessoal,
        appliedAt: null,
        attachmentCount: 0,
        hasConfirmation: false,
        continuationSessionId: null,
      });
      expect(item.expiresAt).toBe(seeded.expiresAt.toISOString());
      expect(item.createdAt).toBe(seeded.createdAt.toISOString());
      expect(item.actions).toEqual(expect.arrayContaining(["CANCEL"]));
      const text = JSON.stringify(reply.json);
      for (const forbidden of [
        "SEGREDO-OCR",
        "obs-secreta",
        "c".repeat(64),
        "d".repeat(64),
        "draft",
        "evidence",
        "fileName",
        "createRequestId",
        "ownerUserId",
        "tenantId",
      ]) {
        expect(text).not.toContain(forbidden);
      }
    });

    it("counts only non-RELEASED refs of THIS session, without reading blobs or another session", async () => {
      const mine = await seedSession(setup, world, {
        ownerUserId: world.users.owner.id,
      });
      const other = await seedSession(setup, world, {
        ownerUserId: world.users.owner.id,
        createdAt: new Date(FIXED_NOW.getTime() - 5000),
      });
      const ref = (sessionId: string, position: number, state: string) => ({
        id: randomUUID(),
        tenantId: world.tenantId,
        sessionId,
        ownerProjectId: world.projects.pessoal,
        position,
        fileName: `nome-${position}.pdf`,
        declaredMime: "application/pdf",
        declaredBytes: 10,
        state,
        reservedBytes: 10,
        releasedAt: state === "RELEASED" ? FIXED_NOW : null,
      });
      await setup.importSessionArtifact.createMany({
        data: [
          ref(mine.id, 0, "RESERVED"),
          ref(mine.id, 1, "RELEASED"),
          ref(mine.id, 2, "RESERVED"),
          ref(other.id, 0, "RESERVED"),
        ],
      });
      const reply = await list(await api.tokenFor(world.users.owner));
      const counts = Object.fromEntries(
        reply.json.items.map(
          (item: { id: string; attachmentCount: number }) => [
            item.id,
            item.attachmentCount,
          ],
        ),
      );
      expect(counts).toEqual({ [mine.id]: 2, [other.id]: 1 });
      expect(JSON.stringify(reply.json)).not.toContain("nome-");
    });

    it("applied summaries carry appliedAt, expiresAt:null, hasConfirmation and the continuation id ONLY from a validated receipt", async () => {
      const successor = randomUUID();
      const applied = await seedApplied(setup, world, {
        owner: world.users.owner,
        mutate: (receipt) => {
          receipt["continuationSessionId"] = successor;
        },
      });
      const reply = await list(
        await api.tokenFor(world.users.owner),
        "?state=applied",
      );
      expect(reply.status).toBe(200);
      expect(reply.json.items).toHaveLength(1);
      expect(reply.json.items[0]).toMatchObject({
        id: applied.id,
        state: "APPLIED",
        expiresAt: null,
        appliedAt: FIXED_NOW.toISOString(),
        hasConfirmation: true,
        continuationSessionId: successor,
      });
      expect(Object.keys(reply.json.items[0]).sort()).toEqual(SUMMARY_KEYS);
    });
  });

  describe("active predicate and order", () => {
    it("expiresAt == now is excluded, now+1ms is included; terminal and other users/tenants never appear", async () => {
      const owner = world.users.owner.id;
      const boundary = await seedSession(setup, world, {
        ownerUserId: owner,
        expiresAt: new Date(FIXED_NOW.getTime()),
      });
      const justAfter = await seedSession(setup, world, {
        ownerUserId: owner,
        expiresAt: new Date(FIXED_NOW.getTime() + 1),
      });
      await seedSession(setup, world, {
        ownerUserId: owner,
        state: "CANCELLED",
        closedAt: FIXED_NOW,
      });
      await seedSession(setup, world, {
        ownerUserId: owner,
        state: "EXPIRED",
        closedAt: FIXED_NOW,
      });
      await seedSession(setup, world, { ownerUserId: world.users.peer.id });
      const ids = (
        await list(await api.tokenFor(world.users.owner))
      ).json.items.map((item: { id: string }) => item.id);
      expect(ids).toEqual([justAfter.id]);
      expect(ids).not.toContain(boundary.id);
    });

    it("orders by createdAt DESC then id DESC (equal createdAt is broken by the literal id)", async () => {
      const owner = world.users.owner.id;
      const sameInstant = new Date(FIXED_NOW.getTime() - 60_000);
      const ids = [
        "00000000-0000-4000-8000-00000000000a",
        "00000000-0000-4000-8000-00000000000c",
        "00000000-0000-4000-8000-00000000000b",
      ];
      const newest = await seedSession(setup, world, {
        ownerUserId: owner,
        createdAt: FIXED_NOW,
      });
      const oldest = await seedSession(setup, world, {
        ownerUserId: owner,
        createdAt: new Date(FIXED_NOW.getTime() - 120_000),
      });
      for (const id of ids)
        await seedSession(setup, world, {
          ownerUserId: owner,
          id,
          createdAt: sameInstant,
        });
      const got = (
        await list(await api.tokenFor(world.users.owner))
      ).json.items.map((item: { id: string }) => item.id);
      expect(got).toEqual([newest.id, ids[1]!, ids[2]!, ids[0]!, oldest.id]);
    });

    it("applied uses closedAt DESC, id DESC and has NO seven-day cutoff", async () => {
      const owner = world.users.owner;
      const ancient = await seedApplied(setup, world, {
        owner,
        index: 1,
        closedAt: new Date(FIXED_NOW.getTime() - 400 * 86_400_000),
      });
      const recent = await seedApplied(setup, world, {
        owner,
        index: 2,
        closedAt: new Date(FIXED_NOW.getTime() - 1000),
      });
      const ids = (
        await list(await api.tokenFor(owner), "?state=applied")
      ).json.items.map((item: { id: string }) => item.id);
      expect(ids).toEqual([recent.id, ancient.id]);
    });
  });

  describe("pagination: fixed 25, 26th row decides the cursor, visibility BEFORE the limit", () => {
    const owner = () => world.users.owner;
    const draft = (index: number, extra = {}) =>
      sessionRow(world, owner().id, index, extra);

    it.each([
      [25, 0],
      [26, 1],
      [30, 5],
      [51, 1],
    ])(
      "with %i visible rows: first page 25, then %i more, never duplicated or skipped",
      async (visible, second) => {
        await insertMany(
          setup,
          Array.from({ length: visible }, (_v, i) => draft(i)),
        );
        const { ids, pages } = await allPages(
          await api.tokenFor(owner()),
          "active",
        );
        expect(pages[0]).toBe(25);
        expect(pages.length).toBe(visible === 25 ? 1 : visible === 51 ? 3 : 2);
        expect(pages[1] ?? 0).toBe(visible === 51 ? 25 : second);
        expect(new Set(ids).size).toBe(visible);
        const expected = (
          await setup.importSession.findMany({
            where: { ownerUserId: owner().id },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          })
        ).map((row) => row.id);
        expect(ids).toEqual(expected);
      },
    );

    it("exactly 25 visible has NO cursor; the 26th visible row is what creates one", async () => {
      await insertMany(
        setup,
        Array.from({ length: 25 }, (_v, i) => draft(i)),
      );
      expect(
        (await list(await api.tokenFor(owner()))).json.nextCursor,
      ).toBeNull();
      await insertMany(setup, [draft(99)]);
      expect((await list(await api.tokenFor(owner()))).json.nextCursor).toEqual(
        expect.any(String),
      );
    });

    it("150+ invisible rows NEWER than the last visible one do not shrink the page nor derive the cursor", async () => {
      const gone = await addSoftDeletedAnchor(setup, world, "a");
      const invisible = Array.from({ length: 170 }, (_v, i) =>
        draft(i, { ownerProjectId: gone.projectId, cardId: gone.cardId }),
      );
      const visible = Array.from({ length: 30 }, (_v, i) => draft(1000 + i));
      await insertMany(setup, [...invisible, ...visible]);
      const first = await list(await api.tokenFor(owner()));
      expect(first.json.items).toHaveLength(25);
      expect(first.json.nextCursor).toEqual(expect.any(String));
      const { ids, pages } = await allPages(
        await api.tokenFor(owner()),
        "active",
      );
      expect(pages).toEqual([25, 5]);
      expect(ids).toEqual(visible.map((row) => row.id));
    });

    it("200 invisible interleaved with 30 visible; and zero visible => empty page, no cursor", async () => {
      const gone = await addSoftDeletedAnchor(setup, world, "b");
      const rows = Array.from({ length: 230 }, (_v, i) =>
        i % 8 === 0 && i / 8 < 30
          ? draft(i)
          : draft(i, { ownerProjectId: gone.projectId, cardId: gone.cardId }),
      );
      const visibleIds = rows
        .filter((row) => row.ownerProjectId === world.projects.pessoal)
        .map((row) => row.id as string);
      await insertMany(setup, rows);
      const { ids, pages } = await allPages(
        await api.tokenFor(owner()),
        "active",
      );
      expect(visibleIds).toHaveLength(29);
      expect(ids).toEqual(visibleIds);
      expect(pages).toEqual([25, 4]);
      await setup.importSession.deleteMany({
        where: { id: { in: visibleIds } },
      });
      const empty = await list(await api.tokenFor(owner()));
      expect(empty.json).toEqual({
        items: [],
        nextCursor: null,
        entry: {
          kind: "UNAVAILABLE",
          version: 1,
          reason: "NOT_ENABLED",
        },
      });
      // Indistinguishable from an owner that never had a row.
      const never = await list(await api.tokenFor(world.users.restricted));
      expect(never.json).toEqual(empty.json);
      expect(never.status).toBe(empty.status);
    });

    it("the cursor is a keyset position: the row it points at may become invisible and the page continues", async () => {
      await insertMany(
        setup,
        Array.from({ length: 40 }, (_v, i) => draft(i)),
      );
      const token = await api.tokenFor(owner());
      const first = await list(token);
      const lastSeen: string = first.json.items[24].id;
      await setup.importSession.update({
        where: { id: lastSeen },
        data: { state: "CANCELLED", closedAt: FIXED_NOW },
      });
      const second = await list(
        token,
        `?cursor=${encodeURIComponent(first.json.nextCursor)}`,
      );
      expect(second.status).toBe(200);
      expect(second.json.items).toHaveLength(15);
      expect(
        second.json.items.map((item: { id: string }) => item.id),
      ).not.toContain(lastSeen);
    });
  });

  describe("cursor authenticity (HMAC, bound, expiring)", () => {
    const owner = () => world.users.owner;
    const firstCursor = async (state = "active") => {
      const token = await api.tokenFor(owner());
      const reply = await list(token, `?state=${state}`);
      expect(reply.json.nextCursor).toEqual(expect.any(String));
      return { token, cursor: reply.json.nextCursor as string };
    };
    beforeEach(async () => {
      await insertMany(
        setup,
        Array.from({ length: 30 }, (_v, i) => sessionRow(world, owner().id, i)),
      );
      for (let i = 0; i < 30; i++)
        await seedApplied(setup, world, { owner: owner(), index: i });
    });

    it("accepts its own cursor, then rejects tampering, truncation, junk and oversize with 400 INVALID_INPUT", async () => {
      const { token, cursor } = await firstCursor();
      expect(
        (await list(token, `?cursor=${encodeURIComponent(cursor)}`)).status,
      ).toBe(200);
      const flipped =
        cursor.slice(0, -2) + (cursor.endsWith("AA") ? "BB" : "AA");
      for (const bad of [
        flipped,
        cursor.slice(0, cursor.length - 5),
        cursor + "x",
        "AAAA",
        "a.b.c",
        "x".repeat(4096),
        "%",
        cursor.toUpperCase(),
      ]) {
        const reply = await list(token, `?cursor=${encodeURIComponent(bad)}`);
        expect([bad.slice(0, 12), reply.status, reply.json]).toEqual([
          bad.slice(0, 12),
          400,
          invalidInput,
        ]);
      }
    });

    it("is bound to user, tenant and filter: replaying it elsewhere is rejected", async () => {
      const { cursor } = await firstCursor("active");
      const other = await list(
        await api.tokenFor(world.users.restricted),
        `?cursor=${encodeURIComponent(cursor)}`,
      );
      expect([other.status, other.json]).toEqual([400, invalidInput]);
      const otherFilter = await list(
        await api.tokenFor(owner()),
        `?state=applied&cursor=${encodeURIComponent(cursor)}`,
      );
      expect([otherFilter.status, otherFilter.json]).toEqual([
        400,
        invalidInput,
      ]);
      const foreign = await list(
        await api.tokenFor(world.users.foreign),
        `?cursor=${encodeURIComponent(cursor)}`,
      );
      expect([foreign.status, foreign.json]).toEqual([400, invalidInput]);
    });

    it("expires after 900 s (899 s ok, 900 s rejected) using the injected clock", async () => {
      const { token, cursor } = await firstCursor();
      api.clock.current = new Date(FIXED_NOW.getTime() + 899_000);
      expect(
        (await list(token, `?cursor=${encodeURIComponent(cursor)}`)).status,
      ).toBe(200);
      api.clock.current = new Date(FIXED_NOW.getTime() + 900_000);
      const expired = await list(
        token,
        `?cursor=${encodeURIComponent(cursor)}`,
      );
      expect([expired.status, expired.json]).toEqual([400, invalidInput]);
    });

    it("applies the visibility predicate on every page: access lost between pages hides rows, never leaks them", async () => {
      const { token, cursor } = await firstCursor("applied");
      await setup.project.update({
        where: { id: world.projects.pessoal },
        data: { deletedAt: new Date(FIXED_NOW.getTime() - 1) },
      });
      try {
        const second = await list(
          token,
          `?state=applied&cursor=${encodeURIComponent(cursor)}`,
        );
        expect(second.status).toBe(200);
        expect(second.json).toEqual({
          items: [],
          nextCursor: null,
          entry: {
            kind: "UNAVAILABLE",
            version: 1,
            reason: "NOT_ENABLED",
          },
        });
      } finally {
        await setup.project.update({
          where: { id: world.projects.pessoal },
          data: { deletedAt: null },
        });
      }
    });

    it("a signing key from a missing/public/default secret is refused in production (gate, not fallback)", async () => {
      const previous = {
        node: process.env["NODE_ENV"],
        secret: process.env["JWT_SECRET"],
      };
      const { token, cursor } = await firstCursor();
      try {
        process.env["NODE_ENV"] = "production";
        for (const weak of [undefined, "", "dev-secret-change-me", "short"]) {
          if (weak === undefined) delete process.env["JWT_SECRET"];
          else process.env["JWT_SECRET"] = weak;
          const reply = await list(
            token,
            `?cursor=${encodeURIComponent(cursor)}`,
          );
          expect([String(weak), reply.status]).toEqual([String(weak), 503]);
          expect(reply.json).toMatchObject({
            code: "CAPABILITY_DISABLED",
            retryable: true,
          });
        }
      } finally {
        if (previous.node === undefined) delete process.env["NODE_ENV"];
        else process.env["NODE_ENV"] = previous.node;
        if (previous.secret === undefined) delete process.env["JWT_SECRET"];
        else process.env["JWT_SECRET"] = previous.secret;
      }
    });
  });

  describe("identity (401) precedes the cursor key gate (503), in the same read", () => {
    const WEAK = "short";
    const withWeakProductionSecret = async (run: () => Promise<void>) => {
      const previous = {
        node: process.env["NODE_ENV"],
        secret: process.env["JWT_SECRET"],
      };
      try {
        process.env["NODE_ENV"] = "production";
        process.env["JWT_SECRET"] = WEAK;
        await run();
      } finally {
        if (previous.node === undefined) delete process.env["NODE_ENV"];
        else process.env["NODE_ENV"] = previous.node;
        if (previous.secret === undefined) delete process.env["JWT_SECRET"];
        else process.env["JWT_SECRET"] = previous.secret;
      }
    };
    const codeOf = async (run: () => Promise<unknown>) => {
      try {
        await run();
        return "OK";
      } catch (error) {
        return (error as { code?: string }).code ?? String(error);
      }
    };
    const service = () => api.app.get(ImportSessionService, { strict: false });

    it("revoked session version + unsafe secret => 401; valid actor + unsafe secret => 503; forged context => 401", async () => {
      const owner = world.users.owner;
      await setup.user.update({
        where: { id: owner.id },
        data: { sessionVersion: 3 },
      });
      await withWeakProductionSecret(async () => {
        expect(
          await codeOf(() =>
            service().list(authFor(owner, { sessionVersion: 2 }), {}),
          ),
        ).toBe("UNAUTHENTICATED");
        expect(
          await codeOf(() =>
            service().list(authFor(owner, { sessionVersion: 3 }), {}),
          ),
        ).toBe("CAPABILITY_DISABLED");
        expect(
          await codeOf(() => service().list(forgedAuthFor(owner), {})),
        ).toBe("UNAUTHENTICATED");
      });
    });

    it("GET session and result do not depend on the key: 200 while the list is 503", async () => {
      const applied = await seedApplied(setup, world, {
        owner: world.users.owner,
      });
      const token = await api.tokenFor(world.users.owner);
      await withWeakProductionSecret(async () => {
        expect((await list(token)).status).toBe(503);
        const session = await api.call(
          "GET",
          `/import-sessions/${applied.id}`,
          {
            token,
          },
        );
        const result = await api.call(
          "GET",
          `/import-sessions/${applied.id}/result`,
          { token },
        );
        expect([session.status, result.status]).toEqual([200, 200]);
      });
    });

    it("no token => 401 from the guard even with an unsafe secret", async () => {
      await withWeakProductionSecret(async () => {
        const reply = await api.call("GET", "/import-sessions");
        expect([reply.status, reply.json?.code]).toEqual([
          401,
          "UNAUTHENTICATED",
        ]);
      });
    });
  });

  describe("ACL parity: list inclusion <=> GET session 200 <=> GET result 200 (else identical 404)", () => {
    type Arrange = (owner: "owner" | "restricted") => Promise<{
      id: string;
      state: "active" | "applied";
      visible: { owner: boolean; restricted: boolean };
    }>;
    const seedFor = async (
      who: "owner" | "restricted",
      state: "active" | "applied",
      anchor: { projectId: string; cardId: string },
      participants: string[] = [],
    ) => {
      const user = world.users[who];
      if (state === "applied") {
        const applied = await seedApplied(setup, world, {
          owner: user,
          anchorProjectId: anchor.projectId,
          cardId: anchor.cardId,
          participants: [
            {
              sourceProjectId: anchor.projectId,
              targets: participants.map((projectId) => ({
                projectId,
                amountCents: 100,
              })),
            },
          ],
        });
        return applied.id;
      }
      return (
        await seedSession(setup, world, {
          ownerUserId: user.id,
          ownerProjectId: anchor.projectId,
          cardId: anchor.cardId,
        })
      ).id;
    };
    const pessoal = () => ({
      projectId: world.projects.pessoal,
      cardId: world.cards.pessoal,
    });

    const cases: Array<
      [
        string,
        (state: "active" | "applied") => Promise<{
          anchor: { projectId: string; cardId: string };
          participants: string[];
          owner: boolean;
          restricted: boolean;
          after?: () => Promise<void>;
        }>,
      ]
    > = [
      [
        "everything visible",
        async () => ({
          anchor: pessoal(),
          participants: [],
          owner: true,
          restricted: true,
        }),
      ],
      [
        "anchor project soft-deleted",
        async () => {
          const gone = await addSoftDeletedAnchor(
            setup,
            world,
            `pa${randomUUID().slice(0, 6)}`,
          );
          return {
            anchor: gone,
            participants: [],
            owner: false,
            restricted: false,
          };
        },
      ],
      [
        "card soft-deleted",
        async () => {
          const extra = await addProjectWithCard(
            setup,
            world,
            `cd${randomUUID().slice(0, 6)}`,
            "PESSOAL",
          );
          await setup.creditCard.update({
            where: { id: extra.cardId },
            data: { deletedAt: new Date(FIXED_NOW.getTime() - 1) },
          });
          await setup.user.update({
            where: { id: world.users.restricted.id },
            data: {
              allowedProjects: JSON.stringify([
                world.projects.pessoal,
                extra.projectId,
              ]),
            },
          });
          return {
            anchor: extra,
            participants: [],
            owner: false,
            restricted: false,
            after: async () => {
              await setup.user.update({
                where: { id: world.users.restricted.id },
                data: {
                  allowedProjects: JSON.stringify([world.projects.pessoal]),
                },
              });
            },
          };
        },
      ],
      [
        "anchor outside the restricted grant (casa)",
        async () => ({
          anchor: { projectId: world.projects.casa, cardId: world.cards.casa },
          participants: [],
          owner: false,
          restricted: false,
        }),
      ],
    ];
    const appliedOnly: typeof cases = [
      [
        "KEEP/target project hidden from the restricted user (casa)",
        async () => ({
          anchor: pessoal(),
          participants: [world.projects.casa],
          owner: true,
          restricted: false,
        }),
      ],
      [
        "target project soft-deleted (also for ALL)",
        async () => {
          const gone = await addSoftDeletedAnchor(
            setup,
            world,
            `pt${randomUUID().slice(0, 6)}`,
          );
          return {
            anchor: pessoal(),
            participants: [gone.projectId],
            owner: false,
            restricted: false,
          };
        },
      ],
      [
        "target project of another tenant",
        async () => ({
          anchor: pessoal(),
          participants: [world.projects.foreign],
          owner: false,
          restricted: false,
        }),
      ],
      [
        "target project that does not exist",
        async () => ({
          anchor: pessoal(),
          participants: ["does-not-exist"],
          owner: false,
          restricted: false,
        }),
      ],
    ];

    const run = async (
      label: string,
      arrange: (typeof cases)[number][1],
      state: "active" | "applied",
      who: "owner" | "restricted",
    ) => {
      const spec = await arrange(state);
      try {
        const id = await seedFor(who, state, spec.anchor, spec.participants);
        const token = await api.tokenFor(world.users[who]);
        const { ids } = await allPages(token, state);
        const inList = ids.includes(id);
        const session = await api.call("GET", `/import-sessions/${id}`, {
          token,
        });
        const result = await api.call("GET", `/import-sessions/${id}/result`, {
          token,
        });
        const expected = spec[who];
        expect([label, who, state, "list", inList]).toEqual([
          label,
          who,
          state,
          "list",
          expected,
        ]);
        if (state === "active")
          expect([label, "session", session.status]).toEqual([
            label,
            "session",
            expected ? 200 : 404,
          ]);
        else
          expect([
            label,
            "session+result",
            session.status,
            result.status,
          ]).toEqual([
            label,
            "session+result",
            expected ? 200 : 404,
            expected ? 200 : 404,
          ]);
        if (!expected) {
          expect(session.json).toEqual(notFound);
          if (state === "applied") expect(result.json).toEqual(notFound);
          // Same body as an id that never existed: no total, snapshot or partial ids.
          const missing = await api.call(
            "GET",
            `/import-sessions/${randomUUID()}`,
            { token },
          );
          expect(session.json).toEqual(missing.json);
          expect(session.text).not.toMatch(
            /totalCents|snapshot|participantProjectIds|exp-line/,
          );
        }
      } finally {
        await spec.after?.();
      }
    };
    it.each(cases)("active — %s", async (label, arrange) => {
      for (const who of ["owner", "restricted"] as const)
        await run(label, arrange, "active", who);
    });
    it.each([...cases, ...appliedOnly])(
      "applied — %s",
      async (label, arrange) => {
        for (const who of ["owner", "restricted"] as const)
          await run(label, arrange, "applied", who);
      },
    );

    it("APPLIED sessions require both current card and participant expense scopes", async () => {
      const applied = await seedFor("restricted", "applied", pessoal());
      const active = await seedFor("restricted", "active", pessoal());
      const token = await api.tokenFor(world.users.restricted);
      expect((await allPages(token, "applied")).ids).toEqual([applied]);
      await setup.user.update({
        where: { id: world.users.restricted.id },
        data: { allowedModules: JSON.stringify(["creditCards"]) },
      });
      expect((await allPages(token, "applied")).ids).toEqual([]);
      expect(
        (await api.call("GET", `/import-sessions/${applied}`, { token }))
          .status,
      ).toBe(404);
      expect(
        (await api.call("GET", `/import-sessions/${applied}/result`, { token }))
          .status,
      ).toBe(404);
      await setup.user.update({
        where: { id: world.users.restricted.id },
        data: { allowedModules: JSON.stringify(["expenses"]) },
      });
      expect((await allPages(token, "active")).ids).toEqual([]);
      expect(
        (await api.call("GET", `/import-sessions/${active}`, { token })).status,
      ).toBe(404);
      await setup.user.update({
        where: { id: world.users.restricted.id },
        data: { allowedModules: JSON.stringify(["creditCards", "expenses"]) },
      });
    });

    it("does NOT promise quota parity: a hidden active session stays out of the list (cancel by id keeps its own rules)", async () => {
      const gone = await addSoftDeletedAnchor(setup, world, "q");
      const hidden = await seedSession(setup, world, {
        ownerUserId: world.users.owner.id,
        ownerProjectId: gone.projectId,
        cardId: gone.cardId,
      });
      const token = await api.tokenFor(world.users.owner);
      expect((await list(token)).json.items).toEqual([]);
      const cancel = await api.call(
        "POST",
        `/import-sessions/${hidden.id}/cancel`,
        {
          token,
          headers: { origin: "http://localhost:3000", "x-rf-import-ui": "1" },
          body: { expectedRevision: 1 },
        },
      );
      expect([cancel.status, cancel.json]).toEqual([404, notFound]);
    });

    it("filters deleted cards and unauthorized APPLIED participants before LIMIT and cursor derivation", async () => {
      const actor = world.users.restricted;
      const deletedCardAnchor = await addProjectWithCard(
        setup,
        world,
        `page${randomUUID().slice(0, 6)}`,
        "PESSOAL",
      );
      await setup.user.update({
        where: { id: actor.id },
        data: {
          allowedProjects: JSON.stringify([
            world.projects.pessoal,
            deletedCardAnchor.projectId,
          ]),
        },
      });
      await setup.creditCard.update({
        where: { id: deletedCardAnchor.cardId },
        data: { deletedAt: FIXED_NOW },
      });

      const visibleIds: string[] = [];
      const hiddenIds: string[] = [];
      for (let index = 0; index < 30; index++) {
        const hidden =
          index % 2 === 0
            ? await seedApplied(setup, world, {
                owner: actor,
                anchorProjectId: deletedCardAnchor.projectId,
                cardId: deletedCardAnchor.cardId,
                index: index * 2,
              })
            : await seedApplied(setup, world, {
                owner: actor,
                participants: [
                  {
                    sourceProjectId: world.projects.pessoal,
                    targets: [
                      { projectId: world.projects.casa, amountCents: 100 },
                    ],
                  },
                ],
                index: index * 2,
              });
        hiddenIds.push(hidden.id);
        visibleIds.push(
          (
            await seedApplied(setup, world, {
              owner: actor,
              index: index * 2 + 1,
            })
          ).id,
        );
      }

      const token = await api.tokenFor(actor);
      const first = await list(token, "?state=applied");
      expect(first.status).toBe(200);
      expect(Object.keys(first.json).sort()).toEqual([
        "entry",
        "items",
        "nextCursor",
      ]);
      expect(first.json.items.map((item: { id: string }) => item.id)).toEqual(
        visibleIds.slice(0, 25),
      );
      expect(first.json.nextCursor).toEqual(expect.any(String));
      expect(first.text).not.toMatch(/totalCount|hiddenCount/);

      const second = await list(
        token,
        `?state=applied&cursor=${encodeURIComponent(first.json.nextCursor)}`,
      );
      expect(second.status).toBe(200);
      expect(second.json.items.map((item: { id: string }) => item.id)).toEqual(
        visibleIds.slice(25),
      );
      expect(second.json.nextCursor).toBeNull();
      expect(
        [...first.json.items, ...second.json.items].some(
          (item: { id: string }) => hiddenIds.includes(item.id),
        ),
      ).toBe(false);

      await setup.importSession.deleteMany({
        where: { tenantId: world.tenantId },
      });
      for (let index = 0; index < 30; index++) {
        await seedApplied(setup, world, {
          owner: actor,
          participants: [
            {
              sourceProjectId: world.projects.pessoal,
              targets: [{ projectId: world.projects.casa, amountCents: 100 }],
            },
          ],
          index,
        });
      }
      const allHidden = await list(token, "?state=applied");
      expect(allHidden.status).toBe(200);
      expect(allHidden.json.items).toEqual([]);
      expect(allHidden.json.nextCursor).toBeNull();

      await setup.user.update({
        where: { id: actor.id },
        data: {
          allowedProjects: JSON.stringify([
            world.projects.pessoal,
            world.projects.casa,
          ]),
        },
      });
      const grantedToken = await api.tokenFor(actor);
      const beforeRevocation = await list(grantedToken, "?state=applied");
      expect(beforeRevocation.json.items).toHaveLength(25);
      expect(beforeRevocation.json.nextCursor).toEqual(expect.any(String));

      await setup.user.update({
        where: { id: actor.id },
        data: {
          allowedProjects: JSON.stringify([world.projects.pessoal]),
        },
      });
      const afterRevocation = await list(
        grantedToken,
        `?state=applied&cursor=${encodeURIComponent(
          beforeRevocation.json.nextCursor,
        )}`,
      );
      expect(afterRevocation.status).toBe(200);
      expect(afterRevocation.json.items).toEqual([]);
      expect(afterRevocation.json.nextCursor).toBeNull();
    });
  });

  describe("corruption is an explicit error, never an omission", () => {
    it.each([
      ["snapshot absent", '{"version":1}'],
      [
        "participants not an array",
        '{"snapshot":{"participantProjectIds":"x"}}',
      ],
    ])(
      "applied with %s: the page that contains it answers a sanitised 500 (not empty, not 404, not partial)",
      async (_label, json) => {
        const owner = world.users.owner;
        const ok = await seedApplied(setup, world, { owner, index: 5 });
        const bad = await seedApplied(setup, world, {
          owner,
          index: 1,
          receiptJson: json,
        });
        const logged: string[] = [];
        const spy = jest
          .spyOn(Logger.prototype, "error")
          .mockImplementation((...args: unknown[]) => {
            logged.push(args.map(String).join(" "));
          });
        try {
          const reply = await list(await api.tokenFor(owner), "?state=applied");
          expect([reply.status, reply.json]).toEqual([
            500,
            { statusCode: 500, message: "Internal server error" },
          ]);
          expect(reply.text).not.toContain(ok.id);
          expect(reply.text).not.toContain(bad.id);
          const line = logged.join("\n");
          expect(line).toContain(bad.id);
          expect(line).toContain("receipt");
          expect(line).toContain("ImportSessionCorruptStateError");
        } finally {
          spy.mockRestore();
        }
      },
    );

    it("a corrupted, UNUSED draft does not break the summary; the full GET answers 500; cancel by CAS still works", async () => {
      const owner = world.users.owner;
      const token = await api.tokenFor(owner);
      const seeded = await seedSession(setup, world, {
        ownerUserId: owner.id,
        draftJson: '{"version":1,"lines":"not-an-array"}',
      });
      const summary = await list(token);
      expect(summary.status).toBe(200);
      expect(summary.json.items.map((item: { id: string }) => item.id)).toEqual(
        [seeded.id],
      );
      const spy = jest
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => undefined);
      try {
        expect(
          (await api.call("GET", `/import-sessions/${seeded.id}`, { token }))
            .status,
        ).toBe(500);
      } finally {
        spy.mockRestore();
      }
      const stale = await api.call(
        "POST",
        `/import-sessions/${seeded.id}/cancel`,
        {
          token,
          headers: { origin: "http://localhost:3000", "x-rf-import-ui": "1" },
          body: { expectedRevision: 9 },
        },
      );
      expect(stale.status).toBe(409);
      const cancelled = await api.call(
        "POST",
        `/import-sessions/${seeded.id}/cancel`,
        {
          token,
          headers: { origin: "http://localhost:3000", "x-rf-import-ui": "1" },
          body: { expectedRevision: 1 },
        },
      );
      expect([cancelled.status, cancelled.json?.state]).toEqual([
        200,
        "CANCELLED",
      ]);
    });
  });

  describe("reads write nothing and share ONE read transaction", () => {
    it("the read path contains no writer statement (UPDATE tenants, BEGIN IMMEDIATE, raw writes)", () => {
      const source = readFileSync(
        join(__dirname, "import-session.service.ts"),
        "utf8",
      );
      const start = source.indexOf("async list(");
      expect(start).toBeGreaterThan(-1);
      const listBody = source.slice(start, source.indexOf("async getSession("));
      expect(listBody).not.toMatch(
        /UPDATE\s|\$executeRaw|BEGIN\s+IMMEDIATE|\.(create|update|updateMany|upsert|delete|deleteMany)\(/i,
      );
      const readBody = source.slice(
        source.indexOf("private async read("),
        source.indexOf("/** Owner-only, tenant-only lookup"),
      );
      expect(readBody).toMatch(/\$transaction\(/);
      expect(readBody).not.toMatch(/UPDATE\s|\$executeRaw|BEGIN\s+IMMEDIATE/i);
    });
  });

  describe("measured budget on the REAL route (median of 5 < 250 ms)", () => {
    const BUDGET_MS = 250;
    /** ONE fixed sequence: 1 warm-up, then 5 timed calls; the median is the gate. No retry. */
    const measured: Record<string, number[]> = {};
    const median = async (label: string, run: () => Promise<unknown>) => {
      await run();
      const samples: number[] = [];
      for (let i = 0; i < 5; i++) {
        const start = process.hrtime.bigint();
        await run();
        samples.push(Number(process.hrtime.bigint() - start) / 1e6);
      }
      measured[label] = [...samples];
      return samples.sort((a, b) => a - b)[2]!;
    };

    it("7,100 rows of ONE owner (tenant 10,100 + other tenant 4,000) and a page of 25 near-limit receipts", async () => {
      const owner = world.users.owner;
      const gone = await addSoftDeletedAnchor(setup, world, "budget");
      const applied = (
        index: number,
        participants: string[],
        heavy: boolean,
      ) => {
        const id = randomUUID();
        const lines = heavy
          ? Array.from({ length: 10 }, (_v, n) => ({
              lineId: `line-${n + 1}`,
              sourceProjectId: world.projects.pessoal,
              totalCents: 24_000,
              targets: [
                { projectId: world.projects.casa, amountCents: 100 },
                { projectId: world.projects.pessoal, amountCents: 100 },
              ],
            }))
          : [{ sourceProjectId: participants[0]! }];
        const receipt = receiptV1(id, world.projects.pessoal, lines, (r) => {
          if (heavy) {
            for (const line of r["snapshot"].lines) {
              line.schedule = {
                version: 1,
                occurrences: Array.from({ length: 24 }, (_x, k) => ({
                  index: k,
                  parcela: `${k + 1}/24`,
                  valor: 1000,
                  data: "2026-09-10",
                  invoiceDueMonth: "2026-10",
                })),
              };
            }
            r["snapshot"].createdEconomicTotalCents = 240_000;
            r["snapshot"].invoiceDeltas = [
              { invoiceDueMonth: "2026-10", amountCents: 240_000 },
            ];
          } else {
            r["snapshot"].participantProjectIds = [
              ...new Set([world.projects.pessoal, ...participants]),
            ].sort();
            r["snapshot"].lines[0].sourceProjectId = participants[0]!;
          }
        });
        return sessionRow(world, owner.id, index, {
          id,
          state: "APPLIED",
          financialRequestId: randomUUID(),
          confirmedRevision: 1,
          confirmedSessionVersion: 0,
          confirmedAt: FIXED_NOW,
          proposalHash: "b".repeat(64),
          receiptJson: JSON.stringify(receipt),
          closedAt: new Date(FIXED_NOW.getTime() - index * 1000),
        });
      };
      const rows = [
        ...Array.from({ length: 3800 }, (_v, i) =>
          sessionRow(world, owner.id, i, {
            ownerProjectId: gone.projectId,
            cardId: gone.cardId,
          }),
        ),
        ...Array.from({ length: 200 }, (_v, i) =>
          sessionRow(world, owner.id, 4000 + i),
        ),
        ...Array.from({ length: 1000 }, (_v, i) =>
          sessionRow(world, owner.id, 5000 + i, {
            state: "CANCELLED",
            closedAt: FIXED_NOW,
          }),
        ),
        ...Array.from({ length: 2000 }, (_v, i) =>
          applied(100 + i, [gone.projectId], false),
        ),
        // 100 visible applied: the newest 25 are near-limit (10 lines x 24 installments).
        ...Array.from({ length: 100 }, (_v, i) =>
          applied(i < 25 ? -1 - i : 2200 + i, [world.projects.pessoal], i < 25),
        ),
        ...Array.from({ length: 3000 }, (_v, i) =>
          sessionRow(world, world.users.peer.id, i),
        ),
      ];
      const otherWorld = {
        ...world,
        tenantId: world.otherTenantId,
        projects: { ...world.projects, pessoal: world.projects.foreign },
        cards: { ...world.cards, pessoal: world.cards.foreign },
      };
      rows.push(
        ...Array.from({ length: 4000 }, (_v, i) =>
          sessionRow(otherWorld, world.users.foreign.id, i),
        ),
      );
      await insertMany(setup, rows);
      const ownerRows = 3800 + 200 + 1000 + 2000 + 100;
      expect(ownerRows).toBe(7100);
      expect(
        await setup.importSession.count({
          where: { tenantId: world.tenantId, ownerUserId: owner.id },
        }),
      ).toBe(ownerRows);
      expect(
        await setup.importSession.count({
          where: { tenantId: world.tenantId },
        }),
      ).toBe(ownerRows + 3000);

      const token = await api.tokenFor(owner);
      const activeMs = await median("active", () =>
        list(token, "?state=active"),
      );
      const appliedMs = await median("applied", () =>
        list(token, "?state=applied"),
      );
      const first = await list(token, "?state=applied");
      expect(first.status).toBe(200);
      expect(first.json.items).toHaveLength(25);
      expect(first.text.length).toBeLessThan(64 * 1024); // summaries only: no snapshot on the wire
      const deep = await allPages(token, "applied");
      expect(deep.ids).toHaveLength(100);
      const getHeavy = await median("getHeavy", () =>
        api.call("GET", `/import-sessions/${first.json.items[0].id}`, {
          token,
        }),
      );
      // eslint-disable-next-line no-console
      console.log(
        `B1b real-route budget: ownerRows=${ownerRows} tenantRows=${ownerRows + 3000} otherTenant=4000 active=${activeMs.toFixed(1)}ms applied(25 heavy)=${appliedMs.toFixed(1)}ms GET heavy=${getHeavy.toFixed(1)}ms`,
      );
      // eslint-disable-next-line no-console
      console.log(
        `B1b budget samples (ms, run order): ${JSON.stringify(measured)} loadavg=${loadavg()
          .map((n) => n.toFixed(1))
          .join("/")}`,
      );
      expect(activeMs).toBeLessThan(BUDGET_MS);
      expect(appliedMs).toBeLessThan(BUDGET_MS);
      expect(getHeavy).toBeLessThan(BUDGET_MS);
    });
  });
});
