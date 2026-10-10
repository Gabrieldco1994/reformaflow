// The database guard must run before PrismaClient is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../../../scripts/test-db-env.cjs");

import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  cleanupImportWorld,
  FIXED_NOW,
  seedImportWorld,
  seedSession,
  type ImportWorld,
  type WorldUser,
} from "../../../test-utils/import-session-harness";
import {
  bootVaultApp,
  connectVaultTestDatabase,
  vaultTestDatabaseIsSafe,
  canonicalDir,
  contentPath,
  fullDigest,
  inSeconds,
  pdfBytes,
  putContent,
  rawCall,
  refsOf,
  seedArtifact,
  seedRef,
  TEN_MIB,
  treeOf,
  UI_HEADERS,
  CANONICAL_VAULT,
  wire,
  type RecoveryApp,
} from "../../../test-utils/import-session-vault-harness";
import { seedApplied } from "../../../test-utils/import-session-recovery-harness";
import { IMPORT_SESSION_GRANT_VERIFIER } from "../import-session.capability";
import { ImportUiGrantIssuer } from "../import-session-ui-grant";

/**
 * B2a RED (slice 1: PUT pre-claim decisions, C2 + C4 + slots). Nothing here reaches the file
 * system: every case is decided by the database (classification of the ref, slots, corrupt
 * draft) or by request framing, before any byte is stored. The successful claim, streaming,
 * finalize and self-fence are the NEXT slice (the slot-until-close and framing specs prove them against the real `VAULT_DIR` filesystem).
 *
 * The harness app does NOT register the framing middleware: the controller must refuse hostile
 * framing on its own (C2), before it touches a ref, and with the wire error, never a Nest body.
 */
const PREFIX = "imp-b2a-claim";
const setup = new PrismaClient();
let world: ImportWorld;
let api: RecoveryApp;
let vaultRoot: string;
let tokens: {
  owner: string;
  restricted: string;
  peer: string;
  foreign: string;
};
jest.setTimeout(180_000);

const notFound = wire("NOT_FOUND");
const invalid = wire("INVALID_INPUT");
const leaseConflict = wire("LEASE_CONFLICT");
const busy = wire("RETRYABLE_WRITE_CONFLICT");
const unsupported = wire("UNSUPPORTED_DOCUMENT");
const expired = wire("SESSION_EXPIRED");
const sanitized500 = { statusCode: 500, message: "Internal server error" };

const restricted = () => world.users.restricted;
const draft = (owner: WorldUser, extra: Record<string, unknown> = {}) =>
  seedSession(setup, world, { ownerUserId: owner.id, ...(extra as object) });
/** Session + one ref for `owner`; `ref` overrides the RESERVED gen-1 default. */
async function withRef(
  owner: WorldUser,
  ref: Parameters<typeof seedRef>[3] = {},
  session: Record<string, unknown> = {},
) {
  const row = await draft(owner, session);
  const id = await seedRef(setup, row, owner, ref);
  return { session: row, id };
}
/** As a real finalize leaves it: temporary key and reserved bytes kept, purge pending. */
const releasedVerifiedSeed = () => {
  const id = randomUUID();
  return {
    id,
    state: "RELEASED",
    generation: 2,
    temporaryStorageKey: `t/${id}/g2/blob`,
    reservedBytes: 1000,
    temporaryPurgePending: true,
    releasedAt: inSeconds(-5),
    verifiedAt: FIXED_NOW,
  };
};
const body = (n: number) => pdfBytes(n);
const put = (
  who: keyof typeof tokens,
  target: { session: { id: string }; id: string },
  options: Parameters<typeof putContent>[3] = {},
) =>
  putContent(api, target.session.id, target.id, {
    token: tokens[who],
    ...options,
  });

describe("B2a slice 1 — PUT content: decisions before any byte", () => {
  beforeAll(async () => {
    await connectVaultTestDatabase(setup);
    world = await seedImportWorld(setup, PREFIX);
    vaultRoot = canonicalDir(await mkdtemp(join(tmpdir(), "rf-b2a-claim-")));
    api = await bootVaultApp(setup, {
      writes: true,
      vault: CANONICAL_VAULT,
      vaultDir: vaultRoot,
    });
    tokens = {
      owner: await api.tokenFor(world.users.owner),
      restricted: await api.tokenFor(world.users.restricted),
      peer: await api.tokenFor(world.users.peer),
      foreign: await api.tokenFor(world.users.foreign),
    };
  });
  afterAll(async () => {
    await api?.close();
    if (vaultTestDatabaseIsSafe(setup)) await cleanupImportWorld(setup, PREFIX);
    await setup.$disconnect();
    await rm(vaultRoot, { recursive: true, force: true });
  });
  // Slots are tenant-wide: no case may leak a claimed ref into the next one.
  beforeEach(async () => {
    await setup.importSessionArtifact.deleteMany({
      where: { tenantId: world.tenantId, uploadGeneration: { gte: 2 } },
    });
  });

  describe("C2: framing is refused by the controller itself (app WITHOUT the middleware)", () => {
    it("a VALID JSON body on the octet-stream route is 422 UNSUPPORTED_DOCUMENT with the wire error and no ref mutated", async () => {
      const target = await withRef(restricted());
      const before = await fullDigest(setup, target.session.id);
      const reply = await put("restricted", target, {
        bareHeaders: {
          ...UI_HEADERS,
          "content-type": "application/json",
          "content-length": "2",
        },
        body: Buffer.from("{}"),
      });
      expect([reply.status, reply.json]).toEqual([422, unsupported]);
      expect(await fullDigest(setup, target.session.id)).toEqual(before);
    });

    it.each([
      ["no content-type", { "content-length": "1000" }],
      [
        "octet-stream with parameters",
        {
          "content-type": "application/octet-stream; charset=utf-8",
          "content-length": "1000",
        },
      ],
      [
        "multipart",
        {
          "content-type": "multipart/form-data; boundary=x",
          "content-length": "1000",
        },
      ],
      [
        "a documentary MIME",
        { "content-type": "application/pdf", "content-length": "1000" },
      ],
    ])(
      "%s is 422 UNSUPPORTED_DOCUMENT, before the ref is looked at",
      async (_name, headers) => {
        const target = await withRef(restricted());
        const before = await fullDigest(setup, target.session.id);
        const reply = await put("restricted", target, {
          bareHeaders: { ...UI_HEADERS, ...headers },
          body: body(1000),
        });
        expect([reply.status, reply.json]).toEqual([422, unsupported]);
        expect(await fullDigest(setup, target.session.id)).toEqual(before);
      },
    );

    it.each([
      [
        "Transfer-Encoding: chunked",
        {
          "transfer-encoding": "chunked",
          "content-type": "application/octet-stream",
        },
      ],
      [
        "Content-Encoding: gzip",
        {
          "content-encoding": "gzip",
          "content-type": "application/octet-stream",
          "content-length": "1000",
        },
      ],
      [
        "Content-Length: 0",
        { "content-type": "application/octet-stream", "content-length": "0" },
      ],
      [
        "Content-Length over the 10 MiB file limit",
        {
          "content-type": "application/octet-stream",
          "content-length": String(TEN_MIB + 1),
        },
      ],
    ])(
      "%s is 400 INVALID_INPUT with the wire error, identically for own, foreign and unknown sessions (header syntax precedes ownership)",
      async (_name, rawHeaders) => {
        const headers: Record<string, string> = rawHeaders;
        const own = await withRef(restricted());
        const foreignRow = await withRef(world.users.peer);
        const before = await fullDigest(setup, own.session.id);
        const unknown = {
          session: { id: "00000000-0000-4000-8000-00000000dead" },
          id: "00000000-0000-4000-8000-00000000beef",
        };
        const replies = [];
        for (const target of [own, foreignRow, unknown]) {
          const sent = await put("restricted", target, {
            bareHeaders: { ...UI_HEADERS, ...headers },
            body:
              headers["content-length"] === "0"
                ? Buffer.alloc(0)
                : headers["content-length"] === "1000"
                  ? body(1000)
                  : undefined,
          });
          replies.push([sent.status, sent.json]);
        }
        expect(replies).toEqual([
          [400, invalid],
          [400, invalid],
          [400, invalid],
        ]);
        expect(await fullDigest(setup, own.session.id)).toEqual(before);
      },
    );

    it("Content-Length different from the DECLARED size is 400 for the owner, and 404 for a foreign session (ownership first)", async () => {
      const target = await withRef(restricted(), { declaredBytes: 1000 });
      const before = await fullDigest(setup, target.session.id);
      const mismatch = await put("restricted", target, { body: body(1001) });
      expect([mismatch.status, mismatch.json]).toEqual([400, invalid]);
      const foreign = await put("peer", target, { body: body(1001) });
      expect([foreign.status, foreign.json]).toEqual([404, notFound]);
      expect(await fullDigest(setup, target.session.id)).toEqual(before);
    });

    it("an invalid JSON body is refused by the Node parser with 400 before the app: the shape is NOT asserted (C2: the parser's own error is not the application's contract) and no ref is mutated", async () => {
      const target = await withRef(restricted());
      const before = await fullDigest(setup, target.session.id);
      const reply = await rawCall(
        api,
        "PUT",
        contentPath(target.session.id, target.id),
        {
          token: tokens.restricted,
          headers: {
            ...UI_HEADERS,
            "content-type": "application/json",
            "content-length": "3",
          },
          body: "{x}",
        },
      );
      expect(reply.status).toBe(400);
      expect(await fullDigest(setup, target.session.id)).toEqual(before);
    });
  });

  describe("classification of the ref before a claim (design 3.2)", () => {
    it("an already claimed ref (generation 2) is 409 LEASE_CONFLICT and not a second claim", async () => {
      const target = await withRef(restricted(), {
        generation: 2,
        leaseExpiresAt: inSeconds(60),
      });
      const before = await fullDigest(setup, target.session.id);
      const reply = await put("restricted", target);
      expect([reply.status, reply.json]).toEqual([409, leaseConflict]);
      expect(await fullDigest(setup, target.session.id)).toEqual(before);
    });

    it.each([
      [
        "a generation-1 ref whose claim window lapsed (lease = now)",
        { leaseExpiresAt: FIXED_NOW },
      ],
      [
        "a FAILED ref",
        {
          state: "FAILED",
          generation: 3,
          temporaryPurgePending: true,
          leaseExpiresAt: null,
        },
      ],
      ["a ref with a purge pending", { temporaryPurgePending: true }],
      [
        "a RELEASED ref of a cancelled upload",
        {
          state: "RELEASED",
          releasedAt: inSeconds(-5),
          temporaryStorageKey: null,
          generation: 2,
        },
      ],
    ])("%s is 409 LEASE_CONFLICT with zero effect", async (_name, ref) => {
      const target = await withRef(restricted(), ref as never);
      const before = await fullDigest(setup, target.session.id);
      const reply = await put("restricted", target);
      expect([reply.status, reply.json]).toEqual([409, leaseConflict]);
      expect(await fullDigest(setup, target.session.id)).toEqual(before);
    });

    it("a duplicate ATTACHED upload replays as 200 with the session view, no FS and no database write", async () => {
      const row = await draft(restricted());
      const artifactId = await seedArtifact(setup, row, {
        verifiedBytes: 1000,
      });
      const id = await seedRef(setup, row, restricted(), {
        state: "ATTACHED",
        artifactId,
        verifiedAt: FIXED_NOW,
      });
      const before = await fullDigest(setup, row.id);
      const reply = await put("restricted", { session: row, id });
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({ id: row.id, state: "DRAFT" });
      expect(await fullDigest(setup, row.id)).toEqual(before);
    });

    it("a RELEASED duplicate (verified_at set, no artifact) in an EDITABLE session replays as 200 with no write; in a non-editable session it is 409", async () => {
      const releasedVerified = releasedVerifiedSeed;
      const editable = await withRef(restricted(), releasedVerified());
      const before = await fullDigest(setup, editable.session.id);
      const reply = await put("restricted", editable);
      expect(reply.status).toBe(200);
      expect(reply.json).toMatchObject({
        id: editable.session.id,
        state: "DRAFT",
      });
      expect(await fullDigest(setup, editable.session.id)).toEqual(before);
      const frozen = await withRef(restricted(), releasedVerified(), {
        state: "CONFIRMED",
      });
      const refused = await put("restricted", frozen);
      expect([refused.status, refused.json]).toEqual([409, leaseConflict]);
    });

    it("another user's ATTACHED ref, and a ref of ANOTHER session, are 404 opaque (never 200/409)", async () => {
      const row = await draft(restricted());
      const artifactId = await seedArtifact(setup, row, {});
      const id = await seedRef(setup, row, restricted(), {
        state: "ATTACHED",
        artifactId,
        verifiedAt: FIXED_NOW,
      });
      const other = await draft(restricted());
      const stolen = await put("peer", { session: row, id });
      const crossed = await put("restricted", { session: other, id });
      expect([stolen.status, stolen.json]).toEqual([404, notFound]);
      expect([crossed.status, crossed.json]).toEqual([404, notFound]);
    });

    it("EXPIRED by the clock: PUT is 410 SESSION_EXPIRED even for an ATTACHED replay; the boundary expires_at = now + 1 ms is still 200", async () => {
      const row = await draft(restricted(), { expiresAt: FIXED_NOW });
      const artifactId = await seedArtifact(setup, row, {});
      const id = await seedRef(setup, row, restricted(), {
        state: "ATTACHED",
        artifactId,
        verifiedAt: FIXED_NOW,
      });
      const gone = await put("restricted", { session: row, id });
      expect([gone.status, gone.json]).toEqual([410, expired]);
      await setup.importSession.update({
        where: { id: row.id },
        data: { expiresAt: inSeconds(0.001) },
      });
      const still = await put("restricted", { session: row, id });
      expect(still.status).toBe(200);
    });

    it("EXPIRED persisted by the reaper: PUT is 410 SESSION_EXPIRED, an ATTACHED replay included", async () => {
      const row = await draft(restricted(), { state: "EXPIRED" });
      const artifactId = await seedArtifact(setup, row, {});
      const attached = await seedRef(setup, row, restricted(), {
        state: "ATTACHED",
        artifactId,
        verifiedAt: FIXED_NOW,
      });
      const fresh = await seedRef(setup, row, restricted(), { position: 1 });
      for (const id of [attached, fresh]) {
        const reply = await put("restricted", { session: row, id });
        expect([reply.status, reply.json]).toEqual([410, expired]);
      }
    });

    it("APPLIED: PUT is 409 LEASE_CONFLICT for a fresh ref and for an ATTACHED replay (the session is closed, not editable)", async () => {
      const applied = await seedApplied(setup, world, { owner: restricted() });
      const row = {
        id: applied.id,
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
      };
      const artifactId = await seedArtifact(setup, row, {});
      const attached = await seedRef(setup, row, restricted(), {
        state: "ATTACHED",
        artifactId,
        verifiedAt: FIXED_NOW,
      });
      const fresh = await seedRef(setup, row, restricted(), { position: 1 });
      for (const id of [attached, fresh]) {
        const reply = await put("restricted", { session: row, id });
        expect([reply.status, reply.json]).toEqual([409, leaseConflict]);
      }
    });

    it.each([
      "CANCELLED",
      "CONFIRMED",
      "REVIEW_REQUIRED",
      "ANALYZING",
      "READY",
    ])(
      "a %s session is 409 LEASE_CONFLICT (never an upload, never a 404 that would hide the state from its owner)",
      async (state) => {
        const target = await withRef(restricted(), {}, { state });
        const before = await fullDigest(setup, target.session.id);
        const reply = await put("restricted", target);
        expect([reply.status, reply.json]).toEqual([409, leaseConflict]);
        expect(await fullDigest(setup, target.session.id)).toEqual(before);
      },
    );
  });

  describe("C4 + slots: the grant is minted from the path with generation 1, and a full slot spends nothing", () => {
    async function occupy(owner: WorldUser, leaseSeconds = 60) {
      const held = await draft(owner);
      return seedRef(setup, held, owner, {
        generation: 2,
        leaseExpiresAt: inSeconds(leaseSeconds),
      });
    }

    it.each([
      ["the user already holds his one slot", async () => occupy(restricted())],
      [
        "the tenant's two slots are held by other users",
        async () => {
          await occupy(world.users.owner);
          await occupy(world.users.peer);
        },
      ],
      [
        "the tenant's two slots are held, one of them EXPIRED but not yet fenced (conservative count)",
        async () => {
          await occupy(world.users.owner);
          await occupy(world.users.peer, -600);
        },
      ],
    ])(
      "%s => 503 RETRYABLE_WRITE_CONFLICT, the ref stays RESERVED generation 1 with an untouched lease, and 0 grants are verified",
      async (_name, fill) => {
        await fill();
        const target = await withRef(restricted());
        const issuer = api.app.get(ImportUiGrantIssuer, { strict: false });
        const verifier = api.app.get(IMPORT_SESSION_GRANT_VERIFIER, {
          strict: false,
        });
        const issue = jest.spyOn(issuer, "issue");
        const verify = jest.spyOn(verifier as never, "verify");
        try {
          const before = await fullDigest(setup, target.session.id);
          const reply = await put("restricted", target);
          expect([reply.status, reply.json]).toEqual([503, busy]);
          expect(verify).not.toHaveBeenCalled();
          expect(issue).toHaveBeenCalledTimes(1);
          expect(issue.mock.calls[0]![2]).toEqual({
            operation: "UPLOAD_CONTENT",
            sessionId: target.session.id,
            attachmentId: target.id,
            uploadGeneration: 1,
          });
          expect(await fullDigest(setup, target.session.id)).toEqual(before);
          const [row] = await refsOf(setup, target.session.id);
          expect(row).toMatchObject({ state: "RESERVED", uploadGeneration: 1 });
        } finally {
          issue.mockRestore();
          verify.mockRestore();
        }
      },
    );

    it("the grant generation comes from the PATH contract (literal 1), not from the stored generation, and a body-borne grant is ignored", async () => {
      const target = await withRef(restricted(), {
        generation: 2,
        leaseExpiresAt: inSeconds(60),
      });
      const issuer = api.app.get(ImportUiGrantIssuer, { strict: false });
      const issue = jest.spyOn(issuer, "issue");
      try {
        const reply = await put("restricted", target, {
          headers: { "x-rf-grant": "forged", "x-rf-import-generation": "2" },
        });
        expect([reply.status, reply.json]).toEqual([409, leaseConflict]);
        expect(issue).toHaveBeenCalledTimes(1);
        expect(issue.mock.calls[0]![2]).toMatchObject({
          operation: "UPLOAD_CONTENT",
          uploadGeneration: 1,
        });
      } finally {
        issue.mockRestore();
      }
    });

    it("a slot released later is usable by a NEW request for the same reservation without touching its claim window (V56): the 503 is recoverable", async () => {
      const slot = await occupy(restricted());
      const target = await withRef(restricted());
      const first = await put("restricted", target);
      expect([first.status, first.json]).toEqual([503, busy]);
      const [reservation] = await refsOf(setup, target.session.id);
      await setup.importSessionArtifact.update({
        where: { id: slot },
        data: {
          state: "FAILED",
          uploadGeneration: 3,
          temporaryPurgePending: true,
        },
      });
      const second = await put("restricted", target, { body: body(999) });
      // Header/size mismatch is decided AFTER the claim window is confirmed intact.
      expect([second.status, second.json]).toEqual([400, invalid]);
      const [after] = await refsOf(setup, target.session.id);
      expect(after!.uploadLeaseExpiresAt).toEqual(
        reservation!.uploadLeaseExpiresAt,
      );
      expect(after!.uploadGeneration).toBe(1);
    });
  });

  describe("V70: PUT matrix, session state x ref state (real PrismaService, fixed clock)", () => {
    type Seeder = (
      row: { id: string; tenantId: string; ownerProjectId: string },
      position: number,
    ) => Promise<string>;
    const plain =
      (seed: (id: string) => Parameters<typeof seedRef>[3]): Seeder =>
      async (row, position) => {
        const id = randomUUID();
        return seedRef(setup, row, restricted(), { ...seed(id), id, position });
      };
    const refs: Record<string, Seeder> = {
      ATTACHED: async (row, position) => {
        const artifactId = await seedArtifact(setup, row, {});
        return seedRef(setup, row, restricted(), {
          state: "ATTACHED",
          artifactId,
          verifiedAt: FIXED_NOW,
          position,
        });
      },
      "RELEASED (verified duplicate)": plain(() => releasedVerifiedSeed()),
      "RELEASED (cancel/transfer)": plain((id) => ({
        state: "RELEASED",
        generation: 3,
        temporaryStorageKey: `t/${id}/g2/blob`,
        reservedBytes: 1000,
        temporaryPurgePending: true,
        releasedAt: inSeconds(-5),
      })),
      FAILED: plain((id) => ({
        state: "FAILED",
        generation: 3,
        temporaryStorageKey: `t/${id}/g2/blob`,
        reservedBytes: 1000,
        temporaryPurgePending: true,
        leaseExpiresAt: null,
      })),
      "RESERVED gen1": plain(() => ({})),
      "RESERVED gen2": plain(() => ({ generation: 2 })),
      "RESERVED with an expired lease": plain(() => ({
        leaseExpiresAt: inSeconds(-1),
      })),
    };
    const build = async (kind: string, session: Record<string, unknown>) => {
      const row = await draft(restricted(), session);
      const id = await refs[kind]!(row, 0);
      return { session: row, id };
    };

    describe.each(["DRAFT", "NEEDS_INPUT"])("editable %s", (state) => {
      it.each(["ATTACHED", "RELEASED (verified duplicate)"])(
        "%s is a 200 replay with NO effect: same tables, revision, updated_at and file tree",
        async (kind) => {
          const target = await build(kind, { state });
          const before = await fullDigest(setup, target.session.id);
          const tree = await treeOf(vaultRoot);
          const reply = await put("restricted", target);
          expect(reply.status).toBe(200);
          expect(reply.json).toMatchObject({ id: target.session.id, state });
          expect(await fullDigest(setup, target.session.id)).toEqual(before);
          expect(await treeOf(vaultRoot)).toEqual(tree);
        },
      );
      it.each([
        "RELEASED (cancel/transfer)",
        "FAILED",
        "RESERVED gen2",
        "RESERVED with an expired lease",
      ])("%s is 409 LEASE_CONFLICT with zero effect", async (kind) => {
        const target = await build(kind, { state });
        const before = await fullDigest(setup, target.session.id);
        const reply = await put("restricted", target);
        expect([reply.status, reply.json]).toEqual([409, leaseConflict]);
        expect(await fullDigest(setup, target.session.id)).toEqual(before);
      });
    });

    describe.each([
      "CANCELLED",
      "CONFIRMED",
      "ANALYZING",
      "READY",
      "REVIEW_REQUIRED",
    ])("not editable %s", (state) => {
      it.each([
        "ATTACHED",
        "RELEASED (verified duplicate)",
        "RESERVED gen1",
        "FAILED",
      ])(
        "%s is 409 LEASE_CONFLICT: no replay 200, no claim, no grant, no file",
        async (kind) => {
          const target = await build(kind, { state });
          const before = await fullDigest(setup, target.session.id);
          const tree = await treeOf(vaultRoot);
          const reply = await put("restricted", target);
          expect([reply.status, reply.json]).toEqual([409, leaseConflict]);
          expect(await fullDigest(setup, target.session.id)).toEqual(before);
          expect(await treeOf(vaultRoot)).toEqual(tree);
        },
      );
    });

    describe.each([
      ["persisted EXPIRED", { state: "EXPIRED" }],
      [
        "effectively expired (DRAFT with expires_at <= now)",
        { state: "DRAFT", expiresAt: FIXED_NOW },
      ],
    ])("%s", (_name, session) => {
      it.each([
        "ATTACHED",
        "RELEASED (verified duplicate)",
        "RESERVED gen1",
        "FAILED",
      ])("%s is 410 SESSION_EXPIRED with zero effect", async (kind) => {
        const target = await build(kind, session);
        const before = await fullDigest(setup, target.session.id);
        const reply = await put("restricted", target);
        expect([reply.status, reply.json]).toEqual([410, expired]);
        expect(await fullDigest(setup, target.session.id)).toEqual(before);
      });
    });
  });

  describe("V55: the projection runs inside the claim transaction", () => {
    it("a corrupt draft is a sanitized 500 with the ref, the slots and the grant untouched (corruption never becomes an empty draft)", async () => {
      const target = await withRef(restricted());
      await setup.$executeRawUnsafe(
        `UPDATE import_sessions SET draft_json = '{"version":1,"lines":"x","secret-sentinel":"OCR-SENTINEL"}' WHERE id = ?`,
        target.session.id,
      );
      const verifier = api.app.get(IMPORT_SESSION_GRANT_VERIFIER, {
        strict: false,
      });
      const verify = jest.spyOn(verifier as never, "verify");
      try {
        const before = await fullDigest(setup, target.session.id);
        const reply = await put("restricted", target);
        expect([reply.status, reply.json]).toEqual([500, sanitized500]);
        expect(reply.text).not.toContain("OCR-SENTINEL");
        expect(verify).not.toHaveBeenCalled();
        expect(await fullDigest(setup, target.session.id)).toEqual(before);
      } finally {
        verify.mockRestore();
      }
    });
  });
});
