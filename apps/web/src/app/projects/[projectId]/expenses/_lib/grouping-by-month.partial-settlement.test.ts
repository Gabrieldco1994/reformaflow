import { describe, expect, it } from "vitest";
import type { Expense } from "@/types";
import {
  expandExpenseOccurrences,
  groupExpensesByMes,
  expensePaymentTotals,
} from "./grouping-by-month";
import { toCaixaBase, toDisplayBase } from "./personal-hierarchy";

const target: Expense = {
  id: "contract",
  tipoDespesa: "OUTROS",
  formaPagamento: "PARCELADO",
  valor: 80_000,
  quantidade: 1,
  valorTotal: 80_000,
  quantidadeParcela: 1,
  dataInicioParcela: "2026-10-10",
  status: "PLANEJADO",
  installmentSettlements: [
    {
      parcelaIndex: 0,
      dueDate: "2026-10-10T00:00:00.000Z",
      contractedCents: 80_000,
      paidCents: 40_000,
      remainingCents: 40_000,
      settlementStatus: "PARTIAL",
      contributions: [
        {
          settlementId: "a",
          sourceId: "source-a",
          amountCents: 25_000,
          paymentDate: "2026-09-05T00:00:00.000Z",
        },
        {
          settlementId: "b",
          sourceId: "source-b",
          amountCents: 15_000,
          paymentDate: "2026-09-20T00:00:00.000Z",
        },
      ],
    },
  ],
};

describe("cash grouping — additive funding #702", () => {
  it("keeps 80k contracted, 40k paid in September and 40k due in October", () => {
    const groups = groupExpensesByMes([target]);
    expect(
      groups.map((g) => [g.mesKey, g.totalPago, g.totalPlanejado]),
    ).toEqual([
      ["2026-09", 40_000, 0],
      ["2026-10", 0, 40_000],
    ]);
    const rows = groups.flatMap((g) => g.items);
    expect(new Set(rows.map((r) => r.occKey)).size).toBe(3);
    expect(rows.find((r) => r.status === "PLANEJADO")?.occKey).toBe(
      "contract#0",
    );
    expect(rows.reduce((sum, r) => sum + r.occValue, 0)).toBe(80_000);
    expect(target.valorTotal).toBe(80_000);
    expect(expandExpenseOccurrences(rows[0])).toEqual([rows[0]]);
  });

  it("undo preserves the pending key; the other contribution keeps its date and key", () => {
    const before = expandExpenseOccurrences(target);
    const after = expandExpenseOccurrences({
      ...target,
      installmentSettlements: [
        {
          ...target.installmentSettlements![0],
          paidCents: 15_000,
          remainingCents: 65_000,
          contributions: [target.installmentSettlements![0].contributions![1]],
        },
      ],
    });
    expect(after.find((r) => r.status === "PAGO")?.occKey).toBe(
      before.find((r) => r.occValue === 15_000)?.occKey,
    );
    expect(after.find((r) => r.status === "PLANEJADO")).toMatchObject({
      occKey: "contract#0",
      occValue: 65_000,
    });
  });

  it("does not invent payment dates or contribution counts when details are redacted", () => {
    const rows = expandExpenseOccurrences({
      ...target,
      installmentSettlements: [
        { ...target.installmentSettlements![0], contributions: undefined },
      ],
    });
    expect(rows.find((r) => r.status === "PAGO")).toMatchObject({
      occDate: "",
      occValue: 40_000,
    });
    expect(rows.reduce((sum, r) => sum + r.occValue, 0)).toBe(80_000);
  });

  it("category totals sum paid + remaining without adding the contract again", () => {
    expect(expensePaymentTotals(target)).toEqual({
      paid: 40_000,
      remaining: 40_000,
    });
  });

  it("keeps the original pending occurrence after the last contribution is undone", () => {
    const rows = expandExpenseOccurrences({
      ...target,
      installmentSettlements: [
        {
          ...target.installmentSettlements![0],
          paidCents: 0,
          remainingCents: 80_000,
          settlementStatus: "UNPAID",
          contributions: [],
        },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      occKey: "contract#0",
      occDate: "2026-10-10",
      occValue: 80_000,
      status: "PLANEJADO",
    });
  });

  it("PESSOAL bases keep the real debit and only the foreign remainder", () => {
    const debit: Expense = {
      ...target,
      id: "source",
      valorTotal: 80_000,
      formaPagamento: "PIX",
      status: "PAGO",
      dataPagamento: "2026-09-05",
      installmentSettlements: undefined,
      sourceAvailableCents: 40_000,
    };
    for (const base of [toCaixaBase, toDisplayBase]) {
      const rows = base([debit, target], new Set());
      expect(rows.filter((r) => r.id === "source")).toHaveLength(1);
      expect(rows.reduce((sum, r) => sum + r.valorTotal, 0)).toBe(120_000);
      expect(rows.find((r) => r.id === "contract")).toMatchObject({
        valorTotal: 40_000,
        status: "PLANEJADO",
      });
    }
  });
});
