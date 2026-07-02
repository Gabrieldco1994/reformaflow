import { describe, it, expect } from 'vitest';
import { voiceParsedToFormData, type VoiceParsedLike } from './voiceExpense';
import { buildExpenseFormData } from './wizardPayload';
import { makeEmptyWizardDraft } from '../_hooks/useNovaDespesaWizard';

const NOW = new Date('2026-07-02T12:00:00.000Z');

function parsed(patch: Partial<VoiceParsedLike>): VoiceParsedLike {
  return {
    tipoDespesa: 'OUTROS',
    valor: 85,
    formaPagamento: 'A_VISTA',
    status: 'PAGO',
    dataReferencia: '2026-07-02',
    quantidadeParcela: null,
    titulo: 'Mercado',
    creditCardId: null,
    bankAccountId: null,
    ...patch,
  };
}

describe('voiceParsedToFormData', () => {
  it('à vista PAGO: status PAGO, dataPagamento setada, parcelas nulas', () => {
    const d = voiceParsedToFormData(parsed({}), { now: NOW });
    expect(d.status).toBe('PAGO');
    expect(d.valor).toBe(85);
    expect(d.quantidade).toBe(1);
    expect(d.dataPagamento).toBe('2026-07-02');
    expect(d.quantidadeParcela).toBeNull();
    expect(d.dataInicioParcela).toBeNull();
  });

  it('parcelado PLANEJADO: quantidadeParcela e dataInicioParcela setadas, dataPagamento nula', () => {
    const d = voiceParsedToFormData(
      parsed({ formaPagamento: 'PARCELADO', quantidadeParcela: 3, status: 'PLANEJADO', dataReferencia: '2026-08-01' }),
      { now: NOW },
    );
    expect(d.status).toBe('PLANEJADO');
    expect(d.quantidadeParcela).toBe(3);
    expect(d.dataInicioParcela).toBe('2026-08-01');
    expect(d.dataPagamento).toBeNull();
  });

  it('dataReferencia vazia usa a data atual (now)', () => {
    const d = voiceParsedToFormData(parsed({ dataReferencia: '' }), { now: NOW });
    expect(d.dataPagamento).toBe('2026-07-02');
  });

  it('parcelado sem quantidade explícita → 1', () => {
    const d = voiceParsedToFormData(
      parsed({ formaPagamento: 'PARCELADO', quantidadeParcela: null, status: 'PLANEJADO' }),
      { now: NOW },
    );
    expect(d.quantidadeParcela).toBe(1);
  });

  it('propaga cartão, conta, fornecedor e linkedExpenseId', () => {
    const d = voiceParsedToFormData(
      parsed({ creditCardId: 'card-1', bankAccountId: 'acc-1' }),
      { fornecedor: 'Padaria', linkedExpenseId: 'exp-9', now: NOW },
    );
    expect(d.creditCardId).toBe('card-1');
    expect(d.bankAccountId).toBe('acc-1');
    expect(d.fornecedor).toBe('Padaria');
    expect(d.linkedExpenseId).toBe('exp-9');
  });

  it('PARIDADE: idêntico a buildExpenseFormData do draft equivalente (+ linkedExpenseId)', () => {
    const p = parsed({
      formaPagamento: 'PARCELADO',
      quantidadeParcela: 5,
      status: 'PLANEJADO',
      dataReferencia: '2026-09-01',
      titulo: 'Telha',
      creditCardId: 'card-x',
    });
    const viaVoice = voiceParsedToFormData(p, { fornecedor: 'Loja', linkedExpenseId: 'exp-1', now: NOW });

    const draft = {
      ...makeEmptyWizardDraft(),
      tipoDespesa: p.tipoDespesa,
      valor: String(p.valor),
      quantidade: '1',
      titulo: p.titulo,
      fornecedor: 'Loja',
      formaPagamento: p.formaPagamento,
      dataPagamento: '',
      quantidadeParcela: '5',
      dataInicioParcela: '2026-09-01',
      creditCardId: 'card-x',
      bankAccountId: '',
    };
    const expected = {
      ...buildExpenseFormData(draft, { mode: 'PLANEJAR', allowRecorrente: false }),
      linkedExpenseId: 'exp-1',
    };
    expect(viaVoice).toEqual(expected);
  });
});
