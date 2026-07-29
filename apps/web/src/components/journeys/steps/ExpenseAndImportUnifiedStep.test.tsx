import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProjectType } from '@reformaflow/domain';
import { ExpenseAndImportUnifiedStep } from './ExpenseAndImportUnifiedStep';

const queryMocks = {
  expenses: vi.fn(),
  imports: vi.fn(),
};

vi.mock('@tanstack/react-query', async () => {
  const actual = await vi.importActual('@tanstack/react-query');
  return {
    ...actual,
    useQuery: (opts: any) => {
      const queryKey = opts.queryKey?.[1];
      if (queryKey === 'expenses') {
        return { data: [], isLoading: false };
      } else if (queryKey === 'imports') {
        return { data: [], isLoading: false };
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

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe('ExpenseAndImportUnifiedStep (operational summary contract)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Contract: Renders with required props', () => {
    it('renders with minimal props', () => {
      wrap(
        <ExpenseAndImportUnifiedStep
          projectId="p1"
          projectType={ProjectType.PESSOAL}
          onDone={vi.fn()}
          onSkip={vi.fn()}
        />
      );

      // Tab buttons should be visible
      expect(screen.getByText(/Lançar despesa/i)).toBeInTheDocument();
      expect(screen.getByText(/Importar/i)).toBeInTheDocument();
    });

    it('renders with optional props (subtitle, onBack, stepRequired)', () => {
      wrap(
        <ExpenseAndImportUnifiedStep
          projectId="p1"
          projectType={ProjectType.PESSOAL}
          onDone={vi.fn()}
          onSkip={vi.fn()}
          subtitle="Custom subtitle"
          onBack={vi.fn()}
          stepRequired={true}
        />
      );

      expect(screen.getByText(/Lançar despesa/i)).toBeInTheDocument();
    });
  });

  describe('Contract: Tab switching', () => {
    it('starts with expense tab active', () => {
      wrap(
        <ExpenseAndImportUnifiedStep
          projectId="p1"
          projectType={ProjectType.PESSOAL}
          onDone={vi.fn()}
          onSkip={vi.fn()}
        />
      );

      const expenseTab = screen.getByRole('button', { name: /Lançar despesa/i });
      expect(expenseTab).toHaveClass('bg-lifeone-blue');
    });

    it('switches to import tab when clicked', () => {
      wrap(
        <ExpenseAndImportUnifiedStep
          projectId="p1"
          projectType={ProjectType.PESSOAL}
          onDone={vi.fn()}
          onSkip={vi.fn()}
        />
      );

      const importTab = screen.getByRole('button', { name: /Importar/i });
      fireEvent.click(importTab);

      expect(importTab).toHaveClass('bg-lifeone-blue');
    });

    it('switches back to expense tab when clicked', () => {
      wrap(
        <ExpenseAndImportUnifiedStep
          projectId="p1"
          projectType={ProjectType.PESSOAL}
          onDone={vi.fn()}
          onSkip={vi.fn()}
        />
      );

      const importTab = screen.getByRole('button', { name: /Importar/i });
      fireEvent.click(importTab);

      const expenseTab = screen.getByRole('button', { name: /Lançar despesa/i });
      fireEvent.click(expenseTab);

      expect(expenseTab).toHaveClass('bg-lifeone-blue');
    });
  });

  describe('Contract: Respects canSkip flag', () => {
    it('accepts canSkip prop', () => {
      wrap(
        <ExpenseAndImportUnifiedStep
          projectId="p1"
          projectType={ProjectType.PESSOAL}
          onDone={vi.fn()}
          onSkip={vi.fn()}
          canSkip={false}
        />
      );

      expect(screen.getByText(/Lançar despesa/i)).toBeInTheDocument();
    });
  });

  describe('Contract: Passes through props correctly', () => {
    it('accepts funding prop', () => {
      const onFundingChange = vi.fn();
      wrap(
        <ExpenseAndImportUnifiedStep
          projectId="p1"
          projectType={ProjectType.PESSOAL}
          onDone={vi.fn()}
          onSkip={vi.fn()}
          funding={{
            bankAccount: null,
            creditCard: null,
          }}
          onFundingChange={onFundingChange}
        />
      );

      expect(screen.getByText(/Lançar despesa/i)).toBeInTheDocument();
    });
  });
});
