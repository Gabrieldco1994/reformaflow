/**
 * Common contract tests for operational summary steps.
 *
 * Every operational summary step should:
 * 1. Render successfully with minimal required props
 * 2. Call onDone when user completes the action
 * 3. Call onSkip when user clicks skip (if canSkip is true)
 * 4. Prevent double-submit on rapid clicks
 * 5. Surface server validation errors inline
 * 6. Not call onDone when validation fails
 *
 * This suite provides a template for testing any new operational summary step.
 * Usage example:
 *
 * ```typescript
 * import { createOperationalSummaryContractTest } from '@/lib/operational-summaries/contract.test';
 * import { MyCustomStep } from './MyCustomStep';
 *
 * describe('MyCustomStep (operational summary contract)', () => {
 *   createOperationalSummaryContractTest(MyCustomStep, ProjectType.PESSOAL);
 * });
 * ```
 */

import type { ProjectType } from '@reformaflow/domain';
import type { OperationalSummaryStepProps } from './types';

/**
 * Generate a common contract test suite for an operational summary step.
 *
 * This returns an object describing the contract tests. Each test should verify:
 * - Component renders with minimal props
 * - Optional props are accepted
 * - canSkip flag is respected
 * - Double-submit is prevented
 * - Errors are surfaced inline
 * - Callbacks are invoked correctly
 *
 * Integration with vitest:
 * - Tests MUST run inside a describe() block
 * - Each test MUST use render() from @testing-library/react
 * - Each test MUST call fireEvent/waitFor for user interaction
 * - Mocks MUST be set up before calling createOperationalSummaryContractTest
 */
export function createOperationalSummaryContractTest(
  Component: React.ComponentType<OperationalSummaryStepProps>,
  projectType: ProjectType,
  customTests?: {
    /** Test name → setup & assertion (for step-specific behavior) */
    [testName: string]: (props: OperationalSummaryStepProps) => void | Promise<void>;
  },
): {
  /** List of test descriptions that should be implemented */
  readonly requiredTests: readonly string[];
  /** Helper to build default props for testing */
  buildDefaultProps: () => OperationalSummaryStepProps;
  /** Helper to validate that props conform to the contract */
  validateProps: (props: unknown) => props is OperationalSummaryStepProps;
} {
  const requiredTests = [
    'renders without crashing with minimal required props',
    'accepts optional props (subtitle, onBack, stepRequired)',
    'respects canSkip=false by not rendering skip button',
    'prevents double-submit on rapid button clicks',
    'surfaces inline error messages (never silently fails)',
    'calls onDone (possibly with payload) on successful completion',
    'calls onSkip only when skip button is explicitly clicked (if canSkip=true)',
    'never calls onDone after validation failure',
  ] as const;

  const buildDefaultProps = (): OperationalSummaryStepProps => ({
    projectId: 'test-project-1',
    projectType,
    onDone: () => {},
    onSkip: () => {},
    canSkip: true,
  });

  const validateProps = (props: unknown): props is OperationalSummaryStepProps => {
    if (!props || typeof props !== 'object') return false;
    const p = props as Record<string, unknown>;
    if (typeof p.projectId !== 'string') return false;
    if (typeof p.projectType !== 'string') return false;
    if (typeof p.onDone !== 'function') return false;
    if (typeof p.onSkip !== 'function') return false;
    if (p.onBack !== undefined && typeof p.onBack !== 'function') return false;
    if (p.subtitle !== undefined && typeof p.subtitle !== 'string') return false;
    if (p.canSkip !== undefined && typeof p.canSkip !== 'boolean') return false;
    if (p.stepRequired !== undefined && typeof p.stepRequired !== 'boolean') return false;
    if (p.onFundingChange !== undefined && typeof p.onFundingChange !== 'function') return false;
    return true;
  };

  return {
    requiredTests,
    buildDefaultProps,
    validateProps,
  };
}

