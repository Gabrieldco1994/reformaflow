import { describe, it, expect } from 'vitest';
import { mediaMensalPorTipo, categoriasDoAno, ticketMedioGeral } from './derive';
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

  it('media anexada é só das pagas (Alimentação: 400 paga em 2 meses ativos = 200)', () => {
    const cats = categoriasDoAno(
      [
        entry({ data: '2026-01-10', categoria: 'Moradia', status: 'PAGO', valor: 1000 }),
        entry({ data: '2026-02-10', categoria: 'Alimentação', status: 'PAGO', valor: 400 }),
        entry({ data: '2026-03-10', categoria: 'Alimentação', status: 'PLANEJADO', valor: 200 }),
      ],
      2026,
    );
    // meses ativos (com gasto pago) = jan, fev = 2 → média Alimentação = 400/2 = 200
    expect(cats.find((c) => c.categoria === 'Alimentação')!.media).toBe(200);
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
    expect(cats).toEqual([{ categoria: 'Moradia', valor: 500, media: 500 }]);
  });
});

describe('ticketMedioGeral', () => {
  it('média por lançamento de despesa realizada', () => {
    const t = ticketMedioGeral(
      [
        entry({ data: '2026-01-10', valor: 300 }),
        entry({ data: '2026-02-10', valor: 500 }),
        entry({ data: '2026-03-10', valor: 100 }),
      ],
      2026,
    );
    expect(t.count).toBe(3);
    expect(t.valor).toBe(300); // (300+500+100)/3
  });

  it('NÃO conta espelho cross-project (dedup): usa só o canônico', () => {
    const t = ticketMedioGeral(
      [
        // canônico da compra no projeto de origem
        entry({ data: '2026-01-10', projectId: 'reforma', projectType: 'REFORMA', valor: 800 }),
        // espelho PESSOAL da MESMA compra (quitação) → não conta
        entry({ data: '2026-01-10', projectId: 'pessoal', isEspelho: true, valor: 800 }),
        entry({ data: '2026-02-10', valor: 200 }),
      ],
      2026,
    );
    // só canônico (800) + a outra (200) = 1000 / 2 = 500
    expect(t.count).toBe(2);
    expect(t.valor).toBe(500);
  });

  it('NÃO conta neutros (pagamento de fatura / movimentação interna)', () => {
    const t = ticketMedioGeral(
      [
        entry({ data: '2026-01-10', valor: 400 }),
        entry({
          data: '2026-01-10',
          isNeutral: true,
          tipoDespesaCodigo: 'PAGAMENTO_FATURA_CARTAO',
          valor: 100000,
        }),
      ],
      2026,
    );
    // fatura gigante (100000) fora → não infla
    expect(t.count).toBe(1);
    expect(t.valor).toBe(400);
  });

  it('NÃO conta planejado (só realizado) nem recebimento nem outro ano', () => {
    const t = ticketMedioGeral(
      [
        entry({ data: '2026-01-10', status: 'PAGO', valor: 300 }),
        entry({ data: '2026-06-10', status: 'PLANEJADO', valor: 9000 }),
        entry({ data: '2026-01-10', tipo: 'RECEBIMENTO', status: 'EM_CAIXA', valor: 5000 }),
        entry({ data: '2025-01-10', status: 'PAGO', valor: 9000 }),
      ],
      2026,
    );
    expect(t.count).toBe(1);
    expect(t.valor).toBe(300);
  });

  it('sem lançamentos → zero (sem divisão por zero)', () => {
    expect(ticketMedioGeral([], 2026)).toEqual({ valor: 0, count: 0 });
  });
});
