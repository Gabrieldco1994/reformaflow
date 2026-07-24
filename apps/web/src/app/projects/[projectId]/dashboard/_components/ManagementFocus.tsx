'use client';

import { useId, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ChevronDown } from 'lucide-react';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import { daysUntilDue } from '@/lib/recurring-bill-status';
import {
  BillFrequencyLabels,
  ReminderPriorityLabels,
} from '@reformaflow/domain';
import type { Bill, Maintenance, Reminder } from './ManagementDashboard';
import { dueDateLabel } from './ManagementDashboard';
import { computeMaintenanceProgress } from '../_lib/maintenance-progress';

/** Dias (arredondados para cima) entre hoje e uma data-calendário completa (não dia-do-mês). */
function daysBetween(dateStr: string, today: Date): number {
  return Math.ceil((new Date(dateStr).getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

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
    <div className="overflow-hidden rounded-2xl border border-lifeone-hairline bg-lifeone-card shadow-lifeone-card">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={controlsId}
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-[44px] w-full items-center justify-between gap-3 p-4 text-left"
      >
        <span className="min-w-0">
          <span className="block text-[11px] font-semibold uppercase tracking-[0.16em] text-lifeone-ink-3">{title}</span>
          <span className="mt-0.5 block text-xs text-lifeone-ink-3">{summary}</span>
        </span>
        <ChevronDown
          className={`h-5 w-5 shrink-0 text-lifeone-ink-3 transition-transform motion-reduce:transition-none ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div id={controlsId} className="border-t border-lifeone-hairline p-4 pt-3">
          {children}
          <Link
            href={href}
            className="mt-3 inline-flex min-h-[44px] items-center text-sm font-medium text-lifeone-blue hover:underline"
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
  carKmAtual,
}: {
  projectId: string;
  activeBills: Bill[];
  upcomingMaintenance: Maintenance[];
  pendingReminders: Reminder[];
  today: Date;
  carKmAtual?: number | null;
}) {
  return (
    <div className="space-y-3">
      <Disclosure
        title="Contas Recorrentes"
        summary={activeBills.length === 0 ? 'Nenhuma conta cadastrada' : `${activeBills.length} ativas`}
        href={`/projects/${projectId}/bills`}
        hrefLabel="Ver todas as contas"
      >
        {activeBills.length === 0 ? (
          <p className="text-sm text-lifeone-ink-3">Nenhuma conta cadastrada.</p>
        ) : (
          <div className="divide-y divide-lifeone-hairline">
            {activeBills.slice(0, 5).map((bill) => {
              const dias = daysUntilDue(bill.diaVencimento, today);
              const isOverdue = dias < 0;
              return (
                <div key={bill.id} className={`flex items-center justify-between gap-3 py-2.5 ${isOverdue ? '-mx-2 rounded-lg bg-[#FCEBE9] px-2' : ''}`}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-lifeone-ink">
                      {bill.nome}
                      {isOverdue && <span className="ml-2 text-xs font-semibold text-[#D92D20]">Vencida</span>}
                    </p>
                    <p className="mt-0.5 truncate text-[11px] text-lifeone-ink-3">
                      {bill.frequencia !== 'MENSAL' ? `${BillFrequencyLabels[bill.frequencia as keyof typeof BillFrequencyLabels] ?? bill.frequencia} · ` : ''}
                      {isOverdue ? 'venceu' : dueDateLabel(dias)}
                    </p>
                  </div>
                  <span className="whitespace-nowrap font-geist text-sm font-bold tabular-nums text-lifeone-ink">{formatCurrency(bill.valor / 100)}</span>
                </div>
              );
            })}
          </div>
        )}
      </Disclosure>

      <Disclosure
        title="Próximas Manutenções"
        summary={
          upcomingMaintenance.length === 0
            ? 'Nenhuma manutenção agendada'
            : carKmAtual != null
              ? `${upcomingMaintenance.length} agendadas · ${carKmAtual.toLocaleString('pt-BR')} km atuais`
              : `${upcomingMaintenance.length} agendadas`
        }
        href={`/projects/${projectId}/maintenance`}
        hrefLabel="Ver todas as manutenções"
      >
        {upcomingMaintenance.length === 0 ? (
          <p className="text-sm text-lifeone-ink-3">Nenhuma manutenção agendada.</p>
        ) : (
          <div className="space-y-2">
            {upcomingMaintenance.map((m) => {
              const daysUntil = daysBetween(m.dataProxima!, today);
              const accent = daysUntil <= 7 ? 'bg-[#D92D20]' : daysUntil <= 30 ? 'bg-[#B5803A]' : 'bg-lifeone-ink-4';
              const progress = computeMaintenanceProgress(m.dataRealizada, m.dataProxima!, today);
              return (
                <div key={m.id} className="relative overflow-hidden rounded-xl bg-lifeone-surface p-3">
                  <span className={`absolute bottom-3 left-0 top-3 w-1 rounded-r-full ${accent}`} />
                  <p className="pl-2 text-sm font-semibold text-lifeone-ink">{m.tipo}</p>
                  <p className="mt-1 pl-2 text-xs text-lifeone-ink-3">Próxima: {formatDateBR(m.dataProxima!)}</p>
                  <p className={`pl-2 text-xs ${daysUntil <= 0 ? 'font-semibold text-[#D92D20]' : 'text-lifeone-ink-3'}`}>
                    {daysUntil <= 0 ? 'Atrasada' : `Em ${daysUntil} dias`}
                  </p>
                  <div
                    role="progressbar"
                    aria-label={`Progresso até a próxima manutenção: ${m.tipo}`}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progress.percentComplete}
                    className="ml-2 mt-2 h-1.5 overflow-hidden rounded-full bg-lifeone-hairline-3"
                  >
                    <div className={`h-full ${accent}`} style={{ width: `${progress.percentComplete}%` }} />
                  </div>
                  {m.fornecedor && <p className="mt-1 pl-2 text-xs text-lifeone-ink-4">{m.fornecedor}</p>}
                </div>
              );
            })}
          </div>
        )}
      </Disclosure>

      <Disclosure
        title="Lembretes Pendentes"
        summary={pendingReminders.length === 0 ? 'Nenhum lembrete pendente' : `${pendingReminders.length} pendentes`}
        href={`/projects/${projectId}/reminders`}
        hrefLabel="Ver todos os lembretes"
      >
        {pendingReminders.length === 0 ? (
          <p className="text-sm text-lifeone-ink-3">Nenhum lembrete pendente.</p>
        ) : (
          <div className="space-y-2">
            {pendingReminders.map((r) => {
              const daysUntil = daysBetween(r.data, today);
              const priorityColors: Record<string, string> = {
                URGENTE: 'border-l-[#D92D20]',
                ALTA: 'border-l-[#B5803A]',
                MEDIA: 'border-l-lifeone-blue',
                BAIXA: 'border-l-lifeone-ink-4',
              };
              return (
                <div key={r.id} className={`rounded-r-lg border-l-4 bg-lifeone-surface p-3 ${priorityColors[r.prioridade] ?? 'border-l-lifeone-ink-4'}`}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-lifeone-ink">{r.titulo}</p>
                    <span className="rounded-full border border-lifeone-hairline bg-lifeone-card px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] text-lifeone-ink-3">
                      {ReminderPriorityLabels[r.prioridade as keyof typeof ReminderPriorityLabels] ?? r.prioridade}
                    </span>
                  </div>
                  {r.descricao && <p className="mt-1 text-sm text-lifeone-ink-3">{r.descricao}</p>}
                  <p className={`mt-1 text-xs ${daysUntil <= 0 ? 'font-semibold text-[#D92D20]' : 'text-lifeone-ink-3'}`}>
                    {formatDateBR(r.data)} · {daysUntil <= 0 ? 'Atrasado' : `Em ${daysUntil} dias`}
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
