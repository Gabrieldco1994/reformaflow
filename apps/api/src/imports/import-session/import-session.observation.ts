import type {
  ImportObservation,
  ImportSession,
  ImportSessionArtifact,
} from "@prisma/client";
import {
  IMPORT_SESSION_LIMITS,
  IMPORT_SESSION_PRIMITIVES,
  IMPORT_SESSION_PROTOCOL_VERSION,
  ImportSessionAmountMeaning,
  ImportSessionAttachmentState,
  ImportSessionErrorCode,
  parseInstallmentDateOnlyUtc,
  type ImportSessionObservationViewV1,
  type ImportSessionStoredDraftV1,
} from "@reformaflow/domain";
import {
  ImportSessionCorruptStateError,
  ImportSessionError,
} from "./import-session.errors";
import { invoicePaymentIgnoredReason } from "../../credit-card/invoice-payment-classification";

/** A purchase binding is editable only while every canonical claim field is empty. */
export const EMPTY_IMPORT_OBSERVATION_CLAIM = Object.freeze({
  canonicalProjectId: null,
  canonicalExpenseId: null,
  canonicalReceiptId: null,
  canonicalIndex: null,
  claimSessionId: null,
  claimReceiptJson: null,
  claimedAt: null,
});

export interface StoredImportObservationEvidenceV1 {
  /** Immutable parser source; optional solely for additive historical read compatibility. */
  sourceDescription?: string | null;
  version: 1;
  reference: string;
  text: string;
  amountMeaning: ImportSessionAmountMeaning;
  amountCents: number | null;
  installmentCount: number | null;
  installmentIndex: number | null;
  dataCompra: string | null;
  identity: {
    merchant: string | null;
    externalId: string | null;
    fitId: string | null;
    ordinal: number | null;
    fileContentHash: string | null;
  };
  /** Server-derived binding for direct Vertex candidates; absent on local/legacy rows. */
  ocr?: {
    attachmentId: string;
    artifactSha256: string;
    candidateFingerprint: string;
    pageNumber: number;
  };
}

const EVIDENCE_KEYS = [
  "version",
  "reference",
  "text",
  "amountMeaning",
  "amountCents",
  "installmentCount",
  "installmentIndex",
  "dataCompra",
  "identity",
];
const IDENTITY_KEYS = [
  "merchant",
  "externalId",
  "fitId",
  "ordinal",
  "fileContentHash",
];
const OCR_KEYS = [
  "attachmentId",
  "artifactSha256",
  "candidateFingerprint",
  "pageNumber",
];
const FILE_CONTENT_HASH = /^[0-9a-f]{32}$/;
const ID = new RegExp(IMPORT_SESSION_PRIMITIVES.idPattern);
const id = (value: unknown): value is string =>
  typeof value === "string" && ID.test(value);
const corrupt = () => new ImportSessionCorruptStateError("evidence_json");
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const text = (value: unknown, min: number, max: number): value is string =>
  typeof value === "string" &&
  value.length >= min &&
  value.length <= max &&
  value.normalize("NFC") === value;
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);
const nullableInteger = (value: unknown): value is number | null =>
  value === null || integer(value);
const nullableText = (value: unknown, max: number): value is string | null =>
  value === null || text(value, 0, max);
const meaning = (value: unknown): value is ImportSessionAmountMeaning =>
  Object.values(ImportSessionAmountMeaning).some((item) => item === value);
const dateOnly = (value: unknown): value is string | null => {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  const date = parseInstallmentDateOnlyUtc(value);
  return (
    date !== null &&
    date.getUTCFullYear() >= IMPORT_SESSION_PRIMITIVES.minYear &&
    date.getUTCFullYear() <= IMPORT_SESSION_PRIMITIVES.maxYear
  );
};

export function parseStoredImportObservationEvidence(
  raw: string,
): StoredImportObservationEvidenceV1 {
  if (
    typeof raw !== "string" ||
    Buffer.byteLength(raw, "utf8") >
      IMPORT_SESSION_LIMITS.jsonBytesPerDraftOrProposal
  ) {
    throw corrupt();
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) throw corrupt();
    throw error;
  }
  if (
    !record(value) ||
    !(
      exact(value, EVIDENCE_KEYS) ||
      exact(value, [...EVIDENCE_KEYS, "sourceDescription"]) ||
      exact(value, [...EVIDENCE_KEYS, "ocr"]) ||
      exact(value, [...EVIDENCE_KEYS, "sourceDescription", "ocr"])
    ) ||
    ("sourceDescription" in value &&
      // Documentary raw fields are intentionally neither NFC nor display-length
      // constrained. The complete stored evidence envelope is byte-bounded above.
      value.sourceDescription !== null &&
      typeof value.sourceDescription !== "string") ||
    value.version !== IMPORT_SESSION_PROTOCOL_VERSION ||
    !text(value.reference, 1, IMPORT_SESSION_PRIMITIVES.maxReferenceLength) ||
    !text(value.text, 0, IMPORT_SESSION_PRIMITIVES.maxObservationTextLength) ||
    !meaning(value.amountMeaning) ||
    !nullableInteger(value.amountCents) ||
    (value.amountCents !== null &&
      (value.amountCents < IMPORT_SESSION_PRIMITIVES.minCents ||
        value.amountCents > IMPORT_SESSION_PRIMITIVES.maxCents)) ||
    !nullableInteger(value.installmentCount) ||
    !nullableInteger(value.installmentIndex) ||
    !dateOnly(value.dataCompra) ||
    !record(value.identity) ||
    !exact(value.identity, IDENTITY_KEYS)
  )
    throw corrupt();
  const identity = value.identity;
  const ocr = "ocr" in value && record(value.ocr) ? value.ocr : null;
  if (
    "ocr" in value &&
    (!ocr ||
      !exact(ocr, OCR_KEYS) ||
      typeof ocr.attachmentId !== "string" ||
      !ID.test(ocr.attachmentId) ||
      typeof ocr.artifactSha256 !== "string" ||
      !new RegExp(IMPORT_SESSION_PRIMITIVES.hashPattern).test(
        ocr.artifactSha256,
      ) ||
      typeof ocr.candidateFingerprint !== "string" ||
      !new RegExp(IMPORT_SESSION_PRIMITIVES.hashPattern).test(
        ocr.candidateFingerprint,
      ) ||
      !Number.isSafeInteger(ocr.pageNumber) ||
      (ocr.pageNumber as number) < 1)
  )
    throw corrupt();
  if (
    !nullableText(
      identity.merchant,
      IMPORT_SESSION_PRIMITIVES.maxSupplierLength,
    ) ||
    !nullableText(
      identity.externalId,
      IMPORT_SESSION_PRIMITIVES.maxReferenceLength,
    ) ||
    !nullableText(
      identity.fitId,
      IMPORT_SESSION_PRIMITIVES.maxReferenceLength,
    ) ||
    !nullableInteger(identity.ordinal) ||
    (identity.ordinal !== null && identity.ordinal < 0) ||
    !(
      identity.fileContentHash === null ||
      (typeof identity.fileContentHash === "string" &&
        FILE_CONTENT_HASH.test(identity.fileContentHash))
    )
  )
    throw corrupt();
  return Object.freeze({
    ...("sourceDescription" in value
      ? { sourceDescription: value.sourceDescription as string | null }
      : {}),
    version: IMPORT_SESSION_PROTOCOL_VERSION,
    reference: value.reference,
    text: value.text,
    amountMeaning: value.amountMeaning,
    amountCents: value.amountCents,
    installmentCount: value.installmentCount,
    installmentIndex: value.installmentIndex,
    dataCompra: value.dataCompra,
    identity: Object.freeze({
      merchant: identity.merchant,
      externalId: identity.externalId,
      fitId: identity.fitId,
      ordinal: identity.ordinal,
      fileContentHash: identity.fileContentHash,
    }),
    ...(ocr
      ? {
          ocr: Object.freeze({
            attachmentId: ocr.attachmentId as string,
            artifactSha256: ocr.artifactSha256 as string,
            candidateFingerprint: ocr.candidateFingerprint as string,
            pageNumber: ocr.pageNumber as number,
          }),
        }
      : {}),
  });
}

export function projectImportObservation(
  session: Pick<ImportSession, "id" | "tenantId" | "ownerProjectId">,
  scope: ImportSessionStoredDraftV1["scope"],
  row: ImportObservation,
  attachment: ImportSessionArtifact,
): ImportSessionObservationViewV1 {
  if (
    !id(session.id) ||
    !id(session.tenantId) ||
    !id(session.ownerProjectId) ||
    !id(row.id) ||
    !id(row.artifactId) ||
    !id(attachment.id) ||
    row.tenantId !== session.tenantId ||
    row.ownerProjectId !== session.ownerProjectId ||
    attachment.tenantId !== session.tenantId ||
    attachment.ownerProjectId !== session.ownerProjectId ||
    attachment.sessionId !== session.id ||
    attachment.state !== ImportSessionAttachmentState.ATTACHED ||
    attachment.artifactId === null ||
    attachment.artifactId !== row.artifactId ||
    !scope.observationIds.includes(row.id)
  )
    throw new ImportSessionError(ImportSessionErrorCode.NOT_FOUND);
  const evidence = parseStoredImportObservationEvidence(row.evidenceJson);
  if (evidence.reference !== row.reference) throw corrupt();
  return {
    ...(evidence.sourceDescription !== undefined ||
    ignoredImportObservation(evidence) !== null
      ? { ignoredReason: ignoredImportObservation(evidence) }
      : {}),
    id: row.id,
    attachmentId: attachment.id,
    reference: row.reference,
    text: evidence.text,
    amountMeaning: evidence.amountMeaning,
    amountCents: evidence.amountCents,
    installmentCount: evidence.installmentCount,
    installmentIndex: evidence.installmentIndex,
    dataCompra: evidence.dataCompra,
  };
}

export function ignoredImportObservation(
  evidence: StoredImportObservationEvidenceV1,
): ReturnType<typeof invoicePaymentIgnoredReason> {
  return invoicePaymentIgnoredReason(
    evidence.sourceDescription === undefined
      ? evidence.identity.merchant
      : evidence.sourceDescription,
  );
}
