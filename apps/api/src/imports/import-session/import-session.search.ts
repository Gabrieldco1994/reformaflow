import {
  IMPORT_SESSION_LIMITS,
  IMPORT_SESSION_PRIMITIVES,
  type ImportSessionStoredDraftV1,
} from "@reformaflow/domain";
import type {
  ImportCandidateRef,
  SearchStep,
  StoredImportSearchV1,
} from "./card-purchase-batch.port";
import { ImportSessionCorruptStateError } from "./import-session.errors";

const STAGES = ["DOCUMENT_IDENTITY", "CROSS_ORIGIN", "CARD_IDENTITY"] as const;
const KINDS = ["EXPENSE", "RECEIPT"] as const;
const REASONS = [
  "STRONG_IDENTITY",
  "NATURAL_MATCH",
  "INSTALLMENT_MATCH",
] as const;
const HASH = new RegExp(IMPORT_SESSION_PRIMITIVES.hashPattern);
const ID = new RegExp(IMPORT_SESSION_PRIMITIVES.idPattern);
const corrupt = () => new ImportSessionCorruptStateError("search");
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const hash = (value: unknown): value is string =>
  typeof value === "string" && HASH.test(value);
const id = (value: unknown): value is string =>
  typeof value === "string" && ID.test(value);
const member = <T extends string>(
  values: readonly T[],
  value: unknown,
): value is T =>
  typeof value === "string" && values.some((item) => item === value);

export function parseStoredImportSearch(
  raw: string | null,
  expectedPrepRevision: number,
  draft: ImportSessionStoredDraftV1,
): { kind: "EMPTY_SEARCH" } | { kind: "SEARCH"; value: StoredImportSearchV1 } {
  if (raw === null) return { kind: "EMPTY_SEARCH" };
  if (
    Buffer.byteLength(raw, "utf8") >
    IMPORT_SESSION_LIMITS.jsonBytesPerDraftOrProposal
  )
    throw corrupt();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) throw corrupt();
    throw error;
  }
  if (
    !record(value) ||
    !exact(value, [
      "version",
      "revision",
      "complete",
      "candidates",
      "coverage",
    ]) ||
    value.version !== 1 ||
    value.revision !== expectedPrepRevision ||
    !Number.isInteger(value.revision) ||
    expectedPrepRevision < 1 ||
    expectedPrepRevision > IMPORT_SESSION_PRIMITIVES.maxRevision ||
    typeof value.complete !== "boolean" ||
    !Array.isArray(value.candidates) ||
    value.candidates.length >
      IMPORT_SESSION_LIMITS.matchingRowsVisitedPerPreparation ||
    !record(value.coverage) ||
    !exact(value.coverage, ["recipe", "inputHash", "steps"]) ||
    value.coverage.recipe !== "CARD_PURCHASE_V1" ||
    !hash(value.coverage.inputHash) ||
    !Array.isArray(value.coverage.steps)
  )
    throw corrupt();
  const selected = new Set(draft.selectedLineIds);
  if (value.coverage.steps.length !== selected.size * STAGES.length)
    throw corrupt();
  const seen = new Set<string>();
  let visits = 0;
  const steps: SearchStep[] = value.coverage.steps.map((step: unknown) => {
    if (
      !record(step) ||
      !exact(step, [
        "lineId",
        "stage",
        "status",
        "predicateHash",
        "visitedRows",
        "endCursor",
      ]) ||
      !id(step.lineId) ||
      !selected.has(step.lineId) ||
      !member(STAGES, step.stage) ||
      step.endCursor !== null ||
      typeof step.visitedRows !== "number" ||
      !Number.isSafeInteger(step.visitedRows) ||
      step.visitedRows < 0
    )
      throw corrupt();
    const key = `${step.lineId}:${step.stage}`;
    if (seen.has(key)) throw corrupt();
    seen.add(key);
    visits += step.visitedRows;
    if (visits > IMPORT_SESSION_LIMITS.matchingRowsVisitedPerPreparation)
      throw corrupt();
    if (
      step.status === "NOT_RUN" &&
      step.predicateHash === null &&
      step.visitedRows === 0
    )
      return {
        lineId: step.lineId,
        stage: step.stage,
        status: "NOT_RUN",
        predicateHash: null,
        visitedRows: 0,
        endCursor: null,
      };
    if (step.status !== "EXHAUSTED" || !hash(step.predicateHash))
      throw corrupt();
    return {
      lineId: step.lineId,
      stage: step.stage,
      status: "EXHAUSTED",
      predicateHash: step.predicateHash,
      visitedRows: step.visitedRows,
      endCursor: null,
    };
  });
  const allTerminalNoWrite =
    selected.size === 0 &&
    draft.lines.length > 0 &&
    draft.lines.every((line) =>
      ["DEFER", "EXCLUDE", "IGNORED_POLICY"].includes(line.decision.kind),
    );
  if (
    value.complete !==
    ((selected.size > 0 &&
      steps.every((step) => step.status === "EXHAUSTED")) ||
      allTerminalNoWrite)
  )
    throw corrupt();
  const candidatesSeen = new Set<string>();
  const candidates: ImportCandidateRef[] = value.candidates.map(
    (candidate: unknown) => {
      if (
        !record(candidate) ||
        !exact(candidate, ["lineId", "kind", "id", "reason"]) ||
        !id(candidate.lineId) ||
        !selected.has(candidate.lineId) ||
        !id(candidate.id) ||
        !member(KINDS, candidate.kind) ||
        !member(REASONS, candidate.reason)
      )
        throw corrupt();
      const key = `${candidate.lineId}:${candidate.kind}:${candidate.id}`;
      if (candidatesSeen.has(key)) throw corrupt();
      candidatesSeen.add(key);
      return {
        lineId: candidate.lineId,
        kind: candidate.kind,
        id: candidate.id,
        reason: candidate.reason,
      };
    },
  );
  return {
    kind: "SEARCH",
    value: {
      version: 1,
      revision: expectedPrepRevision,
      complete: value.complete,
      candidates,
      coverage: {
        recipe: "CARD_PURCHASE_V1",
        inputHash: value.coverage.inputHash,
        steps,
      },
    },
  };
}
