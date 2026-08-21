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

/**
 * Dados REALISTAS de propósito (#490 / D-D).
 *
 * Com nomes curtos e valores de 4 dígitos a tabela cabe em 375px e o defeito
 * some do teste sem sumir do produto. O corte real foi medido com valor de 6
 * dígitos ("R$ 125.000,00") e nome longo ("Apartamento Higienópolis"); é esse
 * o pior caso honesto, então é esse o que o teste carrega.
 *
 * A terceira linha vem REDIGIDA (`targetProject: null`) porque a redação
 * cross-tenant é estado real desta tela (#449 B2) e o rótulo de fallback é
 * mais largo que boa parte dos nomes.
 */
const budgetAllocations = [
  {
    id: "alloc-1",
    dataAlocacao: "2026-07-03T12:00:00.000Z",
    mes: "2026-07",
    valor: 125_000_00,
    targetProject: { id: reformaId, name: "Apartamento Higienópolis" },
    descricao: null,
  },
  {
    id: "alloc-2",
    dataAlocacao: "2026-07-14T12:00:00.000Z",
    mes: "2026-07",
    valor: 8_000_00,
    targetProject: { id: reformaId, name: "Reforma Casa da Serra" },
    descricao: "Entrada da marcenaria",
  },
  {
    id: "alloc-3",
    dataAlocacao: "2026-06-22T12:00:00.000Z",
    mes: "2026-06",
    valor: 4_530_00,
    targetProject: null,
    descricao: null,
  },
];

/**
 * O total do resumo SOMA O MESMO CONJUNTO da lista — como o servidor faz.
 *
 * `getSummary` e `findAll` consultam `budgetAllocation` com o mesmo `WHERE`
 * para quem alcança esta tela (o filtro de escopo de `findAll` colapsa em
 * `null` para ADMIN/OWNER, que é o único papel com acesso). Um mock que
 * divergisse aqui inventaria um defeito de dinheiro que o produto não tem —
 * já aconteceu neste issue e custou uma rodada de investigação.
 */
const totalAllocatedMock = budgetAllocations.reduce((sum, a) => sum + a.valor, 0);

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
    // #529: a mesma fixture de recebimentos passa a servir os DOIS projetos.
    // Os testes de `/receipts` migraram para REFORMA (no PESSOAL a rota
    // colapsou), e o que eles medem — a linha, o menu "Ações" e a geometria sob
    // o dock — não depende do tipo nem dos rótulos de `tipo`. Servir o mesmo
    // payload mantém a medição idêntica à de antes.
    if (
      path === `/projects/${pessoalId}/receipts` ||
      path === `/projects/${reformaId}/receipts`
    ) {
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
          totalAllocated: totalAllocatedMock,
          // Valores que reproduzem o defeito do SINAL solto reportado no #490:
          // "+ R$ 206.030,00" e "− R$ 21.000,00" quebravam em duas linhas.
          totalExpenses: 21_000_00,
          totalReceipts: 206_030_00,
          allocations: [
            {
              projectName: "Apartamento Higienópolis",
              projectType: "REFORMA",
              total: 125_000_00,
            },
            {
              projectName: "Reforma Casa da Serra",
              projectType: "REFORMA",
              total: 8_000_00,
            },
            { projectName: null, projectType: null, total: 4_530_00 },
          ],
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

/**
 * Scrollers horizontais REAIS da página.
 *
 * ARMADILHA 1 — `document.documentElement.scrollWidth` mediu **375 nas três
 * telas**, inclusive com a coluna "Valor" cortada. Checar só isso deixaria o
 * defeito passar inteiro: o estouro do #490/D-D não vive no documento, vive
 * DENTRO de um contêiner `overflow-x-auto`. Por isso a varredura desce em
 * todos os descendentes.
 *
 * ARMADILHA 2 — `truncate` do Tailwind é `overflow: hidden` + reticências, e
 * ali `scrollWidth > clientWidth` é a truncagem FUNCIONANDO, não rolagem. Sem
 * o filtro de `overflowX ∈ {auto, scroll}` todo título truncado da tela vira
 * falso positivo (aconteceu no protótipo).
 */
async function realHorizontalScrollers(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector("main") ?? document.body;
    return Array.from(root.querySelectorAll<HTMLElement>("*"))
      .concat(root as HTMLElement)
      .filter((element) => {
        const overflowX = getComputedStyle(element).overflowX;
        if (!["auto", "scroll"].includes(overflowX)) return false;
        if (element.getBoundingClientRect().width === 0) return false;
        return element.scrollWidth > element.clientWidth + 1;
      })
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        classes:
          typeof element.className === "string"
            ? element.className.trim().split(/\s+/).slice(0, 3).join(".")
            : "",
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        overflowPx: element.scrollWidth - element.clientWidth,
      }));
  });
}

interface MoneyToken {
  text: string;
  lines: number;
  right: number;
  left: number;
  insideViewport: boolean;
}

/**
 * Todo token monetário VISÍVEL da página, com quantas linhas ele ocupa.
 *
 * Mede `sinal + valor` juntos, não só o valor: o defeito bônus do #490 é
 * exatamente o "+"/"−" sobrando sozinho numa linha enquanto "R$ 206.030,00"
 * fica inteiro na seguinte. Uma asserção só sobre o número passaria.
 *
 * ARMADILHA 3 — `element.getClientRects().length` devolve 1 para elemento de
 * bloco por mais que o texto quebre; só serve para inline. Um `Range` sobre o
 * trecho monetário devolve uma caixa por line box em qualquer display, então é
 * ele que conta.
 *
 * ARMADILHA 4 — as duas variantes do layout (`sm:hidden` / `hidden sm:block`)
 * coexistem no DOM; a oculta tem caixa 0×0 e passaria em QUALQUER asserção de
 * geometria por vacuidade. Daí o filtro de visibilidade.
 */
async function visibleMoneyTokens(page: Page): Promise<MoneyToken[]> {
  return page.evaluate(() => {
    const MONEY = /[+\-−–]?\s*R\$\s*[\d.,]+/;
    const root = document.querySelector("main") ?? document.body;

    const leaves = Array.from(root.querySelectorAll<HTMLElement>("*")).filter(
      (element) => {
        if (!MONEY.test(element.textContent ?? "")) return false;
        // Só o elemento MAIS INTERNO que carrega o dinheiro.
        if (
          Array.from(element.children).some((child) =>
            MONEY.test(child.textContent ?? ""),
          )
        ) {
          return false;
        }
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      },
    );

    return leaves.flatMap((element) => {
      // `textContent` pode vir de vários text nodes ("+ " e "R$ 206.030,00"
      // são nodes distintos no JSX). Mapeia offset global → (node, offset).
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      const nodes: Array<{ node: Text; start: number }> = [];
      let text = "";
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        nodes.push({ node: n as Text, start: text.length });
        text += n.nodeValue ?? "";
      }
      const match = MONEY.exec(text);
      if (!match || nodes.length === 0) return [];

      const locate = (offset: number) => {
        for (let i = nodes.length - 1; i >= 0; i -= 1) {
          if (offset >= nodes[i].start) {
            return {
              node: nodes[i].node,
              offset: Math.min(
                offset - nodes[i].start,
                nodes[i].node.nodeValue?.length ?? 0,
              ),
            };
          }
        }
        return { node: nodes[0].node, offset: 0 };
      };

      const start = locate(match.index);
      const end = locate(match.index + match[0].length);
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);

      const rects = Array.from(range.getClientRects()).filter(
        (r) => r.width > 0,
      );
      if (rects.length === 0) return [];
      const tops = new Set(rects.map((r) => Math.round(r.top)));
      const viewport = document.documentElement.clientWidth;

      return [
        {
          text: match[0].replace(/\s+/g, " ").trim(),
          lines: tops.size,
          left: Math.round(Math.min(...rects.map((r) => r.left))),
          right: Math.round(Math.max(...rects.map((r) => r.right))),
          insideViewport:
            Math.min(...rects.map((r) => r.left)) >= 0 &&
            Math.max(...rects.map((r) => r.right)) <= viewport + 1,
        },
      ];
    });
  });
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

      await page.goto(`/projects/${reformaId}/bank-accounts`);
      // #529: `/bank-accounts` do PESSOAL agora SEMPRE redireciona ao hub, então
      // a CTA do estado vazio não existe mais lá para ser contada. A propriedade
      // medida (#490 — no vazio a CTA primária é única) é da TELA e independe do
      // tipo, e em REFORMA `hasNavRoute(REFORMA,'conta')` é falso ⇒ `navCollapsed`
      // nunca liga ⇒ a página segue alcançável. Fica simétrico ao `credit-cards`
      // logo acima, que já media em REFORMA.
      await expect(
        page,
        "guarda U4 disparou em REFORMA — a fixture não deveria colapsar aqui",
      ).toHaveURL(new RegExp(`/projects/${reformaId}/bank-accounts`));
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
    // #529 partiu este teste em DOIS. Ele cobria `/receipts` e `/conta` na
    // mesma sessão PESSOAL; agora `/receipts` do PESSOAL sempre redireciona ao
    // hub, e `/conta` só existe no PESSOAL. Os destinos ficaram em tipos
    // diferentes, então uma navegação só não alcança os dois. A régua
    // (`expectUsableTarget`) e as duas propriedades são as de antes.
    test(`${width}px — ações de /receipts alcançáveis sob o dock`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "desktop",
        "esta spec controla as próprias larguras",
      );
      await page.setViewportSize({ width, height: 844 });
      await mockApi(page);

      // REFORMA: `receipts` segue no nav do tipo (destino de primeira classe),
      // e `MobileReceiptList` é gated por `viewMode`, não por tipo — a mesma
      // lista que era medida no PESSOAL.
      await page.goto(`/projects/${reformaId}/receipts`);
      await expect(
        page,
        "guarda U4 disparou em REFORMA — a fixture não deveria colapsar aqui",
      ).toHaveURL(new RegExp(`/projects/${reformaId}/receipts`));
      // ANTI-VACUIDADE, e aqui ela é obrigatória: a régua deste teste é "não
      // ser mordido pelo dock", e o dock de REFORMA é OUTRO chassi — o
      // `MobileTabBar` ramifica em `hasFeature(type,'monthlyOverview')`, que é
      // falso fora do PESSOAL. O ramo genérico não tem launcher e faz
      // `if (primary.length === 0) return null`. Sem esta linha, um dock ausente
      // faria o teste passar por vazio.
      await expect(
        page.locator('[data-dock="minimal"]'),
        "sem dock na tela, medir 'alcançável sob o dock' seria verde vazio",
      ).toBeVisible();
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
    });

    test(`${width}px — abas de /conta alcançáveis sob o dock`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "desktop",
        "esta spec controla as próprias larguras",
      );
      await page.setViewportSize({ width, height: 844 });
      await mockApi(page);

      // `/conta` é o hub do PESSOAL — não existe em REFORMA. Continua aqui.
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

    // #529: mesma migração do teste de ações — `/receipts` do PESSOAL sempre
    // redireciona; a propriedade (no desktop a linha mantém os ícones inline,
    // sem menu "⋯") é da TELA e independe do tipo.
    await page.goto(`/projects/${reformaId}/receipts`);
    await expect(
      page,
      "guarda U4 disparou em REFORMA — a fixture não deveria colapsar aqui",
    ).toHaveURL(new RegExp(`/projects/${reformaId}/receipts`));
    const lastRow = page.getByTestId("receipt-row").last();
    await expect(lastRow).toBeVisible();
    // O menu "⋯" é uma troca de mobile: no desktop a linha continua com os
    // três ícones inline no hover, como sempre foi.
    await expect(lastRow.getByRole("button", { name: /^Ações/ })).toBeHidden();
    for (const label of ["Copiar para outro mês", "Editar rápido", "Excluir"]) {
      await expect(lastRow.getByRole("button", { name: label })).toBeAttached();
    }
  });

  /**
   * A tabela do histórico continua sendo o layout de `sm` para cima, e ali a
   * regra da casa também vale. Este teste roda a 1280px de propósito: abaixo
   * de `sm` a tabela é `display:none` e as células mediriam 0×0 — asserção
   * sobre caixa zerada passa por vacuidade, não por acerto.
   */
  test("1280px — a tabela do histórico mantém cada valor em uma linha", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await mockApi(page);

    await page.goto(`/projects/${pessoalId}/budget-allocation`);
    await expect(
      page.getByRole("heading", { name: "Histórico de Alocações" }),
    ).toBeVisible();

    const values = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>("[data-allocation-value]"),
      ).map((cell) => {
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
          lines: tops.size,
          whiteSpace: getComputedStyle(cell).whiteSpace,
          width: Math.round(cell.getBoundingClientRect().width),
        };
      }),
    );

    expect(values.length).toBe(budgetAllocations.length);
    for (const value of values) {
      expect(value.width, `${value.text} precisa estar visível`).toBeGreaterThan(0);
      expect(value.whiteSpace, `${value.text} não pode quebrar linha`).toBe("nowrap");
      expect(value.lines, `${value.text} ocupa ${value.lines} linha(s)`).toBe(1);
    }
  });

  /**
   * D-D — o corte horizontal do histórico, agora FECHADO.
   *
   * Antes (375px): o scroller `overflow-x-auto` media clientWidth 269 vs
   * scrollWidth 372 (+103px) e cada valor terminava em `right` 425 contra
   * viewport 375 — 50px fora da tela. O `min-content` da tabela com dados
   * reais é ~372px e o espaço útil, mesmo zerando TODO padding, chega a 341px:
   * ajuste de largura não fechava a conta, por isso a tabela virou lista
   * empilhada abaixo de `sm` (padrão `MovimentacaoRow`).
   */
  test("375px — histórico legível sem arrastar na horizontal", async ({
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

    // 1. Nenhum scroller horizontal REAL — a asserção que pega o defeito.
    //    `documentElement.scrollWidth` era 375 mesmo com a coluna cortada.
    const scrollers = await realHorizontalScrollers(page);
    expect(
      scrollers,
      `rolagem horizontal viva: ${JSON.stringify(scrollers)}`,
    ).toEqual([]);

    const documentOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(documentOverflow.scrollWidth).toBeLessThanOrEqual(
      documentOverflow.innerWidth,
    );

    // 2. Todo valor da lista dentro do viewport, em uma linha só.
    const money = await visibleMoneyTokens(page);
    expect(money.length).toBeGreaterThanOrEqual(budgetAllocations.length);
    for (const token of money) {
      expect(token.lines, `${token.text} ocupa ${token.lines} linha(s)`).toBe(1);
      expect(
        token.insideViewport,
        `${token.text} termina em right ${token.right}px`,
      ).toBe(true);
    }

    // 3. As linhas são alcançáveis de fato: rola o contêiner real, mede a
    //    caixa e pergunta ao navegador quem está no centro dela.
    const rows = page.locator("[data-allocation-row]");
    await expect(rows).toHaveCount(budgetAllocations.length);
    for (let i = 0; i < budgetAllocations.length; i += 1) {
      const measured = await measureReachability(rows.nth(i));
      expect(measured, `linha ${i + 1} do histórico`).toMatchObject({
        hitsSelf: true,
        insideScroller: true,
      });
      expect(measured.width).toBeGreaterThan(0);
    }

    await testInfo.attach("d-d-depois", {
      body: JSON.stringify({ scrollers, documentOverflow, money }, null, 2),
      contentType: "application/json",
    });
  });

  /**
   * D-D — o conteúdo não some, só muda de peso.
   *
   * "Nada sai" foi decisão explícita: numa trilha de auditoria congelada,
   * apagar campo é decisão de dado, não de layout. Data, projeto e mês de
   * referência continuam legíveis na lista.
   */
  test("375px — a lista preserva data, projeto e mês de referência", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "esta spec controla as próprias larguras",
    );
    await page.setViewportSize({ width: 375, height: 844 });
    await mockApi(page);

    await page.goto(`/projects/${pessoalId}/budget-allocation`);
    const rows = page.locator("[data-allocation-row]");
    await expect(rows).toHaveCount(budgetAllocations.length);

    await expect(rows.nth(0)).toContainText("Apartamento Higienópolis");
    await expect(rows.nth(0)).toContainText("03 jul");
    await expect(rows.nth(0)).toContainText("ref. jul/2026");
    await expect(rows.nth(0)).toContainText("R$ 125.000,00");

    await expect(rows.nth(1)).toContainText("Entrada da marcenaria");
    // Linha redigida (#449 B2): o valor continua, a identidade do alvo não.
    await expect(rows.nth(2)).toContainText("Projeto indisponível");
    await expect(rows.nth(2)).toContainText("R$ 4.530,00");
    await expect(rows.nth(2)).toContainText("ref. jun/2026");
  });

  /**
   * D-D — o desktop não regride.
   *
   * A tabela continua sendo o layout de `sm` para cima e a lista não aparece.
   * As duas variantes coexistem no DOM (o corte é por CSS, não por JS — media
   * query em JS traria descasamento de hidratação), então o que se conta é
   * dinheiro VISÍVEL: se a lista vazasse no desktop, apareceriam 6 valores.
   */
  for (const width of [640, 768, 1280]) {
    test(`${width}px — histórico continua em tabela, sem duplicar valor`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "desktop",
        "esta spec controla as próprias larguras",
      );
      await page.setViewportSize({ width, height: 900 });
      await mockApi(page);

      await page.goto(`/projects/${pessoalId}/budget-allocation`);
      await expect(
        page.getByRole("heading", { name: "Histórico de Alocações" }),
      ).toBeVisible();

      await expect(page.locator("table")).toBeVisible();
      // As duas variantes coexistem no DOM (corte por CSS): o que não pode
      // existir é linha de lista VISÍVEL. `:visible` respeita `display:none`.
      await expect(page.locator("[data-allocation-row]:visible")).toHaveCount(0);
      await expect(page.locator("[data-allocation-row]")).toHaveCount(
        budgetAllocations.length,
      );

      const historyMoney = await page.evaluate(
        () =>
          Array.from(
            document.querySelectorAll<HTMLElement>("[data-allocation-value]"),
          ).filter((cell) => cell.getBoundingClientRect().width > 0).length,
      );
      expect(historyMoney).toBe(budgetAllocations.length);

      const scrollers = await realHorizontalScrollers(page);
      expect(
        scrollers,
        `rolagem horizontal viva em ${width}px: ${JSON.stringify(scrollers)}`,
      ).toEqual([]);
    });
  }

  /**
   * BÔNUS #490 — o sinal quebrando linha no card "Resumo do Budget".
   *
   * Antes: "+ R$ 206.030,00" e "− R$ 21.000,00" mediam
   * `getClientRects().length === 2` — o "+"/"−" ficava sozinho numa linha e o
   * valor inteiro na seguinte. A regra da casa é que valor monetário não
   * quebra linha, e o `MovimentacaoRow` canônico já resolve isso mantendo
   * sinal e número dentro do MESMO `whitespace-nowrap`.
   *
   * A varredura é da PÁGINA inteira, não só do histórico: foi assim que o
   * defeito apareceu, num card que ninguém estava olhando.
   */
  for (const width of [375, 390, 1280]) {
    test(`${width}px — nenhum valor monetário da página quebra linha`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "desktop",
        "esta spec controla as próprias larguras",
      );
      await page.setViewportSize({ width, height: 900 });
      await mockApi(page);

      await page.goto(`/projects/${pessoalId}/budget-allocation`);
      await expect(
        page.getByRole("heading", { name: "Resumo do Budget" }),
      ).toBeVisible();

      const money = await visibleMoneyTokens(page);
      expect(money.length).toBeGreaterThan(0);
      const broken = money.filter((token) => token.lines !== 1);
      expect(
        broken,
        `valores quebrados em ${width}px: ${JSON.stringify(broken)}`,
      ).toEqual([]);

      const signed = money.filter((token) => /^[+\-−–]/.test(token.text));
      expect(
        signed.length,
        "o card precisa mostrar recebimentos (+) e despesas (−)",
      ).toBeGreaterThanOrEqual(2);
    });
  }

  /**
   * "Total Alocado" aparecia DUAS vezes na mesma tela: no card (vindo de
   * `GET /budget-allocations/summary/:id`) e no rodapé do histórico, ali
   * somado no template com `allocations.reduce(...)`.
   *
   * Os dois mediam a MESMA coisa — `getSummary` e `findAll` consultam o mesmo
   * `WHERE` para quem alcança esta tela. Só que a igualdade era ACIDENTAL:
   * `findAll` carrega um filtro de escopo do requisitante que `getSummary` não
   * tem, e eles coincidem apenas porque o portão de leitura (ADMIN/OWNER
   * não-convidado) faz esse escopo colapsar em `null`. Afrouxar a permissão
   * faria os dois números divergirem em silêncio, sob rótulo idêntico.
   *
   * Dois rótulos iguais já são defeito quando os números batem: obrigam o
   * usuário a conferir se batem. O rodapé saiu.
   */
  test("375px — 'Total Alocado' aparece uma vez só", async ({
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

    const occurrences = await page.evaluate(() =>
      Array.from(
        (document.querySelector("main") ?? document.body).querySelectorAll("*"),
      ).filter(
        (element) =>
          element.children.length === 0 &&
          /Total Alocado/i.test(element.textContent ?? "") &&
          element.getBoundingClientRect().width > 0,
      ).length,
    );
    expect(occurrences).toBe(1);
  });
});

