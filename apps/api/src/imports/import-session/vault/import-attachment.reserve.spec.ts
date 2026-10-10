// The database guard must run before PrismaClient is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../../../scripts/test-db-env.cjs");

import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  cleanupImportWorld,
  EMPTY_DRAFT_JSON,
  FIXED_NOW,
  seedImportWorld,
  seedSession,
  type ImportWorld,
} from "../../../test-utils/import-session-harness";
import {
  bootVaultApp,
  connectVaultTestDatabase,
  vaultTestDatabaseIsSafe,
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
 * B2a RED (slice 1: reservation). Real PrismaService/JwtStrategy/guards over HTTP. Nothing here
 * touches the file system: the reservation is a database-only decision that precedes any byte.
 */
const PREFIX = "imp-b2a-reserve";
const setup = new PrismaClient();
let world: ImportWorld;
let api: RecoveryApp;
let token: string;
let sv: number;
jest.setTimeout(180_000);

const invalid = wire("INVALID_INPUT");
const draftSession = (extra: Record<string, unknown> = {}) =>
  seedSession(setup, world, {
    ownerUserId: world.users.restricted.id,
    ...(extra as object),
  });
const jwtExpMs = (jwt: string) =>
  JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()).exp *
  1000;

describe("B2a slice 1 — POST /import-sessions/:id/attachments", () => {
  beforeAll(async () => {
    await connectVaultTestDatabase(setup);
    world = await seedImportWorld(setup, PREFIX);
    api = await bootVaultApp(setup, { writes: true, vault: CANONICAL_VAULT });
    token = await api.tokenFor(world.users.restricted);
    sv = world.users.restricted.sessionVersion;
  });
  // Every case starts from an empty vault: the tenant/user quotas are cumulative by design.
  beforeEach(async () => {
    await setup.importSessionArtifact.deleteMany({
      where: { tenantId: world.tenantId },
    });
    await setup.importArtifact.deleteMany({
      where: { tenantId: world.tenantId },
    });
  });
  afterAll(async () => {
    await api?.close();
    if (vaultTestDatabaseIsSafe(setup)) await cleanupImportWorld(setup, PREFIX);
    await setup.$disconnect();
  });

  describe("the reservation itself", () => {
    it("reserves 1..5 files atomically: RESERVED refs, generation 1, key t/<id>, claim window min(exp, +600 s), revision +1, public view only", async () => {
      const session = await draftSession();
      const files = [
        fileSeed({ fileName: "a.pdf", declaredBytes: 111 }),
        fileSeed({ fileName: "b.csv", declaredBytes: 222, mime: "text/csv" }),
      ];
      const reply = await reserve(api, token, session.id, files);
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({
        id: session.id,
        state: "DRAFT",
        revision: 2,
      });
      expect(reply.json.actions).toEqual(
        expect.arrayContaining(["UPLOAD", "CANCEL"]),
      );
      expect(reply.json.attachments).toEqual(
        files.map((file) => ({
          id: file.id,
          fileName: file.fileName,
          declaredBytes: file.declaredBytes,
          materializedInSession: false,
          canAnalyze: false,
          state: "RESERVED",
        })),
      );
      const rows = await refsOf(setup, session.id);
      const exp = jwtExpMs(token);
      expect(rows.map((row) => row.position)).toEqual([0, 1]);
      for (const [index, row] of rows.entries()) {
        expect(row).toMatchObject({
          id: files[index]!.id,
          tenantId: world.tenantId,
          ownerProjectId: world.projects.pessoal,
          state: "RESERVED",
          artifactId: null,
          declaredBytes: files[index]!.declaredBytes,
          reservedBytes: files[index]!.declaredBytes,
          temporaryStorageKey: `t/${files[index]!.id}`,
          uploadGeneration: 1,
          uploadSessionVersion: sv,
          temporaryPurgePending: false,
          verifiedAt: null,
          releasedAt: null,
        });
        expect(row.uploadTokenExpiresAt!.getTime()).toBe(exp);
        expect(row.uploadLeaseExpiresAt!.getTime()).toBe(
          Math.min(exp, inSeconds(600).getTime()),
        );
      }
      const wireText = reply.text;
      for (const secret of [
        "t/",
        "temporaryStorageKey",
        "storageKey",
        "uploadGeneration",
        "uploadLease",
        "uploadToken",
        "reservedBytes",
        "ownerUserId",
      ]) {
        expect(wireText).not.toContain(secret);
      }
    });

    it("preserves human draft fields and atomically appends only the new pending references", async () => {
      const session = await draftSession();
      const file = fileSeed();
      const reply = await reserve(api, token, session.id, [file]);
      expect(reply.status).toBe(200);
      const row = await setup.importSession.findUniqueOrThrow({
        where: { id: session.id },
      });
      expect(JSON.parse(row.draftJson)).toEqual({
        ...JSON.parse(EMPTY_DRAFT_JSON),
        scope: { observationIds: [], pendingAttachmentIds: [file.id] },
      });
      expect(row.proposalJson).toBeNull();
    });

    it("a stale expectedRevision on a NEW reservation is REVISION_CONFLICT with the current revision and zero effect", async () => {
      const session = await draftSession();
      const before = await fullDigest(setup, session.id);
      const reply = await reserve(api, token, session.id, [fileSeed()], {
        expectedRevision: 5,
      });
      expect([reply.status, reply.json]).toEqual([
        409,
        wire("REVISION_CONFLICT", {
          sessionId: session.id,
          currentRevision: 1,
        }),
      ]);
      expect(await fullDigest(setup, session.id)).toEqual(before);
    });
  });

  describe("idempotency is a READ that precedes state, revision and quota (V24)", () => {
    it("identical replay returns the current view, with any expectedRevision, and changes nothing (revision, rows, updatedAt, lease)", async () => {
      const session = await draftSession();
      const files = [fileSeed(), fileSeed({ declaredBytes: 2000 })];
      const first = await reserve(api, token, session.id, files);
      expect(first.status).toBe(200);
      const before = await fullDigest(setup, session.id);
      for (const expectedRevision of [1, 2, 99]) {
        const replay = await reserve(api, token, session.id, files, {
          expectedRevision,
        });
        expect([replay.status, replay.json]).toEqual([200, first.json]);
      }
      expect(await fullDigest(setup, session.id)).toEqual(before);
    });

    it("a known id with a different tuple, or a batch mixing known and new ids, is IDEMPOTENCY_CONFLICT with zero effect", async () => {
      const session = await draftSession();
      const file = fileSeed();
      expect((await reserve(api, token, session.id, [file])).status).toBe(200);
      const before = await fullDigest(setup, session.id);
      const variants = [
        { ...file, fileName: "outro.pdf" },
        { ...file, declaredBytes: file.declaredBytes + 1 },
        { ...file, mime: "image/png" },
      ];
      for (const variant of variants) {
        const reply = await reserve(api, token, session.id, [variant], {
          expectedRevision: 2,
        });
        expect([reply.status, reply.json.code]).toEqual([
          409,
          "IDEMPOTENCY_CONFLICT",
        ]);
      }
      const mixed = await reserve(api, token, session.id, [file, fileSeed()], {
        expectedRevision: 2,
      });
      expect([mixed.status, mixed.json.code]).toEqual([
        409,
        "IDEMPOTENCY_CONFLICT",
      ]);
      expect(await fullDigest(setup, session.id)).toEqual(before);
    });

    it("an id that already exists in ANOTHER scope is the generic INVALID_INPUT: the foreign row is never read, adopted, changed or revealed", async () => {
      const peerSession = await seedSession(setup, world, {
        ownerUserId: world.users.peer.id,
      });
      const taken = await seedRef(setup, peerSession, world.users.peer);
      const mine = await draftSession();
      const foreignBefore = await fullDigest(setup, peerSession.id);
      const mineBefore = await fullDigest(setup, mine.id);
      const reply = await reserve(api, token, mine.id, [
        fileSeed({ id: taken }),
      ]);
      expect([reply.status, reply.json]).toEqual([400, invalid]);
      expect(await fullDigest(setup, peerSession.id)).toEqual(foreignBefore);
      expect(await fullDigest(setup, mine.id)).toEqual(mineBefore);
    });
  });

  describe("input grammar: one generic 400 (or the contract's 422), zero effect", () => {
    const zeroEffect = async (files: unknown, expected: [number, unknown]) => {
      const session = await draftSession();
      const before = await fullDigest(setup, session.id);
      const reply = await reserve(api, token, session.id, files);
      expect([reply.status, reply.json]).toEqual(expected);
      expect(await fullDigest(setup, session.id)).toEqual(before);
    };

    it.each([
      ["uppercase UUID", randomUUID().toUpperCase()],
      ["non-UUID", "not-a-uuid"],
      ["191-char generic Id", "a".repeat(191)],
      ["dot-dot", ".."],
      ["slash", "a/b"],
      ["empty", ""],
      ["UUIDv1 shape", "6ba7b810-9dad-11d1-80b4-00c04fd430c8"],
    ])("file id: %s is rejected (lowercase UUIDv4 only)", async (_name, id) => {
      await zeroEffect([fileSeed({ id })], [400, invalid]);
    });

    it("a duplicated id inside one batch is rejected", async () => {
      const file = fileSeed();
      await zeroEffect([file, { ...file }], [400, invalid]);
    });

    it("no files, a non-array, unknown per-file keys and non-string fields are rejected", async () => {
      await zeroEffect([], [400, invalid]);
      await zeroEffect("x", [400, invalid]);
      await zeroEffect(
        [{ ...fileSeed(), hash: "a".repeat(64) }],
        [400, invalid],
      );
      await zeroEffect([{ ...fileSeed(), fileName: 5 }], [400, invalid]);
    });

    it("six files in one request exceed filesPerRequest (LIMIT_EXCEEDED)", async () => {
      await zeroEffect(
        Array.from({ length: 6 }, () => fileSeed()),
        [422, wire("LIMIT_EXCEEDED")],
      );
    });

    it.each([0, -1, 1.5, "1000", null])(
      "declaredBytes %p is INVALID_INPUT",
      async (declaredBytes) => {
        await zeroEffect([{ ...fileSeed(), declaredBytes }], [400, invalid]);
      },
    );

    it("10485760 bytes is accepted and 10485761 is LIMIT_EXCEEDED", async () => {
      const ok = await draftSession();
      expect(
        (
          await reserve(api, token, ok.id, [
            fileSeed({ declaredBytes: TEN_MIB }),
          ])
        ).status,
      ).toBe(200);
      await zeroEffect(
        [fileSeed({ declaredBytes: TEN_MIB + 1 })],
        [422, wire("LIMIT_EXCEEDED")],
      );
    });

    it("expectedRevision must be a positive integer", async () => {
      const session = await draftSession();
      for (const expectedRevision of [undefined, 0, -1, "1", 1.5]) {
        const reply = await reserve(api, token, session.id, [fileSeed()], {
          body: { expectedRevision, files: [fileSeed()] },
        });
        expect([reply.status, reply.json]).toEqual([400, invalid]);
      }
    });

    const ACCEPTED_NAMES = [
      "fatura.pdf",
      "fatura março.pdf",
      "a..b.pdf",
      ".env.pdf",
      "x".repeat(255),
    ];
    it.each(ACCEPTED_NAMES)(
      "fileName %#: accepted verbatim",
      async (fileName) => {
        const session = await draftSession();
        const reply = await reserve(api, token, session.id, [
          fileSeed({ fileName }),
        ]);
        expect(reply.status).toBe(200);
        expect(reply.json.attachments[0].fileName).toBe(fileName);
      },
    );

    const REJECTED_NAMES: Array<[string, string]> = [
      ["NFD (not normalised, never rewritten)", "marc\u0327o.pdf"],
      ["256 characters", "x".repeat(256)],
      ["empty", ""],
      ["NUL", "a\u0000b.pdf"],
      ["CR", "a\rb.pdf"],
      ["LF", "a\nb.pdf"],
      ["C1 control", "a\u0085b.pdf"],
      ["line separator", "a\u2028b.pdf"],
      ["paragraph separator", "a\u2029b.pdf"],
      ["RLO bidi", "a\u202eb.pdf"],
      ["isolate bidi", "a\u2066b.pdf"],
      ["slash", "a/b.pdf"],
      ["backslash", "a\\b.pdf"],
      ["whole name .", "."],
      ["whole name ..", ".."],
      ["leading space", " a.pdf"],
      ["trailing space", "a.pdf "],
    ];
    it.each(REJECTED_NAMES)(
      "fileName %s is INVALID_INPUT",
      async (_name, fileName) => {
        await zeroEffect([fileSeed({ fileName })], [400, invalid]);
      },
    );

    it("the declared MIME is a closed literal allowlist (10 accepted, everything else UNSUPPORTED_DOCUMENT)", async () => {
      const ACCEPTED = [
        "application/pdf",
        "text/csv",
        "text/plain",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/x-ofx",
        "application/vnd.ofx",
        "image/png",
        "image/jpeg",
        "image/webp",
      ];
      for (const mime of ACCEPTED) {
        const session = await draftSession();
        const reply = await reserve(api, token, session.id, [
          fileSeed({ mime }),
        ]);
        expect([mime, reply.status]).toEqual([mime, 200]);
      }
      for (const mime of [
        "image/gif",
        "image/heic",
        "application/zip",
        "text/html",
        "APPLICATION/PDF",
        "application/pdf; charset=x",
        "",
      ]) {
        await zeroEffect(
          [fileSeed({ mime })],
          [422, wire("UNSUPPORTED_DOCUMENT")],
        );
      }
    });
  });

  describe("only an editable, live session reserves (V22)", () => {
    it.each([
      "ANALYZING",
      "READY",
      "CONFIRMED",
      "REVIEW_REQUIRED",
      "CANCELLED",
    ])(
      "%s: LEASE_CONFLICT, zero effect (and DRAFT/NEEDS_INPUT are the only accepted states)",
      async (state) => {
        const session = await draftSession({ state });
        const before = await fullDigest(setup, session.id);
        const reply = await reserve(api, token, session.id, [fileSeed()]);
        expect([reply.status, reply.json.code]).toEqual([
          409,
          "LEASE_CONFLICT",
        ]);
        expect(await fullDigest(setup, session.id)).toEqual(before);
      },
    );

    it("EXPIRED persisted by the reaper: a NEW reservation is 410 SESSION_EXPIRED, zero effect", async () => {
      const session = await draftSession({ state: "EXPIRED" });
      const before = await fullDigest(setup, session.id);
      const reply = await reserve(api, token, session.id, [fileSeed()]);
      expect([reply.status, reply.json.code]).toEqual([410, "SESSION_EXPIRED"]);
      expect(await fullDigest(setup, session.id)).toEqual(before);
    });

    it("NEEDS_INPUT reserves like DRAFT", async () => {
      const session = await draftSession({ state: "NEEDS_INPUT" });
      const reply = await reserve(api, token, session.id, [fileSeed()]);
      expect(reply.status).toBe(200);
    });

    it("expires_at reached (persisted state still DRAFT, reaper not run): a NEW reservation is 410 SESSION_EXPIRED; one millisecond earlier it is accepted", async () => {
      const expired = await draftSession({ expiresAt: FIXED_NOW });
      const before = await fullDigest(setup, expired.id);
      const reply = await reserve(api, token, expired.id, [fileSeed()]);
      expect([reply.status, reply.json.code]).toEqual([410, "SESSION_EXPIRED"]);
      expect(await fullDigest(setup, expired.id)).toEqual(before);
      const live = await draftSession({
        expiresAt: new Date(FIXED_NOW.getTime() + 1),
      });
      expect((await reserve(api, token, live.id, [fileSeed()])).status).toBe(
        200,
      );
    });

    it("an identical replay on an EXPIRED-by-clock session is a read: 200 with the renderer's view WITHOUT attachments", async () => {
      const session = await draftSession();
      const file = fileSeed();
      expect((await reserve(api, token, session.id, [file])).status).toBe(200);
      await setup.importSession.update({
        where: { id: session.id },
        data: { expiresAt: FIXED_NOW },
      });
      const before = await fullDigest(setup, session.id);
      const replay = await reserve(api, token, session.id, [file]);
      expect(replay.status).toBe(200);
      expect(replay.json.attachments).toEqual([]);
      expect(await fullDigest(setup, session.id)).toEqual(before);
    });

    it("an identical replay after the user CANCELLED the session is a read too: 200 without attachments, and no ref or revision moves", async () => {
      const session = await draftSession();
      const file = fileSeed();
      expect((await reserve(api, token, session.id, [file])).status).toBe(200);
      const cancelled = await api.call(
        "POST",
        `/import-sessions/${session.id}/cancel`,
        { token, headers: UI_HEADERS, body: { expectedRevision: 2 } },
      );
      expect(cancelled.status).toBe(200);
      const before = await fullDigest(setup, session.id);
      const replay = await reserve(api, token, session.id, [file]);
      expect(replay.status).toBe(200);
      expect(replay.json.attachments).toEqual([]);
      expect(await fullDigest(setup, session.id)).toEqual(before);
    });
  });

  describe("positions and per-session bytes are explicit checks, not a UNIQUE violation (V11)", () => {
    it("10 refs over the lifetime including RELEASED/FAILED: the 11th is LIMIT_EXCEEDED; five 10 MiB files fill the 50 MiB session exactly and one more byte is rejected", async () => {
      const full = await draftSession();
      for (let position = 0; position < 10; position++) {
        await seedRef(setup, full, world.users.restricted, {
          position,
          state: position % 2 ? "FAILED" : "RELEASED",
          temporaryStorageKey: null,
          reservedBytes: 0,
          generation: position % 2 ? 3 : 2,
          releasedAt: position % 2 ? null : FIXED_NOW,
        });
      }
      const rejected = await reserve(api, token, full.id, [fileSeed()]);
      expect([rejected.status, rejected.json.code]).toEqual([
        422,
        "LIMIT_EXCEEDED",
      ]);

      const session = await draftSession();
      const five = Array.from({ length: 5 }, () =>
        fileSeed({ declaredBytes: TEN_MIB }),
      );
      const ok = await reserve(api, token, session.id, five);
      expect(ok.status).toBe(200);
      const before = await fullDigest(setup, session.id);
      const over = await reserve(
        api,
        token,
        session.id,
        [fileSeed({ declaredBytes: 1 })],
        { expectedRevision: 2 },
      );
      expect([over.status, over.json.code]).toEqual([422, "LIMIT_EXCEEDED"]);
      expect(await fullDigest(setup, session.id)).toEqual(before);
      expect(5 * TEN_MIB).toBe(50 * MIB);
    });

    it("tenant physical cap: retained artifacts above 209715200 reject +1 byte and accept the exact remainder", async () => {
      const anchor = {
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
      };
      // 19 retained artifacts of 10 MiB = 190 MiB; the remainder to 200 MiB is exactly 10 MiB.
      const artifacts: string[] = [];
      try {
        for (let i = 0; i < 19; i++) {
          artifacts.push(
            await seedArtifact(setup, anchor, { verifiedBytes: TEN_MIB }),
          );
        }
        const tight = await draftSession();
        const over = await reserve(api, token, tight.id, [
          fileSeed({ declaredBytes: TEN_MIB }),
          fileSeed({ declaredBytes: 1 }),
        ]);
        expect([over.status, over.json.code]).toEqual([422, "LIMIT_EXCEEDED"]);
        expect(await refsOf(setup, tight.id)).toHaveLength(0);
        const exact = await reserve(api, token, tight.id, [
          fileSeed({ declaredBytes: TEN_MIB }),
        ]);
        expect(exact.status).toBe(200);
      } finally {
        await setup.importSessionArtifact.deleteMany({
          where: { tenantId: world.tenantId, state: "RESERVED" },
        });
        await setup.importArtifact.deleteMany({
          where: { id: { in: artifacts } },
        });
      }
    });
  });

  describe("projection inside the writer transaction (V55): a corrupt draft never leaves a committed reservation", () => {
    it("draft_json that is valid JSON but not a draft: sanitised 500, zero refs, zero revision", async () => {
      const session = await draftSession();
      await setup.$executeRawUnsafe(
        `UPDATE import_sessions SET draft_json = '{"version":1,"lines":"x","secret-sentinel":"OCR-SENTINEL"}' WHERE id = ?`,
        session.id,
      );
      const before = await fullDigest(setup, session.id);
      const reply = await reserve(api, token, session.id, [fileSeed()]);
      expect([reply.status, reply.json]).toEqual([
        500,
        { statusCode: 500, message: "Internal server error" },
      ]);
      expect(reply.text).not.toContain("OCR-SENTINEL");
      expect(await fullDigest(setup, session.id)).toEqual(before);
      expect(await refsOf(setup, session.id)).toHaveLength(0);
    });
  });
});
