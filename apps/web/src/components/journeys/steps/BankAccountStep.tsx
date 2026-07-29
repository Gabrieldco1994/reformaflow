'use client';

import { SkipForward, ChevronLeft } from 'lucide-react';
import BankAccountFormModal from '@/app/projects/[projectId]/bank-accounts/_components/BankAccountFormModal';
import type { OnboardingStepProps } from '@/app/onboarding/setup/_types';

/**
 * Wraps `BankAccountFormModal` in `bare` mode inside the wizard, with the
 * two-tier skip UX ("Pular por agora" → warning card → "Pular mesmo assim")
 * preserved verbatim from the original PESSOAL-only wizard.
 */
export function BankAccountStep({ projectId, onDone, onSkip, onBack, subtitle, canSkip = true }: OnboardingStepProps) {
  return (
    <section className="rounded-[18px] border border-lifeone-hairline bg-lifeone-card p-6 shadow-lifeone-card">
      <p className="mb-4 text-[12px] text-lifeone-ink-3">
        {subtitle ||
          'Sem o saldo, o Caixa mostra só o fluxo. Dá pra definir depois em Contas Bancárias.'}
      </p>
      <BankAccountFormModal
        projectId={projectId}
        account={null}
        onClose={onSkip}
        onSaved={() => onDone()}
        bare
        hideCancel
      />

      {canSkip && (
        <button
          onClick={onSkip}
          className="mt-3 flex min-h-11 w-full items-center justify-center gap-1.5 rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-4 py-3 text-[13px] font-medium text-lifeone-ink-2 hover:bg-lifeone-hairline/60 transition-colors"
        >
          <SkipForward className="h-3.5 w-3.5" /> Pular por agora
        </button>
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
