import { describe, expect, it } from "vitest";
import { buildInstallments, PaymentForm } from "../src";

const utc = (year: number, month: number, day: number) =>
  new Date(Date.UTC(year, month - 1, day));

describe("documented Maria CSV installment schedule", () => {
  it("preserves each irregular cent amount, label, date, and invoice cycle", () => {
    const documentedSchedule = [
      {
        parcela: "1/2",
        valor: 4000,
        data: utc(2026, 11, 10),
        invoiceDueMonth: "2026-11",
      },
      {
        parcela: "2/2",
        valor: 6001,
        data: utc(2027, 1, 12),
        invoiceDueMonth: "2027-01",
      },
    ];

    // Keep the agreed CSV schedule shape in the fixture while invoking the
    // baseline public function. On main, buildInstallments accepts the
    // ordinary fields but ignores documentedSchedule; the assertion therefore
    // fails on the returned data instead of failing module/type resolution.
    const input = {
      valorTotal: 10001,
      formaPagamento: PaymentForm.PARCELADO,
      quantidadeParcela: 2,
      dataInicioParcela: utc(2026, 11, 10),
      documentedSchedule,
    };

    expect(buildInstallments(input)).toEqual(documentedSchedule);
  });
});
