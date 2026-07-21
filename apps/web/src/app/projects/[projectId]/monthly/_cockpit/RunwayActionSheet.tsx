"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { X, Calendar, Minus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { RunwayCandidato } from "../../dre/_types";
import { fmtMoney } from "./format";
import { moneyGlance } from "@/lib/money";

type Action = "adiar" | "reduzir" | null;

function useRunwayMutations(projectId: string, candidato: RunwayCandidato) {
  const qc = useQueryClient();
  const ownerProject = candidato.projetoOrigem?.id ?? projectId;
  const { expenseId } = candidato;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["dre-overview", projectId] });
    qc.invalidateQueries({ queryKey: ["account-view", projectId] });
    qc.invalidateQueries({ queryKey: ["monthly-overview", projectId] });
  };

  const adiarMutation = useMutation({
    mutationFn: (dataPagamento: string) =>
      api.patch(`/projects/${ownerProject}/expenses/${expenseId}`, { dataPagamento }),
    onSuccess: () => { toast.success("Data adiada"); invalidate(); },
    onError: (e: Error) => toast.error(`Erro ao adiar: ${e.message}`),
  });

  const reduzirMutation = useMutation({
    mutationFn: (valor: number) =>
      api.patch(`/projects/${ownerProject}/expenses/${expenseId}`, { valor: valor / 100 }),
    onSuccess: () => { toast.success("Valor reduzido"); invalidate(); },
    onError: (e: Error) => toast.error(`Erro ao reduzir: ${e.message}`),
  });

  const removerMutation = useMutation({
    mutationFn: () => api.delete(`/projects/${ownerProject}/expenses/${expenseId}`),
    onSuccess: () => { toast.success("Despesa removida"); invalidate(); },
    onError: (e: Error) => toast.error(`Erro ao remover: ${e.message}`),
  });

  return { adiarMutation, reduzirMutation, removerMutation };
}

function CandidatoRow({
  c,
  projectId,
  onDone,
}: {
  c: RunwayCandidato;
  projectId: string;
  onDone: () => void;
}) {
  const [action, setAction] = useState<Action>(null);
  const [dateValue, setDateValue] = useState(c.data.slice(0, 10));
  const [valorCents, setValorCents] = useState(c.valor);
  const { adiarMutation, reduzirMutation, removerMutation } = useRunwayMutations(projectId, c);

  const busy =
    adiarMutation.isPending || reduzirMutation.isPending || removerMutation.isPending;

  const submit = async () => {
    if (action === "adiar") await adiarMutation.mutateAsync(dateValue);
    else if (action === "reduzir") await reduzirMutation.mutateAsync(valorCents);
    setAction(null);
    onDone();
  };

  const remove = async () => {
    await removerMutation.mutateAsync();
    onDone();
  };

  return (
    <li className="rounded-2xl border border-[var(--ck-border)] bg-[var(--ck-surface-2)] p-3.5 space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[13px] font-semibold text-[var(--ck-text)] leading-snug truncate">
            {c.descricao}
          </p>
          {c.projetoOrigem && (
            <p className="text-[11px] text-[var(--ck-muted)]">{c.projetoOrigem.name}</p>
          )}
        </div>
        <span className="shrink-0 text-[15px] font-bold tabular-nums text-[var(--ck-neg)] whitespace-nowrap">
          {moneyGlance(c.valor)}
        </span>
      </div>

      {/* Inline edit area */}
      {action === "adiar" && (
        <div className="flex items-center gap-2">
          <input
            type="date"
            value={dateValue}
            onChange={(e) => setDateValue(e.target.value)}
            className="flex-1 rounded-xl border border-[var(--ck-border)] bg-[var(--ck-surface)] px-3 py-2 text-[13px] text-[var(--ck-text)] min-h-[44px]"
          />
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="min-h-[44px] rounded-xl bg-[var(--ck-accent)] px-4 text-[13px] font-semibold text-white disabled:opacity-50"
          >
            OK
          </button>
          <button
            type="button"
            onClick={() => setAction(null)}
            className="min-h-[44px] rounded-xl border border-[var(--ck-border)] px-3 text-[13px] text-[var(--ck-muted)]"
          >
            ✕
          </button>
        </div>
      )}

      {action === "reduzir" && (
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            step={0.01}
            value={(valorCents / 100).toFixed(2)}
            onChange={(e) => setValorCents(Math.round(parseFloat(e.target.value || "0") * 100))}
            className="flex-1 rounded-xl border border-[var(--ck-border)] bg-[var(--ck-surface)] px-3 py-2 text-[13px] text-[var(--ck-text)] min-h-[44px]"
          />
          <button
            type="button"
            onClick={submit}
            disabled={busy}
            className="min-h-[44px] rounded-xl bg-[var(--ck-accent)] px-4 text-[13px] font-semibold text-white disabled:opacity-50"
          >
            OK
          </button>
          <button
            type="button"
            onClick={() => setAction(null)}
            className="min-h-[44px] rounded-xl border border-[var(--ck-border)] px-3 text-[13px] text-[var(--ck-muted)]"
          >
            ✕
          </button>
        </div>
      )}

      {/* Action buttons */}
      {!action && (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setAction("adiar")}
            disabled={busy}
            className="flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-xl border border-[var(--ck-border)] bg-[var(--ck-surface)] px-3 text-[12px] font-medium text-[var(--ck-text)] disabled:opacity-50"
          >
            <Calendar className="h-3.5 w-3.5" />
            Adiar
          </button>
          <button
            type="button"
            onClick={() => setAction("reduzir")}
            disabled={busy}
            className="flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-xl border border-[var(--ck-border)] bg-[var(--ck-surface)] px-3 text-[12px] font-medium text-[var(--ck-text)] disabled:opacity-50"
          >
            <Minus className="h-3.5 w-3.5" />
            Reduzir
          </button>
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            aria-label="Remover despesa"
            className="flex min-h-[44px] w-[44px] items-center justify-center rounded-xl border border-[var(--ck-neg)]/40 bg-[var(--ck-neg)]/10 text-[var(--ck-neg)] disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      )}
    </li>
  );
}

/**
 * Sheet "Como fechar no azul?": lista os até 5 maiores gastos planejados até o
 * crossover. Por item: adiar / reduzir / remover usando as mutations existentes.
 * Linguagem neutra — nunca sugere cortes específicos, o usuário decide.
 */
export function RunwayActionSheet({
  candidatos,
  piorSaldo,
  piorMes,
  projectId,
  onClose,
}: {
  candidatos: RunwayCandidato[];
  /** Valor do pior ponto da projeção (centavos, negativo). */
  piorSaldo: number;
  piorMes: string;
  projectId: string;
  onClose: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Como fechar no azul?"
      className="fixed inset-0 z-50 flex items-end justify-center bg-lifeone-ink/40 p-0 sm:items-center sm:p-4"
    >
      <div className="w-full max-w-md rounded-t-3xl bg-[var(--ck-surface)] shadow-lifeone-dialog sm:rounded-3xl max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 p-5 pb-3 shrink-0">
          <div>
            <h3 className="text-base font-bold text-[var(--ck-text)]">Como fechar no azul?</h3>
            <p className="mt-0.5 text-[12px] text-[var(--ck-muted)]">
              Sem ação, o saldo chega a{" "}
              <span className="font-semibold text-[var(--ck-neg)]">{fmtMoney(piorSaldo)}</span>{" "}
              em {piorMes}.
            </p>
            <p className="mt-1 text-[12px] text-[var(--ck-muted)]">
              Os {candidatos.length} maiores gastos planejados até lá:
            </p>
          </div>
          <button
            type="button"
            aria-label="Fechar"
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[var(--ck-border)] text-[var(--ck-muted)]"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* List */}
        <ul className="flex-1 overflow-y-auto px-5 pb-5 space-y-2.5">
          {candidatos.length === 0 ? (
            <li className="py-8 text-center text-[13px] text-[var(--ck-muted)]">
              Sem gastos planejados identificados até o crossover.
            </li>
          ) : (
            candidatos.map((c) => (
              <CandidatoRow
                key={c.expenseId}
                c={c}
                projectId={projectId}
                onDone={onClose}
              />
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
