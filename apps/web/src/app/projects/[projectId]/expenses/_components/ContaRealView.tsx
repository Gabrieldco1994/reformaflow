'use client';
import { useState } from 'react';
import { ChevronDown, ChevronRight, CreditCard } from 'lucide-react';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import type { Expense, ExpenseStatus } from '@/types';
import { mesLabelFromKey } from '../_lib/grouping-by-month';
import type { ContaRealMonth, FaturaCartao } from '../_lib/conta-real';
import PersonalExpenseCard, { type PersonalCardInfo } from './PersonalExpenseCard';

function diaMM(dia: number | null, mes: string): string {
  if (dia == null) return '—';
  const mm = mes.split('-')[1] ?? '';
  return mm ? `${String(dia).padStart(2, '0')}/${mm}` : String(dia).padStart(2, '0');
}

function FaturaCard({ fatura }: { fatura: FaturaCartao }) {
  const [open, setOpen] = useState(false);
  const paga = fatura.planejado === 0 && fatura.pago > 0;
  return (
    <div className="rounded-lg border border-rose-200 bg-white overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-rose-50/50"
      >
        {open ? <ChevronDown className="w-4 h-4 text-rose-500" /> : <ChevronRight className="w-4 h-4 text-rose-500" />}
        <CreditCard className="w-4 h-4 text-rose-600 shrink-0" />
        <div className="min-w-0">
          <div className="text-sm font-semibold text-gray-900 truncate">Fatura {fatura.label}</div>
          <div className="text-[10px] text-gray-500">
            vence {diaMM(fatura.dueDay, fatura.mes)} · {fatura.itens.length}{' '}
            {fatura.itens.length === 1 ? 'compra' : 'compras'}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <span
            className={`text-[10px] rounded px-1.5 py-0.5 font-semibold ${
              paga ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
            }`}
          >
            {paga ? 'paga' : 'a pagar'}
          </span>
          <span className="font-mono text-sm font-bold text-gray-900">
            {formatCurrency(fatura.valor / 100)}
          </span>
        </div>
      </button>
      {open && (
        <div className="border-t border-rose-100 divide-y divide-gray-50">
          {fatura.itens.map((it) => (
            <div key={it.occKey} className="flex items-center gap-2 px-3 py-1.5 text-xs">
              <div className="flex-1 min-w-0">
                <span className="text-gray-800 truncate">{it.descricao || '—'}</span>
                {it.parcela && (
                  <span className="ml-1.5 text-[10px] font-semibold text-teal-700 bg-teal-100 rounded px-1 py-0.5">
                    {it.parcela}
                  </span>
                )}
                <span className="ml-1.5 text-[10px] text-gray-400">{formatDateBR(it.data)}</span>
              </div>
              <span className="font-mono text-gray-700">{formatCurrency(it.valor / 100)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Visão "Conta Real" (eixo de caixa): o que SAI da conta no mês — faturas dos
 * cartões (por vencimento, agregadas) + débitos diretos. Não lista as compras
 * individuais de cartão (ficam dentro da fatura, expandível).
 */
export function ContaRealView({
  months,
  tipoLabel,
  cardInfoByLast4,
  openEdit,
  onDelete,
  onToggleStatus,
}: {
  months: ContaRealMonth[];
  tipoLabel: (t: string) => string;
  cardInfoByLast4: Map<string, PersonalCardInfo>;
  openEdit: (e: Expense) => void;
  onDelete: (id: string) => void;
  onToggleStatus: (id: string, next: ExpenseStatus) => void;
}) {
  const visible = months.filter((m) => m.faturas.length > 0 || m.debitos.length > 0);
  if (visible.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
        Nada sai da conta neste período.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {visible.map((m) => (
        <div key={m.mes} className="rounded-xl border-2 border-rose-200 bg-rose-50/30 overflow-hidden">
          <div className="flex items-center gap-3 px-4 py-2.5 border-b border-rose-100">
            <span className="text-sm font-bold text-gray-900">Vence em {mesLabelFromKey(m.mes)}</span>
            <div className="ml-auto flex items-center gap-2 text-xs">
              <span className="text-rose-700">Faturas {formatCurrency(m.totalFaturas / 100)}</span>
              <span className="text-gray-300">·</span>
              <span className="text-sky-700">Débitos {formatCurrency(m.totalDebitos / 100)}</span>
              <span className="text-gray-300">=</span>
              <span className="font-mono font-bold text-gray-900">{formatCurrency(m.total / 100)}</span>
            </div>
          </div>

          <div className="p-3 space-y-3">
            {m.faturas.length > 0 && (
              <div className="space-y-2">
                {m.faturas.map((f) => (
                  <FaturaCard key={`${f.mes}__${f.cardLast4}`} fatura={f} />
                ))}
              </div>
            )}

            {m.debitos.length > 0 && (
              <div className="rounded-lg border border-sky-200 bg-white overflow-hidden">
                <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-sky-700 bg-sky-50">
                  Débitos da conta
                </div>
                {m.debitos.map((d) => {
                  const display: Expense = {
                    ...d.occ,
                    valorTotal: d.valor,
                    quantidadeParcela: 1,
                    dataInicioParcela: undefined,
                    dataPagamento: d.data,
                    status: d.status,
                  };
                  return (
                    <PersonalExpenseCard
                      key={d.occ.occKey}
                      expense={display}
                      tipoLabel={tipoLabel}
                      cardInfoByLast4={cardInfoByLast4}
                      cashMode="caixa"
                      onEdit={openEdit}
                      onDelete={onDelete}
                      onToggleStatus={onToggleStatus}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
