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
  /** Called after a successful save — advances the shell to the next step. */
  onDone: () => void;
  /** Called when the user explicitly skips — advances the shell to the next step without saving. */
  onSkip: () => void;
  /** Transitório: fontes financeiras selecionadas/criadas no passo funding. */
  funding?: OnboardingFunding | null;
  /** Atualiza o runtime state do wizard shell com as fontes escolhidas. */
  onFundingChange?: (next: OnboardingFunding) => void;
  /** Se true, o passo exige ao menos uma ação antes de avançar. */
  stepRequired?: boolean;
}

// Re-export for convenience (steps import from _types, not from domain directly)
export type { OnboardingFunding };
