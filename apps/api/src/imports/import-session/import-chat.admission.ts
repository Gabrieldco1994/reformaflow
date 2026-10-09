import {
  IMPORT_SESSION_LIMITS as LIMITS,
  IMPORT_SESSION_PRIMITIVES as PRIMITIVES,
  ImportSessionErrorCode as Code,
  type ImportChatTurnV1,
  type ImportChatOutcomeV1,
  type ImportFocusV1,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import { canonical } from "../../common/canonical";
import { ImportChatContractError } from "../../agent/import-chat.contract";
import { assertImportAuthForRequest } from "./import-session.auth";
import type { AuthenticatedImportContext } from "./import-session.contract";
import { ImportSessionError } from "./import-session.errors";

const ID = new RegExp(PRIMITIVES.idPattern);
const REQUEST_ID = new RegExp(PRIMITIVES.requestIdPattern);
const FIELDS: readonly ImportFocusV1["field"][] = [
  "amountMeaning",
  "amountCents",
  "installmentCount",
  "merchant",
  "installmentIndex",
  "dataCompra",
  "firstDueDate",
  "targets",
  "decision",
  "tipoDespesa",
  "categoriaMaoDeObra",
];
const invalid = () => new ImportSessionError(Code.INVALID_INPUT);
const inactive = () => new ImportSessionError(Code.UI_ACTION_REQUIRED);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string =>
  typeof value === "string" && ID.test(value);
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}
function ids(value: unknown): value is string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > LIMITS.editableLines
  )
    return false;
  for (const item of value) if (!id(item)) return false;
  return new Set(value).size === value.length;
}
function focus(value: unknown): value is ImportFocusV1 {
  return (
    object(value) &&
    exact(value, ["id", "field", "lineIds"]) &&
    id(value.id) &&
    FIELDS.some((field) => field === value.field) &&
    ids(value.lineIds)
  );
}
function valid(value: unknown): value is ImportChatTurnV1 {
  if (
    !object(value) ||
    !exact(value, [
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
    value.version !== 1 ||
    typeof value.turnId !== "string" ||
    !REQUEST_ID.test(value.turnId) ||
    !id(value.sessionId) ||
    typeof value.expectedRevision !== "number" ||
    !Number.isInteger(value.expectedRevision) ||
    value.expectedRevision < PRIMITIVES.minRevision ||
    value.expectedRevision > PRIMITIVES.maxRevision ||
    (value.channel !== "TEXT" && value.channel !== "VOICE") ||
    typeof value.literalAnswer !== "string" ||
    value.literalAnswer.length > 4000
  )
    return false;
  if (
    value.intent === "CONTINUE" ||
    value.intent === "OPEN_REVIEW" ||
    value.intent === "READ_RESULT"
  )
    return value.focus === null && value.scope === null;
  if (!focus(value.focus) || !object(value.scope)) return false;
  const scope = value.scope;
  if (value.intent === "ANSWER")
    return (
      (scope.kind === "LINES" &&
        exact(scope, ["kind", "lineIds"]) &&
        ids(scope.lineIds)) ||
      (scope.kind === "ATTACHMENT" &&
        exact(scope, ["kind", "attachmentId"]) &&
        id(scope.attachmentId))
    );
  return (
    value.intent === "APPROVE_ATTACHMENT_SCOPE" &&
    exact(scope, ["kind", "attachmentId", "approvedLineIds"]) &&
    scope.kind === "ATTACHMENT" &&
    id(scope.attachmentId) &&
    ids(scope.approvedLineIds)
  );
}
export function freezeImportChatValue<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const member of Object.values(value)) freezeImportChatValue(member);
    Object.freeze(value);
  }
  return value;
}
export function parseImportChatTurn(value: unknown): ImportChatTurnV1 {
  if (!valid(value)) throw invalid();
  return freezeImportChatValue(structuredClone(value));
}

/** Private in-memory lifetime only; never a Nest provider, grant or auth minter. */
export type ImportChatAdmission = Readonly<{ turn: ImportChatTurnV1 }>;
export type ImportConversationWriteBinding = Readonly<{
  admission: ImportChatAdmission;
  auth: AuthenticatedImportContext;
  operation: "EDIT" | "PREPARE";
  sessionId: string;
  expectedRevision: number;
}>;
type Entry = {
  request: object;
  auth: AuthenticatedImportContext;
  turn: ImportChatTurnV1;
  state: "PENDING" | "ACTIVE" | "RELEASED";
  admission: ImportChatAdmission | null;
  binding: ImportConversationWriteBinding | null;
  view: ImportSessionViewV1 | null;
  started: boolean;
  outcome: ImportChatOutcomeV1 | null;
};
const requests = new WeakMap<object, Entry>();
const active = new WeakMap<ImportChatAdmission, Entry>();
const toolContexts = new WeakMap<object, ImportChatAdmission>();

export function registerPendingImportChat(
  request: object,
  auth: AuthenticatedImportContext,
  turn: ImportChatTurnV1,
): void {
  assertImportAuthForRequest(request, auth);
  if (requests.has(request)) throw inactive();
  requests.set(request, {
    request,
    auth,
    turn: parseImportChatTurn(turn),
    state: "PENDING",
    admission: null,
    binding: null,
    view: null,
    started: false,
    outcome: null,
  });
}
export function activateImportChat(
  request: object,
  now: Date,
): ImportChatAdmission | null {
  const entry = requests.get(request);
  if (!entry) return null;
  if (entry.state !== "PENDING") throw inactive();
  const body: unknown = Reflect.get(request, "body");
  if (
    !object(body) ||
    canonical(parseImportChatTurn(body.importTurn)) !== canonical(entry.turn)
  )
    throw invalid();
  assertImportAuthForRequest(request, entry.auth);
  if (Date.parse(entry.auth.tokenExpiresAt) <= now.getTime()) throw inactive();
  const admission = Object.freeze({ turn: entry.turn });
  entry.state = "ACTIVE";
  entry.admission = admission;
  active.set(admission, entry);
  return admission;
}
function live(admission: ImportChatAdmission, now: Date): Entry {
  const entry = active.get(admission);
  if (
    !entry ||
    entry.state !== "ACTIVE" ||
    entry.admission !== admission ||
    Date.parse(entry.auth.tokenExpiresAt) <= now.getTime()
  )
    throw inactive();
  assertImportAuthForRequest(entry.request, entry.auth);
  const body: unknown = Reflect.get(entry.request, "body");
  if (
    !object(body) ||
    !valid(body.importTurn) ||
    canonical(body.importTurn) !== canonical(entry.turn)
  )
    throw inactive();
  return entry;
}
export function importChatAuth(
  admission: ImportChatAdmission,
  now: Date,
): AuthenticatedImportContext {
  return live(admission, now).auth;
}
export function releaseImportChat(admission: ImportChatAdmission): void {
  const entry = active.get(admission);
  if (entry) entry.state = "RELEASED";
}
export function reserveImportChatOperation(
  admission: ImportChatAdmission,
  operation: "EDIT" | "PREPARE",
  now: Date,
): ImportConversationWriteBinding {
  const entry = live(admission, now);
  if (entry.binding) throw new ImportChatContractError("TOOL_NOT_ALLOWED");
  const allowed =
    operation === "EDIT"
      ? admission.turn.intent === "ANSWER" ||
        admission.turn.intent === "APPROVE_ATTACHMENT_SCOPE"
      : admission.turn.intent === "OPEN_REVIEW";
  if (!allowed) throw new ImportChatContractError("TOOL_NOT_ALLOWED");
  entry.binding = Object.freeze({
    admission,
    auth: entry.auth,
    operation,
    sessionId: entry.turn.sessionId,
    expectedRevision: entry.turn.expectedRevision,
  });
  return entry.binding;
}
export function assertLiveImportConversationWrite(
  binding: ImportConversationWriteBinding,
  auth: AuthenticatedImportContext,
  now: Date,
): undefined {
  const entry = live(binding.admission, now);
  if (
    entry.binding !== binding ||
    binding.auth !== entry.auth ||
    auth !== entry.auth ||
    binding.sessionId !== entry.turn.sessionId ||
    binding.expectedRevision !== entry.turn.expectedRevision
  )
    throw inactive();
  return undefined;
}
export function reservedImportChatWrite(
  admission: ImportChatAdmission,
  operation: "EDIT" | "PREPARE",
  now: Date,
): ImportConversationWriteBinding {
  const binding = live(admission, now).binding;
  if (!binding || binding.operation !== operation) throw inactive();
  assertLiveImportConversationWrite(binding, binding.auth, now);
  return binding;
}
export function markImportChatStarted(
  admission: ImportChatAdmission,
  now: Date,
): void {
  live(admission, now).started = true;
}
export function importChatState(admission: ImportChatAdmission): {
  view: ImportSessionViewV1 | null;
  started: boolean;
  outcome: ImportChatOutcomeV1 | null;
} {
  const entry = active.get(admission);
  if (!entry) throw inactive();
  return { view: entry.view, started: entry.started, outcome: entry.outcome };
}
export function rememberImportChatOutcome(
  admission: ImportChatAdmission,
  outcome: ImportChatOutcomeV1,
): void {
  const entry = active.get(admission);
  if (
    !entry ||
    entry.state !== "ACTIVE" ||
    outcome.turnId !== entry.turn.turnId
  )
    throw inactive();
  entry.outcome = outcome;
}
export function rememberImportChatView(
  admission: ImportChatAdmission,
  view: ImportSessionViewV1,
  now: Date,
): void {
  live(admission, now).view = view;
}
export function bindImportChatToolContext(
  context: object,
  admission: ImportChatAdmission,
): void {
  const entry = active.get(admission);
  if (!entry || entry.state !== "ACTIVE") throw inactive();
  toolContexts.set(context, admission);
}
export function importChatForToolContext(
  context: object,
): ImportChatAdmission | null {
  return toolContexts.get(context) ?? null;
}
