import { describe, expect, it } from 'vitest';
import type { Expense } from '@/types';
import { canDeleteExpense, expenseUpdatePayload, isExpenseCredit } from './credit-policy';
import { expenseMetadataFromForm } from './expense-metadata';

const base = { valorTotal: 40_000 };

describe('credit policy (#704): sign never grants ownership or deletion', () => {
  it.each([
    [-1, true],
    [0, false],
    [1, false],
  ])('valorTotal=%s -> credit=%s', (valorTotal, credit) => {
    expect(isExpenseCredit({ valorTotal })).toBe(credit);
  });
  it('treats absent expense as not a credit', () => {
    expect(isExpenseCredit(null)).toBe(false);
    expect(isExpenseCredit(undefined)).toBe(false);
  });

  it.each([
    { valorTotal: -40_000, canDelete: undefined, allowed: false },
    { valorTotal: -40_000, canDelete: false, allowed: false },
    { valorTotal: -40_000, canDelete: true, allowed: true },
    { valorTotal: 40_000, canDelete: undefined, allowed: true },
    { valorTotal: 40_000, canDelete: false, allowed: false },
    { valorTotal: 40_000, canDelete: true, allowed: true },
  ])('canDeleteExpense($valorTotal, $canDelete) = $allowed', ({ allowed, ...expense }) => {
    expect(canDeleteExpense(expense)).toBe(allowed);
  });

  describe('expenseUpdatePayload', () => {
    const form = {
      tipoDespesa: 'OUTROS',
      categoriaMaoDeObra: null,
      valor: 1,
      quantidade: 2,
      formaPagamento: 'A_VISTA',
      dataPagamento: '2026-09-10',
      status: 'PAGO',
      linkedExpenseId: 'x',
      cardLast4: '1234',
      titulo: 'Novo título',
      fornecedor: 'Forn',
      link: 'https://x',
      imageUrl: null,
    } as never;

    it('keeps positive payloads untouched', () => {
      expect(expenseUpdatePayload(base, form)).toBe(form);
      expect(expenseUpdatePayload(null, form)).toBe(form);
    });
    it('reduces every credit to the four descriptive fields', () => {
      expect(expenseUpdatePayload({ valorTotal: -1 }, form)).toStrictEqual({
        titulo: 'Novo título',
        fornecedor: 'Forn',
        link: 'https://x',
        imageUrl: null,
      });
    });
    it('#701 overlap: metadata built for a documented schedule loses category fields for a credit', () => {
      // Type-level overlap only: no claim that the backend emits credit+schedule.
      const fd = new FormData();
      fd.set('tipoDespesa', 'OUTROS');
      fd.set('categoriaMaoDeObra', 'PEDREIRO');
      fd.set('titulo', 'T');
      fd.set('fornecedor', 'F');
      const scheduleCredit = { valorTotal: -248, schedule: { version: 1, occurrences: [] } } as Pick<Expense, 'valorTotal'>;
      const payload = expenseUpdatePayload(scheduleCredit, expenseMetadataFromForm(fd, true));
      expect(Object.keys(payload).sort()).toEqual(['fornecedor', 'imageUrl', 'link', 'titulo']);
      expect(payload).not.toHaveProperty('tipoDespesa');
      expect(payload).not.toHaveProperty('categoriaMaoDeObra');
      expect(payload).not.toHaveProperty('roomId');
    });
  });
});
