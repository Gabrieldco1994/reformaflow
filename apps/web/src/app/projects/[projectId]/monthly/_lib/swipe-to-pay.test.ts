import { describe, expect, it } from "vitest";
import type { MonthlyEntry } from "../_types";
import { resolveSwipeToPayTarget } from "./swipe-to-pay";

function baseEligibleEntry(patch: Partial<MonthlyEntry> = {}): MonthlyEntry {
  return {
    id: "cashflow-1",
    data: "2026-07-10T12:00:00.000Z",
    tipo: "DESPESA",
    status: "PLANEJADO",
    valor: 50_007,
    categoria: "Moradia",
    subcategoria: null,
    formaPagamento: "PIX",
    projectId: "pessoal-test",
    projectName: "Pessoal Teste",
    projectType: "PESSOAL",
    isNeutral: false,
    isNeutralConsumo: false,
    isEspelho: false,
    expenseId: "exp-1",
    ...patch,
  };
}

describe("resolveSwipeToPayTarget", () => {
  it("resolves expenseId + ownerProjectId for an eligible planned expense", () => {
    expect(
      resolveSwipeToPayTarget(baseEligibleEntry(), "pessoal-test"),
    ).toEqual({ expenseId: "exp-1", ownerProjectId: "pessoal-test" });
  });

  it("returns null for RECEBIMENTO (receipts excluded)", () => {
    expect(
      resolveSwipeToPayTarget(
        baseEligibleEntry({ tipo: "RECEBIMENTO" }),
        "pessoal-test",
      ),
    ).toBeNull();
  });

  it("returns null for already realized status PAGO", () => {
    expect(
      resolveSwipeToPayTarget(
        baseEligibleEntry({ status: "PAGO" }),
        "pessoal-test",
      ),
    ).toBeNull();
  });

  it("returns null for already realized status EM_CAIXA", () => {
    expect(
      resolveSwipeToPayTarget(
        baseEligibleEntry({ status: "EM_CAIXA" }),
        "pessoal-test",
      ),
    ).toBeNull();
  });

  it("returns null when expenseId is absent (unsafe row — manual cashflow entry)", () => {
    expect(
      resolveSwipeToPayTarget(
        baseEligibleEntry({ expenseId: null }),
        "pessoal-test",
      ),
    ).toBeNull();
  });

  it("never returns entry.id as expenseId even when both are present and differ", () => {
    const result = resolveSwipeToPayTarget(
      baseEligibleEntry({ id: "cashflow-999", expenseId: "exp-1" }),
      "pessoal-test",
    );
    expect(result?.expenseId).toBe("exp-1");
    expect(result?.expenseId).not.toBe("cashflow-999");
  });

  it("returns null for invoices (isNeutral true)", () => {
    expect(
      resolveSwipeToPayTarget(
        baseEligibleEntry({ isNeutral: true }),
        "pessoal-test",
      ),
    ).toBeNull();
  });

  it("returns null for neutro-de-consumo (isNeutralConsumo true)", () => {
    expect(
      resolveSwipeToPayTarget(
        baseEligibleEntry({ isNeutralConsumo: true }),
        "pessoal-test",
      ),
    ).toBeNull();
  });

  it("returns null for mirror rows (isEspelho true)", () => {
    expect(
      resolveSwipeToPayTarget(
        baseEligibleEntry({ isEspelho: true }),
        "pessoal-test",
      ),
    ).toBeNull();
  });

  it("returns null for cross-project rows (entry.projectId !== viewingProjectId)", () => {
    expect(
      resolveSwipeToPayTarget(
        baseEligibleEntry({ projectId: "reforma-1" }),
        "pessoal-test",
      ),
    ).toBeNull();
  });

  it("boundary: same projectId as viewingProjectId is eligible", () => {
    expect(
      resolveSwipeToPayTarget(
        baseEligibleEntry({ projectId: "pessoal-test" }),
        "pessoal-test",
      ),
    ).not.toBeNull();
  });
});
