import { expect, test, type Page, type ViewportSize } from "@playwright/test";

const projectId = "pessoal-test";

const entries = [
  {
    id: "expense-paid",
    data: "2026-07-05T12:00:00.000Z",
    tipo: "DESPESA",
    status: "PAGO",
    valor: 129_901,
    categoria: "Mercado",
    subcategoria: null,
    formaPagamento: "CARTAO_CREDITO",
    projectId,
    projectName: "Pessoal Teste",
    projectType: "PESSOAL",
    cardLast4: "4242",
    isNeutral: false,
    isNeutralConsumo: false,
    isEspelho: false,
  },
  {
    id: "receipt-paid",
    data: "2026-07-03T12:00:00.000Z",
    tipo: "RECEBIMENTO",
    status: "EM_CAIXA",
    valor: 500_025,
    categoria: "Salário",
    subcategoria: null,
    formaPagamento: "PIX",
    projectId,
    projectName: "Pessoal Teste",
    projectType: "PESSOAL",
    bankLast4: "0001",
    isNeutral: false,
    isNeutralConsumo: false,
    isEspelho: false,
  },
  {
    id: "expense-planned",
    data: "2026-07-25T12:00:00.000Z",
    tipo: "DESPESA",
    status: "PLANEJADO",
    valor: 75_007,
    categoria: "Moradia",
    subcategoria: null,
    formaPagamento: "PIX",
    projectId,
    projectName: "Pessoal Teste",
    projectType: "PESSOAL",
    isNeutral: false,
    isNeutralConsumo: false,
    isEspelho: false,
  },
];

const monthRow = {
  mes: "2026-07",
  totalDespesas: 204_908,
  totalRecebimentos: 500_025,
  despesasRealizadas: 129_901,
  recebimentosRealizados: 500_025,
  saldoMes: 295_117,
  saldoMesRealizado: 370_124,
  porOrigem: {},
  porCategoria: [{ categoria: "Mercado", valor: 129_901 }],
};

const overview = {
  mesAtual: "2026-07",
  meses: [
    { ...monthRow, mes: "2026-06", saldoMes: 0, saldoMesRealizado: 0 },
    monthRow,
    { ...monthRow, mes: "2026-08", saldoMes: -75_007, saldoMesRealizado: 0 },
  ],
  comparativo: {
    current: monthRow,
    previous: null,
    deltaDespesas: 0,
    deltaDespesasPct: null,
    deltaRecebimentos: 0,
    deltaRecebimentosPct: null,
    deltaSaldo: 0,
  },
  mesAtualEntries: entries,
  entries,
  projetos: [{ id: projectId, name: "Pessoal Teste", type: "PESSOAL" }],
  cards: [{ last4: "4242", nickname: "Teste", closingDay: 10, dueDay: 17 }],
  caixa: {
    hoje: 1_234_567,
    saldoInicial: 1_000_000,
    temSaldoInicial: true,
    porMes: [
      { mes: "2026-06", caixa: 1_000_000 },
      { mes: "2026-07", caixa: 1_234_567 },
    ],
  },
  projecao: {
    caixaHoje: 1_234_567,
    entrouMes: 500_025,
    saiuMes: 129_901,
    faltaPagarMes: 75_007,
    recebimentosPrevistosMes: 0,
    sobraPrevista: 1_159_560,
  },
};

function json(body: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

async function openMonthly(page: Page, viewport: ViewportSize) {
  const mutations: string[] = [];
  await page.setViewportSize(viewport);
  await page
    .context()
    .addCookies([
      { name: "rf_token", value: "test", url: "http://localhost:3013" },
    ]);
  await page.route("http://localhost:3001/**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET")
      mutations.push(`${request.method()} ${request.url()}`);
    const path = new URL(request.url()).pathname;
    if (path === "/auth/me") {
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
    }
    if (path === `/projects/${projectId}/monthly-overview`)
      return route.fulfill(json(overview));
    if (path === `/projects/${projectId}`) {
      return route.fulfill(
        json({
          id: projectId,
          name: "Pessoal Teste",
          type: "PESSOAL",
          rooms: [],
        }),
      );
    }
    if (path === "/projects") {
      return route.fulfill(
        json([{ id: projectId, name: "Pessoal Teste", type: "PESSOAL" }]),
      );
    }
    if (path === "/tenant/credit-cards" || path === "/tenant/bank-accounts") {
      return route.fulfill(json([]));
    }
    if (path === `/projects/${projectId}/monthly-overview/dre-overview`) {
      return route.fulfill(json({ anual: { saldoAcumuladoSerie: [] } }));
    }
    if (path === `/projects/${projectId}/category-budgets/progress`) {
      return route.fulfill(json([]));
    }
    return route.fulfill(json([]));
  });
  await page.goto(`/projects/${projectId}/monthly`);
  await expect(
    page.getByRole("heading", { name: /julho 2026/i }),
  ).toBeVisible();
  return mutations;
}

async function expectNoHorizontalOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);
}

test.describe("Monthly cockpit — Phase C mobile relance", () => {
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
      const mutations = await openMonthly(page, viewport);
      const mobile = page.getByTestId("mobile-month-cockpit");
      await expect(mobile).toBeVisible();
      await expect(page.getByTestId("desktop-monthly-legacy")).toBeHidden();
      await expectNoHorizontalOverflow(page);

      const box = await mobile.boundingBox();
      expect(box?.height).toBeLessThanOrEqual(viewport.height * 2.5);

      const interactiveMetrics = await mobile
        .locator("button:visible, summary:visible, input:visible")
        .evaluateAll((elements) =>
          elements.map((element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return {
              width: rect.width,
              height: rect.height,
              fontSize: parseFloat(style.fontSize),
            };
          }),
        );
      expect(interactiveMetrics.length).toBeGreaterThan(0);
      for (const metric of interactiveMetrics) {
        expect(metric.width).toBeGreaterThanOrEqual(44);
        expect(metric.height).toBeGreaterThanOrEqual(44);
        expect(metric.fontSize).toBeGreaterThanOrEqual(14);
      }

      // Named accordions (not a magic total): Track C keeps only the two
      // collapsible disclosures ("Consumo"/"Detalhes") — the extra mobile
      // sections it ships (scenarios, sankey, maria stories, swipe-to-pay)
      // are always-visible `region`s, not `aria-expanded` disclosures, so an
      // exact-count assertion on the disclosure selector would be brittle to
      // future additions of either kind. Each named disclosure is checked
      // individually so a future accordion addition is an explicit,
      // intentional change to this list rather than a silent pass.
      const disclosureNames = ["Consumo", "Detalhes"] as const;
      const disclosures = mobile.locator(
        'button[aria-controls^="mobile-cockpit-"][aria-expanded]',
      );
      expect(await disclosures.count()).toBe(disclosureNames.length);
      for (const name of disclosureNames) {
        const disclosure = mobile.getByRole("button", { name });
        await expect(disclosure).toHaveAttribute(
          "aria-controls",
          /^mobile-cockpit-/,
        );
        const initialState = await disclosure.getAttribute("aria-expanded");
        const toggledState = initialState === "true" ? "false" : "true";
        await disclosure.focus();
        await page.keyboard.press("Enter");
        await expect(disclosure).toHaveAttribute("aria-expanded", toggledState);
        await page.keyboard.press("Enter");
        await expect(disclosure).toHaveAttribute(
          "aria-expanded",
          initialState!,
        );
      }

      // Track C: the new mobile progressive sections (scenarios, swipe to
      // pay, sankey and "Maria percebeu") ship as always-visible accessible
      // `region`s alongside the two disclosures above — assert each keeps
      // its accessible name so the mobile contract stays discoverable by
      // assistive tech without depending on brittle DOM structure/markup.
      await expect(
        mobile.getByRole("region", { name: "Cenários e se…?" }),
      ).toBeVisible();
      await expect(
        mobile.getByRole("region", { name: "Próximas saídas" }),
      ).toBeVisible();
      await expect(
        mobile.getByRole("region", {
          name: "Para onde foi seu dinheiro este mês",
        }),
      ).toBeVisible();
      await expect(
        mobile.getByRole("region", { name: "Maria percebeu" }),
      ).toBeVisible();

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await expect(page.getByTestId("mobile-month-mini-hero")).toBeVisible();
      expect(mutations).toEqual([]);
    });
  }

  test("desktop keeps the legacy monthly tree and hides the mobile relance", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "viewport is explicitly owned by this spec",
    );
    const mutations = await openMonthly(page, { width: 1280, height: 800 });
    await expectNoHorizontalOverflow(page);
    await expect(page.getByTestId("desktop-monthly-legacy")).toBeVisible();
    await expect(page.getByTestId("mobile-month-cockpit")).toBeHidden();
    expect(mutations).toEqual([]);
  });
});
