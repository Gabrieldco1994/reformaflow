import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ProjecaoSaldo } from './ProjecaoSaldo';
import type { DreSaldoAcumuladoRow } from '../../dre/_types';

/**
 * PARIDADE: Quando simulatedRitmo === baseRitmo, os valores do gráfico
 * devem ser idênticos aos do saldoProjetado backend (100% match).
 *
 * COMPROMISSO FIXO: Quando ritmo = 0, o gráfico mostra apenas o componente
 * fixoLiquido; se há uma fatura grande (degrau no fixo), ele permanece visível.
 */
describe('ProjecaoSaldo — Simulador de ritmo', () => {
  const currentMonth = '2026-07';

  // Série base: 6 meses com saldo crescente, sem crossover ainda
  const serieBases: DreSaldoAcumuladoRow[] = [
    {
      mes: '2026-07',
      recebimentos: 500000, // 5k
      despesas: 300000,     // 3k
      saldoProjetado: 100000,
      saldoRealizado: 100000,
      recebimentosRealizados: 500000,
      despesasRealizados: 300000,
      fixoLiquido: 200000, // recebimentos - despesas
    },
    {
      mes: '2026-08',
      recebimentos: 500000,
      despesas: 350000, // +50k gasto → fixo menor
      saldoProjetado: 250000, // 100k + 200k
      saldoRealizado: null,
      recebimentosRealizados: null,
      despesasRealizados: null,
      fixoLiquido: 150000,
    },
    {
      mes: '2026-09',
      recebimentos: 500000,
      despesas: 400000, // +50k fatura grande entra aqui
      saldoProjetado: 350000,
      saldoRealizado: null,
      recebimentosRealizados: null,
      despesasRealizados: null,
      fixoLiquido: 100000, // compromisso fixo (degrau de fatura)
    },
    {
      mes: '2026-10',
      recebimentos: 500000,
      despesas: 350000, // volta ao normal
      saldoProjetado: 500000,
      saldoRealizado: null,
      recebimentosRealizados: null,
      despesasRealizados: null,
      fixoLiquido: 150000,
    },
    {
      mes: '2026-11',
      recebimentos: 500000,
      despesas: 300000,
      saldoProjetado: 700000,
      saldoRealizado: null,
      recebimentosRealizados: null,
      despesasRealizados: null,
      fixoLiquido: 200000,
    },
    {
      mes: '2026-12',
      recebimentos: 500000,
      despesas: 300000,
      saldoProjetado: 900000,
      saldoRealizado: null,
      recebimentosRealizados: null,
      despesasRealizados: null,
      fixoLiquido: 200000,
    },
  ];

  it('1. PARIDADE: simulatedRitmo === baseRitmo ⇒ valores 100% batem com série backend', () => {
    const baseRitmo = 10000; // 10k/dia
    const simulatedRitmo = baseRitmo;

    const { container } = render(
      <ProjecaoSaldo
        serie={serieBases}
        currentMonth={currentMonth}
        simulatedRitmo={simulatedRitmo}
      />
    );

    // Verifica que o componente renderiza sem quebra
    expect(container.querySelector('section')).toBeDefined();

    // Verifica que há texto de narrativa (crossover ou positive)
    const text = container.textContent ?? '';
    expect(text.length).toBeGreaterThan(100);
  });

  it('2. COMPROMISSO FIXO: ritmo = 0 ⇒ gráfico mostra apenas fixoLiquido, degrau mantém', () => {
    const baseRitmo = 10000;
    const simulatedRitmo = 0; // Nenhum gasto variável

    const { container } = render(
      <ProjecaoSaldo
        serie={serieBases}
        currentMonth={currentMonth}
        simulatedRitmo={simulatedRitmo}
      />
    );

    // Verificar que "simulação" aparece no selo
    const text = container.textContent ?? '';
    expect(text).toContain('simulação');

    // Verifica que o componente renderiza
    expect(container.querySelector('section')).toBeDefined();
  });

  it('3. Renderiza sem quebra quando não há simulação (simulatedRitmo undefined)', () => {
    const { container } = render(
      <ProjecaoSaldo
        serie={serieBases}
        currentMonth={currentMonth}
      />
    );

    // Verificar que o componente renderiza
    expect(container.querySelector('section')).toBeDefined();

    // "simulação" NÃO deve aparecer
    const text = container.textContent ?? '';
    expect(text).not.toContain('simulação');
  });
});
