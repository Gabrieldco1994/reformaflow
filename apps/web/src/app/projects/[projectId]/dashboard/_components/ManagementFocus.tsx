'use client';

import { useId, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ChevronDown } from 'lucide-react';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import {
  BillCategoryLabels, BillFrequencyLabels,
  ReminderPriorityLabels,
} from '@reformaflow/domain';
import type { Bill, Maintenance, Reminder } from './ManagementDashboard';

function Disclosure({
  title,
  summary,
  href,
  hrefLabel,
  children,
}: {
  title: string;
  summary: ReactNode;
  href: string;
  hrefLabel: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const controlsId = `${useId()}-panel`;

  return (
    <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen overflow-hidden">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={controlsId}
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-[44px] w-full items-center justify-between gap-3 p-4 text-left"
      >
        <span className="min-w-0">
          <span className="block font-editorial italic text-darc-velvet">{title}</span>
          <span className="mt-0.5 block text-xs text-darc-velvet/60">{summary}</span>
        </span>
        <ChevronDown
          className={`h-5 w-5 shrink-0 text-darc-velvet/60 transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div id={controlsId} className="border-t border-darc-linen p-4 pt-3">
          {children}
          <Link
            href={href}
            className="mt-3 inline-flex min-h-[44px] items-center text-sm font-medium text-darc-red hover:underline"
          >
            {hrefLabel} →
          </Link>
        </div>
      )}
    </div>
  );
}

export default function ManagementFocus({
  projectId,
  activeBills,
  upcomingMaintenance,
  pendingReminders,
  today,
}: {
  projectId: string;
  activeBills: Bill[];
  upcomingMaintenance: Maintenance[];
  pendingReminders: Reminder[];
  today: Date;
}) {
  return (
    <div className="space-y-3">
      <Disclosure
        title="📋 Contas Recorrentes"
        summary={activeBills.length === 0 ? 'Nenhuma conta cadastrada' : `${activeBills.length} ativas`}
        href={`/projects/${projectId}/bills`}
        hrefLabel="Ver todas as contas"
      >
        {activeBills.length === 0 ? (
          <p className="text-darc-velvet/60 text-sm">Nenhuma conta cadastrada.</p>
        ) : (
          <div className="divide-y divide-darc-linen">
            {activeBills.slice(0, 5).map((bill) => {
              const isOverdue = today.getDate() > bill.diaVencimento;
              return (
                <div key={bill.id} className={`flex items-center justify-between gap-3 py-2.5 ${isOverdue ? 'bg-darc-red-bright/5 -mx-2 px-2 rounded-lg' : ''}`}>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-darc-velvet truncate text-sm">
                      {bill.nome}
                      {isOverdue && <span className="ml-2 text-xs text-darc-red">⚠ Vencida</span>}
                    </p>
                    <p className="text-xs text-darc-velvet/60 mt-0.5">
                      {BillCategoryLabels[bill.categoria as keyof typeof BillCategoryLabels] ?? bill.categoria}
                      {' · '}
                      Dia {bill.diaVencimento}
                      {' · '}
                      {BillFrequencyLabels[bill.frequencia as keyof typeof BillFrequencyLabels] ?? bill.frequencia}
                    </p>
                  </div>
                  <span className="text-sm font-bold text-darc-velvet whitespace-nowrap">{formatCurrency(bill.valor / 100)}</span>
                </div>
              );
            })}
          </div>
        )}
      </Disclosure>

      <Disclosure
        title="🔧 Próximas Manutenções"
        summary={upcomingMaintenance.length === 0 ? 'Nenhuma manutenção agendada' : `${upcomingMaintenance.length} agendadas`}
        href={`/projects/${projectId}/maintenance`}
        hrefLabel="Ver todas as manutenções"
      >
        {upcomingMaintenance.length === 0 ? (
          <p className="text-darc-velvet/60 text-sm">Nenhuma manutenção agendada.</p>
        ) : (
          <div className="space-y-2">
            {upcomingMaintenance.map((m) => {
              const daysUntil = Math.ceil((new Date(m.dataProxima!).getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
              const accent = daysUntil <= 7 ? 'bg-darc-red-bright' : daysUntil <= 30 ? 'bg-darc-sunfire' : 'bg-darc-mist';
              return (
                <div key={m.id} className="rounded-xl bg-darc-linen/40 p-3 relative overflow-hidden">
                  <span className={`absolute left-0 top-3 bottom-3 w-1 rounded-r-full ${accent}`} />
                  <p className="font-semibold text-darc-velvet pl-2 text-sm">{m.tipo}</p>
                  <p className="text-xs text-darc-velvet/70 mt-1 pl-2">Próxima: {formatDateBR(m.dataProxima!)}</p>
                  <p className="text-xs text-darc-velvet/60 pl-2">{daysUntil <= 0 ? '⚠ Atrasada!' : `Em ${daysUntil} dias`}</p>
                  {m.fornecedor && <p className="text-xs text-darc-velvet/50 mt-1 pl-2">📞 {m.fornecedor}</p>}
                </div>
              );
            })}
          </div>
        )}
      </Disclosure>

      <Disclosure
        title="🔔 Lembretes Pendentes"
        summary={pendingReminders.length === 0 ? 'Nenhum lembrete pendente' : `${pendingReminders.length} pendentes`}
        href={`/projects/${projectId}/reminders`}
        hrefLabel="Ver todos os lembretes"
      >
        {pendingReminders.length === 0 ? (
          <p className="text-darc-velvet/60 text-sm">Nenhum lembrete pendente.</p>
        ) : (
          <div className="space-y-2">
            {pendingReminders.map((r) => {
              const daysUntil = Math.ceil((new Date(r.data).getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
              const priorityColors: Record<string, string> = {
                URGENTE: 'border-l-darc-red-bright',
                ALTA: 'border-l-darc-sunfire',
                MEDIA: 'border-l-darc-pink',
                BAIXA: 'border-l-darc-mist',
              };
              return (
                <div key={r.id} className={`border-l-4 ${priorityColors[r.prioridade] ?? 'border-l-darc-mist'} bg-darc-linen/40 rounded-r-lg p-3`}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-medium text-darc-velvet text-sm">{r.titulo}</p>
                    <span className="text-[10px] uppercase tracking-[0.15em] px-2 py-0.5 rounded-full bg-white border border-darc-linen text-darc-velvet/70">
                      {ReminderPriorityLabels[r.prioridade as keyof typeof ReminderPriorityLabels] ?? r.prioridade}
                    </span>
                  </div>
                  {r.descricao && <p className="text-sm text-darc-velvet/70 mt-1">{r.descricao}</p>}
                  <p className="text-xs text-darc-velvet/60 mt-1">
                    {formatDateBR(r.data)} · {daysUntil <= 0 ? '⚠ Atrasado!' : `Em ${daysUntil} dias`}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </Disclosure>
    </div>
  );
}
