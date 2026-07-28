'use client';

import { ChevronLeft } from 'lucide-react';
import RecurringBillFormModal from '@/app/projects/[projectId]/bills/_components/RecurringBillFormModal';
import type { OnboardingStepProps } from '../../_types';

/** Wraps `RecurringBillFormModal` in `bare` mode inside the wizard (CASA/CARRO anchor). */
export function RecurringBillStep({ projectId, projectType, onDone, onSkip, onBack, subtitle }: OnboardingStepProps) {
  return (
    <section className="rounded-[18px] border border-lifeone-hairline bg-lifeone-card p-6 shadow-lifeone-card">
      <p className="mb-4 text-[12px] text-lifeone-ink-3">
        {subtitle || 'Cadastre uma conta que se repete todo mês (água, luz, condomínio…).'}
      </p>
      <RecurringBillFormModal
        projectId={projectId}
        projectType={projectType}
        bill={null}
        onClose={onSkip}
        onSaved={onDone}
        bare
      />
      {onBack && (
        <button
          onClick={onBack}
          className="mt-3 flex min-h-11 w-full items-center justify-center gap-1.5 text-[13px] font-medium text-lifeone-ink-3 hover:text-lifeone-ink transition-colors"
        >
          <ChevronLeft className="h-3.5 w-3.5" /> Voltar
        </button>
      )}
    </section>
  );
}
