import type {
  ImportSessionAmountMeaning,
  ImportSessionState,
} from "@reformaflow/domain";
import type { ImportViewRead } from "./import-session-read";

export const IMPORT_STATE_LABEL: Record<ImportSessionState, string> = {
  DRAFT: "Rascunho guardado",
  ANALYZING: "Analisando os documentos",
  NEEDS_INPUT: "Aguardando sua resposta",
  READY: "Pronta para revisar",
  CONFIRMED: "Confirmada, aplicando",
  APPLIED: "Aplicada",
  REVIEW_REQUIRED: "Precisa de nova revisão",
  CANCELLED: "Cancelada",
  EXPIRED: "Expirada",
};

export const IMPORT_AMOUNT_MEANING_LABEL: Record<
  ImportSessionAmountMeaning,
  string
> = {
  TOTAL_PURCHASE: "Total da compra",
  INSTALLMENT_CHARGE: "Valor da parcela",
  UNKNOWN: "Valor a confirmar",
};

/**
 * Recovery only ever acts on what the server lists in `actions`. Upload, resolve, prepare,
 * confirm and execute have no route yet, so they never become a control here.
 */
export function importActionGate(actions: ImportViewRead["actions"]) {
  return {
    canCancel: actions.includes("CANCEL"),
    canReadResult: actions.includes("READ_RESULT"),
  };
}
