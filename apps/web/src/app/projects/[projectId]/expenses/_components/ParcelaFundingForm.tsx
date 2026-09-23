"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { currencyInputToCents } from "@/lib/currency-input";
import { formatCurrency, formatDateBR } from "@/lib/utils";
import type {
  Expense,
  InstallmentSettlement,
  ParcelaFundingResult,
} from "@/types";
import { invalidateExpenseProjects } from "../_hooks/useExpenseMutations";

export const SETTLEMENT_LABELS: Record<
  InstallmentSettlement["settlementStatus"],
  string
> = {
  UNPAID: "Pendente",
  PARTIAL: "Parcialmente pago",
  PAID: "Pago",
};

interface FundingCommand {
  mode: "ADDITIVE";
  targetExpenseId: string;
  parcelaIndex: number;
  amountCents: number;
  requestId: string;
}

/** Applies an existing debit. Never creates or edits a financial movement. */
export function ParcelaFundingForm({
  projectId,
  sourceId,
  initialTargetId,
  initialParcelaIndex = 0,
  onPendingChange,
}: {
  projectId: string;
  sourceId: string;
  initialTargetId?: string;
  initialParcelaIndex?: number;
  onPendingChange?: (pending: boolean) => void;
}) {
  const id = useId();
  const client = useQueryClient();
  const [selected, setSelected] = useState(
    initialTargetId ? `${initialTargetId}#${initialParcelaIndex}` : "",
  );
  const [amountDraft, setAmountDraft] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<ParcelaFundingResult[]>([]);
  const [latest, setLatest] = useState<ParcelaFundingResult | null>(null);
  const command = useRef<FundingCommand | null>(null);
  const amountInput = useRef<HTMLInputElement>(null);
  const source = useQuery<Expense>({
    queryKey: ["expense", projectId, sourceId],
    queryFn: () => api.get(`/projects/${projectId}/expenses/${sourceId}`),
  });
  const targets = useQuery<Expense[]>({
    queryKey: ["cross-project-expenses", projectId, "funding"],
    queryFn: () =>
      api.get(`/projects/${projectId}/expenses/cross-project?limit=2000`),
  });
  const options = (targets.data ?? []).flatMap((expense) =>
    (expense.installmentSettlements ?? []).map((summary) => ({
      expense,
      summary,
      key: `${expense.id}#${summary.parcelaIndex}`,
    })),
  );
  const option = options.find((o) => o.key === selected);
  const summary = option?.summary;
  const available = source.data?.sourceAvailableCents;
  const remaining = summary?.remainingCents;
  const maxCents =
    available !== undefined &&
    remaining !== undefined &&
    Number.isSafeInteger(available) &&
    Number.isSafeInteger(remaining)
      ? Math.min(available, remaining)
      : undefined;
  const amount =
    amountDraft ??
    (maxCents !== undefined && maxCents > 0 ? String(maxCents / 100) : "");
  const cents = currencyInputToCents(amount);

  function accept(result: ParcelaFundingResult) {
    setLatest(result);
    setAmountDraft(null);
    if (result.state === "REVERSED") command.current = null;
    setConfirmed((previous) => [
      ...previous.filter((r) => r.settlementId !== result.settlementId),
      result,
    ]);
    const target = targets.data?.find((e) => e.id === result.targetId);
    // Only confirmed server balances enter the cache; later reads remain authoritative.
    client.setQueryData<Expense>(["expense", projectId, sourceId], (old) =>
      old ? { ...old, sourceAvailableCents: result.sourceAvailableCents } : old,
    );
    client.setQueryData<Expense[]>(
      ["cross-project-expenses", projectId, "funding"],
      (old) =>
        old?.map((expense) =>
          expense.id === result.targetId
            ? {
                ...expense,
                installmentSettlements: expense.installmentSettlements?.map(
                  (item) =>
                    item.parcelaIndex === result.parcelaIndex
                      ? {
                          ...item,
                          contractedCents: result.contractedCents,
                          paidCents: result.paidCents,
                          remainingCents: result.remainingCents,
                          settlementStatus: result.settlementStatus,
                        }
                      : item,
                ),
              }
            : expense,
        ),
    );
    invalidateExpenseProjects(client, [
      projectId,
      target?.projectId ?? target?.project?.id,
    ]);
    client.invalidateQueries({ queryKey: ["expense"] });
    client.invalidateQueries({ queryKey: ["origin-items-yearly", projectId] });
  }

  const apply = useMutation({
    mutationFn: (body: FundingCommand) =>
      api.post<ParcelaFundingResult>(
        `/projects/${projectId}/expenses/${sourceId}/conciliar-parcela`,
        body,
      ),
    onSuccess: accept,
  });
  const undo = useMutation({
    mutationFn: (settlementId: string) =>
      api.delete<ParcelaFundingResult>(
        `/projects/${projectId}/expenses/${sourceId}/conciliar-parcela/${settlementId}`,
      ),
    onSuccess: (result) => {
      accept(result);
      command.current = null;
    },
  });
  const busy = apply.isPending || undo.isPending;
  useEffect(() => {
    onPendingChange?.(busy);
    return () => onPendingChange?.(false);
  }, [busy, onPendingChange]);
  const retrying = apply.isError && command.current !== null;
  const valid =
    !!option &&
    !source.isError &&
    !targets.isError &&
    (retrying ||
      (maxCents !== undefined &&
        cents > 0 &&
        Number.isSafeInteger(cents) &&
        cents <= maxCents));
  const error = source.error ?? targets.error ?? apply.error ?? undo.error;

  function confirm() {
    if (!valid || !option || busy) return;
    if (!retrying && !amountInput.current?.reportValidity()) return;
    // Keep the exact command on network retry; field edits explicitly discard it.
    if (
      command.current &&
      (command.current.targetExpenseId !== option.expense.id ||
        command.current.parcelaIndex !== option.summary.parcelaIndex ||
        command.current.amountCents !== cents)
    ) {
      command.current = null;
    }
    command.current ??= {
      mode: "ADDITIVE",
      targetExpenseId: option.expense.id,
      parcelaIndex: option.summary.parcelaIndex,
      amountCents: cents,
      requestId: crypto.randomUUID(),
    };
    setAmountDraft(amount);
    apply.mutate(command.current);
  }

  return (
    <section
      aria-label="Aplicar débito existente"
      className="space-y-3 rounded-xl border border-darc-linen p-3"
    >
      <h3 className="font-semibold">Pagar parcela com este débito</h3>
      <p className="text-sm text-darc-velvet/70">
        O débito original é mantido. Apenas o valor aplicado reduz o saldo da
        parcela, sem criar outra despesa.
      </p>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error.message}
        </p>
      )}
      {(source.isPending || targets.isPending) && <p>Carregando saldos…</p>}
      <label htmlFor={`${id}-target`} className="block text-sm">
        Parcela a pagar
      </label>
      <select
        id={`${id}-target`}
        value={selected}
        disabled={busy}
        className="min-h-11 w-full min-w-0 rounded-lg border border-darc-linen bg-white px-2"
        onChange={(e) => {
          setSelected(e.target.value);
          setAmountDraft(null);
          command.current = null;
          apply.reset();
        }}
      >
        <option value="">Selecione uma parcela</option>
        {options.map(({ expense, summary: item, key }) => (
          <option key={key} value={key}>
            {expense.project?.name} ·{" "}
            {expense.titulo || expense.fornecedor || "Despesa"} · parcela{" "}
            {item.parcelaIndex + 1} · {formatDateBR(item.dueDate)}
          </option>
        ))}
      </select>
      {summary && (
        <dl className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-3">
          {[
            { label: "Contratado", cents: summary.contractedCents },
            { label: "Pago", cents: summary.paidCents },
            { label: "Restante", cents: summary.remainingCents },
          ].map(({ label, cents }) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd className="whitespace-nowrap font-semibold tabular-nums">
                {formatCurrency(cents / 100)}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <p className="text-sm">
        Disponível neste débito:{" "}
        <span className="whitespace-nowrap">
          {available === undefined
            ? "não informado"
            : formatCurrency(available / 100)}
        </span>
      </p>
      {maxCents === undefined && (
        <p className="text-sm text-amber-800">
          Selecione uma parcela com saldo e disponibilidade informados pelo
          servidor.
        </p>
      )}
      <label htmlFor={`${id}-amount`} className="block text-sm">
        Valor a aplicar (R$)
      </label>
      <input
        ref={amountInput}
        id={`${id}-amount`}
        type="number"
        inputMode="decimal"
        min="0.01"
        step="0.01"
        max={maxCents === undefined ? undefined : maxCents / 100}
        value={amount}
        disabled={busy || maxCents === undefined}
        className="min-h-11 w-full rounded-lg border border-darc-linen px-3"
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            confirm();
          }
        }}
        onChange={(e) => {
          setAmountDraft(e.target.value);
          command.current = null;
          apply.reset();
        }}
      />
      {maxCents !== undefined && amount !== "" && !valid && (
        <p role="alert" className="text-sm text-red-700">
          Informe um valor positivo até {formatCurrency(maxCents / 100)}.
        </p>
      )}
      <button
        type="button"
        disabled={busy || !valid}
        onClick={confirm}
        className="min-h-11 w-full rounded-lg bg-brand-600 px-3 py-2 text-white disabled:opacity-50"
      >
        {busy ? "Aguarde…" : "Confirmar pagamento parcial"}
      </button>
      {latest && (
        <p role="status">
          {latest.state === "REVERSED"
            ? "Contribuição desfeita"
            : SETTLEMENT_LABELS[latest.settlementStatus]}
        </p>
      )}
      {confirmed
        .filter((r) => r.state === "ACTIVE")
        .map((r) => (
          <div
            key={r.settlementId}
            className="flex flex-wrap items-center justify-between gap-2 text-sm"
          >
            <span className="whitespace-nowrap">
              Aplicado: {formatCurrency(r.amountCents / 100)}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => undo.mutate(r.settlementId)}
              className="min-h-11 rounded-lg border border-darc-linen px-3 py-2"
            >
              Desfazer esta contribuição
            </button>
          </div>
        ))}
    </section>
  );
}
