import { expect, test } from 'vitest';
import { computeFuelSummary } from './fuel-summary';

const today = new Date('2026-07-23T12:00:00.000Z');

test('soma o mês atual e calcula a média entre os meses com gasto', () => {
  const result = computeFuelSummary(
    [
      { valorTotal: 20000, dataPagamento: '2026-07-05T00:00:00.000Z' },
      { valorTotal: 15000, dataPagamento: '2026-07-18T00:00:00.000Z' },
      { valorTotal: 18000, dataPagamento: '2026-06-10T00:00:00.000Z' },
    ],
    today,
  );
  expect(result.currentMonthCents).toBe(35000);
  expect(result.monthsConsidered).toBe(2);
  expect(result.averageMonthlyCents).toBe(Math.round((35000 + 18000) / 2));
});

test('sem despesas → tudo zero, sem divisão por zero', () => {
  const result = computeFuelSummary([], today);
  expect(result).toEqual({ currentMonthCents: 0, averageMonthlyCents: 0, monthsConsidered: 0 });
});

test('usa dataCompra quando presente, senão dataPagamento, senão createdAt', () => {
  const result = computeFuelSummary(
    [
      { valorTotal: 10000, dataCompra: '2026-07-01T00:00:00.000Z', dataPagamento: '2026-06-01T00:00:00.000Z' },
      { valorTotal: 5000, dataPagamento: null, createdAt: '2026-07-02T00:00:00.000Z' },
    ],
    today,
  );
  expect(result.currentMonthCents).toBe(15000);
});

test('despesa sem nenhuma data é ignorada (não conta em nenhum mês)', () => {
  const result = computeFuelSummary([{ valorTotal: 9999 }], today);
  expect(result.currentMonthCents).toBe(0);
  expect(result.monthsConsidered).toBe(0);
});
