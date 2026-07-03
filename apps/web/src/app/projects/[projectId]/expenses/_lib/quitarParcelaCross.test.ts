import { describe, it, expect } from 'vitest';
import type { AccountViewSaida } from '../../conta/_types';
import {
  parseForeignParcelaId,
  expandPendingForeignParcelas,
  buildEspelhoQuitacaoPayload,
  parsePaidParcelaSet,
  suggestParcelaQuitacao,
  suggestParcelaQuitacaoAt,
} from './quitarParcelaCross';

/** Factory de uma saída da Visão Conta com defaults sensatos. */
function saida(partial: Partial<AccountViewSaida>): AccountViewSaida {
  return {
    id: null,
    kind: 'saida',
    descricao: 'Despesa',
    data: '2026-07-03',
    forma: 'pix',
    valor: 10000,
    realizado: false,
    status: 'PLANEJADO',
    cardLast4: null,
    bankLast4: null,
    tipoDespesa: 'MATERIAL',
    isInvoice: false,
    editavel: false,
    dueMonth: null,
    projetoOrigem: null,
    parcelaIndex: null,
    foreignExpenseId: null,
    ...partial,
  };
}

describe('parseForeignParcelaId', () => {
  it('parseia id sintético válido', () => {
    expect(parseForeignParcelaId('cmow625abc#3')).toEqual({
      foreignExpenseId: 'cmow625abc',
      parcelaIndex: 3,
    });
  });

  it('aceita índice 0', () => {
    expect(parseForeignParcelaId('abc#0')).toEqual({
      foreignExpenseId: 'abc',
      parcelaIndex: 0,
    });
  });

  it('id sem "#" → null', () => {
    expect(parseForeignParcelaId('cmow625abc')).toBeNull();
  });

  it('índice ausente após "#" → null', () => {
    expect(parseForeignParcelaId('abc#')).toBeNull();
  });

  it('índice não numérico → null', () => {
    expect(parseForeignParcelaId('abc#x')).toBeNull();
  });

  it('índice negativo/decimal → null', () => {
    expect(parseForeignParcelaId('abc#-1')).toBeNull();
    expect(parseForeignParcelaId('abc#1.5')).toBeNull();
  });

  it('"#" no início (sem foreignExpenseId) → null', () => {
    expect(parseForeignParcelaId('#3')).toBeNull();
  });

  it('string vazia → null', () => {
    expect(parseForeignParcelaId('')).toBeNull();
  });
});

describe('expandPendingForeignParcelas', () => {
  it('mantém apenas parcelas cross-project pendentes', () => {
    const saidas: AccountViewSaida[] = [
      // normal (sem foreignExpenseId) → ignora
      saida({ id: 'a1', descricao: 'Conta luz' }),
      // parcela cross pendente → mantém
      saida({
        id: 'fx#2',
        descricao: 'IPTU Casa',
        foreignExpenseId: 'fx',
        parcelaIndex: 2,
        valor: 25000,
        data: '2026-07-10',
        projetoOrigem: { id: 'p2', name: 'Casa', type: 'CASA' },
      }),
      // parcela cross já realizada → ignora
      saida({
        id: 'fy#1',
        foreignExpenseId: 'fy',
        parcelaIndex: 1,
        realizado: true,
      }),
      // foreignExpenseId mas parcelaIndex null → ignora
      saida({ id: 'fz', foreignExpenseId: 'fz', parcelaIndex: null }),
    ];

    const result = expandPendingForeignParcelas(saidas);
    expect(result).toEqual([
      {
        foreignExpenseId: 'fx',
        parcelaIndex: 2,
        valor: 25000,
        descricao: 'IPTU Casa',
        data: '2026-07-10',
        projetoOrigem: { id: 'p2', name: 'Casa', type: 'CASA' },
      },
    ]);
  });

  it('lista vazia → []', () => {
    expect(expandPendingForeignParcelas([])).toEqual([]);
  });
});

describe('buildEspelhoQuitacaoPayload', () => {
  it('meio bank → bankAccountId + A_VISTA, valor em reais, status PAGO', () => {
    const payload = buildEspelhoQuitacaoPayload({
      descricao: 'IPTU Casa 3/12',
      valorCentavos: 25000,
      dataPagamento: '2026-07-03',
      tipoDespesa: 'MATERIAL',
      meio: { kind: 'bank', bankAccountId: 'bank1' },
    });
    expect(payload.status).toBe('PAGO');
    expect(payload.valor).toBe(250);
    expect(payload.quantidade).toBe(1);
    expect(payload.formaPagamento).toBe('A_VISTA');
    expect(payload.bankAccountId).toBe('bank1');
    expect(payload.creditCardId).toBeNull();
    expect(payload.titulo).toBe('IPTU Casa 3/12');
    expect(payload.dataPagamento).toBe('2026-07-03');
    expect(payload.quantidadeParcela).toBeNull();
  });

  it('meio bank com forma PIX', () => {
    const payload = buildEspelhoQuitacaoPayload({
      descricao: 'x',
      valorCentavos: 10000,
      dataPagamento: '2026-07-03',
      tipoDespesa: 'MATERIAL',
      meio: { kind: 'bank', bankAccountId: 'bank1', forma: 'PIX' },
    });
    expect(payload.formaPagamento).toBe('PIX');
  });

  it('meio card → creditCardId, sem bankAccountId', () => {
    const payload = buildEspelhoQuitacaoPayload({
      descricao: 'Reforma parcela',
      valorCentavos: 50000,
      dataPagamento: '2026-07-03',
      tipoDespesa: 'MAO_DE_OBRA',
      meio: { kind: 'card', cardId: 'card9' },
    });
    expect(payload.creditCardId).toBe('card9');
    expect(payload.bankAccountId).toBeNull();
    expect(payload.valor).toBe(500);
    expect(payload.formaPagamento).toBe('A_VISTA');
  });
});

describe('parsePaidParcelaSet', () => {
  it('JSON string → Set de índices', () => {
    expect([...parsePaidParcelaSet('[0,1,2]')]).toEqual([0, 1, 2]);
  });
  it('array direto → Set', () => {
    expect([...parsePaidParcelaSet([3, 4])]).toEqual([3, 4]);
  });
  it('null/vazio/JSON inválido → Set vazio', () => {
    expect(parsePaidParcelaSet(null).size).toBe(0);
    expect(parsePaidParcelaSet('').size).toBe(0);
    expect(parsePaidParcelaSet('nope').size).toBe(0);
  });
  it('descarta valores negativos/não-inteiros', () => {
    expect([...parsePaidParcelaSet('[0,-1,2.5,3]')]).toEqual([0, 3]);
  });
});

describe('suggestParcelaQuitacao', () => {
  const today = new Date('2026-07-03T12:00:00.000Z');

  it('pagamento único → índice 0, valor total, data do pagamento', () => {
    const s = suggestParcelaQuitacao(
      {
        id: 'x',
        tipoDespesa: 'MATERIAL',
        valorTotal: 500000,
        formaPagamento: 'A_VISTA',
        dataPagamento: '2026-07-10',
      },
      today,
    );
    expect(s.parcelaIndex).toBe(0);
    expect(s.valorSugerido).toBe(500000);
    expect(s.dataSugerida).toBe('2026-07-10');
  });

  it('quinzenal com paid=[0,1,2] → sugere parcela 3 (1ª não paga), valor da PARCELA (não o total)', () => {
    // Infra real: 80.000 em 10 quinzenais a partir de 2026-06-08 → 8.000/parcela.
    const s = suggestParcelaQuitacao(
      {
        id: 'infra',
        tipoDespesa: 'MAO_DE_OBRA',
        valorTotal: 8000000,
        formaPagamento: 'QUINZENAL',
        quantidadeParcela: 10,
        dataInicioParcela: '2026-06-08',
        paidParcelas: '[0,1,2]',
      },
      today,
    );
    expect(s.parcelaIndex).toBe(3);
    expect(s.valorSugerido).toBe(800000); // 8.000, NÃO 80.000
    // idx3 = 08/06 + 3*15 dias = 23/07.
    expect(s.dataSugerida).toBe('2026-07-23');
  });

  it('quinzenal sem parcelas pagas → índice 0', () => {
    const s = suggestParcelaQuitacao(
      {
        id: 'y',
        tipoDespesa: 'MATERIAL',
        valorTotal: 1000000,
        formaPagamento: 'QUINZENAL',
        quantidadeParcela: 10,
        dataInicioParcela: '2026-06-08',
        paidParcelas: null,
      },
      today,
    );
    expect(s.parcelaIndex).toBe(0);
    expect(s.valorSugerido).toBe(100000);
  });

  it('todas as parcelas pagas → cai na última (idempotência do backend cobre)', () => {
    const s = suggestParcelaQuitacao(
      {
        id: 'z',
        tipoDespesa: 'MATERIAL',
        valorTotal: 300000,
        formaPagamento: 'PARCELADO',
        quantidadeParcela: 3,
        dataInicioParcela: '2026-06-08',
        paidParcelas: '[0,1,2]',
      },
      today,
    );
    expect(s.parcelaIndex).toBe(2);
  });
});

describe('suggestParcelaQuitacaoAt', () => {
  const today = new Date('2026-07-03T12:00:00.000Z');

  it('parcela explícita → usa o índice pedido, valor/data da própria parcela', () => {
    // Infra real: 80.000 em 10 quinzenais a partir de 2026-06-08 → 8.000/parcela.
    const s = suggestParcelaQuitacaoAt(
      {
        id: 'infra',
        tipoDespesa: 'MAO_DE_OBRA',
        valorTotal: 8000000,
        formaPagamento: 'QUINZENAL',
        quantidadeParcela: 10,
        dataInicioParcela: '2026-06-08',
        paidParcelas: '[0,1,2]',
      },
      5,
    );
    expect(s.parcelaIndex).toBe(5);
    expect(s.valorSugerido).toBe(800000); // 8.000, NÃO 80.000
    // idx5 = 08/06 + 5*15 dias = 22/08.
    expect(s.dataSugerida).toBe('2026-08-22');
  });

  it('índice acima do range → clamp na última parcela', () => {
    const s = suggestParcelaQuitacaoAt(
      {
        id: 'z',
        tipoDespesa: 'MATERIAL',
        valorTotal: 300000,
        formaPagamento: 'PARCELADO',
        quantidadeParcela: 3,
        dataInicioParcela: '2026-06-08',
      },
      99,
    );
    expect(s.parcelaIndex).toBe(2);
    expect(s.valorSugerido).toBe(100000);
  });

  it('pagamento único → sempre índice 0 e valor total', () => {
    const s = suggestParcelaQuitacaoAt(
      {
        id: 'x',
        tipoDespesa: 'MATERIAL',
        valorTotal: 500000,
        formaPagamento: 'A_VISTA',
        dataPagamento: '2026-07-10',
      },
      4,
      today,
    );
    expect(s.parcelaIndex).toBe(0);
    expect(s.valorSugerido).toBe(500000);
    expect(s.dataSugerida).toBe('2026-07-10');
  });
});
