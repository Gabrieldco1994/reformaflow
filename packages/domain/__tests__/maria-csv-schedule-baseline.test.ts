import { describe, expect, it } from "vitest";
import {
  buildInstallments,
  PaymentForm,
  type ExpenseScheduleV1,
  type InstallmentInput,
} from "../src";

const schedule: ExpenseScheduleV1 = {
  version: 1,
  occurrences: [
    {
      index: 0,
      parcela: "1/2",
      valor: 4000,
      data: "2026-11-10",
      invoiceDueMonth: "2026-11",
    },
    {
      index: 1,
      parcela: "2/2",
      valor: 6001,
      data: "2027-01-12",
      invoiceDueMonth: "2027-01",
    },
  ],
};

const input: InstallmentInput = {
  valorTotal: 10001,
  formaPagamento: PaymentForm.PARCELADO,
  quantidadeParcela: 2,
  dataInicioParcela: new Date("2026-11-10T00:00:00.000Z"),
  schedule,
};

describe("documented Maria CSV installment schedule", () => {
  it("preserves each irregular cent amount, label, date, and invoice cycle", () => {
    expect(buildInstallments(input)).toEqual([
      {
        index: 0,
        parcela: "1/2",
        valor: 4000,
        data: new Date("2026-11-10T00:00:00.000Z"),
        invoiceDueMonth: "2026-11",
      },
      {
        index: 1,
        parcela: "2/2",
        valor: 6001,
        data: new Date("2027-01-12T00:00:00.000Z"),
        invoiceDueMonth: "2027-01",
      },
    ]);
  });

  it.each([
    { valorTotal: 10000 },
    { valorTotal: 10002 },
    { quantidadeParcela: 1 },
    { quantidadeParcela: 3 },
  ])("rejects a schedule/expense mismatch: %j", (mismatch) => {
    expect(() => buildInstallments({ ...input, ...mismatch })).toThrow(
      RangeError,
    );
  });
});
