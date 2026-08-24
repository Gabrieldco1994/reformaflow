import { describe, expect, it } from 'vitest';
import {
  buildPayInvoicePayload,
  buildUndoInvoicePaymentPayload,
  computeMovementTotals,
  groupByMovementDay,
  groupByMovementMonth,
  invoiceActionAllowed,
  invoiceIdentityErrorMessage,
  invoicePayBlockedReason,
  originLast4FromKey,
  sumSaidasSemConta,
} from './_lib';
import type { AccountViewMovimentacao } from './_types';

describe('groupByMovementDay', () => {
  it('keeps the input order and groups movements with the same UTC date', () => {
    const groups = groupByMovementDay([
      { id: 'a', data: '2026-07-17T00:00:00.000Z' },
      { id: 'b', data: '2026-07-17T18:00:00.000Z' },
      { id: 'c', data: '2026-07-16T00:00:00.000Z' },
    ]);

    expect(groups).toEqual([
      expect.objectContaining({ day: '2026-07-17', movements: [{ id: 'a', data: '2026-07-17T00:00:00.000Z' }, { id: 'b', data: '2026-07-17T18:00:00.000Z' }] }),
      expect.objectContaining({ day: '2026-07-16', movements: [{ id: 'c', data: '2026-07-16T00:00:00.000Z' }] }),
    ]);
    expect(groups[0]?.label).toContain('17');
  });
});

describe('groupByMovementMonth', () => {
  it('agrupa por mês UTC preservando a ordem de entrada (visão anual)', () => {
    const groups = groupByMovementMonth([
      { id: 'a', data: '2026-07-17T00:00:00.000Z' },
      { id: 'b', data: '2026-07-02T18:00:00.000Z' },
      { id: 'c', data: '2026-06-30T00:00:00.000Z' },
    ]);

    expect(groups.map((g) => g.day)).toEqual(['2026-07', '2026-06']);
    expect(groups[0]?.movements).toHaveLength(2);
    expect(groups[1]?.movements).toHaveLength(1);
    expect(groups[0]?.label).toContain('julho');
  });

  it('não perde nenhum item: a soma dos grupos é o total de itens', () => {
    const items = Array.from({ length: 24 }, (_, index) => ({
      id: `i-${index}`,
      data: `2026-${String((index % 12) + 1).padStart(2, '0')}-1${index % 9}T00:00:00.000Z`,
    }));
    const groups = groupByMovementMonth(items);
    expect(groups.reduce((sum, g) => sum + g.movements.length, 0)).toBe(items.length);
    expect(new Set(groups.map((g) => g.day)).size).toBe(12);
  });
});

describe('originLast4FromKey', () => {
  it('extrai o last4 da chave de origem do gráfico anual (card:/conta:)', () => {
    expect(originLast4FromKey('card:1234')).toBe('1234');
    expect(originLast4FromKey('conta:5678')).toBe('5678');
  });

  it('devolve null para chave ausente ou fora do formato', () => {
    expect(originLast4FromKey(null)).toBeNull();
    expect(originLast4FromKey('')).toBeNull();
    expect(originLast4FromKey('carteira')).toBeNull();
  });
});

function saida(overrides: Partial<AccountViewMovimentacao> = {}): AccountViewMovimentacao {
  return {
    kind: 'saida',
    id: 'exp-1',
    descricao: 'Mercado',
    data: '2026-03-10T00:00:00.000Z',
    forma: 'pix',
    valor: 10_000,
    realizado: true,
    status: 'PAGO',
    cardLast4: null,
    bankLast4: '1234',
    tipoDespesa: 'MERCADO',
    isInvoice: false,
    editavel: true,
    dueMonth: null,
    projetoOrigem: null,
    ...overrides,
  } as AccountViewMovimentacao;
}

function entrada(overrides: Partial<AccountViewMovimentacao> = {}): AccountViewMovimentacao {
  return {
    kind: 'entrada',
    id: 'rec-1',
    descricao: 'Salário',
    data: '2026-03-05T00:00:00.000Z',
    tipo: 'salario',
    valor: 500_000,
    bankLast4: '1234',
    status: 'EM_CAIXA',
    ...overrides,
  } as AccountViewMovimentacao;
}

describe('computeMovementTotals', () => {
  it('soma saídas, entradas em caixa e previstas — aporte fica fora do total de saídas', () => {
    const totals = computeMovementTotals([
      saida(),
      saida({ id: 'exp-2', valor: 7_000, tipoDespesa: 'INVESTIMENTOS' }),
      entrada(),
      entrada({ id: 'rec-2', valor: 30_000, status: 'PREVISTO' }),
    ]);

    expect(totals).toEqual({
      totalSaidas: 10_000,
      totalEntradasRecebido: 500_000,
      totalEntradasPrevisto: 30_000,
    });

    describe('sumSaidasSemConta', () => {
      it('soma o mesmo card base pago + planejado e segue excluindo invoice/cartão/conta', () => {
        expect(
          sumSaidasSemConta([
            { isInvoice: false, cardLast4: null, bankLast4: null, valor: 5_000 },
            { isInvoice: false, cardLast4: null, bankLast4: null, valor: 7_000 },
            { isInvoice: false, cardLast4: '4242', bankLast4: null, valor: 11_000 },
            { isInvoice: false, cardLast4: null, bankLast4: '0001', valor: 13_000 },
            { isInvoice: true, cardLast4: null, bankLast4: null, valor: 17_000 },
          ]),
        ).toBe(12_000);
      });
    });
  });

  it('INVARIANTE ano == soma dos 12 meses: totais do ano = soma dos totais mensais', () => {
    const meses = Array.from({ length: 12 }, (_, index) => {
      const mes = String(index + 1).padStart(2, '0');
      return [
        saida({ id: `exp-${mes}`, data: `2026-${mes}-10T00:00:00.000Z`, valor: 10_000 + index }),
        // Carteira (sem cartão/conta): regra de ouro 14 — conta no total igual.
        saida({
          id: `carteira-${mes}`,
          data: `2026-${mes}-11T00:00:00.000Z`,
          valor: 5_000,
          bankLast4: null,
        }),
        entrada({ id: `rec-${mes}`, data: `2026-${mes}-05T00:00:00.000Z`, valor: 500_000 }),
        entrada({
          id: `rec-prev-${mes}`,
          data: `2026-${mes}-25T00:00:00.000Z`,
          valor: 20_000,
          status: 'PREVISTO',
        }),
      ];
    });

    const somaDosMeses = meses
      .map((items) => computeMovementTotals(items))
      .reduce(
        (acc, totals) => ({
          totalSaidas: acc.totalSaidas + totals.totalSaidas,
          totalEntradasRecebido: acc.totalEntradasRecebido + totals.totalEntradasRecebido,
          totalEntradasPrevisto: acc.totalEntradasPrevisto + totals.totalEntradasPrevisto,
        }),
        { totalSaidas: 0, totalEntradasRecebido: 0, totalEntradasPrevisto: 0 },
      );

    expect(computeMovementTotals(meses.flat())).toEqual(somaDosMeses);
  });
});

describe('groupByMovementDay — o mês não regride', () => {
  it('continua agrupando por dia depois da extração do agrupamento mensal', () => {
    const groups = groupByMovementDay([
      { id: 'a', data: '2026-07-17T00:00:00.000Z' },
      { id: 'b', data: '2026-07-16T00:00:00.000Z' },
    ]);
    expect(groups.map((g) => g.day)).toEqual(['2026-07-17', '2026-07-16']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// W1 (#448): identidades explícitas de fatura no payload das mutações de
// dinheiro (`pay-invoice` / `undo-invoice-payment`).
//
// Contrato mixed-version (os dois deploys NÃO são atômicos):
//  - API nova: `cardId`/`accountId` têm precedência sobre o último4; mismatch
//    com o último4 (ou id cross-tenant) é 400 ANTES da ACL.
//  - API antiga: o `@Body()` daquelas rotas é um objeto inline (metatype
//    `Object`), então o `ValidationPipe` global NÃO valida e as chaves
//    desconhecidas são ignoradas — o último4 legado ainda resolve.
// Logo o payload manda SEMPRE o último4 legado E o id quando existir; nunca
// só o id (a API antiga responderia "Cartão obrigatório") e nunca `null`/`''`
// (a API nova trataria como chave de busca).
// ─────────────────────────────────────────────────────────────────────────────

describe('buildPayInvoicePayload — identidade explícita quando disponível', () => {
  const account = { accountId: 'acc-1', last4: '9876' };
  const card = { cardId: 'card-1', last4: '1234', dueMonth: '2026-07' };

  it('envia cardId e accountId JUNTO do último4 legado quando a API os forneceu', () => {
    expect(
      buildPayInvoicePayload({ card, account, amountCents: 12_345, paymentDate: '2026-07-10' }),
    ).toEqual({
      cardId: 'card-1',
      cardLast4: '1234',
      month: '2026-07',
      amountCents: 12_345,
      accountId: 'acc-1',
      bankLast4: '9876',
      paymentDate: '2026-07-10',
    });
  });

  it('OMITE as chaves de id (não manda null/vazio) quando a API antiga não as forneceu', () => {
    const payload = buildPayInvoicePayload({
      card: { last4: '1234', dueMonth: '2026-07' },
      account: { last4: '9876' },
      amountCents: 12_345,
      paymentDate: '2026-07-10',
    });

    expect(Object.keys(payload).sort()).toEqual(
      ['amountCents', 'bankLast4', 'cardLast4', 'month', 'paymentDate'].sort(),
    );
    expect('cardId' in payload).toBe(false);
    expect('accountId' in payload).toBe(false);
  });

  it('degrada byte-a-byte para o payload legado quando não há id nenhum', () => {
    const payload = buildPayInvoicePayload({
      card: { cardId: null, last4: '1234', dueMonth: '2026-07' },
      account: { accountId: '   ', last4: '9876' },
      amountCents: 12_345,
      paymentDate: '2026-07-10',
    });

    // Exatamente o corpo que o bundle antigo mandava — nenhuma chave a mais.
    expect(JSON.parse(JSON.stringify(payload))).toEqual({
      cardLast4: '1234',
      month: '2026-07',
      amountCents: 12_345,
      bankLast4: '9876',
      paymentDate: '2026-07-10',
    });
  });

  it('manda o id de UM lado só quando só um lado tem identidade', () => {
    const payload = buildPayInvoicePayload({
      card,
      account: { last4: '9876' },
      amountCents: 100,
      paymentDate: '2026-07-10',
    });
    expect(payload.cardId).toBe('card-1');
    expect('accountId' in payload).toBe(false);
    expect(payload.bankLast4).toBe('9876');
  });

  it('nunca deixa o último4 legado de fora, mesmo com os dois ids presentes', () => {
    const payload = buildPayInvoicePayload({
      card,
      account,
      amountCents: 100,
      paymentDate: '2026-07-10',
    });
    expect(payload.cardLast4).toBe('1234');
    expect(payload.bankLast4).toBe('9876');
  });

  it('trima o id e usa o mês explícito quando informado', () => {
    const payload = buildPayInvoicePayload({
      card: { cardId: ' card-1 ', last4: '1234', dueMonth: '2026-07' },
      account,
      amountCents: 100,
      paymentDate: '2026-07-10',
      month: '2026-08',
    });
    expect(payload.cardId).toBe('card-1');
    expect(payload.month).toBe('2026-08');
  });
});

describe('buildUndoInvoicePaymentPayload — identidade explícita quando disponível', () => {
  it('envia cardId junto do último4 legado', () => {
    expect(
      buildUndoInvoicePaymentPayload({ cardId: 'card-1', last4: '1234', dueMonth: '2026-07' }),
    ).toEqual({ cardId: 'card-1', cardLast4: '1234', dueMonth: '2026-07' });
  });

  it('degrada para o payload legado quando a API antiga não mandou cardId', () => {
    const payload = buildUndoInvoicePaymentPayload({ last4: '1234', dueMonth: '2026-07' });
    expect(JSON.parse(JSON.stringify(payload))).toEqual({
      cardLast4: '1234',
      dueMonth: '2026-07',
    });
    expect('cardId' in payload).toBe(false);
  });
});

describe('invoiceIdentityErrorMessage — erro honesto, nunca downgrade silencioso', () => {
  it('traduz o 400 de mismatch id×último4 em "os dados mudaram, atualize"', () => {
    const message = invoiceIdentityErrorMessage({
      status: 400,
      message: 'cardId e cardLast4 não correspondem ao mesmo cartão.',
    });
    expect(message).toMatch(/atualize/i);
    expect(message).not.toMatch(/cardId/);
  });

  it('traduz o mismatch de conta também', () => {
    expect(
      invoiceIdentityErrorMessage({
        status: 400,
        message: 'accountId e bankLast4 não correspondem à mesma conta.',
      }),
    ).toMatch(/atualize/i);
  });

  it('traduz a recusa de propriedade desconhecida (API que não conhece os ids)', () => {
    const message = invoiceIdentityErrorMessage({
      status: 400,
      message: 'property cardId should not exist',
    });
    expect(message).toMatch(/servidor/i);
    expect(message).toMatch(/atualize/i);
  });

  it('devolve null para erro que não é de identidade — a mensagem do servidor prevalece', () => {
    expect(invoiceIdentityErrorMessage({ status: 400, message: 'Valor da fatura inválido.' })).toBeNull();
    expect(invoiceIdentityErrorMessage({ status: 404, message: 'Cartão não encontrado.' })).toBeNull();
    expect(invoiceIdentityErrorMessage({ status: 500, message: 'boom' })).toBeNull();
    expect(invoiceIdentityErrorMessage(new Error('offline'))).toBeNull();
    expect(invoiceIdentityErrorMessage(null)).toBeNull();
  });
});

describe('invoiceIdentityErrorMessage — 409 de final ambíguo (B1b #448)', () => {
  it('traduz "Cartão ambíguo" em erro acionável, sem inventar contagem de duplicatas', () => {
    const message = invoiceIdentityErrorMessage({ status: 409, message: 'Cartão ambíguo' });
    expect(message).toMatch(/cart[ãa]o/i);
    expect(message).toMatch(/cadastro|duplicid/i);
    // A mensagem do servidor é deliberadamente terse: não revela QUANTAS
    // duplicatas existem nem quais. A do web não pode ser mais indiscreta.
    expect(message).not.toMatch(/\b\d+\b/);
  });

  it('traduz "Conta ambígua" com o mesmo vocabulário', () => {
    const message = invoiceIdentityErrorMessage({ status: 409, message: 'Conta ambígua' });
    expect(message).toMatch(/conta/i);
    expect(message).toMatch(/cadastro|duplicid/i);
  });

  it('devolve null para 409 que não é de ambiguidade — mensagem do servidor prevalece', () => {
    expect(invoiceIdentityErrorMessage({ status: 409, message: 'Fatura já paga.' })).toBeNull();
  });
});

describe('invoiceActionAllowed — capabilities do servidor VETAM, nunca concedem', () => {
  it('API antiga (sem `actions`) preserva a derivação local, byte-a-byte', () => {
    expect(invoiceActionAllowed({}, 'pay', true)).toBe(true);
    expect(invoiceActionAllowed({}, 'pay', false)).toBe(false);
    expect(invoiceActionAllowed({ actions: undefined }, 'undo', true)).toBe(true);
    expect(invoiceActionAllowed({ actions: null }, 'undo', true)).toBe(true);
    expect(invoiceActionAllowed(undefined, 'undo', true)).toBe(true);
  });

  it('veta a CTA quando o servidor manda `actions` sem o verbo', () => {
    // Final ambíguo (B1b): a fatura não oferece verbo NENHUM porque
    // `payInvoice`/`undoInvoicePayment` responderiam 409 por último4.
    expect(invoiceActionAllowed({ actions: [] }, 'pay', true)).toBe(false);
    expect(invoiceActionAllowed({ actions: [] }, 'undo', true)).toBe(false);
    expect(invoiceActionAllowed({ actions: ['pay'] }, 'undo', true)).toBe(false);
  });

  it('mantém a CTA quando servidor e regra local concordam', () => {
    expect(invoiceActionAllowed({ actions: ['pay'] }, 'pay', true)).toBe(true);
    expect(invoiceActionAllowed({ actions: ['pay', 'undo'] }, 'undo', true)).toBe(true);
  });

  it('NUNCA concede: `actions` do servidor não ressuscita CTA que a regra local nega', () => {
    expect(invoiceActionAllowed({ actions: ['pay', 'undo'] }, 'pay', false)).toBe(false);
    expect(invoiceActionAllowed({ actions: ['undo'] }, 'undo', false)).toBe(false);
  });

  it('ignora verbo desconhecido de uma API mais nova sem quebrar', () => {
    expect(invoiceActionAllowed({ actions: ['settle' as 'pay'] }, 'pay', true)).toBe(false);
    expect(invoiceActionAllowed({ actions: ['settle' as 'pay', 'pay'] }, 'pay', true)).toBe(true);
  });
});

describe('invoicePayBlockedReason — o veto precisa dizer a verdade sobre o motivo', () => {
  it('não inventa motivo contra API antiga nem quando pagar está autorizado', () => {
    expect(invoicePayBlockedReason({ faturaPendente: 100 })).toBeNull();
    expect(invoicePayBlockedReason({ actions: null, faturaPendente: 100 })).toBeNull();
    expect(invoicePayBlockedReason({ actions: ['pay'], faturaPendente: 100 })).toBeNull();
    expect(invoicePayBlockedReason(null)).toBeNull();
  });

  it('com pendente > 0 e sem `pay`, o único motivo restante do servidor é o final ambíguo', () => {
    expect(invoicePayBlockedReason({ actions: [], faturaPendente: 45_000 })).toMatch(
      /mais de um cartão com esse final/i,
    );
  });

  it('sem pendente NÃO acusa duplicidade — o servidor omite `pay` por não haver o que pagar', () => {
    const semPendente = invoicePayBlockedReason({ actions: [], faturaPendente: 0 });
    expect(semPendente).toMatch(/já consta paga/i);
    expect(semPendente).not.toMatch(/mais de um/i);
  });

  it('não publica CONTAGEM de duplicatas (metadata que o servidor decidiu não expor)', () => {
    expect(invoicePayBlockedReason({ actions: [], faturaPendente: 1 })).not.toMatch(/\d/);
  });
});
