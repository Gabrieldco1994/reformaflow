'use client';

import { useState } from 'react';
import { SkipForward, AlertTriangle } from 'lucide-react';
import BankAccountFormModal from '@/app/projects/[projectId]/bank-accounts/_components/BankAccountFormModal';
import type { OnboardingStepProps } from '../../_types';

/**
 * Wraps `BankAccountFormModal` in `bare` mode inside the wizard, with the
 * two-tier skip UX ("Pular por agora" → warning card → "Pular mesmo assim")
 * preserved verbatim from the original PESSOAL-only wizard.
 */
export function BankAccountStep({ projectId, onDone, onSkip }: OnboardingStepProps) {
  const [showSkipWarning, setShowSkipWarning] = useState(false);

  return (
    <section className="rounded-[18px] border border-lifeone-hairline bg-lifeone-card p-6 shadow-lifeone-card">
      <BankAccountFormModal
        projectId={projectId}
        account={null}
        onClose={onSkip}
        onSaved={onDone}
        bare
        hideCancel
      />

      <div className="mt-3">
        {!showSkipWarning ? (
          <button
            onClick={() => setShowSkipWarning(true)}
            className="flex min-h-11 w-full items-center justify-center gap-1.5 text-[13px] text-lifeone-ink-3 hover:text-lifeone-ink"
          >
            <SkipForward className="h-3.5 w-3.5" /> Pular por agora
          </button>
        ) : (
          <div className="rounded-[10px] border border-[#FECDCA] bg-[#FEF3F2] p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-[#B42318]" />
              <div>
                <p className="text-[12px] font-semibold text-[#B42318]">Sem o saldo, o Caixa não bate com o banco</p>
                <p className="mt-0.5 text-[11px] text-[#7A271A]">
                  O cockpit vai mostrar apenas o fluxo realizado (entradas − saídas), não o saldo real da conta.
                  Você pode definir depois em Contas Bancárias.
                </p>
              </div>
            </div>
            <button
              onClick={onSkip}
              className="mt-2 flex min-h-9 items-center justify-center gap-1 rounded-[8px] border border-[#FECDCA] px-3 py-1.5 text-[12px] font-medium text-[#B42318] hover:bg-[#FEE4E2]"
            >
              <SkipForward className="h-3 w-3" /> Pular mesmo assim
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
