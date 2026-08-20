import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RateioDetalheSection } from './RateioDetalheSection';
import type { RateioDetalhe } from '../_hooks/useRateioDetalhe';

/**
 * Contrato SOURCE-ONLY do B1b (#448), já entregue no servidor.
 *
 * `hiddenTargetsCount`/`hiddenAllocationCents` NÃO EXISTEM MAIS: participante
 * fora da lente é omitido por inteiro, `rateadoCents` é Σ dos itens visíveis e
 * `rateado: false` quando nada é visível. Este arquivo prova que a renderização
 * não depende do campo morto, não vira `R$ NaN`, não fabrica alarme — e que a
 * copy não insinua que existe algo oculto (isso reabriria pelo texto o
 * vazamento que o payload fechou).
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
    // Sob o contrato source-only a sobra do viewer restrito é a leitura CORRETA
    // de "esse dinheiro não está alocado" — não é erro dele, e a frase não pode
    // soar como se fosse NEM sugerir que há participante escondido.
    const alerta = screen.getByRole('alert');
    expect(alerta).toHaveTextContent('Esta compra tem R$ 5,00 sem alocação em planejadas.');
    expect(screen.queryByText(/não fecha o total/i)).not.toBeInTheDocument();
    expect(alerta.textContent ?? '').not.toMatch(/você vê|vis[íi]ve|oculta|escondid|sem acesso/i);
  });

  it('não mostra warning quando removedTargetsCount=0 e sobra=0', () => {
    render(<RateioDetalheSection isLoading={false} isError={false} detalhe={BASE_DETALHE} onRetry={vi.fn()} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('expõe o contrato numérico em data-attributes (nunca depender do BRL renderizado)', () => {
    render(<RateioDetalheSection isLoading={false} isError={false} detalhe={BASE_DETALHE} onRetry={vi.fn()} />);
    const box = screen.getByTestId('rateio-detalhe');
    expect(box).toHaveAttribute('data-total-cents', '20000');
    expect(box).toHaveAttribute('data-rateado-cents', '20000');
    expect(box).toHaveAttribute('data-sobra-cents', '0');
  });

  it('nenhum data-attribute de metadata oculta é emitido — nem contra API pré-B1b', () => {
    // Intenção preservada do caso legado: o servidor VELHO ainda manda
    // `hiddenTargetsCount`/`hiddenAllocationCents`. O bundle novo tem que
    // ignorá-los por completo — renderizá-los seria publicar metadata que o
    // contrato atual decidiu não emitir.
    const legado = {
      ...BASE_DETALHE,
      hiddenTargetsCount: 2,
      hiddenAllocationCents: 40000,
    } as unknown as RateioDetalhe;
    render(<RateioDetalheSection isLoading={false} isError={false} detalhe={legado} onRetry={vi.fn()} />);
    const box = screen.getByTestId('rateio-detalhe');
    expect(box).not.toHaveAttribute('data-hidden-targets-count');
    expect(box).not.toHaveAttribute('data-hidden-allocation-cents');
    expect(screen.queryByTestId('rateio-hidden')).not.toBeInTheDocument();
    expect(box.textContent ?? '').not.toMatch(/oculta|sem acesso|R\$ 400,00/i);
  });

  it('`rateado: false` (nenhum participante visível) não renderiza a seção', () => {
    // SOURCE-ONLY estrito (#448, revisão do B1b em #499): com qualquer alvo
    // fora da lente a resposta é a de uma compra NUNCA rateada — a seção some,
    // em vez de anunciar "alguém dividiu isto com você". `sobraCents` chega
    // igual ao total; nada disso pode virar aviso, âmbar ou valor na tela.
    const { container } = render(
      <RateioDetalheSection
        isLoading={false}
        isError={false}
        detalhe={{
          ...BASE_DETALHE,
          rateado: false,
          items: [],
          removedTargetsCount: 0,
          rateadoCents: 0,
          sobraCents: BASE_DETALHE.totalSourceCents,
        }}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('rateio-detalhe')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
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
 * Payload REDIGIDO: parte das alocações está fora da lente do requisitante.
 * Por design ele é deep-equal ao de uma compra sem nada oculto — nada aqui pode
 * distinguir os dois casos, nem para renderizar nem para inferir.
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
    // `rateadoCents` já vem como Σ dos itens VISÍVEIS (B1b), então R$ 80,00
    // aparecem como sobra. Renderizar é o certo; a frase é que não pode
    // denunciar de onde vem o buraco.
    const alerta = screen.getByRole('alert');
    expect(alerta).toHaveTextContent('Esta compra tem R$ 80,00 sem alocação em planejadas.');
    expect(alerta.textContent ?? '').not.toMatch(/você vê|vis[íi]ve|oculta|escondid|sem acesso/i);
  });

  it('é INDISTINGUÍVEL de uma compra sem nada oculto — mesma renderização, byte a byte', () => {
    // A prova do contrato source-only no lado do web: dois payloads iguais
    // renderizam igual, então nenhuma pista de UI (número, frase, atributo)
    // permite inferir que o segundo teve participante omitido.
    const { container: comOculto } = render(
      <RateioDetalheSection isLoading={false} isError={false} detalhe={REDIGIDO} onRetry={vi.fn()} />,
    );
    const htmlComOculto = comOculto.innerHTML;
    const semOculto: RateioDetalhe = { ...REDIGIDO };
    const { container: visivel } = render(
      <RateioDetalheSection isLoading={false} isError={false} detalhe={semOculto} onRetry={vi.fn()} />,
    );
    expect(visivel.innerHTML).toBe(htmlComOculto);
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
