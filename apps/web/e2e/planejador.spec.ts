import { expect, test, type Page } from "@playwright/test";

const projectId = "pessoal-test";
const compraProjectId = "compra-test";
const priceItemId = "price-item-1";

function json(body: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

// Baseline do PESSOAL: 12 meses de saldo projetado positivo e decrescente —
// suficiente para os horizontes 3/6/12 sem crossover. Começa no mês atual
// real (o filtro `row.mes >= month` da página usa `new Date()`), não um mês
// fixo, para não depender do relógio do ambiente onde o teste roda.
function baselineSerie() {
  const now = new Date();
  const rows = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    const mes = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    rows.push({
      mes,
      recebimentos: 500_000,
      despesas: 200_000,
      recebimentosRealizados: null,
      despesasRealizadas: null,
      saldoProjetado: 50_000_00 - i * 1_000_00,
      saldoRealizado: null,
    });
  }
  return rows;
}

let scenarios: Array<{
  id: string;
  nome: string;
  horizonteMeses: number;
  itens: Array<{
    id: string;
    nome: string;
    tipo: "A_VISTA" | "PARCELADO" | "FINANCIAMENTO";
    valorCents: number;
    entradaCents: number | null;
    parcelas: number | null;
    taxaJurosMensalBps: number | null;
    sistema: "PRICE" | "SAC" | null;
    mesInicio: string;
    incluido: boolean;
    sourcePriceItemId: string | null;
  }>;
}>;

async function openPlanejador(
  page: Page,
  { withDeepLink = false }: { withDeepLink?: boolean } = {},
) {
  scenarios = [];
  const mutations: string[] = [];
  await page
    .context()
    .addCookies([
      { name: "rf_token", value: "test", url: "http://localhost:3013" },
    ]);
  await page.route("http://localhost:3001/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;
    if (method !== "GET") mutations.push(`${method} ${path}`);

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
    if (path === "/projects") {
      return route.fulfill(
        json([
          { id: projectId, name: "Pessoal Teste", type: "PESSOAL" },
          { id: compraProjectId, name: "Compra Teste", type: "COMPRA" },
        ]),
      );
    }
    if (path === `/projects/${projectId}`) {
      return route.fulfill(
        json({ id: projectId, name: "Pessoal Teste", type: "PESSOAL", onboardedAt: "2026-01-01T00:00:00.000Z", rooms: [] }),
      );
    }
    if (
      path === `/projects/${projectId}/monthly-overview/dre-overview`
    ) {
      return route.fulfill(
        json({ anual: { saldoAcumuladoSerie: baselineSerie() } }),
      );
    }
    if (path === `/projects/${compraProjectId}/price-monitor/items`) {
      return route.fulfill(
        json([
          {
            id: priceItemId,
            title: "Geladeira Frost Free",
            referencePriceCents: 300_000,
            lastBestPriceCents: 280_000,
          },
        ]),
      );
    }
    if (path === `/projects/${projectId}/planejador` && method === "GET") {
      return route.fulfill(json(scenarios));
    }
    if (path === `/projects/${projectId}/planejador` && method === "POST") {
      const body = request.postDataJSON() as { nome: string };
      const created = {
        id: `scenario-${scenarios.length + 1}`,
        nome: body.nome,
        horizonteMeses: 6,
        itens: [],
      };
      scenarios.push(created);
      return route.fulfill(json(created));
    }
    const scenarioPatchMatch = path.match(
      new RegExp(`^/projects/${projectId}/planejador/([^/]+)$`),
    );
    if (scenarioPatchMatch && method === "PATCH") {
      const scenario = scenarios.find((s) => s.id === scenarioPatchMatch[1]);
      const body = request.postDataJSON() as { horizonteMeses: number };
      if (scenario) scenario.horizonteMeses = body.horizonteMeses;
      return route.fulfill(json(scenario));
    }
    const itemsPostMatch = path.match(
      new RegExp(`^/projects/${projectId}/planejador/([^/]+)/itens$`),
    );
    if (itemsPostMatch && method === "POST") {
      const scenario = scenarios.find((s) => s.id === itemsPostMatch[1]);
      const body = request.postDataJSON();
      const item = {
        id: `item-${Date.now()}`,
        nome: body.nome,
        tipo: body.tipo,
        valorCents: body.valorCents,
        entradaCents: body.entradaCents ?? null,
        parcelas: body.parcelas ?? null,
        taxaJurosMensalBps: body.taxaJurosMensalBps ?? null,
        sistema: body.sistema ?? null,
        mesInicio: body.mesInicio,
        incluido: true,
        sourcePriceItemId: body.sourcePriceItemId ?? null,
      };
      scenario?.itens.push(item);
      return route.fulfill(json(item));
    }
    return route.fulfill(json([]));
  });

  const query = withDeepLink
    ? `?priceItemId=${priceItemId}&projectId=${compraProjectId}`
    : "";
  await page.goto(`/projects/${projectId}/planejador${query}`);
  await expect(
    page.getByRole("heading", { name: "Compras e cenários" }),
  ).toBeVisible();
  return mutations;
}

test.describe("Compras e cenários", () => {
  test("J1: cria cenário, adiciona financiamento e o veredito recalcula ao trocar horizonte sem novo fetch", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "fluxo owned pelo desktop");
    await openPlanejador(page);

    await page
      .getByPlaceholder("Novo cenário (ex.: Carro novo)")
      .fill("Carro novo");
    await page.getByRole("button", { name: "Criar cenário" }).click();
    await expect(page.getByRole("button", { name: "Carro novo" })).toBeVisible();

    await page.getByLabel("Nome").fill("Financiamento do carro");
    await page.getByLabel("Tipo").selectOption("FINANCIAMENTO");
    await page.getByLabel("Valor (R$)").fill("60000,00");
    await page.getByLabel("Mês de início").fill("2026-08");
    await page.getByLabel("Parcelas").fill("48");
    await page.getByLabel("Entrada (R$)").fill("10000,00");
    await page.getByLabel("Taxa mensal (%)").fill("1,5");
    await page.getByLabel("Sistema").selectOption("PRICE");
    await page.getByRole("button", { name: "Adicionar item" }).click();

    await expect(page.getByText("Financiamento do carro")).toBeVisible();
    await expect(page.getByTestId("plan-veredito-texto")).toBeVisible();

    // Trocar horizonte 6 → 3 → 12 recalcula o veredito no client (useMemo +
    // applyPurchasePlan local), sem buscar a baseline (dre-overview) de novo —
    // só a mutation de PATCH persiste a preferência de horizonte.
    const baselineFetches: string[] = [];
    page.on("request", (req) => {
      if (
        req.method() === "GET" &&
        req.url().includes("/monthly-overview/dre-overview")
      ) {
        baselineFetches.push(req.url());
      }
    });

    const vereditoBefore = await page
      .getByTestId("plan-veredito-texto")
      .innerText();
    await page.getByTestId("horizonte-3").click();
    await expect(page.getByTestId("horizonte-3")).toHaveClass(/ck-accent/);
    await page.getByTestId("horizonte-12").click();
    const vereditoAfter = await page
      .getByTestId("plan-veredito-texto")
      .innerText();
    expect(baselineFetches.length).toBe(0);
    // Com 12 meses de horizonte o texto do veredito referencia um mês
    // diferente do de 6 meses — confirma que o recálculo aconteceu.
    expect(vereditoAfter).not.toBe(vereditoBefore);
  });

  test("deep-link da COMPRA pré-carrega nome e preço do item monitorado", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "fluxo owned pelo desktop");
    await openPlanejador(page, { withDeepLink: true });

    await page
      .getByPlaceholder("Novo cenário (ex.: Carro novo)")
      .fill("Geladeira nova");
    await page.getByRole("button", { name: "Criar cenário" }).click();
    await expect(
      page.getByRole("button", { name: "Geladeira nova" }),
    ).toBeVisible();

    await expect(page.getByLabel("Nome")).toHaveValue("Geladeira Frost Free");
    await expect(page.getByLabel("Valor (R$)")).toHaveValue("2.800,00");
  });
});

// U5 / #454 — "Orçamento futuro" (Planning local, localStorage
// `personal-planning:${id}`) e "Compras e cenários" (Planejador server,
// PurchaseScenario) são dois stores independentes. Navegar entre eles não
// pode: (a) disparar nenhuma mutation de rede, (b) alterar 1 byte do
// localStorage do outro store. Rodado nos 3 projects (desktop + mobile), sem
// skip — a regressão de contaminação de store não é owned por um viewport.
const PLANNING_STORAGE_KEY = `personal-planning:${projectId}`;
const SEEDED_PLANNING_STATE = JSON.stringify({
  version: 2,
  activeScenarioId: "sc-rf454",
  scenarios: [
    {
      id: "sc-rf454",
      name: "Cenário QA rf454",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
});

// Alinhado ao relógio congelado em setupUnifiedStores (2026-09-03).
const FROZEN_MONTH_KEY = "2026-09";
function currentMonthKey() {
  return FROZEN_MONTH_KEY;
}

async function setupUnifiedStores(page: Page) {
  const mutations: string[] = [];
  // Relógio congelado: `/planning` e `/planejador` filtram série pelo mês
  // corrente (`new Date()`); sem congelar, o CI em UTC vira o mês antes do
  // Brasil e a página fica vazia (regra #22).
  await page.clock.setFixedTime(new Date("2026-09-03T12:00:00.000Z"));
  await page
    .context()
    .addCookies([
      { name: "rf_token", value: "test", url: "http://localhost:3013" },
    ]);
  await page.route("http://localhost:3001/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;
    if (method !== "GET") mutations.push(`${method} ${path}`);

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
    if (path === "/projects") {
      return route.fulfill(
        json([{ id: projectId, name: "Pessoal Teste", type: "PESSOAL" }]),
      );
    }
    if (path === `/projects/${projectId}`) {
      return route.fulfill(
        json({
          id: projectId,
          name: "Pessoal Teste",
          type: "PESSOAL",
          onboardedAt: "2026-01-01T00:00:00.000Z",
          rooms: [],
        }),
      );
    }
    if (path === `/projects/${projectId}/monthly-overview`) {
      const mes = currentMonthKey();
      return route.fulfill(
        json({
          mesAtual: mes,
          meses: [
            { mes, totalRecebimentos: 500_000, totalDespesas: 200_000 },
          ],
          entries: [],
        }),
      );
    }
    if (path === `/projects/${projectId}/monthly-overview/dre-overview`) {
      return route.fulfill(
        json({ anual: { saldoAcumuladoSerie: baselineSerie() } }),
      );
    }
    if (path === `/projects/${projectId}/planejador`) {
      return route.fulfill(json([]));
    }
    return route.fulfill(json([]));
  });
  return mutations;
}

async function readPlanningStore(page: Page) {
  return page.evaluate(
    (key) => window.localStorage.getItem(key),
    PLANNING_STORAGE_KEY,
  );
}

// Semeia o store do "Orçamento futuro" UMA ÚNICA VEZ. A origem precisa existir
// antes do `localStorage.setItem`, então navega primeiro, escreve via
// `page.evaluate` e recarrega uma vez para o app hidratar. NENHUM
// `addInitScript` — se ele ressemeasse a cada navegação/reload, a comparação
// byte a byte seria falso-verde (todo reload sobrescreveria de volta o seed).
async function seedPlanningStoreOnce(page: Page) {
  await page.goto(`/projects/${projectId}/planning`);
  await page.evaluate(
    ([key, value]) => window.localStorage.setItem(key, value),
    [PLANNING_STORAGE_KEY, SEEDED_PLANNING_STATE] as const,
  );
  await page.reload();
  await expect(
    page.getByRole("heading", { name: /Orçamento futuro/i }),
  ).toBeVisible();
  const seeded = await readPlanningStore(page);
  expect(seeded).toContain("Cenário QA rf454");
  expect(seeded).toContain("sc-rf454");
  return seeded as string;
}

test.describe("Orçamento futuro × Compras e cenários — stores isolados", () => {
  test("navegar entre os dois stores não dispara mutation nem altera o localStorage do outro", async ({
    page,
  }) => {
    const mutations = await setupUnifiedStores(page);

    // 1. Seed único do Orçamento futuro (localStorage).
    const before = await seedPlanningStoreOnce(page);

    // 2. Compras e cenários (server store) — sem reseed.
    await page.goto(`/projects/${projectId}/planejador`);
    await expect(
      page.getByRole("heading", { name: "Compras e cenários" }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Compras e cenários" }),
    ).toBeVisible();

    // 3. Volta para o Orçamento futuro + reload — sem reseed.
    await page.goto(`/projects/${projectId}/planning`);
    await expect(
      page.getByRole("heading", { name: /Orçamento futuro/i }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("heading", { name: /Orçamento futuro/i }),
    ).toBeVisible();
    const after = await readPlanningStore(page);

    // 4. localStorage do Orçamento futuro intacto byte a byte.
    expect(after).toBe(before);
    expect(JSON.parse(after as string)).toEqual(JSON.parse(before));

    // 5. Nenhuma mutation de rede durante a navegação — e em especial nada
    // que toque o store de Compras e cenários.
    expect(
      mutations.filter((m) => /planejador|purchase-scenario|scenario/i.test(m)),
    ).toEqual([]);
    expect(mutations).toEqual([]);
  });

  test("CONTROLE: escrita indevida no store quebra a comparação (prova que o assert tem dente)", async ({
    page,
  }) => {
    await setupUnifiedStores(page);

    // Mesmo seed único do teste acima.
    const before = await seedPlanningStoreOnce(page);

    // Navega para Compras e cenários e, já lá, simula EXATAMENTE o que um
    // vazamento de store faria: uma escrita cruzada na chave do outro store.
    await page.goto(`/projects/${projectId}/planejador`);
    await expect(
      page.getByRole("heading", { name: "Compras e cenários" }),
    ).toBeVisible();
    await page.evaluate(
      (key) =>
        window.localStorage.setItem(key, JSON.stringify({ tampered: true })),
      PLANNING_STORAGE_KEY,
    );

    // Volta para o Orçamento futuro + reload, sem reseed.
    await page.goto(`/projects/${projectId}/planning`);
    await expect(
      page.getByRole("heading", { name: /Orçamento futuro/i }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole("heading", { name: /Orçamento futuro/i }),
    ).toBeVisible();
    const after = await readPlanningStore(page);

    // A MESMA asserção do teste 1 agora DEVE falhar — logo, ela tem dente:
    // uma regressão real de contaminação de store deixa o teste vermelho.
    expect(after).not.toBe(before);
  });
});
