'use client';

import { useMemo, useState } from 'react';
import { CreditCard, Landmark, Layers } from 'lucide-react';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import { tipoLabel } from '@/lib/expense-options';
import type { OriginItemsYearlyResponse } from '../_types';

const MONTH_LABELS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

function monthLabel(mes: string) {
  const month = parseInt(mes.slice(5, 7), 10);
  return MONTH_LABELS[month - 1] ?? mes;
}

/**
 * Lista "Todos" da Visão Conta (ano): todas as despesas de todas as origens no
 * ano, com filtros de tipo de despesa e mês. Mesma base do gráfico anual (regras
 * de neutro/mês aplicadas no backend, kind='all'). Cada item mostra sua origem.
 */
export function TodasDespesasAno({
  data,
  isLoading,
  year,
}: {
  data: OriginItemsYearlyResponse | undefined;
  isLoading: boolean;
  year: string | number;
}) {
  const [tipo, setTipo] = useState<string>('');
  const [mes, setMes] = useState<string>('');

  const allItems = data?.items ?? [];

  // Opções de tipo (código → label amigável), distintas e ordenadas.
  const tipoOptions = useMemo(() => {
    const set = new Set(allItems.map((i) => i.tipoDespesa));
    return Array.from(set)
      .map((code) => ({ code, label: tipoLabel(code) }))
      .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
  }, [allItems]);

  const mesesDisponiveis = useMemo(() => {
    const set = new Set(allItems.map((i) => i.mes));
    return Array.from(set).sort();
  }, [allItems]);

  const filtered = useMemo(() => {
    let list = allItems;
    if (tipo) list = list.filter((i) => i.tipoDespesa === tipo);
    if (mes) list = list.filter((i) => i.mes === mes);
    return list;
  }, [allItems, tipo, mes]);

  const byMonth = useMemo(() => {
    const map = new Map<string, OriginItemsYearlyResponse['items']>();
    for (const item of filtered) {
      const list = map.get(item.mes) ?? [];
      list.push(item);
      map.set(item.mes, list);
    }
    return map;
  }, [filtered]);

  const months = useMemo(() => Array.from(byMonth.keys()).sort((a, b) => b.localeCompare(a)), [byMonth]);
  const total = useMemo(() => filtered.reduce((s, i) => s + i.valor, 0), [filtered]);

  const selectCls =
    'rounded-lg border border-lifeone-hairline bg-lifeone-card px-2 py-1 text-[11px] text-lifeone-ink-2 outline-none';

  return (
    <section className="space-y-3 rounded-2xl border border-lifeone-hairline bg-lifeone-card p-4 shadow-lifeone-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-lifeone-surface text-lifeone-ink-2">
            <Layers className="h-4 w-4" />
          </span>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-lifeone-ink-3">
              Todas as despesas · {year}
            </p>
            <p className="text-sm text-lifeone-ink-3">
              {filtered.length} lançamento{filtered.length === 1 ? '' : 's'} · todas as origens
            </p>
          </div>
        </div>
        <p className="shrink-0 text-base font-bold text-lifeone-ink font-geist tabular-nums">
          {formatCurrency(total / 100)}
        </p>
      </div>

      {/* Filtros: tipo de despesa + mês */}
      <div className="flex flex-wrap items-center gap-2">
        <select value={tipo} onChange={(e) => setTipo(e.target.value)} className={selectCls} aria-label="Tipo de despesa">
          <option value="">Todos os tipos</option>
          {tipoOptions.map((o) => (
            <option key={o.code} value={o.code}>{o.label}</option>
          ))}
        </select>
        <select value={mes} onChange={(e) => setMes(e.target.value)} className={selectCls} aria-label="Mês">
          <option value="">Todos os meses</option>
          {mesesDisponiveis.map((m) => (
            <option key={m} value={m}>{monthLabel(m)} · {m.slice(0, 4)}</option>
          ))}
        </select>
        {(tipo || mes) && (
          <button
            type="button"
            onClick={() => {
              setTipo('');
              setMes('');
            }}
            className="text-[11px] font-semibold text-lifeone-blue hover:underline"
          >
            limpar
          </button>
        )}
      </div>

      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="h-10 animate-pulse rounded-lg bg-lifeone-surface" />
          ))}
        </div>
      )}

      {!isLoading && months.length === 0 && (
        <div className="flex h-24 items-center justify-center rounded-xl bg-lifeone-surface text-sm text-lifeone-ink-3">
          Nenhuma despesa para os filtros selecionados.
        </div>
      )}

      {!isLoading && months.length > 0 && (
        <div className="space-y-3">
          {months.map((m) => {
            const items = byMonth.get(m)!;
            const subtotal = items.reduce((sum, item) => sum + item.valor, 0);
            return (
              <div key={m} className="overflow-hidden rounded-xl border border-lifeone-hairline-3">
                <div className="flex items-center justify-between bg-lifeone-surface px-3 py-1.5">
                  <span className="text-[11px] font-bold uppercase tracking-wide text-lifeone-ink-2">
                    {monthLabel(m)} · {m.slice(0, 4)}
                  </span>
                  <span className="text-xs font-semibold text-lifeone-ink-2">{formatCurrency(subtotal / 100)}</span>
                </div>
                <ul className="divide-y divide-lifeone-hairline-3">
                  {items.map((item, index) => {
                    const OriginIcon = item.origem?.kind === 'conta' ? Landmark : CreditCard;
                    return (
                      <li key={`${m}-${index}`} className="flex items-center justify-between gap-3 px-3 py-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm text-lifeone-ink">{item.descricao}</p>
                          <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-lifeone-ink-4">
                            {formatDateBR(item.data)}
                            <span className="inline-flex items-center gap-1 text-lifeone-ink-3">
                              <OriginIcon className="h-3 w-3" />
                              {item.origem ? `${item.origem.nickname} · ${item.origem.last4}` : '—'}
                            </span>
                            <span className="rounded-full bg-lifeone-surface px-1.5 py-px font-medium text-lifeone-ink-3">
                              {tipoLabel(item.tipoDespesa)}
                            </span>
                            {item.status !== 'PAGO' && (
                              <span className="rounded-full bg-[#FBEBDC] px-1.5 py-px font-medium text-[#B5803A]">
                                {item.status === 'PLANEJADO' ? 'planejado' : item.status.toLowerCase()}
                              </span>
                            )}
                            {item.projetoOrigem && item.projetoOrigem.type !== 'PESSOAL' && (
                              <span className="rounded-full bg-[#E6EFFE] px-1.5 py-px font-medium text-lifeone-blue">
                                {item.projetoOrigem.name}
                              </span>
                            )}
                          </p>
                        </div>
                        <span
                          className={`shrink-0 text-sm font-semibold tabular-nums font-geist ${
                            item.valor < 0 ? 'text-[#1E924A]' : 'text-lifeone-ink'
                          }`}
                        >
                          {formatCurrency(item.valor / 100)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
