import type { ProjectType } from '@reformaflow/domain';
import type { OnboardingFunding } from '@reformaflow/domain';

/**
 * Interface every embeddable anchor step (bank account, credit card, quick
 * expense/receipt, recurring bill, car info, plant) implements. The shell
 * renders whichever one is active generically — it never branches on
 * project type beyond looking up `ANCHOR_STEPS`.
 */
export interface OnboardingStepProps {
  projectId: string;
  projectType: ProjectType;
  /**
   * Called after a successful save — advances the shell to the next step.
   * Steps que produzem dados relevantes ao próximo passo (ex.: QuickExpenseStep
   * → MariaInsightStep) podem propagar um payload opcional; steps sem payload
   * seguem chamando `onDone()` sem argumentos.
   */
  onDone: (payload?: StepDonePayload) => void;
  /** Called when the user explicitly skips — advances the shell to the next step without saving. */
  onSkip: () => void;
  /** Subtitle from jornada (customizable per project type). */
  subtitle?: string;
  /** Whether this step can be skipped (from jornada). */
  canSkip?: boolean;
  /** Transitório: fontes financeiras selecionadas/criadas no passo funding. */
  funding?: OnboardingFunding | null;
  /** Atualiza o runtime state do wizard shell com as fontes escolhidas. */
  onFundingChange?: (next: OnboardingFunding) => void;
  /** Se true, o passo exige ao menos uma ação antes de avançar. */
  stepRequired?: boolean;
}

/** Dados que um passo pode propagar ao concluir, consumidos pelo wizard shell. */
export interface StepDonePayload {
  /** Despesa recém-criada — habilita e alimenta o MariaInsightStep. */
  createdExpense?: {
    /** Valor do enum ExpenseType (ex.: 'SUPERMERCADO'). */
    tipoDespesa: string;
    /** Label legível da categoria (ex.: 'Supermercado'). */
    categoriaLabel: string;
  };
}

// Re-export for convenience (steps import from _types, not from domain directly)
export type { OnboardingFunding };
