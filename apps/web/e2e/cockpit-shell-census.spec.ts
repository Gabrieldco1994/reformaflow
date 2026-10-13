import { expect, test, type Locator, type Page } from "@playwright/test";

const PROJECT_ID = "phase2-564";
const MIN_CENSUS = 5;

const MOBILE_VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 375, height: 667 },
] as const;

const LOCAL_CHAT_REPLY = "Resposta local determinística.";
const COPILOT_INPUT_PLACEHOLDER = "Pergunte sobre suas finanças...";
const MARIA_INPUT_PLACEHOLDER = "Pergunte ou lance… “paguei 30 de uber”";

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

async function mockApi(
  page: Page,
  options: { includeImportEntryAction?: boolean } = {},
) {
  await page.clock.setFixedTime(new Date("2026-07-15T12:00:00.000Z"));
  await page
    .context()
    .addCookies([
      { name: "rf_token", value: "phase2-564", url: "http://localhost:3013" },
    ]);

  const chatPosts: Array<{
    method: string;
    path: string;
    body: unknown;
  }> = [];

  await page.route("http://localhost:3001/**", async (route) => {
    const request = route.request();
    const path = new URL(route.request().url()).pathname;

    if (request.method() === "OPTIONS") {
      return route.fulfill({
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "*",
        },
      });
    }

    if (path === "/agent/chat" && request.method() === "POST") {
      chatPosts.push({
        method: request.method(),
        path,
        body: request.postDataJSON(),
      });
      return route.fulfill(
        json({
          reply: LOCAL_CHAT_REPLY,
          toolsUsed: [],
          provider: "local-stub",
          ...(options.includeImportEntryAction
            ? {
                importEntryAction: {
                  version: 1,
                  kind: "START_CARD_INVOICE_IMPORT",
                  originChannel: "TEXT",
                  formats: ["CSV"],
                  suggestedCardId: null,
                },
              }
            : {}),
        }),
      );
    }

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

  return { chatPosts };
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
      element instanceof HTMLAnchorElement
        ? element.getAttribute("href")
        : null;
    const deadLink =
      element instanceof HTMLAnchorElement && (href === "#" || href === "");
    const fullyInsideViewport = pointHits.every(
      ({ insideViewport }) => insideViewport,
    );

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

async function census(
  page: Page,
  targets: Array<{ label: string; locator: Locator }>,
) {
  const initial: Measurement[] = [];
  for (const target of targets) {
    initial.push(await readTarget(target.locator, target.label));
  }

  const results: TargetCensus[] = [];
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const initialTarget = initial[index];
    let finalTarget = initialTarget;
    if (
      initialTarget.verdict !== "dead-link" &&
      initialTarget.verdict !== "ok"
    ) {
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
  const bad = results.filter((r) => r.final.verdict !== "ok");
  expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
  for (const result of results) {
    expect(result.final.width).toBeGreaterThanOrEqual(44);
    expect(result.final.height).toBeGreaterThanOrEqual(44);
  }
  return results;
}

async function ensureWidgetOpen(page: Page) {
  const openButton = page.getByLabel("Abrir Copiloto Financeiro");
  const closeButton = page.getByRole("button", { name: "Fechar", exact: true });
  await expect
    .poll(async () => (await closeButton.isVisible()) || openButton.isVisible())
    .toBe(true);
  if (await closeButton.isVisible()) return;
  await openButton.click();
  await expect(closeButton).toBeVisible();
}

async function readMainPaddingRight(page: Page) {
  return page.locator("main.minimal-main").evaluate((element) => {
    return Number.parseFloat(getComputedStyle(element).paddingRight);
  });
}

function boxesOverlap(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
) {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

async function verifyOpenCopilotOnMariaAndClose(
  page: Page,
  expectedDraft: string,
) {
  const closeButton = page.getByRole("button", { name: "Fechar", exact: true });
  const panelIsOpen = await closeButton.isVisible();
  expect
    .soft(panelIsOpen, "Copilot should remain open after Maria navigation")
    .toBe(true);

  const copilotInput = page.getByPlaceholder(COPILOT_INPUT_PLACEHOLDER);
  const copilotInputCount = await copilotInput.count();
  expect
    .soft(copilotInputCount, "the Copilot draft should remain available")
    .toBe(1);
  if (copilotInputCount === 1) {
    expect.soft(await copilotInput.inputValue()).toBe(expectedDraft);
  }

  expect.soft(await readMainPaddingRight(page)).toBe(408);

  if (panelIsOpen) {
    const mariaInput = page.getByPlaceholder(MARIA_INPUT_PLACEHOLDER);
    await expect(mariaInput).toBeVisible();
    const composer = mariaInput.locator("xpath=..");
    const panel = closeButton.locator("xpath=../../..");
    const [composerBox, panelBox] = await Promise.all([
      composer.boundingBox(),
      panel.boundingBox(),
    ]);
    expect.soft(composerBox).not.toBeNull();
    expect.soft(panelBox).not.toBeNull();
    if (composerBox && panelBox) {
      expect
        .soft(boxesOverlap(composerBox, panelBox))
        .toBe(false, "the open Copilot panel must not cover Maria's composer");
    }

    await closeButton.click();
    await expect(closeButton).toHaveCount(0);
  }

  const closedFabCount = await page
    .getByRole("button", { name: "Abrir Copiloto Financeiro" })
    .count();
  expect
    .soft(
      closedFabCount,
      "closing Copilot on Maria must not expose its floating button",
    )
    .toBe(0);
}

async function planningTargets(page: Page) {
  await expect(
    page.getByRole("heading", { name: "Matriz mensal (modo planilha)" }),
  ).toBeVisible();
  const matrixSection = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Matriz mensal (modo planilha)" }),
  });
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
      locator: page.getByRole("button", {
        name: "Ajuda sobre Tenho na conta hoje",
      }),
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
      locator: page.getByRole("button", {
        name: "Ajuda sobre Ainda falta pagar",
      }),
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
    {
      label: "Sidebar · Notificações",
      locator: sidebar.getByLabel("Notificações"),
    },
    {
      label: "Sidebar · Enviar feedback",
      locator: sidebar.getByLabel("Enviar feedback"),
    },
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

async function openMonthly(
  page: Page,
  viewport: { width: number; height: number },
) {
  await page.setViewportSize(viewport);
  await page.goto(`/projects/${PROJECT_ID}/monthly`);
}

async function openConta(
  page: Page,
  viewport: { width: number; height: number },
) {
  await page.setViewportSize(viewport);
  await page.goto(`/projects/${PROJECT_ID}/conta`);
}

test.describe("issue #564 — cockpit shell census", () => {
  test("desktop rail survives 700/800/900 without covered actions", async ({
    page,
  }) => {
    await mockApi(page);
    for (const viewport of DESKTOP_VIEWPORTS) {
      await openMonthly(page, viewport);
      await census(page, [
        {
          label: "Projetos",
          locator: page.locator(
            'aside.minimal-sidebar a[aria-label="Projetos"]',
          ),
        },
        {
          label: "Apoio",
          locator: page.locator('aside.minimal-sidebar a[aria-label="Apoio"]'),
        },
        {
          label: "Histórico de Budget",
          locator: page.locator(
            'aside.minimal-sidebar a[aria-label="Histórico de Budget"]',
          ),
        },
        {
          label: "Sair",
          locator: page.locator(
            'aside.minimal-sidebar button[aria-label="Sair (Ana)"]',
          ),
        },
        {
          label: "Expandir menu lateral",
          locator: page.getByRole("button", { name: "Expandir menu lateral" }),
        },
      ]);
    }
  });

  test("desktop rail expandido segura os choques do FinancialAgentWidget em 700/800/900 — /maria", async ({
    page,
  }, testInfo) => {
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
      const paddingRight = await readMainPaddingRight(page);
      expect(paddingRight).toBe(408);
      const main = page.locator("main.minimal-main");
      const widget = page.getByLabel("Fechar").locator("xpath=../../..");
      const [mainBox, widgetBox] = await Promise.all([
        main.boundingBox(),
        widget.boundingBox(),
      ]);
      expect(mainBox).not.toBeNull();
      expect(widgetBox).not.toBeNull();
      expect(mainBox!.x + mainBox!.width - paddingRight).toBeLessThanOrEqual(
        widgetBox!.x,
      );
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      ).toBe(true);
      await census(page, [
        ...mariaTargets(page),
        ...expandedSidebarTargets(page),
      ]);
    }
  });

  test("desktop rail expandido segura os choques do FinancialAgentWidget em 700/800/900 — /planning", async ({
    page,
  }, testInfo) => {
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

      await page.goto(`/projects/${PROJECT_ID}/planning`);
      await ensureWidgetOpen(page);
      await census(page, [
        ...(await planningTargets(page)),
        ...expandedSidebarTargets(page),
      ]);
    }
  });

  test("desktop rail expandido segura os choques do FinancialAgentWidget em 700/800/900 — /conta", async ({
    page,
  }, testInfo) => {
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

      await page.goto(`/projects/${PROJECT_ID}/conta`);
      await ensureWidgetOpen(page);
      await census(page, [
        ...contaTargets(page),
        ...expandedSidebarTargets(page),
      ]);
    }
  });

  test("mobile monthly keeps dock, cta and Maria details hittable at 390/375", async ({
    page,
  }) => {
    await mockApi(page);
    for (const viewport of MOBILE_VIEWPORTS) {
      await openMonthly(page, viewport);
      const details = page.getByRole("link", { name: /Ver detalhes de/ });
      await census(page, [
        {
          label: "Lançar",
          locator: page.getByRole("button", { name: "Lançar" }),
        },
        {
          label: "Cockpit",
          locator: page.locator('[data-dock-slot="monthly"]'),
        },
        { label: "Conta", locator: page.locator('[data-dock-slot="conta"]') },
        { label: "Maria", locator: page.locator('[data-dock-slot="maria"]') },
        {
          label: "Ver todas as despesas",
          locator: page.getByRole("link", { name: "Ver todas as despesas" }),
        },
        { label: "Ver detalhes", locator: details },
      ]);
      await expect(details).toHaveAttribute(
        "href",
        `/projects/${PROJECT_ID}/maria`,
      );
    }
  });

  test("mobile Conta keeps KPI quick-filters clear of the help affordance", async ({
    page,
  }) => {
    await mockApi(page);
    for (const viewport of MOBILE_VIEWPORTS) {
      await openConta(page, viewport);
      await census(page, [
        {
          label: "Ajuda sobre hoje",
          locator: page.getByRole("button", {
            name: "Ajuda sobre Tenho na conta hoje",
          }),
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
          label: "Ainda falta pagar",
          locator: page.getByRole("button", { name: /^Ainda falta pagar, / }),
        },
        {
          label: "Ajuda sobre sobra",
          locator: page.getByRole("button", {
            name: "Ajuda sobre Sobra prevista",
          }),
        },
      ]);
    }
  });

  test("desktop Maria composer sends from its exact center with Copilot closed", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "the Maria FAB collision is measured at the desktop viewport",
    );
    const { chatPosts } = await mockApi(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`/projects/${PROJECT_ID}/maria`);

    const closedFab = page.getByRole("button", {
      name: "Abrir Copiloto Financeiro",
    });

    const prompt = "Teste Maria 564: envio físico único";
    const input = page.getByPlaceholder(MARIA_INPUT_PLACEHOLDER);
    await expect(input).toBeVisible();
    await input.fill(prompt);

    const send = page.getByRole("button", { name: "Enviar", exact: true });
    await expect(send).toBeVisible();
    const box = await send.boundingBox();
    expect(box).not.toBeNull();
    const center = {
      x: box!.x + box!.width / 2,
      y: box!.y + box!.height / 2,
    };
    expect.soft(box!.width).toBeGreaterThanOrEqual(44);
    expect.soft(box!.height).toBeGreaterThanOrEqual(44);

    const centerHitsSend = await send.evaluate((button, point) => {
      const hit = document.elementFromPoint(point.x, point.y);
      return hit !== null && (hit === button || button.contains(hit));
    }, center);
    expect.soft(centerHitsSend).toBe(true);
    expect.soft(await closedFab.count()).toBe(0);

    await page.mouse.click(center.x, center.y);

    await expect.poll(() => chatPosts.length).toBe(1);
    expect(chatPosts).toHaveLength(1);
    expect(chatPosts[0]).toMatchObject({
      method: "POST",
      path: "/agent/chat",
      body: {
        projectId: PROJECT_ID,
        metadata: { channel: "TEXT" },
        messages: [{ role: "user", content: prompt }],
      },
    });
    await expect(page.getByText(prompt, { exact: true })).toHaveCount(1);
    await expect(page.getByText(LOCAL_CHAT_REPLY, { exact: true })).toHaveCount(
      1,
    );
  });

  test("desktop closed Copilot FAB remains on planning and Conta", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "the preserved FAB destinations are desktop routes",
    );
    await mockApi(page);
    await page.setViewportSize({ width: 1280, height: 800 });

    for (const route of ["planning", "conta"] as const) {
      await page.goto(`/projects/${PROJECT_ID}/${route}`);
      const fab = page.getByRole("button", {
        name: "Abrir Copiloto Financeiro",
      });
      await expect(fab).toBeVisible();
      await expect(fab).toHaveCount(1);
    }
  });

  test("desktop Copilot draft and open panel survive every Maria entry link", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "the global Copilot panel is a desktop surface",
    );
    const { chatPosts } = await mockApi(page, {
      includeImportEntryAction: true,
    });
    await page.setViewportSize({ width: 1280, height: 800 });

    const scenarios: Array<{
      name: string;
      source: "planning" | "conta";
      draft: string;
      findLink: (currentPage: Page) => Locator;
      prepare?: (currentPage: Page) => Promise<void>;
    }> = [
      {
        name: "Copilot header",
        source: "planning",
        draft: "Rascunho do cabeçalho da Maria",
        findLink: (currentPage) =>
          currentPage.getByRole("link", {
            name: "Importar fatura CSV com Maria",
            exact: true,
          }),
      },
      {
        name: "Copilot welcome message",
        source: "conta",
        draft: "Rascunho da mensagem de boas-vindas da Maria",
        findLink: (currentPage) =>
          currentPage.getByRole("link", {
            name: "Para importar uma fatura CSV, abra a conversa da Maria",
            exact: true,
          }),
      },
      {
        name: "Copilot reply action",
        source: "planning",
        draft: "Rascunho da ação de importação da Maria",
        findLink: (currentPage) =>
          currentPage.getByRole("link", {
            name: "Continuar importação CSV com a Maria",
            exact: true,
          }),
        prepare: async (currentPage) => {
          await currentPage
            .getByPlaceholder(COPILOT_INPUT_PLACEHOLDER)
            .fill("Quero abrir o atalho local de importação");
          await currentPage
            .getByRole("button", { name: "Enviar", exact: true })
            .click();
          await expect(
            currentPage.getByRole("link", {
              name: "Continuar importação CSV com a Maria",
              exact: true,
            }),
          ).toBeVisible();
        },
      },
    ];

    for (const scenario of scenarios) {
      await page.goto(`/projects/${PROJECT_ID}/${scenario.source}`);
      await ensureWidgetOpen(page);
      if (scenario.prepare) await scenario.prepare(page);

      await page
        .getByPlaceholder(COPILOT_INPUT_PLACEHOLDER)
        .fill(scenario.draft);
      const mariaLink = scenario.findLink(page);
      await expect(mariaLink).toBeVisible();
      await expect(mariaLink).toHaveAttribute(
        "href",
        `/projects/${PROJECT_ID}/maria`,
      );
      await mariaLink.click();
      await expect(page).toHaveURL(
        (url) => url.pathname === `/projects/${PROJECT_ID}/maria`,
      );

      await verifyOpenCopilotOnMariaAndClose(page, scenario.draft);
    }

    expect(chatPosts).toHaveLength(1);
    expect(chatPosts[0]).toMatchObject({
      method: "POST",
      path: "/agent/chat",
      body: {
        projectId: PROJECT_ID,
        metadata: { channel: "TEXT" },
        messages: [
          { role: "user", content: "Quero abrir o atalho local de importação" },
        ],
      },
    });
  });

  test("mobile Maria composer stays visible and center-hittable at 390/375", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "mobile",
      "mobile composer geometry uses the mobile browser context",
    );
    const { chatPosts } = await mockApi(page);

    for (const viewport of MOBILE_VIEWPORTS) {
      await openMonthly(page, viewport);
      const mariaTab = page.locator('[data-dock-slot="maria"]');
      await expect(mariaTab).toBeVisible();
      await expect(mariaTab).toHaveAttribute(
        "href",
        `/projects/${PROJECT_ID}/maria`,
      );
      await mariaTab.click();
      await expect(page).toHaveURL(
        (url) => url.pathname === `/projects/${PROJECT_ID}/maria`,
      );

      expect(await readMainPaddingRight(page)).toBe(20);
      await expect(
        page.getByRole("button", { name: "Abrir Copiloto Financeiro" }),
      ).toHaveCount(0);

      const input = page.getByPlaceholder(MARIA_INPUT_PLACEHOLDER);
      await expect(input).toBeVisible();
      await input.fill(`Maria mobile ${viewport.width}`);
      const send = page.getByRole("button", { name: "Enviar", exact: true });
      await expect(send).toBeVisible();
      const box = await send.boundingBox();
      expect(box).not.toBeNull();
      const center = {
        x: box!.x + box!.width / 2,
        y: box!.y + box!.height / 2,
      };
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(
        await send.evaluate((button, point) => {
          const hit = document.elementFromPoint(point.x, point.y);
          return hit !== null && (hit === button || button.contains(hit));
        }, center),
      ).toBe(true);
    }

    expect(chatPosts).toHaveLength(0);
  });
});
