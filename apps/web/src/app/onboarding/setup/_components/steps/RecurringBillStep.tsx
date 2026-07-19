'use client';

import RecurringBillFormModal from '@/app/projects/[projectId]/bills/_components/RecurringBillFormModal';
import type { OnboardingStepProps } from '../../_types';

/** Wraps `RecurringBillFormModal` in `bare` mode inside the wizard (CASA/CARRO anchor). */
export function RecurringBillStep({ projectId, projectType, onDone, onSkip }: OnboardingStepProps) {
  return (
    <section className="rounded-[18px] border border-lifeone-hairline bg-lifeone-card p-6 shadow-lifeone-card">
      <RecurringBillFormModal
        projectId={projectId}
        projectType={projectType}
        bill={null}
        onClose={onSkip}
        onSaved={onDone}
        bare
      />
    </section>
  );
}
