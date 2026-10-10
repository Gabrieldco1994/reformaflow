import { expect, test, type Page } from "@playwright/test";
import { FIXTURE_INSTANT, summaryFixture, viewFixture } from "../src/app/projects/[projectId]/maria/_lib/import-session-fixtures";

/**
 * Contrato de UI (componente real + API stubada — NÃO é a jornada real nem QA de backend) do FOCO de
 * teclado na retomada de importações da Maria: toda transição intencional (Enter na linha, Cancelar,
 * Manter, Sim/erro, Voltar) deixa o foco em um alvo útil dentro do diálogo — nunca em <body> —, a
 * confirmação destrutiva não foca "Sim, cancelar", o Tab continua preso e Esc devolve o foco à entrada.
 */

const projectId = "maria-import-focus";
const WIDTHS = [375, 390, 1280] as const;
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const active = summaryFixture({ id: "sess-a", cardId: "card-qa", ownerProjectId: projectId });

const monthRow = {
  mes: "2026-09",
  totalDespesas: 0,
  totalRecebimentos: 0,
  despesasRealizadas: 0,
  recebimentosRealizados: 0,
  saldoMes: 0,
  saldoMesRealizado: 0,
  porOrigem: {},
  porCategoria: [],
};
const monthlyOverview = {
  mesAtual: "2026-09",
  meses: [monthRow],
  comparativo: { current: monthRow, previous: null, deltaDespesas: 0, deltaDespesasPct: null, deltaRecebimentos: 0, deltaRecebimentosPct: null, deltaSaldo: 0 },
  mesAtualEntries: [],
  entries: [],
  projetos: [{ id: projectId, name: "Pessoal QA", type: "PESSOAL" }],
  cards: [],
  caixa: { hoje: 0, saldoInicial: 0, temSaldoInicial: true, porMes: [{ mes: "2026-09", caixa: 0 }] },
  projecao: { caixaHoje: 0, entrouMes: 0, saiuMes: 0, faltaPagarMes: 0, recebimentosPrevistosMes: 0, sobraPrevista: 0 },
};

async function mockApi(page: Page, cancelStatus: number) {
  await page.clock.setFixedTime(new Date(FIXTURE_INSTANT));
  await page.context().addCookies([{ name: "rf_token", value: "maria-import-focus", url: `http://localhost:${process.env.PLAYWRIGHT_PORT ?? 3013}` }]);
  await page.route("http://localhost:3001/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path === "/auth/me")
      return route.fulfill(
        json({ id: "maria-focus-user", username: "maria-focus", name: "QA Foco", role: "ADMIN", tenantId: "maria-focus-tenant", allowedModules: [], allowedProjects: [], allowedProjectTypes: [] }),
      );
    if (path === "/auth/config") return route.fulfill(json({ registerEnabled: false, guestEnabled: false }));
    if (path === "/projects") return route.fulfill(json([{ id: projectId, name: "Pessoal QA", type: "PESSOAL" }]));
    if (path === `/projects/${projectId}`) return route.fulfill(json({ id: projectId, name: "Pessoal QA", type: "PESSOAL", onboardedAt: "2026-01-01T00:00:00.000Z" }));
    if (path === `/projects/${projectId}/monthly-overview`) return route.fulfill(json(monthlyOverview));
    if (path === "/tenant/credit-cards") return route.fulfill(json([{ id: "card-qa", nickname: "Cartão QA", last4: "9911", project: { id: projectId, name: "Pessoal QA" } }]));
    if (path === "/import-sessions") return route.fulfill(json({ items: [active], nextCursor: null }));
    if (path === "/import-sessions/sess-a" && req.method() === "GET") return route.fulfill(json(viewFixture({ id: "sess-a", ownerProjectId: projectId, cardId: "card-qa" })));
    if (path === "/import-sessions/sess-a/cancel" && req.method() === "POST") {
      if (cancelStatus !== 200) return route.fulfill(json({ statusCode: cancelStatus, message: "erro" }, cancelStatus));
      return route.fulfill(json(viewFixture({ id: "sess-a", state: "CANCELLED", revision: 4, actions: [] })));
    }
    return route.fulfill(json([]));
  });
}

/** Where focus is, and whether it is usable: inside the dialog, ≥44px, and the centre is hit-testable. */
async function focusInfo(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector('[role="dialog"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      tag: el.tagName,
      text: (el.textContent ?? "").trim().slice(0, 60),
      testId: el.getAttribute("data-testid"),
      inDialog: !!dialog && dialog.contains(el),
      width: r.width,
      height: r.height,
      hit: hit === el || (hit != null && el.contains(hit)),
      rect: { top: r.top, bottom: r.bottom, left: r.left, right: r.right, vh: window.innerHeight },
      hitTag: hit ? `${hit.tagName}:${(hit.textContent ?? "").trim().slice(0, 30)}` : null,
    };
  });
}

async function expectFocus(page: Page, label: string, match: { tag?: string; text?: RegExp; testId?: string }) {
  await expect
    .poll(async () => {
      const f = await focusInfo(page);
      return !!f && f.tag !== "BODY" && f.inDialog && (!match.tag || f.tag === match.tag) && (!match.text || match.text.test(f.text)) && (!match.testId || f.testId === match.testId);
    }, { message: label, timeout: 5_000 })
    .toBe(true);
  // The sheet slides in: wait for the focused control to settle inside the viewport before measuring.
  await expect.poll(async () => (await focusInfo(page))?.hit, { message: `${label}: hit-test`, timeout: 5_000 }).toBe(true);
  return (await focusInfo(page))!;
}

for (const width of WIDTHS) {
  for (const cancelStatus of [200, 500]) {
    test(`foco por teclado @${width}px (cancelamento ${cancelStatus === 200 ? "ok" : "com erro"})`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "medição roda uma vez só");
      await page.setViewportSize({ width, height: 900 });
      await mockApi(page, cancelStatus);
      await page.goto(`/projects/${projectId}/maria`);
      const entry = page.getByRole("button", { name: "Importações da Maria" });
      await entry.click();
      const dialog = page.getByRole("dialog", { name: "Importações da Maria" });
      const row = dialog.getByTestId("import-session-row");
      await expect(row).toBeVisible();

      // lista → detalhe (Enter na linha)
      await row.focus();
      await page.keyboard.press("Enter");
      await expect(dialog.getByRole("heading", { name: /Rascunho guardado/ })).toBeVisible();
      const voltar = await expectFocus(page, "detalhe: foco na nova vista", { tag: "BUTTON", text: /Voltar/ });
      expect(voltar.height).toBeGreaterThanOrEqual(44);
      expect(voltar.hit, JSON.stringify(voltar)).toBe(true);

      // Tab continua preso ao diálogo
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press("Tab");
        expect((await focusInfo(page))?.inDialog, `Tab ${i + 1} dentro do diálogo`).toBe(true);
      }

      // detalhe → confirmação: foco na confirmação, nunca em "Sim, cancelar"
      await dialog.getByRole("button", { name: "Cancelar importação" }).focus();
      await page.keyboard.press("Enter");
      const confirm = await expectFocus(page, "confirmação", { text: /não cria lançamentos/ });
      expect(confirm.text).not.toMatch(/^Sim, cancelar/);
      await page.keyboard.press("Tab");
      await expectFocus(page, "Tab da confirmação → Manter", { tag: "BUTTON", text: /Manter importação/ });

      // Manter → volta ao controle que abriu a confirmação
      await page.keyboard.press("Enter");
      const cancelBtn = await expectFocus(page, "Manter → Cancelar importação", { tag: "BUTTON", text: /Cancelar importação/ });
      expect(cancelBtn.height).toBeGreaterThanOrEqual(44);
      expect(cancelBtn.hit).toBe(true);

      // confirmar cancelamento: resultado (sucesso ou erro) recebe o foco
      await page.keyboard.press("Enter");
      await dialog.getByRole("button", { name: "Sim, cancelar" }).focus();
      await page.keyboard.press("Enter");
      const outcome = await expectFocus(page, "resultado do cancelamento", { text: cancelStatus === 200 ? /Importação cancelada/ : /Não foi possível|indisponível|erro/i });
      expect(outcome.inDialog).toBe(true);

      // Voltar → lista: foco na linha aberta
      await dialog.getByRole("button", { name: "Voltar" }).focus();
      await page.keyboard.press("Enter");
      await expectFocus(page, "Voltar → linha", { tag: "BUTTON", testId: "import-session-row" });

      // Esc fecha e devolve o foco à entrada
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(entry).toBeFocused();

      const overflow = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
      expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.innerWidth);
      await testInfo.attach(`focus-${width}-${cancelStatus}`, { body: JSON.stringify({ width, cancelStatus, voltar, confirm, cancelBtn, outcome }, null, 2), contentType: "application/json" });
    });
  }
}
