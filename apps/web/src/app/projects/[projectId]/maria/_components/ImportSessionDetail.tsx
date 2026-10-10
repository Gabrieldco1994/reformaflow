"use client";

import { useState } from "react";
import { useImportCatalog } from "../_hooks/useImportCatalog";
import { useIntentFocus } from "../_hooks/useIntentFocus";
import {
  useCancelImportSession,
  useImportSession,
} from "../_hooks/useImportSessions";
import { importActionGate } from "../_lib/import-session-copy";
import {
  describeImportFailure,
  type ImportFailureInfo,
} from "../_lib/import-session-errors";
import { ImportFailureNotice, noticeFromInfo } from "./ImportFailureNotice";
import { ImportSessionBody } from "./ImportSessionBody";

type Notice =
  | { kind: "status"; text: string }
  | { kind: "failure"; info: ImportFailureInfo };

const BUTTON =
  "inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl border px-4 text-[14px] font-semibold disabled:opacity-60";

export function ImportSessionDetail({
  userId,
  sessionId,
  onOpenResult,
  onContinue,
}: {
  userId: string;
  sessionId: string;
  onOpenResult: (sessionId: string, afterApplied: boolean) => void;
  onContinue?: (sessionId: string) => void;
}) {
  const read = useImportSession(userId, sessionId);
  const { names } = useImportCatalog(userId, read.status === "ready");
  const { cancel } = useCancelImportSession(userId);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const { scope: focusScope, request: requestFocus } = useIntentFocus();

  if (read.status === "loading" || read.status === "disabled") {
    return (
      <p role="status" className="text-[14px] text-lifeone-ink-3">
        Carregando importação…
      </p>
    );
  }
  if (read.status === "error" && read.failure) {
    return noticeFromInfo(
      describeImportFailure(read.failure, "detail"),
      () => void read.retry(),
    );
  }
  const view = read.view;
  if (!view) return null;

  const gate = importActionGate(view.actions);
  const fresh = read.freshness === "fresh";

  async function confirmCancel() {
    if (!view || sending) return;
    setSending(true);
    setNotice(null);
    const outcome = await cancel(view.id, view.revision);
    setSending(false);
    switch (outcome.kind) {
      case "cancelled":
        requestFocus(["notice"]);
        setConfirming(false);
        setNotice({ kind: "status", text: "Importação cancelada." });
        break;
      case "conflict":
        requestFocus(["notice"]);
        setConfirming(false);
        setNotice({
          kind: "status",
          text: "Esta importação mudou. Mostramos o estado atual antes de qualquer nova ação.",
        });
        break;
      case "already-applied":
        onOpenResult(view.id, true);
        break;
      case "failed":
        requestFocus(["notice"]);
        setConfirming(false);
        setNotice({ kind: "failure", info: outcome.info });
        break;
      case "busy":
        break;
    }
  }

  return (
    <div ref={focusScope} className="space-y-4">
      {read.freshness === "refreshing" && (
        <p role="status" className="text-[13px] text-lifeone-ink-3">
          Atualizando…
        </p>
      )}
      {read.freshness === "stale" && (
        <ImportFailureNotice
          message="Não foi possível atualizar. O que aparece pode estar desatualizado."
          actionLabel="Tentar de novo"
          onAction={() => void read.retry()}
        />
      )}
      {notice?.kind === "status" && (
        <p
          role="status"
          tabIndex={-1}
          data-focus-key="notice"
          className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[14px] text-emerald-900"
        >
          {notice.text}
        </p>
      )}
      {notice?.kind === "failure" && (
        <div tabIndex={-1} data-focus-key="notice">
          <ImportFailureNotice message={notice.info.message} />
        </div>
      )}

      <ImportSessionBody view={view} names={names} />

      <div className="flex flex-wrap gap-2">
        {onContinue &&
          view.actions.some((action) =>
            [
              "UPLOAD",
              "ANALYZE",
              "RESOLVE",
              "PREPARE",
              "CONFIRM",
              "EXECUTE",
            ].includes(action),
          ) && (
            <button
              type="button"
              disabled={!fresh || sending || confirming}
              onClick={() => onContinue(view.id)}
              className={`${BUTTON} border-lifeone-hairline bg-white text-lifeone-ink`}
            >
              Continuar na Maria
            </button>
          )}
        {gate.canReadResult && (
          <button
            type="button"
            onClick={() => onOpenResult(view.id, false)}
            className={`${BUTTON} border-lifeone-hairline bg-white text-lifeone-ink`}
          >
            Ver comprovante
          </button>
        )}
        {gate.canCancel && !confirming && (
          <button
            type="button"
            disabled={!fresh}
            data-focus-key="cancel"
            onClick={() => {
              requestFocus(["confirm"]);
              setConfirming(true);
            }}
            className={`${BUTTON} border-red-200 bg-white text-red-700`}
          >
            Cancelar importação
          </button>
        )}
      </div>

      {gate.canCancel && confirming && (
        <div className="space-y-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3">
          <p
            tabIndex={-1}
            data-focus-key="confirm"
            className="text-[14px] text-red-900"
          >
            Cancelar encerra esta importação, não cria lançamentos e não desfaz
            operações já concluídas.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={sending}
              onClick={() => {
                requestFocus(["cancel"]);
                setConfirming(false);
              }}
              className={`${BUTTON} border-lifeone-hairline bg-white text-lifeone-ink`}
            >
              Manter importação
            </button>
            <button
              type="button"
              disabled={sending || !fresh}
              onClick={() => void confirmCancel()}
              className={`${BUTTON} border-red-700 bg-red-700 text-white`}
            >
              {sending ? "Cancelando…" : "Sim, cancelar"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
