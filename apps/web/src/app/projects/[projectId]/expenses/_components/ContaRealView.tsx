'use client';
import { useState } from 'react';
import { ChevronDown, ChevronRight, CreditCard, Landmark } from 'lucide-react';
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
    <div className="overflow-hidden rounded-xl border border-rose-200 bg-white shadow-sm shadow-rose-100/70">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left hover:bg-rose-50/60"
      >
        {open ? <ChevronDown className="w-4 h-4 text-rose-500" /> : <ChevronRight className="w-4 h-4 text-rose-500" />}
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-rose-100 to-violet-100 text-rose-700">
          <CreditCard className="h-4 w-4" />
        </span>
        <div className="min-w-0">
          <div className="text-[10px] font-bold uppercase tracking-wide text-rose-700">Fatura do cartão</div>
          <div className="text-sm font-semibold text-gray-900 truncate">{fatura.label}</div>
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
          <span className="font-mono text-sm font-bold text-rose-950">
            {formatCurrency(fatura.valor / 100)}
          </span>
        </div>
      </button>
      {open && (
        <div className="border-t border-rose-100 bg-rose-50/30 divide-y divide-rose-100/70">
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
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 border-b border-rose-100">
            <span className="text-sm font-bold text-gray-900 whitespace-nowrap">Vence em {mesLabelFromKey(m.mes)}</span>
            <div className="ml-auto flex items-center gap-2 text-xs">
              <span className="font-mono font-bold text-gray-900">{formatCurrency(m.total / 100)}</span>
            </div>
          </div>

          <div className="space-y-4 p-3 md:p-4">
            {m.faturas.length > 0 && (
              <section className="space-y-2.5" aria-label="Faturas do cartão">
                <div className="flex items-center gap-2 px-1">
                  <span className="h-2 w-2 rounded-full bg-rose-500" />
                  <h3 className="text-[11px] font-bold uppercase tracking-wide text-rose-800">Faturas do cartão</h3>
                  <span className="h-px flex-1 bg-rose-100" />
                </div>
                {m.faturas.map((f) => (
                  <FaturaCard key={`${f.mes}__${f.cardLast4}`} fatura={f} />
                ))}
              </section>
            )}

            {m.debitos.length > 0 && (
              <section className="space-y-2.5" aria-label="Débitos em conta">
                <div className="flex items-center gap-2 px-1">
                  <span className="h-2 w-2 rounded-full bg-sky-500" />
                  <h3 className="text-[11px] font-bold uppercase tracking-wide text-sky-800">Débitos em conta</h3>
                  <span className="h-px flex-1 bg-sky-100" />
                </div>
                <div className="overflow-hidden rounded-xl border border-sky-200 bg-sky-50/40 shadow-sm shadow-sky-100/60">
                  <div className="flex items-center gap-2 border-b border-sky-100 bg-sky-50 px-3 py-2 text-xs font-semibold text-sky-900">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-white text-sky-700 ring-1 ring-sky-100">
                      <Landmark className="h-4 w-4" />
                    </span>
                    <div className="min-w-0">
                      <div className="text-[10px] font-bold uppercase tracking-wide text-sky-700">Débito em conta</div>
                      <div className="truncate text-sm text-sky-950">Lançamentos que saem direto da conta</div>
                    </div>
                  </div>
                  <div className="space-y-1.5 p-1.5 md:space-y-2 md:p-2">
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
                </div>
              </section>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
