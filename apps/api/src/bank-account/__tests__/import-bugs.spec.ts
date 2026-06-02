/* eslint-disable @typescript-eslint/no-explicit-any */
import { isNeutralExpenseType } from '@reformaflow/domain';
import {
  fastClassify,
  detectCardPayment,
  looksLikeOutboundTransfer,
} from '../bank-account.service';
import {
  assignOrdinals,
  makeExternalId,
} from '../../credit-card/parsers/types';

describe('fastClassify — MOVIMENTACAO_INTERNA guards', () => {
  // POSITIVOS: devem virar MOVIMENTACAO_INTERNA
  it.each([
    'APLICACAO COFRINHOS',
    'APLICACAO AUT MAIS',
    'AG.EST RESG PERSONDIF',
    'AG.RESGATE PERSONDIF',
    'INT RESGATE PERSONDIF',
    'INT RESGATE ACTIONDEBE',
    'RESGATE CDB DI',
    'RESGATE CDB Cofrinhos',
    'COFRINHO Casa',
    'PERSONDIF',
  ])('classifica "%s" como MOVIMENTACAO_INTERNA', (s) => {
    expect(fastClassify(s)).toBe('MOVIMENTACAO_INTERNA');
  });

  // NEGATIVOS CRÍTICOS: NÃO devem ser MOVIMENTACAO_INTERNA
  it.each([
    'REND PAGO APLIC AUT MAIS',
    'RENDIMENTO POUPANCA',
    'REND PAGO CDB',
    'RENDIMENTO CDB DI',
    'JUROS POUPANCA',
    'DIVIDENDO ITAU SA',
    'SALARIO EMPRESA X',
    'PAY ZIG L',
    'IFOOD RESTAURANTE',
  ])('NÃO classifica "%s" como MOVIMENTACAO_INTERNA', (s) => {
    expect(fastClassify(s)).not.toBe('MOVIMENTACAO_INTERNA');
  });

  // Outros casos esperados
  it('classifica PIX TRANSF como TRANSFERENCIA', () => {
    expect(fastClassify('PIX TRANSF MARIA')).toBe('TRANSFERENCIA');
  });
});

describe('detectCardPayment — texto explícito', () => {
  it.each([
    ['FATURA PAGA PERSON MULTI', true],
    ['FATURA PAGO ITAU', true],
    ['PAGTO CART CRED 5876', true],
    ['PAGAMENTO CARTAO CRED', true],
    ['DEB AUT CART', true],
    ['Pagamento PIX', false],         // PIX → tratado por matching async
    ['PIX TRANSF MARIA', false],      // PIX comum
    ['IFOOD RESTAURANTE', false],
  ])('detectCardPayment("%s").isCardPayment === %s', (s, expected) => {
    expect(detectCardPayment(s).isCardPayment).toBe(expected);
  });
});

describe('looksLikeOutboundTransfer — candidatos para match async', () => {
  it.each([
    ['Pagamento PIX', true],
    ['PIX TRANSF MARIA', true],
    ['PIX CARTAO', true],
    ['PgConta NU PAGAMENTOS SA', true],
    ['PgConta ITAU UNIBANCO SA', true],
    ['TED REFORMA', true],
    ['DOC FORNECEDOR', true],
    // negativos:
    ['IFOOD RESTAURANTE', false],
    ['PAY ZIG L', false],
    ['UBER TRIP', false],
    ['PIX QRS PIX MARKETP', false],   // PIX QRS é consumo
  ])('looksLikeOutboundTransfer("%s") === %s', (s, expected) => {
    expect(looksLikeOutboundTransfer(s)).toBe(expected);
  });
});

describe('isNeutralExpenseType', () => {
  it('aceita PAGAMENTO_FATURA_CARTAO e MOVIMENTACAO_INTERNA', () => {
    expect(isNeutralExpenseType('PAGAMENTO_FATURA_CARTAO' as any)).toBe(true);
    expect(isNeutralExpenseType('MOVIMENTACAO_INTERNA' as any)).toBe(true);
  });
  it('rejeita tipos normais', () => {
    expect(isNeutralExpenseType('ALIMENTACAO' as any)).toBe(false);
    expect(isNeutralExpenseType('OUTROS' as any)).toBe(false);
  });
  it('lida com null/undefined', () => {
    expect(isNeutralExpenseType(null as any)).toBe(false);
    expect(isNeutralExpenseType(undefined as any)).toBe(false);
  });
});

describe('makeExternalId + assignOrdinals — N linhas idênticas distintas', () => {
  it('3 transações idênticas no mesmo dia geram 3 externalIds distintos', () => {
    const date = new Date(Date.UTC(2026, 2, 20));
    const txs = [
      { date, merchant: 'PAY ZIG L 20/03', amountCents: 800 },
      { date, merchant: 'PAY ZIG L 20/03', amountCents: 800 },
      { date, merchant: 'PAY ZIG L 20/03', amountCents: 800 },
    ];
    const ord = assignOrdinals(txs);
    const ids = ord.map((t) =>
      makeExternalId({
        cardId: 'acc1',
        date: t.date,
        merchant: t.merchant,
        amountCents: t.amountCents,
        ordinal: t._ordinal,
      }),
    );
    expect(new Set(ids).size).toBe(3);
  });

  it('reprocessar o mesmo array gera os mesmos externalIds (idempotente)', () => {
    const date = new Date(Date.UTC(2026, 2, 20));
    const txs = [
      { date, merchant: 'PAY ZIG L', amountCents: 800 },
      { date, merchant: 'PAY ZIG L', amountCents: 800 },
      { date, merchant: 'PAY ZIG L', amountCents: 800 },
    ];
    const idsA = assignOrdinals(txs).map((t) =>
      makeExternalId({ cardId: 'a', date: t.date, merchant: t.merchant, amountCents: t.amountCents, ordinal: t._ordinal }),
    );
    const idsB = assignOrdinals(txs).map((t) =>
      makeExternalId({ cardId: 'a', date: t.date, merchant: t.merchant, amountCents: t.amountCents, ordinal: t._ordinal }),
    );
    expect(idsA).toEqual(idsB);
  });

  it('bankRef único ignora ordinal (idempotência via FITID)', () => {
    const date = new Date(Date.UTC(2026, 2, 20));
    const a = makeExternalId({ cardId: 'a', date, merchant: 'x', amountCents: 100, bankRef: 'F1', ordinal: 0 });
    const b = makeExternalId({ cardId: 'a', date, merchant: 'x', amountCents: 100, bankRef: 'F1', ordinal: 999 });
    expect(a).toBe(b);
  });

  it('transações diferentes mantêm ordinal=0 cada uma', () => {
    const date = new Date(Date.UTC(2026, 2, 20));
    const ord = assignOrdinals([
      { date, merchant: 'A', amountCents: 100 },
      { date, merchant: 'B', amountCents: 200 },
    ]);
    expect(ord[0]._ordinal).toBe(0);
    expect(ord[1]._ordinal).toBe(0);
  });
});
