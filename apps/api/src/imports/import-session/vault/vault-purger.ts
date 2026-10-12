import type { Prisma } from "@prisma/client";
import {
  IMPORT_SESSION_LIMITS,
  IMPORT_SESSION_PRIMITIVES,
  ImportSessionAttachmentState,
  ImportSessionArtifactState,
  ImportSessionErrorCode,
} from "@reformaflow/domain";
import type { PrismaService } from "../../../prisma/prisma.service";
import type { ImportSessionClock } from "../import-session.capability";
import { isRetryableWriteFailure } from "../import-session.writer";
import { ImportSessionError } from "../import-session.errors";
import type { VaultBootHandle, VaultRuntime } from "./vault-boot";
import { VaultFdRegistry, type VaultKey } from "./vault-fd-registry";
import {
  VaultStorage,
  VaultIoError,
  type CapturedVaultPurge,
} from "./vault-storage";

export type VaultPurgeTarget = Readonly<{
  kind: "ref" | "artifact";
  tenantId: string;
  ownerProjectId: string;
  id: string;
}>;
export type VaultPurgeResult =
  | "PURGED"
  | "NOT_ELIGIBLE"
  | "STALE_CAPTURE"
  | "DRAIN_TIMEOUT";
const ID = new RegExp(IMPORT_SESSION_PRIMITIVES.idPattern);

export class PurgeCoordinator {
  private readonly inFlight = new Map<
    VaultKey,
    { target: VaultPurgeTarget; promise: Promise<VaultPurgeResult> }
  >();
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ImportSessionClock,
    private readonly boot: VaultBootHandle,
    private readonly registry: VaultFdRegistry,
    private readonly storage: VaultStorage,
    private readonly drainTimeoutMs: number,
  ) {}

  purge(input: VaultPurgeTarget): Promise<VaultPurgeResult> {
    const target = Object.freeze({ ...input });
    if (
      !["ref", "artifact"].includes(target.kind) ||
      ![target.tenantId, target.ownerProjectId, target.id].every(
        (id) => typeof id === "string" && ID.test(id),
      )
    )
      return Promise.reject(
        new VaultIoError({ kind: "INVALID_CAPTURE", step: "capture" }),
      );
    const key: VaultKey =
      target.kind === "ref" ? `R:${target.id}` : `A:${target.id}`;
    const running = this.inFlight.get(key);
    if (running) {
      if (
        running.target.tenantId !== target.tenantId ||
        running.target.ownerProjectId !== target.ownerProjectId
      )
        return Promise.reject(
          new VaultIoError({ kind: "INVALID_CAPTURE", step: "capture" }),
        );
      return running.promise;
    }
    const promise = this.run(target, key).finally(() => {
      this.registry.releaseFence(key);
      if (this.inFlight.get(key)?.promise === promise)
        this.inFlight.delete(key);
    });
    this.inFlight.set(key, { target, promise });
    return promise;
  }
  private current(runtime: Readonly<VaultRuntime>): void {
    if (this.boot.runtime() !== runtime)
      throw new VaultIoError({ kind: "UNAVAILABLE", step: "runtime" });
  }
  private async write<T>(
    tenantId: string,
    runtime: Readonly<VaultRuntime>,
    work: (tx: Prisma.TransactionClient, now: Date) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        this.current(runtime);
        return await this.prisma.$transaction(
          async (tx) => {
            await tx.$executeRaw`UPDATE tenants SET id = id WHERE id = ${tenantId}`;
            this.current(runtime);
            return work(tx, this.clock.now());
          },
          {
            maxWait: IMPORT_SESSION_LIMITS.transactionMaxWaitMs,
            timeout: IMPORT_SESSION_LIMITS.transactionTimeoutMs,
          },
        );
      } catch (error) {
        if (!isRetryableWriteFailure(error)) throw error;
        if (attempt >= IMPORT_SESSION_LIMITS.writeAttempts)
          throw new ImportSessionError(
            ImportSessionErrorCode.RETRYABLE_WRITE_CONFLICT,
          );
      }
    }
  }
  private async capture(
    target: VaultPurgeTarget,
    runtime: Readonly<VaultRuntime>,
  ): Promise<CapturedVaultPurge | null> {
    return this.write(target.tenantId, runtime, async (tx, now) => {
      const where = {
        tenantId: target.tenantId,
        ownerProjectId: target.ownerProjectId,
        id: target.id,
      };
      if (target.kind === "ref") {
        const ref = await tx.importSessionArtifact.findFirst({ where });
        if (!ref?.temporaryStorageKey) return null;
        const expired =
          ref.state === ImportSessionAttachmentState.RESERVED &&
          ref.uploadLeaseExpiresAt !== null &&
          ref.uploadLeaseExpiresAt.getTime() <= now.getTime();
        if (!ref.temporaryPurgePending && !expired) return null;
        if (ref.state === ImportSessionAttachmentState.RESERVED) {
          const changed = await tx.importSessionArtifact.updateMany({
            where: {
              ...where,
              state: ImportSessionAttachmentState.RESERVED,
              uploadGeneration: ref.uploadGeneration,
              temporaryStorageKey: ref.temporaryStorageKey,
            },
            data: {
              state: ImportSessionAttachmentState.FAILED,
              uploadGeneration: { increment: 1 },
              uploadLeaseExpiresAt: null,
              uploadTokenExpiresAt: null,
              uploadSessionVersion: null,
              temporaryPurgePending: true,
            },
          });
          if (changed.count !== 1) return null;
        }
        return Object.freeze({
          kind: "ref",
          ...where,
          key: `R:${ref.id}`,
          temporaryStorageKey: ref.temporaryStorageKey,
          sourceKey: ref.temporaryStorageKey,
          trashKey: `trash/r-${ref.id}`,
        } as const);
      }
      const artifact = await tx.importArtifact.findFirst({ where });
      if (
        !artifact?.storageKey ||
        artifact.state === ImportSessionArtifactState.PURGED
      )
        return null;
      if (
        await tx.importSessionArtifact.count({
          where: {
            tenantId: target.tenantId,
            ownerProjectId: target.ownerProjectId,
            artifactId: artifact.id,
            state: ImportSessionAttachmentState.ATTACHED,
          },
        })
      )
        return null;
      if (artifact.state !== ImportSessionArtifactState.PURGING) {
        const changed = await tx.importArtifact.updateMany({
          where: {
            ...where,
            state: artifact.state,
            storageKey: artifact.storageKey,
          },
          data: {
            state: ImportSessionArtifactState.PURGING,
            parseGeneration: { increment: 1 },
            leaseSessionId: null,
            leaseSessionVersion: null,
            leaseTokenExpiresAt: null,
            leaseExpiresAt: null,
          },
        });
        if (changed.count !== 1) return null;
      }
      const parts = artifact.storageKey.split("/");
      return Object.freeze({
        kind: "artifact",
        ...where,
        key: `A:${artifact.id}`,
        storageKey: artifact.storageKey,
        sourceKey: parts.slice(0, -1).join("/"),
        trashKey: `trash/a-${artifact.id}-${parts[1]}-${parts[2]}`,
      } as const);
    });
  }
  private async matches(
    tx: Prisma.TransactionClient,
    capture: CapturedVaultPurge,
  ): Promise<boolean> {
    const where = {
      tenantId: capture.tenantId,
      ownerProjectId: capture.ownerProjectId,
      id: capture.id,
    };
    if (capture.kind === "ref")
      return (
        (await tx.importSessionArtifact.count({
          where: {
            ...where,
            temporaryPurgePending: true,
            temporaryStorageKey: capture.temporaryStorageKey,
          },
        })) === 1
      );
    return (
      (await tx.importArtifact.count({
        where: {
          ...where,
          state: ImportSessionArtifactState.PURGING,
          storageKey: capture.storageKey,
        },
      })) === 1 &&
      (await tx.importSessionArtifact.count({
        where: {
          tenantId: capture.tenantId,
          ownerProjectId: capture.ownerProjectId,
          artifactId: capture.id,
          state: ImportSessionAttachmentState.ATTACHED,
        },
      })) === 0
    );
  }
  private async run(
    target: VaultPurgeTarget,
    key: VaultKey,
  ): Promise<VaultPurgeResult> {
    const runtime = this.boot.runtime();
    if (!runtime)
      throw new VaultIoError({ kind: "UNAVAILABLE", step: "runtime" });
    const capture = await this.capture(target, runtime);
    if (!capture) return "NOT_ELIGIBLE";
    this.current(runtime);
    this.registry.fence(key);
    if (
      (await this.registry.abortAndDrain(key, this.drainTimeoutMs)) ===
      "TIMEOUT"
    )
      return "DRAIN_TIMEOUT";
    if (
      !(await this.write(target.tenantId, runtime, (tx) =>
        this.matches(tx, capture),
      ))
    )
      return "STALE_CAPTURE";
    this.current(runtime);
    await this.storage.eraseCaptured(capture);
    return this.write(target.tenantId, runtime, async (tx) => {
      if (!(await this.matches(tx, capture))) return "STALE_CAPTURE";
      this.current(runtime);
      const where = {
        tenantId: capture.tenantId,
        ownerProjectId: capture.ownerProjectId,
        id: capture.id,
      };
      const changed =
        capture.kind === "ref"
          ? await tx.importSessionArtifact.updateMany({
              where: {
                ...where,
                temporaryPurgePending: true,
                temporaryStorageKey: capture.temporaryStorageKey,
              },
              data: {
                temporaryStorageKey: null,
                reservedBytes: 0,
                temporaryPurgePending: false,
              },
            })
          : await tx.importArtifact.updateMany({
              where: {
                ...where,
                state: ImportSessionArtifactState.PURGING,
                storageKey: capture.storageKey,
              },
              data: {
                state: ImportSessionArtifactState.PURGED,
                storageKey: null,
                extractionJson: null,
              },
            });
      return changed.count === 1 ? "PURGED" : "STALE_CAPTURE";
    });
  }
}
