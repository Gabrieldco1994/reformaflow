"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { hasFeature, type ProjectType } from "@reformaflow/domain";
import { Landmark, Plus, History } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { api } from "@/lib/api";
import ImportHistoryModal from "../../_components/ImportHistoryModal";
import BankAccountFormModal from "../../bank-accounts/_components/BankAccountFormModal";
import type { BankAccountRow } from "../../bank-accounts/_types";

function accountName(account: BankAccountRow) {
  return account.nickname?.trim() || account.institution;
}

function accountIdentity(account: BankAccountRow) {
  const parts = [
    account.nickname?.trim() ? account.institution : null,
    `final ${account.last4}`,
    account.agency ? `ag. ${account.agency}` : null,
    account.accountNumber ? `conta ${account.accountNumber}` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

export default function BankAccountsSection({
  projectId,
  projectType,
  onChanged,
}: {
  projectId: string;
  projectType: string;
  onChanged: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { hasModule } = useAuth();
  const canManage =
    hasFeature(projectType as ProjectType, "bankAccounts") &&
    hasModule("bankAccounts");

  const accountsQuery = useQuery<BankAccountRow[]>({
    queryKey: ["bank-accounts", projectId],
    queryFn: () => api.get(`/projects/${projectId}/bank-accounts`),
    enabled: canManage && !!projectId,
  });

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<BankAccountRow | null>(null);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [historyFor, setHistoryFor] = useState<BankAccountRow | null>(null);
  const [deepLinkError, setDeepLinkError] = useState<string | null>(null);
  const handledFocus = useRef<string | null>(null);

  const clearFocusQuery = useCallback(() => {
    const next = new URLSearchParams(searchParams.toString());
    next.delete("focus");
    next.delete("accountId");
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
  }, [pathname, router, searchParams]);

  const closeForm = useCallback(() => {
    setFormOpen(false);
    setEditing(null);
    setSelectorOpen(false);
    setDeepLinkError(null);
    clearFocusQuery();
  }, [clearFocusQuery]);

  const openEdit = (account: BankAccountRow, syncDeepLink = false) => {
    if (syncDeepLink && searchParams.get("focus") === "openingBalance") {
      const next = new URLSearchParams(searchParams.toString());
      next.set("accountId", account.id);
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    }
    setEditing(account);
    setSelectorOpen(false);
    setDeepLinkError(null);
    setFormOpen(true);
  };

  const openCreate = () => {
    setEditing(null);
    setSelectorOpen(false);
    setDeepLinkError(null);
    setFormOpen(true);
  };

  const focus = searchParams.get("focus");
  const accountId = searchParams.get("accountId");
  const focusKey =
    focus === "openingBalance" ? `${focus}:${accountId ?? ""}` : null;

  useEffect(() => {
    if (!focusKey) {
      handledFocus.current = null;
      return;
    }
    if (!accountsQuery.isSuccess || handledFocus.current === focusKey) return;

    handledFocus.current = focusKey;
    const accounts = accountsQuery.data;
    setFormOpen(false);
    setEditing(null);
    setSelectorOpen(false);
    setDeepLinkError(null);

    if (accountId) {
      const requested = accounts.find((account) => account.id === accountId);
      if (requested) {
        setEditing(requested);
        setFormOpen(true);
      } else {
        setDeepLinkError(
          "A conta solicitada não foi encontrada. Escolha uma conta da lista.",
        );
        setSelectorOpen(accounts.length > 0);
      }
      return;
    }

    if (accounts.length === 0) {
      setFormOpen(true);
    } else if (accounts.length === 1) {
      setEditing(accounts[0]!);
      setFormOpen(true);
    } else {
      setSelectorOpen(true);
    }
  }, [accountId, accountsQuery.data, accountsQuery.isSuccess, focusKey]);

  if (!canManage) return null;

  const accounts = accountsQuery.data ?? [];

  return (
    <section className="rounded-2xl border border-lifeone-hairline bg-lifeone-card p-4 shadow-lifeone-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-lifeone-surface text-lifeone-ink-2">
            <Landmark className="h-[18px] w-[18px]" />
          </span>
          <div>
            <h2 className="text-sm font-bold text-lifeone-ink">
              Contas bancárias
            </h2>
            <p className="text-xs text-lifeone-ink-3">
              Identidade da conta e saldo inicial
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-lifeone-hairline px-3 text-sm font-semibold text-lifeone-ink-2 transition-colors hover:bg-lifeone-surface"
          data-bank-account-action
          data-journey-action="bank-account.new"
        >
          <Plus className="h-4 w-4" />
          Nova conta
        </button>
      </div>

      {accountsQuery.isLoading && (
        <p className="mt-3 text-sm text-lifeone-ink-3">
          Carregando contas bancárias…
        </p>
      )}

      {accountsQuery.isError && !accountsQuery.isLoading && (
        <div
          role="alert"
          className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#EAD9C0] bg-[#FBEBDC] p-3 text-sm text-[#8A5A20]"
        >
          <span>Não foi possível carregar as contas bancárias.</span>
          <button
            type="button"
            onClick={() => void accountsQuery.refetch()}
            className="min-h-11 rounded-lg border border-[#D5B98C] px-3 font-semibold"
            data-bank-account-action
          >
            Tentar novamente
          </button>
        </div>
      )}

      {accountsQuery.isSuccess && (
        <>
          {deepLinkError && (
            <p
              role="alert"
              className="mt-3 rounded-xl border border-[#FECDCA] bg-[#FEF3F2] p-3 text-sm text-[#B42318]"
            >
              {deepLinkError}
            </p>
          )}

          {selectorOpen && (
            <div className="mt-3 rounded-xl border border-lifeone-hairline bg-lifeone-surface p-3">
              <p className="text-sm font-semibold text-lifeone-ink">
                Escolha a conta que deseja editar
              </p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {accounts.map((account) => (
                  <button
                    key={account.id}
                    type="button"
                    onClick={() => openEdit(account, true)}
                    aria-label={`Selecionar ${accountName(account)}, final ${account.last4}`}
                    className="min-h-11 rounded-xl border border-lifeone-hairline bg-lifeone-card px-3 py-2 text-left text-sm transition-colors hover:bg-white"
                    data-bank-account-action
                  >
                    <span className="block font-semibold text-lifeone-ink">
                      {accountName(account)}
                    </span>
                    <span className="block text-xs text-lifeone-ink-3">
                      {accountIdentity(account)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {accounts.length === 0 ? (
              <p className="text-sm text-lifeone-ink-3">
                Nenhuma conta cadastrada. Use “Nova conta” para informar a
                identidade e o saldo inicial.
              </p>
            ) : (
              accounts.map((account) => (
                <div
                  key={account.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-lifeone-hairline px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-lifeone-ink">
                      {accountName(account)}
                    </p>
                    <p className="text-xs text-lifeone-ink-3">
                      {accountIdentity(account)}
                    </p>
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setHistoryFor(account)}
                      aria-label={`Importações de ${accountName(account)}, final ${account.last4}`}
                      className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-lifeone-hairline px-3 text-xs font-semibold text-lifeone-ink-2 transition-colors hover:bg-lifeone-surface"
                      data-bank-account-action
                    >
                      <History className="h-4 w-4" />
                      Histórico
                    </button>
                    <button
                      type="button"
                      onClick={() => openEdit(account)}
                      aria-label={`Editar ${accountName(account)}, final ${account.last4}`}
                      className="inline-flex min-h-11 items-center rounded-lg border border-lifeone-hairline px-3 text-xs font-semibold text-lifeone-blue transition-colors hover:bg-lifeone-surface"
                      data-bank-account-action
                    >
                      Editar
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </>
      )}

      {formOpen && (
        <BankAccountFormModal
          projectId={projectId}
          account={editing}
          onClose={closeForm}
          onSaved={() => {
            closeForm();
            void queryClient.invalidateQueries({
              queryKey: ["bank-accounts", projectId],
            });
            onChanged();
          }}
        />
      )}

      {historyFor && (
        <ImportHistoryModal
          basePath={`/projects/${projectId}/bank-accounts/${historyFor.id}`}
          title={`Importações · ${accountName(historyFor)}`}
          onClose={() => setHistoryFor(null)}
          onUndone={() => {
            void queryClient.invalidateQueries({
              queryKey: ["bank-accounts", projectId],
            });
            onChanged();
          }}
        />
      )}
    </section>
  );
}
