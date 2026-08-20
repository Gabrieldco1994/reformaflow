import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * #490 — defeitos VISÍVEIS medidos em runtime.
 *
 * Existe porque jsdom não tem layout: `getBoundingClientRect` devolve zeros e
 * `0 >= 44` nunca falha, então toda asserção de geometria e de alcançabilidade
 * vive aqui. Os testes de estrutura (não há botão dentro de botão; existe uma
 * só CTA primária) ficam no vitest, ao lado dos componentes.
 *
 * Alcançabilidade não é "a caixa tem 44px". Já se mediu nesta base um link de
 * 207×44px impecáveis que era inalcançável, porque o `elementFromPoint` do
 * centro dele devolvia o rodapé fixo. A ordem obrigatória é:
 *   1. `scrollIntoViewIfNeeded()` no contêiner rolável de verdade;
 *   2. medir a caixa;
 *   3. `elementFromPoint` no centro tem que devolver o próprio elemento ou um
 *      descendente dele;
 *   4. o centro tem que cair dentro do *client rect* do contêiner rolável.
 */

const pessoalId = "d490-pessoal";
const reformaId = "d490-reforma";

const MIN_TOUCH = 44;

const receipts = [
  {
    id: "rec-1",
    valor: 850_000,
    data: "2026-07-05T12:00:00.000Z",
    tipo: "PAGAMENTO",
    status: "EM_CAIXA",
  },
  {
    id: "rec-2",
    valor: 120_000,
    data: "2026-07-12T12:00:00.000Z",
    tipo: "PAGAMENTO",
    status: "PREVISTO",
  },
  {
    id: "rec-3",
    valor: 45_000,
    data: "2026-07-20T12:00:00.000Z",
    tipo: "PAGAMENTO",
    status: "PREVISTO",
  },
  {
    id: "rec-4",
    valor: 32_500,
    data: "2026-07-27T12:00:00.000Z",
    tipo: "PAGAMENTO",
    status: "PREVISTO",
  },
];

const accountView = {
  mesSelecionado: "2026-07",
  caixaHoje: 1_010_100,
  entrouMes: 2_020_200,
  saiuMes: 3_030_300,
  faltaPagarMes: 4_040_400,
  recebimentosPrevistosMes: 5_050_500,
  sobraPrevista: 6_060_600,
  devoCartaoTotal: 0,
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

const dreOverview = {
  mensal: {
    mes: "2026-07",
    resultado: 1_010_100,
    deltaVsMesAnterior: 0,
    totalEntrou: 2_020_200,
    totalSaiuMaisGuardou: 1_010_100,
    receitaTotal: 2_020_200,
    despesaTotal: 1_010_100,
    margemPct: 50,
    entradas: [{ label: "Salário", valor: 2_020_200 }],
    entradasConta: [{ label: "Salário", valor: 2_020_200 }],
    saidas: [
      {
        group: "Casa",
        icon: "home",
        color: "slate",
        items: [{ label: "Mercado do mês", valor: 45_000 }],
      },
    ],
    saidasCaixa: [
      {
        group: "Casa",
        icon: "home",
        color: "slate",
        items: [{ label: "Mercado do mês", valor: 45_000 }],
      },
    ],
    guardado: [],
    contaCorrente: {
      caixaHoje: 1_010_100,
      entrouMes: 2_020_200,
      saiuMes: 3_030_300,
      faltaPagarMes: 4_040_400,
      recebimentosPrevistosMes: 5_050_500,
      sobraPrevista: 6_060_600,
      despesaTotal: 1_010_100,
    },
  },
  anual: {
    ano: 2026,
    ateOMes: "2026-07",
    totalEntrou: 2_020_200,
    totalSaiu: 1_010_100,
    resultadoAcumulado: 1_010_100,
    mediaMensal: 144_300,
    mesCritico: { mes: "2026-07", margem: 50 },
    serie: [],
    caixaHoje: 1_010_100,
    saldoAcumuladoOpening: 0,
    saldoAcumuladoSerie: [],
    despesasPorOrigem: { origens: [], serie: [] },
    totaisEntradas: [],
    totaisSaidas: [],
    totaisGuardado: [],
    candidatos: [],
  },
};

const budgetAllocations = [
  {
    id: "alloc-1",
    dataAlocacao: "2026-07-03T12:00:00.000Z",
    mes: "2026-07",
    valor: 8_000_00,
    targetProject: { id: reformaId, name: "Reforma Sentinela" },
    descricao: null,
  },
  {
    id: "alloc-2",
    dataAlocacao: "2026-07-14T12:00:00.000Z",
    mes: "2026-07",
    valor: 1_250_00,
    targetProject: { id: reformaId, name: "Reforma Sentinela" },
    descricao: null,
  },
  {
    id: "alloc-3",
    dataAlocacao: "2026-07-22T12:00:00.000Z",
    mes: "2026-07",
    valor: 4_530_00,
    targetProject: { id: reformaId, name: "Reforma Sentinela" },
    descricao: null,
  },
];

function json(body: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

async function mockApi(page: Page) {
  await page.clock.setFixedTime(new Date("2026-07-15T12:00:00.000Z"));
  await page
    .context()
    .addCookies([
      { name: "rf_token", value: "d490", url: "http://localhost:3013" },
    ]);
  await page.route("http://localhost:3001/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/auth/me") {
      return route.fulfill(
        json({
          id: "d490-user",
          username: "d490",
          name: "Usuária 490",
          role: "ADMIN",
          tenantId: "d490-tenant",
          allowedModules: [],
          allowedProjects: [],
          allowedProjectTypes: [],
        }),
      );
    }
    if (path === "/projects") {
      return route.fulfill(
        json([
          { id: pessoalId, name: "Pessoal 490", type: "PESSOAL" },
          { id: reformaId, name: "Reforma 490", type: "REFORMA" },
        ]),
      );
    }
    if (path === `/projects/${pessoalId}`) {
      return route.fulfill(
        json({
          id: pessoalId,
          name: "Pessoal 490",
          type: "PESSOAL",
          onboardedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    }
    if (path === `/projects/${reformaId}`) {
      return route.fulfill(
        json({
          id: reformaId,
          name: "Reforma 490",
          type: "REFORMA",
          onboardedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    }
    if (path === `/projects/${pessoalId}/receipts`) {
      return route.fulfill(json(receipts));
    }
    if (path.endsWith("/monthly-overview/account-view")) {
      return route.fulfill(json(accountView));
    }
    if (path.endsWith("/monthly-overview/dre-overview")) {
      return route.fulfill(json(dreOverview));
    }
    if (path === "/budget-allocations") {
      return route.fulfill(json(budgetAllocations));
    }
    if (path.startsWith("/budget-allocations/available/")) {
      return route.fulfill(json(1_500_000));
    }
    if (path.startsWith("/budget-allocations/summary/")) {
      return route.fulfill(
        json({
          totalAllocated: 1_378_000,
          totalExpenses: 0,
          totalReceipts: 2_878_000,
          allocations: [],
        }),
      );
    }
    return route.fulfill(json([]));
  });
}

/** Rótulos VISÍVEIS de ação dentro do conteúdo da rota. Conta, não olha. */
async function visibleActionLabels(page: Page) {
  return page
    .locator("main")
    .locator("button:visible, a:visible")
    .evaluateAll((elements) =>
      elements
        .map((element) => (element.textContent ?? "").replace(/\s+/g, " ").trim())
        .filter(Boolean),
    );
}

function repeated(labels: string[]) {
  return labels.filter((label, index, all) => all.indexOf(label) !== index);
}

interface Reachability {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  hitsSelf: boolean;
  topElement: string;
  insideScroller: boolean;
}

/**
 * Mede um alvo do jeito que o usuário o encontra: rola o contêiner real,
 * mede, e pergunta ao navegador QUEM está no centro daquela caixa.
 */
async function measureReachability(target: Locator): Promise<Reachability> {
  await target.scrollIntoViewIfNeeded();
  return target.evaluate((element) => {
    function describe(node: Element | null): string {
      if (!node) return "<nada>";
      const classes =
        typeof node.className === "string" && node.className
          ? `.${node.className.trim().split(/\s+/).slice(0, 2).join(".")}`
          : "";
      const label = node.getAttribute("aria-label");
      return `${node.tagName.toLowerCase()}${classes}${label ? `[${label}]` : ""}`;
    }

    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(centerX, centerY);

    // Contêiner rolável real da rota (o <main> do AppShell rola, não o body).
    let scroller: Element | null = element.parentElement;
    while (
      scroller &&
      scroller !== document.body &&
      !(
        scroller.scrollHeight > scroller.clientHeight &&
        ["auto", "scroll"].includes(getComputedStyle(scroller).overflowY)
      )
    ) {
      scroller = scroller.parentElement;
    }
    const scrollerRect = (scroller ?? document.documentElement).getBoundingClientRect();
    const scrollerClientBottom =
      scrollerRect.top + (scroller ?? document.documentElement).clientHeight;

    return {
      width: rect.width,
      height: rect.height,
      centerX,
      centerY,
      hitsSelf: !!hit && (hit === element || element.contains(hit)),
      topElement: describe(hit),
      insideScroller:
        centerY >= scrollerRect.top &&
        centerY <= scrollerClientBottom &&
        centerX >= scrollerRect.left &&
        centerX <= scrollerRect.left + (scroller ?? document.documentElement).clientWidth,
    };
  });
}

async function expectUsableTarget(target: Locator, name: string) {
  await expect(target, `${name} precisa estar visível`).toBeVisible();
  const measured = await measureReachability(target);
  expect(
    { name, ...measured },
    `${name}: alvo de toque menor que ${MIN_TOUCH}px`,
  ).toMatchObject({
    hitsSelf: true,
    insideScroller: true,
  });
  expect(measured.width, `${name}: largura ${measured.width}px`).toBeGreaterThanOrEqual(MIN_TOUCH);
  expect(measured.height, `${name}: altura ${measured.height}px`).toBeGreaterThanOrEqual(MIN_TOUCH);
}

test.describe("#490 — defeitos visíveis medidos em runtime", () => {
  for (const width of [375, 390, 1280]) {
    test(`${width}px — CTA única no estado vazio de cartões e contas`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "desktop",
        "esta spec controla as próprias larguras",
      );
      await page.setViewportSize({ width, height: 844 });
      await mockApi(page);

      await page.goto(`/projects/${reformaId}/credit-cards`);
      await expect(page.getByText("Nenhum cartão cadastrado")).toBeVisible();
      expect(repeated(await visibleActionLabels(page))).toEqual([]);
      await expect(page.getByRole("button", { name: /Novo cartão/ })).toHaveCount(1);
      await expect(
        page.locator('[data-journey-action="credit-card.new"]'),
      ).toHaveCount(1);

      await page.goto(`/projects/${pessoalId}/bank-accounts`);
      await expect(page.getByText("Nenhuma conta cadastrada")).toBeVisible();
      expect(repeated(await visibleActionLabels(page))).toEqual([]);
      await expect(page.getByRole("button", { name: /Nova conta/ })).toHaveCount(1);
      await expect(
        page.locator('[data-journey-action="bank-account.new"]'),
      ).toHaveCount(1);
    });

    test(`${width}px — /conta e /dre carregam sem HTML inválido no console`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "desktop",
        "esta spec controla as próprias larguras",
      );
      await page.setViewportSize({ width, height: 844 });
      const consoleProblems: string[] = [];
      page.on("console", (message) => {
        if (message.type() !== "error" && message.type() !== "warning") return;
        const text = message.text();
        if (/cannot (appear as a descendant|be a descendant)/i.test(text)) {
          consoleProblems.push(text);
        }
      });
      page.on("pageerror", (error) => consoleProblems.push(`pageerror: ${error.message}`));
      await mockApi(page);

      await page.goto(`/projects/${pessoalId}/conta`);
      await expect(page.getByText("Tenho na conta hoje")).toBeVisible();
      await page.waitForTimeout(500);
      expect(consoleProblems, "/conta").toEqual([]);

      await page.goto(`/projects/${pessoalId}/dre`);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(500);
      expect(consoleProblems, "/conta + /dre").toEqual([]);
    });
  }

  for (const width of [375, 390]) {
    test(`${width}px — ações de /receipts e abas de /conta alcançáveis sob o dock`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "desktop",
        "esta spec controla as próprias larguras",
      );
      await page.setViewportSize({ width, height: 844 });
      await mockApi(page);

      await page.goto(`/projects/${pessoalId}/receipts`);
      const lastRow = page.getByTestId("receipt-row").last();
      await expect(lastRow).toBeVisible();
      const menuTrigger = lastRow.getByRole("button", { name: /^Ações/ });
      await expectUsableTarget(
        menuTrigger,
        `receipts: menu de ações da última linha @${width}`,
      );

      // O gatilho ser alcançável não basta: o menu abre para BAIXO, e é a
      // última linha da lista — é exatamente onde o dock morde. Mede-se cada
      // item do menu com a mesma régua.
      await menuTrigger.click();
      for (const label of ["Copiar para outro mês", "Editar rápido", "Excluir"]) {
        await expectUsableTarget(
          page.getByRole("menuitem", { name: label }),
          `receipts: item "${label}" da última linha @${width}`,
        );
      }
      await page.keyboard.press("Escape");

      await page.goto(`/projects/${pessoalId}/conta`);
      for (const label of ["Saídas", "Entradas", "Tudo"]) {
        await expectUsableTarget(
          page.getByRole("button", { name: label, exact: true }),
          `conta: aba ${label} @${width}`,
        );
      }
      for (const label of ["todos", "pago", "a pagar"]) {
        await expectUsableTarget(
          page.getByRole("button", { name: label, exact: true }),
          `conta: filtro ${label} @${width}`,
        );
      }
    });
  }

  test("1280px — /receipts mantém os ícones inline no desktop (sem menu ⋯)", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "esta spec controla as próprias larguras",
    );
    await page.setViewportSize({ width: 1280, height: 800 });
    await mockApi(page);

    await page.goto(`/projects/${pessoalId}/receipts`);
    const lastRow = page.getByTestId("receipt-row").last();
    await expect(lastRow).toBeVisible();
    // O menu "⋯" é uma troca de mobile: no desktop a linha continua com os
    // três ícones inline no hover, como sempre foi.
    await expect(lastRow.getByRole("button", { name: /^Ações/ })).toBeHidden();
    for (const label of ["Copiar para outro mês", "Editar rápido", "Excluir"]) {
      await expect(lastRow.getByRole("button", { name: label })).toBeAttached();
    }
  });

  test("375px — histórico de budget: valor monetário não quebra linha", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "esta spec controla as próprias larguras",
    );
    await page.setViewportSize({ width: 375, height: 844 });
    await mockApi(page);

    await page.goto(`/projects/${pessoalId}/budget-allocation`);
    await expect(
      page.getByRole("heading", { name: "Histórico de Alocações" }),
    ).toBeVisible();

    const measured = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>(
        "[data-allocation-history-scroller]",
      );
      const values = Array.from(
        document.querySelectorAll<HTMLElement>("[data-allocation-value]"),
      ).map((cell) => {
        const rect = cell.getBoundingClientRect();
        // Conta linhas de TEXTO, não altura da célula: a altura da <td> é
        // ditada pela coluna "Projeto" ao lado, então medir `height/lineHeight`
        // mentiria. Um Range devolve uma caixa por line box.
        const range = document.createRange();
        range.selectNodeContents(cell);
        const tops = new Set(
          Array.from(range.getClientRects()).map((r) => Math.round(r.top)),
        );
        return {
          text: (cell.textContent ?? "").trim(),
          right: Math.round(rect.right),
          lines: tops.size,
          whiteSpace: getComputedStyle(cell).whiteSpace,
        };
      });
      return {
        viewport: document.documentElement.clientWidth,
        scrollWidth: scroller?.scrollWidth ?? -1,
        clientWidth: scroller?.clientWidth ?? -1,
        values,
      };
    });

    expect(measured.values.length).toBe(3);
    for (const value of measured.values) {
      expect(value.whiteSpace, `${value.text} não pode quebrar linha`).toBe("nowrap");
      expect(value.lines, `${value.text} ocupa ${value.lines} linha(s)`).toBe(1);
    }

    // O corte horizontal segue ABERTO (ver `test.fixme` abaixo). Anexa-se a
    // medição para que o número apareça no relatório em vez de virar adjetivo.
    await testInfo.attach("d-d-overflow", {
      body: JSON.stringify(
        {
          scrollWidth: measured.scrollWidth,
          clientWidth: measured.clientWidth,
          overflowPx: measured.scrollWidth - measured.clientWidth,
          viewport: measured.viewport,
          valores: measured.values.map((v) => `${v.text} → right ${v.right}px`),
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
  });

  /**
   * D-D — CORTE HORIZONTAL: ABERTO DE PROPÓSITO.
   *
   * Não é ajuste de largura. Medido a 375px: o scrollport tem 269px úteis e o
   * `min-content` da tabela inteira com dados realistas ("R$ 125.000,00",
   * "Apartamento Higienópolis") é ~349px — 80px, 23%, de déficit. Encolher
   * padding para `px-1` e encurtar a data para `dd/mm/aa` chega a ~285px, e
   * volta a estourar no primeiro valor de 6 dígitos ou nome de projeto longo.
   * A saída honesta é a tabela virar lista empilhada (padrão `MovimentacaoRow`)
   * abaixo de `sm`, e isso é decisão de produto — está proposta no PR, não
   * decidida aqui. Este teste é a definição de pronto para quando ela vier.
   */
  test.fixme(
    "375px — coluna Valor do histórico legível sem arrastar na horizontal",
    async ({ page }, testInfo) => {
      test.skip(
        testInfo.project.name !== "desktop",
        "esta spec controla as próprias larguras",
      );
      await page.setViewportSize({ width: 375, height: 844 });
      await mockApi(page);

      await page.goto(`/projects/${pessoalId}/budget-allocation`);
      await expect(
        page.getByRole("heading", { name: "Histórico de Alocações" }),
      ).toBeVisible();

      const measured = await page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>(
          "[data-allocation-history-scroller]",
        );
        return {
          viewport: document.documentElement.clientWidth,
          scrollWidth: scroller?.scrollWidth ?? -1,
          clientWidth: scroller?.clientWidth ?? -1,
          rights: Array.from(
            document.querySelectorAll<HTMLElement>("[data-allocation-value]"),
          ).map((cell) => Math.round(cell.getBoundingClientRect().right)),
        };
      });

      expect(measured.scrollWidth).toBeLessThanOrEqual(measured.clientWidth + 1);
      for (const right of measured.rights) {
        expect(right).toBeLessThanOrEqual(measured.viewport);
      }
    },
  );
});
