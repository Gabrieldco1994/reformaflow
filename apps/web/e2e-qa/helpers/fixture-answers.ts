import { expect } from "@playwright/test";
import type {
  ImportSessionQuestionV1,
  ImportSessionViewV1,
} from "@reformaflow/domain";

export interface CsvExpected {
  purchases: { title: string; amountCents: number; date: string }[];
  ignoredPaymentRow: string;
  ignoredPaymentAmountCents: number;
  declarations: {
    invoiceDueMonth: string;
    amountMeaning: string;
    installmentCount: number;
    firstDueDate: string;
    decision: string;
    purpose: string;
  };
}

export function csvFixtureAnswers(expected: CsvExpected) {
  expect(expected.declarations.amountMeaning).toBe("TOTAL_PURCHASE");
  expect(expected.declarations.installmentCount).toBe(1);
  expect(expected.declarations.decision).toBe("CREATE_NEW");
  expect(expected.declarations.purpose).toBe(
    "Personal purchase; no cross-project allocation",
  );
  expect(expected.declarations.firstDueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(expected.declarations.firstDueDate.slice(0, 7)).toBe(
    expected.declarations.invoiceDueMonth,
  );
  expect(new Set(expected.purchases.map((p) => p.title)).size).toBe(
    expected.purchases.length,
  );
  for (const purchase of expected.purchases) {
    expect(Number.isSafeInteger(purchase.amountCents)).toBe(true);
    expect(purchase.amountCents).toBeGreaterThan(0);
    expect(purchase.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  }
  const dateLiteral = (date: string) => date.split("-").reverse().join("/");
  const fixed: Record<string, string> = {
    amountMeaning: "total da compra",
    installmentCount: String(expected.declarations.installmentCount),
    // All purchases are explicitly non-installment (count=1), so their sole occurrence is 1.
    installmentIndex: String(expected.declarations.installmentCount),
    firstDueDate: dateLiteral(expected.declarations.firstDueDate),
    targets: "sem rateio",
    decision: "criar compra nova",
    // Retained existing user choice; not inferred from the merchant name.
    tipoDespesa: "OUTROS",
  };
  return (
    question: ImportSessionQuestionV1,
    current: ImportSessionViewV1,
    selectedIds: readonly string[],
  ) => {
    expect(
      question.lineIds.length,
      "Question must identify fixture purchases",
    ).toBeGreaterThan(0);
    const purchases = question.lineIds.map((id) => {
      expect(
        selectedIds,
        `Question line ${id} must belong to the explicit selected subset`,
      ).toContain(id);
      const lines = current.lines.filter((line) => line.id === id);
      expect(lines, `Question line ${id} must resolve uniquely`).toHaveLength(
        1,
      );
      const matches = expected.purchases.filter(
        (p) => p.title === lines[0].titulo,
      );
      expect(
        matches,
        `Question line ${id} must match exactly one expected.csv purchase title`,
      ).toHaveLength(1);
      return matches[0];
    });
    const perPurchase: Record<
      string,
      (purchase: CsvExpected["purchases"][number]) => string
    > = {
      amountCents: (purchase) => {
        // Integer cents only: no floating-point conversion, rounding or batch sum.
        const cents = String(purchase.amountCents).padStart(3, "0");
        return `${cents.slice(0, -2)},${cents.slice(-2)}`;
      },
      dataCompra: (purchase) => dateLiteral(purchase.date),
      merchant: (purchase) => purchase.title,
    };
    const derive = perPurchase[question.field];
    if (derive) {
      const values = purchases.map(derive);
      expect(
        new Set(values).size,
        `Cannot answer different ${question.field} values with a single literal`,
      ).toBe(1);
      return values[0];
    }
    const answer = fixed[question.field];
    expect(
      answer,
      `Unexpected fixture question ${question.field}; do not invent documentary facts`,
    ).toBeTruthy();
    return answer;
  };
}
