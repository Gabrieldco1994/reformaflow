import { describe, expect, it } from "vitest";
import type { Expense } from "@/types";
import {
  expandExpenseOccurrences,
  expensePaymentTotals,
} from "./grouping-by-month";
import { buildContaReal } from "./conta-real";
import {
  suggestParcelaQuitacao,
  suggestParcelaQuitacaoAt,
} from "./quitarParcelaCross";
import { deriveOriginChips } from "../_components/OriginChips";

const expense: Expense = {
  id: "documented",
  tipoDespesa: "OUTROS",
  valor: 9753,
  quantidade: 1,
  valorTotal: 9753,
  formaPagamento: "PARCELADO",
  quantidadeParcela: 2,
  dataInicioParcela: "2026-08-10",
  status: "PLANEJADO",
  paidParcelas: "[0]",
  cardLast4: "1234",
  schedule: {
    version: 1,
    occurrences: [
      {
        index: 0,
        parcela: "2/3",
        valor: 10001,
        data: "2026-08-10",
        invoiceDueMonth: "2026-10",
      },
      {
        index: 1,
        parcela: "3/3",
        valor: -248,
        data: "2026-08-28",
        invoiceDueMonth: "2026-09",
      },
    ],
  },
};

describe("#701 documented schedule consumers", () => {
  it.each([
    {
      paidCents: 4000,
      remainingCents: 6003,
      settlementStatus: "PARTIAL",
      paid: 14001,
    },
    {
      paidCents: 10003,
      remainingCents: 0,
      settlementStatus: "PAID",
      paid: 20004,
    },
    {
      paidCents: 0,
      remainingCents: 10003,
      settlementStatus: "UNPAID",
      paid: 10001,
    },
  ] as const)(
    "composes sparse $settlementStatus funding with the native-paid documented sister",
    ({ paidCents, remainingCents, settlementStatus, paid }) => {
      const mixed: Expense = {
        ...expense,
        valor: 20004,
        valorTotal: 20004,
        cardLast4: null,
        schedule: {
          version: 1,
          occurrences: [
            {
              index: 0,
              parcela: "2/3",
              valor: 10001,
              data: "2026-08-10",
              invoiceDueMonth: null,
            },
            {
              index: 1,
              parcela: "3/3",
              valor: 10003,
              data: "2027-01-28",
              invoiceDueMonth: null,
            },
          ],
        },
        installmentSettlements: [
          {
            parcelaIndex: 1,
            dueDate: "2027-01-28",
            contractedCents: 10003,
            paidCents,
            remainingCents,
            settlementStatus,
            contributions: paidCents
              ? [
                  {
                    settlementId: "funding",
                    sourceId: "source",
                    amountCents: paidCents,
                    paymentDate: "2026-09-10",
                  },
                ]
              : [],
          },
        ],
      };
      expect(expensePaymentTotals(mixed)).toEqual({
        paid,
        remaining: remainingCents,
      });
      const occurrences = expandExpenseOccurrences(mixed);
      expect(occurrences[0]).toMatchObject({
        occKey: "documented#0",
        occIndex: 1,
        occParcela: "2/3",
        occValue: 10001,
        occDate: "2026-08-10",
        status: "PAGO",
      });
      if (remainingCents) {
        expect(occurrences.at(-1)).toMatchObject({
          occKey: "documented#1",
          occIndex: 2,
          occParcela: "3/3",
          occValue: remainingCents,
          occDate: "2027-01-28",
          status: "PLANEJADO",
        });
      }
      if (paidCents) {
        const contribution = occurrences.find(
          (occurrence) => occurrence.settlementId === "funding",
        )!;
        expect(contribution).toMatchObject({
          occIndex: 2,
          occParcela: "3/3",
          occValue: paidCents,
          occDate: "2026-09-10",
          status: "PAGO",
        });
        expect(expensePaymentTotals(contribution)).toEqual({
          paid: paidCents,
          remaining: 0,
        });
      }
    },
  );

  it("preserves signed amounts, real dates, labels and local paid indices", () => {
    expect(expandExpenseOccurrences(expense)).toMatchObject([
      {
        occKey: "documented#0",
        occIndex: 1,
        occParcela: "2/3",
        occValue: 10001,
        occDate: "2026-08-10",
        invoiceDueMonth: "2026-10",
        status: "PAGO",
      },
      {
        occKey: "documented#1",
        occIndex: 2,
        occParcela: "3/3",
        occValue: -248,
        occDate: "2026-08-28",
        invoiceDueMonth: "2026-09",
        status: "PLANEJADO",
      },
    ]);
  });

  it("uses explicit cycles on both sides of closing day without rewriting purchase dates", () => {
    const months = buildContaReal(
      [expense],
      [{ last4: "1234", label: "Cartão", closingDay: 20, dueDay: 5 }],
    );
    expect([...months.keys()].sort()).toEqual(["2026-09", "2026-10"]);
    expect(months.get("2026-10")).toMatchObject({
      total: 10001,
      pago: 10001,
      faturas: [
        { itens: [{ parcela: "2/3", valor: 10001, data: "2026-08-10" }] },
      ],
    });
    expect(months.get("2026-09")).toMatchObject({
      total: -248,
      planejado: -248,
      faturas: [
        { itens: [{ parcela: "3/3", valor: -248, data: "2026-08-28" }] },
      ],
    });
  });

  it("suggests the actual remaining local occurrence, never label numerator minus one", () => {
    expect(suggestParcelaQuitacao(expense)).toEqual({
      parcelaIndex: 1,
      valorSugerido: -248,
      dataSugerida: "2026-08-28",
    });
    expect(suggestParcelaQuitacaoAt(expense, 0)).toEqual({
      parcelaIndex: 0,
      valorSugerido: 10001,
      dataSugerida: "2026-08-10",
    });
  });

  it("does not redivide sliced documented occurrences in origin totals", () => {
    const chips = deriveOriginChips(
      expandExpenseOccurrences(expense),
      new Map(),
      new Map(),
      true,
    );
    expect(chips).toMatchObject([{ pago: 10001, planejado: -248, count: 2 }]);
  });

  it("keeps legacy division, remainder, dates and status unchanged with null schedule", () => {
    expect(
      expandExpenseOccurrences({ ...expense, schedule: null }),
    ).toMatchObject([
      {
        occKey: "documented#0",
        occValue: 4876,
        occDate: "2026-08-10",
        status: "PAGO",
      },
      {
        occKey: "documented#1",
        occValue: 4877,
        occDate: "2026-09-10",
        status: "PLANEJADO",
      },
    ]);
  });

  it("does not bypass a documented schedule for single-payment forms", () => {
    expect(
      expandExpenseOccurrences({
        ...expense,
        formaPagamento: "A_VISTA",
        quantidadeParcela: 1,
        schedule: {
          version: 1,
          occurrences: [
            {
              index: 0,
              parcela: "3/3",
              valor: 9753,
              data: "2026-08-28",
              invoiceDueMonth: "2026-11",
            },
          ],
        },
      }),
    ).toMatchObject([
      {
        occIndex: 1,
        occParcela: "3/3",
        occValue: 9753,
        invoiceDueMonth: "2026-11",
      },
    ]);
  });

  it.each([
    { cards: [{ last4: "1234", label: "Cartão", closingDay: 20, dueDay: 5 }] },
    { cards: [] },
  ])(
    "keeps new paid credits in the documented cycle with configuration $cards",
    ({ cards }) => {
      const purchases: Expense[] = [
        { id: "purchase", valor: 12345, data: "2026-09-10" },
        { id: "credit-7", valor: -7, data: "2026-08-10" },
        { id: "credit-321", valor: -321, data: "2026-08-28" },
      ].map(({ id, valor, data }) => ({
        ...expense,
        id,
        valor,
        valorTotal: valor,
        formaPagamento: "A_VISTA",
        quantidadeParcela: 1,
        dataPagamento: data,
        status: "PAGO",
        schedule: {
          version: 1,
          occurrences: [
            {
              index: 0,
              parcela: null,
              valor,
              data,
              invoiceDueMonth: "2026-11",
            },
          ],
        },
      }));
      const credits = buildContaReal(purchases.slice(1), cards);
      expect([...credits.keys()]).toEqual(["2026-11"]);
      expect(credits.get("2026-11")?.total).toBe(-328);
      const months = buildContaReal(purchases, cards);
      expect([...months.keys()]).toEqual(["2026-11"]);
      expect(months.get("2026-11")?.total).toBe(12017);
      expect(months.get("2026-11")?.faturas[0].itens).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            expenseId: "credit-7",
            data: "2026-08-10",
            valor: -7,
          }),
          expect.objectContaining({
            expenseId: "credit-321",
            data: "2026-08-28",
            valor: -321,
          }),
        ]),
      );
    },
  );

  it("applies date overrides without discarding the explicit cycle or local label", () => {
    expect(
      expandExpenseOccurrences({
        ...expense,
        installmentDateOverrides: '{"1":"2026-10-20"}',
      })[1],
    ).toMatchObject({
      occIndex: 2,
      occParcela: "3/3",
      occValue: -248,
      occDate: "2026-10-20",
      invoiceDueMonth: "2026-09",
    });
  });
});
