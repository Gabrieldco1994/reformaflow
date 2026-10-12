import { expect, type Locator, type Page } from "@playwright/test";

export type ReviewBlockerAction = "include" | "remove";

function readablePurchaseTitle(title: string) {
  const normalized = title.trim().replace(/\s+/g, " ");
  if (!normalized) {
    throw new Error("Review blocker row requires a readable purchase title");
  }
  return normalized;
}

export function reviewBlockerButtonName(
  action: ReviewBlockerAction,
  purchaseTitle: string,
): RegExp {
  const title = readablePurchaseTitle(purchaseTitle);
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const actionLabel =
    action === "include"
      ? { verb: "Incluir", ending: "na revisão" }
      : { verb: "Retirar", ending: "da seleção" };

  return new RegExp(
    `^${actionLabel.verb} compra [\\s\\S]*${escapedTitle}[\\s\\S]* ${actionLabel.ending}$`,
  );
}

export async function reviewBlockerActionButton(
  page: Page,
  purchaseTitle: string,
  action: ReviewBlockerAction,
): Promise<Locator> {
  const title = readablePurchaseTitle(purchaseTitle);
  const row = page.getByRole("article", { name: title, exact: false });
  await expect(
    row,
    "The readable purchase context must identify exactly one review row",
  ).toHaveCount(1);
  await expect(row).toBeVisible();

  const name = reviewBlockerButtonName(action, title);
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
