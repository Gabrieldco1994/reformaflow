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
import type { DailySummary, SummaryItem } from './types';

interface NotificationsBellProps {
  variant?: 'light' | 'dark';
  className?: string;
}

const PROJECT_DEFAULT_ROUTE: Record<string, string> = {
  REFORMA: 'dashboard',
  COMPRA: 'dashboard',
  PESSOAL: 'monthly',
  CASA: 'dashboard',
  CARRO: 'dashboard',
  PLANTAS: 'dashboard',
};

function routeForItem(
  item: SummaryItem,
  kind:
    | 'gasto'
    | 'recebimento'
    | 'tarefa'
    | 'conta'
    | 'lembrete'
    | 'manutencao'
    | 'vencimento',
): string {
  const base = `/projects/${item.projectId}`;
  switch (kind) {
    case 'gasto':
      return `${base}/expenses`;
    case 'recebimento':
      return `${base}/receipts`;
    case 'vencimento':
      return `${base}/cash-flow`;
    case 'tarefa':
      return `${base}/schedule`;
    case 'conta':
      return `${base}/bills`;
    case 'lembrete':
      return `${base}/reminders`;
    case 'manutencao':
      return `${base}/maintenance`;
    default:
      return `${base}/${PROJECT_DEFAULT_ROUTE[item.projectType] ?? 'dashboard'}`;
  }
}

function formatDateShort(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

export function NotificationsBell({
  variant = 'dark',
  className = '',
}: NotificationsBellProps) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  const { data, isLoading } = useQuery<DailySummary>({
    queryKey: ['notifications', 'daily-summary'],
    queryFn: () => api.get<DailySummary>('/notifications/daily-summary'),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  const badge = data?.totalBadge ?? 0;
  const isDark = variant === 'dark';

  function go(item: SummaryItem, kind: Parameters<typeof routeForItem>[1]) {
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

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Resumo do Dia"
        size="md"
      >
        {isLoading ? (
          <div className="py-10 flex justify-center">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-darc-red" />
          </div>
        ) : !data ? (
          <p className="text-sm text-darc-velvet/60 text-center py-6">
            Não foi possível carregar o resumo.
          </p>
        ) : (
          <SummaryContent data={data} onItem={go} />
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
  onItem: (
    item: SummaryItem,
    kind: Parameters<typeof routeForItem>[1],
  ) => void;
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
      <p className="text-sm text-darc-velvet/60 text-center py-6">
        Nada pra hoje nem nos próximos 7 dias. ✨
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <section>
        <h3 className="text-[10px] tracking-[0.2em] uppercase text-darc-velvet/60 mb-2">
          Hoje
        </h3>

        {(hoje.gastos.count > 0 || hoje.recebimentos.count > 0) && (
          <div className="grid grid-cols-2 gap-2 mb-3">
            <div className="rounded-xl border border-darc-linen p-3">
              <p className="text-[10px] uppercase tracking-wider text-darc-velvet/60">
                Gastos
              </p>
              <p className="font-editorial italic text-lg text-darc-maroon">
                {formatCurrency(hoje.gastos.total / 100)}
              </p>
              <p className="text-xs text-darc-velvet/60">
                {hoje.gastos.count} {hoje.gastos.count === 1 ? 'lançamento' : 'lançamentos'}
              </p>
            </div>
            <div className="rounded-xl border border-darc-linen p-3">
              <p className="text-[10px] uppercase tracking-wider text-darc-velvet/60">
                Recebimentos
              </p>
              <p className="font-editorial italic text-lg text-darc-maroon">
                {formatCurrency(hoje.recebimentos.total / 100)}
              </p>
              <p className="text-xs text-darc-velvet/60">
                {hoje.recebimentos.count} {hoje.recebimentos.count === 1 ? 'lançamento' : 'lançamentos'}
              </p>
            </div>
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
          <Group title="Tarefas em andamento" icon={<CalendarClock className="w-4 h-4 text-darc-velvet/70" />}>
            {hoje.tarefasAtivas.map((item) => (
              <Item key={item.id} item={item} onClick={() => onItem(item, 'tarefa')} />
            ))}
          </Group>
        )}

        {hoje.gastos.items.length > 0 && (
          <Group title="Gastos de hoje" icon={<Receipt className="w-4 h-4 text-darc-velvet/70" />}>
            {hoje.gastos.items.slice(0, 5).map((item) => (
              <Item key={item.id} item={item} onClick={() => onItem(item, 'gasto')} />
            ))}
          </Group>
        )}

        {hoje.recebimentos.items.length > 0 && (
          <Group title="Recebimentos de hoje" icon={<Wallet className="w-4 h-4 text-darc-velvet/70" />}>
            {hoje.recebimentos.items.slice(0, 5).map((item) => (
              <Item key={item.id} item={item} onClick={() => onItem(item, 'recebimento')} />
            ))}
          </Group>
        )}
      </section>

      <section>
        <h3 className="text-[10px] tracking-[0.2em] uppercase text-darc-velvet/60 mb-2">
          Próximos 7 dias
        </h3>

        {prox.vencimentos.length > 0 && (
          <Group title="Vencimentos" icon={<CreditCard className="w-4 h-4 text-darc-velvet/70" />}>
            {prox.vencimentos.slice(0, 8).map((item) => (
              <Item key={item.id} item={item} onClick={() => onItem(item, 'vencimento')} showDate />
            ))}
          </Group>
        )}

        {prox.contasRecorrentes.length > 0 && (
          <Group title="Contas recorrentes" icon={<CreditCard className="w-4 h-4 text-darc-velvet/70" />}>
            {prox.contasRecorrentes.slice(0, 8).map((item) => (
              <Item key={item.id} item={item} onClick={() => onItem(item, 'conta')} showDate />
            ))}
          </Group>
        )}

        {prox.tarefasComecando.length > 0 && (
          <Group title="Tarefas começando" icon={<CalendarClock className="w-4 h-4 text-darc-velvet/70" />}>
            {prox.tarefasComecando.slice(0, 8).map((item) => (
              <Item key={item.id} item={item} onClick={() => onItem(item, 'tarefa')} showDate />
            ))}
          </Group>
        )}

        {prox.lembretes.length > 0 && (
          <Group title="Lembretes" icon={<Bell className="w-4 h-4 text-darc-velvet/70" />}>
            {prox.lembretes.slice(0, 8).map((item) => (
              <Item key={item.id} item={item} onClick={() => onItem(item, 'lembrete')} showDate />
            ))}
          </Group>
        )}

        {prox.manutencoes.length > 0 && (
          <Group title="Manutenções" icon={<Wrench className="w-4 h-4 text-darc-velvet/70" />}>
            {prox.manutencoes.slice(0, 8).map((item) => (
              <Item key={item.id} item={item} onClick={() => onItem(item, 'manutencao')} showDate />
            ))}
          </Group>
        )}
      </section>
    </div>
  );
}

function Group({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2 mb-1.5 px-1">
        {icon}
        <p className="text-xs font-medium text-darc-velvet/80">{title}</p>
      </div>
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Item({
  item,
  onClick,
  showDate = false,
}: {
  item: SummaryItem;
  onClick: () => void;
  showDate?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-darc-linen/40 active:bg-darc-linen/60 transition-colors"
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm text-darc-velvet truncate">{item.titulo}</p>
        <p className="text-[11px] text-darc-velvet/60 truncate">
          {item.projectName}
          {showDate ? ` · ${formatDateShort(item.data)}` : ''}
          {item.meta ? ` · ${item.meta}` : ''}
        </p>
      </div>
      {item.valor !== undefined && (
        <span className="text-sm font-medium text-darc-maroon flex-shrink-0">
          {formatCurrency(item.valor / 100)}
        </span>
      )}
    </button>
  );
}
