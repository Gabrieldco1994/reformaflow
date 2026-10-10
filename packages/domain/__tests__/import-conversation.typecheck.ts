import type {
  ImportChatErrorCode,
  ImportChatOutcomeV1,
  ImportChatTurnV1,
  ImportClarificationReason,
  ImportFocusV1,
  ImportScopeReviewV1,
  ImportSessionErrorCode,
  ImportSessionErrorV1,
  ImportSessionQuestionV1,
  ImportSessionRequestId,
  ImportSessionRevision,
} from '@reformaflow/domain';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
type Assert<T extends true> = T;
type KeysOfUnion<T> = T extends unknown ? keyof T : never;
type Outcome<K extends ImportChatOutcomeV1['kind']> = Extract<
  ImportChatOutcomeV1,
  { kind: K }
>;

export type PublicContract = [
  Assert<Equal<ImportChatTurnV1['version'], 1>>,
  Assert<Equal<ImportChatTurnV1['channel'], 'TEXT' | 'VOICE'>>,
  Assert<Equal<ImportChatTurnV1['turnId'], ImportSessionRequestId>>,
  Assert<Equal<ImportChatTurnV1['expectedRevision'], ImportSessionRevision>>,
  Assert<
    Equal<
      ImportChatTurnV1['intent'],
      | 'ANSWER'
      | 'APPROVE_ATTACHMENT_SCOPE'
      | 'CONTINUE'
      | 'OPEN_REVIEW'
      | 'READ_RESULT'
    >
  >,
  Assert<
    Equal<
      KeysOfUnion<ImportChatTurnV1>,
      | 'version'
      | 'turnId'
      | 'sessionId'
      | 'expectedRevision'
      | 'channel'
      | 'literalAnswer'
      | 'intent'
      | 'focus'
      | 'scope'
    >
  >,
  Assert<
    Equal<
      ImportFocusV1,
      Pick<ImportSessionQuestionV1, 'id' | 'field' | 'lineIds'>
    >
  >,
  Assert<
    Equal<
      ImportFocusV1['field'],
      | 'amountMeaning'
      | 'amountCents'
      | 'installmentCount'
      | 'dataCompra'
      | 'firstDueDate'
      | 'targets'
      | 'decision'
      | 'tipoDespesa'
      | 'categoriaMaoDeObra'
      | "merchant"
      | "installmentIndex"
    >
  >,
  Assert<
    Equal<keyof ImportScopeReviewV1, 'focus' | 'attachmentId' | 'lineIds'>
  >,
  Assert<
    Equal<
      ImportClarificationReason,
      | 'AMBIGUOUS'
      | 'INVALID_VALUE'
      | 'MULTI_FIELD'
      | 'UNSUPPORTED_NORMALIZATION'
      | 'SCOPE_REVIEW'
      | 'INCOMPLETE_SCOPE'
    >
  >,
  Assert<
    Equal<
      ImportChatErrorCode,
      | ImportSessionErrorCode
      | 'PROVIDER_UNAVAILABLE'
      | 'MODEL_OUTPUT_INVALID'
      | 'TOOL_NOT_ALLOWED'
      | 'TURN_LIMIT'
      | 'INTERNAL_ERROR'
    >
  >,
  Assert<Equal<ImportChatOutcomeV1['version'], 1>>,
  Assert<Equal<ImportChatOutcomeV1['turnId'], ImportSessionRequestId>>,
  Assert<
    Equal<
      ImportChatOutcomeV1['kind'],
      | 'CLARIFY'
      | 'QUESTION'
      | 'REVISED_SESSION'
      | 'OPEN_REVIEW'
      | 'READ_RESULT'
      | 'ERROR'
    >
  >,
  Assert<
    Equal<
      KeysOfUnion<ImportChatOutcomeV1>,
      | 'version'
      | 'turnId'
      | 'ref'
      | 'acknowledgment'
      | 'kind'
      | 'reason'
      | 'scopeReview'
      | 'questionId'
      | 'code'
      | 'retryable'
      | 'recovery'
    >
  >,
  Assert<Equal<Outcome<'CLARIFY'>['acknowledgment'], 'NONE'>>,
  Assert<Equal<Outcome<'QUESTION'>['acknowledgment'], 'NONE' | 'PREPARED'>>,
  Assert<
    Equal<
      Outcome<'REVISED_SESSION'>['acknowledgment'],
      'EDITED' | 'NO_CHANGE' | 'PREPARED' | 'NONE'
    >
  >,
  Assert<Equal<Outcome<'OPEN_REVIEW'>['acknowledgment'], 'NONE' | 'PREPARED'>>,
  Assert<Equal<Outcome<'READ_RESULT'>['acknowledgment'], 'NONE'>>,
  Assert<Equal<Outcome<'ERROR'>['acknowledgment'], 'NONE' | 'UNKNOWN'>>,
  Assert<Equal<Outcome<'ERROR'>['reason'], ImportSessionErrorV1['reason']>>,
  Assert<
    Equal<
      Outcome<'ERROR'>['recovery'],
      'READ_SESSION' | 'READ_RESULT' | 'REAUTHENTICATE' | 'NONE'
    >
  >,
];

const focus = {
  id: 'q1',
  field: 'amountCents',
  lineIds: ['l1'],
} satisfies ImportFocusV1;
const scopeReview = {
  focus,
  attachmentId: 'a1',
  lineIds: ['l1', 'l2'],
} satisfies ImportScopeReviewV1;
const turn = {
  version: 1,
  turnId: '10000000-0000-4000-8000-000000000001',
  sessionId: 's1',
  expectedRevision: 7,
  channel: 'TEXT',
  literalAnswer: '206,96',
} as const;
const answer = {
  ...turn,
  intent: 'ANSWER',
  focus,
  scope: { kind: 'LINES', lineIds: ['l1'] },
} satisfies ImportChatTurnV1;
const review = {
  ...turn,
  intent: 'OPEN_REVIEW',
  focus: null,
  scope: null,
} satisfies ImportChatTurnV1;

export const validTurns = [
  answer,
  { ...answer, channel: 'VOICE' },
  { ...answer, scope: { kind: 'ATTACHMENT', attachmentId: 'a1' } },
  {
    ...turn,
    intent: 'APPROVE_ATTACHMENT_SCOPE',
    focus,
    scope: {
      kind: 'ATTACHMENT',
      attachmentId: 'a1',
      approvedLineIds: ['l1', 'l2'],
    },
  },
  { ...review, intent: 'CONTINUE' },
  review,
  { ...review, intent: 'READ_RESULT' },
] satisfies ImportChatTurnV1[];

const outcome = {
  version: 1,
  turnId: turn.turnId,
  ref: { sessionId: 's1', revision: 7 },
} as const;
const error = {
  ...outcome,
  kind: 'ERROR',
  code: 'INTERNAL_ERROR',
  reason: null,
  retryable: false,
  acknowledgment: 'NONE',
  recovery: 'NONE',
} satisfies ImportChatOutcomeV1;

export const validOutcomes = [
  {
    ...outcome,
    kind: 'CLARIFY',
    acknowledgment: 'NONE',
    reason: 'AMBIGUOUS',
    scopeReview: null,
  },
  {
    ...outcome,
    kind: 'CLARIFY',
    acknowledgment: 'NONE',
    reason: 'SCOPE_REVIEW',
    scopeReview,
  },
  { ...outcome, kind: 'QUESTION', acknowledgment: 'NONE', questionId: 'q1' },
  {
    ...outcome,
    kind: 'QUESTION',
    acknowledgment: 'PREPARED',
    questionId: 'q1',
  },
  { ...outcome, kind: 'REVISED_SESSION', acknowledgment: 'EDITED' },
  { ...outcome, kind: 'REVISED_SESSION', acknowledgment: 'NO_CHANGE' },
  { ...outcome, kind: 'REVISED_SESSION', acknowledgment: 'PREPARED' },
  { ...outcome, kind: 'REVISED_SESSION', acknowledgment: 'NONE' },
  { ...outcome, kind: 'OPEN_REVIEW', acknowledgment: 'NONE' },
  { ...outcome, kind: 'OPEN_REVIEW', acknowledgment: 'PREPARED' },
  { ...outcome, kind: 'READ_RESULT', acknowledgment: 'NONE' },
  error,
  { ...error, acknowledgment: 'UNKNOWN', recovery: 'READ_SESSION' },
  { ...error, acknowledgment: 'UNKNOWN', recovery: 'READ_RESULT' },
  { ...error, acknowledgment: 'UNKNOWN', recovery: 'REAUTHENTICATE' },
  { ...error, code: 'UNAUTHENTICATED', ref: null, recovery: 'REAUTHENTICATE' },
  { ...error, code: 'UI_ACTION_REQUIRED', ref: null },
  { ...error, code: 'NOT_FOUND', ref: null },
] satisfies ImportChatOutcomeV1[];

const reviewWithFocus = { ...review, focus };
// @ts-expect-error TYPE: explicit review cannot carry an answer focus.
export const rejectedReviewFocus: ImportChatTurnV1 = reviewWithFocus;
const reviewWithScope = { ...review, scope: answer.scope };
// @ts-expect-error TYPE: review is not a scoped answer.
export const rejectedReviewScope: ImportChatTurnV1 = reviewWithScope;
const answerWithoutFocus = { ...answer, focus: null };
// @ts-expect-error TYPE: an answer requires its structured focus.
export const rejectedAnswerFocus: ImportChatTurnV1 = answerWithoutFocus;
const approvalWithoutLines = {
  ...answer,
  intent: 'APPROVE_ATTACHMENT_SCOPE' as const,
  scope: { kind: 'ATTACHMENT' as const, attachmentId: 'a1' },
};
// @ts-expect-error TYPE: collective approval requires the exact presented IDs.
export const rejectedApproval: ImportChatTurnV1 = approvalWithoutLines;
const versionTwo = { ...answer, version: 2 };
// @ts-expect-error TYPE: only wire version 1 is specified.
export const rejectedVersion: ImportChatTurnV1 = versionTwo;
const nullableTurn = { ...answer, turnId: null };
// @ts-expect-error TYPE: a turn ID is required, not nullable.
export const rejectedTurnId: ImportChatTurnV1 = nullableTurn;
const { turnId: omittedTurnId, ...missingTurnId } = answer;
void omittedTurnId;
// @ts-expect-error TYPE: omission is not a correlation ID.
export const rejectedMissingTurnId: ImportChatTurnV1 = missingTurnId;

const editedError = { ...error, acknowledgment: 'EDITED' as const };
// @ts-expect-error TYPE: an ERROR must never acknowledge a committed edit.
export const rejectedEditedError: ImportChatOutcomeV1 = editedError;
const preparedError = { ...error, acknowledgment: 'PREPARED' as const };
// @ts-expect-error TYPE: an ERROR must never acknowledge preparation.
export const rejectedPreparedError: ImportChatOutcomeV1 = preparedError;
const nullableOutcome = { ...error, turnId: null };
// @ts-expect-error TYPE: admitted outcomes always have a non-null turn ID.
export const rejectedOutcomeId: ImportChatOutcomeV1 = nullableOutcome;
const { turnId: omittedOutcomeId, ...missingOutcomeId } = error;
void omittedOutcomeId;
// @ts-expect-error TYPE: admitted outcomes cannot omit correlation.
export const rejectedMissingOutcomeId: ImportChatOutcomeV1 = missingOutcomeId;
const unknownWithoutRecovery = { ...error, acknowledgment: 'UNKNOWN' as const };
// @ts-expect-error TYPE: UNKNOWN requires a recovery action.
export const rejectedUnknown: ImportChatOutcomeV1 = unknownWithoutRecovery;

const unauthorizedRef = { ...error, code: 'UNAUTHENTICATED' as const };
// @ts-expect-error TYPE: unauthenticated outcomes cannot expose a session ref.
export const rejectedUnauthorizedRef: ImportChatOutcomeV1 = unauthorizedRef;
const uiRequiredRef = { ...error, code: 'UI_ACTION_REQUIRED' as const };
// @ts-expect-error TYPE: missing UI admission cannot expose a session ref.
export const rejectedUiRequiredRef: ImportChatOutcomeV1 = uiRequiredRef;
const opaqueNotFoundRef = { ...error, code: 'NOT_FOUND' as const };
// @ts-expect-error TYPE: opaque not-found outcomes cannot expose a session ref.
export const rejectedNotFoundRef: ImportChatOutcomeV1 = opaqueNotFoundRef;
const privateUnknown = {
  ...error,
  code: 'NOT_FOUND' as const,
  ref: null,
  acknowledgment: 'UNKNOWN' as const,
  recovery: 'READ_SESSION' as const,
};
// @ts-expect-error TYPE: privacy errors require acknowledgment NONE.
export const rejectedPrivateUnknown: ImportChatOutcomeV1 = privateUnknown;
const unreferencedReview = {
  ...outcome,
  kind: 'OPEN_REVIEW' as const,
  acknowledgment: 'NONE' as const,
  ref: null,
};
// @ts-expect-error TYPE: non-error outcomes require a session reference.
export const rejectedUnreferencedReview: ImportChatOutcomeV1 =
  unreferencedReview;
const missingScopeReview = {
  ...outcome,
  kind: 'CLARIFY' as const,
  acknowledgment: 'NONE' as const,
  reason: 'SCOPE_REVIEW' as const,
  scopeReview: null,
};
// @ts-expect-error TYPE: scope review requires the proposed collective scope.
export const rejectedMissingScopeReview: ImportChatOutcomeV1 =
  missingScopeReview;
const unrelatedScopeReview = {
  ...missingScopeReview,
  reason: 'AMBIGUOUS' as const,
  scopeReview,
};
// @ts-expect-error TYPE: only SCOPE_REVIEW carries collective-scope review data.
export const rejectedUnrelatedScopeReview: ImportChatOutcomeV1 =
  unrelatedScopeReview;

// @ts-expect-error TYPE: admission authority is not a public domain export.
export type { ImportChatAdmission } from '@reformaflow/domain';
// @ts-expect-error TYPE: writer bindings are server-only.
export type { ImportConversationWriteBinding } from '@reformaflow/domain';
// @ts-expect-error TYPE: model projections are not UI wire exports.
export type { ImportModelRead } from '@reformaflow/domain';
// @ts-expect-error TYPE: model interpretations are not UI wire exports.
export type { ImportAnswerInterpretationV1 } from '@reformaflow/domain';
