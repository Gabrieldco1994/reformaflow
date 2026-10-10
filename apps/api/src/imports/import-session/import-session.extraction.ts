import { createHash } from "node:crypto";
import type {
  ImportArtifact,
  ImportObservation,
  ImportSession,
  ImportSessionArtifact,
} from "@prisma/client";
import {
  IMPORT_SESSION_LIMITS as LIMITS,
  IMPORT_SESSION_PRIMITIVES as P,
  ImportSessionErrorCode as Code,
  isInvoiceDueMonth,
  type ExpenseScheduleV1,
  type ImportSessionDraftLineV1,
  type ImportSessionDraftQuestionV1,
  type ImportSessionStoredDraftV1,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import { canonical } from "../../common/canonical";
import {
  CARD_IMPORT_LINE_CLASSIFICATION,
  CARD_IMPORT_LINE_POLICY_VERSION,
  classifyCardImportLine,
} from "../../credit-card/card-import-line-policy";
import { hasUnknownCardOccurrenceFacts } from "../../credit-card/card-purchase-identity";
import { validateDocumentExtraction } from "../../credit-card/parsers/statement-document";
import {
  DocumentExtractionError,
  type DocumentExtractionV1,
} from "../../credit-card/parsers/types";
import type { DocumentaryCycle } from "../../expense/documented-schedule.types";
import {
  ImportSessionCorruptStateError,
  ImportSessionError,
} from "./import-session.errors";
import {
  parseStoredImportObservationEvidence,
  type StoredImportObservationEvidenceV1,
} from "./import-session.observation";
import { validateStoredDraft } from "./import-session.validation";

type Evidence = StoredImportObservationEvidenceV1;
type OccurrenceFacts = Pick<
  Evidence,
  "amountMeaning" | "amountCents" | "installmentCount" | "installmentIndex"
>;

export function hasIncompleteOriginalIdentity(o: Evidence): boolean {
  return (
    o.dataCompra === null ||
    o.amountCents === null ||
    o.identity.merchant === null ||
    o.identity.ordinal === null
  );
}
export function isWholePurchaseObservation(o: OccurrenceFacts): boolean {
  return o.amountMeaning === "TOTAL_PURCHASE" && o.installmentIndex === null;
}
export function hasIncompleteCreateOccurrence(o: OccurrenceFacts): boolean {
  return (
    !isWholePurchaseObservation(o) &&
    (hasUnknownCardOccurrenceFacts(o) ||
      (o.installmentIndex === null &&
        !(
          o.amountMeaning === "INSTALLMENT_CHARGE" && o.installmentCount === 1
        )))
  );
}
export function hasIncompleteKeepOccurrence(o: OccurrenceFacts): boolean {
  return (
    hasUnknownCardOccurrenceFacts(o) ||
    (o.installmentIndex === null &&
      o.installmentCount !== null &&
      o.installmentCount > 1)
  );
}
export function importReviewBlockers(
  lines: readonly ImportSessionDraftLineV1[],
  evidence: ReadonlyMap<string, Evidence>,
): Array<
  Pick<ImportSessionViewV1["reviewBlockers"][number], "lineId" | "code">
> {
  const result: Array<
    Pick<ImportSessionViewV1["reviewBlockers"][number], "lineId" | "code">
  > = [];
  for (const line of lines) {
    const originals = line.observationIds.map((id) => {
      const original = evidence.get(id);
      if (!original) throw new ImportSessionCorruptStateError("evidence_json");
      return original;
    });
    if (originals.some(hasIncompleteOriginalIdentity))
      result.push({ lineId: line.id, code: "ORIGINAL_IDENTITY_INCOMPLETE" });
    const create = originals.some(hasIncompleteCreateOccurrence);
    const keep = originals.some(hasIncompleteKeepOccurrence);
    if (
      line.decision.kind === "CREATE"
        ? create
        : line.decision.kind === "KEEP_EXISTING"
          ? keep
          : create && keep
    )
      result.push({ lineId: line.id, code: "ORIGINAL_OCCURRENCE_INCOMPLETE" });
  }
  return result;
}

export function importFileContentHash(sha: string): string {
  if (!new RegExp(P.hashPattern).test(sha))
    throw new ImportSessionCorruptStateError("document_sha256");
  return createHash("sha256").update(sha).digest("hex").slice(0, 32);
}

export function supportsImportExtraction(
  artifact: Pick<ImportArtifact, "detectedFormat" | "parserVersion">,
): boolean {
  switch (artifact.detectedFormat) {
    case "CSV":
    case "OFX":
      return artifact.parserVersion === "card-local-text-v1";
    case "PDF":
      return artifact.parserVersion === "card-local-pdf-v1";
    case "XLS":
      return artifact.parserVersion === "card-local-xls-v1";
    case "XLSX":
      return artifact.parserVersion === "card-local-xlsx-v1";
    default:
      return false;
  }
}

export function readStoredImportExtraction(
  artifact: ImportArtifact,
): DocumentExtractionV1 {
  if (artifact.extractionJson === null || !supportsImportExtraction(artifact))
    throw new ImportSessionCorruptStateError("extraction_json");
  if (Buffer.byteLength(artifact.extractionJson, "utf8") > LIMITS.bytesPerFile)
    throw new ImportSessionError(Code.LIMIT_EXCEEDED);
  try {
    const value: unknown = JSON.parse(artifact.extractionJson);
    const extraction = validateDocumentExtraction(value);
    if (extraction.parserVersion !== artifact.parserVersion)
      throw new ImportSessionCorruptStateError("parser_version");
    return extraction;
  } catch (error) {
    if (
      error instanceof DocumentExtractionError &&
      error.code === "LIMIT_EXCEEDED"
    )
      throw new ImportSessionError(Code.LIMIT_EXCEEDED);
    if (
      error instanceof SyntaxError ||
      error instanceof DocumentExtractionError
    )
      throw new ImportSessionCorruptStateError("extraction_json");
    throw error;
  }
}

export function readImportObservationCycle(
  artifact: ImportArtifact,
  observation: ImportObservation,
  extraction: DocumentExtractionV1,
): DocumentaryCycle | null {
  return createImportObservationCycleReader(artifact, extraction)(observation);
}

export function createImportObservationCycleReader(
  artifact: ImportArtifact,
  extraction: DocumentExtractionV1,
): (observation: ImportObservation) => DocumentaryCycle | null {
  const occurrences = new Map<
    string,
    DocumentExtractionV1["occurrences"][number]
  >();
  for (const occurrence of extraction.occurrences) {
    const { reference } = occurrence;
    if (occurrences.has(reference))
      throw new ImportSessionCorruptStateError("extraction_reference");
    occurrences.set(reference, occurrence);
  }
  return (observation) => {
    if (
      artifact.id !== observation.artifactId ||
      artifact.tenantId !== observation.tenantId ||
      artifact.ownerProjectId !== observation.ownerProjectId ||
      artifact.parserVersion !== extraction.parserVersion
    )
      throw new ImportSessionCorruptStateError("extraction_reference");
    const occurrence = occurrences.get(observation.reference);
    if (!occurrence)
      throw new ImportSessionCorruptStateError("extraction_reference");
    const cycle = occurrence.cycle;
    if (cycle === null) return null;
    if (!isInvoiceDueMonth(cycle.invoiceDueMonth))
      throw new ImportSessionCorruptStateError("extraction_cycle");
    return {
      invoiceDueMonth: cycle.invoiceDueMonth,
      evidence: {
        documentSha256: artifact.documentSha256,
        reference: cycle.reference,
      },
    };
  };
}

export function checkImportObservationCycle(
  cycle: DocumentaryCycle | null,
  schedule: ExpenseScheduleV1,
  boundIndex: number | null,
):
  | { kind: "NOT_DOCUMENTED" }
  | { kind: "MATCH"; occurrenceIndex: number }
  | {
      kind: "NEEDS_INPUT";
      reason: "UNBOUND" | "MISSING_SCHEDULE_CYCLE" | "MISMATCH";
    } {
  if (cycle === null) return { kind: "NOT_DOCUMENTED" };
  const occurrence =
    boundIndex === null
      ? schedule.occurrences.length === 1
        ? schedule.occurrences[0]
        : undefined
      : schedule.occurrences.find((o) => o.index === boundIndex);
  if (!occurrence) return { kind: "NEEDS_INPUT", reason: "UNBOUND" };
  if (occurrence.invoiceDueMonth === null)
    return { kind: "NEEDS_INPUT", reason: "MISSING_SCHEDULE_CYCLE" };
  return occurrence.invoiceDueMonth === cycle.invoiceDueMonth
    ? { kind: "MATCH", occurrenceIndex: occurrence.index }
    : { kind: "NEEDS_INPUT", reason: "MISMATCH" };
}

export interface ImportMaterializationInput {
  session: Pick<
    ImportSession,
    "id" | "tenantId" | "ownerProjectId" | "revision"
  >;
  attachment: ImportSessionArtifact;
  artifact: ImportArtifact;
  extraction: DocumentExtractionV1;
  draft: ImportSessionStoredDraftV1;
  observations: readonly ImportObservation[];
  newIds: ReadonlyMap<string, { observationId: string; lineId: string }>;
}
export interface ImportMaterializationPlan {
  draft: ImportSessionStoredDraftV1;
  observations: Array<
    Pick<
      ImportObservation,
      | "id"
      | "tenantId"
      | "ownerProjectId"
      | "artifactId"
      | "reference"
      | "evidenceJson"
    >
  >;
}

export function buildImportMaterialization(
  input: ImportMaterializationInput,
): ImportMaterializationPlan {
  const { session, attachment, artifact, extraction, newIds } = input;
  if (
    attachment.sessionId !== session.id ||
    attachment.tenantId !== session.tenantId ||
    attachment.ownerProjectId !== session.ownerProjectId ||
    attachment.artifactId !== artifact.id ||
    artifact.tenantId !== session.tenantId ||
    artifact.ownerProjectId !== session.ownerProjectId ||
    attachment.state !== "ATTACHED" ||
    artifact.state !== "EXTRACTED" ||
    artifact.parserVersion !== extraction.parserVersion
  )
    throw new ImportSessionCorruptStateError("extraction_reference");
  const draft = structuredClone(validateStoredDraft(input.draft));
  if (!draft.scope.pendingAttachmentIds.includes(attachment.id))
    throw new ImportSessionError(Code.STALE_PREVIEW);
  const existing = new Map(input.observations.map((o) => [o.reference, o]));
  if (
    existing.size !== input.observations.length ||
    input.observations.some(
      (o) =>
        o.artifactId !== artifact.id ||
        o.tenantId !== session.tenantId ||
        o.ownerProjectId !== session.ownerProjectId ||
        !extraction.occurrences.some(
          (occurrence) => occurrence.reference === o.reference,
        ),
    )
  )
    throw new ImportSessionError(Code.REVIEW_REQUIRED);
  const plan: ImportMaterializationPlan = { draft, observations: [] };
  for (const occurrence of extraction.occurrences) {
    const previous = existing.get(occurrence.reference);
    if (
      previous &&
      (previous.canonicalExpenseId !== null ||
        previous.canonicalReceiptId !== null)
    )
      continue;
    const ids = newIds.get(occurrence.reference);
    if (!ids) throw new ImportSessionCorruptStateError("extraction_ids");
    const text = [
      occurrence.dateOnly,
      occurrence.merchant,
      occurrence.amountCents === null
        ? null
        : `${occurrence.amountCents} centavos`,
      occurrence.installmentIndex === null
        ? null
        : `${occurrence.installmentIndex}/${occurrence.installmentCount}`,
    ]
      .filter((part) => part !== null)
      .join(" · ");
    const evidence: Evidence = {
      version: 1,
      reference: occurrence.reference,
      text,
      amountMeaning: occurrence.amountMeaning,
      amountCents: occurrence.amountCents,
      installmentCount: occurrence.installmentCount,
      installmentIndex: occurrence.installmentIndex,
      dataCompra: occurrence.dateOnly,
      identity: {
        merchant: occurrence.merchant,
        ordinal: occurrence.identityOrdinal,
        externalId: null,
        fitId: occurrence.fitId,
        fileContentHash: importFileContentHash(artifact.documentSha256),
      },
    };
    const evidenceJson = canonical(evidence);
    parseStoredImportObservationEvidence(evidenceJson);
    if (previous) {
      const old = parseStoredImportObservationEvidence(previous.evidenceJson);
      if (
        canonical({ ...old, text: "" }) !== canonical({ ...evidence, text: "" })
      )
        throw new ImportSessionError(Code.REVIEW_REQUIRED);
    } else {
      plan.observations.push({
        id: ids.observationId,
        tenantId: session.tenantId,
        ownerProjectId: session.ownerProjectId,
        artifactId: artifact.id,
        reference: occurrence.reference,
        evidenceJson,
      });
    }
    const observationId = previous?.id ?? ids.observationId;
    if (!draft.scope.observationIds.includes(observationId))
      draft.scope.observationIds.push(observationId);
    if (draft.lines.some((line) => line.observationIds.includes(observationId)))
      continue;
    const classification = classifyCardImportLine({
      documentaryText: occurrence.raw.description ?? "",
    });
    const line: ImportSessionDraftLineV1 = {
      id: ids.lineId,
      observationIds: [observationId],
      titulo: occurrence.merchant || "Compra do documento",
      fornecedor: occurrence.merchant,
      tipoDespesa: null,
      categoriaMaoDeObra: null,
      amountMeaning: occurrence.amountMeaning,
      amountCents:
        occurrence.amountMeaning === "TOTAL_PURCHASE"
          ? occurrence.amountCents
          : null,
      installmentCount:
        occurrence.installmentCount !== null &&
        occurrence.installmentCount >= 1 &&
        occurrence.installmentCount <= LIMITS.installmentsPerPurchase
          ? occurrence.installmentCount
          : null,
      dataCompra: occurrence.dateOnly,
      firstDueDate: null,
      targets:
        classification === CARD_IMPORT_LINE_CLASSIFICATION.PURCHASE ? null : [],
      decision: (() => {
        if (classification === CARD_IMPORT_LINE_CLASSIFICATION.PURCHASE)
          return { kind: "UNRESOLVED" };
        return {
          kind: "IGNORED_POLICY",
          reason:
            classification ===
            CARD_IMPORT_LINE_CLASSIFICATION.IGNORE_CARD_PAYS_CARD
              ? "CARD_PAYS_CARD"
              : "INVOICE_PAYMENT",
          policyVersion: CARD_IMPORT_LINE_POLICY_VERSION,
        };
      })(),
    };
    draft.lines.push(line);
    const fileFields: ImportSessionDraftQuestionV1["field"][] = [
      "amountMeaning",
      ...(line.amountCents === null ? [] : (["amountCents"] as const)),
      ...(line.installmentCount === null
        ? []
        : (["installmentCount"] as const)),
      ...(line.dataCompra === null ? [] : (["dataCompra"] as const)),
    ];
    draft.fieldProvenance ??= [];
    for (const field of fileFields)
      draft.fieldProvenance.push({
        origin: "FILE",
        lineId: line.id,
        field,
        recordedRevision: session.revision + 1,
      });
    if (line.decision.kind === "IGNORED_POLICY") continue;
    if (draft.selectedLineIds.length < LIMITS.selectedLines)
      draft.selectedLineIds.push(line.id);
    const fields: ImportSessionDraftQuestionV1["field"][] = [];
    if (line.dataCompra === null) fields.push("dataCompra");
    if (line.amountMeaning !== "TOTAL_PURCHASE") fields.push("amountMeaning");
    if (line.amountCents === null) fields.push("amountCents");
    if (line.installmentCount === null) fields.push("installmentCount");
    fields.push("firstDueDate");
    for (const field of fields)
      draft.questions.push({
        id: createHash("sha256").update(`${line.id}:${field}`).digest("hex"),
        lineIds: [line.id],
        field,
        text: `Informe ${field} para revisar esta compra. Esta resposta atualiza o rascunho; a verificação documental pode continuar pendente.`,
      });
  }
  draft.scope.pendingAttachmentIds = draft.scope.pendingAttachmentIds.filter(
    (id) => id !== attachment.id,
  );
  if (
    draft.lines.length > LIMITS.editableLines ||
    draft.scope.observationIds.length > LIMITS.parsedRowsPerSession ||
    Buffer.byteLength(canonical(draft), "utf8") >
      LIMITS.jsonBytesPerDraftOrProposal
  )
    throw new ImportSessionError(Code.LIMIT_EXCEEDED);
  validateStoredDraft(draft);
  return plan;
}
