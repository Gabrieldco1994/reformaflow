import { describe, expect, it } from "vitest";
import { ImportSessionAmountMeaning, parseImportFocusedLiteral } from "../src";

describe("deterministic focused import literals", () => {
  it.each([
    ["amountCents", "o valor é R$ 206,96", 20696],
    ["installmentCount", "foram 3 parcelas", 3],
    ["dataCompra", "a compra foi em 10/10/2026", "2026-10-10"],
    ["firstDueDate", "vence em 2026-11-05", "2026-11-05"],
    [
      "amountMeaning",
      "esse é o total da compra",
      ImportSessionAmountMeaning.TOTAL_PURCHASE,
    ],
    [
      "amountMeaning",
      "esse é o valor da parcela",
      ImportSessionAmountMeaning.INSTALLMENT_CHARGE,
    ],
  ] as const)(
    "parses one whole-literal %s candidate",
    (field, literal, value) => {
      expect(parseImportFocusedLiteral(field, literal)).toEqual(value);
    },
  );

  it.each([
    ["amountCents", "R$ 10,00 ou R$ 20,00"],
    ["amountCents", "R$ 0,00"],
    ["amountCents", "-10,00"],
    ["amountCents", "  -10,00  "],
    ["amountCents", "R$ -10,00"],
    ["amountCents", "R$   -10,00"],
    ["installmentCount", "3 ou 4 parcelas"],
    ["installmentCount", "-3 parcelas"],
    ["installmentCount", "  -3 parcelas  "],
    ["installmentCount", "25 parcelas"],
    ["dataCompra", "10/10/2026 ou 11/10/2026"],
    ["firstDueDate", "2026-02-30"],
    ["amountMeaning", "total ou valor da parcela"],
    ["amountMeaning", "mensal"],
  ] as const)(
    "rejects ambiguous or invalid whole-literal %s",
    (field, literal) => {
      expect(parseImportFocusedLiteral(field, literal)).toBeNull();
    },
  );
});
