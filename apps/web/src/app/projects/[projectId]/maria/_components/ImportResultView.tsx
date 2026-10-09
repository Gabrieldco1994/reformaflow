"use client";

import { useMemo } from "react";
import { useImportCatalog } from "../_hooks/useImportCatalog";
import { useImportResult } from "../_hooks/useImportSessions";
import { buildReceiptView } from "../_lib/import-receipt-view";
import { describeImportFailure } from "../_lib/import-session-errors";
import { ImportFailureNotice, noticeFromInfo } from "./ImportFailureNotice";
import { ImportReceipt } from "./ImportReceipt";

const AFTER_APPLIED =
  "Esta importação já foi aplicada. Não foi possível abrir o comprovante agora.";

export function ImportResultView({
  userId,
  sessionId,
  afterApplied = false,
  onOpenSession,
}: {
  userId: string;
  sessionId: string;
  /** Reached from a cancel that answered ALREADY_APPLIED: the receipt may still be unreadable. */
  afterApplied?: boolean;
  onOpenSession: (sessionId: string) => void;
}) {
  const read = useImportResult(userId, sessionId);
  const { names } = useImportCatalog(userId, read.status === "ready");
  const receiptView = useMemo(
    () =>
      read.result?.receipt
        ? buildReceiptView(read.result.receipt, names)
        : null,
    [read.result, names],
  );

  if (read.status === "loading" || read.status === "disabled") {
    return (
      <p role="status" className="text-[14px] text-lifeone-ink-3">
        Carregando comprovante…
      </p>
    );
  }
  if (read.status === "error" && read.failure) {
    const info = describeImportFailure(read.failure, "result");
    if (afterApplied) {
      return (
        <ImportFailureNotice
          message={AFTER_APPLIED}
          actionLabel={info.retryable ? "Tentar de novo" : undefined}
          onAction={info.retryable ? () => void read.retry() : undefined}
        />
      );
    }
    return noticeFromInfo(info, () => void read.retry());
  }
  if (!read.result?.receipt) {
    return (
      <ImportFailureNotice message="Esta importação ainda não tem comprovante." />
    );
  }
  if (!receiptView) {
    return (
      <ImportFailureNotice
        message="Não foi possível exibir este comprovante."
        actionLabel="Tentar de novo"
        onAction={() => void read.retry()}
      />
    );
  }
  return (
    <div className="space-y-3">
      {read.freshness === "stale" && (
        <ImportFailureNotice
          message="Não foi possível atualizar. O que aparece pode estar desatualizado."
          actionLabel="Tentar de novo"
          onAction={() => void read.retry()}
        />
      )}
      <ImportReceipt view={receiptView} onOpenContinuation={onOpenSession} />
    </div>
  );
}
