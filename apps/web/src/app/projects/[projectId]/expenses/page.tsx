'use client';

import Link from 'next/link';
import { useProject } from '@/contexts/project-context';
import { ExpensesView } from './ExpensesView';
import { MobileExpensesScreen } from './_components/MobileExpensesScreen';

/**
 * Desktop mantém a view analítica existente. No mobile (<lg) renderizamos a
 * superfície "app" simplificada.
 */
export default function ExpensesPage() {
  const { projectType, projectId } = useProject();

  if (projectType !== 'PESSOAL') {
    return <ExpensesView lockedEixo="competencia" />;
  }

  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-lifeone-hairline bg-lifeone-card px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-lifeone-ink-3">
            Visão por competência
          </p>
          <Link
            href={`/projects/${projectId}/conta`}
            className="text-[12px] font-semibold text-lifeone-blue hover:underline"
          >
            Voltar para Conta
          </Link>
        </div>
      </div>
      <div className="lg:hidden">
        <MobileExpensesScreen />
      </div>
      <div className="hidden lg:block">
        <ExpensesView lockedEixo="competencia" />
      </div>
    </div>
  );
}
