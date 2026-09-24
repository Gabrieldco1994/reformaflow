import { renderHook } from "@testing-library/react";
import { ProjectType } from "@reformaflow/domain";
import { describe, expect, it, vi } from "vitest";
import type { Expense } from "@/types";
import { formatCurrency } from "@/lib/utils";
import { getAvulsaDisplay } from "../../bills/_display";
import { useExpenseFilters } from "../_hooks/useExpenseFilters";
import { decodeExpenseQuery } from "./expense-query-state";
import {
  expandExpenseOccurrences,
  expensePaymentTotals,
} from "./grouping-by-month";

const mixed: Expense = {
  id: "mixed-contract",
  tipoDespesa: "OUTROS",
  valor: 160_000,
  quantidade: 1,
  valorTotal: 160_000,
  formaPagamento: "PARCELADO",
  quantidadeParcela: 2,
  dataInicioParcela: "2026-09-10",
  status: "PLANEJADO",
  paidParcelas: "[0]",
  // Native/legacy-paid index 0 is deliberately absent from the server summary.
  installmentSettlements: [
    {
      parcelaIndex: 1,
      dueDate: "2026-10-10T00:00:00.000Z",
      contractedCents: 80_000,
      paidCents: 40_000,
      remainingCents: 40_000,
      settlementStatus: "PARTIAL",
    },
  ],
};

describe("#702 X3 sparse settlement summaries", () => {
  describe.each([
    {
      name: "native-paid sister plus partial additive",
      expense: mixed,
      paid: 120_000,
      remaining: 40_000,
    },
    {
      name: "native-paid sister plus full additive",
      expense: {
        ...mixed,
        status: "PAGO",
        paidParcelas: "[0,1]",
        installmentSettlements: [
          {
            ...mixed.installmentSettlements![0],
            paidCents: 80_000,
            remainingCents: 0,
            settlementStatus: "PAID",
          },
        ],
      } satisfies Expense,
      paid: 160_000,
      remaining: 0,
    },
    {
      name: "unpaid sister is not assumed paid merely because its summary is absent",
      expense: { ...mixed, paidParcelas: "[]" },
      paid: 40_000,
      remaining: 120_000,
    },
  ])("$name", ({ expense, paid, remaining }) => {
    it("counts the entire contract in the real category payment helper", () => {
      expect(expensePaymentTotals(expense)).toEqual({ paid, remaining });
    });

    it("keeps whole-contract amounts in the actual CASA/CARRO Avulsas display", () => {
      for (const projectType of [ProjectType.CASA, ProjectType.CARRO]) {
        const display = getAvulsaDisplay(expense, projectType);
        expect
          .soft(display.fundingDetails)
          .toEqual([
            `Contratado: ${formatCurrency(1_600)}`,
            `Pago: ${formatCurrency(paid / 100)}`,
          ]);
        expect
          .soft(display.value)
          .toBe(`Restante: ${formatCurrency(remaining / 100)}`);
        expect(display.source).toBe(expense);
      }
    });
  });

  it("retains the native-paid sister in the real REFORMA category hook", () => {
    const query = decodeExpenseQuery(new URLSearchParams(), {
      projectType: ProjectType.REFORMA,
      hasRooms: true,
    });
    const { result } = renderHook(() =>
      useExpenseFilters([mixed], true, query, vi.fn()),
    );
    expect(result.current.categorias).toHaveLength(1);
    expect(result.current.categorias[0]).toMatchObject({
      tipo: "OUTROS",
      total: 160_000,
      totalPago: 120_000,
      totalPlanejado: 40_000,
      expenses: [mixed],
    });
  });

  it.each([
    { status: "PLANEJADO", paid: 0, remaining: 160_000 },
    { status: "PAGO", paid: 160_000, remaining: 0 },
  ] as const)(
    "preserves the no-summary $status control",
    ({ status, paid, remaining }) => {
      const expense: Expense = {
        ...mixed,
        status,
        paidParcelas: status === "PAGO" ? "[0,1]" : "[]",
        installmentSettlements: undefined,
      };
      expect(expensePaymentTotals(expense)).toEqual({ paid, remaining });
      expect(getAvulsaDisplay(expense, ProjectType.CASA)).toMatchObject({
        value: formatCurrency(1_600),
        fundingDetails: [],
      });
    },
  );

  it("does not double count a contract when both installments have additive summaries", () => {
    const expense: Expense = {
      ...mixed,
      installmentSettlements: [
        {
          parcelaIndex: 0,
          dueDate: "2026-09-10T00:00:00.000Z",
          contractedCents: 80_000,
          paidCents: 80_000,
          remainingCents: 0,
          settlementStatus: "PAID",
        },
        mixed.installmentSettlements![0],
      ],
    };
    expect(expensePaymentTotals(expense)).toEqual({
      paid: 120_000,
      remaining: 40_000,
    });
    expect(getAvulsaDisplay(expense, ProjectType.CASA).fundingDetails).toEqual([
      `Contratado: ${formatCurrency(1_600)}`,
      `Pago: ${formatCurrency(1_200)}`,
    ]);
  });

  it("keeps existing occurrence slices scoped rather than recounting their parent", () => {
    expect(expandExpenseOccurrences(mixed).map(expensePaymentTotals)).toEqual([
      { paid: 80_000, remaining: 0 },
      { paid: 40_000, remaining: 0 },
      { paid: 0, remaining: 40_000 },
    ]);
  });
});
