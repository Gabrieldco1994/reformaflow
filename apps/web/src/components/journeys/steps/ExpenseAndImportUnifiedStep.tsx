'use client';

import { Suspense, useState } from 'react';
import type { OnboardingStepProps } from '@/app/onboarding/setup/_types';
import { QuickExpenseStep } from './QuickExpenseStep';
import { ImportMassStep } from './ImportMassStep';

/**
 * Unified step combining expense creation + import CSV/statement in tabs.
 * Only shown when admin has enabled the "unify expense + import" mode.
 * Otherwise, expense and import are separate steps.
 */
export function ExpenseAndImportUnifiedStep({
  projectId,
  projectType,
  onDone,
  onSkip,
  subtitle,
  canSkip = true,
  funding,
  onFundingChange,
}: OnboardingStepProps) {
  const [activeTab, setActiveTab] = useState<'expense' | 'import'>('expense');

  return (
    <section className="space-y-4">
      {/* Tab selector */}
      <div className="flex gap-2">
        <button
          onClick={() => setActiveTab('expense')}
          className={`flex-1 rounded-[10px] px-3 py-2 text-[13px] font-semibold transition-colors ${
            activeTab === 'expense'
              ? 'bg-lifeone-blue text-white'
              : 'border border-lifeone-hairline bg-lifeone-surface text-lifeone-ink-2 hover:bg-lifeone-card'
          }`}
        >
          Lançar despesa
        </button>
        <button
          onClick={() => setActiveTab('import')}
          className={`flex-1 rounded-[10px] px-3 py-2 text-[13px] font-semibold transition-colors ${
            activeTab === 'import'
              ? 'bg-lifeone-blue text-white'
              : 'border border-lifeone-hairline bg-lifeone-surface text-lifeone-ink-2 hover:bg-lifeone-card'
          }`}
        >
          Importar
        </button>
      </div>

      {/* Content */}
      <div>
        {activeTab === 'expense' && (
          <Suspense fallback={<div className="py-4 text-center text-sm text-lifeone-ink-3">Carregando...</div>}>
            <QuickExpenseStep
              projectId={projectId}
              projectType={projectType}
              onDone={onDone}
              onSkip={onSkip}
              subtitle={subtitle || 'Lance um gasto de hoje para o app começar a te mostrar algo real.'}
              canSkip={canSkip}
              funding={funding}
              onFundingChange={onFundingChange}
            />
          </Suspense>
        )}

        {activeTab === 'import' && (
          <Suspense fallback={<div className="py-4 text-center text-sm text-lifeone-ink-3">Carregando...</div>}>
            <ImportMassStep
              projectId={projectId}
              projectType={projectType}
              onDone={onDone}
              onSkip={onSkip}
              subtitle={subtitle || 'Traga seu extrato ou fatura de uma vez em vez de digitar tudo.'}
              canSkip={canSkip}
              funding={funding}
              onFundingChange={onFundingChange}
            />
          </Suspense>
        )}
      </div>
    </section>
  );
}
