"use client";

import { useLayoutEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useIntentFocus } from "../_hooks/useIntentFocus";
import { useImportCatalog } from "../_hooks/useImportCatalog";
import {
  useImportSessionList,
  useImportUserId,
  type ImportListState,
} from "../_hooks/useImportSessions";
import { IMPORT_ENTRY_ERROR } from "../_lib/import-session-read";
import { importActionGate } from "../_lib/import-session-copy";
import type { ImportListScope } from "../_lib/import-session-keys";
import { ImportResultView } from "./ImportResultView";
import { ImportSessionDetail } from "./ImportSessionDetail";
import { ImportSessionList } from "./ImportSessionList";

type View =
  | { kind: "list" }
  | { kind: "session"; id: string }
  | { kind: "result"; id: string; afterApplied: boolean };

const TABS: Array<{ scope: ImportListScope; label: string }> = [
  { scope: "active", label: "Em andamento" },
  { scope: "applied", label: "Concluídas" },
];

function ScopedList({
  userId,
  scope,
  onView,
  onSettled,
}: {
  userId: string;
  scope: ImportListScope;
  onView: (view: View) => void;
  onSettled: () => void;
}) {
  const list = useImportSessionList(userId, scope);
  return (
    <ListContent
      userId={userId}
      list={list}
      onView={onView}
      onSettled={onSettled}
    />
  );
}

function ListContent({
  userId,
  list,
  onView,
  onSettled,
  shared = false,
}: {
  userId: string;
  list: ImportListState;
  onView: (view: View) => void;
  onSettled: () => void;
  shared?: boolean;
}) {
  const loading = list.status === "loading" || list.status === "disabled";
  useLayoutEffect(() => {
    if (!loading) onSettled();
  }, [loading, onSettled]);
  const { names } = useImportCatalog(
    userId,
    list.status === "ready" && list.items.length > 0,
  );
  return (
    <>
      {!shared && list.entry?.kind === "ERROR" && (
        <p role="alert">{IMPORT_ENTRY_ERROR}</p>
      )}
      <ImportSessionList
        list={list}
        names={names}
        onOpen={(summary) =>
          onView(
            importActionGate(summary.actions).canReadResult
              ? { kind: "result", id: summary.id, afterApplied: false }
              : { kind: "session", id: summary.id },
          )
        }
      />
    </>
  );
}

interface RecoveryProps {
  activeList?: ImportListState;
  onContinue?: (sessionId: string) => void;
}
function ImportRecoveryBody({
  userId,
  activeList,
  onContinue,
}: RecoveryProps & { userId: string | null }) {
  const [stack, setStack] = useState<View[]>([{ kind: "list" }]);
  const [scope, setScope] = useState<ImportListScope>("active");
  const current = stack[stack.length - 1];
  const { scope: focusScope, request: requestFocus, settle } = useIntentFocus();
  // The control that triggered a view change unmounts with it: send focus to the new view's first
  // control ("Voltar"), or back to the row that was opened / the active tab when returning to the list.
  const push = (view: View) => {
    requestFocus(["back"]);
    setStack((previous) => [...previous, view]);
  };
  const replace = (view: View) => {
    requestFocus(["back"]);
    setStack((previous) => [...previous.slice(0, -1), view]);
  };
  const back = () => {
    const target = stack.length > 1 ? stack[stack.length - 2] : null;
    if (target && target.kind !== "list") requestFocus(["back"]);
    else
      requestFocus([`row:${current.kind === "list" ? "" : current.id}`], "tab");
    setStack((previous) =>
      previous.length > 1 ? previous.slice(0, -1) : previous,
    );
  };

  if (userId === null) {
    return (
      <p className="text-[14px] text-lifeone-ink-3">
        Entre novamente para ver suas importações.
      </p>
    );
  }

  if (current.kind !== "list") {
    return (
      <div ref={focusScope} className="space-y-4">
        <button
          type="button"
          data-focus-key="back"
          onClick={back}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl px-2 text-[14px] font-semibold text-lifeone-ink-2"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          Voltar
        </button>
        {current.kind === "session" ? (
          <ImportSessionDetail
            key={current.id}
            userId={userId}
            sessionId={current.id}
            onOpenResult={(id, afterApplied) =>
              replace({ kind: "result", id, afterApplied })
            }
            onContinue={onContinue}
          />
        ) : (
          <ImportResultView
            key={current.id}
            userId={userId}
            sessionId={current.id}
            afterApplied={current.afterApplied}
            onOpenSession={
              onContinue ?? ((id) => push({ kind: "session", id }))
            }
          />
        )}
      </div>
    );
  }

  return (
    <div ref={focusScope} className="space-y-4">
      <p className="text-[14px] text-lifeone-ink-2">
        Retome ou consulte as importações guardadas pela Maria. Importações
        feitas por extrato ou fatura no app não aparecem aqui.
      </p>
      <div
        role="tablist"
        aria-label="Importações da Maria"
        className="flex gap-2"
      >
        {TABS.map((tab) => (
          <button
            key={tab.scope}
            type="button"
            role="tab"
            data-focus-key={scope === tab.scope ? "tab" : undefined}
            aria-selected={scope === tab.scope}
            onClick={() => setScope(tab.scope)}
            className={`inline-flex min-h-11 flex-1 items-center justify-center rounded-xl border px-3 text-[14px] font-semibold ${
              scope === tab.scope
                ? "border-lifeone-ink bg-lifeone-ink text-white"
                : "border-lifeone-hairline bg-white text-lifeone-ink-2"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {scope === "active" && activeList ? (
        <ListContent
          userId={userId}
          list={activeList}
          onView={push}
          onSettled={settle}
          shared
        />
      ) : (
        <ScopedList
          key={scope}
          userId={userId}
          scope={scope}
          onView={push}
          onSettled={settle}
        />
      )}
    </div>
  );
}

/**
 * Recovery of sessions the Maria already holds: list → detail → cancel / receipt →
 * continuation. Reads and cancel only. The body is keyed by the user, so a user change
 * drops the selection and any late answer that belonged to the previous user.
 */
export function ImportRecoveryPanel(props: RecoveryProps) {
  const userId = useImportUserId();
  return (
    <ImportRecoveryBody
      key={userId ?? "anonymous"}
      userId={userId}
      {...props}
    />
  );
}
