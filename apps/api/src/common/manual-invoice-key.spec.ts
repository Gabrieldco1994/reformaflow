import {
  MANUAL_INVOICE_KEY_VERSION,
  buildManualInvoiceKey,
  isManualInvoiceKey,
  parseManualInvoiceKey,
} from './manual-invoice-key';

describe('manual-invoice-key (namespace reservado m1)', () => {
  const cardId = 'cmtvze00t0007lydyi657x4fn';

  it('build → parse round-trip', () => {
    const key = buildManualInvoiceKey(cardId, '5555', '2026-10');
    expect(key).toBe(`m1:${cardId}:5555:2026-10`);
    expect(parseManualInvoiceKey(key)).toEqual({ cardId, last4: '5555', dueMonth: '2026-10' });
    expect(isManualInvoiceKey(key)).toBe(true);
    expect(MANUAL_INVOICE_KEY_VERSION).toBe('m1');
  });

  it('legado de 2 partes NÃO é chave manual (cartão paga cartão / declaração geral)', () => {
    expect(parseManualInvoiceKey('5555:2026-10')).toBeNull();
    expect(isManualInvoiceKey('5555:2026-10')).toBe(false);
  });

  it.each([
    null,
    undefined,
    '',
    'm1:5555:2026-10', // 3 partes (sem cardId)
    `m1:${cardId}:5555:2026-10:x`, // 5 partes
    `m0:${cardId}:5555:2026-10`, // versão errada
    `m1::5555:2026-10`, // cardId vazio
    `m1:${cardId}:555:2026-10`, // last4 curto
    `m1:${cardId}:55a5:2026-10`, // last4 não-dígito
    `m1:${cardId}:5555:2026-13`, // mês inválido
    `m1:${cardId}:5555:2026-1`, // mês malformado
    `m1:${cardId}:5555:not-a-month`,
  ])('fail-closed: %s → null', (bad) => {
    expect(parseManualInvoiceKey(bad as string | null | undefined)).toBeNull();
    expect(isManualInvoiceKey(bad as string | null | undefined)).toBe(false);
  });
});
