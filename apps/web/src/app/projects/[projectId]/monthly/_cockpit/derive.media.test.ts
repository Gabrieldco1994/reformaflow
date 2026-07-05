import { describe, it, expect } from 'vitest';
import { mediaMensalPorTipo, categoriasDoAno, gastoMedioMensal } from './derive';
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
  it('divide o total pago do tipo por 12 (ano cheio, normalizado)', () => {
    // Moradia paga em jan (300) e fev (500) → 800 / 12 = 67.
    const media = mediaMensalPorTipo(
      [
        entry({ data: '2026-01-10', categoria: 'Moradia', valor: 300 }),
        entry({ data: '2026-02-10', categoria: 'Moradia', valor: 500 }),
      ],
      2026,
    );
    expect(media.get('Moradia')).toBe(67); // 800 / 12
  });

  it('só conta pagas (ignora PLANEJADO)', () => {
    const media = mediaMensalPorTipo(
      [
        entry({ data: '2026-01-10', categoria: 'Lazer', status: 'PAGO', valor: 240 }),
        entry({ data: '2026-02-10', categoria: 'Lazer', status: 'PLANEJADO', valor: 900 }),
      ],
      2026,
    );
    // só a paga conta → 240 / 12 = 20
    expect(media.get('Lazer')).toBe(20);
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
        entry({ data: '2026-01-10', categoria: 'Moradia', valor: 1200 }),
      ],
      2026,
    );
    expect(media.get('Moradia')).toBe(100); // 1200 / 12
    expect(media.has('Pagamento de fatura')).toBe(false);
  });

  it('divide sempre por 12 (não por nº de meses ativos)', () => {
    // jan: Moradia 300 + Lazer 120; fev: Moradia 300 → total Moradia 600, Lazer 120
    const media = mediaMensalPorTipo(
      [
        entry({ data: '2026-01-10', categoria: 'Moradia', valor: 300 }),
        entry({ data: '2026-01-15', categoria: 'Lazer', valor: 120 }),
        entry({ data: '2026-02-10', categoria: 'Moradia', valor: 300 }),
      ],
      2026,
    );
    expect(media.get('Moradia')).toBe(50); // 600 / 12
    expect(media.get('Lazer')).toBe(10); // 120 / 12
  });

  it('categoria nula vira "Outros"', () => {
    const media = mediaMensalPorTipo([entry({ categoria: null, valor: 1200 })], 2026);
    expect(media.get('Outros')).toBe(100); // 1200 / 12
  });
});

describe('categoriasDoAno', () => {
  it('lista COMPLETA por valor desc, incluindo planejado (não trunca)', () => {
    const cats = categoriasDoAno(
      [
        entry({ data: '2026-01-10', categoria: 'Moradia', status: 'PAGO', valor: 1000 }),
        entry({ data: '2026-02-10', categoria: 'Alimentação', status: 'PAGO', valor: 400 }),
        entry({ data: '2026-03-10', categoria: 'Alimentação', status: 'PLANEJADO', valor: 200 }),
        entry({ data: '2026-01-10', categoria: 'Lazer', status: 'PAGO', valor: 300 }),
      ],
      2026,
    );
    // valor inclui planejado (Alimentação 400+200=600); ordenado desc
    expect(cats.map((c) => c.categoria)).toEqual(['Moradia', 'Alimentação', 'Lazer']);
    expect(cats.find((c) => c.categoria === 'Alimentação')!.valor).toBe(600);
  });

  it('media anexada é só das pagas, ÷12 (Alimentação: 400 paga / 12 = 33)', () => {
    const cats = categoriasDoAno(
      [
        entry({ data: '2026-01-10', categoria: 'Moradia', status: 'PAGO', valor: 1000 }),
        entry({ data: '2026-02-10', categoria: 'Alimentação', status: 'PAGO', valor: 400 }),
        entry({ data: '2026-03-10', categoria: 'Alimentação', status: 'PLANEJADO', valor: 200 }),
      ],
      2026,
    );
    // média = só pagas ÷ 12 → Alimentação 400/12 = 33
    expect(cats.find((c) => c.categoria === 'Alimentação')!.media).toBe(33);
  });

  it('exclui espelhos e neutros; ignora outros anos', () => {
    const cats = categoriasDoAno(
      [
        entry({ data: '2026-01-10', categoria: 'Moradia', valor: 500 }),
        entry({ data: '2026-01-10', categoria: 'Moradia', isEspelho: true, valor: 999 }),
        entry({
          data: '2026-01-10',
          categoria: 'Pagamento de fatura',
          isNeutral: true,
          tipoDespesaCodigo: 'PAGAMENTO_FATURA_CARTAO',
          valor: 999,
        }),
        entry({ data: '2025-01-10', categoria: 'Moradia', valor: 999 }),
      ],
      2026,
    );
    expect(cats).toEqual([{ categoria: 'Moradia', valor: 500, media: 42 }]); // 500 / 12
  });
});

describe('gastoMedioMensal', () => {
  it('total realizado ÷ 12 (ano cheio, normalizado)', () => {
    const t = gastoMedioMensal(
      [
        entry({ data: '2026-01-10', valor: 300 }),
        entry({ data: '2026-02-10', valor: 500 }),
        entry({ data: '2026-03-10', valor: 400 }),
      ],
      2026,
    );
    expect(t.meses).toBe(3);
    expect(t.valor).toBe(100); // (300+500+400)=1200 / 12
  });

  it('sempre divide por 12, mesmo com poucos meses ativos', () => {
    const t = gastoMedioMensal(
      [
        entry({ data: '2026-01-10', valor: 600 }),
        entry({ data: '2026-01-20', valor: 600 }),
      ],
      2026,
    );
    expect(t.meses).toBe(1);
    expect(t.valor).toBe(100); // 1200 / 12 (não / 1)
  });

  it('NÃO conta espelho cross-project (dedup): usa só o canônico', () => {
    const t = gastoMedioMensal(
      [
        entry({ data: '2026-01-10', projectId: 'reforma', projectType: 'REFORMA', valor: 1200 }),
        entry({ data: '2026-01-10', projectId: 'pessoal', isEspelho: true, valor: 1200 }),
        entry({ data: '2026-02-10', valor: 1200 }),
      ],
      2026,
    );
    // canônico (1200) + a outra (1200) = 2400 / 12 = 200
    expect(t.valor).toBe(200);
  });

  it('NÃO conta neutros (pagamento de fatura / movimentação interna)', () => {
    const t = gastoMedioMensal(
      [
        entry({ data: '2026-01-10', valor: 1200 }),
        entry({
          data: '2026-01-10',
          isNeutral: true,
          tipoDespesaCodigo: 'PAGAMENTO_FATURA_CARTAO',
          valor: 100000,
        }),
      ],
      2026,
    );
    expect(t.valor).toBe(100); // 1200 / 12; fatura fora
  });

  it('NÃO conta planejado (só realizado) nem recebimento nem outro ano', () => {
    const t = gastoMedioMensal(
      [
        entry({ data: '2026-01-10', status: 'PAGO', valor: 1200 }),
        entry({ data: '2026-06-10', status: 'PLANEJADO', valor: 9000 }),
        entry({ data: '2026-01-10', tipo: 'RECEBIMENTO', status: 'EM_CAIXA', valor: 5000 }),
        entry({ data: '2025-01-10', status: 'PAGO', valor: 9000 }),
      ],
      2026,
    );
    expect(t.valor).toBe(100); // só jan realizado 1200 / 12
  });

  it('sem lançamentos → zero (sem divisão por zero)', () => {
    expect(gastoMedioMensal([], 2026)).toEqual({ valor: 0, meses: 0 });
  });
});
