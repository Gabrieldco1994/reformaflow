import { Inject, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import {
  IMPORT_SESSION_LIMITS,
  IMPORT_SESSION_PRIMITIVES,
  PDF_OCR_LEGACY_PARSER_VERSION,
  PDF_OCR_PARSER_VERSION,
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
  EMPTY_DRAFT_JSON,
} from "../import-session.projection";
import { runImportSessionWrite } from "../import-session.writer";
import { IMPORT_VAULT_GATE, type ImportVaultGate } from "./vault-state";
import { VaultIoError } from "./vault-storage";
import {
  releasedAttachmentData,
  invalidateTerminalParserLeases,
  purgeCompletedSessionObservationEvidence,
  pendingTerminalObservationCleanupWhere,
  purgeUnreferencedObservationEvidence,
} from "./completed-retention";
import type { VaultPurgeTarget, VaultPurgeResult } from "./vault-purger";
import {
  ImportRawExecutions,
  type ImportRawClaim,
} from "../import-session.raw-executions";
import { PDF_OCR_RETENTION_MS } from "../ocr/pdf-ocr-state";
import { enforcePdfOcrRetention } from "../ocr/pdf-ocr-retention";
import { PDF_OCR_USAGE_OUTCOME } from "../ocr/pdf-ocr-budget";
import { parseStoredDraft } from "../import-session.projection";
import { validateStoredDraft } from "../import-session.validation";
import { parseStoredImportObservationEvidence } from "../import-session.observation";
import { canonical } from "../../../common/canonical";

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

  private async purgeAgedOcrContent(
    runtime: Runtime,
    scope: Readonly<{ tenantId: string; ownerProjectId: string }>,
    limit: number,
  ): Promise<void> {
    const usage = await this.read(runtime, (tx, now) =>
      tx.importOcrUsage.findMany({
        where: {
          tenantId: scope.tenantId,
          ownerProjectId: scope.ownerProjectId,
          outcome: PDF_OCR_USAGE_OUTCOME.SUCCEEDED,
          contentPurgedAt: null,
          OR: [
            {
              createdAt: {
                lte: new Date(now.getTime() - PDF_OCR_RETENTION_MS),
              },
            },
            { region: null },
            { modelVersion: null },
            { authTrace: null },
            { responseId: null },
            { inputTokens: null },
            { outputTokens: null },
            { totalTokens: null },
          ],
        },
        orderBy: { createdAt: "asc" },
        take: limit,
        select: { id: true, sessionId: true },
      }),
    );
    const candidates = [...new Set(usage.map((item) => item.sessionId))].map(
      (id) => ({
        id,
        usageIds: usage
          .filter((item) => item.sessionId === id)
          .map((item) => item.id),
      }),
    );
    for (const candidate of candidates) {
      await runImportSessionWrite(
        this.prisma,
        this.clock,
        scope,
        async (tx, now) => {
          this.current(runtime);
          const row = await tx.importSession.findFirst({
            where: {
              ...scope,
              id: candidate.id,
            },
          });
          if (!row) return { value: undefined, invalidatedClaims: [] };
          const retainedSession = await enforcePdfOcrRetention(tx, row, now);
          if (retainedSession !== row)
            return { value: undefined, invalidatedClaims: [] };
          const due = await tx.importOcrUsage.findMany({
            where: {
              id: { in: candidate.usageIds },
              ...scope,
              sessionId: row.id,
              outcome: PDF_OCR_USAGE_OUTCOME.SUCCEEDED,
              contentPurgedAt: null,
              createdAt: {
                lte: new Date(now.getTime() - PDF_OCR_RETENTION_MS),
              },
            },
          });
          if (due.length === 0)
            return { value: undefined, invalidatedClaims: [] };
          if (!CANCELLABLE_STATE_LIST.includes(row.state)) {
            await purgeCompletedSessionObservationEvidence(tx, {
              ...scope,
              sessionId: row.id,
            });
            await tx.importArtifact.updateMany({
              where: {
                id: { in: due.map((item) => item.artifactId) },
                ...scope,
                parserVersion: {
                  in: [PDF_OCR_LEGACY_PARSER_VERSION, PDF_OCR_PARSER_VERSION],
                },
              },
              data: {
                state: ImportSessionArtifactState.RAW_READY,
                parserVersion: null,
                extractionJson: null,
              },
            });
            const reconciled = await tx.importOcrUsage.updateMany({
              where: {
                ...scope,
                sessionId: row.id,
                id: { in: due.map((item) => item.id) },
                outcome: PDF_OCR_USAGE_OUTCOME.SUCCEEDED,
                contentPurgedAt: null,
              },
              data: {
                contentPurgedAt: now,
                updatedAt: now,
              },
            });
            if (reconciled.count !== due.length)
              throw new VaultIoError({
                kind: "INVALID_CAPTURE",
                step: "capture",
              });
            return { value: undefined, invalidatedClaims: [] };
          }
          const observations = await tx.importObservation.findMany({
            where: {
              tenantId: row.tenantId,
              ownerProjectId: row.ownerProjectId,
              artifactId: { in: due.map((attempt) => attempt.artifactId) },
            },
          });
          const purgeIds = observations.flatMap((observation) => {
            const evidence = parseStoredImportObservationEvidence(
              observation.evidenceJson,
            );
            return due.some(
              (attempt) =>
                evidence.ocr?.attachmentId === attempt.attachmentId &&
                evidence.ocr.artifactSha256 === attempt.artifactSha256,
            )
              ? [observation.id]
              : [];
          });
          const purgeSet = new Set(purgeIds);
          const draft = parseStoredDraft(row.draftJson);
          const removedLineIds = new Set(
            draft.lines.flatMap((line) =>
              line.observationIds.some((id) => purgeSet.has(id))
                ? [line.id]
                : [],
            ),
          );
          const retainedLines = draft.lines.filter(
            (line) => !removedLineIds.has(line.id),
          );
          const retained = validateStoredDraft({
            ...draft,
            lines: retainedLines,
            selectedLineIds: draft.selectedLineIds.filter(
              (id) => !removedLineIds.has(id),
            ),
            questions: draft.questions.flatMap((question) => {
              const lineIds = question.lineIds.filter(
                (id) => !removedLineIds.has(id),
              );
              return lineIds.length === 0 ? [] : [{ ...question, lineIds }];
            }),
            scope: {
              ...draft.scope,
              observationIds: draft.scope.observationIds.filter(
                (id) => !purgeSet.has(id),
              ),
            },
            ...(draft.declarations
              ? {
                  declarations: {
                    ...draft.declarations,
                    items: draft.declarations.items.filter(
                      (item) => !removedLineIds.has(item.lineId),
                    ),
                  },
                }
              : {}),
          });
          const changed = await tx.importSession.updateMany({
            where: {
              ...scope,
              id: row.id,
              revision: row.revision,
              ocrJson: row.ocrJson,
              state: row.state,
            },
            data: {
              draftJson: canonical(retained),
              state: ImportSessionState.REVIEW_REQUIRED,
              revision: { increment: 1 },
              searchJson: null,
              proposalJson: null,
              proposalHash: null,
              preflightHash: null,
              challengeJson: null,
              prepareLeaseJson: null,
              prepareGeneration: { increment: 1 },
            },
          });
          if (changed.count !== 1)
            throw new VaultIoError({
              kind: "INVALID_CAPTURE",
              step: "capture",
            });
          if (purgeIds.length > 0) {
            const deleted = await tx.importObservation.deleteMany({
              where: {
                id: { in: purgeIds },
                tenantId: row.tenantId,
                ownerProjectId: row.ownerProjectId,
                canonicalExpenseId: null,
                canonicalReceiptId: null,
                claimSessionId: null,
              },
            });
            if (deleted.count !== purgeIds.length)
              throw new VaultIoError({
                kind: "INVALID_CAPTURE",
                step: "capture",
              });
          }
          await tx.importArtifact.updateMany({
            where: {
              id: { in: due.map((attempt) => attempt.artifactId) },
              tenantId: row.tenantId,
              ownerProjectId: row.ownerProjectId,
              parserVersion: {
                in: [PDF_OCR_LEGACY_PARSER_VERSION, PDF_OCR_PARSER_VERSION],
              },
            },
            data: {
              state: ImportSessionArtifactState.RAW_READY,
              parserVersion: null,
              extractionJson: null,
            },
          });
          const reconciled = await tx.importOcrUsage.updateMany({
            where: {
              tenantId: row.tenantId,
              ownerProjectId: row.ownerProjectId,
              sessionId: row.id,
              attachmentId: {
                in: due.map((attempt) => attempt.attachmentId),
              },
              id: { in: due.map((item) => item.id) },
              outcome: PDF_OCR_USAGE_OUTCOME.SUCCEEDED,
              contentPurgedAt: null,
            },
            data: {
              contentPurgedAt: now,
              updatedAt: now,
            },
          });
          if (reconciled.count !== due.length)
            throw new VaultIoError({
              kind: "INVALID_CAPTURE",
              step: "capture",
            });
          return { value: undefined, invalidatedClaims: [] };
        },
        () => this.current(runtime),
      );
    }
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
    await this.purgeAgedOcrContent(runtime, scope, limit);
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
              draftJson: EMPTY_DRAFT_JSON,
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
            const invalidated = await invalidateTerminalParserLeases(
              tx,
              { ...scope, sessionId: row.id },
              {
                limit,
                assertLive: () => this.current(runtime),
                conflictError: () =>
                  new VaultIoError({
                    kind: "INVALID_CAPTURE",
                    step: "capture",
                  }),
              },
            );
            invalidatedClaims.push(...invalidated);
            if (invalidated.length < limit) break;
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
            data: releasedAttachmentData(now),
          });
          await purgeCompletedSessionObservationEvidence(tx, {
            ...scope,
            sessionId: row.id,
          });
          this.current(runtime);
          return { value: "CLEANED" as const, invalidatedClaims };
        },
        () => this.current(runtime),
      );
      this.raw.abortOwned(outcome.invalidatedClaims, "EXPIRE");
      sessions.push({ id: candidate.id, outcome: outcome.value });
    }
    // Bounded repair for previously closed sessions, including artifacts whose
    // original/extraction is already gone. Recheck eligibility under the writer
    // lock: a newly attached continuation/reimport must keep its live evidence.
    const terminalWhere = pendingTerminalObservationCleanupWhere(scope);
    const terminalArtifacts = await this.read(runtime, (tx) =>
      tx.importArtifact.findMany({
        where: terminalWhere,
        select: { id: true },
        orderBy: { id: "asc" },
        take: limit,
      }),
    );
    if (terminalArtifacts.length > 0) {
      await this.probe(runtime);
      await runImportSessionWrite(
        this.prisma,
        this.clock,
        scope,
        async (tx) => {
          this.current(runtime);
          await purgeUnreferencedObservationEvidence(tx, scope, {
            AND: [
              terminalWhere,
              { id: { in: terminalArtifacts.map(({ id }) => id) } },
            ],
          });
        },
        () => this.current(runtime),
      );
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
