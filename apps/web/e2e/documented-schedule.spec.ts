import "../../../scripts/test-db-env.cjs";
import { expect, test } from "@playwright/test";
import type { Expense } from "../src/types";

const projectId = "documented-schedule-web";
const purchase: Expense = {
  id: "purchase",
  projectId,
  titulo: "Compra documentada",
  tipoDespesa: "OUTROS",
  valor: 20004,
  quantidade: 1,
  valorTotal: 20004,
  formaPagamento: "PARCELADO",
  quantidadeParcela: 2,
  dataInicioParcela: "2026-08-10",
  status: "PLANEJADO",
  cardLast4: "4321",
  installmentDateOverrides: '{"0":"2026-08-25"}',
  schedule: {
    version: 1,
    occurrences: [
      {
        index: 0,
        parcela: "2/3",
        valor: 10001,
        data: "2026-08-10",
        invoiceDueMonth: "2026-11",
      },
      {
        index: 1,
        parcela: "3/3",
        valor: 10003,
        data: "2026-09-28",
        invoiceDueMonth: null,
      },
    ],
  },
};
const credit: Expense = {
  id: "credit",
  projectId,
  titulo: "Crédito documentado",
  tipoDespesa: "OUTROS",
  valor: -12345678,
  quantidade: 1,
  valorTotal: -12345678,
  formaPagamento: "A_VISTA",
  dataPagamento: "2026-09-10",
  status: "PAGO",
  cardLast4: "4321",
  schedule: {
    version: 1,
    occurrences: [
      {
        index: 0,
        parcela: null,
        valor: -12345678,
        data: "2026-09-10",
        invoiceDueMonth: "2026-11",
      },
    ],
  },
};
const json = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

for (const width of [375, 390, 1280]) {
  test(`#701 documented consumption and metadata preservation at ${width}px`, async ({
    page,
    baseURL,
  }) => {
    if (!baseURL) throw new Error("Playwright baseURL is required");
    await page.setViewportSize({ width, height: 900 });
    await page.clock.setFixedTime(new Date("2026-09-23T12:00:00.000Z"));
    await page
      .context()
      .addCookies([
        { name: "rf_token", value: "synthetic-test", url: baseURL },
      ]);
    const patches: unknown[] = [];
    const project = {
      id: projectId,
      name: "Reforma Teste",
      type: "REFORMA",
      onboardedAt: "2026-01-01T00:00:00.000Z",
      rooms: [],
    };
    await page.route("http://localhost:3001/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/auth/me")
        return route.fulfill(
          json({
            id: "synthetic-user",
            name: "Teste",
            username: "test",
            role: "ADMIN",
            tenantId: "synthetic-tenant",
            allowedModules: [],
            allowedProjects: [],
            allowedProjectTypes: [],
          }),
        );
      if (path === "/auth/config")
        return route.fulfill(
          json({ registerEnabled: false, guestEnabled: false }),
        );
      if (path === "/projects") return route.fulfill(json([project]));
      if (path === `/projects/${projectId}`)
        return route.fulfill(json(project));
      if (path === `/projects/${projectId}/expenses`)
        return route.fulfill(
          json({
            items: [purchase, credit],
            total: 2,
            page: 1,
            pageSize: 2000,
            totalPages: 1,
          }),
        );
      if (path === `/projects/${projectId}/expenses/paid-origins`)
        return route.fulfill(json({ items: [] }));
      for (const expense of [purchase, credit]) {
        if (path === `/projects/${projectId}/expenses/${expense.id}/rateio`) {
          return route.fulfill(
            json({
              sourceExpenseId: expense.id,
              rateado: false,
              totalSourceCents: expense.valorTotal,
              rateadoCents: 0,
              sobraCents: expense.valorTotal,
              items: [],
            }),
          );
        }
        if (path === `/projects/${projectId}/expenses/${expense.id}`) {
          if (route.request().method() === "PATCH")
            patches.push(route.request().postDataJSON());
          return route.fulfill(json(expense));
        }
      }
      return route.fulfill(json([]));
    });
    await page.goto(`/projects/${projectId}/expenses?period=ALL&view=general`);
    await expect(page.getByText("parcela 2/3", { exact: true })).toBeVisible();
    await expect(page.getByText("parcela 3/3", { exact: true })).toBeVisible();
    const purchaseRow = page
      .getByText("parcela 2/3", { exact: true })
      .locator("../../..");
    const lastPurchaseRow = page
      .getByText("parcela 3/3", { exact: true })
      .locator("../../..");
    await expect(purchaseRow.getByText(/R\$\s*100,01/)).toBeVisible();
    await expect(lastPurchaseRow.getByText(/R\$\s*100,03/)).toBeVisible();
    const status = purchaseRow.getByTitle(
      "Clique para alternar entre Planejado e Pago",
    );
    const statusBox = await status.boundingBox();
    expect(statusBox?.width).toBeGreaterThanOrEqual(44);
    expect(statusBox?.height).toBeGreaterThanOrEqual(44);
    await purchaseRow
      .getByRole("button", { name: "Editar completo", exact: true })
      .click();
    const form = page.locator("form").filter({
      has: page.getByRole("heading", { name: "Cronograma documentado" }),
    });
    await expect(form.getByText(/Parcela 2\/3.*25\/08\/2026/)).toBeVisible();
    await expect(
      form.getByText("Fatura 2026-11", { exact: true }),
    ).toBeVisible();
    await expect(form.getByLabel("Valor (R$)", { exact: true })).toBeDisabled();
    await expect(form.getByLabel("Quantidade", { exact: true })).toBeDisabled();
    await form
      .getByLabel("Título da Despesa", { exact: true })
      .fill("Descrição corrigida");
    const save = form.getByRole("button", { name: "Salvar", exact: true });
    const saveBox = await save.boundingBox();
    expect(saveBox?.width).toBeGreaterThanOrEqual(44);
    expect(saveBox?.height).toBeGreaterThanOrEqual(44);
    await save.click();
    await expect
      .poll(() => patches)
      .toEqual([
        {
          tipoDespesa: "OUTROS",
          categoriaMaoDeObra: null,
          roomId: null,
          titulo: "Descrição corrigida",
          fornecedor: null,
          link: null,
          imageUrl: null,
        },
      ]);
    await expect(
      page.getByRole("heading", { name: "Cronograma documentado" }),
    ).toHaveCount(0);

    const creditRow = page
      .getByText("Crédito documentado", { exact: true })
      .locator("../..");
    const edit = creditRow.getByRole("button", {
      name: "Editar completo",
      exact: true,
    });
    const box = await edit.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
    await edit.click();
    const schedule = page
      .getByRole("heading", { name: "Cronograma documentado" })
      .locator("..");
    const amount = schedule.getByText(/-R\$\s*123\.456,78/);
    await expect(amount).toBeVisible();
    expect(
      await amount.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getClientRects().length;
      }),
    ).toBe(1);
    const moneyBox = await amount.boundingBox();
    expect(moneyBox).not.toBeNull();
    expect(moneyBox!.x).toBeGreaterThanOrEqual(0);
    expect(moneyBox!.x + moneyBox!.width).toBeLessThanOrEqual(width);
    await expect(schedule.getByText(/10\/09\/2026/)).toBeVisible();
    await expect(
      schedule.getByText("Fatura 2026-11", { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  });
}
