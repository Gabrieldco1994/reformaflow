import { expect, test, type Locator, type Page } from "@playwright/test";

const PROJECT_ID = "phase2-564";
const MIN_CENSUS = 5;

const MOBILE_VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 375, height: 667 },
] as const;

const DESKTOP_VIEWPORTS = [
  { width: 1280, height: 700 },
  { width: 1280, height: 800 },
  { width: 1280, height: 900 },
] as const;

const accountView = {
  caixaHoje: 1_010_100,
  entrouMes: 2_020_200,
  saiuMes: 3_030_300,
  faltaPagarMes: 4_040_400,
  recebimentosPrevistosMes: 5_050_500,
  sobraPrevista: 6_060_600,
  carteiraHoje: 25_000,
  saiuSemConta: 8_900,
  cartoes: [],
  contas: [],
  saidas: [
    {
      id: "saida-1",
      titulo: "Mercado do mês",
      valor: 45_000,
      data: "2026-07-08T12:00:00.000Z",
      tipoDespesa: "MERCADO",
      status: "PAGO",
      formaPagamento: "PIX",
    },
    {
      id: "saida-2",
      titulo: "Farmácia",
      valor: 8_900,
      data: "2026-07-11T12:00:00.000Z",
      tipoDespesa: "SAUDE",
      status: "PAGO",
      formaPagamento: "PIX",
    },
  ],
  comprasCartao: [],
  entradas: [],
  ticketMedio: {
    valor: 0,
    nCompras: 0,
    totalCompras: 0,
    serie6m: [],
    media6m: 0,
    deltaVsMediaPct: null,
  },
};

const monthlyOverview = {
  mesAtual: "2026-07",
  meses: [
    {
      mes: "2026-06",
      totalDespesas: 80_000,
      totalRecebimentos: 0,
      despesasRealizadas: 80_000,
      recebimentosRealizados: 0,
      saldoMes: -80_000,
      saldoMesRealizado: -80_000,
      porOrigem: {},
      porCategoria: [{ categoria: "Mercado", valor: 80_000 }],
    },
    {
      mes: "2026-07",
      totalDespesas: 130_000,
      totalRecebimentos: 0,
      despesasRealizadas: 130_000,
      recebimentosRealizados: 0,
      saldoMes: -130_000,
      saldoMesRealizado: -130_000,
      porOrigem: {},
      porCategoria: [{ categoria: "Mercado", valor: 130_000 }],
    },
  ],
  comparativo: {
    current: null,
    previous: null,
    deltaDespesas: 0,
    deltaDespesasPct: null,
    deltaRecebimentos: 0,
    deltaRecebimentosPct: null,
    deltaSaldo: 0,
  },
  mesAtualEntries: [
    {
      id: "e-1",
      data: "2026-07-08T12:00:00.000Z",
      tipo: "DESPESA",
      status: "PAGO",
      valor: 130_000,
      categoria: "Mercado",
      subcategoria: null,
      formaPagamento: "PIX",
      projectId: PROJECT_ID,
      projectName: "Projeto Pessoal",
      projectType: "PESSOAL",
    },
  ],
  entries: [
    {
      id: "e-0",
      data: "2026-06-05T12:00:00.000Z",
      tipo: "DESPESA",
      status: "PAGO",
      valor: 80_000,
      categoria: "Mercado",
      subcategoria: null,
      formaPagamento: "PIX",
      projectId: PROJECT_ID,
      projectName: "Projeto Pessoal",
      projectType: "PESSOAL",
    },
    {
      id: "e-1",
      data: "2026-07-08T12:00:00.000Z",
      tipo: "DESPESA",
      status: "PAGO",
      valor: 130_000,
      categoria: "Mercado",
      subcategoria: null,
      formaPagamento: "PIX",
      projectId: PROJECT_ID,
      projectName: "Projeto Pessoal",
      projectType: "PESSOAL",
    },
  ],
  projetos: [{ id: PROJECT_ID, name: "Projeto Pessoal", type: "PESSOAL" }],
  caixa: {
    hoje: 1_010_100,
    saldoInicial: 1_010_100,
    temSaldoInicial: true,
    porMes: [
      { mes: "2026-06", caixa: 1_090_100 },
      { mes: "2026-07", caixa: 960_100 },
    ],
  },
  projecao: {
    status: "canonical",
    mes: "2026-07",
    caixaHoje: 1_010_100,
    entrouMes: 2_020_200,
    saiuMes: 3_030_300,
    faltaPagarMes: 4_040_400,
    recebimentosPrevistosMes: 5_050_500,
    sobraPrevista: 6_060_600,
    carteiraHoje: 25_000,
  },
};

const dreOverview = {
  mensal: { mes: "2026-07" },
  anual: {
    saldoAcumuladoSerie: [],
    candidatos: [],
  },
};

function json(body: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

async function mockApi(page: Page) {
  await page.clock.setFixedTime(new Date("2026-07-15T12:00:00.000Z"));
  await page.context().addCookies([
    { name: "rf_token", value: "phase2-564", url: "http://localhost:3013" },
  ]);

  await page.route("http://localhost:3001/**", async (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/auth/me") {
      return route.fulfill(
        json({
          id: "phase2-564-user",
          username: "phase2-564",
          name: "Ana",
          role: "ADMIN",
          tenantId: "phase2-564-tenant",
          allowedModules: [],
          allowedProjects: [],
          allowedProjectTypes: [],
        }),
      );
    }

    if (path === "/projects") {
      return route.fulfill(
        json([{ id: PROJECT_ID, name: "Projeto Pessoal", type: "PESSOAL" }]),
      );
    }

    if (path === `/projects/${PROJECT_ID}`) {
      return route.fulfill(
        json({
          id: PROJECT_ID,
          name: "Projeto Pessoal",
          type: "PESSOAL",
          onboardedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    }

    if (path === `/projects/${PROJECT_ID}/monthly-overview`) {
      return route.fulfill(json(monthlyOverview));
    }

    if (path === `/projects/${PROJECT_ID}/monthly-overview/account-view`) {
      return route.fulfill(json(accountView));
    }

    if (path === `/projects/${PROJECT_ID}/monthly-overview/dre-overview`) {
      return route.fulfill(json(dreOverview));
    }

    return route.fulfill(json([]));
  });
}

type Verdict = "ok" | "covered" | "offscreen" | "dead-link";

interface Measurement {
  verdict: Verdict;
  width: number;
  height: number;
  hit: string;
  href: string | null;
}

interface TargetCensus {
  label: string;
  initial: Measurement;
  final: Measurement;
}

async function readTarget(target: Locator, name: string): Promise<Measurement> {
  return target.evaluate((element, label) => {
    const rect = element.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const sampleWidth = Math.min(44, rect.width);
    const sampleHeight = Math.min(44, rect.height);
    const inset = Math.min(8, sampleWidth / 4, sampleHeight / 4);
    const left = cx - sampleWidth / 2;
    const right = cx + sampleWidth / 2;
    const top = cy - sampleHeight / 2;
    const bottom = cy + sampleHeight / 2;
    const pointHits = [
      { x: cx, y: cy },
      { x: left + inset, y: top + inset },
      { x: right - inset, y: top + inset },
      { x: left + inset, y: bottom - inset },
      { x: right - inset, y: bottom - inset },
    ].map(({ x, y }) => ({
      insideViewport:
        x >= 0 &&
        y >= 0 &&
        x <= document.documentElement.clientWidth &&
        y <= document.documentElement.clientHeight,
      hit: document.elementFromPoint(x, y),
    }));
    const coveredPoint = pointHits.find(
      ({ insideViewport, hit }) =>
        insideViewport && (!hit || !(hit === element || element.contains(hit))),
    );
    const hit = coveredPoint?.hit ?? pointHits[0].hit;
    const href =
      element instanceof HTMLAnchorElement ? element.getAttribute("href") : null;
    const deadLink =
      element instanceof HTMLAnchorElement &&
      (href === "#" || href === "");
    const fullyInsideViewport = pointHits.every(({ insideViewport }) => insideViewport);

    let verdict: Verdict = "ok";
    if (deadLink) verdict = "dead-link";
    else if (!fullyInsideViewport) verdict = "offscreen";
    else if (coveredPoint) verdict = "covered";

    return {
      label,
      verdict,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      hit: hit
        ? `${hit.tagName.toLowerCase()}.${String(hit.className).split(" ").slice(0, 2).join(".")}`
        : "none",
      href,
    };
  }, name);
}

async function census(page: Page, targets: Array<{ label: string; locator: Locator }>) {
  const initial: Measurement[] = [];
  for (const target of targets) {
    initial.push(await readTarget(target.locator, target.label));
  }

  const results: TargetCensus[] = [];
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const initialTarget = initial[index];
    let finalTarget = initialTarget;
    if (initialTarget.verdict !== "dead-link" && initialTarget.verdict !== "ok") {
      await target.locator.scrollIntoViewIfNeeded();
      finalTarget = await readTarget(target.locator, target.label);
    }
    results.push({
      label: target.label,
      initial: initialTarget,
      final: finalTarget,
    });
  }
  expect(results.length).toBeGreaterThanOrEqual(MIN_CENSUS);
  const bad = results.filter(
    (r) => r.final.verdict !== "ok",
  );
  expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
  for (const result of results) {
    expect(result.final.width).toBeGreaterThanOrEqual(44);
    expect(result.final.height).toBeGreaterThanOrEqual(44);
  }
  return results;
}

async function ensureWidgetOpen(page: Page) {
  const openButton = page.getByLabel("Abrir Copiloto Financeiro");
  if (await openButton.count()) {
    await expect(openButton).toBeVisible();
    await openButton.click();
    await expect(page.getByLabel("Fechar")).toBeVisible();
  }
}

async function readMainPaddingRight(page: Page) {
  return page.locator("main.minimal-main").evaluate((element) => {
    return Number.parseFloat(getComputedStyle(element).paddingRight);
  });
}

async function planningTargets(page: Page) {
  await expect(page.getByRole("heading", { name: "Matriz mensal (modo planilha)" })).toBeVisible();
  const matrixSection = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Matriz mensal (modo planilha)" }) });
  const inputs = matrixSection.locator("input");
  await expect(inputs.first()).toBeVisible();
  const count = await inputs.count();
  const start = Math.max(0, count - 5);
  return Array.from({ length: Math.min(5, count) }, (_, index) => ({
    label: `Matriz mensal · input ${index + 1}`,
    locator: inputs.nth(start + index),
  }));
}

function contaTargets(page: Page) {
  return [
    {
      label: "Ajuda sobre Tenho na conta hoje",
      locator: page.getByRole("button", { name: "Ajuda sobre Tenho na conta hoje" }),
    },
    {
      label: "Entrou no mês",
      locator: page.getByRole("button", { name: /^Entrou no mês, / }),
    },
    {
      label: "Saiu no mês",
      locator: page.getByRole("button", { name: /^Saiu no mês, / }),
    },
    {
      label: "Ajuda sobre Ainda falta pagar",
      locator: page.getByRole("button", { name: "Ajuda sobre Ainda falta pagar" }),
    },
    {
      label: "Ajuda sobre Sobra prevista",
      locator: page.getByRole("button", { name: "Ajuda sobre Sobra prevista" }),
    },
  ];
}

function mariaTargets(page: Page) {
  return [
    {
      label: "Voltar para hoje",
      locator: page.getByRole("link", { name: "Voltar para hoje" }),
    },
    {
      label: "Posso gastar R$ 500?",
      locator: page.getByRole("button", { name: "Posso gastar R$ 500?" }),
    },
    {
      label: "Quanto gastei com mercado?",
      locator: page.getByRole("button", { name: "Quanto gastei com mercado?" }),
    },
    {
      label: "Iniciar conversa por voz",
      locator: page.getByRole("button", { name: "Iniciar conversa por voz" }),
    },
    {
      label: "Falar",
      locator: page.getByRole("button", { name: "Falar", exact: true }),
    },
  ];
}

function expandedSidebarTargets(page: Page) {
  const sidebar = page.locator("aside.minimal-sidebar");
  return [
    { label: "Sidebar · Projetos", locator: sidebar.getByLabel("Projetos") },
    { label: "Sidebar · Notificações", locator: sidebar.getByLabel("Notificações") },
    { label: "Sidebar · Enviar feedback", locator: sidebar.getByLabel("Enviar feedback") },
    { label: "Sidebar · Apoio", locator: sidebar.getByLabel("Apoio") },
    {
      label: "Sidebar · Histórico de Budget",
      locator: sidebar.getByLabel("Histórico de Budget"),
    },
    { label: "Sidebar · Usuários", locator: sidebar.getByLabel("Usuários") },
    { label: "Sidebar · Sair", locator: sidebar.getByLabel("Sair (Ana)") },
    {
      label: "Sidebar · Recolher menu lateral",
      locator: sidebar.getByLabel("Recolher menu lateral"),
    },
  ];
}

async function openMonthly(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.goto(`/projects/${PROJECT_ID}/monthly`);
}

async function openConta(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.goto(`/projects/${PROJECT_ID}/conta`);
}

test.describe("issue #564 — cockpit shell census", () => {
  test("desktop rail survives 700/800/900 without covered actions", async ({ page }) => {
    await mockApi(page);
    for (const viewport of DESKTOP_VIEWPORTS) {
      await openMonthly(page, viewport);
      await census(page, [
        { label: "Projetos", locator: page.locator('aside.minimal-sidebar a[aria-label="Projetos"]') },
        { label: "Apoio", locator: page.locator('aside.minimal-sidebar a[aria-label="Apoio"]') },
        { label: "Histórico de Budget", locator: page.locator('aside.minimal-sidebar a[aria-label="Histórico de Budget"]') },
        { label: "Sair", locator: page.locator('aside.minimal-sidebar button[aria-label="Sair (Ana)"]') },
        { label: "Expandir menu lateral", locator: page.getByRole("button", { name: "Expandir menu lateral" }) },
      ]);
    }
  });

  test("desktop rail expandido segura os choques do FinancialAgentWidget em 700/800/900", async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "a colisão expandida do FinancialAgentWidget só roda no projeto desktop",
    );
    await page.addInitScript(() => {
      window.localStorage.setItem("lifeone:sidebar:collapsed", "false");
    });
    await mockApi(page);
    for (const viewport of DESKTOP_VIEWPORTS) {
      await page.setViewportSize(viewport);

      await page.goto(`/projects/${PROJECT_ID}/maria`);
      expect(await readMainPaddingRight(page)).toBe(24);
      await ensureWidgetOpen(page);
      expect(await readMainPaddingRight(page)).toBe(408);
      await census(page, [...mariaTargets(page), ...expandedSidebarTargets(page)]);

      await page.goto(`/projects/${PROJECT_ID}/planning`);
      await ensureWidgetOpen(page);
      await census(page, [
        ...(await planningTargets(page)),
        ...expandedSidebarTargets(page),
      ]);

      await page.goto(`/projects/${PROJECT_ID}/conta`);
      await ensureWidgetOpen(page);
      await census(page, [...contaTargets(page), ...expandedSidebarTargets(page)]);
    }
  });

  test("mobile monthly keeps dock, cta and Maria details hittable at 390/375", async ({ page }) => {
    await mockApi(page);
    for (const viewport of MOBILE_VIEWPORTS) {
      await openMonthly(page, viewport);
      const details = page.getByRole("link", { name: /Ver detalhes de/ });
      await census(page, [
        { label: "Lançar", locator: page.getByRole("button", { name: "Lançar" }) },
        { label: "Cockpit", locator: page.locator('[data-dock-slot="monthly"]') },
        { label: "Conta", locator: page.locator('[data-dock-slot="conta"]') },
        { label: "Maria", locator: page.locator('[data-dock-slot="maria"]') },
        { label: "Ver todas as despesas", locator: page.getByRole("link", { name: "Ver todas as despesas" }) },
        { label: "Ver detalhes", locator: details },
      ]);
      await expect(details).toHaveAttribute("href", `/projects/${PROJECT_ID}/maria`);
    }
  });

  test("mobile Conta keeps KPI quick-filters clear of the help affordance", async ({ page }) => {
    await mockApi(page);
    for (const viewport of MOBILE_VIEWPORTS) {
      await openConta(page, viewport);
      await census(page, [
        { label: "Ajuda sobre hoje", locator: page.getByRole("button", { name: "Ajuda sobre Tenho na conta hoje" }) },
        { label: "Entrou no mês", locator: page.getByRole("button", { name: /^Entrou no mês, / }) },
        { label: "Saiu no mês", locator: page.getByRole("button", { name: /^Saiu no mês, / }) },
        { label: "Ainda falta pagar", locator: page.getByRole("button", { name: /^Ainda falta pagar, / }) },
        { label: "Ajuda sobre sobra", locator: page.getByRole("button", { name: "Ajuda sobre Sobra prevista" }) },
      ]);
    }
  });
});
