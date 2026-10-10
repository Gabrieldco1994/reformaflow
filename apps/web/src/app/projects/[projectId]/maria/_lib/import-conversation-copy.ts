import { ApiResponseError } from "@/lib/api";
import type {
  ImportChatOutcomeV1,
  ImportClarificationReason,
} from "@reformaflow/domain";
import { ImportConversationHttpError } from "./import-conversation-read";
import { IMPORT_ERROR_COPY } from "./import-session-errors";
import { buildReceiptView, lookupNames } from "./import-receipt-view";
import type { ImportResultRead } from "./import-session-read";
import { ImportWorkflowResponseError } from "./import-session-workflow-read";

const CLARIFICATION: Record<ImportClarificationReason, string> = {
  AMBIGUOUS: "Preciso de uma resposta mais específica para esta pergunta.",
  INVALID_VALUE: "Não consegui validar esse valor. Confira a resposta.",
  MULTI_FIELD: "Responda somente ao campo desta pergunta.",
  UNSUPPORTED_NORMALIZATION:
    "Não consegui interpretar esse formato. Escreva o valor de outra forma.",
  SCOPE_REVIEW: "Confira todas as compras que receberão esta resposta.",
  INCOMPLETE_SCOPE:
    "Ainda não é possível identificar todas as compras deste anexo.",
};
const ERRORS = {
  ...IMPORT_ERROR_COPY,
  PROVIDER_UNAVAILABLE:
    "A conversa está indisponível. Você ainda pode consultar a importação.",
  MODEL_OUTPUT_INVALID:
    "Não consegui validar a interpretação. Consulte o estado atual.",
  TOOL_NOT_ALLOWED: "Esta operação não está disponível nesta conversa.",
  TURN_LIMIT:
    "Não foi possível concluir esta resposta. Consulte o estado atual.",
  INTERNAL_ERROR:
    "Não foi possível confirmar o resultado. Consulte o estado atual.",
};

export function importOutcomeCopy(outcome: ImportChatOutcomeV1): string {
  switch (outcome.kind) {
    case "CLARIFY":
      return CLARIFICATION[outcome.reason];
    case "QUESTION":
      return "Confira a pergunta atual da importação.";
    case "REVISED_SESSION":
      return outcome.acknowledgment === "EDITED"
        ? "Resposta documental guardada. Confira o rascunho atualizado."
        : "Estado da importação consultado. Nenhum lançamento foi confirmado aqui.";
    case "OPEN_REVIEW":
      return "Confira a revisão do lote antes de escolher uma ação no card.";
    case "READ_RESULT":
      return "Consultando o comprovante guardado.";
    case "ERROR":
      return ERRORS[outcome.code];
  }
}

export interface ConversationFailure {
  message: string;
  recovery: "READ_SESSION" | "READ_RESULT" | "REAUTHENTICATE" | "NONE";
  privateContextLost: boolean;
}

export function importConversationFailure(error: unknown): ConversationFailure {
  if (error instanceof ImportConversationHttpError) {
    const outcome = error.outcome;
    return {
      message: ERRORS[outcome.code],
      recovery: outcome.recovery,
      privateContextLost:
        outcome.code === "UNAUTHENTICATED" ||
        outcome.code === "NOT_FOUND" ||
        outcome.code === "UI_ACTION_REQUIRED",
    };
  }
  if (error instanceof ApiResponseError) {
    const status = error.status;
    if (status === 401)
      return {
        message: IMPORT_ERROR_COPY.UNAUTHENTICATED,
        recovery: "REAUTHENTICATE",
        privateContextLost: true,
      };
    if (status === 403 || status === 404)
      return {
        message: "Esta importação não está disponível para esta sessão.",
        recovery: "NONE",
        privateContextLost: true,
      };
    if (status === 429)
      return {
        message:
          "O limite da conversa foi atingido. Consulte a importação sem usar a IA.",
        recovery: "READ_SESSION",
        privateContextLost: false,
      };
    if (status === 409)
      return {
        message: IMPORT_ERROR_COPY.REVISION_CONFLICT,
        recovery: "READ_SESSION",
        privateContextLost: false,
      };
  }
  return {
    message:
      "Resultado não confirmado. Consulte o estado guardado antes de responder novamente.",
    recovery: "READ_SESSION",
    privateContextLost: false,
  };
}

export function importReceiptSpeech(result: ImportResultRead): string | null {
  if (result.state !== "APPLIED" || !result.receipt) return null;
  const view = buildReceiptView(
    result.receipt,
    lookupNames({ projects: [], cards: [] }),
  );
  if (!view) throw new ImportWorkflowResponseError();
  return `Comprovante consultado. Total criado: ${view.createdTotalLabel}.`;
}
