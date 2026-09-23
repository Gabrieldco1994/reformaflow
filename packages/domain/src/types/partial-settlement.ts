export type SettlementStatus = "UNPAID" | "PARTIAL" | "PAID";
export interface AdditiveSettlementCommand {
  mode: "ADDITIVE";
  targetExpenseId: string;
  parcelaIndex: number;
  amountCents: number;
  requestId: string;
}
export interface InstallmentSettlementContribution {
  settlementId: string;
  amountCents: number;
  paymentDate: string;
}
export interface InstallmentSettlementSummary {
  parcelaIndex: number;
  dueDate: string;
  contractedCents: number;
  paidCents: number;
  remainingCents: number;
  settlementStatus: SettlementStatus;
  contributions?: InstallmentSettlementContribution[];
}
export interface AdditiveSettlementResult {
  ok: true;
  settlementId: string;
  state: "ACTIVE" | "REVERSED";
  replayed: boolean;
  sourceId: string;
  targetId: string;
  parcelaIndex: number;
  amountCents: number;
  contractedCents: number;
  paidCents: number;
  remainingCents: number;
  sourceAvailableCents: number;
  settlementStatus: SettlementStatus;
}
