import type {
  ImportSessionFocusedDraftAnswerV1,
  ImportSessionFocusedDraftAnswerRequestV1,
} from "@reformaflow/domain";

/** Temporary exact extension until the backend domain union is integrated. */
export type FocusedDraftAnswer =
  | ImportSessionFocusedDraftAnswerV1
  | {
      field: "decision";
      value: { kind: "CREATE"; acceptNaturalDuplicate: false };
    }
  | { field: "targets"; value: [] };

export type FocusedDraftAnswerRequest = Omit<
  ImportSessionFocusedDraftAnswerRequestV1,
  "answer"
> & {
  answer: FocusedDraftAnswer;
};
