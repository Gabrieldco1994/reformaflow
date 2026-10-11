import { createHash } from "node:crypto";
import type {
  ImportArtifact,
  ImportObservation,
  ImportSession,
  ImportSessionArtifact,
} from "@prisma/client";
import {
  IMPORT_SESSION_PRIMITIVES as P,
  ImportSessionErrorCode as Code,
  ImportSessionAmountMeaning as Meaning,
  encodeImportDeclaration,
  parseImportDeclarationLiteral,
  type ImportDeclarationAnswerV1,
  type ImportDeclarationContextV1,
  type ImportSessionDocumentaryAnswerRequestV1,
  type ImportSessionQuestionV1,
  type ImportDeclaredFactViewV1,
  type ImportHumanFactFieldV1,
  type ImportHumanFactValuesV1,
  type ImportHumanMeaningV1,
  type ImportObservationQuestionV1,
  type ImportReviewBlockerV1,
  type ImportSessionDraftLineV1,
  type ImportSessionStoredDraftV1,
  type ImportStoredDeclarationV1,
} from "@reformaflow/domain";
import { canonical } from "../../common/canonical";
import {
  dedupeKeyNatural,
  dedupeKeyStrong,
} from "../../credit-card/parsers/dedupe-key";
import { makeExternalId } from "../../credit-card/parsers/types";
import type { DedupeKeys } from "../../import-dedupe/cross-origin-dedupe";
import {
  ImportSessionCorruptStateError,
  ImportSessionError,
} from "./import-session.errors";
import {
  hasIncompleteCreateOccurrence,
  hasIncompleteKeepOccurrence,
  importReviewBlockers,
  isWholePurchaseObservation,
} from "./import-session.extraction";
import {
  parseStoredImportObservationEvidence,
  projectImportObservation,
  type StoredImportObservationEvidenceV1,
} from "./import-session.observation";
import { validateStoredDraft } from "./import-session.validation";

const HASH = new RegExp(P.hashPattern);

type Session = Pick<
  ImportSession,
  "id" | "tenantId" | "ownerProjectId" | "revision"
>;
type Artifact = Pick<
  ImportArtifact,
  "id" | "tenantId" | "ownerProjectId" | "documentSha256"
>;
export interface ImportDeclarationMaterial {
  observations: readonly ImportObservation[];
  references: readonly {
    ref: ImportSessionArtifact;
    artifact: Artifact | null;
  }[];
}
export interface EffectiveImportObservationFacts {
  dataCompra: string | null;
  merchant: string | null;
  amountMeaning: StoredImportObservationEvidenceV1["amountMeaning"];
  amountCents: number | null;
  installmentCount: number | null;
  installmentIndex: number | null;
}
interface ResolvedObservation {
  original: StoredImportObservationEvidenceV1;
  effective: EffectiveImportObservationFacts;
  originalFingerprint: string;
  claimVersion: number;
  validAnswers: ImportStoredDeclarationV1[];
}
export interface ImportDeclarationResolution {
  questions: ImportObservationQuestionV1[];
  declaredFacts: ImportDeclaredFactViewV1[];
  reviewBlockers: ImportReviewBlockerV1[];
  byLine: Map<string, Map<string, ResolvedObservation>>;
}
/** Only whole-literal normalization against the authoritative context raises this. */
export class ImportDeclarationLiteralError extends ImportSessionError {
  constructor() {
    super(Code.INVALID_INPUT);
  }
}
export function importObservationDedupeKeys(
  session: Pick<ImportSession, "tenantId" | "ownerProjectId" | "cardId">,
  observation: ResolvedObservation,
): DedupeKeys | null {
  const {
    original: { identity },
    effective,
  } = observation;
  if (
    identity.ordinal === null ||
    effective.dataCompra === null ||
    effective.merchant === null ||
    effective.amountCents === null
  )
    return null;
  const params = {
    tenantId: session.tenantId,
    projectId: session.ownerProjectId,
    date: new Date(`${effective.dataCompra}T00:00:00.000Z`),
    merchant: effective.merchant,
    amountCents: effective.amountCents,
    ordinal: identity.ordinal,
  };
  return {
    externalId:
      identity.externalId ??
      makeExternalId({
        ...params,
        cardId: session.cardId,
        bankRef: identity.fitId ?? undefined,
      }),
    strong: dedupeKeyStrong({
      ...params,
      fitId: identity.fitId ?? undefined,
      fileContentHash: identity.fileContentHash ?? undefined,
    }),
    natural: dedupeKeyNatural(params),
  };
}
const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const fields: readonly ImportHumanFactFieldV1[] = [
  "dataCompra",
  "merchant",
  "amountMeaning",
  "amountCents",
  "installmentCount",
  "installmentIndex",
];
const labels: Record<ImportHumanFactFieldV1, string> = {
  dataCompra: "Data da compra",
  merchant: "Nome do estabelecimento",
  amountMeaning: "Significado do valor",
  amountCents: "Valor",
  installmentCount: "Total de parcelas",
  installmentIndex: "Número desta parcela",
};
const stale = () => new ImportSessionError(Code.STALE_PREVIEW);
const invalid = () => new ImportSessionError(Code.INVALID_INPUT);
type NonNullAnswer = {
  [F in ImportHumanFactFieldV1]: Extract<
    ImportDeclarationAnswerV1,
    { field: F }
  > & { value: ImportHumanFactValuesV1[F] };
}[ImportHumanFactFieldV1];
const hasValue = (answer: ImportDeclarationAnswerV1): answer is NonNullAnswer =>
  answer.value !== null;
function answerOf(item: ImportStoredDeclarationV1): ImportDeclarationAnswerV1 {
  const {
    lineId: _line,
    observationId: _observation,
    originalFingerprint: _fingerprint,
    claimVersion: _claim,
    originSessionId: _session,
    recordedRevision: _revision,
    questionId: _question,
    turnId: _turn,
    attestedByUserId: _user,
    attestedAt: _at,
    literalHash: _literal,
    channel: _channel,
    ...answer
  } = item;
  return answer;
}
function applyFact(
  facts: EffectiveImportObservationFacts,
  answer: NonNullAnswer,
): void {
  switch (answer.field) {
    case "amountMeaning":
      facts.amountMeaning = answer.value;
      break;
    case "amountCents":
      facts.amountCents = answer.value;
      break;
    case "installmentCount":
      facts.installmentCount = answer.value;
      break;
    case "installmentIndex":
      facts.installmentIndex = answer.value;
      break;
    case "dataCompra":
      facts.dataCompra = answer.value;
      break;
    case "merchant":
      facts.merchant = answer.value;
      break;
  }
}
function makeQuestion(
  session: Session,
  line: ImportSessionDraftLineV1,
  observationId: string,
  resolved: ResolvedObservation,
  field: ImportHumanFactFieldV1,
  meaningContext: ImportHumanMeaningV1 | null,
  answerState: ImportObservationQuestionV1["answerState"],
): ImportObservationQuestionV1 {
  const id =
    "oq_" +
    hash({
      version: 1,
      tenantId: session.tenantId,
      sessionId: session.id,
      lineId: line.id,
      observationId,
      originalFingerprint: resolved.originalFingerprint,
      claimVersion: resolved.claimVersion,
      field,
      meaningContext,
    });
  const common = {
    id,
    lineIds: [line.id] as [string],
    text: labels[field],
    answerState,
  };
  if (field === "amountCents") {
    if (meaningContext === null)
      throw new ImportSessionCorruptStateError("declaration_context");
    return {
      ...common,
      field,
      text:
        meaningContext === "TOTAL_PURCHASE"
          ? "Total da compra"
          : "Valor desta parcela",
      subject: { kind: "OBSERVATION", observationId, meaningContext },
    };
  }
  return {
    ...common,
    field,
    subject: { kind: "OBSERVATION", observationId, meaningContext: null },
  };
}
function occurrenceMissing(
  line: ImportSessionDraftLineV1,
  facts: EffectiveImportObservationFacts,
): boolean {
  return line.decision.kind === "CREATE"
    ? hasIncompleteCreateOccurrence(facts)
    : line.decision.kind === "KEEP_EXISTING"
      ? hasIncompleteKeepOccurrence(facts)
      : hasIncompleteCreateOccurrence(facts) &&
        hasIncompleteKeepOccurrence(facts);
}

export function resolveImportDeclarations(
  session: Session,
  draft: ImportSessionStoredDraftV1,
  material: ImportDeclarationMaterial,
): ImportDeclarationResolution {
  const result: ImportDeclarationResolution = {
    questions: [],
    declaredFacts: [],
    reviewBlockers: [],
    byLine: new Map(),
  };
  const originals = new Map<string, StoredImportObservationEvidenceV1>();
  for (const line of draft.lines) {
    const byObservation = new Map<string, ResolvedObservation>();
    result.byLine.set(line.id, byObservation);
    for (const observationId of line.observationIds) {
      const row = material.observations.find(
        (item) => item.id === observationId,
      );
      const reference = material.references.find(
        (item) => item.ref.artifactId === row?.artifactId,
      );
      if (!row || !reference?.artifact)
        throw new ImportSessionCorruptStateError("declaration_material");
      const { artifact, ref } = reference;
      if (
        artifact.tenantId !== session.tenantId ||
        artifact.ownerProjectId !== session.ownerProjectId ||
        artifact.id !== row.artifactId ||
        typeof artifact.documentSha256 !== "string" ||
        !HASH.test(artifact.documentSha256)
      )
        throw new ImportSessionCorruptStateError("declaration_material");
      projectImportObservation(session, draft.scope, row, ref);
      const original = parseStoredImportObservationEvidence(row.evidenceJson);
      originals.set(row.id, original);
      const effective: EffectiveImportObservationFacts = {
        dataCompra: original.dataCompra,
        merchant: original.identity.merchant,
        amountMeaning: original.amountMeaning,
        amountCents: original.amountCents,
        installmentCount: original.installmentCount,
        installmentIndex: original.installmentIndex,
      };
      const resolved: ResolvedObservation = {
        original,
        effective,
        claimVersion: row.claimVersion,
        validAnswers: [],
        originalFingerprint: hash({
          tenantId: session.tenantId,
          ownerProjectId: session.ownerProjectId,
          observationId,
          artifactId: artifact.id,
          documentSha256: artifact.documentSha256,
          reference: row.reference,
          evidence: original,
        }),
      };
      byObservation.set(row.id, resolved);
      const stored =
        draft.declarations?.items.filter(
          (item) => item.lineId === line.id && item.observationId === row.id,
        ) ?? [];
      for (const item of stored) {
        if (
          item.originalFingerprint !== resolved.originalFingerprint ||
          item.claimVersion !== row.claimVersion ||
          (item.originSessionId === session.id &&
            item.recordedRevision > session.revision) ||
          row.claimedAt !== null
        )
          throw stale();
        if (
          item.questionId !==
          makeQuestion(
            { ...session, id: item.originSessionId },
            line,
            row.id,
            resolved,
            item.field,
            item.meaningContext,
            "UNKNOWN",
          ).id
        )
          throw new ImportSessionCorruptStateError("declaration_question");
        const known =
          item.field === "merchant"
            ? original.identity.merchant
            : original[item.field];
        if (
          known !== null &&
          known !== "UNKNOWN" &&
          item.value !== null &&
          known !== item.value
        )
          throw stale();
      }
      const applicationOrder: readonly ImportHumanFactFieldV1[] = [
        ...fields.filter((field) => field !== "amountCents"),
        "amountCents",
      ];
      for (const field of applicationOrder) {
        const item = stored.find((item) => item.field === field);
        if (!item || !hasValue(item)) continue;
        const known =
          field === "merchant" ? original.identity.merchant : original[field];
        if (known !== null && known !== "UNKNOWN") continue;
        if (
          field === "amountCents" &&
          item.meaningContext !== effective.amountMeaning
        )
          continue;
        applyFact(effective, item);
        resolved.validAnswers.push(item);
      }
      if (
        effective.installmentIndex !== null &&
        effective.installmentCount !== null &&
        effective.installmentIndex > effective.installmentCount &&
        resolved.validAnswers.some(
          (item) =>
            item.field === "installmentCount" ||
            item.field === "installmentIndex",
        )
      )
        throw invalid();
      const wanted = new Set<ImportHumanFactFieldV1>(
        stored.map((item) => item.field),
      );
      if (original.dataCompra === null) wanted.add("dataCompra");
      if (original.identity.merchant === null) wanted.add("merchant");
      if (original.amountMeaning === "UNKNOWN") wanted.add("amountMeaning");
      if (
        original.amountCents === null &&
        effective.amountMeaning !== "UNKNOWN"
      )
        wanted.add("amountCents");
      const wholeCreate =
        line.decision.kind === "CREATE" &&
        isWholePurchaseObservation(effective);
      if (!wholeCreate && original.installmentCount === null)
        wanted.add("installmentCount");
      if (
        original.installmentIndex === null &&
        !wholeCreate &&
        !(
          effective.installmentCount === 1 &&
          (line.decision.kind === "KEEP_EXISTING" ||
            effective.amountMeaning === "INSTALLMENT_CHARGE")
        )
      )
        wanted.add("installmentIndex");
      for (const field of fields) {
        if (!wanted.has(field)) continue;
        const item = stored.find((item) => item.field === field);
        const meaningContext =
          field === "amountCents"
            ? effective.amountMeaning === "UNKNOWN"
              ? null
              : effective.amountMeaning
            : null;
        if (field === "amountCents" && meaningContext === null) continue;
        const changed =
          item?.field === "amountCents" &&
          item.meaningContext !== effective.amountMeaning;
        const question = makeQuestion(
          session,
          line,
          row.id,
          resolved,
          field,
          meaningContext,
          !item || changed
            ? "UNANSWERED"
            : item.value === null
              ? "UNKNOWN"
              : "DECLARED",
        );
        result.questions.push(question);
        if (!item || (changed && item.value === null)) continue;
        const base = {
          lineId: line.id,
          observationId: row.id,
          questionId: question.id,
          origin: "USER_ATTESTATION" as const,
          ...(item.channel === undefined ? {} : { channel: item.channel }),
        };
        const answer = answerOf(item);
        if (changed && answer.field === "amountCents" && answer.value !== null)
          result.declaredFacts.push({
            ...base,
            ...answer,
            value: answer.value,
            status: "CONTEXT_CHANGED",
          });
        else if (hasValue(answer))
          result.declaredFacts.push({ ...base, ...answer, status: "CURRENT" });
        else
          result.declaredFacts.push({
            ...base,
            ...answer,
            value: null,
            status: "UNKNOWN",
          });
      }
    }
  }
  result.reviewBlockers = importReviewBlockers(draft.lines, originals).map(
    (blocker) => {
      const line = draft.lines.find((line) => line.id === blocker.lineId)!;
      const observations = [...result.byLine.get(line.id)!.values()];
      const needs =
        blocker.code === "ORIGINAL_IDENTITY_INCOMPLETE"
          ? observations.some(
              ({ effective }) =>
                effective.dataCompra === null ||
                effective.amountCents === null ||
                effective.merchant === null,
            )
          : observations.some(({ effective }) =>
              occurrenceMissing(line, effective),
            );
      return {
        ...blocker,
        resolution: needs
          ? "NEEDS_DECLARATION"
          : blocker.code === "ORIGINAL_IDENTITY_INCOMPLETE" &&
              observations.some(
                ({ original }) => original.identity.ordinal === null,
              )
            ? "SEARCH_IDENTITY_UNAVAILABLE"
            : "RESOLVED_BY_USER",
      };
    },
  );
  return result;
}

export function recordImportDeclaration(
  session: Session,
  draft: ImportSessionStoredDraftV1,
  material: ImportDeclarationMaterial,
  questionId: string,
  literal: string,
  actor: {
    userId: string;
    turnId: string;
    now: Date;
    channel: ImportSessionDocumentaryAnswerRequestV1["channel"];
  },
  originalLiteralHash?: string,
): ImportSessionStoredDraftV1 {
  const resolution = resolveImportDeclarations(session, draft, material);
  const question = resolution.questions.find(
    (question) => question.id === questionId,
  );
  if (!question) throw invalid();
  const lineId = question.lineIds[0];
  const observationId = question.subject.observationId;
  const facts = resolution.byLine.get(lineId)?.get(observationId);
  if (!facts) throw invalid();
  const context: ImportDeclarationContextV1 =
    question.field === "amountCents"
      ? {
          field: question.field,
          meaningContext: question.subject.meaningContext,
          effectiveInstallmentCount: facts.effective.installmentCount,
        }
      : {
          field: question.field,
          meaningContext: null,
          effectiveInstallmentCount: facts.effective.installmentCount,
        };
  const answer = parseImportDeclarationLiteral(context, literal);
  if (answer.kind !== "VALID") throw new ImportDeclarationLiteralError();
  const old = draft.declarations?.items.find(
    (item) =>
      item.lineId === lineId &&
      item.observationId === observationId &&
      item.field === question.field,
  );
  if (old && canonical(answerOf(old)) === canonical(answer.answer))
    return draft;
  const item: ImportStoredDeclarationV1 = {
    ...answer.answer,
    lineId,
    observationId,
    originalFingerprint: facts.originalFingerprint,
    claimVersion: facts.claimVersion,
    originSessionId: session.id,
    recordedRevision: session.revision + 1,
    questionId,
    turnId: actor.turnId,
    attestedByUserId: actor.userId,
    attestedAt: actor.now.toISOString(),
    literalHash:
      originalLiteralHash ?? createHash("sha256").update(literal).digest("hex"),
    channel: actor.channel,
  };
  const updated = validateStoredDraft({
    ...draft,
    declarations: {
      version: 1,
      items: [
        ...(draft.declarations?.items.filter(
          (item) =>
            !(
              item.lineId === lineId &&
              item.observationId === observationId &&
              item.field === question.field
            ),
        ) ?? []),
        item,
      ],
    },
  });
  const nextResolution = resolveImportDeclarations(
    { ...session, revision: session.revision + 1 },
    updated,
    material,
  );
  return reconcileImportDeclarationDraft(updated, nextResolution, resolution);
}

type CoveredField =
  | "dataCompra"
  | "amountMeaning"
  | "amountCents"
  | "installmentCount";
const COVERED_FIELDS: readonly CoveredField[] = [
  "dataCompra",
  "amountMeaning",
  "amountCents",
  "installmentCount",
];
const coveredField = (field: string): field is CoveredField =>
  COVERED_FIELDS.some((candidate) => candidate === field);

/**
 * A draft purchase total is NOT an observed installment charge. Only single-observation
 * lines have an unambiguous direct documentary-to-draft mapping; grouped lines retain
 * their explicit draft questions. Never infer a total by multiplying a charge.
 */
function compatibleDocumentaryField(
  line: ImportSessionDraftLineV1,
  field: CoveredField,
  facts: EffectiveImportObservationFacts,
): boolean {
  if (field === "amountMeaning")
    return (
      line.amountMeaning !== Meaning.INSTALLMENT_CHARGE &&
      facts.amountMeaning !== Meaning.INSTALLMENT_CHARGE
    );
  if (field === "amountCents")
    return (
      facts.amountMeaning === Meaning.TOTAL_PURCHASE &&
      line.amountMeaning !== Meaning.INSTALLMENT_CHARGE
    );
  return true;
}

/** Prefer live hashed subjects to duplicate legacy questions, without admitting legacy IDs. */
export function coalesceImportDeclarationQuestions(
  draft: ImportSessionStoredDraftV1,
  resolution: ImportDeclarationResolution,
): ImportSessionQuestionV1[] {
  // Historical drafts may predate synchronization. Reads suppress provably covered
  // tasks without writing; prepare persists this same derivation under its lock.
  const covered = reconcileImportDeclarationDraft(draft, resolution);
  const generic = covered.questions.flatMap((question) => {
    if (!coveredField(question.field) || question.lineIds.length !== 1)
      return [question];
    const field = question.field;
    const lineIds = question.lineIds.filter((lineId) => {
      const line = covered.lines.find((line) => line.id === lineId);
      if (!line || line.observationIds.length !== 1) return true;
      const observationId = line.observationIds[0];
      const facts = resolution.byLine
        .get(lineId)
        ?.get(observationId)?.effective;
      if (!facts || !compatibleDocumentaryField(line, field, facts))
        return true;
      const matching = resolution.questions.some(
        (q) =>
          q.field === field &&
          q.lineIds[0] === lineId &&
          q.subject.observationId === observationId &&
          (q.field !== "amountCents" ||
            q.subject.meaningContext === Meaning.TOTAL_PURCHASE),
      );
      // A human draft correction that differs from the documentary fact is a distinct task.
      const value = line[field];
      return (
        !matching ||
        (value !== null &&
          value !== Meaning.UNKNOWN &&
          facts[field] !== null &&
          facts[field] !== Meaning.UNKNOWN &&
          value !== facts[field])
      );
    });
    return lineIds.length ? [{ ...question, lineIds }] : [];
  });
  return [...resolution.questions, ...generic];
}

function supportsDraftField(
  item: ResolvedObservation,
  field: CoveredField,
): boolean {
  return item.validAnswers.some(
    (answer) =>
      answer.field === field ||
      (field === "amountCents" &&
        answer.field === "amountMeaning" &&
        answer.value === Meaning.TOTAL_PURCHASE),
  );
}

/**
 * Retire covered legacy tasks in the same edit, not merely in the read projection.
 * Fill only missing fields with current attested facts. Known source money may fill a
 * missing total only after an explicit TOTAL_PURCHASE meaning attestation. Preserve
 * independent human values; subsequent declaration edits update only inherited values.
 */
export function reconcileImportDeclarationDraft(
  draft: ImportSessionStoredDraftV1,
  resolution: ImportDeclarationResolution,
  previous?: ImportDeclarationResolution,
): ImportSessionStoredDraftV1 {
  const lines = draft.lines.map((line) => {
    if (line.observationIds.length !== 1) return line;
    const observationId = line.observationIds[0];
    const resolved = resolution.byLine.get(line.id)?.get(observationId);
    if (!resolved) return line;
    const old = previous?.byLine.get(line.id)?.get(observationId);
    const updated = { ...line };
    for (const field of COVERED_FIELDS) {
      const oldValue = old?.effective[field];
      const inherited =
        old && supportsDraftField(old, field) && line[field] === oldValue;
      const pending = draft.questions.some(
        (q) => q.field === field && q.lineIds.includes(line.id),
      );
      const missing = line[field] === null || line[field] === Meaning.UNKNOWN;
      if (
        !compatibleDocumentaryField(updated, field, resolved.effective) ||
        !(
          inherited ||
          (pending && missing && supportsDraftField(resolved, field))
        )
      )
        continue;
      switch (field) {
        case "amountMeaning":
          updated.amountMeaning = resolved.effective.amountMeaning;
          break;
        case "amountCents":
          updated.amountCents = resolved.effective.amountCents;
          break;
        case "dataCompra":
          updated.dataCompra = resolved.effective.dataCompra;
          break;
        case "installmentCount":
          updated.installmentCount = resolved.effective.installmentCount;
          break;
      }
    }
    return updated;
  });
  const questions = draft.questions.flatMap((question) => {
    if (!coveredField(question.field) || question.lineIds.length !== 1)
      return [question];
    const field = question.field;
    const lineIds = question.lineIds.filter((lineId) => {
      const line = lines.find((line) => line.id === lineId);
      if (!line || line.observationIds.length !== 1) return true;
      const resolved = resolution.byLine
        .get(lineId)
        ?.get(line.observationIds[0]);
      if (
        !resolved ||
        !compatibleDocumentaryField(line, field, resolved.effective)
      )
        return true;
      const value = resolved.effective[field];
      return (
        value === null ||
        value === Meaning.UNKNOWN ||
        line[field] !== value ||
        !supportsDraftField(resolved, field)
      );
    });
    return lineIds.length ? [{ ...question, lineIds }] : [];
  });
  return validateStoredDraft({ ...draft, lines, questions });
}

/** Resolve hashed question, fingerprint, claim and meaning only from locked server material. */
export function recordNativeImportDeclaration(
  session: Session,
  draft: ImportSessionStoredDraftV1,
  material: ImportDeclarationMaterial,
  request: ImportSessionDocumentaryAnswerRequestV1,
  actor: { userId: string; now: Date },
): ImportSessionStoredDraftV1 {
  const resolution = resolveImportDeclarations(session, draft, material);
  const question = resolution.questions.find(
    (q) => q.id === request.questionId,
  );
  if (!question)
    throw new ImportSessionError(Code.REVISION_CONFLICT, {
      sessionId: session.id,
      currentRevision: session.revision,
    });
  const facts = resolution.byLine
    .get(question.lineIds[0])
    ?.get(question.subject.observationId);
  if (!facts) throw invalid();
  const context = {
    field: question.field,
    meaningContext: question.subject.meaningContext,
    effectiveInstallmentCount: facts.effective.installmentCount,
  } as ImportDeclarationContextV1;
  const encoded = encodeImportDeclaration(context, request.input);
  if (
    encoded.kind !== "ENCODED" ||
    canonical(encoded.answer) !== canonical(request.answer)
  )
    throw invalid();
  // Absence controls have no VALUE literal; their exact intent is separately bound
  // by the grant's request hash. Keep the legacy encoded-literal hash for those.
  const originalLiteralHash =
    request.input.kind === "VALUE"
      ? createHash("sha256").update(request.input.text).digest("hex")
      : undefined;
  return recordImportDeclaration(
    session,
    draft,
    material,
    question.id,
    encoded.literalAnswer,
    {
      ...actor,
      turnId: request.answerRequestId,
      channel: request.channel,
    },
    originalLiteralHash,
  );
}
