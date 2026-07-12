'use client';

import { useProject } from '@/contexts/project-context';
import { ExpensesView } from './ExpensesView';
import { MobileExpensesScreen } from './_components/MobileExpensesScreen';

/**
 * Desktop mantém a view analítica existente. No mobile (<lg) renderizamos a
 * superfície "app" simplificada.
 */
export default function ExpensesPage() {
  const { projectType } = useProject();

  if (projectType !== 'PESSOAL') {
    return <ExpensesView lockedEixo="competencia" />;
  }

  return (
    <>
      <div className="lg:hidden">
        <MobileExpensesScreen />
      </div>
      <div className="hidden lg:block">
        <ExpensesView lockedEixo="competencia" />
      </div>
    </>
  );
}
