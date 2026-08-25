import { expect, test, type Page } from "@playwright/test";

/**
 * #594 — contrato de layout para valor monetário fora do KpiTile.
 *
 * Após a #592, valores DENTRO do KpiTile têm contrato: `whitespace-nowrap` +
 * `.kpi-money-tile` (com `container-type: inline-size` para acomodação).
 *
 * Fora do KpiTile, dois arquivos divergiam:
 * - ManagementDashboard.tsx: `nowrap` SEM acomodação (valores vazavam).
 * - DreMensalDesktop.tsx: SEM `nowrap` (valores quebravam com `-` órfão).
 *
 * Esta correção aplica UM contrato aos dois, reutilizando o par existente:
 * `whitespace-nowrap` + `.kpi-money-tile` com container query.
 *
 * ARMADILHA #1: DRE está disponível APENAS para `type: "PESSOAL"`.
 * Testes anteriores mockavam com CARRO/REFORMA, causando `if (projectType !== 'PESSOAL')`
 * render uma mensagem em vez do componente. Aqui: dois projetos distintos.
 *
 * ARMADILHA #2: endpoints reais para DRE:
 * - `/projects/:id/monthly-overview/dre-overview?month=YYYY-MM&year=YYYY`
 * - `/projects/:id/monthly-overview/account-view?month=YYYY-MM`
 * (não `/projects/:id/dre/monthly` como havia na versão anterior)
 */

const CARRO_PROJECT_ID = "money-layout-594-carro";
const PESSOAL_PROJECT_ID = "money-layout-594-pessoal";
const WIDTHS = [1280, 1366, 1440, 1536] as const;

const CARRO_MOCK_DATA = {
  fuelCurrentMonth: 123_45678,
  fuelAverageMonthly: 98_76543,
  bills: [
    { id: "1", nome: "Gás", valor: 234_56789, categoria: "Utilidade", frequencia: "MENSAL", diaVencimento: 10, status: "ATIVA" },
  ],
};

const PESSOAL_MOCK_DRE = {
  mes: "2026-07",
  resultado: -567_89123,  // R$ -5.678,91 (6 dígitos, negativo)
  deltaVsMesAnterior: -12.5,
  totalEntrou: 100_00000,
  totalSaiuMaisGuardado: 567_89123,
  receitaTotal: 100_00000,
  despesaTotal: 234_56789,
  margemPct: -56.8,
  entradas: [
    { label: "Salário", valor: 50_00000, sub: "renda mensal" },
    { label: "Extras", valor: 50_00000, sub: "freelances" },
  ],
  entradasConta: [
    { label: "Salário na conta", valor: 50_00000, sub: "renda mensal" },
  ],
  saidas: [
    {
      group: "Alimentação",
      icon: "utensils",
      color: "#D85A30",
      items: [
        { label: "Supermercado", valor: 123_45678, sub: "compras" },
        { label: "Restaurante", valor: 87_65432, sub: "refeições" },
      ],
    },
  ],
  saidasCaixa: [
    {
      group: "Alimentação",
      icon: "utensils",
      color: "#D85A30",
      items: [
        { label: "Supermercado", valor: 123_45678, sub: "compras" },
      ],
    },
  ],
  guardado: [
    { label: "Emergência", valor: 234_56789, sub: "fundo de reserva" },
    { label: "Férias", valor: 111_11111, sub: "próximas férias" },
  ],
  contaCorrente: {
    caixaHoje: 500_00000,
    entrouMes: 100_00000,
    saiuMes: 234_56789,
    faltaPagarMes: 50_00000,
    recebimentosPrevistosMes: 0,
    sobraPrevista: 215_43211,
    despesaTotal: 234_56789,
  },
};

function json(body: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

async function setupCarroMock(page: Page) {
  await page.clock.setFixedTime(new Date("2026-07-15T12:00:00.000Z"));
  await page.context().addCookies([
    {
      name: "rf_token",
      value: CARRO_PROJECT_ID,
      url: `http://localhost:${process.env.PLAYWRIGHT_PORT ?? 3013}`,
    },
  ]);

  await page.route("http://localhost:3001/**", async (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/auth/me") {
      return route.fulfill(
        json({
          id: `${CARRO_PROJECT_ID}-user`,
          username: CARRO_PROJECT_ID,
          name: "Test CARRO",
          role: "ADMIN",
          tenantId: `${CARRO_PROJECT_ID}-tenant`,
          allowedModules: [],
          allowedProjects: [],
          allowedProjectTypes: [],
        }),
      );
    }
    if (path === "/projects") {
      return route.fulfill(json([{ id: CARRO_PROJECT_ID, name: "Meu Carro", type: "CARRO" }]));
    }
    if (path === `/projects/${CARRO_PROJECT_ID}`) {
      return route.fulfill(
        json({
          id: CARRO_PROJECT_ID,
          name: "Meu Carro",
          type: "CARRO",
          onboardedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    }
    if (path === `/projects/${CARRO_PROJECT_ID}/dashboard`) {
      return route.fulfill(
        json({
          bills: CARRO_MOCK_DATA.bills,
          maintenance: [],
          reminders: [],
          carInfo: { kmAtual: 50000 },
          fuelSummary: {
            currentMonthCents: CARRO_MOCK_DATA.fuelCurrentMonth,
            averageMonthlyCents: CARRO_MOCK_DATA.fuelAverageMonthly,
            monthsConsidered: 1,
          },
          financing: null,
          vehicleDocuments: [],
        }),
      );
    }
    return route.fulfill(json([]));
  });
}

async function setupPessoalMock(page: Page) {
  await page.clock.setFixedTime(new Date("2026-07-15T12:00:00.000Z"));
  await page.context().addCookies([
    {
      name: "rf_token",
      value: PESSOAL_PROJECT_ID,
      url: `http://localhost:${process.env.PLAYWRIGHT_PORT ?? 3013}`,
    },
  ]);

  await page.route("http://localhost:3001/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const url = new URL(route.request().url());

    if (path === "/auth/me") {
      return route.fulfill(
        json({
          id: `${PESSOAL_PROJECT_ID}-user`,
          username: PESSOAL_PROJECT_ID,
          name: "Test PESSOAL",
          role: "ADMIN",
          tenantId: `${PESSOAL_PROJECT_ID}-tenant`,
          allowedModules: ['monthlyOverview', 'expenses', 'receipts', 'cashFlow', 'creditCards', 'bankAccounts'],
          allowedProjects: [PESSOAL_PROJECT_ID],
          allowedProjectTypes: ['PESSOAL'],
        }),
      );
    }
    if (path === "/projects") {
      return route.fulfill(json([{ id: PESSOAL_PROJECT_ID, name: "Pessoal", type: "PESSOAL" }]));
    }
    if (path === `/projects/${PESSOAL_PROJECT_ID}`) {
      return route.fulfill(
        json({
          id: PESSOAL_PROJECT_ID,
          name: "Pessoal",
          type: "PESSOAL",
          onboardedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    }
    if (path === `/projects/${PESSOAL_PROJECT_ID}/monthly-overview/dre-overview`) {
      return route.fulfill(
        json({
          mensal: PESSOAL_MOCK_DRE,
          anual: {
            saldoAcumuladoSerie: [],
            candidatos: [],
          },
        }),
      );
    }
    if (path === `/projects/${PESSOAL_PROJECT_ID}/monthly-overview/account-view`) {
      return route.fulfill(
        json({
          caixaHoje: 500_00000,
          carteiraHoje: 0,
          entrouMes: 100_00000,
          saiuMes: 234_56789,
          saidaTotal: 234_56789,
          faltaPagarMes: 50_00000,
          recebimentosPrevistosMes: 0,
          sobraPrevista: 215_43211,
          cartoes: [],
          contas: [],
          saidas: [],
          comprasCartao: [],
          entradas: [],
          ticketMedio: { valor: 0, nCompras: 0, totalCompras: 0, serie6m: [], media6m: 0, deltaVsMediaPct: null },
        }),
      );
    }
    return route.fulfill(json([]));
  });
}

interface ValueMetrics {
  text: string;
  lines: number;
  clientWidth: number;
  scrollWidth: number;
  whiteSpace: string;
}

async function readValue(element: any): Promise<ValueMetrics> {
  return element.evaluate((node: HTMLElement) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0);
    return {
      text: (node.textContent ?? "").trim(),
      lines: rects.length,
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
      whiteSpace: getComputedStyle(node).whiteSpace,
    };
  });
}

async function openCopilot(page: Page) {
  // Espera o Copiloto estar disponível (não hardcoda [data-kpi-value] que só existe em KpiTile)
  const openButton = page.getByLabel("Abrir Copiloto Financeiro");
  await expect(openButton).toBeVisible();
  await openButton.click();
  await expect(openButton).toHaveCount(0);

  // Confirma a reserva de 408px está ativa
  await expect
    .poll(() =>
      page
        .locator("main.minimal-main")
        .evaluate((m) => Number.parseFloat(getComputedStyle(m).paddingRight)),
    )
    .toBe(408);
}

test.describe("#594 — valor monetário fora do KpiTile não quebra", () => {
  test("Dashboard CARRO: combustível com .kpi-money-tile em múltiplas larguras com Copiloto aberto", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop");
    await setupCarroMock(page);

    const report: string[] = [];

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/projects/${CARRO_PROJECT_ID}/dashboard`);
      await openCopilot(page);

      const fuelContainers = await page.locator(".kpi-money-tile").all();

      for (const container of fuelContainers) {
        const valueEl = container.locator("p").nth(1);
        if (await valueEl.isVisible()) {
          const m = await readValue(valueEl);

          if (m.text.includes("R$")) {
            report.push(`${width}px fuel: "${m.text}" lines=${m.lines} nowrap=${m.whiteSpace}`);

            expect(m.lines, `${width}px fuel: quebrou em ${m.lines} linhas`).toBe(1);
            expect(m.whiteSpace, `${width}px fuel: sem nowrap`).toBe("nowrap");
            expect(m.scrollWidth, `${width}px fuel: transborda`).toBeLessThanOrEqual(m.clientWidth);
          }
        }
      }
    }

    if (report.length > 0) {
      await testInfo.attach("dashboard-fuel-594", {
        body: report.join("\n"),
        contentType: "text/plain",
      });
    }
  });

  test("DRE PESSOAL: resultado, margem e breakdown com whitespace-nowrap em múltiplas larguras com Copiloto aberto", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop");
    await setupPessoalMock(page);

    const report: string[] = [];

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/projects/${PESSOAL_PROJECT_ID}/dre`);
      await openCopilot(page);

      // Verifica que a página renderizou o DreMensalDesktop, não a mensagem "disponível apenas para Pessoal"
      await expect(page.locator("text=disponível apenas para").first()).not.toBeVisible({timeout: 2000});

      // Localiza todos os valores monetários (p ou span com R$)
      const moneyValues = await page.locator("p, span").filter({
        has: page.locator("text=/^-?R\\$")
      }).all();

      for (const el of moneyValues) {
        const text = await el.textContent();
        if (text?.includes("R$") && text.length > 5) { // só valores reais
          const m = await readValue(el);
          report.push(`${width}px: "${m.text.substring(0, 20)}" lines=${m.lines} nowrap=${m.whiteSpace}`);

          expect(m.lines, `${width}px dre: "${m.text}" quebrou em ${m.lines} linhas`).toBe(1);
          expect(m.whiteSpace, `${width}px dre: "${m.text}" sem nowrap`).toBe("nowrap");
          expect(m.scrollWidth, `${width}px dre: "${m.text}" transborda`).toBeLessThanOrEqual(m.clientWidth);
        }
      }
    }

    if (report.length > 0) {
      await testInfo.attach("dre-money-594", {
        body: report.join("\n"),
        contentType: "text/plain",
      });
    }
  });

  test("valores permanecem íntegros sem Copiloto", async ({ page }) => {
    await setupCarroMock(page);
    await setupPessoalMock(page);

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });

      // Dashboard CARRO sem Copiloto
      await page.goto(`/projects/${CARRO_PROJECT_ID}/dashboard`);
      const dashboardValues = await page.locator(".kpi-money-tile p").filter({
        has: page.locator("text=/^R\\$")
      }).all();

      for (const el of dashboardValues) {
        const m = await readValue(el);
        if (m.text.includes("R$")) {
          expect(m.lines, `${width}px dashboard`).toBe(1);
          expect(m.scrollWidth, `${width}px dashboard overflow`).toBeLessThanOrEqual(m.clientWidth);
        }
      }

      // DRE PESSOAL sem Copiloto
      await page.goto(`/projects/${PESSOAL_PROJECT_ID}/dre`);
      const dreValues = await page.locator("p, span").filter({
        has: page.locator("text=/^-?R\\$")
      }).all();

      for (const el of dreValues) {
        const m = await readValue(el);
        if (m.text.includes("R$") && m.text.length > 5) {
          expect(m.lines, `${width}px dre`).toBe(1);
          expect(m.scrollWidth, `${width}px dre overflow`).toBeLessThanOrEqual(m.clientWidth);
        }
      }
    }
  });
});
