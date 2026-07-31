import { expect, test, type Page } from "@playwright/test";

/**
 * REGRESSÃO DE ÁRVORE, não de componente.
 *
 * `ExpenseMobileFab.test.tsx` (unitário) passava com o bug ativo: o componente
 * em isolamento sempre esteve correto. O que quebrava era a POSIÇÃO dele na
 * árvore — em PESSOAL o `ExpensesView` é renderizado dentro de
 * `hidden lg:block` (só-desktop) enquanto o FAB é `md:hidden` (só-mobile),
 * então a caixa nunca nascia: `getBoundingClientRect()` = 0×0 nos QUATRO
 * valores, que significa caixa NÃO GERADA — diferente de `visibility:hidden`
 * ou `opacity:0`, que produzem rect não-zero.
 *
 * Só um teste de runtime, na árvore real, pega isso. Precedente no repo:
 * `journey-markers-runtime.spec.ts`.
 */

const projectId = "fab-test";
const FAB = 'button[aria-label="Nova despesa"]';

function json(body: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

async function openExpenses(page: Page, type: "PESSOAL" | "REFORMA") {
  await page.setViewportSize({ width: 375, height: 812 });
  await page
    .context()
    .addCookies([
      { name: "rf_token", value: "test", url: "http://localhost:3013" },
    ]);

  await page.route("http://localhost:3001/**", async (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/auth/me")
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
    if (path === "/auth/config")
      return route.fulfill(
        json({ registerEnabled: false, guestEnabled: false }),
      );
    if (path === `/projects/${projectId}`)
      return route.fulfill(
        json({
          id: projectId,
          name: "Projeto Teste",
          type,
          // Sem `onboardedAt` o AppShell manda para o wizard de onboarding e a
          // tela de despesas nunca renderiza.
          onboardedAt: "2026-01-01T00:00:00.000Z",
          rooms: [],
        }),
      );
    if (path === "/projects")
      return route.fulfill(
        json([{ id: projectId, name: "Projeto Teste", type }]),
      );
    if (path === `/projects/${projectId}/expenses`)
      return route.fulfill(
        json({ items: [], total: 0, page: 1, pageSize: 2000, totalPages: 1 }),
      );

    // Lista vazia basta para o resto: o alvo aqui é a ÁRVORE, não o dado.
    return route.fulfill(json([]));
  });

  await page.goto(`/projects/${projectId}/expenses`);
}

test.describe("FAB mobile de Despesas — caixa real na árvore", () => {
  test("REFORMA em 375px: FAB tem caixa não-zero e alvo de toque >=44px", async ({
    page,
  }) => {
    await openExpenses(page, "REFORMA");

    const fab = page.locator(FAB);
    await expect(fab).toBeVisible();

    const box = await fab.boundingBox();
    expect(box).not.toBeNull();
    // O bug era rect 0x0 — `toBeVisible` sozinho não bastaria como asserção.
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);

    // Clicável de verdade: nada por cima interceptando o ponto central.
    await fab.click({ timeout: 5000 });
  });

  test("PESSOAL em 375px: FAB ausente — a superfície mobile é outra", async ({
    page,
  }) => {
    await openExpenses(page, "PESSOAL");

    // Em PESSOAL o FAB não deve nem existir no DOM. Renderizá-lo com caixa 0x0
    // (o estado anterior) é pior que não renderizar: vira alvo fantasma para
    // teste automatizado e para leitor de tela.
    await expect(page.locator(FAB)).toHaveCount(0);

    // E a tela segue de pé (não ficou em branco ao remover o FAB).
    await expect(page.locator("main")).toBeVisible();
  });
});
