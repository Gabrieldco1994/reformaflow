'use client';

import { SkipForward } from 'lucide-react';
import CardFormModal from '@/app/projects/[projectId]/credit-cards/_components/CardFormModal';
import type { OnboardingStepProps } from '../../_types';

/**
 * Wraps `CardFormModal` in `bare` mode inside the wizard, with the
 * single-tier skip UX ("Pular — cadastro depois") preserved verbatim from
 * the original PESSOAL-only wizard.
 */
export function CreditCardStep({ projectId, onDone, onSkip }: OnboardingStepProps) {
  return (
    <section className="rounded-[18px] border border-lifeone-hairline bg-lifeone-card p-6 shadow-lifeone-card">
      <CardFormModal
        projectId={projectId}
        card={null}
        onClose={onSkip}
        onSaved={onDone}
        bare
        hideCancel
      />

      <div className="mt-3">
        <button
          onClick={onSkip}
          className="flex min-h-11 w-full items-center justify-center gap-1.5 text-[13px] text-lifeone-ink-3 hover:text-lifeone-ink"
        >
          <SkipForward className="h-3.5 w-3.5" /> Pular — cadastro depois
        </button>
      </div>
    </section>
  );
}
