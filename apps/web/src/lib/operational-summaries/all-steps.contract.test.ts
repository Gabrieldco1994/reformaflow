/**
 * Parametrized contract test suite for ALL operational summary steps.
 *
 * This suite iterates over the OPERATIONAL_SUMMARY_REGISTRY and verifies that:
 * 1. Each step component accepts the operational summary contract props
 * 2. Registry entries are not null or undefined
 * 3. All steps listed in journey-catalog have a corresponding registry entry
 *
 * Individual step-specific tests (behavior, validation, async) belong in
 * the step's own .test.tsx file (e.g., FundingStep.test.tsx).
 */

import { describe, it, expect } from 'vitest';
import { ProjectType } from '@reformaflow/domain';
import {
  OPERATIONAL_SUMMARY_REGISTRY,
  listOperationalSummaryStepKeys,
  validateOperationalSummaryProps,
} from './index';

describe('Operational Summary Registry Contract', () => {
  describe('Registry integrity', () => {
    it('registry is not empty', () => {
      expect(listOperationalSummaryStepKeys().length).toBeGreaterThan(0);
    });

    it('all registry entries are valid React components', () => {
      const keys = listOperationalSummaryStepKeys();
      keys.forEach((key) => {
        const Component = OPERATIONAL_SUMMARY_REGISTRY[key];
        expect(Component).toBeDefined();
        expect(typeof Component).toBe('function');
      });
    });

    it('no registry entry is null or undefined', () => {
      Object.entries(OPERATIONAL_SUMMARY_REGISTRY).forEach(([key, Component]) => {
        expect(Component, `Registry entry "${key}" should not be null/undefined`).toBeDefined();
      });
    });
  });

  describe('Expected steps from journey catalog', () => {
    // Steps that MUST exist in registry (from ONBOARDING_JOURNEY_DEFAULTS)
    // NOTE: maria-insight and feedback are NOT in the registry because they have
    // custom props and are rendered directly by the shell.
    const expectedSteps = [
      'funding',
      'expense',
      'import',
      'expense-import',
      'receipt',
      'bill',
      'car',
      'plant',
    ];

    expectedSteps.forEach((stepKey) => {
      it(`registry has entry for "${stepKey}"`, () => {
        expect(OPERATIONAL_SUMMARY_REGISTRY[stepKey]).toBeDefined();
      });
    });
  });

  describe('Props contract validation', () => {
    it('validates that minimal props conform to contract', () => {
      const minimalProps = {
        projectId: 'test-project',
        projectType: ProjectType.PESSOAL,
        onDone: () => {},
        onSkip: () => {},
      };

      expect(validateOperationalSummaryProps(minimalProps)).toBe(true);
    });

    it('validates that full props conform to contract', () => {
      const fullProps = {
        projectId: 'test-project',
        projectType: ProjectType.PESSOAL,
        onDone: () => {},
        onSkip: () => {},
        onBack: () => {},
        subtitle: 'Test subtitle',
        canSkip: true,
        stepRequired: false,
        onFundingChange: () => {},
      };

      expect(validateOperationalSummaryProps(fullProps)).toBe(true);
    });

    it('rejects props with missing required fields', () => {
      const invalidProps = {
        projectId: 'test-project',
        // missing projectType
        onDone: () => {},
        onSkip: () => {},
      };

      expect(validateOperationalSummaryProps(invalidProps)).toBe(false);
    });

    it('rejects props with invalid field types', () => {
      const invalidProps = {
        projectId: 'test-project',
        projectType: 'INVALID_TYPE', // not a valid ProjectType
        onDone: () => {},
        onSkip: 'not-a-function', // wrong type
      };

      expect(validateOperationalSummaryProps(invalidProps)).toBe(false);
    });
  });

  describe('Journey catalog completeness', () => {
    it('all journey steps (except maria-insight/feedback) have operational summary components', () => {
      // These are all the stepKeys that appear in ONBOARDING_JOURNEY_DEFAULTS
      // in packages/domain/src/config/onboarding-journey.ts
      // NOTE: maria-insight and feedback are excluded because they have custom props
      const journeyStepKeys = [
        'funding',
        'expense',
        'import',
        'expense-import',
        'receipt',
        'bill',
        'car',
        'plant',
      ];

      journeyStepKeys.forEach((key) => {
        expect(
          OPERATIONAL_SUMMARY_REGISTRY[key],
          `Step "${key}" from journey catalog should have registry entry`,
        ).toBeDefined();
      });
    });
  });
});
