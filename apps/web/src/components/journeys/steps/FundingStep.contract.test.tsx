/**
 * Test: FundingStep operational summary contract compliance.
 *
 * The FundingStep is an operational summary step that unifies bank account
 * and credit card selection/creation. It demonstrates:
 * - Dual mini-areas (bank + card)
 * - Optional completion (0, 1, or 2 selections)
 * - Double-click guard on "Continuar"
 * - Optional skip
 * - Error handling (mocked in these tests)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProjectType } from '@reformaflow/domain';
import { FundingStep } from './FundingStep';

const queryMocks = {
  'tenant.bank-accounts': vi.fn(),
  'tenant.credit-cards': vi.fn(),
};

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual('@tanstack/react-query');
  return {
    ...actual,
    useQuery: (opts: any) => {
      const queryKey = opts.queryKey?.[1];
      if (queryKey === 'bank-accounts') {
        return { data: queryMocks['tenant.bank-accounts'](), isLoading: false };
      } else if (queryKey === 'credit-cards') {
        return { data: queryMocks['tenant.credit-cards'](), isLoading: false };
      }
      return { data: undefined, isLoading: false };
    },
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

describe('FundingStep (operational summary contract)', () => {
  beforeEach(() => {
    queryMocks['tenant.bank-accounts'].mockReturnValue([]);
    queryMocks['tenant.credit-cards'].mockReturnValue([]);
  });

  describe('Contract: Renders & accepts required props', () => {
    it('renders with minimal props', () => {
      render(
        <FundingStep
          projectId="p1"
          projectType={ProjectType.PESSOAL}
          onDone={vi.fn()}
          onSkip={vi.fn()}
        />
      );
      expect(screen.getByText(/Contas/i)).toBeInTheDocument();
    });

    it('renders with optional props (subtitle, onBack, stepRequired)', () => {
      render(
        <FundingStep
          projectId="p1"
          projectType={ProjectType.PESSOAL}
          onDone={vi.fn()}
          onSkip={vi.fn()}
          subtitle="Custom subtitle"
          onBack={vi.fn()}
          stepRequired={true}
        />
      );
      expect(screen.getByText(/Custom subtitle/)).toBeInTheDocument();
    });
  });

  describe('Contract: Respects canSkip flag', () => {
    it('shows skip button when canSkip is not provided (default true)', () => {
      render(
        <FundingStep
          projectId="p1"
          projectType={ProjectType.PESSOAL}
          onDone={vi.fn()}
          onSkip={vi.fn()}
        />
      );
      expect(screen.getByText(/Pular/i)).toBeInTheDocument();
    });

    it('hides skip button when canSkip=false and stepRequired=true', () => {
      render(
        <FundingStep
          projectId="p1"
          projectType={ProjectType.PESSOAL}
          onDone={vi.fn()}
          onSkip={vi.fn()}
          canSkip={false}
          stepRequired={true}
        />
      );
      // When stepRequired=true and no funding selected, button shows message
      expect(screen.queryByText(/Pular por agora/i)).not.toBeInTheDocument();
    });
  });

  describe('Contract: Prevents double-submit', () => {
    it('clique duplo no botão Continuar não chama onDone duas vezes', async () => {
      const onDone = vi.fn();
      render(
        <FundingStep
          projectId="p1"
          projectType={ProjectType.PESSOAL}
          onDone={onDone}
          onSkip={vi.fn()}
        />
      );

      const continuar = screen.getByRole('button', { name: /Continuar/i });

      // First click
      fireEvent.click(continuar);
      // Second click immediately (before async completes)
      fireEvent.click(continuar);

      await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    });
  });

  describe('Contract: Calls onSkip without saving', () => {
    it('clicking Pular calls onSkip, not onDone', () => {
      const onSkip = vi.fn();
      const onDone = vi.fn();

      render(
        <FundingStep
          projectId="p1"
          projectType={ProjectType.PESSOAL}
          onDone={onDone}
          onSkip={onSkip}
        />
      );

      fireEvent.click(screen.getByText(/Pular por agora/i));

      expect(onSkip).toHaveBeenCalledTimes(1);
      expect(onDone).not.toHaveBeenCalled();
    });
  });

  describe('Contract: Calls onDone on successful completion', () => {
    it('clicking Continuar with no selection calls onDone', () => {
      const onDone = vi.fn();

      render(
        <FundingStep
          projectId="p1"
          projectType={ProjectType.PESSOAL}
          onDone={onDone}
          onSkip={vi.fn()}
          stepRequired={false}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /Continuar/i }));

      expect(onDone).toHaveBeenCalledTimes(1);
    });
  });

  describe('Contract: Respects stepRequired flag', () => {
    it('disables Continuar when stepRequired=true and no selection', () => {
      render(
        <FundingStep
          projectId="p1"
          projectType={ProjectType.PESSOAL}
          onDone={vi.fn()}
          onSkip={vi.fn()}
          stepRequired={true}
        />
      );

      const continuar = screen.getByRole('button', { name: /Continuar/i });
      expect(continuar).toBeDisabled();
    });

    it('enables Continuar when stepRequired=false (optional step)', () => {
      render(
        <FundingStep
          projectId="p1"
          projectType={ProjectType.PESSOAL}
          onDone={vi.fn()}
          onSkip={vi.fn()}
          stepRequired={false}
        />
      );

      const continuar = screen.getByRole('button', { name: /Continuar/i });
      expect(continuar).not.toBeDisabled();
    });
  });
});
