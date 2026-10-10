import type { ExpenseType } from "../enums";

export type RefundPurposeRequest =
  | { mode: "preview"; targetProjectId: string; roomId: string | null }
  | {
      mode: "apply";
      targetProjectId: string;
      roomId: string | null;
      expectedRevision: number;
      expectedFingerprint: string;
    };

export interface RefundPurposeSummary {
  sourceExpenseId: string;
  targetProjectId: string;
  roomId: string | null;
  tipoDespesa: ExpenseType;
  allocationCents: number;
  dataCompra: string | null;
  dataPagamento: string;
  cashFlowDate: string;
  cardId: string;
  importId: string;
}

export type RefundPurposeResponse =
  | {
      mode: "preview";
      revision: number;
      fingerprint: string;
      summary: RefundPurposeSummary;
    }
  | {
      mode: "apply";
      revision: number;
      fingerprint: string;
      summary: RefundPurposeSummary;
      targetExpenseId: string;
      alreadyApplied: boolean;
    };

export interface UndoRefundPurposeRequest {
  expectedRevision: number;
}

export interface UndoRefundPurposeResponse {
  revision: number;
  alreadyUndone: boolean;
}

/** Actions the reader offers; `PREPARE` is necessary, never sufficient (the preview may still refuse). */
export type RefundPurposeAction = "PREPARE" | "UNDO";

/** Exact public shape of `GET /projects/:projectId/expenses/:id/refund-purpose`. */
export interface RefundPurposeStateResponse {
  sourceExpenseId: string;
  assignment: { revision: number; summary: RefundPurposeSummary } | null;
  actions: RefundPurposeAction[];
}
