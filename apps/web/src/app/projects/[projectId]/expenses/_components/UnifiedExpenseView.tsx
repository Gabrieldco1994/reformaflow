'use client';
import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, CreditCard, Landmark } from 'lucide-react';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { isNeutralExpenseType } from '@reformaflow/domain';
import type { Expense, ExpenseStatus } from '@/types';
import {
  groupPersonalExpenses,
  groupByMonth,
  groupByTipo,
  type RemoteProjectMap,
} from '../_lib/personal-hierarchy';
import {
  ProjectCard,
  projectAccentOf,
} from './PersonalHierarchicalView';
import type { PersonalCardInfo } from './PersonalExpenseCard';

export type UnifiedMode = 'category' | 'month' | 'project';

interface TenantCardLite {
  id: string;
  nickname?: string | null;
  brand: string;
  last4: string;
  closingDay?: number | null;
  dueDay?: number | null;
}
interface TenantAccountLite { id: string; nickname?: string | null; institution: string; last4?: string | null; }

interface Props {
  mode: UnifiedMode;
  expenses: Expense[];
  remoteMap: RemoteProjectMap;
  selfProjectId: string;
  selfProjectName: string;
  /** Quando true (mês específico selecionado), parceladas contam só 1 parcela nos chips. */
  splitInstallments?: boolean;
  tipoLabel: (t: string) => string;
  openEdit: (e: Expense) => void;
  onDelete: (id: string) => void;
  onToggleStatus: (id: string, next: ExpenseStatus) => void;
}

interface OriginChip {
  key: string;
  kind: 'CARTAO' | 'EXTRATO';
  last4: string;
  label: string;
  pago: number;
  planejado: number;
  count: number;
}

/** Chave de origem (cartão/conta) de uma despesa, ou null se for manual. */
function originKeyOf(e: Expense): string | null {
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

function deriveOriginChips(
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

function OriginChips({
  chips, selected, onSelect,
}: {
  chips: OriginChip[];
  selected: string | null;
  onSelect: (key: string | null) => void;
}) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-stretch gap-2">
      {chips.map((c) => {
        const isActive = selected === c.key;
        const Icon = c.kind === 'CARTAO' ? CreditCard : Landmark;
        return (
          <button
            key={c.key}
            type="button"
            onClick={() => onSelect(isActive ? null : c.key)}
            className={`flex items-center gap-2.5 rounded-xl border px-4 py-2.5 text-left transition-colors ${
              isActive
                ? 'border-teal-600 bg-teal-600 text-white shadow-sm'
                : 'border-gray-200 bg-white text-gray-700 hover:border-teal-400 hover:bg-teal-50'
            }`}
          >
            <Icon className={`h-5 w-5 shrink-0 ${isActive ? 'text-white' : 'text-teal-600'}`} />
            <div className="leading-tight">
              <div className="text-sm font-semibold">{c.label}</div>
              <div className={`text-xs font-mono ${isActive ? 'text-teal-50' : 'text-gray-500'}`}>
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
          className="self-center rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50"
        >
          Limpar filtro
        </button>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
      Nenhuma despesa no período selecionado.
    </div>
  );
}

function ProjectsList({
  projects, tipoLabel, cardInfoByLast4, openEdit, onDelete, onToggleStatus,
}: {
  projects: ReturnType<typeof groupPersonalExpenses>;
  tipoLabel: (t: string) => string;
  cardInfoByLast4: Map<string, PersonalCardInfo>;
  openEdit: (e: Expense) => void;
  onDelete: (id: string) => void;
  onToggleStatus: (id: string, next: ExpenseStatus) => void;
}) {
  return (
    <div className="space-y-2">
      {projects.map((pg) => (
        <ProjectCard
          key={pg.projectKey}
          pg={pg}
          accent={projectAccentOf(pg.projectType)}
          tipoLabel={tipoLabel}
          cardInfoByLast4={cardInfoByLast4}
          openEdit={openEdit}
          onDelete={onDelete}
          onToggleStatus={onToggleStatus}
        />
      ))}
    </div>
  );
}

function TopShell({
  title, badgeTone, count, pago, planejado, defaultOpen, children,
}: {
  title: string;
  badgeTone: 'orange' | 'emerald' | 'indigo';
  count: number;
  pago: number;
  planejado: number;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const total = pago + planejado;
  const accent =
    badgeTone === 'orange' ? 'border-orange-300 bg-orange-50/40'
      : badgeTone === 'emerald' ? 'border-emerald-300 bg-emerald-50/40'
      : 'border-indigo-300 bg-indigo-50/40';
  return (
    <div className={`rounded-xl border-2 ${accent} overflow-hidden shadow-sm`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/60"
      >
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        <span className="font-bold text-gray-900 text-sm">{title}</span>
        <span className="text-xs text-gray-500">{count} itens</span>
        <div className="ml-auto flex items-center gap-3 text-xs">
          <span className="text-emerald-700 font-mono">{formatCurrency(pago / 100)}</span>
          <span className="text-gray-300">·</span>
          <span className="text-amber-700 font-mono">{formatCurrency(planejado / 100)}</span>
          <span className="text-gray-300">=</span>
          <span className="font-mono font-bold text-gray-900">{formatCurrency(total / 100)}</span>
        </div>
      </button>
      {open && <div className="p-3 bg-white/40">{children}</div>}
    </div>
  );
}

export function UnifiedExpenseView({
  mode, expenses, remoteMap, selfProjectId, selfProjectName, splitInstallments = false, tipoLabel, openEdit, onDelete, onToggleStatus,
}: Props) {
  const [selectedOrigin, setSelectedOrigin] = useState<string | null>(null);

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
  const cardInfoByLast4 = useMemo(() => {
    const m = new Map<string, PersonalCardInfo>();
    for (const c of cards) {
      if (!c.last4 || m.has(c.last4)) continue;
      m.set(c.last4, {
        label: `${c.nickname || c.brand} ••${c.last4}`,
        closingDay: c.closingDay ?? null,
        dueDay: c.dueDay ?? null,
      });
    }
    return m;
  }, [cards]);
  const accountLabels = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of accounts) if (a.last4 && !m.has(a.last4)) m.set(a.last4, `${a.nickname || a.institution} ••${a.last4}`);
    return m;
  }, [accounts]);

  const chips = useMemo(
    () => deriveOriginChips(expenses, cardLabels, accountLabels, splitInstallments),
    [expenses, cardLabels, accountLabels, splitInstallments],
  );

  // Se o chip selecionado deixar de existir (ex.: mudou o período), limpa.
  const selected = selectedOrigin && chips.some((c) => c.key === selectedOrigin) ? selectedOrigin : null;

  const filteredExpenses = useMemo(
    () => selected ? expenses.filter((e) => originKeyOf(e) === selected) : expenses,
    [expenses, selected],
  );

  const projects = useMemo(
    () => groupPersonalExpenses(filteredExpenses, remoteMap, selfProjectName, selfProjectId),
    [filteredExpenses, remoteMap, selfProjectName, selfProjectId],
  );

  const months = useMemo(
    () => mode === 'month' ? groupByMonth(filteredExpenses, remoteMap, selfProjectName, selfProjectId) : [],
    [mode, filteredExpenses, remoteMap, selfProjectName, selfProjectId],
  );

  const tipos = useMemo(
    () => mode === 'category' ? groupByTipo(filteredExpenses, remoteMap, selfProjectName, tipoLabel, selfProjectId) : [],
    [mode, filteredExpenses, remoteMap, selfProjectName, tipoLabel, selfProjectId],
  );

  const body = (() => {
    if (filteredExpenses.length === 0) return <EmptyState />;

    if (mode === 'project') {
      return (
        <ProjectsList
          projects={projects}
          tipoLabel={tipoLabel}
          cardInfoByLast4={cardInfoByLast4}
          openEdit={openEdit}
          onDelete={onDelete}
          onToggleStatus={onToggleStatus}
        />
      );
    }

    if (mode === 'month') {
      return (
        <div className="space-y-3">
          {months.map((mg, idx) => (
            <TopShell
              key={mg.ym}
              title={mg.label}
              badgeTone="indigo"
              count={mg.count}
              pago={mg.totalPago}
              planejado={mg.totalPlanejado}
              defaultOpen={idx === 0}
            >
              <ProjectsList
                projects={mg.projects}
                tipoLabel={tipoLabel}
                cardInfoByLast4={cardInfoByLast4}
                openEdit={openEdit}
                onDelete={onDelete}
                onToggleStatus={onToggleStatus}
              />
            </TopShell>
          ))}
        </div>
      );
    }

    // category
    return (
      <div className="space-y-3">
        {tipos.map((tg, idx) => (
          <TopShell
            key={tg.tipo}
            title={tg.label}
            badgeTone="emerald"
            count={tg.count}
            pago={tg.totalPago}
            planejado={tg.totalPlanejado}
            defaultOpen={idx === 0}
          >
            <ProjectsList
              projects={tg.projects}
              tipoLabel={tipoLabel}
              cardInfoByLast4={cardInfoByLast4}
              openEdit={openEdit}
              onDelete={onDelete}
              onToggleStatus={onToggleStatus}
            />
          </TopShell>
        ))}
      </div>
    );
  })();

  if (expenses.length === 0) return <EmptyState />;

  return (
    <div className="space-y-3">
      <OriginChips chips={chips} selected={selected} onSelect={setSelectedOrigin} />
      {body}
    </div>
  );
}
