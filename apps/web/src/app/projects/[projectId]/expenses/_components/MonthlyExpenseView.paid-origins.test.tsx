import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { GrupoDespesaPorMes } from '../_lib/grouping-by-month';
import { MonthlyExpenseView } from './MonthlyExpenseView';
import type { ExpensePaidOrigin, PaidOriginRef } from '@/types';

const nubank: PaidOriginRef = {
  kind: 'card', last4: '3541', nickname: 'Nubank', institution: 'Mastercard',
  sourceProjectId: 'p', sourceProjectName: 'Pessoal',
};
const latam: PaidOriginRef = { ...nubank, last4: '5572', nickname: 'Latam' };
const contaSemApelido: PaidOriginRef = {
  kind: 'bank', last4: '7424', nickname: null, institution: 'ITAU',
  sourceProjectId: 'p', sourceProjectName: 'Pessoal',
};

function buildGrouped(): GrupoDespesaPorMes[] {
  return [
    {
      mesKey: '2026-10',
      mesLabel: 'Outubro 2026',
      total: 60_000,
      totalPago: 0,
      totalPlanejado: 60_000,
      isCurrentMonth: false,
      isFuture: true,
      items: [
        {
          id: 'expense-infra',
          tipoDespesa: 'MATERIAL_CONSTRUCAO',
          valor: 30_000,
          quantidade: 1,
          valorTotal: 60_000,
          formaPagamento: 'PARCELADO',
          quantidadeParcela: 6,
          dataInicioParcela: '2026-06-10',
          status: 'PLANEJADO',
          cardLast4: null,
          bankLast4: null,
          occKey: 'expense-infra#4',
          occDate: '2026-10-10',
          occValue: 30_000,
          occIndex: 5,
          occTotalParcelas: 6,
        },
        {
          id: 'expense-infra',
          tipoDespesa: 'MATERIAL_CONSTRUCAO',
          valor: 30_000,
          quantidade: 1,
          valorTotal: 60_000,
          formaPagamento: 'PARCELADO',
          quantidadeParcela: 6,
          dataInicioParcela: '2026-06-10',
          status: 'PLANEJADO',
          cardLast4: null,
          bankLast4: null,
          occKey: 'expense-infra#5',
          occDate: '2026-11-10',
          occValue: 30_000,
          occIndex: 6,
          occTotalParcelas: 6,
        },
      ],
    },
  ];
}

function baseProps() {
  return {
    grouped: buildGrouped(),
    collapsedMonths: new Set<string>(),
    toggleMonth: vi.fn(),
    tipoLabel: (v: string) => v,
    tipoOptions: [],
    openEdit: vi.fn(),
    onDelete: vi.fn(),
    onToggleStatus: vi.fn(),
    onQuickUpdate: vi.fn(),
    onQuickCreate: vi.fn(),
    emptyMsg: 'vazio',
  };
}

describe('MonthlyExpenseView — origem PESSOAL por parcela (#424)', () => {
  it('mostra a origem SÓ na ocorrência cuja parcela foi quitada', () => {
    const paidOrigins = new Map<string, ExpensePaidOrigin>([
      [
        'expense-infra',
        {
          expenseId: 'expense-infra',
          via: 'settlement',
          multiple: false,
          parcelas: [{ parcelaIndex: 4, origin: nubank }],
          origins: [nubank],
        },
      ],
    ]);

    render(<MonthlyExpenseView {...baseProps()} paidOrigins={paidOrigins} />);

    expect(screen.getAllByText('Nubank ••3541')).toHaveLength(1);
  });

  it('ocorrências com cartões DIFERENTES mostram rótulos diferentes lado a lado', () => {
    const paidOrigins = new Map<string, ExpensePaidOrigin>([
      [
        'expense-infra',
        {
          expenseId: 'expense-infra',
          via: 'settlement',
          multiple: true,
          parcelas: [
            { parcelaIndex: 4, origin: nubank },
            { parcelaIndex: 5, origin: latam },
          ],
          origins: [nubank, latam],
        },
      ],
    ]);

    render(<MonthlyExpenseView {...baseProps()} paidOrigins={paidOrigins} />);

    expect(screen.getByText('Nubank ••3541')).toBeInTheDocument();
    expect(screen.getByText('Latam ••5572')).toBeInTheDocument();
  });

  it('alvo RATEADO mostra a MESMA origem em todas as ocorrências', () => {
    const grouped: GrupoDespesaPorMes[] = [
      {
        mesKey: '2026-10',
        mesLabel: 'Outubro 2026',
        total: 90_000,
        totalPago: 0,
        totalPlanejado: 90_000,
        isCurrentMonth: false,
        isFuture: true,
        items: [1, 2, 3].map((i) => ({
          id: 'expense-rateado',
          tipoDespesa: 'MATERIAL_CONSTRUCAO',
          valor: 30_000,
          quantidade: 1,
          valorTotal: 90_000,
          formaPagamento: 'PARCELADO',
          quantidadeParcela: 3,
          dataInicioParcela: '2026-08-10',
          status: 'PLANEJADO',
          cardLast4: null,
          bankLast4: null,
          occKey: `expense-rateado#${i - 1}`,
          occDate: `2026-${String(9 + i).padStart(2, '0')}-10`,
          occValue: 30_000,
          occIndex: i,
          occTotalParcelas: 3,
        })),
      },
    ];

    const paidOrigins = new Map<string, ExpensePaidOrigin>([
      [
        'expense-rateado',
        {
          expenseId: 'expense-rateado',
          via: 'rateio',
          multiple: false,
          parcelas: [],
          origins: [latam],
        },
      ],
    ]);

    render(
      <MonthlyExpenseView {...baseProps()} grouped={grouped} paidOrigins={paidOrigins} />,
    );

    expect(screen.getAllByText('Latam ••5572')).toHaveLength(3);
  });

  it('conta bancária sem apelido usa o fallback "Conta ••7424"', () => {
    const paidOrigins = new Map<string, ExpensePaidOrigin>([
      [
        'expense-infra',
        {
          expenseId: 'expense-infra',
          via: 'settlement',
          multiple: false,
          parcelas: [{ parcelaIndex: 4, origin: contaSemApelido }],
          origins: [contaSemApelido],
        },
      ],
    ]);

    render(<MonthlyExpenseView {...baseProps()} paidOrigins={paidOrigins} />);

    expect(screen.getByText('Conta ••7424')).toBeInTheDocument();
  });

  it('sem paidOrigins (loading/erro/undefined) não renderiza rótulo nem quebra a lista', () => {
    render(<MonthlyExpenseView {...baseProps()} />);

    expect(screen.queryByText(/••/)).toBeNull();
    expect(screen.getAllByText('MATERIAL_CONSTRUCAO').length).toBeGreaterThan(0);
  });

  it('O1: o rótulo é derivado e NÃO vem de cardLast4/bankLast4 do alvo', () => {
    const paidOrigins = new Map<string, ExpensePaidOrigin>([
      [
        'expense-infra',
        {
          expenseId: 'expense-infra',
          via: 'settlement',
          multiple: false,
          parcelas: [{ parcelaIndex: 4, origin: nubank }],
          origins: [nubank],
        },
      ],
    ]);

    render(<MonthlyExpenseView {...baseProps()} paidOrigins={paidOrigins} />);

    expect(screen.getByText('Nubank ••3541')).toBeInTheDocument();
  });

  it('não introduz fluxo de edição: o rótulo não é um botão', () => {
    const paidOrigins = new Map<string, ExpensePaidOrigin>([
      [
        'expense-infra',
        {
          expenseId: 'expense-infra',
          via: 'settlement',
          multiple: false,
          parcelas: [{ parcelaIndex: 4, origin: nubank }],
          origins: [nubank],
        },
      ],
    ]);

    render(<MonthlyExpenseView {...baseProps()} paidOrigins={paidOrigins} />);

    expect(screen.queryByRole('button', { name: /Nubank/ })).toBeNull();
  });

  it('mantém a edição completa alcançável no mobile com alvo de toque de 44px', () => {
    const props = baseProps();
    render(<MonthlyExpenseView {...props} />);

    const actions = screen.getAllByRole('button', { name: 'Editar completo' });
    actions.forEach((action) => {
      expect(action).not.toHaveClass('hidden');
      expect(action).toHaveClass('min-h-[44px]', 'min-w-[44px]');
    });

    fireEvent.click(actions[0]!);
    expect(props.openEdit).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'expense-infra' }),
    );
  });
});
