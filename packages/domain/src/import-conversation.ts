import type {
  IMPORT_SESSION_PROTOCOL_VERSION,
  ImportSessionErrorV1,
  ImportSessionId,
  ImportSessionDraftQuestionV1,
  ImportObservationQuestionV1,
  ImportSessionQuestionV1,
  ImportSessionRequestId,
  ImportSessionRevision,
  ImportChatChannel,
} from "./import-session";

export function isPendingImportQuestion(
  question: ImportSessionDraftQuestionV1 | ImportObservationQuestionV1,
): boolean {
  return !("subject" in question) || question.answerState === "UNANSWERED";
}

export type ImportFocusV1 = Pick<
  ImportSessionQuestionV1,
  "id" | "field" | "lineIds"
>;

/** UI wire only: references are not authority or runtime input validation. */
export type ImportChatTurnV1 = {
  version: typeof IMPORT_SESSION_PROTOCOL_VERSION;
  turnId: ImportSessionRequestId;
  sessionId: ImportSessionId;
  expectedRevision: ImportSessionRevision;
  channel: ImportChatChannel;
  literalAnswer: string;
} & (
  | {
      intent: "ANSWER";
      focus: ImportFocusV1;
      scope:
        | { kind: "LINES"; lineIds: ImportSessionId[] }
        | { kind: "ATTACHMENT"; attachmentId: ImportSessionId };
    }
  | {
      intent: "APPROVE_ATTACHMENT_SCOPE";
      focus: ImportFocusV1;
      scope: {
        kind: "ATTACHMENT";
        attachmentId: ImportSessionId;
        approvedLineIds: ImportSessionId[];
      };
    }
  | {
      intent: "CONTINUE" | "OPEN_REVIEW" | "READ_RESULT";
      focus: null;
      scope: null;
    }
);

export type ImportScopeReviewV1 = {
  focus: ImportFocusV1;
  attachmentId: ImportSessionId;
  lineIds: ImportSessionId[];
};

export type ImportClarificationReason =
  | "AMBIGUOUS"
  | "INVALID_VALUE"
  | "MULTI_FIELD"
  | "UNSUPPORTED_NORMALIZATION"
  | "SCOPE_REVIEW"
  | "INCOMPLETE_SCOPE";

export type ImportChatErrorCode =
  | ImportSessionErrorV1["code"]
  | "PROVIDER_UNAVAILABLE"
  | "MODEL_OUTPUT_INVALID"
  | "TOOL_NOT_ALLOWED"
  | "TURN_LIMIT"
  | "INTERNAL_ERROR";

type ImportChatRefV1 = {
  sessionId: ImportSessionId;
  revision: ImportSessionRevision;
};

type ImportChatRecoveryV1 =
  | "READ_SESSION"
  | "READ_RESULT"
  | "REAUTHENTICATE"
  | "NONE";

type OpaqueImportChatErrorCode =
  | "UNAUTHENTICATED"
  | "UI_ACTION_REQUIRED"
  | "NOT_FOUND";

type ImportChatErrorOutcomeV1 = {
  kind: "ERROR";
  reason: ImportSessionErrorV1["reason"];
  retryable: boolean;
} & (
  | {
      code: OpaqueImportChatErrorCode;
      ref: null;
      acknowledgment: "NONE";
      recovery: ImportChatRecoveryV1;
    }
  | ({
      code: Exclude<ImportChatErrorCode, OpaqueImportChatErrorCode>;
      ref: ImportChatRefV1 | null;
    } & (
      | { acknowledgment: "NONE"; recovery: ImportChatRecoveryV1 }
      | {
          acknowledgment: "UNKNOWN";
          recovery: Exclude<ImportChatRecoveryV1, "NONE">;
        }
    ))
);

/** Admitted outcomes only; pre-admission HTTP errors need not carry an outcome. */
export type ImportChatOutcomeV1 = {
  version: typeof IMPORT_SESSION_PROTOCOL_VERSION;
  turnId: ImportSessionRequestId;
} & (
  | ({ ref: ImportChatRefV1 } & (
      | ({
          kind: "CLARIFY";
          acknowledgment: "NONE";
        } & (
          | {
              reason: "SCOPE_REVIEW";
              scopeReview: ImportScopeReviewV1;
            }
          | {
              reason: Exclude<ImportClarificationReason, "SCOPE_REVIEW">;
              scopeReview: null;
            }
        ))
      | {
          kind: "QUESTION";
          acknowledgment: "NONE" | "PREPARED";
          questionId: ImportSessionId;
        }
      | {
          kind: "REVISED_SESSION";
          acknowledgment: "EDITED" | "NO_CHANGE" | "PREPARED" | "NONE";
        }
      | {
          kind: "OPEN_REVIEW";
          acknowledgment: "NONE" | "PREPARED";
        }
      | {
          kind: "READ_RESULT";
          acknowledgment: "NONE";
        }
    ))
  | ImportChatErrorOutcomeV1
);
