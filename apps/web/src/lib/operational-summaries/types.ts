/**
 * Generic types for operational summary steps — shared contract between
 * onboarding, jornadas, and any other flow that reuses these components.
 *
 * An operational summary step is a reusable, self-contained UI component that:
 * - Accepts a focused set of props (projectId, callbacks, optional configuration)
 * - Manages its own async state (saving, error)
 * - Prevents double-submit via ref or flag
 * - Respects the `canSkip` flag and calls appropriate callbacks
 * - Surfaces server validation errors inline (never silently)
 */

import type { ProjectType, OnboardingFunding } from '@reformaflow/domain';

/**
 * Payload that a step can propagate to the shell when completing.
 * Used to pass context to subsequent steps (e.g., created expense → Maria step).
 */
export interface OperationalSummaryPayload {
  /** Despesa recém-criada — habilita e alimenta passos dependentes (e.g., Maria). */
  createdExpense?: {
    tipoDespesa: string;
    categoriaLabel: string;
  };
}

/**
 * Props that every operational summary step must accept.
 * Allows interchangeable use in onboarding, jornadas, and future contexts.
 */
export interface OperationalSummaryStepProps {
  projectId: string;
  projectType: ProjectType;

  /**
   * Called after successful completion.
   * Steps producing payloads may pass context; others call without arguments.
   */
  onDone: (payload?: OperationalSummaryPayload) => void;

  /** Called when user explicitly skips (if canSkip is true). */
  onSkip: () => void;

  /** Optional: go back to previous step. */
  onBack?: () => void;

  /** Text from journey/config, customizable per project type. */
  subtitle?: string;

  /** Whether this step can be skipped (from journey config). */
  canSkip?: boolean;

  /** Whether step is mandatory before advancing. */
  stepRequired?: boolean;

  /**
   * Current funding state (bank account + credit card selections).
   * Only populated for steps that use funding (FundingStep, expense/receipt forms).
   */
  funding?: OnboardingFunding | null;

  /**
   * Called when funding state changes.
   * Only steps that manage funding (FundingStep) call this.
   */
  onFundingChange?: (next: OnboardingFunding) => void;
}

/**
 * Registry entry for an operational summary step.
 * Maps a key (e.g., 'funding', 'expense') to a React component.
 */
export interface OperationalSummaryStepRegistry {
  [key: string]: React.ComponentType<OperationalSummaryStepProps>;
}

/**
 * Metadata about an operational summary step.
 * Used for runtime discovery and configuration.
 */
export interface OperationalSummaryMetadata {
  key: string;
  label: string;
  description?: string;
  /** Whether this step appears in all project types or only specific ones. */
  supportedTypes?: ProjectType[];
  /** Whether this step can be skipped by default. */
  defaultSkippable?: boolean;
  /** Whether this step is mandatory in the journey. */
  defaultRequired?: boolean;
}

/**
 * Error returned from an operational summary step.
 * Always includes a user-facing message.
 */
export interface OperationalSummaryError {
  message: string;
  code?: string;
  details?: Record<string, unknown>;
}
