'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  Bell,
  Wallet,
  Receipt,
  CalendarClock,
  CreditCard,
  Wrench,
  AlertCircle,
} from 'lucide-react';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { Modal } from '@/components/ui/modal';
import { useProjectOptional } from '@/contexts/project-context';
import type { DailySummary, SummaryItem } from './types';

interface NotificationsBellProps {
  variant?: 'light' | 'dark';
  className?: string;
}

const KIND_ROUTES: Record<string, string> = {
  gasto: 'expenses',
  recebimento: 'receipts',
  vencimento: 'cash-flow',
  tarefa: 'schedule',
  conta: 'bills',
  lembrete: 'reminders',
  manutencao: 'maintenance',
};

const PROJECT_DEFAULT_ROUTE: Record<string, string> = {
  REFORMA: 'dashboard', COMPRA: 'dashboard', PESSOAL: 'monthly',
  CASA: 'dashboard', CARRO: 'dashboard', PLANTAS: 'dashboard',
};

type Kind = 'gasto' | 'recebimento' | 'tarefa' | 'conta' | 'lembrete' | 'manutencao' | 'vencimento';

function routeForItem(item: SummaryItem, kind: Kind): string {
  const base = `/projects/${item.projectId}`;
  return `${base}/${KIND_ROUTES[kind] ?? PROJECT_DEFAULT_ROUTE[item.projectType] ?? 'dashboard'}`;
}

function formatDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

/** Filter all DailySummary arrays to a single project. */
function filterToProject(data: DailySummary, projectId: string): DailySummary {
  const f = <T extends SummaryItem>(arr: T[]) => arr.filter(i => i.projectId === projectId);
  const gastos = f(data.hoje.gastos.items);
  const recebimentos = f(data.hoje.recebimentos.items);
  const hoje = {
    gastos: {
      items: gastos,
      count: gastos.length,
      total: gastos.reduce((s, i) => s + (i.valor ?? 0), 0),
    },
    recebimentos: {
      items: recebimentos,
      count: recebimentos.length,
      total: recebimentos.reduce((s, i) => s + (i.valor ?? 0), 0),
    },
    tarefasAtivas: f(data.hoje.tarefasAtivas),
    vencendoHoje: f(data.hoje.vencendoHoje),
  };
  const prox = {
    vencimentos: f(data.proximos7Dias.vencimentos),
    tarefasComecando: f(data.proximos7Dias.tarefasComecando),
    lembretes: f(data.proximos7Dias.lembretes),
    manutencoes: f(data.proximos7Dias.manutencoes),
    contasRecorrentes: f(data.proximos7Dias.contasRecorrentes),
  };
  const totalBadge =
    hoje.vencendoHoje.length + hoje.tarefasAtivas.length +
    prox.vencimentos.length + prox.lembretes.length +
    prox.manutencoes.length + prox.contasRecorrentes.length + prox.tarefasComecando.length;
  return { ...data, hoje, proximos7Dias: prox, totalBadge };
}

export function NotificationsBell({ variant = 'dark', className = '' }: NotificationsBellProps) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const project = useProjectOptional();
  const projectId = project?.projectId ?? null;
  const projectName = project?.projectName ?? 'Notificações';

  const { data, isLoading } = useQuery<DailySummary>({
    queryKey: ['notifications', 'daily-summary'],
    queryFn: () => api.get<DailySummary>('/notifications/daily-summary'),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  // ponytail: filter client-side — avoids API change, data already cached globally
  const filtered = data && projectId ? filterToProject(data, projectId) : data;
  const badge = filtered?.totalBadge ?? 0;
  const isDark = variant === 'dark';

  function go(item: SummaryItem, kind: Kind) {
    setOpen(false);
    router.push(routeForItem(item, kind));
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Notificações${badge > 0 ? ` (${badge})` : ''}`}
        className={`relative p-2 rounded-full transition-colors ${
          isDark
            ? 'text-darc-linen/80 hover:text-darc-linen hover:bg-white/10'
            : 'text-darc-velvet/70 hover:bg-darc-linen/60'
        } ${className}`}
      >
        <Bell className="w-5 h-5" />
        {badge > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-darc-red text-white text-[10px] font-semibold leading-none">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title={projectName} size="md">
        {isLoading ? (
          <div className="py-10 flex justify-center">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-darc-red" />
          </div>
        ) : !filtered ? (
          <p className="text-sm text-darc-velvet/60 text-center py-6">
            Não foi possível carregar o resumo.
          </p>
        ) : (
          <SummaryContent data={filtered} onItem={go} />
        )}
      </Modal>
    </>
  );
}

function SummaryContent({
  data,
  onItem,
}: {
  data: DailySummary;
  onItem: (item: SummaryItem, kind: Kind) => void;
}) {
  const hoje = data.hoje;
  const prox = data.proximos7Dias;

  const isEmpty =
    hoje.gastos.count === 0 &&
    hoje.recebimentos.count === 0 &&
    hoje.tarefasAtivas.length === 0 &&
    hoje.vencendoHoje.length === 0 &&
    prox.vencimentos.length === 0 &&
    prox.tarefasComecando.length === 0 &&
    prox.lembretes.length === 0 &&
    prox.manutencoes.length === 0 &&
    prox.contasRecorrentes.length === 0;

  if (isEmpty) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-center">
        <Bell className="w-8 h-8 text-darc-velvet/20" />
        <p className="text-sm text-darc-velvet/50">Nada pra hoje nem nos próximos 7 dias.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5 safe-pb">
      <section>
        <SectionLabel>Hoje</SectionLabel>

        {(hoje.gastos.count > 0 || hoje.recebimentos.count > 0) && (
          <div className="grid grid-cols-2 gap-2 mb-3">
            {hoje.gastos.count > 0 && (
              <StatCard label="Gastos" total={hoje.gastos.total} count={hoje.gastos.count} />
            )}
            {hoje.recebimentos.count > 0 && (
              <StatCard label="Recebimentos" total={hoje.recebimentos.total} count={hoje.recebimentos.count} />
            )}
          </div>
        )}

        {hoje.vencendoHoje.length > 0 && (
          <Group title="Vencendo hoje" icon={<AlertCircle className="w-4 h-4 text-darc-red" />}>
            {hoje.vencendoHoje.map((item) => (
              <Item key={item.id} item={item} onClick={() => onItem(item, 'vencimento')} />
            ))}
          </Group>
        )}

        {hoje.tarefasAtivas.length > 0 && (
          <Group title="Tarefas em andamento" icon={<CalendarClock className="w-4 h-4 text-darc-velvet/60" />}>
            {hoje.tarefasAtivas.map((item) => (
              <Item key={item.id} item={item} onClick={() => onItem(item, 'tarefa')} />
            ))}
          </Group>
        )}

        {hoje.gastos.items.length > 0 && (
          <Group title="Gastos de hoje" icon={<Receipt className="w-4 h-4 text-darc-velvet/60" />}>
            {hoje.gastos.items.slice(0, 5).map((item) => (
              <Item key={item.id} item={item} onClick={() => onItem(item, 'gasto')} />
            ))}
          </Group>
        )}

        {hoje.recebimentos.items.length > 0 && (
          <Group title="Recebimentos de hoje" icon={<Wallet className="w-4 h-4 text-darc-velvet/60" />}>
            {hoje.recebimentos.items.slice(0, 5).map((item) => (
              <Item key={item.id} item={item} onClick={() => onItem(item, 'recebimento')} />
            ))}
          </Group>
        )}
      </section>

      {(prox.vencimentos.length > 0 ||
        prox.contasRecorrentes.length > 0 ||
        prox.tarefasComecando.length > 0 ||
        prox.lembretes.length > 0 ||
        prox.manutencoes.length > 0) && (
        <section>
          <SectionLabel>Próximos 7 dias</SectionLabel>

          {prox.vencimentos.length > 0 && (
            <Group title="Vencimentos" icon={<CreditCard className="w-4 h-4 text-darc-velvet/60" />}>
              {prox.vencimentos.slice(0, 8).map((item) => (
                <Item key={item.id} item={item} onClick={() => onItem(item, 'vencimento')} showDate />
              ))}
            </Group>
          )}

          {prox.contasRecorrentes.length > 0 && (
            <Group title="Contas recorrentes" icon={<CreditCard className="w-4 h-4 text-darc-velvet/60" />}>
              {prox.contasRecorrentes.slice(0, 8).map((item) => (
                <Item key={item.id} item={item} onClick={() => onItem(item, 'conta')} showDate />
              ))}
            </Group>
          )}

          {prox.tarefasComecando.length > 0 && (
            <Group title="Tarefas começando" icon={<CalendarClock className="w-4 h-4 text-darc-velvet/60" />}>
              {prox.tarefasComecando.slice(0, 8).map((item) => (
                <Item key={item.id} item={item} onClick={() => onItem(item, 'tarefa')} showDate />
              ))}
            </Group>
          )}

          {prox.lembretes.length > 0 && (
            <Group title="Lembretes" icon={<Bell className="w-4 h-4 text-darc-velvet/60" />}>
              {prox.lembretes.slice(0, 8).map((item) => (
                <Item key={item.id} item={item} onClick={() => onItem(item, 'lembrete')} showDate />
              ))}
            </Group>
          )}

          {prox.manutencoes.length > 0 && (
            <Group title="Manutenções" icon={<Wrench className="w-4 h-4 text-darc-velvet/60" />}>
              {prox.manutencoes.slice(0, 8).map((item) => (
                <Item key={item.id} item={item} onClick={() => onItem(item, 'manutencao')} showDate />
              ))}
            </Group>
          )}
        </section>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[10px] tracking-[0.2em] uppercase text-darc-velvet/50 mb-2 px-1">
      {children}
    </h3>
  );
}

function StatCard({ label, total, count }: { label: string; total: number; count: number }) {
  return (
    <div className="rounded-xl border border-darc-linen bg-darc-linen/20 p-3 min-w-0">
      <p className="text-[10px] uppercase tracking-wider text-darc-velvet/50 truncate">{label}</p>
      <p className="font-editorial italic text-lg text-darc-maroon leading-tight">
        {formatCurrency(total / 100)}
      </p>
      <p className="text-xs text-darc-velvet/50">
        {count} {count === 1 ? 'lançamento' : 'lançamentos'}
      </p>
    </div>
  );
}

function Group({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2 mb-1 px-1">
        {icon}
        <p className="text-xs font-semibold text-darc-velvet/70">{title}</p>
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function Item({ item, onClick, showDate = false }: { item: SummaryItem; onClick: () => void; showDate?: boolean }) {
  const sub = [showDate ? formatDateShort(item.data) : null, item.meta].filter(Boolean).join(' · ');
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-darc-linen/40 active:bg-darc-linen/60 transition-colors min-h-[44px]"
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm text-darc-velvet truncate leading-snug">{item.titulo}</p>
        {sub && <p className="text-[11px] text-darc-velvet/50 truncate mt-0.5">{sub}</p>}
      </div>
      {item.valor !== undefined && (
        <span className="text-sm font-medium text-darc-maroon flex-shrink-0 tabular-nums">
          {formatCurrency(item.valor / 100)}
        </span>
      )}
    </button>
  );
}
