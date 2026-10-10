// The database guard must run before PrismaClient is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../../../scripts/test-db-env.cjs");

import * as http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
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
  pdfBytes,
  putContent,
  readStoredBlob,
  refsOf,
  seedRef,
  sha256Hex,
  spyVaultOpen,
  storedMode,
  UI_HEADERS,
  CANONICAL_VAULT,
  wire,
  type RecoveryApp,
} from "../../../test-utils/import-session-vault-harness";

/**
 * B2a RED (V67): a slot is held until the FD is CLOSED, not until the database says something
 * else about the ref. The suspended close is observed and held on the REAL filesystem calls of
 * the writer (`fs.promises.open` wrapped for the test, its FileHandle's `close` held); the vault
 * root comes from the real configuration (`VAULT_DIR`). No production hook, no production pause.
 * The writer must therefore call `fsp.open` by property and close through `handle.close()`; a
 * writer built on `createWriteStream`/`openSync` changes that premise and must be decided first.
 *
 * Two ways a claimed upload reaches its close, both with the FD open and the close suspended:
 *   - B1 CANCEL, then the client aborts: the ref is already RELEASED / gen3 / purge pending
 *     (B1 behaviour, untouched) while the FD is open;
 *   - session expiry mid-upload, body finished: the close comes BEFORE the finalize (design 5.1/5.2)
 *     and the upload self-fence is a transaction AFTER the finalize rolled back (3A.3), so at the
 *     suspended close the ref is still RESERVED / gen2; once the close is released the finalize
 *     fails with 410 and only then the ref is FAILED / gen3 / purge pending.
 * The slot count is the union by refId of {DB RESERVED/gen2} and {registry entries with an open
 * FD}: a claimed ref in both counts once, a fenced ref whose FD is still open still counts.
 * Another user or tenant keeps advancing within the limits and must really finish (200, ATTACHED,
 * sha256 of what was sent AND the bytes on disk); a 422/404 proves nothing.
 */
const PREFIX = "imp-b2a-slotclose";
const setup = new PrismaClient();
let world: ImportWorld;
let api: RecoveryApp;
let root: string;
let tokens: { restricted: string; peer: string; foreign: string };
jest.setTimeout(60_000);

function deferred<T = void>() {
  let resolve!: (value?: T) => void;
  const promise = new Promise<T>((r) => (resolve = r as (value?: T) => void));
  return { promise, resolve };
}
async function within<T>(promise: Promise<T>, ms: number, what: string) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout: ${what}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function until<T>(read: () => Promise<T | null | false>, what: string) {
  const deadline = Date.now() + 4000;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`never happened: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A PUT whose body is delivered in two halves so the test can act mid-upload. */
function slowPut(
  token: string,
  sessionId: string,
  refId: string,
  payload: Buffer,
) {
  const port = (api.app.getHttpServer().address() as AddressInfo).port;
  const reply = deferred<{ status: number; json: unknown } | "aborted">();
  const half = payload.length / 2;
  const req = http.request(
    {
      host: "127.0.0.1",
      port,
      method: "PUT",
      path: contentPath(sessionId, refId),
      agent: false,
      headers: {
        ...UI_HEADERS,
        authorization: `Bearer ${token}`,
        "content-type": "application/octet-stream",
        "content-length": String(payload.length),
      },
    },
    (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* not json */
        }
        reply.resolve({ status: res.statusCode ?? 0, json });
      });
    },
  );
  req.on("error", () => reply.resolve("aborted"));
  req.write(payload.subarray(0, half));
  return {
    reply: reply.promise,
    finish: () => req.end(payload.subarray(half)),
    abort: () => req.destroy(),
  };
}

const sessionWithRef = async (owner: WorldUser, tenantOverrides = {}) => {
  const session = await seedSession(setup, world, {
    ownerUserId: owner.id,
    ...tenantOverrides,
  });
  const id = await seedRef(setup, session, owner, { declaredBytes: 1000 });
  return { session, id };
};

/** 200 + the durable proof of a completed upload: ATTACHED ref, verified artifact of THESE bytes. */
async function expectCompleted(
  reply: { status: number; json?: unknown },
  target: { session: { id: string }; id: string },
  payload: Buffer,
) {
  expect(reply.status).toBe(200);
  const [ref] = await refsOf(setup, target.session.id);
  expect(ref).toMatchObject({ state: "ATTACHED", reservedBytes: 0 });
  expect(ref!.artifactId).not.toBeNull();
  expect(ref!.verifiedAt).not.toBeNull();
  const artifact = await setup.importArtifact.findUniqueOrThrow({
    where: { id: ref!.artifactId! },
  });
  expect(artifact).toMatchObject({
    documentSha256: sha256Hex(payload),
    verifiedBytes: payload.length,
  });
  const onDisk = await readStoredBlob(root, artifact.storageKey!);
  expect(onDisk.length).toBe(payload.length);
  expect(sha256Hex(onDisk)).toBe(sha256Hex(payload));
  expect(sha256Hex(onDisk)).toBe(artifact.documentSha256);
  expect(await storedMode(root, artifact.storageKey!)).toBe(0o600);
}

describe("B2a slice 1 — V67: the slot lives until the FD is closed", () => {
  // Per-case gate on the real FileHandle of the held ref's temporary file.
  let hooks: {
    heldRef: string;
    opened: ReturnType<typeof deferred<string>>;
    entered: ReturnType<typeof deferred<string>>;
    gate: ReturnType<typeof deferred>;
  };
  let openSpy: jest.SpyInstance | undefined;
  const resetHooks = (heldRef: string) => {
    hooks?.gate.resolve();
    hooks = {
      heldRef,
      opened: deferred<string>(),
      entered: deferred<string>(),
      gate: deferred(),
    };
  };
  const hold = (refId: string, handle: FileHandle) => {
    if (refId !== hooks.heldRef) return;
    hooks.opened.resolve(refId);
    const close = handle.close.bind(handle);
    handle.close = async () => {
      hooks.entered.resolve(refId);
      await hooks.gate.promise;
      return close();
    };
  };

  beforeAll(async () => {
    await connectVaultTestDatabase(setup);
    world = await seedImportWorld(setup, PREFIX);
    root = canonicalDir(await mkdtemp(join(tmpdir(), "rf-b2a-slot-")));
    resetHooks("");
    api = await bootVaultApp(setup, {
      writes: true,
      vault: CANONICAL_VAULT,
      vaultDir: root,
    });
    tokens = {
      restricted: await api.tokenFor(world.users.restricted),
      peer: await api.tokenFor(world.users.peer),
      foreign: await api.tokenFor(world.users.foreign),
    };
  });
  afterAll(async () => {
    hooks.gate.resolve();
    await api?.close();
    if (vaultTestDatabaseIsSafe(setup)) await cleanupImportWorld(setup, PREFIX);
    await setup.$disconnect();
    await rm(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    openSpy = spyVaultOpen(root, (refId, handle) => hold(refId, handle));
    await setup.importSessionArtifact.deleteMany({
      where: { tenantId: { in: [world.tenantId, world.otherTenantId] } },
    });
    await setup.importArtifact.deleteMany({
      where: { tenantId: { in: [world.tenantId, world.otherTenantId] } },
    });
  });

  afterEach(() => {
    hooks.gate.resolve();
    openSpy?.mockRestore();
  });

  type Target = { session: { id: string }; id: string };
  const scenarios: Array<{
    name: string;
    trigger: (A: Target, upload: ReturnType<typeof slowPut>) => Promise<void>;
    /** What the database says while the close is suspended and the FD is open. */
    atSuspendedClose: {
      ref: Record<string, unknown>;
      reservedGen2Rows: number;
    };
    firstReply: (reply: unknown) => void;
    /** What the database says once the close has been released and the first request answered. */
    afterClose: Record<string, unknown>;
  }> = [
    {
      name: "B1 CANCEL mid-upload (the client then aborts, which drives the writer to its close)",
      trigger: async (A, upload) => {
        const cancelled = await api.call(
          "POST",
          `/import-sessions/${A.session.id}/cancel`,
          {
            token: tokens.restricted,
            headers: UI_HEADERS,
            body: { expectedRevision: 1 },
          },
        );
        expect(cancelled.status).toBe(200);
        upload.abort();
      },
      atSuspendedClose: {
        ref: {
          state: "RELEASED",
          uploadGeneration: 3,
          temporaryPurgePending: true,
        },
        reservedGen2Rows: 0,
      },
      firstReply: (reply) => expect(reply).toBe("aborted"),
      afterClose: {
        state: "RELEASED",
        uploadGeneration: 3,
        temporaryPurgePending: true,
      },
    },
    {
      name: "session expiry mid-upload (the body finishes; the close runs BEFORE the finalize, which then answers 410)",
      trigger: async (A, upload) => {
        await setup.importSession.update({
          where: { id: A.session.id },
          data: { expiresAt: FIXED_NOW },
        });
        upload.finish();
      },
      // the self-fence is a transaction AFTER the finalize rolled back: not yet at the close.
      atSuspendedClose: {
        ref: { state: "RESERVED", uploadGeneration: 2 },
        reservedGen2Rows: 1,
      },
      firstReply: (reply) =>
        expect(reply).toMatchObject({
          status: 410,
          json: wire("SESSION_EXPIRED"),
        }),
      afterClose: {
        state: "FAILED",
        uploadGeneration: 3,
        temporaryPurgePending: true,
      },
    },
  ];

  it.each(scenarios)(
    "$name: the FD stays open, the slot stays taken until the close, unrelated uploads complete, and the slot opens only after the close",
    async ({ trigger, atSuspendedClose, firstReply, afterClose }) => {
      const A = await sessionWithRef(world.users.restricted);
      resetHooks(A.id);
      const payloadA = pdfBytes(1000, "A");
      const upload = slowPut(tokens.restricted, A.session.id, A.id, payloadA);

      // 1. claimed (generation 2) and the temporary file is REALLY open, body half-sent.
      await within(
        hooks.opened.promise,
        4000,
        "real fsp.open of the temporary file (route missing until GREEN)",
      );
      const [claimed] = await refsOf(setup, A.session.id);
      expect(claimed).toMatchObject({ state: "RESERVED", uploadGeneration: 2 });

      // 1b. one claimed upload is BOTH a DB RESERVED/gen2 row and a registry entry: the union by
      // refId counts it once, so the tenant's second slot is free (double counting => 503).
      const early = await sessionWithRef(world.users.peer);
      const earlyBytes = pdfBytes(1000, "early");
      const earlyReply = await putContent(api, early.session.id, early.id, {
        token: tokens.peer,
        body: earlyBytes,
      });
      await expectCompleted(earlyReply, early, earlyBytes);

      // 2. the scenario's trigger; the close is reached and SUSPENDED with the FD still open.
      await trigger(A, upload);
      expect(
        await within(
          hooks.entered.promise,
          4000,
          "close of the held FileHandle entered",
        ),
      ).toBe(A.id);
      const [suspended] = await refsOf(setup, A.session.id);
      expect(suspended).toMatchObject(atSuspendedClose.ref);
      expect(
        await setup.importSessionArtifact.count({
          where: {
            tenantId: world.tenantId,
            state: "RESERVED",
            uploadGeneration: 2,
          },
        }),
      ).toBe(atSuspendedClose.reservedGen2Rows);

      // 3. same user, second reservation: whatever the DB says, the FD is open => busy.
      const B = await sessionWithRef(world.users.restricted);
      const beforeB = await fullDigest(setup, B.session.id);
      const blocked = await putContent(api, B.session.id, B.id, {
        token: tokens.restricted,
        body: pdfBytes(1000, "B"),
      });
      expect([blocked.status, blocked.json]).toEqual([
        503,
        wire("RETRYABLE_WRITE_CONFLICT"),
      ]);
      expect(await fullDigest(setup, B.session.id)).toEqual(beforeB);

      // 4. no global lock: a peer of the tenant and another tenant COMPLETE.
      const peer = await sessionWithRef(world.users.peer);
      const alien = await sessionWithRef(world.users.foreign, {
        tenantId: world.otherTenantId,
        ownerProjectId: world.projects.foreign,
        cardId: world.cards.foreign,
      });
      const peerBytes = pdfBytes(1000, "peer");
      const alienBytes = pdfBytes(1000, "alien");
      const [peerReply, alienReply] = await within(
        Promise.all([
          putContent(api, peer.session.id, peer.id, {
            token: tokens.peer,
            body: peerBytes,
          }),
          putContent(api, alien.session.id, alien.id, {
            token: tokens.foreign,
            body: alienBytes,
          }),
        ]),
        8000,
        "unrelated uploads must not wait for the suspended close",
      );
      await expectCompleted(peerReply, peer, peerBytes);
      await expectCompleted(alienReply, alien, alienBytes);

      // 5. the close completes; only now the slot is free and B goes through.
      hooks.gate.resolve();
      firstReply(await within(upload.reply, 4000, "first upload answer"));
      const [after] = await refsOf(setup, A.session.id);
      expect(after).toMatchObject(afterClose);
      const retryBytes = pdfBytes(1000, "B-retry");
      const again = await until(async () => {
        const reply = await putContent(api, B.session.id, B.id, {
          token: tokens.restricted,
          body: retryBytes,
        });
        return reply.status === 503 ? false : reply;
      }, "slot released after the close");
      await expectCompleted(again, B, retryBytes);
    },
  );
});
