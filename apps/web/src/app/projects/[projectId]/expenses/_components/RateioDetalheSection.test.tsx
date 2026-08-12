import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RateioDetalheSection } from './RateioDetalheSection';
import type { RateioDetalhe } from '../_hooks/useRateioDetalhe';

const BASE_DETALHE: RateioDetalhe = {
  sourceExpenseId: 'src-1',
  rateado: true,
  totalSourceCents: 20000,
  rateadoCents: 20000,
  sobraCents: 0,
  removedTargetsCount: 0,
  hiddenTargetsCount: 0,
  hiddenAllocationCents: 0,
  items: [
    {
      targetExpenseId: 'tgt-1',
      titulo: 'Piso porcelanato',
      fornecedor: null,
      projectId: 'p2',
      projectName: 'Reforma A',
      projectType: 'REFORMA',
      allocationCents: 12000,
      plannedValorTotalCents: 18000,
      status: 'PLANEJADO',
    },
    {
      targetExpenseId: 'tgt-2',
      titulo: null,
      fornecedor: 'Loja XPTO',
      projectId: 'p3',
      projectName: 'Carro',
      projectType: 'CARRO',
      allocationCents: 8000,
      plannedValorTotalCents: null,
      status: 'PAGO',
    },
  ],
};

describe('RateioDetalheSection', () => {
  it('estado loading é explícito', () => {
    render(<RateioDetalheSection isLoading isError={false} detalhe={undefined} onRetry={vi.fn()} />);
    expect(screen.getByText(/carregando/i)).toBeInTheDocument();
  });

  it('estado loading expõe hook data-testid=rateio-loading para e2e', () => {
    render(<RateioDetalheSection isLoading isError={false} detalhe={undefined} onRetry={vi.fn()} />);
    expect(screen.getByTestId('rateio-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('rateio-error')).not.toBeInTheDocument();
  });

  it('estado de erro mostra retry acionável', () => {
    const onRetry = vi.fn();
    render(<RateioDetalheSection isLoading={false} isError detalhe={undefined} onRetry={onRetry} />);
    const retryBtn = screen.getByRole('button', { name: /tentar novamente/i });
    fireEvent.click(retryBtn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('estado de erro expõe hooks data-testid=rateio-error e rateio-retry para e2e', () => {
    const onRetry = vi.fn();
    render(<RateioDetalheSection isLoading={false} isError detalhe={undefined} onRetry={onRetry} />);
    expect(screen.getByTestId('rateio-error')).toBeInTheDocument();
    const retryBtn = screen.getByTestId('rateio-retry');
    expect(retryBtn).toBeInTheDocument();
    fireEvent.click(retryBtn);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('rateio-loading')).not.toBeInTheDocument();
  });

  it('não renderiza nada quando a despesa não é rateada', () => {
    const { container } = render(
      <RateioDetalheSection
        isLoading={false}
        isError={false}
        detalhe={{ ...BASE_DETALHE, rateado: false, items: [] }}
        onRetry={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('rateado=true lista todas as allocations com fallback título→fornecedor→"Despesa"', () => {
    render(<RateioDetalheSection isLoading={false} isError={false} detalhe={BASE_DETALHE} onRetry={vi.fn()} />);
    expect(screen.getByText('Piso porcelanato')).toBeInTheDocument();
    expect(screen.getByText('Loja XPTO')).toBeInTheDocument();
    expect(screen.getByText('Reforma A')).toBeInTheDocument();
    expect(screen.getByText('Carro')).toBeInTheDocument();
  });

  it('usa "Despesa" quando título e fornecedor são null', () => {
    const detalhe: RateioDetalhe = {
      ...BASE_DETALHE,
      items: [
        {
          targetExpenseId: 'tgt-3',
          titulo: null,
          fornecedor: null,
          projectId: 'p4',
          projectName: 'Casa',
          projectType: 'CASA',
          allocationCents: 5000,
          plannedValorTotalCents: null,
          status: 'PLANEJADO',
        },
      ],
    };
    render(<RateioDetalheSection isLoading={false} isError={false} detalhe={detalhe} onRetry={vi.fn()} />);
    expect(screen.getByText('Despesa')).toBeInTheDocument();
  });

  it('mostra o planejado original quando plannedValorTotalCents não é null', () => {
    render(<RateioDetalheSection isLoading={false} isError={false} detalhe={BASE_DETALHE} onRetry={vi.fn()} />);
    expect(screen.getByText(/planejado original/i)).toBeInTheDocument();
  });

  it('mostra header com total/rateado/sobra', () => {
    render(<RateioDetalheSection isLoading={false} isError={false} detalhe={BASE_DETALHE} onRetry={vi.fn()} />);
    expect(screen.getAllByText('R$ 200,00').length).toBeGreaterThanOrEqual(2); // total e rateado
    expect(screen.getByText('R$ 0,00')).toBeInTheDocument(); // sobra
  });

  it('mostra warning quando removedTargetsCount > 0', () => {
    render(
      <RateioDetalheSection
        isLoading={false}
        isError={false}
        detalhe={{ ...BASE_DETALHE, removedTargetsCount: 1 }}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('mostra warning quando sobra != 0', () => {
    render(
      <RateioDetalheSection
        isLoading={false}
        isError={false}
        detalhe={{ ...BASE_DETALHE, sobraCents: 500 }}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('não mostra warning quando removedTargetsCount=0 e sobra=0', () => {
    render(<RateioDetalheSection isLoading={false} isError={false} detalhe={BASE_DETALHE} onRetry={vi.fn()} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('expõe o contrato numérico em data-attributes (nunca depender do BRL renderizado)', () => {
    render(
      <RateioDetalheSection
        isLoading={false}
        isError={false}
        detalhe={{ ...BASE_DETALHE, hiddenTargetsCount: 1, hiddenAllocationCents: 5000 }}
        onRetry={vi.fn()}
      />,
    );
    const box = screen.getByTestId('rateio-detalhe');
    expect(box).toHaveAttribute('data-total-cents', '20000');
    expect(box).toHaveAttribute('data-rateado-cents', '20000');
    expect(box).toHaveAttribute('data-sobra-cents', '0');
    expect(box).toHaveAttribute('data-hidden-targets-count', '1');
    expect(box).toHaveAttribute('data-hidden-allocation-cents', '5000');
  });

  it('alocações ocultas aparecem como linha informativa — e não como alerta de divergência', () => {
    render(
      <RateioDetalheSection
        isLoading={false}
        isError={false}
        detalhe={{ ...BASE_DETALHE, hiddenTargetsCount: 2, hiddenAllocationCents: 40000 }}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByTestId('rateio-hidden')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); // sobra = 0 ⇒ nada de âmbar
  });

  it('todos os alvos ocultos: NÃO fica em branco — mostra totais e a linha de ocultos', () => {
    render(
      <RateioDetalheSection
        isLoading={false}
        isError={false}
        detalhe={{ ...BASE_DETALHE, items: [], hiddenTargetsCount: 9, hiddenAllocationCents: 20000 }}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByTestId('rateio-detalhe')).toBeInTheDocument();
    expect(screen.queryAllByTestId('rateio-item')).toHaveLength(0);
    expect(screen.getByTestId('rateio-hidden')).toHaveTextContent(/9/);
  });

  it('sem ocultos, nenhuma linha de ocultos é renderizada (fronteira 0)', () => {
    render(<RateioDetalheSection isLoading={false} isError={false} detalhe={BASE_DETALHE} onRetry={vi.fn()} />);
    expect(screen.queryByTestId('rateio-hidden')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('rateio-item')).toHaveLength(2);
  });

  it('cada <li> de item expõe data-target-expense-id para navegação e2e', () => {
    render(<RateioDetalheSection isLoading={false} isError={false} detalhe={BASE_DETALHE} onRetry={vi.fn()} />);
    const items = screen.getAllByTestId('rateio-item');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveAttribute('data-target-expense-id', 'tgt-1');
    expect(items[1]).toHaveAttribute('data-target-expense-id', 'tgt-2');
  });
});
