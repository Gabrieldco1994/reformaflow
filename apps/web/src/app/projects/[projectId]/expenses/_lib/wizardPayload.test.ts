import { describe, it, expect } from 'vitest';
import {
  buildExpenseFormData,
  buildRatearMixedPayload,
  detectSingleLinkShortcut,
} from './wizardPayload';
import {
  makeEmptyWizardDraft,
  type BasketRow,
  type WizardDraft,
} from '../_hooks/useNovaDespesaWizard';

function draft(patch: Partial<WizardDraft>): WizardDraft {
  return { ...makeEmptyWizardDraft(), ...patch };
}

describe('buildExpenseFormData', () => {
  it('A_VISTA: seta dataPagamento, zera parcela; mode PLANEJAR → PLANEJADO', () => {
    const d = draft({
      tipoDespesa: 'MATERIAL_CONSTRUCAO',
      valor: '150',
      quantidade: '2',
      formaPagamento: 'A_VISTA',
      dataPagamento: '2026-01-10',
      dataCompra: '2026-01-05',
    });
    const data = buildExpenseFormData(d, { mode: 'PLANEJAR', allowRecorrente: false });
    expect(data.status).toBe('PLANEJADO');
    expect(data.valor).toBe(150);
    expect(data.quantidade).toBe(2);
    expect(data.dataPagamento).toBe('2026-01-10');
    expect(data.quantidadeParcela).toBeNull();
    expect(data.dataInicioParcela).toBeNull();
    expect(data.dataCompra).toBe('2026-01-05'); // independe da forma
  });

  it('PARCELADO: seta quantidadeParcela e dataInicioParcela, zera dataPagamento', () => {
    const d = draft({
      tipoDespesa: 'MATERIAL_CONSTRUCAO',
      valor: '300',
      quantidade: '1',
      formaPagamento: 'PARCELADO',
      quantidadeParcela: '3',
      dataInicioParcela: '2026-02-01',
      dataCompra: '2026-01-20',
    });
    const data = buildExpenseFormData(d, { mode: 'PLANEJAR', allowRecorrente: true });
    expect(data.quantidadeParcela).toBe(3);
    expect(data.dataInicioParcela).toBe('2026-02-01');
    expect(data.dataPagamento).toBeNull();
    expect(data.recorrente).toBe(false);
    expect(data.recorrenciaFim).toBeNull();
    expect(data.dataCompra).toBe('2026-01-20'); // independe da forma
  });

  it('PARCELADO com quantidadeParcela 0 → null', () => {
    const d = draft({ formaPagamento: 'QUINZENAL', quantidadeParcela: '0' });
    const data = buildExpenseFormData(d, { mode: 'PLANEJAR', allowRecorrente: false });
    expect(data.quantidadeParcela).toBeNull();
  });

  it('recorrente só quando allowRecorrente && single; recorrenciaFim YYYY-MM → YYYY-MM-01', () => {
    const d = draft({
      formaPagamento: 'A_VISTA',
      recorrente: true,
      recorrenciaFim: '2026-12',
    });
    const on = buildExpenseFormData(d, { mode: 'PLANEJAR', allowRecorrente: true });
    expect(on.recorrente).toBe(true);
    expect(on.recorrenciaFim).toBe('2026-12-01');

    const off = buildExpenseFormData(d, { mode: 'PLANEJAR', allowRecorrente: false });
    expect(off.recorrente).toBe(false);
    expect(off.recorrenciaFim).toBeNull();
  });

  it('mode PAGA → status PAGO', () => {
    const d = draft({ formaPagamento: 'A_VISTA', dataPagamento: '2026-01-01' });
    const data = buildExpenseFormData(d, { mode: 'PAGA', allowRecorrente: false });
    expect(data.status).toBe('PAGO');
  });

  it('card/bank vazios → null', () => {
    const d = draft({ formaPagamento: 'A_VISTA' });
    const data = buildExpenseFormData(d, { mode: 'PLANEJAR', allowRecorrente: false });
    expect(data.creditCardId).toBeNull();
    expect(data.bankAccountId).toBeNull();
  });

  it('card/bank preenchidos passam adiante', () => {
    const d = draft({ formaPagamento: 'A_VISTA', creditCardId: 'cc1', bankAccountId: 'ba1' });
    const data = buildExpenseFormData(d, { mode: 'PLANEJAR', allowRecorrente: false });
    expect(data.creditCardId).toBe('cc1');
    expect(data.bankAccountId).toBe('ba1');
  });

  it('não inclui linkedExpenseId', () => {
    const d = draft({ formaPagamento: 'A_VISTA' });
    const data = buildExpenseFormData(d, { mode: 'PLANEJAR', allowRecorrente: false });
    expect(data.linkedExpenseId).toBeUndefined();
  });
});

describe('buildRatearMixedPayload', () => {
  it('separa EXISTING e NEW; valores em reais/centavos', () => {
    const basket: BasketRow[] = [
      { id: 'r0', kind: 'EXISTING', target: { id: 't1' }, allocation: 500_000 },
      {
        id: 'r1',
        kind: 'NEW',
        allocation: 1_000_000,
        draft: {
          targetProjectId: 'p2',
          tipoDespesa: 'MATERIAL_CONSTRUCAO',
          valor: '10000',
          quantidade: '1',
          titulo: 'Piso',
        },
      },
    ];
    const payload = buildRatearMixedPayload(basket);
    expect(payload.existing).toEqual([{ targetExpenseId: 't1', allocation: 500_000 }]);
    expect(payload.newTargets).toHaveLength(1);
    expect(payload.newTargets[0]).toMatchObject({
      targetProjectId: 'p2',
      tipoDespesa: 'MATERIAL_CONSTRUCAO',
      valor: 10000, // REAIS
      quantidade: 1,
      titulo: 'Piso',
      allocation: 1_000_000, // centavos
    });
  });
});

describe('detectSingleLinkShortcut', () => {
  it('1 EXISTING no valor cheio → shortcut', () => {
    const basket: BasketRow[] = [
      { id: 'r0', kind: 'EXISTING', target: { id: 't1' }, allocation: 1_500_000 },
    ];
    expect(detectSingleLinkShortcut(basket, 1_500_000)).toEqual({ targetExpenseId: 't1' });
  });

  it('EXISTING parcial → null', () => {
    const basket: BasketRow[] = [
      { id: 'r0', kind: 'EXISTING', target: { id: 't1' }, allocation: 500_000 },
    ];
    expect(detectSingleLinkShortcut(basket, 1_500_000)).toBeNull();
  });

  it('linha NEW → null', () => {
    const basket: BasketRow[] = [
      {
        id: 'r0',
        kind: 'NEW',
        allocation: 1_500_000,
        draft: { targetProjectId: 'p2', valor: '15000' },
      },
    ];
    expect(detectSingleLinkShortcut(basket, 1_500_000)).toBeNull();
  });

  it('mais de 1 linha → null', () => {
    const basket: BasketRow[] = [
      { id: 'r0', kind: 'EXISTING', target: { id: 't1' }, allocation: 1_000_000 },
      { id: 'r1', kind: 'EXISTING', target: { id: 't2' }, allocation: 500_000 },
    ];
    expect(detectSingleLinkShortcut(basket, 1_500_000)).toBeNull();
  });
});
