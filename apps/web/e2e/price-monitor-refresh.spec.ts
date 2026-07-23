import { expect, test } from "@playwright/test";

// Regressão do bug real relatado pelo PO: o botão "Atualizar" chamava
// POST /price-monitor/items/:id/refresh, mas o controller que definia essa
// rota nunca foi registrado no módulo da API (dead code desde #160) —
// 404 silencioso, toast "Falha ao atualizar preço". Corrigido nesta issue
// (a) ao mover os endpoints de refresh/history para o PriceCompareController
// que de fato está registrado. Este teste garante que não regride.

const projectId = "compra-test";
const itemId = "item-1";

function json(body: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

test("clicar em Atualizar chama o refresh real e mostra sucesso (não 404 silencioso)", async ({
  page,
}) => {
  let lastBestPriceCents = 300_000;
  let refreshCalled = false;

  await page
    .context()
    .addCookies([
      { name: "rf_token", value: "test", url: "http://localhost:3013" },
    ]);

  await page.route("http://localhost:3001/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;

    if (path === "/auth/me") {
      return route.fulfill(
        json({
          id: "user-test",
          username: "test",
          name: "Usuário Teste",
          role: "ADMIN",
          tenantId: "tenant-test",
          allowedModules: [],
          allowedProjects: [],
          allowedProjectTypes: [],
        }),
      );
    }
    if (path === "/projects" && method === "GET") {
      return route.fulfill(
        json([{ id: projectId, name: "Compra Teste", type: "COMPRA" }]),
      );
    }
    if (path === `/projects/${projectId}` && method === "GET") {
      return route.fulfill(
        json({ id: projectId, name: "Compra Teste", type: "COMPRA", rooms: [] }),
      );
    }
    if (
      path === `/projects/${projectId}/price-monitor/items` &&
      method === "GET"
    ) {
      return route.fulfill(
        json([
          {
            id: itemId,
            title: "Geladeira Frost Free",
            query: "geladeira frost free",
            productUrl: null,
            notes: null,
            referencePriceCents: 300_000,
            targetPriceCents: 250_000,
            isActive: true,
            lastBestPriceCents: refreshCalled ? 280_000 : lastBestPriceCents,
            lastBestPrice: null,
            lastBestStore: refreshCalled ? "Loja B" : "Loja A",
            lastBestLink: "https://loja.com",
            lastCheckedAt: refreshCalled ? new Date().toISOString() : null,
            monitoringEndDate: null,
            diasMonitoramento: 30,
          },
        ]),
      );
    }
    if (
      path === `/projects/${projectId}/price-monitor/items/${itemId}/refresh` &&
      method === "POST"
    ) {
      refreshCalled = true;
      return route.fulfill(
        json({
          id: itemId,
          title: "Geladeira Frost Free",
          lastBestPriceCents: 280_000,
          lastBestStore: "Loja B",
        }),
      );
    }
    if (
      path === `/projects/${projectId}/price-monitor/items/${itemId}/history` &&
      method === "GET"
    ) {
      return route.fulfill(json([]));
    }
    return route.fulfill(json([]));
  });

  await page.goto(`/projects/${projectId}/price-compare`);
  await expect(page.getByText("Geladeira Frost Free", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /^atualizar$/i }).click();

  await expect(page.getByText(/preço atualizado/i)).toBeVisible();
  await expect(page.getByText(/falha ao atualizar/i)).not.toBeVisible();
  expect(refreshCalled).toBe(true);
});
