'use client';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CreditCard, Landmark } from 'lucide-react';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { isNeutralExpenseType } from '@reformaflow/domain';
import type { Expense } from '@/types';

export interface OriginChip {
  key: string;
  kind: 'CARTAO' | 'EXTRATO';
  last4: string;
  label: string;
  pago: number;
  planejado: number;
  count: number;
}

/** Chave de origem (cartão/conta) de uma despesa, ou null se for manual. */
export function originKeyOf(e: Expense): string | null {
  if (e.cardLast4) return `CARTAO:${e.cardLast4}`;
  if (e.bankLast4) return `EXTRATO:${e.bankLast4}`;
  return null;
}

/**
 * Valor que efetivamente impacta o período: despesas parceladas pagam só uma
 * parcela por mês, então usamos `valorTotal / quantidadeParcela`. À vista usa o total.
 */
function periodValue(e: Expense, split: boolean): number {
  const n = e.quantidadeParcela ?? 1;
  if (split && (e.formaPagamento === 'PARCELADO' || e.formaPagamento === 'QUINZENAL') && n > 1)
    return Math.round(e.valorTotal / n);
  return e.valorTotal;
}

export function deriveOriginChips(
  expenses: Expense[],
  cardLabels: Map<string, string>,
  accountLabels: Map<string, string>,
  split: boolean,
): OriginChip[] {
  const map = new Map<string, OriginChip>();
  for (const e of expenses) {
    // Pagamento de fatura é neutro (não é gasto real do cartão/conta) — fora dos chips.
    if (isNeutralExpenseType(e.tipoDespesa)) continue;
    let kind: 'CARTAO' | 'EXTRATO';
    let last4: string;
    if (e.cardLast4) { kind = 'CARTAO'; last4 = e.cardLast4; }
    else if (e.bankLast4) { kind = 'EXTRATO'; last4 = e.bankLast4; }
    else continue;
    const key = `${kind}:${last4}`;
    let chip = map.get(key);
    if (!chip) {
      const label = kind === 'CARTAO'
        ? (cardLabels.get(last4) ?? `Cartão ••${last4}`)
        : (accountLabels.get(last4) ?? `Conta ••${last4}`);
      chip = { key, kind, last4, label, pago: 0, planejado: 0, count: 0 };
      map.set(key, chip);
    }
    const v = periodValue(e, split);
    if (e.status === 'PAGO') chip.pago += v;
    else chip.planejado += v;
    chip.count++;
  }
  return Array.from(map.values()).sort((a, b) => (b.pago + b.planejado) - (a.pago + a.planejado));
}

/** Strip de chips por origem (cartão/conta), clicável para filtrar. Apresentacional. */
export function OriginChips({
  chips, selected, onSelect,
}: {
  chips: OriginChip[];
  selected: string | null;
  onSelect: (key: string | null) => void;
}) {
  if (chips.length === 0) return null;
  return (
    <div className="-mx-1 flex items-stretch gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:flex-wrap md:overflow-visible">
      {chips.map((c) => {
        const isActive = selected === c.key;
        const Icon = c.kind === 'CARTAO' ? CreditCard : Landmark;
        return (
          <button
            key={c.key}
            type="button"
            onClick={() => onSelect(isActive ? null : c.key)}
            className={`flex shrink-0 items-center gap-2.5 rounded-2xl border px-4 py-2.5 text-left transition-colors md:shrink ${
              isActive
                ? 'border-orange-500 bg-orange-500 text-white shadow-sm'
                : 'border-darc-linen bg-white text-darc-velvet hover:border-orange-300 hover:bg-orange-50'
            }`}
          >
            <Icon className={`h-5 w-5 shrink-0 ${isActive ? 'text-white' : 'text-orange-600'}`} />
            <div className="leading-tight">
              <div className="text-sm font-semibold whitespace-nowrap">{c.label}</div>
              <div className={`text-xs font-mono whitespace-nowrap ${isActive ? 'text-orange-50' : 'text-darc-velvet/50'}`}>
                {formatCurrency(c.pago / 100)} pago · {formatCurrency(c.planejado / 100)} plan.
              </div>
            </div>
          </button>
        );
      })}
      {selected && (
        <button
          type="button"
          onClick={() => onSelect(null)}
          className="shrink-0 self-center rounded-2xl border border-darc-linen bg-white px-4 py-2.5 text-sm font-medium text-darc-velvet/60 hover:bg-gray-50"
        >
          Limpar
        </button>
      )}
    </div>
  );
}

interface TenantCardLite { id: string; nickname?: string | null; brand: string; last4: string; }
interface TenantAccountLite { id: string; nickname?: string | null; institution: string; last4?: string | null; }

/**
 * Strip de origens AUTO-CONTIDO: busca cartões/contas do tenant, deriva os chips
 * a partir das despesas do período e expõe seleção controlada. Usado no topo da
 * tela de despesas do PESSOAL (visão Gastos Controle).
 */
export function OriginFilterStrip({
  expenses,
  selected,
  onSelect,
  split = false,
}: {
  expenses: Expense[];
  selected: string | null;
  onSelect: (key: string | null) => void;
  split?: boolean;
}) {
  const { data: cards = [] } = useQuery<TenantCardLite[]>({
    queryKey: ['tenant', 'credit-cards'],
    queryFn: () => api.get('/tenant/credit-cards'),
    staleTime: 60_000,
  });
  const { data: accounts = [] } = useQuery<TenantAccountLite[]>({
    queryKey: ['tenant', 'bank-accounts'],
    queryFn: () => api.get('/tenant/bank-accounts'),
    staleTime: 60_000,
  });

  const cardLabels = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of cards) if (c.last4 && !m.has(c.last4)) m.set(c.last4, `${c.nickname || c.brand} ••${c.last4}`);
    return m;
  }, [cards]);
  const accountLabels = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of accounts) if (a.last4 && !m.has(a.last4)) m.set(a.last4, `${a.nickname || a.institution} ••${a.last4}`);
    return m;
  }, [accounts]);

  const chips = useMemo(
    () => deriveOriginChips(expenses, cardLabels, accountLabels, split),
    [expenses, cardLabels, accountLabels, split],
  );

  // Se o chip selecionado deixar de existir (ex.: mudou o período), limpa.
  const safeSelected = selected && chips.some((c) => c.key === selected) ? selected : null;

  return <OriginChips chips={chips} selected={safeSelected} onSelect={onSelect} />;
}
