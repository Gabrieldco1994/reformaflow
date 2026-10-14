import { expect, type Locator, type Page } from "@playwright/test";
import {
  ImportSessionAmountMeaning,
  type ImportSessionDraftLineV1,
} from "@reformaflow/domain";

export type ReviewBlockerAction = "include" | "remove";
export type ReviewBlockerPurchaseContext = Pick<
  ImportSessionDraftLineV1,
  | "titulo"
  | "fornecedor"
  | "dataCompra"
  | "amountCents"
  | "amountMeaning"
  | "installmentCount"
>;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textToken(value: string) {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized ? escapeRegExp(normalized) : null;
}

function dateToken(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  return `(?:${day}\\D+${month}\\D+${year}|${year}\\D+${month}\\D+${day})`;
}

function amountToken(cents: number) {
  if (!Number.isSafeInteger(cents)) {
    throw new Error("Review blocker amount must be an integer number of cents");
  }
  const digits = String(Math.abs(cents)).padStart(3, "0");
  const whole = digits.slice(0, -2);
  const fraction = digits.slice(-2);
  const groupedWhole = [...whole]
    .map(escapeRegExp)
    .join("[\\s.\\u00a0\\u202f]*");
  const sign = cents < 0 ? "[-−]\\s*" : "";
  return `${sign}R\\$\\s*${groupedWhole}[,.]${fraction}`;
}

function amountMeaningToken(
  meaning: ReviewBlockerPurchaseContext["amountMeaning"],
) {
  switch (meaning) {
    case ImportSessionAmountMeaning.TOTAL_PURCHASE:
      return "Total";
    case ImportSessionAmountMeaning.INSTALLMENT_CHARGE:
      return "Parcela";
    case ImportSessionAmountMeaning.UNKNOWN:
    default:
      return "Valor";
  }
}

function installmentToken(count: number) {
  if (!Number.isSafeInteger(count)) {
    throw new Error("Review blocker installment count must be an integer");
  }
  return `\\b${count}\\s+parcelas?\\b`;
}

function humanContextAssertions(context: ReviewBlockerPurchaseContext) {
  const title = textToken(context.titulo);
  const merchant = context.fornecedor ? textToken(context.fornecedor) : null;
  const tokens = [...new Set([merchant, title].filter((token) => token))];
  if (tokens.length === 0) tokens.push("Compra");

  if (context.dataCompra) {
    const date = dateToken(context.dataCompra);
    if (date) tokens.push(date);
  }
  if (context.amountCents !== null) {
    tokens.push(amountToken(context.amountCents));
    tokens.push(escapeRegExp(amountMeaningToken(context.amountMeaning)));
  }
  if (context.installmentCount !== null) {
    tokens.push(installmentToken(context.installmentCount));
  }

  return tokens.map((token) => `(?=[\\s\\S]*${token})`).join("");
}

export function reviewBlockerArticleName(
  context: ReviewBlockerPurchaseContext,
): RegExp {
  return new RegExp(`^${humanContextAssertions(context)}[\\s\\S]*$`);
}

export function reviewBlockerButtonName(
  action: ReviewBlockerAction,
  context: ReviewBlockerPurchaseContext,
): RegExp {
  const actionLabel =
    action === "include"
      ? { verb: "Incluir", ending: "na revisão" }
      : { verb: "Retirar", ending: "da seleção" };

  return new RegExp(
    `^${actionLabel.verb} compra ${humanContextAssertions(context)}[\\s\\S]* ${actionLabel.ending}$`,
  );
}

export async function reviewBlockerActionButton(
  page: Page,
  context: ReviewBlockerPurchaseContext,
  action: ReviewBlockerAction,
): Promise<Locator> {
  const row = page.getByRole("article", {
    name: reviewBlockerArticleName(context),
    exact: true,
  });
  await expect(
    row,
    "The full human purchase context must identify exactly one review row",
  ).toHaveCount(1);
  await expect(row).toBeVisible();

  const name = reviewBlockerButtonName(action, context);
  const button = row.getByRole("button", { name, exact: true });
  await expect(
    button,
    "The row action must be uniquely named with its readable purchase context",
  ).toHaveCount(1);
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
  await expect(button).toHaveAccessibleName(name);
  return button;
}
