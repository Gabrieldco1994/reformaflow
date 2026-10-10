require("../../../../../../scripts/test-db-env.cjs");

import {
  Prisma,
  PrismaClient,
  type ImportSessionArtifact,
} from "@prisma/client";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PrismaService } from "../../../prisma/prisma.service";
import {
  cleanupImportWorld,
  FIXED_NOW,
  seedImportWorld,
  seedSession,
} from "../../../test-utils/import-session-harness";
import {
  bootVaultApp,
  CANONICAL_VAULT,
  connectVaultTestDatabase,
  createVaultTestDatabase,
  finishVaultFixture,
  getVaultGate,
  pdfBytes,
  putContent,
  readStoredBlob,
  seedRef,
  treeOf,
  vaultTestDatabaseIsSafe,
  wire,
  type RecoveryApp,
} from "../../../test-utils/import-session-vault-harness";
import { observeIo } from "../../../test-utils/vault-foundation-harness";

describe("captured upload claim after ref transfer", () => {
  it.each([
    ["unchanged authority", 409, "LEASE_CONFLICT"],
    ["revoked ACL", 404, "NOT_FOUND"],
    ["revoked session version", 401, "UNAUTHENTICATED"],
  ] as const)(
    "post-enter recheck preserves %s and never touches the successor",
    async (mode, status, code) => {
      const setup = new PrismaClient();
      const prefix = "imp-own-claim-transfer";
      let api: RecoveryApp | undefined;
      let io: ReturnType<typeof observeIo> | undefined;
      let spy: jest.SpyInstance | undefined;
      try {
        await connectVaultTestDatabase(setup);
        const world = await seedImportWorld(setup, prefix);
        api = await bootVaultApp(setup, {
          writes: true,
          vault: CANONICAL_VAULT,
        });
        const owner = world.users.restricted;
        const token = await api.tokenFor(owner);
        const session = await seedSession(setup, world, {
          ownerUserId: owner.id,
        });
        const successor = await seedSession(setup, world, {
          ownerUserId: owner.id,
        });
        const refId = await seedRef(setup, session, owner, {
          declaredBytes: 1000,
        });
        const gate = getVaultGate(api);
        io = observeIo(gate.boot.runtime()!.config.rootDir);
        const native = gate.storage.writeClaim.bind(gate.storage);
        let winner: ImportSessionArtifact | undefined;
        let callbacks = 0;
        spy = jest
          .spyOn(gate.storage, "writeClaim")
          .mockImplementation((claim, source, recheck) =>
            native(claim, source, async (captured) => {
              callbacks++;
              expect(gate.registry.snapshotUploads()).toHaveLength(1);
              expect(captured).toMatchObject({
                sessionId: session.id,
                refId,
                uploadGeneration: 2,
              });
              winner = await setup.importSessionArtifact.update({
                where: { id: refId },
                data: {
                  sessionId: successor.id,
                  uploadGeneration: { increment: 1 },
                },
              });
              if (mode === "revoked ACL")
                await setup.user.update({
                  where: { id: owner.id },
                  data: {
                    allowedProjects: JSON.stringify([world.projects.casa]),
                  },
                });
              if (mode === "revoked session version")
                await setup.user.update({
                  where: { id: owner.id },
                  data: { sessionVersion: { increment: 1 } },
                });
              await recheck(captured);
            }),
          );
        const reply = await putContent(api, session.id, refId, { token });
        expect(callbacks).toBe(1);
        expect([reply.status, reply.json]).toEqual([status, wire(code)]);
        expect(
          await setup.importSessionArtifact.findUniqueOrThrow({
            where: { id: refId },
          }),
        ).toEqual(winner);
        expect(gate.registry.snapshotUploads()).toEqual([]);
        expect(
          io.events.filter(
            (event) => event.op === "open" && event.path.endsWith("/blob"),
          ),
        ).toEqual([]);
        expect(
          await setup.importArtifact.count({
            where: { tenantId: world.tenantId },
          }),
        ).toBe(0);
      } finally {
        spy?.mockRestore();
        io?.restore();
        try {
          await io?.closeRemaining();
        } finally {
          try {
            await api?.close();
          } finally {
            try {
              if (vaultTestDatabaseIsSafe(setup))
                await cleanupImportWorld(setup, prefix);
            } finally {
              await setup.$disconnect();
            }
          }
        }
      }
    },
  );
});

describe("committed claim deadline across entry delay and writer retry", () => {
  it.each([
    ["post-commit entry delay", false, 409, 0],
    ["retry keeps only the committed winner", true, 200, 120000],
  ] as const)("%s", async (label, retry, expectedStatus, expectedAnchor) => {
    const database = await createVaultTestDatabase();
    let api: RecoveryApp | undefined;
    let monotonic: jest.SpyInstance | undefined;
    let write: jest.SpyInstance | undefined;
    let primary: unknown;
    try {
      const world = await seedImportWorld(database.setup, "claim-clock-race");
      const active = await bootVaultApp(database.setup, {
        writes: true,
        vault: CANONICAL_VAULT,
      });
      api = active;
      const owner = world.users.restricted;
      const session = await seedSession(database.setup, world, {
        ownerUserId: owner.id,
      });
      const refId = await seedRef(database.setup, session, owner, {
        declaredBytes: 1000,
      });
      const payload = pdfBytes(1000, "claim-clock-race");
      const token = await active.tokenFor(owner);
      const gate = getVaultGate(active);
      const root = gate.boot.runtime()!.config.rootDir;
      const beforeTree = await treeOf(root);
      let now = 0;
      const cas: Array<{
        before: number;
        after: number;
        count: number;
      }> = [];
      const committed: ImportSessionArtifact[] = [];
      monotonic = jest.spyOn(performance, "now").mockImplementation(() => now);
      active.app
        .get<PrismaService>(PrismaService)
        .$use(async (params, next) => {
          if (
            params.model === "ImportSessionArtifact" &&
            params.action === "updateMany" &&
            params.args.where?.id === refId &&
            params.args.data?.uploadGeneration === 2
          ) {
            const before = performance.now();
            const changed = await next(params);
            now = retry ? (cas.length === 0 ? 120000 : 120001) : 0;
            active.clock.current = new Date(FIXED_NOW.getTime() - 1000);
            cas.push({
              before,
              after: performance.now(),
              count: changed.count,
            });
            if (retry && cas.length === 1)
              throw new Prisma.PrismaClientKnownRequestError("claim retry", {
                code: "P2034",
                clientVersion: Prisma.prismaVersion.client,
              });
            return changed;
          }
          return next(params);
        });
      const native = gate.storage.writeClaim.bind(gate.storage);
      write = jest
        .spyOn(gate.storage, "writeClaim")
        .mockImplementation(async (claim, source, recheck) => {
          committed.push(
            await database.setup.importSessionArtifact.findUniqueOrThrow({
              where: { id: refId },
            }),
          );
          if (!retry) now = 120000;
          return native(claim, source, recheck);
        });
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
      const afterTree = await treeOf(root);
      await writeFile(
        join(database.directory, "claim-clock-race-evidence.json"),
        JSON.stringify({
          label,
          pid: process.pid,
          cas,
          committed,
          captured,
          status: reply.status,
          response: reply.json,
          ref,
          artifactCount: artifacts.length,
          storedBytes: stored.length,
          beforeTree,
          afterTree,
        }),
        { flag: "wx", mode: 0o600 },
      );
      expect(cas).toEqual(
        retry
          ? [
              { before: 0, after: 120000, count: 1 },
              { before: 120000, after: 120001, count: 1 },
            ]
          : [{ before: 0, after: 0, count: 1 }],
      );
      expect(committed).toHaveLength(1);
      expect(committed[0]).toMatchObject({
        id: refId,
        sessionId: session.id,
        state: "RESERVED",
        uploadGeneration: 2,
      });
      expect(write).toHaveBeenCalledTimes(1);
      expect(Object.isFrozen(write.mock.calls[0][0])).toBe(true);
      const wallAnchor = FIXED_NOW.getTime() - (retry ? 1000 : 0);
      expect({
        status: reply.status,
        captured,
        state: ref.state,
        artifactCount: artifacts.length,
        storedBytes: stored.length,
      }).toEqual({
        status: expectedStatus,
        captured: [
          {
            claimedAtMs: wallAnchor,
            claimedAtMonotonicMs: expectedAnchor,
            uploadLeaseExpiresAtMs: wallAnchor + 120000,
          },
        ],
        state: retry ? "ATTACHED" : "FAILED",
        artifactCount: retry ? 1 : 0,
        storedBytes: retry ? 1000 : 0,
      });
      if (retry) {
        expect(stored).toEqual(payload);
        expect(artifacts[0].documentSha256).toBe(
          createHash("sha256").update(payload).digest("hex"),
        );
      } else {
        expect(reply.json).toEqual(wire("LEASE_CONFLICT"));
        expect(ref).toMatchObject({
          uploadGeneration: 3,
          temporaryPurgePending: true,
          reservedBytes: 1000,
          temporaryStorageKey: `t/${refId}`,
        });
        expect(afterTree).toEqual(beforeTree);
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
            "Claim clock race and cleanup failed",
          );
        throw cleanupError;
      }
    }
  });
});
