'use client';

import Link from 'next/link';
import { AlertTriangle, ArrowRight, Bell, CheckCircle2, Wrench } from 'lucide-react';

export default function ManagementGlance({
  projectId,
  totalMensalLabel,
  activeCount,
  overdueCount,
  upcomingMaintenanceCount,
  pendingRemindersCount,
}: {
  projectId: string;
  totalMensalLabel: string;
  activeCount: number;
  overdueCount: number;
  upcomingMaintenanceCount: number;
  pendingRemindersCount: number;
}) {
  const supports: Array<{
    key: string;
    label: string;
    value: string;
    icon: React.ReactNode;
    tone: 'neutral' | 'alert';
    href: string;
  }> = [
    {
      key: 'active',
      label: 'Contas ativas',
      value: `${activeCount}`,
      icon: <CheckCircle2 className="h-4 w-4" />,
      tone: 'neutral',
      href: `/projects/${projectId}/bills`,
    },
    {
      key: 'overdue',
      label: 'Vencidas',
      value: `${overdueCount}`,
      icon: <AlertTriangle className="h-4 w-4" />,
      tone: overdueCount > 0 ? 'alert' : 'neutral',
      href: `/projects/${projectId}/bills`,
    },
    {
      key: 'maintenance',
      label: 'Manutenções',
      value: `${upcomingMaintenanceCount}`,
      icon: <Wrench className="h-4 w-4" />,
      tone: 'neutral',
      href: `/projects/${projectId}/maintenance`,
    },
    {
      key: 'reminders',
      label: 'Lembretes',
      value: `${pendingRemindersCount}`,
      icon: <Bell className="h-4 w-4" />,
      tone: 'neutral',
      href: `/projects/${projectId}/reminders`,
    },
  ];

  return (
    <section
      aria-label="Relance de gestão"
      className="rounded-2xl border border-lifeone-hairline bg-lifeone-card p-4 shadow-lifeone-card"
    >
      <p className="text-[11px] uppercase tracking-[0.18em] text-lifeone-ink-3">Custo mensal recorrente</p>
      <p className="mt-1 font-geist text-2xl font-bold tabular-nums text-lifeone-ink">{totalMensalLabel}</p>

      <div className="mt-4 grid grid-cols-2 gap-2">
        {supports.map((support) => (
          <Link
            key={support.key}
            href={support.href}
            className={`flex min-h-[44px] items-center justify-between gap-2 rounded-xl border p-3 transition-colors ${
              support.tone === 'alert'
                ? 'border-[#F2C6C1] bg-[#FCEBE9] text-[#D92D20]'
                : 'border-lifeone-hairline bg-lifeone-surface text-lifeone-ink'
            }`}
          >
            <span className="flex min-w-0 items-center gap-2">
              {support.icon}
              <span className="min-w-0 truncate">
                <span className="block text-[10px] uppercase tracking-[0.12em] opacity-70">{support.label}</span>
                <span className="block font-geist text-base font-bold tabular-nums">{support.value}</span>
              </span>
            </span>
            <ArrowRight className="h-4 w-4 shrink-0 opacity-50" />
          </Link>
        ))}
      </div>
    </section>
  );
}
