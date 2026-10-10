export type {
  RefundPurposeAction,
  RefundPurposeRequest,
  RefundPurposeResponse,
  RefundPurposeStateResponse,
  RefundPurposeSummary,
  UndoRefundPurposeRequest,
  UndoRefundPurposeResponse,
} from "@reformaflow/domain";

export interface ExpenseDeleteCapability {
  /** HTTP output only; DELETE always reauthorizes. Absent on ordinary positive rows. */
  canDelete?: boolean;
}
