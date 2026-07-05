import { describe, it, expect } from 'vitest';
import { mediaMensalPorTipo } from './derive';
import type { MonthlyEntry } from '../_types';

function entry(patch: Partial<MonthlyEntry>): MonthlyEntry {
  return {
    id: Math.random().toString(36).slice(2),
    data: '2026-01-10T00:00:00.000Z',
    tipo: 'DESPESA',
    status: 'PAGO',
    valor: 0,
    categoria: 'Moradia',
    categoriaCodigo: 'MORADIA',
    subcategoria: null,
    formaPagamento: 'A_VISTA',
    projectId: 'p1',
    projectName: 'P',
    projectType: 'PESSOAL',
    ...patch,
  };
}

describe('mediaMensalPorTipo', () => {
  it('divide o total pago do tipo pelo nº de meses ativos do ano', () => {
    // Moradia paga em jan (300) e fev (500) → 2 meses ativos → média 400.
    const media = mediaMensalPorTipo(
      [
        entry({ data: '2026-01-10', categoria: 'Moradia', valor: 300 }),
        entry({ data: '2026-02-10', categoria: 'Moradia', valor: 500 }),
      ],
      2026,
    );
    expect(media.get('Moradia')).toBe(400);
  });

  it('só conta pagas (ignora PLANEJADO)', () => {
    const media = mediaMensalPorTipo(
      [
        entry({ data: '2026-01-10', categoria: 'Lazer', status: 'PAGO', valor: 200 }),
        entry({ data: '2026-02-10', categoria: 'Lazer', status: 'PLANEJADO', valor: 900 }),
      ],
      2026,
    );
    // só jan tem gasto pago → 1 mês ativo → média = 200
    expect(media.get('Lazer')).toBe(200);
  });

  it('ignora outros anos, espelhos e neutros', () => {
    const media = mediaMensalPorTipo(
      [
        entry({ data: '2025-01-10', categoria: 'Moradia', valor: 999 }), // outro ano
        entry({ data: '2026-01-10', categoria: 'Moradia', isEspelho: true, valor: 999 }), // espelho
        entry({
          data: '2026-01-10',
          categoria: 'Pagamento de fatura',
          isNeutral: true,
          tipoDespesaCodigo: 'PAGAMENTO_FATURA_CARTAO',
          valor: 999,
        }),
        entry({ data: '2026-01-10', categoria: 'Moradia', valor: 100 }),
      ],
      2026,
    );
    expect(media.get('Moradia')).toBe(100);
    expect(media.has('Pagamento de fatura')).toBe(false);
  });

  it('média por mês ativo agrega tipos distintos com denominador comum', () => {
    // jan: Moradia 300 + Lazer 100; fev: Moradia 300 → meses ativos = 2
    const media = mediaMensalPorTipo(
      [
        entry({ data: '2026-01-10', categoria: 'Moradia', valor: 300 }),
        entry({ data: '2026-01-15', categoria: 'Lazer', valor: 100 }),
        entry({ data: '2026-02-10', categoria: 'Moradia', valor: 300 }),
      ],
      2026,
    );
    expect(media.get('Moradia')).toBe(300); // 600 / 2
    expect(media.get('Lazer')).toBe(50); // 100 / 2
  });

  it('categoria nula vira "Outros"', () => {
    const media = mediaMensalPorTipo([entry({ categoria: null, valor: 80 })], 2026);
    expect(media.get('Outros')).toBe(80);
  });
});
