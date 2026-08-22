import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import MobileMonthHero from './MobileMonthHero';
import type { CockpitTopDerived } from './derive';
import { duplicates, nameCensus } from '@/test-utils/accessible-name-census';

/**
 * Herói mobile de `/monthly` — nenhum nome acessível designa dois controles.
 *
 * O herói tinha TRÊS controles rolando para a mesma âncora
 * (`#mobile-cockpit-runway`), dois deles com `aria-label` literalmente igual:
 * "Rolar até projeção detalhada". Para quem navega por leitor de tela a lista
 * de controles fica com duas entradas indistinguíveis; para quem enxerga, "fim
 * do mês" parece um link e é só a legenda do eixo direito da barra de progresso
 * (o par dela, "Hoje", é um `<span>`).
 *
 * Este é o herói MOBILE — renderiza num viewport só, então jsdom basta: não há
 * `hidden md:*` para o layout esconder, e um censo do componente inteiro mede
 * exatamente o que o usuário alcança.
 */

const top: CockpitTopDerived = {
  caixaValor: 500_00,
  caixaReal: true,
  caixaDelta: 0,
  caixaSpark: [],
  resultadoMes: 0,
  resultadoEntrou: 0,
  resultadoGastou: 0,
  resultadoDeltaPct: null,
  entrouMes: 1_000_00,
  saidaJaSaiu: 400_00,
  saidaVaiSair: 100_00,
  saidaTotal: 500_00,
  projecaoMes: 300_00,
  aReceberMes: 0,
  aPagarMes: 200_00,
  mesAtualKey: '2026-08',
  pctMesDecorrido: 0.4,
  projectionSource: 'canonical',
  projectionDegraded: false,
};

describe('MobileMonthHero — nenhum rótulo designa dois controles', () => {
  it('não repete nome acessível entre os controles do herói', () => {
    const { container } = render(<MobileMonthHero top={top} projectId="p1" />);

    const nomes = nameCensus(container);
    expect(duplicates(nomes), `censo: ${JSON.stringify(nomes)}`).toEqual([]);
  });

  it('o rótulo "Rolar até projeção detalhada" designa um controle só', () => {
    const { container } = render(<MobileMonthHero top={top} projectId="p1" />);

    // A frase ("o mês fecha em X") e a linha "Projeção" do trio Entrou/Saiu/
    // Projeção continuam ambas rolando para a mesma âncora, e isso NÃO é
    // duplicata: são affordances distintas, em contextos distintos, com nomes
    // distintos. O defeito era o nome IDÊNTICO em dois controles.
    const nomes = nameCensus(container).filter((n) => n === 'Rolar até projeção detalhada');
    expect(nomes).toHaveLength(1);
  });

  it('a legenda do eixo da barra de progresso não é controle nem de um lado nem do outro', () => {
    const { container, getByText } = render(<MobileMonthHero top={top} projectId="p1" />);

    // "Hoje" e "fim do mês" rotulam as duas pontas da mesma barra. Um `<span>` e
    // um `<button>` para a mesma função é o que fazia o rótulo duplicar.
    expect(getByText('Hoje').tagName).toBe('SPAN');
    expect(getByText('fim do mês').tagName).toBe('SPAN');
    expect(container.querySelector('button[aria-label="Rolar até projeção detalhada"]')).toBeTruthy();
  });
});
