import { test, expect, type Page, type ViewportSize } from "@playwright/test";

const projectId = "pessoal-test";
const expenses = [
  {
    id: "card-paid",
    projectId,
    tipoDespesa: "MERCADO",
    titulo: "Compra no cartão",
    valor: 12990,
    quantidade: 1,
    valorTotal: 12990,
    formaPagamento: "CARTAO_CREDITO",
    cardLast4: "4242",
    dataPagamento: "2026-07-05T12:00:00.000Z",
    dataCompra: "2026-07-05T12:00:00.000Z",
    status: "PAGO",
  },
  {
    id: "account-paid",
    projectId,
    tipoDespesa: "MORADIA",
    titulo: "Conta paga à vista",
    valor: 4500,
    quantidade: 1,
    valorTotal: 4500,
    formaPagamento: "PIX",
    bankLast4: "0001",
    dataPagamento: "2026-07-10T12:00:00.000Z",
    dataCompra: "2026-07-10T12:00:00.000Z",
    status: "PAGO",
  },
  {
    id: "planned",
    projectId,
    tipoDespesa: "LAZER",
    titulo: "Plano de viagem",
    valor: 30000,
    quantidade: 1,
    valorTotal: 30000,
    formaPagamento: "A_VISTA",
    dataPagamento: "2026-07-20T12:00:00.000Z",
    status: "PLANEJADO",
    paidParcelas: null,
  },
];

function json(body: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

async function openExpenses(page: Page, viewport: ViewportSize) {
  await page.setViewportSize(viewport);
  await page
    .context()
    .addCookies([
      { name: "rf_token", value: "test", url: "http://localhost:3013" },
    ]);
  await page.route("http://localhost:3001/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/auth/me")
      return route.fulfill(
        json({
          id: "user-test",
          username: "test",
          name: "Usuário Teste",
          role: "OWNER",
          tenantId: "tenant-test",
          allowedModules: [],
          allowedProjects: [],
          allowedProjectTypes: [],
        }),
      );
    if (path === `/projects/${projectId}/expenses/cross-project`)
      return route.fulfill(json([]));
    if (path === `/projects/${projectId}/expenses/planned`)
      return route.fulfill(
        json(expenses.filter((expense) => expense.status === "PLANEJADO")),
      );
    if (path === `/projects/${projectId}/expenses`)
      return route.fulfill(
        json({
          items: expenses,
          total: expenses.length,
          page: 1,
          pageSize: 2000,
          totalPages: 1,
        }),
      );
    if (path === `/projects/${projectId}`)
      return route.fulfill(
        json({
          id: projectId,
          name: "Pessoal Teste",
          type: "PESSOAL",
          rooms: [],
        }),
      );
    if (path === "/tenant/credit-cards")
      return route.fulfill(
        json([
          {
            id: "card-1",
            last4: "4242",
            nickname: "Teste",
            brand: "VISA",
            closingDay: 10,
            dueDay: 17,
          },
        ]),
      );
    if (path === "/tenant/bank-accounts")
      return route.fulfill(
        json([
          {
            id: "account-1",
            last4: "0001",
            nickname: "Conta Teste",
            institution: "Banco Teste",
          },
        ]),
      );
    if (path === "/projects")
      return route.fulfill(
        json([{ id: projectId, name: "Pessoal Teste", type: "PESSOAL" }]),
      );
    if (path === `/projects/${projectId}/category-budgets`)
      return route.fulfill(json([]));
    return route.fulfill(json([]));
  });
  await page.goto(`/projects/${projectId}/expenses?period=ALL&view=general`);
  await expect(page.getByRole("heading", { name: "Despesas" })).toBeVisible();
  await expect(
    page.getByText("Compra no cartão", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Plano de viagem", { exact: true }),
  ).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page) {
  const { clientWidth, scrollWidth } = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
}

test.describe("Expenses — phase-AB mobile quick wins", () => {
  for (const viewport of [
    { width: 360, height: 800 },
    { width: 390, height: 844 },
    { width: 402, height: 840 },
  ]) {
    test(`mobile ${viewport.width}x${viewport.height}`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "desktop",
        "viewports are explicitly owned by this spec",
      );
      await openExpenses(page, viewport);
      await expectNoHorizontalOverflow(page);
      const cta = page.getByRole("button", {
        name: "Nova despesa",
        exact: true,
      });
      await expect(cta).toHaveCount(1);
      const ctaBox = await cta.boundingBox();
      expect(ctaBox?.width).toBe(56);
      expect(ctaBox?.height).toBe(56);
      expect(await cta.evaluate((el) => getComputedStyle(el).position)).toBe(
        "fixed",
      );

      const filterTrigger = page.getByRole("button", { name: /Filtrar/ });
      await expect(filterTrigger).toBeVisible();
      const triggerStyle = await filterTrigger.evaluate((el) => {
        const style = getComputedStyle(el);
        return {
          height: el.getBoundingClientRect().height,
          fontSize: parseFloat(style.fontSize),
        };
      });
      expect(triggerStyle.height).toBeGreaterThanOrEqual(44);
      expect(triggerStyle.fontSize).toBeGreaterThanOrEqual(14);
      await expect(
        page.getByRole("article", { name: "No cartão" }),
      ).toBeVisible();
      await expect(
        page.getByRole("article", { name: "Na conta" }),
      ).toBeVisible();

      await filterTrigger.click();
      const sheet = page.getByRole("dialog", { name: "Filtros de despesas" });
      await expect(sheet).toBeVisible();
      expect(
        await sheet
          .getByLabel("Buscar despesas")
          .evaluate((el) => el.getBoundingClientRect().height),
      ).toBeGreaterThanOrEqual(44);
      await page.keyboard.press("Escape");
      await expect(sheet).toBeHidden();

      await cta.click();
      await expect(
        page.getByText("Despesa paga", { exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: /^Planejar/ }).click();
      await expect(page.getByRole("spinbutton").first()).toBeVisible();
      await expect(page.getByRole("button", { name: "Avançar" })).toBeVisible();
    });
  }

  test("desktop 1280x800", async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "viewport is explicitly owned by this spec",
    );
    await openExpenses(page, { width: 1280, height: 800 });
    await expectNoHorizontalOverflow(page);
    await expect(
      page.getByRole("button", { name: "Nova despesa", exact: true }),
    ).toHaveCount(1);
    await expect(page.getByRole("button", { name: /Filtrar/ })).toBeHidden();
    await expect(page.getByPlaceholder("Buscar despesas...")).toBeVisible();
    await expect(page.getByRole("button", { name: "Filtros" })).toBeVisible();
    const desktopCta = page.getByRole("button", {
      name: "Nova despesa",
      exact: true,
    });
    expect(
      await desktopCta.evaluate((el) => getComputedStyle(el).position),
    ).not.toBe("fixed");
  });
});
