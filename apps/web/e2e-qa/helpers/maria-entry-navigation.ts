import { expect, type Locator, type Page } from "@playwright/test";

export async function gotoValidatedMariaHref(
  page: Page,
  maria: Locator,
  expectedHref: string,
) {
  await expect(maria).toHaveAttribute("href", expectedHref);
  const href = await maria.getAttribute("href");
  expect(href).toBe(expectedHref);
  await page.goto(href!);
}

export async function waitForMariaEntryButton(page: Page, buttonName: string) {
  await expect(
    page.getByRole("heading", { name: "Maria", exact: true, level: 1 }),
  ).toBeVisible();
  const cta = page.getByRole("button", {
    name: buttonName,
    exact: true,
  });
  await expect(cta).toHaveCount(1);
  await expect(cta).toBeVisible();
  return cta;
}
