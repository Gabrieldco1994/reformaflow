import { describe, expect, it } from 'vitest';
import { deriveRunwayNarrative, monthLabelLongFromKey } from './runway-summary';

describe('runway-summary', () => {
  it('retorna narrativa negativa quando há crossover abaixo de zero', () => {
    const narrative = deriveRunwayNarrative(
      [
        { mes: '2026-07', saldoProjetado: 100_000 },
        { mes: '2026-08', saldoProjetado: -5_000 },
        { mes: '2026-09', saldoProjetado: -12_000 },
      ] as any,
      '2026-07',
    );
    expect(narrative?.tone).toBe('negative');
    expect(narrative?.headline).toContain('fica negativo em');
    expect(narrative?.detail).toContain('Pior ponto:');
  });

  it('retorna narrativa positiva quando toda série é >= 0', () => {
    const narrative = deriveRunwayNarrative(
      [
        { mes: '2026-07', saldoProjetado: 40_000 },
        { mes: '2026-08', saldoProjetado: 30_000 },
        { mes: '2026-09', saldoProjetado: 20_000 },
      ] as any,
      '2026-07',
    );
    expect(narrative?.tone).toBe('positive');
    expect(narrative?.headline).toContain('se mantém positivo até');
    expect(narrative?.detail).toContain('Menor ponto:');
  });

  it('retorna null quando não há horizonte suficiente', () => {
    const narrative = deriveRunwayNarrative(
      [{ mes: '2026-07', saldoProjetado: 40_000 }] as any,
      '2026-07',
    );
    expect(narrative).toBeNull();
  });

  it('formata mês por chave yyyy-mm em pt-BR', () => {
    expect(monthLabelLongFromKey('2026-09')).toMatch(/2026/);
  });
});
