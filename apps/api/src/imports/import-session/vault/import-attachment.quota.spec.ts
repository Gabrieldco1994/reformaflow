// The database guard must run before PrismaClient is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../../../scripts/test-db-env.cjs");

import type { PrismaService } from "../../../prisma/prisma.service";
import {
  cleanupImportWorld,
  FIXED_NOW,
  seedImportWorld,
  seedSession,
  type ImportWorld,
  type WorldUser,
} from "../../../test-utils/import-session-harness";
import { seedApplied } from "../../../test-utils/import-session-recovery-harness";
import {
  bootVaultApp,
  createVaultTestDatabase,
  finishVaultFixture,
  fileSeed,
  fullDigest,
  inSeconds,
  MIB,
  refsOf,
  reserve,
  seedArtifact,
  seedRef,
  TEN_MIB,
  UI_HEADERS,
  CANONICAL_VAULT,
  wire,
  type RecoveryApp,
} from "../../../test-utils/import-session-vault-harness";

/**
 * B2a RED (slice 1: per-user retained-bytes cap, C3). Cap = activeSessionsPerUser (3) x
 * bytesPerSession (50 MiB) = 157286400, a FAIRNESS bill that is never the physical tenant sum.
 * What a user is billed (design v8 3A.1 + parent C3): the temporaries of his refs; every
 * DISTINCT retained artifact he holds an ATTACHED ref to (even in a session that is terminal
 * by clock or persisted state, until the ref is RELEASED); and an orphan retained artifact
 * bills ONE payer, its last releaser (released_at DESC, ref id ASC), until the purge is proven.
 * Each suite retains its own disposable DB; global accounting must never see another test's world.
 * Dates remain Prisma-bound INTEGER values through the real PrismaService.
 */
const PREFIX = "imp-b2a-quota";
let database: Awaited<ReturnType<typeof createVaultTestDatabase>> | undefined;
let setup: PrismaService;
let world: ImportWorld;
let api: RecoveryApp;
let tokens: { restricted: string; peer: string; foreign: string };
jest.setTimeout(240_000);

const limit = { status: 422, code: wire("LIMIT_EXCEEDED") };

const sessionOf = (user: WorldUser, extra: Record<string, unknown> = {}) =>
  seedSession(setup, world, { ownerUserId: user.id, ...(extra as object) });

/** Temporaries: RESERVED refs with a temp key, `mib` MiB in 10 MiB steps (a remainder last). */
async function seedTemp(
  session: { id: string; tenantId: string; ownerProjectId: string },
  user: WorldUser,
  mib: number,
) {
  let left = mib * MIB;
  for (let position = 0; left > 0; position++) {
    const declaredBytes = Math.min(TEN_MIB, left);
    await seedRef(setup, session, user, { position, declaredBytes });
    left -= declaredBytes;
  }
}

/** Attached retained blobs: one artifact + one ATTACHED ref per 10 MiB. Returns the artifact ids. */
async function seedAttached(
  session: { id: string; tenantId: string; ownerProjectId: string },
  user: WorldUser,
  count: number,
) {
  const artifacts: string[] = [];
  for (let position = 0; position < count; position++) {
    const artifactId = await seedArtifact(setup, session, {
      verifiedBytes: TEN_MIB,
    });
    artifacts.push(artifactId);
    await seedRef(setup, session, user, {
      position,
      declaredBytes: TEN_MIB,
      state: "ATTACHED",
      artifactId,
      verifiedAt: FIXED_NOW,
    });
  }
  return artifacts;
}

/** A fresh session that tries to reserve `sizes`; an accepted probe is removed again. */
async function probe(
  user: WorldUser,
  token: string,
  sizes: number[],
  sessionSeed: Record<string, unknown> = {},
) {
  const session = await sessionOf(user, sessionSeed);
  const reply = await reserve(
    api,
    token,
    session.id,
    sizes.map((declaredBytes) => fileSeed({ declaredBytes })),
  );
  if (reply.status === 200) {
    await setup.importSessionArtifact.deleteMany({
      where: { sessionId: session.id },
    });
  }
  return reply;
}
// The whole wire, not just the code: no payer, owner or number may ride along (V65).
const isLimit = (reply: { status: number; json: any }) => [
  reply.status,
  reply.json,
];

describe("B2a slice 1 — per-user retained-bytes cap (C3)", () => {
  beforeAll(async () => {
    database = await createVaultTestDatabase();
    setup = database.setup;
    world = await seedImportWorld(setup, PREFIX);
    api = await bootVaultApp(setup, { writes: true, vault: CANONICAL_VAULT });
    tokens = {
      restricted: await api.tokenFor(world.users.restricted),
      peer: await api.tokenFor(world.users.peer),
      foreign: await api.tokenFor(world.users.foreign),
    };
  });
  beforeEach(async () => {
    const tenants = { in: [world.tenantId, world.otherTenantId] };
    await setup.importSessionArtifact.deleteMany({
      where: { tenantId: tenants },
    });
    await setup.importArtifact.deleteMany({ where: { tenantId: tenants } });
  });
  afterAll(async () => {
    await finishVaultFixture(
      () => api?.close(),
      () => database?.close(),
    );
  });

  it("three legitimate 50 MiB sessions are accepted exactly; +1 byte is LIMIT_EXCEEDED with zero effect; a peer in the same tenant is unaffected", async () => {
    const user = world.users.restricted;
    const five = () =>
      Array.from({ length: 5 }, () => fileSeed({ declaredBytes: TEN_MIB }));
    for (let i = 0; i < 3; i++) {
      const session = await sessionOf(user);
      const reply = await reserve(api, tokens.restricted, session.id, five());
      expect([i, reply.status]).toEqual([i, 200]);
    }
    const fourth = await sessionOf(user);
    const before = await fullDigest(setup, fourth.id);
    const over = await reserve(api, tokens.restricted, fourth.id, [
      fileSeed({ declaredBytes: 1 }),
    ]);
    expect(isLimit(over)).toEqual([limit.status, limit.code]);
    expect(await fullDigest(setup, fourth.id)).toEqual(before);
    const peer = await probe(world.users.peer, tokens.peer, [TEN_MIB]);
    expect(peer.status).toBe(200);
  });

  it("create -> reserve 50 MiB -> cancel, three times: the cancelled temporaries stay billed until a purge is proven, so the 4th cycle is blocked and a proven purge reopens it", async () => {
    const user = world.users.restricted;
    const cycles: string[] = [];
    for (let i = 0; i < 3; i++) {
      const session = await sessionOf(user);
      cycles.push(session.id);
      const reserved = await reserve(
        api,
        tokens.restricted,
        session.id,
        Array.from({ length: 5 }, () => fileSeed({ declaredBytes: TEN_MIB })),
      );
      expect(reserved.status).toBe(200);
      const cancelled = await api.call(
        "POST",
        `/import-sessions/${session.id}/cancel`,
        {
          token: tokens.restricted,
          headers: UI_HEADERS,
          body: { expectedRevision: 2 },
        },
      );
      expect(cancelled.status).toBe(200);
      // Cancel keeps every ref (and its temp key) for the purge, stamped with released_at.
      const kept = await refsOf(setup, session.id);
      expect(kept).toHaveLength(5);
      for (const ref of kept) {
        expect(ref).toMatchObject({
          state: "RELEASED",
          temporaryPurgePending: true,
        });
        expect(ref.releasedAt).not.toBeNull();
        expect(ref.temporaryStorageKey).not.toBeNull();
      }
    }
    const blocked = await probe(user, tokens.restricted, [1]);
    expect(isLimit(blocked)).toEqual([limit.status, limit.code]);
    // A proven purge of the first cycle (key cleared, quota released) is the ONLY thing that reopens it.
    await setup.importSessionArtifact.updateMany({
      where: { sessionId: cycles[0]! },
      data: {
        temporaryStorageKey: null,
        reservedBytes: 0,
        temporaryPurgePending: false,
      },
    });
    const reopened = await probe(user, tokens.restricted, [
      TEN_MIB,
      TEN_MIB,
      TEN_MIB,
      TEN_MIB,
      TEN_MIB,
    ]);
    expect(reopened.status).toBe(200);
  });

  it("upload -> cancel cycles (reserved_bytes already 0, blobs retained, refs RELEASED with released_at): the user still owns 150 MiB until each artifact is PURGED", async () => {
    const user = world.users.restricted;
    const sessions: string[][] = [];
    for (let i = 0; i < 3; i++) {
      const session = await sessionOf(user, {
        state: "CANCELLED",
        closedAt: FIXED_NOW,
      });
      const artifacts = await seedAttached(session, user, 5);
      await setup.importSessionArtifact.updateMany({
        where: { sessionId: session.id },
        data: { state: "RELEASED", releasedAt: inSeconds(-60 - i) },
      });
      sessions.push(artifacts);
    }
    const blocked = await probe(user, tokens.restricted, [1]);
    expect(isLimit(blocked)).toEqual([limit.status, limit.code]);
    await setup.importArtifact.updateMany({
      where: { id: { in: sessions[0]! } },
      data: { state: "PURGED", storageKey: null },
    });
    expect(
      (
        await probe(user, tokens.restricted, [
          TEN_MIB,
          TEN_MIB,
          TEN_MIB,
          TEN_MIB,
          TEN_MIB,
        ])
      ).status,
    ).toBe(200);
  });

  describe("billing follows the PERSISTED state and released_at, never the effective/projected one (V59)", () => {
    it("ATTACHED refs keep billing in a session that expired by the clock (persisted DRAFT) and in an APPLIED one, until the ref is RELEASED", async () => {
      const user = world.users.restricted;
      for (let i = 0; i < 2; i++) {
        const expired = await sessionOf(user, { expiresAt: FIXED_NOW });
        await seedAttached(expired, user, 5);
      }
      const applied = await seedApplied(setup, world, {
        owner: user,
        participants: [{ sourceProjectId: world.projects.pessoal }],
      });
      const appliedSession = {
        id: applied.id,
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
      };
      const artifacts = await seedAttached(appliedSession, user, 5);
      expect(isLimit(await probe(user, tokens.restricted, [1]))).toEqual([
        limit.status,
        limit.code,
      ]);
      // RELEASED with the blob still on disk and no other live holder: still the last releaser's bill.
      await setup.importSessionArtifact.updateMany({
        where: { sessionId: applied.id },
        data: { state: "RELEASED", releasedAt: FIXED_NOW },
      });
      expect(isLimit(await probe(user, tokens.restricted, [1]))).toEqual([
        limit.status,
        limit.code,
      ]);
      await setup.importArtifact.updateMany({
        where: { id: { in: artifacts } },
        data: { state: "PURGED", storageKey: null },
      });
      expect((await probe(user, tokens.restricted, [TEN_MIB])).status).toBe(
        200,
      );
    });

    it("a session expired by the clock does not free its TEMPORARIES either", async () => {
      const user = world.users.restricted;
      for (let i = 0; i < 3; i++) {
        const expired = await sessionOf(user, { expiresAt: FIXED_NOW });
        await seedTemp(expired, user, 50);
      }
      expect(isLimit(await probe(user, tokens.restricted, [1]))).toEqual([
        limit.status,
        limit.code,
      ]);
    });
  });

  describe("caps are enforced per scope with the neighbours present (P1 isolation)", () => {
    const alienScope = () => ({
      tenantId: world.otherTenantId,
      ownerProjectId: world.projects.foreign,
    });
    const orphans = async (
      scope: { tenantId: string; ownerProjectId: string },
      mib: number,
    ) => {
      for (let left = mib; left > 0; left -= 10) {
        await seedArtifact(setup, scope, {
          verifiedBytes: Math.min(10, left) * MIB,
        });
      }
    };
    const mainScope = () => ({
      tenantId: world.tenantId,
      ownerProjectId: world.projects.pessoal,
    });

    it("another tenant ABOVE its own 200 MiB never counts against this tenant: 190 MiB here still takes exactly 10 MiB and rejects +1 byte", async () => {
      await orphans(mainScope(), 190);
      await orphans(alienScope(), 250);
      const user = world.users.restricted;
      expect(
        isLimit(await probe(user, tokens.restricted, [TEN_MIB, 1])),
      ).toEqual([limit.status, limit.code]);
      expect((await probe(user, tokens.restricted, [TEN_MIB])).status).toBe(
        200,
      );
    });

    it("and the inverse: this tenant FULL (200 MiB) does not block the other tenant's 190 MiB from taking exactly 10 MiB", async () => {
      await orphans(mainScope(), 200);
      await orphans(alienScope(), 190);
      const foreign = world.users.foreign;
      const seed = {
        tenantId: world.otherTenantId,
        ownerProjectId: world.projects.foreign,
        cardId: world.cards.foreign,
      };
      expect(
        isLimit(await probe(foreign, tokens.foreign, [TEN_MIB, 1], seed)),
      ).toEqual([limit.status, limit.code]);
      expect(
        (await probe(foreign, tokens.foreign, [TEN_MIB], seed)).status,
      ).toBe(200);
    });

    it("global 1073741824: five other tenants at their full 200 MiB plus 14 MiB here leave exactly 10 MiB; +1 byte is LIMIT_EXCEEDED", async () => {
      const prefixes = Array.from({ length: 5 }, (_, i) => `${PREFIX}-g${i}`);
      const worlds: ImportWorld[] = [];
      try {
        for (const prefix of prefixes) {
          const other = await seedImportWorld(setup, prefix);
          worlds.push(other);
          await orphans(
            {
              tenantId: other.tenantId,
              ownerProjectId: other.projects.pessoal,
            },
            200,
          );
        }
        await orphans(mainScope(), 14);
        const user = world.users.restricted;
        expect(
          isLimit(await probe(user, tokens.restricted, [TEN_MIB, 1])),
        ).toEqual([limit.status, limit.code]);
        expect((await probe(user, tokens.restricted, [TEN_MIB])).status).toBe(
          200,
        );
      } finally {
        await setup.importArtifact.deleteMany({
          where: { tenantId: { in: worlds.map((w) => w.tenantId) } },
        });
        for (const prefix of prefixes) await cleanupImportWorld(setup, prefix);
      }
    });
  });

  describe("billing is per DISTINCT artifact, never per ref", () => {
    // A holds 130 MiB of temporaries + one 10 MiB blob X => 140 MiB: 10 MiB fit, +1 byte does not.
    // Charging per ref (2 x 10 MiB or 3 x 10 MiB) would leave no room for the 10 MiB probe.
    async function holdX(state: "ATTACHED" | "RELEASED", refs: number) {
      const A = world.users.restricted;
      for (const size of [50, 50, 30]) {
        await seedTemp(await sessionOf(A), A, size);
      }
      const first = await sessionOf(A);
      const x = await seedArtifact(setup, first, { verifiedBytes: TEN_MIB });
      for (let i = 0; i < refs; i++) {
        const session = i === 0 ? first : await sessionOf(A);
        await seedRef(setup, session, A, {
          position: 0,
          declaredBytes: TEN_MIB,
          state,
          artifactId: x,
          verifiedAt: FIXED_NOW,
          ...(state === "RELEASED" ? { releasedAt: inSeconds(-10 - i) } : {}),
        });
      }
    }
    it.each([
      ["two ATTACHED refs of one user to the same blob", "ATTACHED", 2],
      [
        "three RELEASED refs of one user to the same orphaned blob (one payer, no ATTACHED anywhere)",
        "RELEASED",
        3,
      ],
    ] as const)(
      "%s bill 10 MiB, not one 10 MiB per ref",
      async (_name, state, refs) => {
        await holdX(state, refs);
        const user = world.users.restricted;
        expect(
          isLimit(await probe(user, tokens.restricted, [TEN_MIB, 1])),
        ).toEqual([limit.status, limit.code]);
        expect((await probe(user, tokens.restricted, [TEN_MIB])).status).toBe(
          200,
        );
      },
    );
  });

  describe("a shared blob bills each holder in full while live and ONE payer once orphaned (V53)", () => {
    // A = restricted holds 130 MiB of temporaries + the shared 10 MiB blob X = 140 MiB, so it can
    // still reserve exactly 20 MiB unless it pays for X (then 10 MiB). B = peer holds the other
    // ATTACHED ref to X. Tenant physical: 130 + 30 + 10 = 170 MiB, X counted once.
    const A = () => world.users.restricted;
    const B = () => world.users.peer;
    const FIT_IF_NOT_PAYING = [TEN_MIB, TEN_MIB];
    const ONE_BYTE_TOO_MANY = [TEN_MIB, 1];

    async function shared(ids: { a: string; b: string }) {
      for (const size of [50, 50, 30]) {
        await seedTemp(await sessionOf(A()), A(), size);
      }
      await seedTemp(await sessionOf(B()), B(), 30);
      const sessionA = await sessionOf(A());
      const sessionB = await sessionOf(B());
      const x = await seedArtifact(setup, sessionA, { verifiedBytes: TEN_MIB });
      const hold = (owner: WorldUser, session: typeof sessionA, id: string) =>
        seedRef(setup, session, owner, {
          id,
          position: 0,
          declaredBytes: TEN_MIB,
          state: "ATTACHED",
          artifactId: x,
          verifiedAt: FIXED_NOW,
        });
      await hold(A(), sessionA, ids.a);
      await hold(B(), sessionB, ids.b);
      return { x, sessionA, sessionB, ids };
    }
    const release = (id: string, releasedAt: Date | null, updatedAt?: Date) =>
      setup.importSessionArtifact.update({
        where: { id },
        data: {
          state: "RELEASED",
          releasedAt,
          ...(updatedAt ? { updatedAt } : {}),
        },
      });
    const LOW = "00000000-0000-4000-8000-000000000001";
    const HIGH = "ffffffff-0000-4000-8000-000000000001";

    it("both live: A pays the whole 10 MiB (only 10 MiB fits); A releasing stops ITS bill at once while B is live (20 MiB fits)", async () => {
      const { ids } = await shared({ a: LOW, b: HIGH });
      expect(
        isLimit(await probe(A(), tokens.restricted, ONE_BYTE_TOO_MANY)),
      ).toEqual([limit.status, limit.code]);
      await release(ids.a, inSeconds(-10));
      expect(
        (await probe(A(), tokens.restricted, FIT_IF_NOT_PAYING)).status,
      ).toBe(200);
    });

    it("orphaned blob: the LAST releaser pays (released_at DESC), not the first, and only until the purge is proven", async () => {
      const { ids, x } = await shared({ a: LOW, b: HIGH });
      await release(ids.b, inSeconds(-30));
      await release(ids.a, inSeconds(-10));
      expect(
        isLimit(await probe(A(), tokens.restricted, ONE_BYTE_TOO_MANY)),
      ).toEqual([limit.status, limit.code]);
      await release(ids.a, inSeconds(-50));
      expect(
        (await probe(A(), tokens.restricted, FIT_IF_NOT_PAYING)).status,
      ).toBe(200);
      await release(ids.a, inSeconds(-10));
      await setup.importArtifact.update({
        where: { id: x },
        data: { state: "PURGED", storageKey: null },
      });
      expect(
        (await probe(A(), tokens.restricted, FIT_IF_NOT_PAYING)).status,
      ).toBe(200);
    });

    it("equal released_at: the smaller ref id pays, deterministically (A LOW pays, A HIGH does not)", async () => {
      const at = inSeconds(-20);
      const first = await shared({ a: LOW, b: HIGH });
      await release(first.ids.a, at);
      await release(first.ids.b, at);
      expect(
        isLimit(await probe(A(), tokens.restricted, ONE_BYTE_TOO_MANY)),
      ).toEqual([limit.status, limit.code]);
      await setup.importSessionArtifact.deleteMany({
        where: { tenantId: world.tenantId },
      });
      await setup.importArtifact.deleteMany({
        where: { tenantId: world.tenantId },
      });
      const second = await shared({ a: HIGH, b: LOW });
      await release(second.ids.a, at);
      await release(second.ids.b, at);
      expect(
        (await probe(A(), tokens.restricted, FIT_IF_NOT_PAYING)).status,
      ).toBe(200);
    });

    it("a RELEASED ref with released_at NULL falls back to updated_at for the ordering (deterministic, never chronology of creation)", async () => {
      const { ids } = await shared({ a: LOW, b: HIGH });
      await release(ids.b, inSeconds(-30));
      await release(ids.a, null, inSeconds(-5));
      expect(
        isLimit(await probe(A(), tokens.restricted, ONE_BYTE_TOO_MANY)),
      ).toEqual([limit.status, limit.code]);
    });

    it("mirror: a ref with released_at NULL and an OLDER updated_at loses to a newer released_at: B pays, A fits (NULL is not 'newest')", async () => {
      const { ids } = await shared({ a: LOW, b: HIGH });
      await release(ids.b, inSeconds(-10));
      await release(ids.a, null, inSeconds(-50));
      expect(
        (await probe(A(), tokens.restricted, FIT_IF_NOT_PAYING)).status,
      ).toBe(200);
    });

    it("legacy storage classes: a TEXT released_at (older) and an INTEGER released_at (newer) order by real time, not by SQLite's TEXT > INTEGER", async () => {
      const { ids } = await shared({ a: LOW, b: HIGH });
      await release(ids.b, inSeconds(-10));
      await release(ids.a, inSeconds(-50));
      await setup.$executeRawUnsafe(
        `UPDATE import_session_artifacts SET released_at = ? WHERE id = ?`,
        inSeconds(-50).toISOString(),
        ids.a,
      );
      const kinds = await setup.$queryRawUnsafe<
        Array<{ id: string; t: string }>
      >(
        `SELECT id, typeof(released_at) AS t FROM import_session_artifacts WHERE id IN (?, ?)`,
        ids.a,
        ids.b,
      );
      expect(Object.fromEntries(kinds.map((k) => [k.id, k.t]))).toEqual({
        [ids.a]: "text",
        [ids.b]: "integer",
      });
      // Real time: B released last and pays; A (older) fits its 20 MiB.
      expect(
        (await probe(A(), tokens.restricted, FIT_IF_NOT_PAYING)).status,
      ).toBe(200);
    });

    it("the tenant physical total counts the shared blob ONCE (10 MiB, not 20): the tenant cap sees 170 MiB, not 180", async () => {
      await shared({ a: LOW, b: HIGH });
      // 209715200 - 170 MiB = 30 MiB of physical room: 30 MiB fits, 30 MiB + 1 byte does not.
      const peerOnly = world.users.owner;
      const ownerToken = await api.tokenFor(peerOnly);
      const over = await probe(peerOnly, ownerToken, [
        TEN_MIB,
        TEN_MIB,
        TEN_MIB,
        1,
      ]);
      expect(isLimit(over)).toEqual([limit.status, limit.code]);
      const exact = await probe(peerOnly, ownerToken, [
        TEN_MIB,
        TEN_MIB,
        TEN_MIB,
      ]);
      expect(exact.status).toBe(200);
    });
  });
});
