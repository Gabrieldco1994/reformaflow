import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewBlockerButtonName } from "./review-blocker-selectors";

test("review actions require the human-readable purchase context", () => {
  const title = "Parafuso (inox) + arruela";
  const context = `Compra de materiais: ${title}`;

  assert.equal(
    reviewBlockerButtonName("include", title).test(
      `Incluir compra ${context} na revisão`,
    ),
    true,
  );
  assert.equal(
    reviewBlockerButtonName("include", title).test(
      "Incluir compra uma compra sem o título na revisão",
    ),
    false,
  );
  assert.equal(
    reviewBlockerButtonName("remove", title).test(
      `Retirar compra ${context} da seleção`,
    ),
    true,
  );
  assert.equal(
    reviewBlockerButtonName("remove", title).test(
      "Retirar compra uma compra sem o título da seleção",
    ),
    false,
  );
});

test("purchase title punctuation is literal and blank context fails closed", () => {
  const title = "Arruela (inox) + porca";
  const includeName = reviewBlockerButtonName("include", title);

  assert.equal(
    includeName.test(
      `Incluir compra Material — ${title} · R$ 10,00 na revisão`,
    ),
    true,
  );
  assert.throws(() => reviewBlockerButtonName("include", "  \n  "), {
    message: "Review blocker row requires a readable purchase title",
  });
});
