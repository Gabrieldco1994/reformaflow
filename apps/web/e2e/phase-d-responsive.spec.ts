import { expect, test, type Locator, type Page } from "@playwright/test";

const houseId = "phase-d-house";
const carId = "phase-d-car";
const personalId = "phase-d-personal";

const recurringBills = [
  {
    id: "bill-energy",
    nome: "Energia Sentinela",
    valor: 20_696,
    categoria: "LUZ",
    frequencia: "MENSAL",
    diaVencimento: 7,
    status: "ATIVO",
  },
];

const avulsas = [
  {
    id: "expense-repair",
    tipoDespesa: "MORADIA",
    titulo: "Conserto sentinela",
    valorTotal: 20_696,
    status: "PAGO",
    formaPagamento: "PIX",
    dataPagamento: "2026-07-05T12:00:00.000Z",
  },
];

const maintenanceLogs = [
  {
    id: "maintenance-oil",
    tipo: "TROCA_OLEO",
    dataRealizada: "2026-06-01T12:00:00.000Z",
    dataProxima: "2026-08-01T12:00:00.000Z",
    quilometragem: 123_456,
    custo: 78_901,
    fornecedor: "Oficina Sentinela",
  },
];

const accountView = {
  mesSelecionado: "2026-07",
  caixaHoje: 10_101,
  entrouMes: 20_202,
  saiuMes: 30_303,
  faltaPagarMes: 40_404,
  recebimentosPrevistosMes: 50_505,
  sobraPrevista: 60_606,
  devoCartaoTotal: 0,
  cartoes: [],
  contas: [],
  saidas: [],
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

function json(body: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

async function mockApi(page: Page) {
  const mutations: string[] = [];
  await page
    .context()
    .addCookies([
      { name: "rf_token", value: "phase-d", url: "http://localhost:3013" },
    ]);
  await page.route("http://localhost:3001/**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") {
      mutations.push(`${request.method()} ${request.url()}`);
    }
    const path = new URL(request.url()).pathname;
    if (path === "/auth/me") {
      return route.fulfill(
        json({
          id: "phase-d-user",
          username: "phase-d",
          name: "Usuário Phase D",
          role: "ADMIN",
          tenantId: "phase-d-tenant",
          allowedModules: [],
          allowedProjects: [],
          allowedProjectTypes: [],
        }),
      );
    }
    if (path === "/projects") {
      return route.fulfill(
        json([
          { id: houseId, name: "Casa Phase D", type: "CASA" },
          { id: carId, name: "Carro Phase D", type: "CARRO" },
          { id: personalId, name: "Pessoal Phase D", type: "PESSOAL" },
        ]),
      );
    }
    if (path === `/projects/${houseId}`) {
      return route.fulfill(
        json({ id: houseId, name: "Casa Phase D", type: "CASA" }),
      );
    }
    if (path === `/projects/${carId}`) {
      return route.fulfill(
        json({ id: carId, name: "Carro Phase D", type: "CARRO" }),
      );
    }
    if (path === `/projects/${personalId}`) {
      return route.fulfill(
        json({ id: personalId, name: "Pessoal Phase D", type: "PESSOAL" }),
      );
    }
    if (path === `/projects/${houseId}/recurring-bills`) {
      return route.fulfill(json(recurringBills));
    }
    if (path === `/projects/${houseId}/expenses`) {
      return route.fulfill(
        json({
          items: avulsas,
          total: avulsas.length,
          page: 1,
          pageSize: 2000,
        }),
      );
    }
    if (path === `/projects/${carId}/maintenance-logs`) {
      return route.fulfill(json(maintenanceLogs));
    }
    if (path === `/projects/${personalId}/monthly-overview/account-view`) {
      return route.fulfill(json(accountView));
    }
    if (path === `/projects/${personalId}/monthly-overview/dre-overview`) {
      return route.fulfill(json({ anual: { saldoAcumuladoSerie: [] } }));
    }
    return route.fulfill(json([]));
  });
  return mutations;
}

async function expectNoHorizontalOverflow(page: Page) {
  const sizes = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(sizes.document).toBeLessThanOrEqual(sizes.viewport + 1);
}

async function expectTouchTargets(actions: Locator) {
  // Espera o primeiro alvo aparecer (assinatura auto-retry do Playwright) antes
  // de tirar a "foto" síncrona com .count() — evita flake de corrida com o
  // dev server / hidratação sem afrouxar a checagem de tamanho abaixo.
  await expect(actions.first()).toBeVisible();
  const count = await actions.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const box = await actions.nth(index).boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
}

/**
 * Cards mobile de bills/maintenance escondem as ações atrás do menu "⋯"
 * (CardActionsMenu, Fase G). O gatilho tem `aria-label="Ações {nome}"` e
 * role="button"; os itens revelados são `role="menuitem"` (role explícito,
 * não casam com getByRole("button")). Este helper abre o menu e valida o
 * alvo de toque tanto do gatilho quanto de cada item revelado, depois
 * fecha o menu (Escape) para não vazar estado para as asserções seguintes.
 */
async function expectCardMenuTouchTargets(
  page: Page,
  card: Locator,
  ariaLabel: string,
) {
  const trigger = card.getByRole("button", { name: ariaLabel });
  await expectTouchTargets(trigger);
  await trigger.click();
  const menu = page.getByRole("menu", { name: ariaLabel });
  await expect(menu).toBeVisible();
  await expectTouchTargets(menu.getByRole("menuitem"));
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
}

async function openBills(page: Page) {
  await page.goto(`/projects/${houseId}/bills`);
  await expect(page.getByRole("heading", { name: "Contas" })).toBeVisible();
}

async function openMaintenance(page: Page) {
  await page.goto(`/projects/${carId}/maintenance`);
  await expect(
    page.getByRole("heading", { name: "Manutenções", exact: true }),
  ).toBeVisible();
}

async function openAccount(page: Page) {
  await page.goto(`/projects/${personalId}/conta`);
  await expect(
    page.getByText("Tenho na conta hoje", { exact: true }),
  ).toBeVisible();
}

test.describe("Phase D responsive cards and account hierarchy", () => {
  for (const width of [390, 767, 768, 1280]) {
    test(`${width}px cards, tables, and account grouping`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "desktop",
        "this spec owns its exact boundaries",
      );
      await page.setViewportSize({ width, height: 900 });
      const mutations = await mockApi(page);

      await openBills(page);
      await expect(page.locator('[data-ui-skin="minimal"]')).toHaveCount(1);
      const mobileMore = page.getByRole("button", { name: "Mais opções" });
      const desktopToggle = page.getByRole("button", {
        name: /Expandir|Recolher menu lateral/,
      });
      if (width < 768) {
        await expect(mobileMore).toBeVisible();
        await expect(desktopToggle).toBeHidden();
        const mobileHeader = page.locator('[data-mobile-header="minimal"]');
        await expect(mobileHeader).not.toHaveClass(/safe-pt/);
        expect(
          await mobileHeader.evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).height),
          ),
        ).toBeGreaterThanOrEqual(56);
      } else {
        await expect(mobileMore).toBeHidden();
        await expect(desktopToggle).toBeVisible();
      }

      const activeNav =
        width < 768
          ? page
              .getByRole("navigation", { name: "Navegação principal" })
              .getByRole("link", { name: "Contas", exact: true })
          : page
              .locator("aside")
              .getByRole("link", { name: "Contas", exact: true });
      await expect(activeNav).toHaveAttribute("aria-current", "page");
      const activeColors = await activeNav.evaluate((link) => ({
        label: getComputedStyle(link.querySelector("span")!).color,
        icon: getComputedStyle(link.querySelector("svg")!).color,
      }));
      expect(activeColors).toEqual({
        label: "rgb(17, 18, 20)",
        icon: "rgb(30, 146, 74)",
      });

      const routeAndBodyFonts = await page.evaluate(() => ({
        route: getComputedStyle(document.querySelector("main")!).fontFamily,
        body: getComputedStyle(document.body).fontFamily,
      }));
      expect(routeAndBodyFonts.route).toBe(routeAndBodyFonts.body);
      await expectNoHorizontalOverflow(page);
      const billCard = page.getByRole("article", { name: "Energia Sentinela" });
      if (width < 768) {
        await expect(billCard).toBeVisible();
        await expect(page.getByRole("table")).toBeHidden();
        await expectCardMenuTouchTargets(
          page,
          billCard,
          "Ações Energia Sentinela",
        );
      } else {
        await expect(page.getByRole("table")).toBeVisible();
        await expect(billCard).toBeHidden();
      }

      await page.getByRole("button", { name: "Avulsas" }).click();
      const avulsaCard = page.getByRole("article", {
        name: "Conserto sentinela",
      });
      await expectNoHorizontalOverflow(page);
      if (width < 768) {
        await expect(avulsaCard).toBeVisible();
        await expect(page.getByRole("table")).toBeHidden();
        await expectTouchTargets(
          avulsaCard.getByRole("button", { name: /Editar|Excluir/ }),
        );
      } else {
        await expect(page.getByRole("table")).toBeVisible();
        await expect(avulsaCard).toBeHidden();
      }

      await openMaintenance(page);
      await expectNoHorizontalOverflow(page);
      const maintenanceCard = page.getByRole("article", {
        name: "Troca de Óleo",
      });
      if (width < 768) {
        await expect(maintenanceCard).toBeVisible();
        await expect(page.getByRole("table")).toBeHidden();
        await expectCardMenuTouchTargets(
          page,
          maintenanceCard,
          "Ações Troca de Óleo",
        );
      } else {
        await expect(page.getByRole("table")).toBeVisible();
        await expect(maintenanceCard).toBeHidden();
      }

      await openAccount(page);
      await expectNoHorizontalOverflow(page);
      if (width < 1280) {
        await expect(
          page.getByRole("heading", { name: "Realizado" }),
        ).toBeVisible();
        await expect(
          page.getByRole("heading", { name: "Projeção" }),
        ).toBeVisible();
      } else {
        await expect(
          page.getByRole("heading", { name: "Realizado" }),
        ).toBeHidden();
        await expect(
          page.getByRole("heading", { name: "Projeção" }),
        ).toBeHidden();
        const labels = [
          "Entrou no mês",
          "Saiu no mês",
          "Ainda falta pagar",
          "Sobra prevista",
        ];
        const boxes = await Promise.all(
          labels.map((label) =>
            page.getByText(label, { exact: true }).boundingBox(),
          ),
        );
        expect(boxes.every(Boolean)).toBe(true);
        expect(
          Math.max(...boxes.map((box) => box!.y)) -
            Math.min(...boxes.map((box) => box!.y)),
        ).toBeLessThan(4);
        expect(boxes.map((box) => box!.x)).toEqual(
          [...boxes.map((box) => box!.x)].sort((a, b) => a - b),
        );
      }

      await page.goto("/projects");
      await expect(
        page.getByRole("heading", { name: "Meus Projetos" }),
      ).toBeVisible();
      await expect(page.locator("[data-ui-skin]")).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
      expect(mutations).toEqual([]);
    });
  }
});
