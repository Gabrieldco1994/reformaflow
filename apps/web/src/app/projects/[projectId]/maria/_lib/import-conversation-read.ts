import {
  IMPORT_SESSION_LIMITS,
  ImportSessionErrorCode,
  type ImportChatOutcomeV1,
  type ImportChatTurnV1,
  type ImportFocusV1,
} from "@reformaflow/domain";
import { isRecord } from "./import-session-read";
import {
  hasExactImportKeys as exact,
  isImportId as id,
  isImportIds as ids,
  isImportRequestId as requestId,
  isImportRevision as revision,
  ImportWorkflowResponseError,
  QUESTION_FIELDS,
} from "./import-session-workflow-read";

export class ImportConversationHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly outcome: Extract<ImportChatOutcomeV1, { kind: "ERROR" }>,
  ) {
    super("Import conversation failed");
  }
}

const oneOf = (value: unknown, choices: readonly string[]) =>
  typeof value === "string" && choices.includes(value);
const lineIds = (value: unknown) =>
  ids(value, 1, IMPORT_SESSION_LIMITS.editableLines);
const focus = (value: unknown): value is ImportFocusV1 =>
  isRecord(value) &&
  exact(value, ["id", "field", "lineIds"]) &&
  id(value.id) &&
  oneOf(value.field, QUESTION_FIELDS) &&
  lineIds(value.lineIds);

function isTurn(v: unknown): v is ImportChatTurnV1 {
  if (
    !isRecord(v) ||
    !exact(v, [
      "version",
      "turnId",
      "sessionId",
      "expectedRevision",
      "channel",
      "literalAnswer",
      "intent",
      "focus",
      "scope",
    ]) ||
    v.version !== 1 ||
    !requestId(v.turnId) ||
    !id(v.sessionId) ||
    !revision(v.expectedRevision) ||
    !oneOf(v.channel, ["TEXT", "VOICE"]) ||
    typeof v.literalAnswer !== "string" ||
    !v.literalAnswer.trim() ||
    v.literalAnswer.length > 4000
  )
    return false;
  if (oneOf(v.intent, ["CONTINUE", "OPEN_REVIEW", "READ_RESULT"]))
    return v.focus === null && v.scope === null;
  if (!focus(v.focus) || !isRecord(v.scope)) return false;
  const s = v.scope;
  if (v.intent === "APPROVE_ATTACHMENT_SCOPE")
    return (
      exact(s, ["kind", "attachmentId", "approvedLineIds"]) &&
      s.kind === "ATTACHMENT" &&
      id(s.attachmentId) &&
      lineIds(s.approvedLineIds)
    );
  if (v.intent !== "ANSWER") return false;
  if (s.kind === "ATTACHMENT")
    return exact(s, ["kind", "attachmentId"]) && id(s.attachmentId);
  const f = v.focus;
  return (
    s.kind === "LINES" &&
    exact(s, ["kind", "lineIds"]) &&
    ids(s.lineIds, 1, IMPORT_SESSION_LIMITS.editableLines) &&
    s.lineIds.every((line) => f.lineIds.includes(line))
  );
}

export function readImportChatTurn(value: unknown): ImportChatTurnV1 {
  if (!isTurn(value)) throw new ImportWorkflowResponseError();
  return value;
}

const reasons = [
  "AMBIGUOUS",
  "INVALID_VALUE",
  "MULTI_FIELD",
  "UNSUPPORTED_NORMALIZATION",
  "SCOPE_REVIEW",
  "INCOMPLETE_SCOPE",
];
const codes = [
  ...Object.values(ImportSessionErrorCode),
  "PROVIDER_UNAVAILABLE",
  "MODEL_OUTPUT_INVALID",
  "TOOL_NOT_ALLOWED",
  "TURN_LIMIT",
  "INTERNAL_ERROR",
];
const baseKeys = ["version", "turnId", "ref", "acknowledgment", "kind"];
const outcomeKinds: Record<
  ImportChatTurnV1["intent"],
  readonly ImportChatOutcomeV1["kind"][]
> = {
  ANSWER: ["CLARIFY", "REVISED_SESSION", "ERROR"],
  APPROVE_ATTACHMENT_SCOPE: ["CLARIFY", "REVISED_SESSION", "ERROR"],
  CONTINUE: ["QUESTION", "REVISED_SESSION", "ERROR"],
  OPEN_REVIEW: ["QUESTION", "REVISED_SESSION", "OPEN_REVIEW", "ERROR"],
  READ_RESULT: ["READ_RESULT", "ERROR"],
};
function isOutcome(v: unknown): v is ImportChatOutcomeV1 {
  if (!isRecord(v) || v.version !== 1 || !requestId(v.turnId)) return false;
  const ref = v.ref;
  if (
    !(
      ref === null ||
      (isRecord(ref) &&
        exact(ref, ["sessionId", "revision"]) &&
        id(ref.sessionId) &&
        revision(ref.revision))
    )
  )
    return false;
  if (v.kind === "ERROR") {
    if (
      !exact(v, [...baseKeys, "code", "reason", "retryable", "recovery"]) ||
      !oneOf(v.code, codes) ||
      typeof v.retryable !== "boolean" ||
      !(
        v.reason === null ||
        oneOf(v.reason, ["ATTACHMENT_IN_FLIGHT", "WRITE_BUDGET_EXCEEDED"])
      ) ||
      !oneOf(v.recovery, [
        "READ_SESSION",
        "READ_RESULT",
        "REAUTHENTICATE",
        "NONE",
      ]) ||
      !oneOf(v.acknowledgment, ["NONE", "UNKNOWN"])
    )
      return false;
    if (oneOf(v.code, ["UNAUTHENTICATED", "UI_ACTION_REQUIRED", "NOT_FOUND"]))
      return ref === null && v.acknowledgment === "NONE";
    return v.acknowledgment !== "UNKNOWN" || v.recovery !== "NONE";
  }
  if (ref === null) return false;
  switch (v.kind) {
    case "CLARIFY": {
      if (
        !exact(v, [...baseKeys, "reason", "scopeReview"]) ||
        v.acknowledgment !== "NONE" ||
        !oneOf(v.reason, reasons)
      )
        return false;
      if (v.reason !== "SCOPE_REVIEW") return v.scopeReview === null;
      const s = v.scopeReview;
      return (
        isRecord(s) &&
        exact(s, ["focus", "attachmentId", "lineIds"]) &&
        focus(s.focus) &&
        id(s.attachmentId) &&
        lineIds(s.lineIds)
      );
    }
    case "QUESTION":
      return (
        exact(v, [...baseKeys, "questionId"]) &&
        id(v.questionId) &&
        oneOf(v.acknowledgment, ["NONE", "PREPARED"])
      );
    case "REVISED_SESSION":
      return (
        exact(v, baseKeys) &&
        oneOf(v.acknowledgment, ["NONE", "EDITED", "NO_CHANGE", "PREPARED"])
      );
    case "OPEN_REVIEW":
      return (
        exact(v, baseKeys) && oneOf(v.acknowledgment, ["NONE", "PREPARED"])
      );
    case "READ_RESULT":
      return exact(v, baseKeys) && v.acknowledgment === "NONE";
    default:
      return false;
  }
}

export function readImportChatOutcome(
  value: unknown,
  turn: ImportChatTurnV1,
): ImportChatOutcomeV1 {
  if (
    !isOutcome(value) ||
    value.turnId !== turn.turnId ||
    (value.ref !== null && value.ref.sessionId !== turn.sessionId)
  )
    throw new ImportWorkflowResponseError();
  if (!outcomeKinds[turn.intent].includes(value.kind))
    throw new ImportWorkflowResponseError();
  if (value.kind === "ERROR") return value;
  const answer =
    turn.intent === "ANSWER" || turn.intent === "APPROVE_ATTACHMENT_SCOPE";
  if (
    value.ref.revision < turn.expectedRevision ||
    (oneOf(value.acknowledgment, ["EDITED", "PREPARED"]) &&
      value.ref.revision === turn.expectedRevision) ||
    (value.acknowledgment === "NO_CHANGE" &&
      value.ref.revision !== turn.expectedRevision) ||
    (value.kind === "OPEN_REVIEW" &&
      value.acknowledgment === "NONE" &&
      value.ref.revision !== turn.expectedRevision) ||
    (oneOf(value.acknowledgment, ["EDITED", "NO_CHANGE"]) && !answer) ||
    (value.acknowledgment === "PREPARED" && turn.intent !== "OPEN_REVIEW") ||
    (value.kind === "OPEN_REVIEW" && turn.intent !== "OPEN_REVIEW") ||
    (value.kind === "READ_RESULT" && turn.intent !== "READ_RESULT") ||
    (value.kind === "REVISED_SESSION" &&
      value.acknowledgment === "NONE" &&
      turn.intent !== "CONTINUE")
  )
    throw new ImportWorkflowResponseError();
  if (value.kind === "CLARIFY" && value.scopeReview) {
    const s = value.scopeReview;
    if (
      !answer ||
      !turn.focus ||
      turn.scope.kind !== "ATTACHMENT" ||
      s.attachmentId !== turn.scope.attachmentId ||
      s.focus.id !== turn.focus.id ||
      s.focus.field !== turn.focus.field ||
      s.focus.lineIds.length !== turn.focus.lineIds.length ||
      !s.focus.lineIds.every((line) => turn.focus?.lineIds.includes(line))
    )
      throw new ImportWorkflowResponseError();
  }
  return value;
}
