"use client";

import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { moneyDetail } from "@/lib/money";
import { invalidateExpenseQueries } from "../../expenses/_hooks/useExpenseMutations";
import type { MonthlyEntry } from "../_types";
import { resolveSwipeToPayTarget, type SwipeToPayTarget } from "../_lib/swipe-to-pay";

type RowState = "idle" | "confirming" | "confirmed" | "undoing";

/**
 * Lista de "marcar como pago" por swipe (inovação #4). Cada linha só ganha o
 * controle quando `resolveSwipeToPayTarget` a considera elegível (I4) — a
 * função pura é o ÚNICO ponto que decide `expenseId`, nunca `entry.id`
 * (I2). Confirmar chama PATCH status=PAGO; o toast oferece "Desfazer", que
 * chama PATCH status=PLANEJADO no MESMO par (ownerProjectId, expenseId) — a
 * reversão só é aplicada depois que o servidor confirma (I5), nunca local-only.
 * Se o PATCH do desfazer falhar, a linha VOLTA para "confirmed" (não "idle") —
 * o servidor ainda está PAGO, então a UI não pode fingir que o desfazer deu
 * certo. Confirmar e desfazer, quando bem-sucedidos, invalidam exatamente o
 * mesmo conjunto de queries que `useExpenseMutations` (dashboard/cash-flow/
 * account-view/monthly-overview/etc) para que a Visão Geral, o fluxo de
 * caixa e o dashboard refletam o novo status sem depender de refresh manual.
 *
 * Estado por linha, chaveado por `expenseId` (não um boolean global), para
 * que uma segunda linha continue swipeable enquanto a primeira tem um PATCH
 * em voo: idle → confirming → confirmed → undoing → (idle | confirmed).
 */
export default function SwipeToPay({
  entries,
  viewingProjectId,
}: {
  entries: MonthlyEntry[];
  viewingProjectId: string;
}) {
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});
  const pendingRef = useRef<Set<string>>(new Set());
  const queryClient = useQueryClient();

  const setRowState = (expenseId: string, state: RowState) =>
    setRowStates((current) => ({ ...current, [expenseId]: state }));

  const confirm = async (target: SwipeToPayTarget) => {
    if (pendingRef.current.has(target.expenseId)) return; // no-op: já em voo
    pendingRef.current.add(target.expenseId);
    setRowState(target.expenseId, "confirming");
    try {
      await api.patch(
        `/projects/${target.ownerProjectId}/expenses/${target.expenseId}`,
        { status: "PAGO" },
      );
      setRowState(target.expenseId, "confirmed");
      invalidateExpenseQueries(queryClient, viewingProjectId);
      toast.success("Despesa marcada como paga", {
        action: {
          label: "Desfazer",
          onClick: () => undo(target),
        },
      });
    } catch {
      setRowState(target.expenseId, "idle");
    } finally {
      pendingRef.current.delete(target.expenseId);
    }
  };

  const undo = async (target: SwipeToPayTarget) => {
    if (pendingRef.current.has(target.expenseId)) return;
    pendingRef.current.add(target.expenseId);
    setRowState(target.expenseId, "undoing");
    try {
      await api.patch(
        `/projects/${target.ownerProjectId}/expenses/${target.expenseId}`,
        { status: "PLANEJADO" },
      );
      setRowState(target.expenseId, "idle");
      invalidateExpenseQueries(queryClient, viewingProjectId);
    } catch {
      // O servidor ainda diz PAGO — não podemos mostrar "idle" (voltaria o
      // botão de "marcar como pago" como se o desfazer tivesse funcionado).
      setRowState(target.expenseId, "confirmed");
      toast.error("Não foi possível desfazer. Tente novamente.");
    } finally {
      pendingRef.current.delete(target.expenseId);
    }
  };

  if (entries.length === 0) {
    return (
      <p className="text-sm text-[var(--ck-muted)]">
        Nenhuma despesa planejada para marcar como paga.
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {entries.map((entry) => {
        const target = resolveSwipeToPayTarget(entry, viewingProjectId);
        const state = target ? (rowStates[target.expenseId] ?? "idle") : "idle";
        const description = entry.titulo ?? entry.categoria ?? "Despesa";
        return (
          <li
            key={entry.id}
            className="flex items-center justify-between gap-3 rounded-xl bg-[var(--ck-surface-2)] p-3 text-sm"
          >
            <span className="min-w-0 truncate text-[var(--ck-text)]">
              {description}
            </span>
            <span className="shrink-0 font-geist font-semibold tabular-nums text-[var(--ck-neg)]">
              {moneyDetail(entry.valor)}
            </span>
            {target && state === "confirmed" && (
              <span className="shrink-0 text-sm font-semibold text-[var(--ck-pos)]">
                Pago
              </span>
            )}
            {target && state !== "confirmed" && (
              <button
                type="button"
                disabled={state === "confirming" || state === "undoing"}
                onClick={() => confirm(target)}
                className="min-h-[44px] min-w-[44px] shrink-0 rounded-full border border-[var(--ck-accent)] px-3 text-sm font-semibold text-[var(--ck-accent)] transition-colors disabled:opacity-50"
              >
                Marcar como pago
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
