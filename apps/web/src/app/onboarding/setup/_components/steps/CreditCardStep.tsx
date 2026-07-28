'use client';

import { SkipForward, ChevronLeft } from 'lucide-react';
import CardFormModal from '@/app/projects/[projectId]/credit-cards/_components/CardFormModal';
import type { OnboardingStepProps } from '../../_types';

/**
 * Wraps `CardFormModal` in `bare` mode inside the wizard, with the
 * single-tier skip UX ("Pular — cadastro depois") preserved verbatim from
 * the original PESSOAL-only wizard.
 */
export function CreditCardStep({ projectId, onDone, onSkip, onBack, subtitle, canSkip = true }: OnboardingStepProps) {
  return (
    <section className="rounded-[18px] border border-lifeone-hairline bg-lifeone-card p-6 shadow-lifeone-card">
      <p className="mb-4 text-[12px] text-lifeone-ink-3">
        {subtitle || 'Cadastre o cartão que você mais usa para as faturas baterem certo.'}
      </p>
      <CardFormModal
        projectId={projectId}
        card={null}
        onClose={onSkip}
        onSaved={() => onDone()}
        bare
        hideCancel
      />

      {canSkip && (
        <div className="mt-3">
          <button
            onClick={onSkip}
            className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-4 py-3 text-[13px] font-medium text-lifeone-ink-2 hover:bg-lifeone-hairline/60 transition-colors"
          >
            <SkipForward className="h-3.5 w-3.5" /> Pular — cadastro depois
          </button>
        </div>
      )}
      {onBack && (
        <button
          onClick={onBack}
          className="mt-2 flex min-h-11 w-full items-center justify-center gap-1.5 text-[13px] font-medium text-lifeone-ink-3 hover:text-lifeone-ink transition-colors"
        >
          <ChevronLeft className="h-3.5 w-3.5" /> Voltar
        </button>
      )}
    </section>
  );
}
