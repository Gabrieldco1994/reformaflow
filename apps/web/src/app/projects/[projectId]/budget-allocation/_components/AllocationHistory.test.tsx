import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AllocationHistory from './AllocationHistory';

/**
 * #490 / D-D — contrato do histórico congelado.
 *
 * Aqui NÃO se mede geometria: em jsdom `getBoundingClientRect` devolve zeros e
 * qualquer asserção de largura/altura passa por vacuidade (`0 >= 0`). O corte
 * de 375px é medido em Playwright (`e2e/visible-defects-490.spec.ts`). O que
 * este arquivo trava é ESTRUTURA: que a lista exista, que ela carregue os
 * mesmos dados da tabela, e que o total duplicado não volte.
 */

const allocations = [
  {
    id: 'a1',
    dataAlocacao: '2026-07-03T12:00:00.000Z',
    mes: '2026-07',
    valor: 125_000_00,
    descricao: null,
    targetProject: { id: 'p1', name: 'Apartamento Higienópolis' },
  },
  {
    id: 'a2',
    dataAlocacao: '2026-06-22T12:00:00.000Z',
    mes: '2026-06',
    valor: 4_530_00,
    descricao: 'Entrada da marcenaria',
    targetProject: null,
  },
];

describe('AllocationHistory', () => {
  it('rende uma linha de lista por alocação, além da tabela', () => {
    const { container } = render(<AllocationHistory allocations={allocations} />);
    expect(container.querySelectorAll('[data-allocation-row]')).toHaveLength(allocations.length);
    // A tabela continua existindo: ela é o layout de `sm` para cima.
    expect(container.querySelector('table')).not.toBeNull();
  });

  it('a linha carrega projeto, valor, data e mês de referência', () => {
    const { container } = render(<AllocationHistory allocations={allocations} />);
    const row = container.querySelectorAll('[data-allocation-row]')[0] as HTMLElement;

    expect(within(row).getByText('Apartamento Higienópolis')).toBeTruthy();
    expect(within(row).getByText('R$ 125.000,00')).toBeTruthy();
    // "Nada sai": data e competência continuam na linha, como apoio.
    expect(row.textContent).toContain('03 jul');
    expect(row.textContent).toContain('ref. jul/2026');
  });

  it('a data não escorrega de fuso: 03/07 em UTC continua 03 jul', () => {
    // `new Date('...T12:00:00Z').toLocaleDateString` já viraria 03/07 em BRT,
    // mas o campo é marco de escrituração — a fatia do ISO não depende de fuso.
    const { container } = render(
      <AllocationHistory
        allocations={[{ ...allocations[0], dataAlocacao: '2026-07-01T00:00:00.000Z' }]}
      />,
    );
    const row = container.querySelector('[data-allocation-row]') as HTMLElement;
    expect(row.textContent).toContain('01 jul');
  });

  it('linha redigida mostra o rótulo de fallback sem perder o valor', () => {
    const { container } = render(<AllocationHistory allocations={allocations} />);
    const row = container.querySelectorAll('[data-allocation-row]')[1] as HTMLElement;

    // #449 B2: a API devolve `targetProject: null` para relação de outro
    // tenant. Some a IDENTIDADE do alvo, nunca o dinheiro.
    expect(within(row).getByText('Projeto indisponível')).toBeTruthy();
    expect(within(row).getByText('R$ 4.530,00')).toBeTruthy();
    expect(row.textContent).toContain('Entrada da marcenaria');
  });

  it('não soma "Total Alocado" no template', () => {
    // O total é do servidor e vive no card "Resumo do Budget". Um segundo
    // "Total Alocado" aqui seria o MESMO rótulo com origem própria: os dois
    // batem hoje só porque o filtro de escopo de `findAll` colapsa para quem
    // alcança esta tela — igualdade acidental, não estrutural.
    render(<AllocationHistory allocations={allocations} />);
    expect(screen.queryByText(/Total Alocado/i)).toBeNull();
  });

  it('estado vazio continua sem lista e sem tabela', () => {
    const { container } = render(<AllocationHistory allocations={[]} />);
    expect(screen.getByText('Nenhuma alocação realizada ainda.')).toBeTruthy();
    expect(container.querySelectorAll('[data-allocation-row]')).toHaveLength(0);
    expect(container.querySelector('table')).toBeNull();
  });
});
