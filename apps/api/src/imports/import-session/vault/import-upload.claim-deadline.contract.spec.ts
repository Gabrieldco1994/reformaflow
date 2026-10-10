require("../../../../../../scripts/test-db-env.cjs");

import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaService } from "../../../prisma/prisma.service";
import {
  FIXED_NOW,
  seedImportWorld,
  seedSession,
} from "../../../test-utils/import-session-harness";
import {
  bootVaultApp,
  CANONICAL_VAULT,
  createVaultTestDatabase,
  fileSeed,
  finishVaultFixture,
  getVaultGate,
  pdfBytes,
  putContent,
  readStoredBlob,
  reserve,
  treeOf,
  type RecoveryApp,
} from "../../../test-utils/import-session-vault-harness";

describe("winning HTTP claim keeps the pre-CAS monotonic deadline", () => {
  it.each([
    ["CONTROL no elapsed CAS", 0, 200],
    ["120000ms elapsed during CAS with wall rollback", 120000, 409],
  ] as const)("%s", async (label, elapsedDuringCas, expectedStatus) => {
    const database = await createVaultTestDatabase();
    let api: RecoveryApp | undefined;
    let monotonic: jest.SpyInstance | undefined;
    let write: jest.SpyInstance | undefined;
    let primary: unknown;
    try {
      const world = await seedImportWorld(
        database.setup,
        `claim-anchor-${elapsedDuringCas}`,
      );
      const active = await bootVaultApp(database.setup, {
        writes: true,
        vault: CANONICAL_VAULT,
      });
      api = active;
      const owner = world.users.restricted;
      const session = await seedSession(database.setup, world, {
        ownerUserId: owner.id,
      });
      const refId = randomUUID();
      const payload = pdfBytes(1000, "claim-anchor");
      const token = await active.tokenFor(owner);
      const reserved = await reserve(active, token, session.id, [
        fileSeed({ id: refId, declaredBytes: payload.length }),
      ]);
      expect(reserved.status).toBe(200);
      const gate = getVaultGate(active);
      const root = gate.boot.runtime()!.config.rootDir;
      const beforeTree = await treeOf(root);
      let now = 0;
      const cas: Array<{ before: number; after: number; count: number }> = [];
      monotonic = jest.spyOn(performance, "now").mockImplementation(() => now);
      const appDb = active.app.get<PrismaService>(PrismaService);
      appDb.$use(async (params, next) => {
        if (
          params.model === "ImportSessionArtifact" &&
          params.action === "updateMany" &&
          params.args.where?.id === refId &&
          params.args.data?.uploadGeneration === 2
        ) {
          const before = performance.now();
          const changed = await next(params);
          now = elapsedDuringCas;
          active.clock.current = new Date(FIXED_NOW.getTime() - 1000);
          cas.push({ before, after: performance.now(), count: changed.count });
          return changed;
        }
        return next(params);
      });
      write = jest.spyOn(gate.storage, "writeClaim");
      const reply = await putContent(active, session.id, refId, {
        token,
        body: payload,
      });
      const ref = await database.setup.importSessionArtifact.findUniqueOrThrow({
        where: { id: refId },
      });
      const artifacts = await database.setup.importArtifact.findMany({
        where: { tenantId: world.tenantId },
      });
      const stored = artifacts[0]?.storageKey
        ? await readStoredBlob(root, artifacts[0].storageKey)
        : Buffer.alloc(0);
      const captured = write.mock.calls.map(([claim]) => ({
        claimedAtMs: claim.claimedAtMs,
        claimedAtMonotonicMs: claim.claimedAtMonotonicMs,
        uploadLeaseExpiresAtMs: claim.uploadLeaseExpiresAtMs,
      }));
      const observed = {
        label,
        pid: process.pid,
        cas,
        captured,
        status: reply.status,
        response: reply.json,
        ref,
        artifactCount: artifacts.length,
        storedBytes: stored.length,
        storedSha256: createHash("sha256").update(stored).digest("hex"),
        beforeTree,
        afterTree: await treeOf(root),
      };
      await writeFile(
        join(database.directory, "claim-anchor-evidence.json"),
        JSON.stringify(observed),
        { flag: "wx", mode: 0o600 },
      );
      expect(cas).toEqual([{ before: 0, after: elapsedDuringCas, count: 1 }]);
      expect({
        status: reply.status,
        captured,
        refState: ref.state,
        artifactCount: artifacts.length,
        storedBytes: stored.length,
      }).toEqual({
        status: expectedStatus,
        captured: [
          {
            claimedAtMs: FIXED_NOW.getTime(),
            claimedAtMonotonicMs: 0,
            uploadLeaseExpiresAtMs: FIXED_NOW.getTime() + 120000,
          },
        ],
        refState: expectedStatus === 200 ? "ATTACHED" : "FAILED",
        artifactCount: expectedStatus === 200 ? 1 : 0,
        storedBytes: expectedStatus === 200 ? 1000 : 0,
      });
      if (expectedStatus === 200) {
        expect(stored).toEqual(payload);
        expect(artifacts[0].documentSha256).toBe(
          createHash("sha256").update(payload).digest("hex"),
        );
      } else {
        expect(ref).toMatchObject({
          uploadGeneration: 3,
          temporaryPurgePending: true,
          reservedBytes: 1000,
          temporaryStorageKey: `t/${refId}`,
        });
        expect(observed.afterTree).toEqual(beforeTree);
      }
      expect(gate.registry.snapshotUploads()).toEqual([]);
    } catch (error) {
      primary = error;
      throw error;
    } finally {
      try {
        await finishVaultFixture(
          () => monotonic?.mockRestore(),
          () => write?.mockRestore(),
          () => api?.close(),
          () => database.close(),
        );
      } catch (cleanupError) {
        if (primary !== undefined)
          throw new AggregateError(
            [primary, cleanupError],
            "Claim anchor regression and cleanup failed",
          );
        throw cleanupError;
      }
    }
  });
});
