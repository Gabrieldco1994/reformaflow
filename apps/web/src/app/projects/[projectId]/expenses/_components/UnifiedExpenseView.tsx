'use client';
import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
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

interface Props {
  mode: UnifiedMode;
  expenses: Expense[];
  remoteMap: RemoteProjectMap;
  selfProjectId: string;
  selfProjectName: string;
  tipoLabel: (t: string) => string;
  openEdit: (e: Expense) => void;
  onDelete: (id: string) => void;
  onToggleStatus: (id: string, next: ExpenseStatus) => void;
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
  mode, expenses, remoteMap, selfProjectId, selfProjectName, tipoLabel, openEdit, onDelete, onToggleStatus,
}: Props) {
  const { data: cards = [] } = useQuery<TenantCardLite[]>({
    queryKey: ['tenant', 'credit-cards'],
    queryFn: () => api.get('/tenant/credit-cards'),
    staleTime: 60_000,
  });

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

  // Filtragem por origem é controlada pelo strip no topo da página — aqui apenas
  // agrupamos as despesas já recebidas (prop `expenses`).
  const projects = useMemo(
    () => groupPersonalExpenses(expenses, remoteMap, selfProjectName, selfProjectId),
    [expenses, remoteMap, selfProjectName, selfProjectId],
  );

  const months = useMemo(
    () => mode === 'month' ? groupByMonth(expenses, remoteMap, selfProjectName, selfProjectId) : [],
    [mode, expenses, remoteMap, selfProjectName, selfProjectId],
  );

  const tipos = useMemo(
    () => mode === 'category' ? groupByTipo(expenses, remoteMap, selfProjectName, tipoLabel, selfProjectId) : [],
    [mode, expenses, remoteMap, selfProjectName, tipoLabel, selfProjectId],
  );

  const body = (() => {
    if (expenses.length === 0) return <EmptyState />;

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

  return <div className="space-y-3">{body}</div>;
}
