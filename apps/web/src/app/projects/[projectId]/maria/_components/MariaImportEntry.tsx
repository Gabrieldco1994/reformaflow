"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IMPORT_SESSION_PRIMITIVES } from "@reformaflow/domain";
import { useImportDocumentFlow } from "../_hooks/useImportDocumentFlow";
import {
  useImportResult,
  useImportSessionList,
  useImportUserId,
} from "../_hooks/useImportSessions";
import {
  listImportEntryCards,
  ImportMalformedResponseError,
} from "../_lib/import-session-api";
import { IMPORT_UNAVAILABLE_COPY } from "../_lib/import-entry-copy";
import { importKeys } from "../_lib/import-session-keys";
import { IMPORT_ENTRY_ERROR } from "../_lib/import-session-read";
import { ImportLocalDocuments } from "./ImportLocalDocuments";
import { ImportRecoveryEntry } from "./ImportRecoveryEntry";
import { MariaChatBody } from "./MariaChatBody";

function Entry({
  projectId,
  userId,
}: {
  projectId: string;
  userId: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const params = new URLSearchParams(search);
  const ids = params.getAll("importSessionId");
  const invalid =
    ids.length > 1 ||
    (ids.length === 1 &&
      !new RegExp(IMPORT_SESSION_PRIMITIVES.idPattern).test(ids[0]));
  const location = JSON.stringify([projectId, pathname, search]);
  const [requested, setRequested] = useState<{
    id: string;
    from: string;
    to: string;
    nonce: number;
  } | null>(null);
  const nextNavigation = useRef(0);
  const selection =
    requested && (requested.from === location || requested.to === location)
      ? requested
      : null;
  if (requested && !selection) setRequested(null);
  const contextKey = JSON.stringify([location, selection?.nonce ?? null]);
  const target = (id: string) => {
    const next = new URLSearchParams(search);
    next.set("importSessionId", id);
    return {
      href: `${pathname}?${next}`,
      location: JSON.stringify([projectId, pathname, next.toString()]),
    };
  };
  const [cardId, setCardId] = useState("");
  const list = useImportSessionList(userId, "active");
  const client = useQueryClient();
  const capability =
    list.entry?.kind === "VALID" && list.entry.value.kind === "CARD_INVOICE"
      ? list.entry.value
      : null;
  const unavailable =
    list.entry?.kind === "VALID" && list.entry.value.kind === "UNAVAILABLE"
      ? IMPORT_UNAVAILABLE_COPY[list.entry.value.reason]
      : null;
  const documents = useImportDocumentFlow(
    selection?.id ?? (invalid ? null : (ids[0] ?? null)),
    {
      key: contextKey,
      adoptionKey: (id) =>
        JSON.stringify([target(id).location, selection?.nonce ?? null]),
      publishSession: (id) => router.replace(target(id).href),
      recoverList: async () => {
        await list.restart();
        const state = client.getQueryState(
          importKeys.list(userId ?? "anonymous", "active"),
        );
        if (state?.status !== "success")
          throw state?.error ?? new ImportMalformedResponseError();
      },
    },
  );
  const appliedSessionId =
    documents.view?.state === "APPLIED" &&
    documents.view.actions.includes("READ_RESULT")
      ? documents.view.id
      : null;
  const appliedResult = useImportResult(userId, appliedSessionId);
  const cleanedGeneration = useRef<string | null>(null);
  const appliedGeneration = JSON.stringify([
    userId,
    projectId,
    pathname,
    search,
    contextKey,
    appliedSessionId,
  ]);
  useEffect(() => {
    if (!appliedSessionId) {
      cleanedGeneration.current = null;
      return;
    }
    if (
      cleanedGeneration.current === appliedGeneration ||
      appliedResult.status !== "ready" ||
      appliedResult.freshness !== "fresh" ||
      appliedResult.result?.state !== "APPLIED" ||
      appliedResult.result.receipt === null
    )
      return;
    const fresh = new URLSearchParams(search);
    const currentIds = fresh.getAll("importSessionId");
    if (currentIds.length !== 1 || currentIds[0] !== appliedSessionId) return;
    cleanedGeneration.current = appliedGeneration;
    setCardId("");
    fresh.delete("importSessionId");
    const remaining = fresh.toString();
    router.replace(`${pathname}${remaining ? `?${remaining}` : ""}`);
  }, [
    appliedGeneration,
    appliedResult.freshness,
    appliedResult.result,
    appliedResult.status,
    appliedSessionId,
    pathname,
    router,
    search,
  ]);
  const cards = useQuery({
    queryKey: importKeys.entryCards(userId ?? "anonymous"),
    queryFn: ({ signal }) => listImportEntryCards(signal),
    enabled: Boolean(userId && capability && !documents.sessionId),
    gcTime: 0,
    staleTime: 0,
    retry: false,
    networkMode: "always",
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const selectedCard = cards.data?.find((card) => card.id === cardId);
  const availableCard = selectedCard && !cards.isError && !cards.isFetching;
  const intake = capability ? (
    <section
      aria-label="Importar fatura CSV"
      className="mb-3 min-w-0 space-y-3"
    >
      {cards.isPending && <p role="status">Carregando cartões…</p>}
      {cards.isError && (
        <div role="alert">
          <p>
            Não foi possível consultar os cartões disponíveis. Nada foi enviado.
          </p>
          <button
            type="button"
            onClick={() => void cards.refetch()}
            className="min-h-11 rounded-xl border px-3"
          >
            Consultar cartões novamente
          </button>
        </div>
      )}
      {cards.data && (
        <label className="block text-sm">
          Cartão da fatura
          <select
            value={cardId}
            disabled={
              documents.hasAttempt ||
              documents.busy ||
              cards.isFetching ||
              cards.isError
            }
            onChange={(event) => setCardId(event.target.value)}
            className="mt-1 min-h-11 w-full min-w-0 rounded-xl border px-3"
          >
            <option value="">Escolha o cartão e seu projeto</option>
            {cards.data.map((card) => (
              <option key={card.id} value={card.id}>
                {card.nickname || "Cartão"} · {card.last4} · {card.project.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {cards.data?.length === 0 && (
        <p>Nenhum cartão disponível para esta importação.</p>
      )}
      <ImportLocalDocuments
        key={contextKey}
        formats={capability.formats}
        attempted={documents.hasAttempt}
        pending={documents.busy}
        disabled={documents.hasAttempt}
        remoteError={documents.error?.message}
        onRecover={() => void documents.recover()}
        onConsent={
          availableCard
            ? (files) =>
                void documents.consent(selectedCard, files, capability.formats)
            : undefined
        }
      />
      {documents.hasAttempt && !documents.sessionId && documents.error && (
        <p>
          O resultado do envio é incerto. Consulte suas importações guardadas;
          nenhuma será escolhida automaticamente.
        </p>
      )}
      {documents.canRetry && !documents.busy && (
        <button
          type="button"
          onClick={() => void documents.retry()}
          className="min-h-11 rounded-xl border px-3"
        >
          Repetir esta tentativa
        </button>
      )}
    </section>
  ) : undefined;

  return (
    <>
      <ImportRecoveryEntry
        activeList={list}
        onContinue={(id) => {
          documents.invalidate();
          const next = target(id);
          setRequested({
            id,
            from: location,
            to: next.location,
            nonce: ++nextNavigation.current,
          });
          router.replace(next.href);
        }}
      />
      {unavailable && (
        <section
          aria-label="Disponibilidade de novas importações"
          className="mt-3 space-y-2 text-sm"
        >
          <p>{unavailable.message}</p>
          {unavailable.canRetry && (
            <button
              type="button"
              onClick={() => void list.restart()}
              className="min-h-11 rounded-xl border px-3"
            >
              Verificar novamente
            </button>
          )}
        </section>
      )}
      {(list.entry?.kind === "ERROR" || list.failure) && (
        <p role="alert" className="mt-3 text-sm text-darc-red">
          {IMPORT_ENTRY_ERROR}
        </p>
      )}
      {invalid && !selection ? (
        <p role="alert">
          O endereço desta importação é inválido. Abra uma importação guardada
          para continuar.
        </p>
      ) : documents.sessionId ? (
        <>
          {documents.view ? (
            <MariaChatBody
              projectId={projectId}
              importSessionId={documents.sessionId}
              documents={documents}
            />
          ) : documents.error ? (
            <div role="alert">
              <p>{documents.error.message}</p>
              {!documents.error.privateContextLost && (
                <button
                  type="button"
                  disabled={documents.busy}
                  onClick={() => void documents.recover()}
                  className="min-h-11 rounded-xl border px-3"
                >
                  Consultar estado dos documentos
                </button>
              )}
            </div>
          ) : (
            <p role="status">Carregando importação…</p>
          )}
          {documents.hasAttempt && documents.busy && (
            <p role="status">Enviando documentos…</p>
          )}
          {documents.canRetry && !documents.busy && (
            <button
              type="button"
              onClick={() => void documents.retry()}
              className="min-h-11 rounded-xl border px-3"
            >
              Retomar envio dos documentos
            </button>
          )}
        </>
      ) : (
        <MariaChatBody projectId={projectId} intake={intake} />
      )}
    </>
  );
}

export function MariaImportEntry({ projectId }: { projectId: string }) {
  const userId = useImportUserId();
  return (
    <Entry
      key={JSON.stringify([userId, projectId])}
      userId={userId}
      projectId={projectId}
    />
  );
}
