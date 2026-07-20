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
          role: "ADMIN",
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
    // Origens do sheet "Lançar" são SÓ do projeto atual (project-scoped),
    // não os endpoints /tenant/* (tenant-wide). Só disparam com o sheet aberto.
    if (path === `/projects/${projectId}/bank-accounts`) {
      return route.fulfill(
        json([
          {
            id: "acc-4247",
            nickname: "Itaú Personnalité",
            institution: "Itaú",
            last4: "4247",
          },
        ]),
      );
    }
    if (path === `/projects/${projectId}/credit-cards`) {
      return route.fulfill(
        json([
          {
            id: "card-5876",
            nickname: "Itaú Mastercard",
            brand: "MASTERCARD",
            last4: "5876",
            closingDay: 10,
            dueDay: 17,
          },
        ]),
      );
    }
    // Maria categoriza a despesa na tela a partir da descrição.
    if (path === "/merchant-categories/suggest") {
      return route.fulfill(
        json({
          category: "Alimentação",
          subcategory: null,
          confidence: 0.92,
          source: "merchant",
          suggestedTipoDespesa: "ALIMENTACAO",
        }),
      );
    }
    if (path === `/projects/${projectId}/monthly-overview/dre-overview`) {
      // MobileRunway ("Vai dar até dez?") só renderiza com ≥6 meses à frente do
      // mês corrente na série de saldo acumulado (eixo caixa §10).
      const runwayRow = (mes: string, saldoProjetado: number) => ({
        mes,
        recebimentos: 500_000,
        despesas: 200_000,
        recebimentosRealizados: null,
        despesasRealizadas: null,
        saldoProjetado,
        saldoRealizado: null,
      });
      return route.fulfill(
        json({
          anual: {
            saldoAcumuladoSerie: [
              runwayRow("2026-07", 1_159_560),
              runwayRow("2026-08", 1_050_000),
              runwayRow("2026-09", 940_000),
              runwayRow("2026-10", 830_000),
              runwayRow("2026-11", 720_000),
              runwayRow("2026-12", 610_000),
            ],
          },
        }),
      );
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

      // Mobile simplificado: só "Consumo" fica como disclosure.
      const disclosureNames = ["Consumo"] as const;
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

      // Contrato atual: runway + maria permanecem sempre visíveis.
      await expect(
        mobile.getByRole("region", { name: "Vai dar até dez?" }),
      ).toBeVisible();
      await expect(
        mobile.getByRole("region", { name: "Maria percebeu" }),
      ).toBeVisible();

      // bug 1 (nav): a tela mobile de Despesas precisa ter uma entrada a partir
      // do cockpit (o link vive na área de consumo/Sankey do "Hoje").
      await expect(
        mobile.getByRole("link", { name: "Ver todas as despesas" }),
      ).toHaveAttribute("href", `/projects/${projectId}/expenses`);

      // A mini-hero capsule (leitura de relance do caixa) fica fixa no topo do
      // cockpit — revelada por rolagem no mês corrente, sempre visível em outro
      // mês. O comportamento de scroll é coberto por MiniHeroCapsule.test.tsx;
      // aqui garantimos que ela é montada no cockpit mobile.
      await expect(page.getByTestId("mini-hero-capsule")).toBeVisible();
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

  // O FAB "Lançar" e o sheet de lançamento vivem no AppShell (global a todas as
  // rotas do projeto), então o cockpit é uma superfície válida para exercê-los.
  test("Lançar: FAB minimal, modo Despesa traz origens do projeto e categorias diretas", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "viewport is explicitly owned by this spec",
    );
    const mutations = await openMonthly(page, { width: 390, height: 844 });

    // O Skin Minimal usa o botão branco separado do dock.
    const fab = page.getByRole("button", { name: "Lançar", exact: true });
    await expect(fab).toBeVisible();
    expect(
      await fab.evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe("rgb(255, 255, 255)");

    // O "+" abre PRIMEIRO o menu de modo (Despesa / Recebimento / Voz / Foto) — não vai direto
    // ao sheet de lançamento.
    await fab.click();
    const launchModeSheet = page.locator('[data-mobile-sheet="launch-mode"]');
    await expect(
      launchModeSheet.getByRole("heading", { name: "Como quer lançar?" }),
    ).toBeVisible();
    await expect(
      launchModeSheet.getByRole("button", { name: /^Despesa\b/ }),
    ).toBeVisible();
    await expect(
      launchModeSheet.getByRole("button", { name: /^Foto\b/ }),
    ).toBeVisible();

    // Despesa → sheet de lançamento rápido.
    await launchModeSheet
      .getByRole("button", { name: /^Despesa\b/ })
      .click();
    await expect(
      page.getByRole("heading", { name: "Lançar", exact: true }),
    ).toBeVisible();

    // origens SÓ do projeto atual (2): conta + cartão com labels próprios.
    const origins = page.locator('button[aria-label^="Origem "]');
    await expect(origins).toHaveCount(2);
    await expect(
      page.getByRole("button", { name: "Origem Itaú Personnalité" }),
    ).toBeVisible();
    const card = page.getByRole("button", {
      name: "Origem Itaú Mastercard •5876",
    });
    await expect(card).toBeVisible();

    // cartão expõe parcelas nativas (1–18x, "À vista" para 1); conta não.
    await card.click();
    const parcelas = page.getByRole("combobox", { name: "Parcelas" });
    await expect(parcelas).toBeVisible();
    await expect(parcelas.locator("option")).toHaveCount(18);
    await expect(parcelas.locator("option").first()).toHaveText("À vista");

    // categoria-first: os atalhos de categoria aparecem direto (sem digitar) e o
    // título é preenchido pela categoria escolhida, por trás.
    const supermercado = page.getByRole("button", {
      name: "Categoria Supermercado",
    });
    await expect(supermercado).toBeVisible();
    await supermercado.click();
    await expect(page.getByText(/Lança como/)).toContainText("Supermercado");

    // "ver todas" revela o resto do catálogo PESSOAL (fora do atalho).
    await expect(
      page.getByRole("button", { name: "Categoria Faxineira" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "ver todas" }).click();
    await expect(
      page.getByRole("button", { name: "Categoria Faxineira" }),
    ).toBeVisible();

    // presentation-only: abrir e mexer no sheet não escreve despesa nenhuma.
    expect(mutations.filter((m) => m.includes("/expenses"))).toEqual([]);
  });
});
