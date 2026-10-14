import type { ImportOcrUsage, ImportSession, Prisma } from "@prisma/client";
import {
  IMPORT_SESSION_LIMITS,
  IMPORT_SESSION_PRIMITIVES,
  PDF_OCR_PARSER_VERSION,
  PDF_OCR_RETENTION_DAYS,
  ImportSessionAmountMeaning,
  ImportSessionArtifactState,
  ImportSessionErrorCode,
  ImportSessionState,
  type ImportSessionStoredDraftV1,
} from "@reformaflow/domain";
import { canonical } from "../../../common/canonical";
import { ImportSessionError } from "../import-session.errors";
import { validateStoredDraft } from "../import-session.validation";
import { PDF_OCR_USAGE_OUTCOME } from "./pdf-ocr-budget";

export const PDF_OCR_RETENTION_MS =
  PDF_OCR_RETENTION_DAYS * 24 * 60 * 60 * 1000;

const ACTIVE_STATES: readonly string[] = [
  ImportSessionState.DRAFT,
  ImportSessionState.ANALYZING,
  ImportSessionState.NEEDS_INPUT,
  ImportSessionState.READY,
  ImportSessionState.CONFIRMED,
  ImportSessionState.REVIEW_REQUIRED,
];
const HASH = new RegExp(IMPORT_SESSION_PRIMITIVES.hashPattern);

type OcrBinding = Readonly<{
  usageId: string | null;
  attachmentId: string;
  artifactSha256: string;
}>;

const unavailable = (): ImportSessionError =>
  new ImportSessionError(ImportSessionErrorCode.OCR_UNAVAILABLE);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function completeSuccessfulUsage(usage: ImportOcrUsage): boolean {
  return (
    typeof usage.region === "string" &&
    typeof usage.modelVersion === "string" &&
    typeof usage.authTrace === "string" &&
    typeof usage.responseId === "string" &&
    Number.isSafeInteger(usage.inputTokens) &&
    Number.isSafeInteger(usage.outputTokens) &&
    Number.isSafeInteger(usage.totalTokens)
  );
}

function retentionBinding(raw: string): OcrBinding | null {
  if (
    typeof raw !== "string" ||
    Buffer.byteLength(raw, "utf8") >
      IMPORT_SESSION_LIMITS.jsonBytesPerDraftOrProposal
  )
    return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!record(value) || !record(value.ocr)) return null;
  const ocr = value.ocr;
  if (
    typeof ocr.attachmentId !== "string" ||
    typeof ocr.artifactSha256 !== "string" ||
    !HASH.test(ocr.artifactSha256)
  )
    return null;
  return {
    usageId: typeof ocr.usageId === "string" ? ocr.usageId : null,
    attachmentId: ocr.attachmentId,
    artifactSha256: ocr.artifactSha256,
  };
}

function hasOcrMarker(raw: string): boolean {
  if (
    typeof raw !== "string" ||
    Buffer.byteLength(raw, "utf8") >
      IMPORT_SESSION_LIMITS.jsonBytesPerDraftOrProposal
  )
    return false;
  try {
    const value: unknown = JSON.parse(raw);
    return record(value) && Object.prototype.hasOwnProperty.call(value, "ocr");
  } catch {
    return false;
  }
}

function matchesUsage(binding: OcrBinding, usage: ImportOcrUsage): boolean {
  return binding.usageId !== null
    ? binding.usageId === usage.id &&
        binding.attachmentId === usage.attachmentId &&
        binding.artifactSha256 === usage.artifactSha256
    : binding.attachmentId === usage.attachmentId &&
        binding.artifactSha256 === usage.artifactSha256;
}

function scrubbedEvidence(reference: string): string {
  return canonical({
    version: 1,
    reference,
    text: "",
    amountMeaning: ImportSessionAmountMeaning.UNKNOWN,
    amountCents: null,
    installmentCount: null,
    installmentIndex: null,
    dataCompra: null,
    identity: {
      merchant: null,
      externalId: null,
      fitId: null,
      ordinal: null,
      fileContentHash: null,
    },
  });
}

function retainedDraft(
  row: ImportSession,
  contaminatedObservationIds: ReadonlySet<string>,
): ImportSessionStoredDraftV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(row.draftJson);
  } catch {
    throw unavailable();
  }
  const draft = validateStoredDraft(raw);
  const removedLineIds = new Set(
    draft.lines.flatMap((line) =>
      line.observationIds.some((id) => contaminatedObservationIds.has(id))
        ? [line.id]
        : [],
    ),
  );
  const removedObservationIds = new Set(contaminatedObservationIds);
  for (const line of draft.lines) {
    if (!removedLineIds.has(line.id)) continue;
    for (const observationId of line.observationIds)
      removedObservationIds.add(observationId);
  }
  return validateStoredDraft({
    ...draft,
    lines: draft.lines.filter((line) => !removedLineIds.has(line.id)),
    selectedLineIds: draft.selectedLineIds.filter(
      (lineId) => !removedLineIds.has(lineId),
    ),
    questions: draft.questions.flatMap((question) => {
      const lineIds = question.lineIds.filter(
        (lineId) => !removedLineIds.has(lineId),
      );
      return lineIds.length === 0 ? [] : [{ ...question, lineIds }];
    }),
    scope: {
      ...draft.scope,
      observationIds: draft.scope.observationIds.filter(
        (id) => !removedObservationIds.has(id),
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
}

/**
 * Enforces the provider-content deadline from the immutable usage timestamp.
 * Callers invoke this inside their existing writer transaction before reading
 * or mutating draft state.
 */
export async function enforcePdfOcrRetention(
  tx: Prisma.TransactionClient,
  row: ImportSession,
  now: Date,
): Promise<ImportSession> {
  try {
    const cutoff = new Date(now.getTime() - PDF_OCR_RETENTION_MS);
    const successful = await tx.importOcrUsage.findMany({
      where: {
        tenantId: row.tenantId,
        ownerProjectId: row.ownerProjectId,
        sessionId: row.id,
        outcome: PDF_OCR_USAGE_OUTCOME.SUCCEEDED,
        contentPurgedAt: null,
      },
    });
    const due = successful.filter(
      (usage) =>
        usage.createdAt.getTime() <= cutoff.getTime() ||
        !completeSuccessfulUsage(usage),
    );
    if (due.length === 0) return row;

    const observations = await tx.importObservation.findMany({
      where: {
        tenantId: row.tenantId,
        ownerProjectId: row.ownerProjectId,
        artifactId: { in: [...new Set(due.map((usage) => usage.artifactId))] },
      },
    });
    const contaminated = observations.filter((observation) => {
      const binding = retentionBinding(observation.evidenceJson);
      return (
        (binding !== null &&
          due.some((usage) => matchesUsage(binding, usage))) ||
        (hasOcrMarker(observation.evidenceJson) &&
          due.some((usage) => usage.artifactId === observation.artifactId))
      );
    });
    const contaminatedIds = new Set(contaminated.map(({ id }) => id));
    const active = ACTIVE_STATES.includes(row.state);
    const draft = active ? retainedDraft(row, contaminatedIds) : null;

    const unclaimed = contaminated.filter(
      (observation) =>
        observation.canonicalExpenseId === null &&
        observation.canonicalReceiptId === null &&
        observation.claimSessionId === null,
    );
    if (unclaimed.length > 0) {
      const deleted = await tx.importObservation.deleteMany({
        where: {
          id: { in: unclaimed.map(({ id }) => id) },
          tenantId: row.tenantId,
          ownerProjectId: row.ownerProjectId,
          canonicalExpenseId: null,
          canonicalReceiptId: null,
          claimSessionId: null,
        },
      });
      if (deleted.count !== unclaimed.length) throw unavailable();
    }
    for (const observation of contaminated) {
      if (unclaimed.some(({ id }) => id === observation.id)) continue;
      const scrubbed = await tx.importObservation.updateMany({
        where: {
          id: observation.id,
          tenantId: row.tenantId,
          ownerProjectId: row.ownerProjectId,
          evidenceJson: observation.evidenceJson,
        },
        data: { evidenceJson: scrubbedEvidence(observation.reference) },
      });
      if (scrubbed.count !== 1) throw unavailable();
    }

    await tx.importArtifact.updateMany({
      where: {
        id: { in: [...new Set(due.map((usage) => usage.artifactId))] },
        tenantId: row.tenantId,
        ownerProjectId: row.ownerProjectId,
        parserVersion: PDF_OCR_PARSER_VERSION,
      },
      data: {
        state: ImportSessionArtifactState.RAW_READY,
        parserVersion: null,
        extractionJson: null,
        parseGeneration: { increment: 1 },
        leaseSessionId: null,
        leaseSessionVersion: null,
        leaseTokenExpiresAt: null,
        leaseExpiresAt: null,
      },
    });
    const marked = await tx.importOcrUsage.updateMany({
      where: {
        id: { in: due.map(({ id }) => id) },
        tenantId: row.tenantId,
        ownerProjectId: row.ownerProjectId,
        sessionId: row.id,
        outcome: PDF_OCR_USAGE_OUTCOME.SUCCEEDED,
        contentPurgedAt: null,
      },
      data: { contentPurgedAt: now, updatedAt: now },
    });
    if (marked.count !== due.length) throw unavailable();

    if (active) {
      if (row.revision >= IMPORT_SESSION_PRIMITIVES.maxRevision)
        throw unavailable();
      const changed = await tx.importSession.updateMany({
        where: {
          id: row.id,
          tenantId: row.tenantId,
          ownerProjectId: row.ownerProjectId,
          revision: row.revision,
          state: row.state,
        },
        data: {
          draftJson: canonical(draft),
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
      if (changed.count !== 1) {
        const applied = await tx.importSession.count({
          where: {
            id: row.id,
            tenantId: row.tenantId,
            ownerProjectId: row.ownerProjectId,
            revision: row.revision + 1,
            state: ImportSessionState.REVIEW_REQUIRED,
          },
        });
        if (applied !== 1) throw unavailable();
      }
    }
    const current = await tx.importSession.findFirst({
      where: {
        id: row.id,
        tenantId: row.tenantId,
        ownerProjectId: row.ownerProjectId,
      },
    });
    if (!current) throw unavailable();
    return current;
  } catch (error) {
    if (
      error instanceof ImportSessionError &&
      error.code === ImportSessionErrorCode.OCR_UNAVAILABLE
    )
      throw error;
    throw unavailable();
  }
}
