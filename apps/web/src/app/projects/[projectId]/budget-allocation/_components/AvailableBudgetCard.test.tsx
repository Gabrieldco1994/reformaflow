import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AvailableBudgetCard from './AvailableBudgetCard';

/**
 * #504 — o card ficou prometendo o que a tela não faz mais.
 *
 * O #449/#500 congelou Alocação de Budget: `POST`/`PATCH`/`DELETE` respondem
 * 404 para todo papel e o cabeçalho da página já diz "Somente leitura". O card
 * não acompanhou e continuou anunciando "Budget Disponível → Disponível para
 * Alocar → R$ 162.499,50", além de instruir "adicione recebimentos EM CAIXA
 * para poder alocar budget" — uma instrução para uma ação que a API recusa.
 *
 * Promessa financeira sem ação atrás é pior que ausência de informação: manda
 * o administrador procurar um botão que não existe. Estes testes travam o tom
 * honesto e o número, que continua correto e útil.
 */

/** Frases que só fazem sentido se ainda desse para alocar. */
const ACTION_PROMISES = [
  /para alocar/i,
  /poder alocar/i,
  /adicione recebimentos/i,
  /nova aloca/i,
];

function cardText() {
  return document.body.textContent ?? '';
}

describe('AvailableBudgetCard — tela congelada, texto honesto (#504)', () => {
  it('não promete alocação em nenhum estado do card', () => {
    const states = [
      { available: 16249950, totalAllocated: 23500000, totalExpenses: 5000, totalReceipts: 40000000 },
      { available: 0, totalAllocated: 0, totalExpenses: 0, totalReceipts: 0 },
      { available: 0, totalAllocated: 23500000, totalExpenses: 100, totalReceipts: 23500100 },
    ];

    for (const state of states) {
      const view = render(<AvailableBudgetCard {...state} allocations={[]} />);
      for (const promise of ACTION_PROMISES) {
        expect(cardText()).not.toMatch(promise);
      }
      view.unmount();
    }
  });

  it('nomeia o número pelo que ele é — saldo histórico, não verba disponível', () => {
    render(
      <AvailableBudgetCard
        available={16249950}
        totalAllocated={23500000}
        totalExpenses={5000}
        totalReceipts={40000000}
        allocations={[]}
      />,
    );

    expect(screen.getByText('Saldo não alocado')).toBeInTheDocument();
    expect(screen.queryByText('Disponível para Alocar')).not.toBeInTheDocument();
    expect(screen.queryByText('Budget Disponível')).not.toBeInTheDocument();
  });

  it('diz explicitamente que a alocação está encerrada', () => {
    render(
      <AvailableBudgetCard available={16249950} totalAllocated={0} allocations={[]} />,
    );

    expect(cardText()).toMatch(/encerrad/i);
  });

  it('preserva o contrato do valor: centavos vindos da API, divididos por 100', () => {
    render(
      <AvailableBudgetCard
        available={16249950}
        totalAllocated={23500000}
        totalExpenses={5000}
        totalReceipts={40000000}
        allocations={[{ projectName: 'Reforma', projectType: 'REFORMA', total: 23500000 }]}
      />,
    );

    expect(screen.getByText('R$ 162.499,50')).toBeInTheDocument();
    // O total alocado aparece no resumo E na linha do projeto de destino.
    expect(screen.getAllByText(/R\$ 235\.000,00/).length).toBeGreaterThan(0);
  });

  it('explica saldo zero como fato, sem mandar o usuário resolver o que não dá para resolver', () => {
    const semRecebimentos = render(
      <AvailableBudgetCard available={0} totalAllocated={0} totalReceipts={0} allocations={[]} />,
    );
    expect(cardText()).toMatch(/EM CAIXA/);
    semRecebimentos.unmount();

    render(
      <AvailableBudgetCard
        available={0}
        totalAllocated={23500000}
        totalExpenses={100}
        totalReceipts={23500100}
        allocations={[]}
      />,
    );
    expect(cardText()).toMatch(/comprometid/i);
  });

  it('mantém a relação redigida legível quando a API omite o projeto de outro tenant', () => {
    render(
      <AvailableBudgetCard
        available={0}
        totalAllocated={23500000}
        allocations={[{ projectName: null, projectType: null, total: 23500000 }]}
      />,
    );

    expect(screen.getByText('Projeto indisponível')).toBeInTheDocument();
  });
});
