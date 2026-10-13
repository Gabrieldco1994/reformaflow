"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IMPORT_SESSION_PRIMITIVES } from "@reformaflow/domain";
import { useAuth } from "@/contexts/auth-context";
import { useImportDocumentFlow } from "../_hooks/useImportDocumentFlow";
import {
  useImportSessionList,
  useImportUserId,
} from "../_hooks/useImportSessions";
import {
  listImportEntryCards,
  ImportMalformedResponseError,
} from "../_lib/import-session-api";
import { importKeys } from "../_lib/import-session-keys";
import { IMPORT_ENTRY_ERROR } from "../_lib/import-session-read";
import type { ImportEntryAction } from "../_lib/import-entry-action";
import { isSupportedImportFormats } from "../_lib/import-entry-action";
import { importFormatLabel } from "../_lib/import-format";
import { ImportLocalDocuments } from "./ImportLocalDocuments";
import { ImportRecoveryEntry } from "./ImportRecoveryEntry";
import { MariaChatBody } from "./MariaChatBody";

const PRIVATE_IMPORT_HISTORY_KEY = "__reformaflowMariaImport";
const validSessionId = (value: string | null): value is string =>
  value !== null && new RegExp(IMPORT_SESSION_PRIMITIVES.idPattern).test(value);

function Entry({
  projectId,
  userId,
}: {
  projectId: string;
  userId: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const { hasModule } = useAuth();
  const cardSetupReturn = searchParams.get("cardSetup") === "return";
  const params = new URLSearchParams(search);
  const ids = params.getAll("importSessionId");
  const importAddress = ids.join("\u0000");
  const invalid =
    ids.length > 1 || (ids.length === 1 && !validSessionId(ids[0]));
  const urlSessionId = !invalid && ids.length === 1 ? ids[0] : null;
  const cleanParams = new URLSearchParams(search);
  cleanParams.delete("importSessionId");
  const cleanSearch = cleanParams.toString();
  const cleanHref = cleanSearch ? `${pathname}?${cleanSearch}` : pathname;
  const [privateSessionId, setPrivateSessionId] = useState<string | null>(null);
  const rememberPrivateSession = useCallback(
    (id: string) => {
      if (!validSessionId(id) || typeof window === "undefined") return;
      const previous =
        window.history.state && typeof window.history.state === "object"
          ? window.history.state
          : {};
      window.history.replaceState(
        {
          ...previous,
          [PRIVATE_IMPORT_HISTORY_KEY]: { projectId, id },
        },
        "",
        cleanHref,
      );
      setPrivateSessionId(id);
    },
    [cleanHref, projectId],
  );
  useEffect(() => {
    if (urlSessionId) {
      rememberPrivateSession(urlSessionId);
      return;
    }
    if (ids.length !== 0 || typeof window === "undefined") return;
    const privateImport = window.history.state?.[PRIVATE_IMPORT_HISTORY_KEY];
    if (
      privateImport &&
      typeof privateImport === "object" &&
      privateImport.projectId === projectId &&
      validSessionId(privateImport.id)
    )
      setPrivateSessionId(privateImport.id);
  }, [
    importAddress,
    ids.length,
    projectId,
    rememberPrivateSession,
    urlSessionId,
  ]);
  const location = JSON.stringify([projectId, pathname, search]);
  const [requested, setRequested] = useState<{
    id: string;
    from: string;
    to: string;
    nonce: number;
  } | null>(null);
  const [
    pendingContinuationFocusSessionId,
    setPendingContinuationFocusSessionId,
  ] = useState<string | null>(null);
  const recordContinuationFocus = useCallback((sessionId: string) => {
    setPendingContinuationFocusSessionId(sessionId);
  }, []);
  const completeContinuationFocus = useCallback((sessionId: string) => {
    setPendingContinuationFocusSessionId((pending) =>
      pending === sessionId ? null : pending,
    );
  }, []);
  const nextNavigation = useRef(0);
  const sessionOriginChannels = useRef(
    new Map<string, ImportEntryAction["originChannel"]>(),
  );
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
  const [action, setAction] = useState<ImportEntryAction | null>(null);
  const [actionSequence, setActionSequence] = useState(0);
  const [cardId, setCardId] = useState<string | null>(null);
  const [intakeContext, setIntakeContext] = useState(contextKey);
  if (intakeContext !== contextKey) {
    setIntakeContext(contextKey);
    setAction(null);
    setCardId(null);
  }
  const list = useImportSessionList(userId, "active");
  const client = useQueryClient();
  const capability =
    action?.kind === "START_CARD_INVOICE_IMPORT" ? action : null;
  const entryFormats =
    list.entry?.kind === "VALID" &&
    list.entry.value.kind === "CARD_INVOICE" &&
    list.freshness === "fresh" &&
    isSupportedImportFormats(list.entry.value.formats)
      ? list.entry.value.formats
      : [];
  const documents = useImportDocumentFlow(
    selection?.id ??
      (invalid ? null : (urlSessionId ?? privateSessionId ?? null)),
    {
      key: contextKey,
      supportedFormats: capability?.formats ?? entryFormats,
      adoptionKey: (id) =>
        JSON.stringify([target(id).location, selection?.nonce ?? null]),
      publishSession: (id) => {
        if (capability)
          sessionOriginChannels.current.set(id, capability.originChannel);
        router.replace(target(id).href);
      },
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
  const activeOriginChannel = documents.sessionId
    ? (sessionOriginChannels.current.get(documents.sessionId) ?? "TEXT")
    : "TEXT";
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
  const mariaReturn = `/projects/${encodeURIComponent(projectId)}/maria?cardSetup=return`;
  const cardSetupHref = `/projects/${encodeURIComponent(projectId)}/credit-cards?new=1&returnTo=${encodeURIComponent(mariaReturn)}`;
  const selectedCardSetupHref = selectedCard
    ? `/projects/${encodeURIComponent(selectedCard.project.id)}/credit-cards?focus=closingDay&cardId=${encodeURIComponent(selectedCard.id)}&returnTo=${encodeURIComponent(mariaReturn)}`
    : null;

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
      {(list.entry?.kind === "ERROR" || list.failure) && (
        <p role="alert" className="mt-3 text-sm text-darc-red">
          {IMPORT_ENTRY_ERROR}
        </p>
      )}
      {cardSetupReturn && (
        <p role="status" className="mt-3 text-sm">
          Você voltou da configuração de cartão. Se cadastrou um cartão, peça
          novamente à Maria para importar a fatura e escolha-o explicitamente.
        </p>
      )}
      {invalid && !selection ? (
        <p role="alert">
          O endereço desta importação é inválido. Abra uma importação guardada
          para continuar.
        </p>
      ) : documents.sessionId ? (
        <>
          {documents.notice && (
            <p role="status" className="mt-3 text-sm">
              {documents.notice}
            </p>
          )}
          {documents.view ? (
            <MariaChatBody
              projectId={projectId}
              importSessionId={documents.sessionId}
              documents={documents}
              continuationFocusSessionId={pendingContinuationFocusSessionId}
              onContinuationRequest={recordContinuationFocus}
              onContinuationFocusComplete={completeContinuationFocus}
              originChannel={activeOriginChannel}
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
        <MariaChatBody
          projectId={projectId}
          key={contextKey}
          disabled={documents.busy || documents.hasAttempt}
          onImportEntryAction={(next) => {
            if (documents.hasAttempt || documents.busy) return;
            setAction(next);
            setCardId(null);
            setActionSequence((current) => current + 1);
          }}
          intake={
            capability ? (
              <section
                aria-label="Nova importação"
                className="min-h-0 space-y-3 overflow-y-auto py-3"
              >
                {cards.isPending && <p role="status">Carregando cartões…</p>}
                {cards.isError && (
                  <div role="alert">
                    <p>
                      Não foi possível consultar os cartões disponíveis. Nada
                      foi enviado.
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
                      value={selectedCard?.id ?? ""}
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
                          {card.nickname || "Cartão"} · {card.last4} ·{" "}
                          {card.project.name} · fecha{" "}
                          {card.closingDay === null
                            ? "não informado"
                            : `dia ${card.closingDay}`}{" "}
                          · vence{" "}
                          {card.dueDay === null
                            ? "não informado"
                            : `dia ${card.dueDay}`}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {selectedCard &&
                  (selectedCard.closingDay === null ||
                    selectedCard.dueDay === null) && (
                    <div className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm">
                      <p>
                        {selectedCard.closingDay === null &&
                        selectedCard.dueDay === null
                          ? "Os dias de fechamento e vencimento deste cartão não estão configurados."
                          : selectedCard.closingDay === null
                            ? "O dia de fechamento deste cartão não está configurado."
                            : "O dia de vencimento deste cartão não está configurado."}{" "}
                        Isso não impede a seleção do cartão; configure os dados
                        se souber os dias corretos.
                      </p>
                      {selectedCardSetupHref && hasModule("creditCards") && (
                        <Link
                          href={selectedCardSetupHref}
                          className="inline-flex min-h-11 items-center rounded-xl border border-amber-700 px-3 font-medium"
                        >
                          Configurar dias do cartão
                        </Link>
                      )}
                    </div>
                  )}
                {cards.data?.length === 0 && (
                  <div className="space-y-2">
                    <p>Nenhum cartão disponível para esta importação.</p>
                    {hasModule("creditCards") ? (
                      <Link
                        href={cardSetupHref}
                        className="inline-flex min-h-11 items-center rounded-xl border px-3"
                      >
                        Cadastrar cartão e voltar à Maria
                      </Link>
                    ) : (
                      <p>
                        Você precisa de acesso ao módulo de cartões para
                        cadastrar um cartão. Peça acesso ao responsável pelo
                        projeto e volte a esta conversa depois.
                      </p>
                    )}
                  </div>
                )}
                <p>
                  Selecione arquivos locais nos formatos{" "}
                  {importFormatLabel(capability.formats)} e autorize o
                  processamento determinístico. Isso não confirma lançamentos.
                </p>
                <ImportLocalDocuments
                  key={`${contextKey}:${actionSequence}`}
                  formats={capability?.formats ?? []}
                  attempted={documents.hasAttempt}
                  pending={documents.busy}
                  disabled={
                    !capability || !availableCard || documents.hasAttempt
                  }
                  remoteError={documents.error?.message}
                  onRecover={() => void documents.recover()}
                  onConsent={
                    capability && availableCard
                      ? (files) =>
                          void documents.consent(
                            selectedCard,
                            files,
                            capability.formats,
                          )
                      : undefined
                  }
                />
                {documents.hasAttempt &&
                  !documents.sessionId &&
                  documents.error && (
                    <p>
                      O resultado do envio é incerto. Consulte suas importações
                      guardadas; nenhuma será escolhida automaticamente.
                    </p>
                  )}
                {documents.canRetry && capability && !documents.busy && (
                  <button
                    type="button"
                    onClick={() => void documents.retry()}
                    className="min-h-11 rounded-xl border px-3"
                  >
                    Repetir esta tentativa
                  </button>
                )}
              </section>
            ) : action?.kind === "IMPORT_UNAVAILABLE" ? (
              <p role="status">
                Novas importações estão indisponíveis neste momento.
              </p>
            ) : undefined
          }
        />
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
