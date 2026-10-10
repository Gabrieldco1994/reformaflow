import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Contrato de UI (componente real + API stubada, NÃO é QA de backend) do fallback SEM o
 * sinal `expenseIsCredit` (campo opcional/compat): a identidade da raiz é lida do
 * GET /projects/:owner/expenses/:id sob demanda (intenção = hover/foco/"Mais ações").
 * Esta concorrência (GET lento, 503, corpo vazio) é reproduzível de forma determinística
 * com o stub. Prova, a 375/390/1280:
 *  - o alvo de "Mais ações" (≥44×44, elementFromPoint) NÃO se move nem é coberto quando o
 *    estado "Verificando ações"/erro aparece — o primeiro toque ainda abre o sheet;
 *  - "Tentar novamente" (≥44px de altura) segue clicável e refaz o GET;
 *  - as ações do sheet não se duplicam e ficam restritas enquanto a raiz é desconhecida;
 *  - sem overflow horizontal e valor monetário nowrap em linha única.
 */

const projectId = "movrow-unknown-root";
const EXPENSE_ID = "unk-1";
const WIDTHS = [375, 390, 1280] as const;
const SIX_DIGIT_CENTS = 12_345_678;
const DETAIL_PATH = `/projects/${projectId}/expenses/${EXPENSE_ID}`;

type DetailMode = "ok-delayed" | "503" | "empty";

const saida = {
  id: EXPENSE_ID,
  kind: "saida",
  descricao: "Compra sem sinal de raiz",
  data: "2026-08-05T12:00:00.000Z",
  forma: "pix",
  valor: SIX_DIGIT_CENTS,
  realizado: false,
  status: "PLANEJADO",
  cardLast4: null,
  bankLast4: "1234",
  tipoDespesa: "MERCADO",
  isInvoice: false,
  editavel: true,
  dueMonth: null,
  projetoOrigem: null,
  foreignExpenseId: null,
  // sem `expenseIsCredit`: é exatamente o fallback sob teste
};

function json(body: unknown, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

const accountView = {
  mesSelecionado: "2026-08",
  caixaHoje: 5_000_00,
  entrouMes: 0,
  saiuMes: 0,
  faltaPagarMes: SIX_DIGIT_CENTS,
  recebimentosPrevistosMes: 0,
  sobraPrevista: 0,
  devoCartaoTotal: 0,
  cartoes: [],
  contas: [],
  saidas: [saida],
  comprasCartao: [],
  entradas: [],
  ticketMedio: { valor: 0, nCompras: 0, totalCompras: 0, serie6m: [], media6m: 0, deltaVsMediaPct: null },
};

const monthRow = {
  mes: "2026-08",
  totalDespesas: SIX_DIGIT_CENTS,
  totalRecebimentos: 0,
  despesasRealizadas: 0,
  recebimentosRealizados: 0,
  saldoMes: -SIX_DIGIT_CENTS,
  saldoMesRealizado: 0,
  porOrigem: {},
  porCategoria: [{ categoria: "Mercado", valor: SIX_DIGIT_CENTS }],
};

const monthlyOverview = {
  mesAtual: "2026-08",
  meses: [{ ...monthRow, mes: "2026-07" }, monthRow],
  comparativo: {
    current: monthRow,
    previous: null,
    deltaDespesas: 0,
    deltaDespesasPct: null,
    deltaRecebimentos: 0,
    deltaRecebimentosPct: null,
    deltaSaldo: 0,
  },
  mesAtualEntries: [],
  entries: [],
  projetos: [{ id: projectId, name: "Pessoal QA", type: "PESSOAL" }],
  cards: [],
  caixa: { hoje: 5_000_00, saldoInicial: 5_000_00, temSaldoInicial: true, porMes: [{ mes: "2026-08", caixa: 5_000_00 }] },
  projecao: {
    caixaHoje: 5_000_00,
    entrouMes: 0,
    saiuMes: SIX_DIGIT_CENTS,
    faltaPagarMes: SIX_DIGIT_CENTS,
    recebimentosPrevistosMes: 0,
    sobraPrevista: 0,
  },
};

async function mockApi(page: Page, state: { mode: DetailMode; detailRequests: number }) {
  await page.clock.setFixedTime(new Date("2026-08-12T12:00:00.000Z"));
  await page
    .context()
    .addCookies([{ name: "rf_token", value: projectId, url: `http://localhost:${process.env.PLAYWRIGHT_PORT ?? 3013}` }]);
  await page.route("http://localhost:3001/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/auth/me")
      return route.fulfill(
        json({
          id: "u",
          username: "u",
          name: "QA",
          role: "ADMIN",
          tenantId: "t",
          allowedModules: [],
          allowedProjects: [],
          allowedProjectTypes: [],
        }),
      );
    if (path === "/auth/config") return route.fulfill(json({ registerEnabled: false, guestEnabled: false }));
    if (path === "/projects") return route.fulfill(json([{ id: projectId, name: "Pessoal QA", type: "PESSOAL" }]));
    if (path === `/projects/${projectId}`)
      return route.fulfill(
        json({ id: projectId, name: "Pessoal QA", type: "PESSOAL", onboardedAt: "2026-01-01T00:00:00.000Z" }),
      );
    if (path === `/projects/${projectId}/monthly-overview`) return route.fulfill(json(monthlyOverview));
    if (path === `/projects/${projectId}/monthly-overview/dre-overview`)
      return route.fulfill(json({ anual: { saldoAcumuladoSerie: [] } }));
    if (path === `/projects/${projectId}/monthly-overview/account-view`) return route.fulfill(json(accountView));
    if (path === `/projects/${projectId}/pendencias/financeiras`) return route.fulfill(json({ total: 0, grupos: [] }));
    if (path === DETAIL_PATH) {
      state.detailRequests += 1;
      if (state.mode === "503") return route.fulfill(json({ message: "indisponível" }, 503));
      if (state.mode === "empty") return route.fulfill(json([]));
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      return route.fulfill(json({ id: EXPENSE_ID, valorTotal: SIX_DIGIT_CENTS, valor: SIX_DIGIT_CENTS }));
    }
    return route.fulfill(json([]));
  });
}

async function boxOf(locator: Locator) {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = (x: number, y: number) => {
      const h = document.elementFromPoint(x, y);
      return h === el || (h != null && el.contains(h));
    };
    return {
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      cx: r.left + r.width / 2,
      cy: r.top + r.height / 2,
      hitCenter: hit(r.left + r.width / 2, r.top + r.height / 2),
      hitCorner: hit(r.left + 2, r.top + 2),
    };
  });
}

async function expectNoOverflow(page: Page, label: string) {
  const o = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, w: window.innerWidth }));
  expect(o.s, `${label}: overflow horizontal`).toBeLessThanOrEqual(o.w);
}

async function expectMoneyIntact(row: Locator, label: string) {
  const money = row.locator("span.whitespace-nowrap").first();
  await expect(money).toContainText("123.456,78");
  const m = await money.evaluate((el) => ({
    ws: getComputedStyle(el).whiteSpace,
    h: el.getBoundingClientRect().height,
    lh: parseFloat(getComputedStyle(el).lineHeight) || 0,
  }));
  expect(m.ws, `${label}: valor nowrap`).toBe("nowrap");
  expect(m.h, `${label}: valor em uma linha`).toBeLessThan(m.lh * 1.6 + 1);
}

async function sheetActionNames(page: Page) {
  const dialog = page.locator('[data-mobile-sheet="modal"]');
  const names = await dialog.getByRole("button").evaluateAll((els) =>
    els.map((el) => (el.textContent ?? "").trim()).filter(Boolean),
  );
  return names;
}

for (const width of WIDTHS) {
  test.describe(`MovimentacaoRow raiz desconhecida @${width}px`, () => {
    test.beforeEach(({}, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "medição roda uma vez só");
    });
    test.use({ viewport: { width, height: 900 } });

    async function open(page: Page, mode: DetailMode) {
      const state = { mode, detailRequests: 0 };
      await mockApi(page, state);
      await page.goto(`/projects/${projectId}/conta`);
      const row = page.getByTestId("movimentacao-row").filter({ hasText: "Compra sem sinal de raiz" });
      await expect(row).toBeVisible();
      expect(state.detailRequests, "nenhuma leitura antes da intenção").toBe(0);
      return { row, state };
    }

    // Move o ponteiro até o alvo (intenção) e devolve a caixa ANTES/DEPOIS do estado aparecer.
    async function hoverAndMeasure(page: Page, row: Locator, target: Locator, appear: Locator) {
      await target.scrollIntoViewIfNeeded();
      const before = await boxOf(target);
      await page.mouse.move(before.cx, before.cy);
      await expect(appear).toBeVisible();
      const after = await boxOf(target);
      return { before, after };
    }

    test("GET lento: Verificando ações não move o alvo; primeiro toque abre o sheet restrito; resolve para a linha normal", async ({ page }) => {
      const { row, state } = await open(page, "ok-delayed");
      const anchor = width < 768 ? row.getByRole("button", { name: "Mais ações" }) : row.getByRole("button", { name: "Editar", exact: true });
      const { before, after } = await hoverAndMeasure(page, row, anchor, row.getByRole("status"));
      await expect(row.getByRole("status")).toHaveText("Verificando ações");
      expect(Math.abs(after.x - before.x), `${width}: alvo moveu em x`).toBeLessThanOrEqual(1);
      expect(Math.abs(after.y - before.y), `${width}: alvo moveu em y`).toBeLessThanOrEqual(1);
      expect(after.width).toBeGreaterThanOrEqual(44);
      expect(after.height).toBeGreaterThanOrEqual(44);
      expect(after.hitCenter, "centro coberto").toBe(true);
      expect(after.hitCorner, "quina coberta").toBe(true);
      await expectNoOverflow(page, `${width} verificando`);
      await expectMoneyIntact(row, `${width} verificando`);
      await expect(row.getByTestId("movimentacao-status")).toBeDisabled();

      if (width < 768) {
        // Primeiro toque nas coordenadas medidas ANTES do estado aparecer.
        await page.mouse.click(before.cx, before.cy);
        await expect(page.locator('[data-mobile-sheet="modal"]')).toBeVisible();
        const names = await sheetActionNames(page);
        expect(new Set(names).size, `ações duplicadas: ${names.join(" | ")}`).toBe(names.length);
        expect(names.filter((n) => /^Editar$/.test(n))).toHaveLength(1);
        expect(names.join("|")).not.toMatch(/Excluir|Ratear|Vincular|Quitar|Pagar|Paga/);
        await page.keyboard.press("Escape");
        await expect(page.locator('[data-mobile-sheet="modal"]')).toBeHidden();
      }

      await expect(row.getByRole("status")).toBeHidden({ timeout: 5_000 });
      expect(state.detailRequests, "uma única leitura (dedup)").toBe(1);
      await expect(row.getByTestId("movimentacao-status")).toBeEnabled();
      if (width < 768) {
        await row.getByRole("button", { name: "Mais ações" }).click();
        const names = await sheetActionNames(page);
        expect(new Set(names).size).toBe(names.length);
        expect(names.join("|")).toMatch(/Excluir/);
      }
      await expectNoOverflow(page, `${width} resolvido`);
    });

    for (const mode of ["503", "empty"] as const) {
      test(`GET ${mode}: erro visível sem mover o alvo; Mais ações e Tentar novamente seguem clicáveis; retry refaz o GET`, async ({ page }) => {
        const { row, state } = await open(page, mode);
        const anchor = width < 768 ? row.getByRole("button", { name: "Mais ações" }) : row.getByRole("button", { name: "Editar", exact: true });
        const alert = row.getByRole("alert");
        const { before, after } = await hoverAndMeasure(page, row, anchor, alert);
        await expect(alert).toContainText("Não foi possível verificar as ações");
        expect(Math.abs(after.x - before.x), `${width}: alvo moveu em x`).toBeLessThanOrEqual(1);
        expect(Math.abs(after.y - before.y), `${width}: alvo moveu em y`).toBeLessThanOrEqual(1);
        expect(after.width).toBeGreaterThanOrEqual(44);
        expect(after.height).toBeGreaterThanOrEqual(44);
        expect(after.hitCenter, "centro coberto").toBe(true);
        expect(after.hitCorner, "quina coberta").toBe(true);
        await expectNoOverflow(page, `${width} erro`);
        await expectMoneyIntact(row, `${width} erro`);
        await expect(row.getByText("Crédito", { exact: true })).toHaveCount(0);
        await expect(row.getByTestId("movimentacao-status")).toBeDisabled();

        if (width < 768) {
          await page.mouse.click(before.cx, before.cy);
          await expect(page.locator('[data-mobile-sheet="modal"]')).toBeVisible();
          const names = await sheetActionNames(page);
          expect(new Set(names).size, `ações duplicadas: ${names.join(" | ")}`).toBe(names.length);
          expect(names.join("|")).not.toMatch(/Excluir|Ratear|Vincular|Quitar|Pagar|Paga/);
          await page.keyboard.press("Escape");
          await expect(page.locator('[data-mobile-sheet="modal"]')).toBeHidden();
        }

        const retry = row.getByRole("button", { name: "Tentar novamente" });
        const rb = await boxOf(retry);
        expect(rb.height, "retry ≥44px de altura").toBeGreaterThanOrEqual(44);
        expect(rb.hitCenter, "retry coberto").toBe(true);
        const requestsBefore = state.detailRequests;
        await page.mouse.click(rb.cx, rb.cy);
        await expect.poll(() => state.detailRequests).toBeGreaterThan(requestsBefore);
        await expect(row.getByRole("alert")).toBeVisible();
        await expectNoOverflow(page, `${width} erro após retry`);

        // O backend volta: o retry seguinte recupera a linha normal.
        state.mode = "ok-delayed";
        await expect(row.getByRole("button", { name: "Tentar novamente" })).toBeVisible();
        await row.getByRole("button", { name: "Tentar novamente" }).click();
        await expect(row.getByRole("alert")).toBeHidden({ timeout: 6_000 });
        await expect(row.getByTestId("movimentacao-status")).toBeEnabled();
      });
    }
  });
}
