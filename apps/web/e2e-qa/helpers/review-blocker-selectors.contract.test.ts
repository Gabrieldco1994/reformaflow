import assert from "node:assert/strict";
import { test } from "node:test";
import {
  reviewBlockerArticleName,
  reviewBlockerButtonName,
  type ReviewBlockerPurchaseContext,
} from "./review-blocker-selectors";

const firstPurchase = {
  titulo: "Liquidificador (inox)",
  fornecedor: "Casa Norte",
  dataCompra: "2026-10-10",
  amountCents: 12_345,
  installmentCount: 1,
} satisfies ReviewBlockerPurchaseContext;

const firstContext =
  "Casa Norte — Liquidificador (inox) · 10/10/2026 · R$ 123,45 · Total · 1 parcela";

test("duplicate titles resolve to the right row and action from full human context", () => {
  const duplicateContexts = [
    {
      field: "merchant",
      purchase: { ...firstPurchase, fornecedor: "Casa Sul" },
      visibleName:
        "Casa Sul — Liquidificador (inox) · 10/10/2026 · R$ 123,45 · Total · 1 parcela",
    },
    {
      field: "date",
      purchase: { ...firstPurchase, dataCompra: "2026-10-11" },
      visibleName:
        "Casa Norte — Liquidificador (inox) · 11/10/2026 · R$ 123,45 · Total · 1 parcela",
    },
    {
      field: "amount",
      purchase: { ...firstPurchase, amountCents: 1_234_567 },
      visibleName:
        "Casa Norte — Liquidificador (inox) · 10/10/2026 · R$ 12.345,67 · Total · 1 parcela",
    },
    {
      field: "installment count",
      purchase: { ...firstPurchase, installmentCount: 2 },
      visibleName:
        "Casa Norte — Liquidificador (inox) · 10/10/2026 · R$ 123,45 · Total · 2 parcelas",
    },
  ] satisfies {
    field: string;
    purchase: ReviewBlockerPurchaseContext;
    visibleName: string;
  }[];

  for (const duplicate of duplicateContexts) {
    const articleNames = [firstContext, duplicate.visibleName];
    const buttonNames = [
      `Incluir compra ${firstContext} na revisão`,
      `Retirar compra ${firstContext} da seleção`,
      `Incluir compra ${duplicate.visibleName} na revisão`,
      `Retirar compra ${duplicate.visibleName} da seleção`,
    ];

    assert.deepEqual(
      articleNames.filter((name) =>
        reviewBlockerArticleName(firstPurchase).test(name),
      ),
      [firstContext],
      duplicate.field,
    );
    assert.deepEqual(
      buttonNames.filter((name) =>
        reviewBlockerButtonName("include", firstPurchase).test(name),
      ),
      [buttonNames[0]],
      duplicate.field,
    );
    assert.deepEqual(
      buttonNames.filter((name) =>
        reviewBlockerButtonName("remove", duplicate.purchase).test(name),
      ),
      [buttonNames[3]],
      duplicate.field,
    );
  }
});
