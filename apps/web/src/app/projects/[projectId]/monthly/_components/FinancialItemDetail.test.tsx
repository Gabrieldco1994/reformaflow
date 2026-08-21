import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FinancialItemCardV1 } from '@reformaflow/domain';
import { FinancialItemDetail } from './FinancialItemDetail';

/** Minimal valid V1 item for testing. */
function makeItem(overrides: Partial<FinancialItemCardV1> = {}): FinancialItemCardV1 {
  return {
    id: 'exp-1',
    kind: 'expense',
    origin: 'Conta Pessoal',
    originProjectId: 'proj-1',
    originProjectName: 'Minha Casa',
    purpose: 'MATERIAL_CONSTRUCAO',
    purposeLabel: 'Material de construção',
    amountCents: 150000,
    date: '2026-06-15T00:00:00.000Z',
    status: 'PAGO',
    title: 'Cimento 50kg',
    supplier: 'Leroy Merlin',
    installment: '2/6',
    paymentForm: 'CARTAO_CREDITO',
    relationship: { cardLast4: '4321', bankLast4: null },
    hasEvidence: false,
    actions: [],
    isEspelho: false,
    isNeutral: false,
    ...overrides,
  };
}

afterEach(cleanup);

/** Helper to mock matchMedia for a given width. */
function mockWidth(width: number) {
  const listeners: Array<(e: MediaQueryListEvent) => void> = [];
  window.matchMedia = vi.fn().mockImplementation((query: string) => {
    const match = width <= parseInt(query.match(/(\d+)/)?.[1] ?? '0', 10);
    return {
      matches: match,
      media: query,
      addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.push(fn),
      removeEventListener: () => {},
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    };
  });
}

describe('FinancialItemDetail', () => {
  describe('responsive presentation', () => {
    it('renders sheet (not drawer) at 375px', () => {
      mockWidth(375);
      render(<FinancialItemDetail item={makeItem()} onClose={() => {}} />);
      expect(screen.getByTestId('financial-detail-sheet')).toBeInTheDocument();
      expect(screen.queryByTestId('financial-detail-drawer')).not.toBeInTheDocument();
    });

    it('renders sheet (not drawer) at 390px', () => {
      mockWidth(390);
      render(<FinancialItemDetail item={makeItem()} onClose={() => {}} />);
      expect(screen.getByTestId('financial-detail-sheet')).toBeInTheDocument();
      expect(screen.queryByTestId('financial-detail-drawer')).not.toBeInTheDocument();
    });

    it('renders drawer (not sheet) at desktop width', () => {
      mockWidth(1024);
      render(<FinancialItemDetail item={makeItem()} onClose={() => {}} />);
      expect(screen.getByTestId('financial-detail-drawer')).toBeInTheDocument();
      expect(screen.queryByTestId('financial-detail-sheet')).not.toBeInTheDocument();
    });
  });

  describe('data rendering', () => {
    it('displays amount in BRL (centavos → reais)', () => {
      mockWidth(375);
      render(<FinancialItemDetail item={makeItem({ amountCents: 150000 })} onClose={() => {}} />);
      // R$ 1.500,00
      expect(screen.getByText('R$ 1.500,00')).toBeInTheDocument();
    });

    it('renders purposeLabel, supplier, installment', () => {
      mockWidth(375);
      render(<FinancialItemDetail item={makeItem()} onClose={() => {}} />);
      expect(screen.getByText('Material de construção')).toBeInTheDocument();
      expect(screen.getByText('Leroy Merlin')).toBeInTheDocument();
      expect(screen.getByText('2/6')).toBeInTheDocument();
    });

    it('renders card relationship as masked', () => {
      mockWidth(375);
      render(<FinancialItemDetail item={makeItem()} onClose={() => {}} />);
      expect(screen.getByText('•••• 4321')).toBeInTheDocument();
    });

    it('does not render null optional fields', () => {
      mockWidth(375);
      render(
        <FinancialItemDetail
          item={makeItem({ title: null, supplier: null, installment: null, paymentForm: null })}
          onClose={() => {}}
        />,
      );
      expect(screen.queryByText('Título')).not.toBeInTheDocument();
      expect(screen.queryByText('Fornecedor')).not.toBeInTheDocument();
      expect(screen.queryByText('Parcela')).not.toBeInTheDocument();
      // "Forma de pagamento" label should not exist
      expect(screen.queryByText('Forma de pagamento')).not.toBeInTheDocument();
    });

    it('shows Espelho badge when isEspelho', () => {
      mockWidth(375);
      render(<FinancialItemDetail item={makeItem({ isEspelho: true })} onClose={() => {}} />);
      expect(screen.getByText('Espelho')).toBeInTheDocument();
    });

    it('shows Neutro badge when isNeutral', () => {
      mockWidth(375);
      render(<FinancialItemDetail item={makeItem({ isNeutral: true })} onClose={() => {}} />);
      expect(screen.getByText('Neutro')).toBeInTheDocument();
    });
  });

  describe('hasEvidence', () => {
    it('does NOT show evidence badge when hasEvidence is false (V1 invariant)', () => {
      mockWidth(375);
      render(<FinancialItemDetail item={makeItem({ hasEvidence: false })} onClose={() => {}} />);
      expect(screen.queryByText('Com comprovante')).not.toBeInTheDocument();
    });

    it('shows evidence badge when hasEvidence is true (future H2)', () => {
      mockWidth(375);
      render(<FinancialItemDetail item={makeItem({ hasEvidence: true })} onClose={() => {}} />);
      expect(screen.getByText('Com comprovante')).toBeInTheDocument();
    });
  });

  describe('status labels', () => {
    it('maps PAGO to Pago', () => {
      mockWidth(375);
      render(<FinancialItemDetail item={makeItem({ status: 'PAGO' })} onClose={() => {}} />);
      expect(screen.getByText('Pago')).toBeInTheDocument();
    });

    it('maps PLANEJADO to Planejado', () => {
      mockWidth(375);
      render(<FinancialItemDetail item={makeItem({ status: 'PLANEJADO' })} onClose={() => {}} />);
      expect(screen.getByText('Planejado')).toBeInTheDocument();
    });

    it('passes through unknown status as-is', () => {
      mockWidth(375);
      render(<FinancialItemDetail item={makeItem({ status: 'CUSTOM' })} onClose={() => {}} />);
      expect(screen.getByText('CUSTOM')).toBeInTheDocument();
    });
  });

  describe('mutation testing: sheet/drawer conditional', () => {
    it('swapping condition would fail — sheet at 375 asserts absence of drawer', () => {
      mockWidth(375);
      render(<FinancialItemDetail item={makeItem()} onClose={() => {}} />);
      // Both assertions together catch any swap
      expect(screen.getByTestId('financial-detail-sheet')).toBeInTheDocument();
      expect(screen.queryByTestId('financial-detail-drawer')).toBeNull();
    });

    it('swapping condition would fail — drawer at 1024 asserts absence of sheet', () => {
      mockWidth(1024);
      render(<FinancialItemDetail item={makeItem()} onClose={() => {}} />);
      expect(screen.getByTestId('financial-detail-drawer')).toBeInTheDocument();
      expect(screen.queryByTestId('financial-detail-sheet')).toBeNull();
    });
  });
});
