import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ExpenseCategoryGroup } from '../_hooks/useExpenseFilters';
import { CategoryExpenseView } from './CategoryExpenseView';
import type { ExpensePaidOrigin, PaidOriginRef } from '@/types';

const nubank: PaidOriginRef = {
  kind: 'card', last4: '3541', nickname: 'Nubank', institution: 'Mastercard',
  sourceProjectId: 'p', sourceProjectName: 'Pessoal',
};
const latam: PaidOriginRef = { ...nubank, last4: '5572', nickname: 'Latam' };

function buildCategorias(): ExpenseCategoryGroup[] {
  return [
    {
      tipo: 'MATERIAL_CONSTRUCAO',
      label: 'Material de construção',
      total: 60_000,
      totalPago: 0,
      totalPlanejado: 60_000,
      expenses: [
        {
          id: 'expense-unica',
          tipoDespesa: 'MATERIAL_CONSTRUCAO',
          valor: 30_000,
          quantidade: 1,
          valorTotal: 30_000,
          formaPagamento: 'A_VISTA',
          status: 'PLANEJADO',
        },
        {
          id: 'expense-multipla',
          tipoDespesa: 'MATERIAL_CONSTRUCAO',
          valor: 30_000,
          quantidade: 1,
          valorTotal: 30_000,
          formaPagamento: 'A_VISTA',
          status: 'PLANEJADO',
        },
        {
          id: 'expense-sem-origem',
          tipoDespesa: 'MATERIAL_CONSTRUCAO',
          valor: 30_000,
          quantidade: 1,
          valorTotal: 30_000,
          formaPagamento: 'A_VISTA',
          status: 'PLANEJADO',
        },
      ] as any,
    },
  ];
}

function baseProps() {
  return {
    categorias: buildCategorias(),
    collapsedCategories: new Set<string>(),
    toggleCategory: vi.fn(),
    tipoLabel: (v: string) => v,
    openEdit: vi.fn(),
    onDelete: vi.fn(),
    onToggleStatus: vi.fn(),
    onQuickUpdate: vi.fn(),
    onQuickCreate: vi.fn(),
    emptyMsg: 'vazio',
  };
}

describe('CategoryExpenseView — origem agregada (#424)', () => {
  it('origem única mostra o rótulo completo', () => {
    const paidOrigins = new Map<string, ExpensePaidOrigin>([
      [
        'expense-unica',
        { expenseId: 'expense-unica', via: 'link', multiple: false, parcelas: [], origins: [nubank] },
      ],
    ]);

    render(<CategoryExpenseView {...baseProps()} paidOrigins={paidOrigins} />);

    expect(screen.getByText('Nubank ••3541')).toBeInTheDocument();
  });

  it('multiple=true mostra "Múltiplas origens" e NÃO um rótulo específico', () => {
    const paidOrigins = new Map<string, ExpensePaidOrigin>([
      [
        'expense-multipla',
        {
          expenseId: 'expense-multipla',
          via: 'settlement',
          multiple: true,
          parcelas: [
            { parcelaIndex: 0, origin: nubank },
            { parcelaIndex: 1, origin: latam },
          ],
          origins: [nubank, latam],
        },
      ],
    ]);

    render(<CategoryExpenseView {...baseProps()} paidOrigins={paidOrigins} />);

    expect(screen.getByText('Múltiplas origens')).toBeInTheDocument();
    expect(screen.queryByText('Nubank ••3541')).toBeNull();
  });

  it('despesa sem entrada em paidOrigins não mostra badge algum', () => {
    const paidOrigins = new Map<string, ExpensePaidOrigin>([
      [
        'expense-unica',
        { expenseId: 'expense-unica', via: 'link', multiple: false, parcelas: [], origins: [nubank] },
      ],
    ]);

    render(<CategoryExpenseView {...baseProps()} paidOrigins={paidOrigins} />);

    // expense-sem-origem não tem entrada no Map: nenhum badge "••" associado a ele.
    expect(screen.getAllByText(/••/)).toHaveLength(1);
  });
});
