import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RateioDetalheSection } from './RateioDetalheSection';
import type { RateioDetalhe } from '../_hooks/useRateioDetalhe';

/**
 * Contrato MIXED-VERSION (#448 W1). Este componente renderiza DUAS formas do
 * payload de `GET :id/rateio`, porque web e API não sobem juntos:
 *
 *  - **API pré-B1b (legado):** manda `hiddenTargetsCount`,
 *    `hiddenAllocationCents` e `removedTargetsCount`.
 *  - **API B1b (atual):** esses três campos SAÍRAM do contrato — o payload
 *    redigido é deep-equal a um sem nada oculto, por design.
 *
 * Os casos marcados "API pré-B1b" existem para provar que o bundle novo não
 * quebra contra o servidor antigo; os marcados "API B1b" provam que o campo
 * ausente não vira `R$ NaN`, linha fantasma nem alarme fabricado.
 */

const BASE_DETALHE: RateioDetalhe = {
  sourceExpenseId: 'src-1',
  rateado: true,
  totalSourceCents: 20000,
  rateadoCents: 20000,
  sobraCents: 0,
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

  it('mostra warning quando removedTargetsCount > 0 (API pré-B1b)', () => {
    render(
      <RateioDetalheSection
        isLoading={false}
        isError={false}
        detalhe={{ ...BASE_DETALHE, removedTargetsCount: 1 }}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('1 planejada removida deste rateio.');
  });

  it('sobra != 0 avisa SEM acusar defeito de dado (viewer restrito vê sobra legítima)', () => {
    render(
      <RateioDetalheSection
        isLoading={false}
        isError={false}
        detalhe={{ ...BASE_DETALHE, sobraCents: 500 }}
        onRetry={vi.fn()}
      />,
    );
    // Sob o contrato B1b a sobra do viewer restrito é a leitura CORRETA de
    // "até onde você enxerga, esse dinheiro não está alocado" — não é erro
    // dele, e a frase não pode soar como se fosse.
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Parte desta compra não está alocada nas planejadas que você vê.',
    );
    expect(screen.queryByText(/não fecha o total/i)).not.toBeInTheDocument();
  });

  it('não mostra warning quando removedTargetsCount=0 e sobra=0', () => {
    render(<RateioDetalheSection isLoading={false} isError={false} detalhe={BASE_DETALHE} onRetry={vi.fn()} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('expõe o contrato numérico em data-attributes (nunca depender do BRL renderizado) — API pré-B1b', () => {
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

  it('alocações ocultas aparecem como linha informativa — e não como alerta de divergência (API pré-B1b)', () => {
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

  it('todos os alvos ocultos: NÃO fica em branco — mostra totais e a linha de ocultos (API pré-B1b)', () => {
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

/**
 * API B1b: os três campos de visibilidade não existem mais no payload. Nada
 * aqui pode depender deles — nem para renderizar, nem para inferir.
 */
describe('RateioDetalheSection · payload redigido (API B1b, #448)', () => {
  /** Rateio parcialmente visível: 1 alvo de R$ 120,00 num total de R$ 200,00. */
  const REDIGIDO: RateioDetalhe = {
    sourceExpenseId: 'src-1',
    rateado: true,
    totalSourceCents: 20000,
    rateadoCents: 12000,
    sobraCents: 8000,
    items: [BASE_DETALHE.items[0]],
  };

  it('sem os campos de visibilidade: renderiza os itens visíveis e nada de NaN', () => {
    const { container } = render(
      <RateioDetalheSection isLoading={false} isError={false} detalhe={REDIGIDO} onRetry={vi.fn()} />,
    );
    expect(screen.getAllByTestId('rateio-item')).toHaveLength(1);
    expect(container.textContent).not.toMatch(/NaN/);
  });

  it('não inventa linha de ocultos nem data-attributes que o servidor não mandou', () => {
    render(<RateioDetalheSection isLoading={false} isError={false} detalhe={REDIGIDO} onRetry={vi.fn()} />);
    expect(screen.queryByTestId('rateio-hidden')).not.toBeInTheDocument();
    const box = screen.getByTestId('rateio-detalhe');
    expect(box).not.toHaveAttribute('data-hidden-targets-count');
    expect(box).not.toHaveAttribute('data-hidden-allocation-cents');
  });

  it('sobra visível != 0 continua avisando (não suprimir) — com a cópia neutra', () => {
    render(<RateioDetalheSection isLoading={false} isError={false} detalhe={REDIGIDO} onRetry={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Parte desta compra não está alocada nas planejadas que você vê.',
    );
  });

  it('centavos ausentes viram "—" em vez de R$ NaN (contrato encolhendo ainda mais)', () => {
    const semNumeros = {
      ...REDIGIDO,
      rateadoCents: undefined,
      sobraCents: undefined,
    } as unknown as RateioDetalhe;
    const { container } = render(
      <RateioDetalheSection isLoading={false} isError={false} detalhe={semNumeros} onRetry={vi.fn()} />,
    );
    expect(container.textContent).not.toMatch(/NaN/);
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
