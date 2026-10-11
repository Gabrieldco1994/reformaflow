import type {
  ExpenseType,
  ImportChatChannel,
  ImportSessionAmountMeaning,
  ImportSessionTargetInputV1,
  LaborCategory,
} from "@reformaflow/domain";

/**
 * Browser-owned discriminant for the server's focused draft endpoint.
 * Every variant changes only the question field named by `field`.
 */
export type FocusedDraftAnswer =
  | { field: "amountMeaning"; value: ImportSessionAmountMeaning }
  | { field: "amountCents"; value: number | null }
  | { field: "installmentCount"; value: number | null }
  | { field: "dataCompra"; value: string | null }
  | { field: "firstDueDate"; value: string | null }
  | { field: "tipoDespesa"; value: ExpenseType | null }
  | { field: "categoriaMaoDeObra"; value: LaborCategory | null }
  | {
      field: "decision";
      value:
        | { kind: "CREATE"; acceptNaturalDuplicate: boolean }
        | { kind: "KEEP_EXISTING"; expenseId: string };
    }
  | { field: "targets"; value: ImportSessionTargetInputV1[] };

export interface FocusedDraftAnswerRequest {
  version: 1;
  answerRequestId: string;
  expectedRevision: number;
  questionId: string;
  channel: ImportChatChannel;
  answer: FocusedDraftAnswer;
}
