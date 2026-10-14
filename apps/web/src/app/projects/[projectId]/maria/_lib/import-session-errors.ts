import { ApiResponseError, ApiTimeoutError } from "@/lib/api";
import type {
  ImportSessionErrorCode,
  ImportSessionErrorV1,
} from "@reformaflow/domain";

/** Exact future wire boundary until the independently owned domain is integrated. */
export type PdfDocumentErrorCode =
  | "OCR_REQUIRED"
  | "OCR_UNAVAILABLE"
  | "OCR_SAFETY_BLOCKED"
  | "OCR_MALFORMED_RESPONSE"
  | "OCR_ATTEMPT_UNKNOWN"
  | "OCR_BUDGET_EXHAUSTED"
  | "DOCUMENT_UNREADABLE"
  | "PDF_PASSWORD_REQUIRED"
  | "UNSUPPORTED_DOCUMENT";
export type ImportWireErrorCode = ImportSessionErrorCode | PdfDocumentErrorCode;
export type ImportWireError = Omit<ImportSessionErrorV1, "code"> & {
  code: ImportWireErrorCode;
};

export function isPdfDocumentErrorCode(
  value: unknown,
): value is PdfDocumentErrorCode {
  return (
    value === "OCR_REQUIRED" ||
    value === "OCR_UNAVAILABLE" ||
    value === "OCR_SAFETY_BLOCKED" ||
    value === "OCR_MALFORMED_RESPONSE" ||
    value === "OCR_ATTEMPT_UNKNOWN" ||
    value === "OCR_BUDGET_EXHAUSTED" ||
    value === "DOCUMENT_UNREADABLE" ||
    value === "PDF_PASSWORD_REQUIRED" ||
    value === "UNSUPPORTED_DOCUMENT"
  );
}

export type ImportFailureContext =
  | "list"
  | "detail"
  | "result"
  | "cancel"
  | "document";

export type ImportFailure =
  | { kind: "api"; status: number; error: ImportWireError }
  /** An HTTP answer that is not a valid ImportSessionErrorV1: generic 404/500, extra-key 400… */
  | { kind: "http"; status: number }
  | { kind: "offline" }
  | { kind: "timeout" }
  | { kind: "malformed" }
  | { kind: "unknown" };

/** Fixed copy per wire code. The server never sends a message and none is ever rendered. */
export const IMPORT_ERROR_COPY: Record<ImportWireErrorCode, string> = {
  OCR_REQUIRED:
    "A análise local não pôde continuar sem leitura externa. Se o servidor confirmar que este documento é elegível, a tela poderá oferecer uma autorização separada somente para ele. PDFs textuais permanecem locais; PDFs mistos ou pesquisáveis não são enviados nesta versão. Sem essa oferta ou disponibilidade, use um PDF textual ou CSV, conforme os formatos oferecidos, ou cancele a importação.",
  OCR_UNAVAILABLE:
    "A falha aconteceu antes de o PDF ser enviado. Use entrada manual, substitua o documento ou cancele a importação.",
  OCR_SAFETY_BLOCKED:
    "O provedor bloqueou a leitura deste documento por segurança. Nenhum lançamento foi criado; use entrada manual, substitua o documento ou cancele a importação.",
  OCR_MALFORMED_RESPONSE:
    "O provedor devolveu uma leitura inválida. Nenhum lançamento foi criado; use entrada manual, substitua o documento ou cancele a importação.",
  OCR_ATTEMPT_UNKNOWN:
    "O envio começou ou pode ter ocorrido, mas não foi possível confirmar o resultado do OCR. Esta tentativa não pode ser repetida. Nenhum lançamento foi criado; use entrada manual, substitua o documento ou cancele a importação.",
  OCR_BUDGET_EXHAUSTED:
    "O limite diário de OCR foi atingido antes do envio. Use entrada manual, substitua o documento ou cancele a importação.",
  DOCUMENT_UNREADABLE:
    "Não foi possível ler este documento. Substitua por um arquivo legível ou cancele a importação.",
  PDF_PASSWORD_REQUIRED:
    "Este PDF está protegido por senha. Substitua por uma cópia sem senha ou cancele a importação. Não envie sua senha à Maria.",
  INVALID_INPUT:
    "Não foi possível concluir esta consulta. Volte à lista e tente de novo.",
  UNAUTHENTICATED: "Sua sessão expirou. Entre de novo para continuar.",
  NOT_FOUND:
    "Não encontramos esta importação. Volte à lista e confira as disponíveis.",
  UI_ACTION_REQUIRED:
    "Esta ação precisa ser feita pelo aplicativo. Recarregue a página e tente de novo.",
  REVISION_CONFLICT:
    "Esta importação mudou enquanto você a via. Confira o estado atual antes de agir.",
  IDEMPOTENCY_CONFLICT:
    "Esta solicitação já foi usada com outros dados. Volte à lista e confira o estado atual.",
  STALE_PREVIEW:
    "A prévia ficou desatualizada. Confira o estado atual da importação.",
  REVIEW_REQUIRED:
    "Esta importação precisa de uma nova revisão antes de seguir.",
  SEARCH_TOO_BROAD: "A busca ficou ampla demais para esta importação.",
  LIMIT_EXCEEDED: "Esta importação passou de um limite permitido.",
  UNSUPPORTED_DOCUMENT: "Um dos documentos desta importação não é suportado.",
  LEASE_CONFLICT:
    "Esta importação está em uso agora. Tente de novo em instantes.",
  RETRYABLE_WRITE_CONFLICT:
    "O servidor está ocupado. Tente de novo em instantes.",
  CAPABILITY_DISABLED:
    "A importação pela Maria está indisponível no momento. Suas importações continuam guardadas.",
  SESSION_EXPIRED: "Esta importação expirou e não pode mais ser retomada.",
  ALREADY_APPLIED:
    "Esta importação já foi aplicada e não pode mais ser cancelada.",
};

const WIRE_KEYS = [
  "code",
  "currentRevision",
  "reason",
  "retryable",
  "sessionId",
];
const REASONS = new Set(["ATTACHMENT_IN_FLIGHT", "WRITE_BUDGET_EXCEEDED"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Exact-shape guard: an extra key means the body is not ours, so nothing in it is trusted. */
export function isImportSessionErrorBody(
  value: unknown,
): value is ImportWireError {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== WIRE_KEYS.length ||
    keys.some((key, index) => key !== WIRE_KEYS[index])
  )
    return false;
  return (
    typeof value.code === "string" &&
    Object.prototype.hasOwnProperty.call(IMPORT_ERROR_COPY, value.code) &&
    typeof value.retryable === "boolean" &&
    (value.sessionId === null || typeof value.sessionId === "string") &&
    (value.currentRevision === null ||
      Number.isInteger(value.currentRevision)) &&
    (value.reason === null ||
      (typeof value.reason === "string" && REASONS.has(value.reason)))
  );
}

export function classifyImportFailure(
  error: unknown,
  online: boolean = typeof navigator === "undefined" ? true : navigator.onLine,
): ImportFailure {
  if (!online) return { kind: "offline" };
  if (error instanceof ApiTimeoutError) return { kind: "timeout" };
  if (error instanceof ApiResponseError) {
    return isImportSessionErrorBody(error.body)
      ? { kind: "api", status: error.status, error: error.body }
      : { kind: "http", status: error.status };
  }
  if (error instanceof TypeError) return { kind: "offline" };
  if (error instanceof Error && error.name === "ImportMalformedResponseError")
    return { kind: "malformed" };
  return { kind: "unknown" };
}

export interface ImportFailureInfo {
  message: string;
  /** Repeating the same request may help. Never true for a definitive 4xx. */
  retryable: boolean;
  /** A documentary write or cancellation may or may not have taken effect. */
  outcomeUnknown: boolean;
  code: ImportWireErrorCode | null;
}

export interface ImportWorkflowFailure {
  message: string;
  recovery: "READ_SESSION" | "READ_RESULT" | "REAUTHENTICATE" | "NONE";
  privateContextLost: boolean;
}

export function importWorkflowFailure(error: unknown): ImportWorkflowFailure {
  if (error instanceof ApiResponseError) {
    if (error.status === 401)
      return {
        message: IMPORT_ERROR_COPY.UNAUTHENTICATED,
        recovery: "REAUTHENTICATE",
        privateContextLost: true,
      };
    if (error.status === 403 || error.status === 404)
      return {
        message: "Esta importação não está disponível para esta sessão.",
        recovery: "NONE",
        privateContextLost: true,
      };
    if (error.status === 429)
      return {
        message:
          "O limite de consultas foi atingido. Consulte o estado guardado.",
        recovery: "READ_SESSION",
        privateContextLost: false,
      };
    if (error.status === 409)
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

const OFFLINE =
  "Sem conexão com o servidor. Verifique sua internet e tente de novo.";
const TIMEOUT = "O servidor demorou para responder. Tente de novo.";
const SERVER =
  "Não foi possível consultar as importações agora. Tente de novo.";
const NOT_FOUND =
  "Não encontramos esta importação. Volte à lista e confira as disponíveis.";
const UNEXPECTED =
  "Recebemos uma resposta inesperada do servidor. Tente de novo.";
const CANCEL_UNKNOWN =
  "Não foi possível confirmar o cancelamento. Atualize a lista e confira o estado atual antes de tentar de novo.";

export function describeImportFailure(
  failure: ImportFailure,
  context: ImportFailureContext,
): ImportFailureInfo {
  if (context === "document") {
    if (failure.kind === "api") {
      return {
        message: isPdfDocumentErrorCode(failure.error.code)
          ? IMPORT_ERROR_COPY[failure.error.code]
          : `${IMPORT_ERROR_COPY[failure.error.code]} Consulte o estado guardado antes de tentar a análise novamente.`,
        retryable: false,
        outcomeUnknown: false,
        code: failure.error.code,
      };
    }
    return {
      message:
        "Não foi possível confirmar a análise documental. Consulte o estado guardado antes de tentar novamente. Nenhum lançamento financeiro foi confirmado aqui.",
      retryable: false,
      outcomeUnknown: true,
      code: null,
    };
  }
  const cancel = context === "cancel";
  switch (failure.kind) {
    case "api":
      return {
        message: IMPORT_ERROR_COPY[failure.error.code],
        retryable:
          !isPdfDocumentErrorCode(failure.error.code) &&
          failure.error.retryable,
        outcomeUnknown: false,
        code: failure.error.code,
      };
    case "offline":
      return {
        message: cancel ? CANCEL_UNKNOWN : OFFLINE,
        retryable: true,
        outcomeUnknown: cancel,
        code: null,
      };
    case "timeout":
      return {
        message: cancel ? CANCEL_UNKNOWN : TIMEOUT,
        retryable: true,
        outcomeUnknown: cancel,
        code: null,
      };
    case "malformed":
      return {
        message: UNEXPECTED,
        retryable: true,
        outcomeUnknown: cancel,
        code: null,
      };
    case "http":
      if (failure.status === 404) {
        return {
          message: NOT_FOUND,
          retryable: false,
          outcomeUnknown: false,
          code: null,
        };
      }
      if (failure.status >= 500) {
        return {
          message: cancel ? CANCEL_UNKNOWN : SERVER,
          retryable: true,
          outcomeUnknown: cancel,
          code: null,
        };
      }
      return {
        message: IMPORT_ERROR_COPY.INVALID_INPUT,
        retryable: false,
        outcomeUnknown: false,
        code: null,
      };
    default:
      return {
        message: cancel ? CANCEL_UNKNOWN : SERVER,
        retryable: true,
        outcomeUnknown: cancel,
        code: null,
      };
  }
}
