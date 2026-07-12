import { describe, it, expect } from 'vitest';
import { deriveCardWalletStatus } from './card-wallet-status';

describe('deriveCardWalletStatus', () => {
  it('cartão sem closingDay cadastrado → configurar, mesmo com fatura zerada/paga', () => {
    const card = { status: 'paga', dueMonth: '2026-07', vencimento: '2026-07-01' };
    const status = deriveCardWalletStatus(card, { closingDay: null });
    expect(status).toBe('configurar');
  });

  it('cartão com closingDay e status "a pagar" → aberta', () => {
    const card = { status: 'a pagar', dueMonth: '2026-07', vencimento: '2026-07-01' };
    const status = deriveCardWalletStatus(card, { closingDay: 5 });
    expect(status).toBe('aberta');
  });

  it('cartão com closingDay e status "paga" → paga', () => {
    const card = { status: 'paga', dueMonth: '2026-07', vencimento: '2026-07-01' };
    const status = deriveCardWalletStatus(card, { closingDay: 5 });
    expect(status).toBe('paga');
  });

  it('sem cadastro do cartão ainda carregado e sem dueMonth/vencimento → configurar (fallback transitório)', () => {
    const card = { status: 'paga', dueMonth: '', vencimento: '' };
    const status = deriveCardWalletStatus(card, undefined);
    expect(status).toBe('configurar');
  });
});
