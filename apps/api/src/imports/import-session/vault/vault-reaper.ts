import { Inject, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  IMPORT_SESSION_LIMITS,
  IMPORT_SESSION_PRIMITIVES,
  ImportSessionState,
  ImportSessionAttachmentState,
  ImportSessionArtifactState,
} from "@reformaflow/domain";
import { PrismaService } from "../../../prisma/prisma.service";
import {
  IMPORT_SESSION_CLOCK,
  type ImportSessionClock,
} from "../import-session.capability";
import {
  CANCELLABLE_STATE_LIST,
  terminalDraftJson,
} from "../import-session.projection";
import { runImportSessionWrite } from "../import-session.writer";
import { IMPORT_VAULT_GATE, type ImportVaultGate } from "./vault-state";
import { VaultIoError } from "./vault-storage";
import type { VaultPurgeTarget, VaultPurgeResult } from "./vault-purger";
import {
  ImportRawExecutions,
  type ImportRawClaim,
} from "../import-session.raw-executions";

export type VaultReaperCycleInput = Readonly<{
  tenantId: string;
  ownerProjectId: string;
  limit: number;
}>;
export type VaultReaperCycleResult = Readonly<{
  sessions: readonly Readonly<{
    id: string;
    outcome: "CLEANED" | "NOT_ELIGIBLE";
  }>[];
  purges: readonly Readonly<{
    target: VaultPurgeTarget;
    outcome: VaultPurgeResult;
  }>[];
}>;
type Runtime = NonNullable<ReturnType<ImportVaultGate["boot"]["runtime"]>>;
const ID = new RegExp(IMPORT_SESSION_PRIMITIVES.idPattern);

@Injectable()
export class VaultReaper {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(IMPORT_SESSION_CLOCK) private readonly clock: ImportSessionClock,
    @Inject(IMPORT_VAULT_GATE) private readonly gate: ImportVaultGate,
    private readonly raw: ImportRawExecutions,
  ) {}
  private current(runtime: Runtime | null): undefined {
    if (
      !runtime ||
      this.gate.boot.stopped.aborted ||
      this.gate.boot.runtime() !== runtime
    )
      throw new VaultIoError({ kind: "UNAVAILABLE", step: "runtime" });
    return undefined;
  }
  private async probe(runtime: Runtime): Promise<void> {
    this.current(runtime);
    const proof = await this.gate.boot.recheckLock();
    this.current(runtime);
    if (!proof.ok || proof.runtime !== runtime)
      throw new VaultIoError({ kind: "UNAVAILABLE", step: "runtime" });
  }
  private read<T>(
    runtime: Runtime,
    work: (tx: Prisma.TransactionClient, now: Date) => Promise<T>,
  ): Promise<T> {
    this.current(runtime);
    return this.prisma.$transaction(
      async (tx) => {
        this.current(runtime);
        const value = await work(tx, this.clock.now());
        this.current(runtime);
        return value;
      },
      {
        maxWait: IMPORT_SESSION_LIMITS.transactionMaxWaitMs,
        timeout: IMPORT_SESSION_LIMITS.transactionTimeoutMs,
      },
    );
  }

  async runCycle(
    input: VaultReaperCycleInput,
  ): Promise<VaultReaperCycleResult> {
    if (
      !input ||
      typeof input.tenantId !== "string" ||
      !ID.test(input.tenantId) ||
      typeof input.ownerProjectId !== "string" ||
      !ID.test(input.ownerProjectId) ||
      !Number.isSafeInteger(input.limit) ||
      input.limit <= 0
    )
      throw new VaultIoError({ kind: "INVALID_CAPTURE", step: "capture" });
    const { tenantId, ownerProjectId, limit } = input;
    const scope = { tenantId, ownerProjectId };
    const runtime = this.gate.boot.runtime();
    this.current(runtime);
    if (!runtime)
      throw new VaultIoError({ kind: "UNAVAILABLE", step: "runtime" });
    const sessions: { id: string; outcome: "CLEANED" | "NOT_ELIGIBLE" }[] = [];
    const purges: { target: VaultPurgeTarget; outcome: VaultPurgeResult }[] =
      [];
    const eligible = await this.read(runtime, (tx, now) =>
      tx.importSession.findMany({
        where: {
          ...scope,
          state: { in: CANCELLABLE_STATE_LIST },
          expiresAt: { lte: now },
        },
        take: limit,
        orderBy: { id: "asc" },
        select: { id: true },
      }),
    );
    for (const candidate of eligible) {
      await this.probe(runtime);
      const outcome = await runImportSessionWrite(
        this.prisma,
        this.clock,
        scope,
        async (tx, now) => {
          this.current(runtime);
          const row = await tx.importSession.findFirst({
            where: { ...scope, id: candidate.id },
          });
          if (
            !row ||
            !CANCELLABLE_STATE_LIST.includes(row.state) ||
            row.expiresAt.getTime() > now.getTime()
          )
            return { value: "NOT_ELIGIBLE" as const, invalidatedClaims: [] };
          this.current(runtime);
          const changed = await tx.importSession.updateMany({
            where: {
              ...scope,
              id: row.id,
              state: row.state,
              revision: row.revision,
              expiresAt: { lte: now },
            },
            data: {
              state: ImportSessionState.EXPIRED,
              revision: Math.min(
                row.revision + 1,
                IMPORT_SESSION_PRIMITIVES.maxRevision,
              ),
              closedAt: now,
              draftJson: terminalDraftJson(row.draftJson),
              searchJson: null,
              proposalJson: null,
              proposalHash:
                row.financialRequestId === null ? null : row.proposalHash,
              preflightHash: null,
              challengeJson: null,
              prepareLeaseJson: null,
              prepareGeneration: { increment: 1 },
            },
          });
          if (changed.count !== 1)
            return { value: "NOT_ELIGIBLE" as const, invalidatedClaims: [] };
          this.current(runtime);
          const invalidatedClaims: ImportRawClaim[] = [];
          for (;;) {
            this.current(runtime);
            const leases = await tx.importArtifact.findMany({
              where: { ...scope, leaseSessionId: row.id },
              select: { id: true, parseGeneration: true, state: true },
              orderBy: { id: "asc" },
              take: limit,
            });
            for (const lease of leases) {
              this.current(runtime);
              const claim = {
                ...scope,
                sessionId: row.id,
                artifactId: lease.id,
                parseGeneration: lease.parseGeneration,
              };
              const invalidated = await tx.importArtifact.updateMany({
                where: {
                  ...scope,
                  id: lease.id,
                  leaseSessionId: row.id,
                  parseGeneration: lease.parseGeneration,
                },
                data: {
                  leaseSessionId: null,
                  leaseSessionVersion: null,
                  leaseTokenExpiresAt: null,
                  leaseExpiresAt: null,
                  parseGeneration: { increment: 1 },
                  ...(lease.state === ImportSessionArtifactState.ANALYZING
                    ? { state: ImportSessionArtifactState.RAW_READY }
                    : {}),
                },
              });
              if (invalidated.count !== 1)
                throw new VaultIoError({
                  kind: "INVALID_CAPTURE",
                  step: "capture",
                });
              invalidatedClaims.push(claim);
            }
            if (leases.length < limit) break;
          }
          this.current(runtime);
          const live = {
            ...scope,
            sessionId: row.id,
            state: { not: ImportSessionAttachmentState.RELEASED },
          };
          await tx.importSessionArtifact.updateMany({
            where: { ...live, temporaryStorageKey: { not: null } },
            data: { temporaryPurgePending: true },
          });
          this.current(runtime);
          await tx.importSessionArtifact.updateMany({
            where: live,
            data: {
              state: ImportSessionAttachmentState.RELEASED,
              releasedAt: now,
              uploadGeneration: { increment: 1 },
              uploadSessionVersion: null,
              uploadLeaseExpiresAt: null,
              uploadTokenExpiresAt: null,
            },
          });
          this.current(runtime);
          return { value: "CLEANED" as const, invalidatedClaims };
        },
        () => this.current(runtime),
      );
      this.raw.abortOwned(outcome.invalidatedClaims, "EXPIRE");
      sessions.push({ id: candidate.id, outcome: outcome.value });
    }
    let remaining = limit - sessions.length;
    if (remaining > 0) {
      const refs = await this.read(runtime, (tx, now) =>
        tx.importSessionArtifact.findMany({
          where: {
            ...scope,
            temporaryStorageKey: { not: null },
            OR: [
              { temporaryPurgePending: true },
              {
                state: ImportSessionAttachmentState.RESERVED,
                uploadLeaseExpiresAt: { lte: now },
              },
            ],
          },
          take: remaining,
          orderBy: { id: "asc" },
          select: { id: true },
        }),
      );
      for (const ref of refs) {
        await this.probe(runtime);
        const target: VaultPurgeTarget = { kind: "ref", ...scope, id: ref.id };
        this.current(runtime);
        purges.push({
          target,
          outcome: await this.gate.requirePurger().purge(target),
        });
      }
      remaining -= refs.length;
    }
    if (remaining > 0) {
      const artifacts = await this.read(runtime, (tx) =>
        tx.importArtifact.findMany({
          where: {
            ...scope,
            storageKey: { not: null },
            state: { not: ImportSessionArtifactState.PURGED },
            references: {
              none: {
                tenantId,
                ownerProjectId,
                state: ImportSessionAttachmentState.ATTACHED,
              },
            },
          },
          take: remaining,
          orderBy: { id: "asc" },
          select: { id: true },
        }),
      );
      for (const artifact of artifacts) {
        await this.probe(runtime);
        const target: VaultPurgeTarget = {
          kind: "artifact",
          ...scope,
          id: artifact.id,
        };
        this.current(runtime);
        purges.push({
          target,
          outcome: await this.gate.requirePurger().purge(target),
        });
      }
    }
    this.current(runtime);
    return { sessions, purges };
  }
}
