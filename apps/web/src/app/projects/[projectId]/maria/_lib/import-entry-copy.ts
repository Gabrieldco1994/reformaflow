import type { ImportUnavailableReason } from "./import-session-read";

export interface ImportUnavailableCopy {
  message: string;
  canRetry: boolean;
}

export const IMPORT_UNAVAILABLE_COPY = {
  NOT_ENABLED: {
    message:
      "Novas importações pela Maria não estão habilitadas neste momento.",
    canRetry: false,
  },
  RUNTIME_UNAVAILABLE: {
    message:
      "A consulta de novas importações está temporariamente indisponível.",
    canRetry: true,
  },
  NO_QUALIFIED_FORMAT: {
    message:
      "Nenhum formato de fatura está qualificado para uma nova importação.",
    canRetry: false,
  },
} as const satisfies Record<ImportUnavailableReason, ImportUnavailableCopy>;
