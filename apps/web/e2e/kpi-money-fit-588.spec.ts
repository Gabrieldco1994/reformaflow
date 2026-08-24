import { expect, test, type Page } from "@playwright/test";

/**
 * #588 — o valor monetário do cockpit quebrava linha e perdia dígito.
 *
 * A #578 reservou 408px do viewport para o painel do Copiloto
 * (`main.minimal-main` ganhou `lg:pr-[408px]`). O conteúdo caiu para 784px em
 * 1280 e o `<p>` do valor do KPI — que nunca teve `whitespace-nowrap`,
 * contrariando o contrato do `AGENTS.md` — passou a quebrar:
 *
 * - `Carteira (dinheiro)`, `-R$ 123.456,78`: `getClientRects().length === 2`,
 *   com o `-` SOZINHO na primeira linha. Saldo negativo lido como positivo.
 * - `Saiu no mês`: `scrollWidth 137` contra `clientWidth 83` — o texto vazava
 *   para dentro do tile vizinho e o navegador exibia `R$ 12.795,6`, sem o `7`.
 *
 * POR QUE O GATE ANTERIOR FOI CEGO: `cockpit-shell-census.spec.ts` media um
 * cockpit sem dados, onde todo KPI é `R$ 0,00` (7 caracteres) e cabe em
 * qualquer largura. Aqui os valores são LONGOS de propósito (6 dígitos +
 * centavos, um deles negativo) — é a única forma de o teste enxergar o defeito.
 *
 * O que se assere é RUNTIME, não classe CSS: número de linhas do `Range`,
 * transbordo (`scrollWidth <= clientWidth`), invasão do tile vizinho e — o que
 * pega dígito perdido — o TEXTO renderizado comparado com a string formatada
 * esperada. Uma classe certa não prova que o número cabe.
 */

const PROJECT_ID = "kpi-fit-588";

/** Larguras onde a medição da #588 acusou transbordo (1680/1920 já cabiam). */
const WIDTHS = [1280, 1366, 1440, 1536] as const;

/**
 * Valores de 6 dígitos + centavos, distintos entre si para que um dígito
 * trocado/perdido não passe despercebido por coincidência de string.
 * `caixaHoje: 0` + `carteiraHoje != 0` é o que liga o modo Carteira, que é o
 * card de 34px onde o sinal ficava órfão.
 */
const CENTS = {
  caixaHoje: 0,
  carteiraHoje: -12_345_678,
  entrouMes: 23_456_789,
  saiuMes: 34_567_891,
  faltaPagarMes: 45_678_912,
  sobraPrevista: -56_789_123,
} as const;

function brl(cents: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(cents / 100);
}

const accountView = {
  caixaHoje: CENTS.caixaHoje,
  entrouMes: CENTS.entrouMes,
  saiuMes: CENTS.saiuMes,
  // #577 tornou `saidaTotal` a fonte canônica do "Saiu" (consolida todas as
  // contas). Sem ela o tile renderiza R$ 0,00 e o gate mediria um valor curto —
  // exatamente o furo que deixou a #588 passar.
  saidaTotal: CENTS.saiuMes,
  faltaPagarMes: CENTS.faltaPagarMes,
  recebimentosPrevistosMes: 5_050_500,
  sobraPrevista: CENTS.sobraPrevista,
  carteiraHoje: CENTS.carteiraHoje,
  saiuSemConta: 8_900,
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

const monthlyOverview = {
  mesAtual: "2026-07",
  meses: [],
  comparativo: {
    current: null,
    previous: null,
    deltaDespesas: 0,
    deltaDespesasPct: null,
    deltaRecebimentos: 0,
    deltaRecebimentosPct: null,
    deltaSaldo: 0,
  },
  mesAtualEntries: [],
  entries: [],
  projetos: [{ id: PROJECT_ID, name: "Projeto Pessoal", type: "PESSOAL" }],
};

const dreOverview = {
  mensal: { mes: "2026-07" },
  anual: { saldoAcumuladoSerie: [], candidatos: [] },
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
    {
      name: "rf_token",
      value: PROJECT_ID,
      url: `http://localhost:${process.env.PLAYWRIGHT_PORT ?? 3013}`,
    },
  ]);

  await page.route("http://localhost:3001/**", async (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/auth/me") {
      return route.fulfill(
        json({
          id: `${PROJECT_ID}-user`,
          username: PROJECT_ID,
          name: "Ana",
          role: "ADMIN",
          tenantId: `${PROJECT_ID}-tenant`,
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

/**
 * ─── /cash-flow: o tile mais apertado do app com o Copiloto aberto ───────────
 *
 * A varredura das 12 telas que consomem `KpiTile` (registrada na PR #592)
 * achou UM caso sem margem confortável: `/cash-flow` em projeto NÃO-PESSOAL,
 * onde `CashFlowKpiHeader` usa `lg:grid-cols-4`. Com os 408px do Copiloto
 * reservados, cada tile fica com `clientWidth` 164 em 1280 — contra 230+ das
 * demais telas (3 colunas). É o único número da varredura que é LIMITE, não
 * margem, e por isso vira barreira aqui: a #588 nasceu justamente de um gate
 * que só media o caso folgado (cockpit inteiro em `R$ 0,00`).
 *
 * Diferença de formatação relevante: `/cash-flow` renderiza `moneyGlance`
 * (abreviado — `-R$ 999,9 mi`), não o formato cheio do cockpit. Os valores
 * abaixo são os que produzem a string MAIS LARGA que essa tela consegue
 * emitir, e vêm do MOCK (não de substituição de `textContent` em runtime):
 * é a entrada do componente que sobrevive a um refactor de formatação.
 */
const CF_PROJECT_ID = "kpi-fit-588-cf";

/**
 * `moneyGlance` abrevia: ≥ 1 mi ⇒ `R$ X,Y mi` com uma casa decimal. A string
 * mais larga possível tem 3 dígitos na parte inteira + decimal + sufixo + o
 * sinal negativo (o mesmo sinal que ficava órfão na #588).
 */
const CF_CENTS = {
  /** `rollingBalance` do último entry ⇒ "Fluxo projetado". */
  saldoProjetado: -99_994_900_000,
  /** `rollingBalanceRealizado` do último entry ⇒ "Fluxo realizado". */
  saldoRealizado: -88_886_600_000,
  /** Soma dos RECEBIMENTO ⇒ "Entradas". */
  entradas: 77_775_500_000,
  /** Soma dos DESPESA ⇒ "Saídas". */
  saidas: 66_664_400_000,
} as const;

/**
 * Strings esperadas, escritas à mão de propósito: é a comparação de string que
 * pega dígito perdido. Se `moneyGlance` mudar de regra, este teste falha alto —
 * que é o comportamento desejado para um contrato de exibição de dinheiro.
 */
const CF_EXPECTED: Array<{ label: string; text: string }> = [
  { label: "Fluxo projetado", text: "-R$ 999,9 mi" },
  { label: "Fluxo realizado", text: "-R$ 888,9 mi" },
  { label: "Entradas", text: "R$ 777,8 mi" },
  { label: "Saídas", text: "R$ 666,6 mi" },
];

const cashFlowEntries = [
  {
    id: "cf-1",
    data: "2026-07-02",
    tipo: "RECEBIMENTO",
    valor: CF_CENTS.entradas,
    status: "EM_CAIXA",
    titulo: "Aporte",
    rollingBalance: CF_CENTS.entradas,
    rollingBalanceRealizado: CF_CENTS.entradas,
  },
  {
    id: "cf-2",
    data: "2026-07-10",
    tipo: "DESPESA",
    valor: CF_CENTS.saidas,
    status: "PAGO",
    titulo: "Empreiteiro",
    // O KPI lê os rolling* do ÚLTIMO entry — são eles que definem as duas
    // primeiras colunas, independentemente das somas acima.
    rollingBalance: CF_CENTS.saldoProjetado,
    rollingBalanceRealizado: CF_CENTS.saldoRealizado,
  },
];

async function mockCashFlowApi(page: Page) {
  await page.clock.setFixedTime(new Date("2026-07-15T12:00:00.000Z"));
  await page.context().addCookies([
    {
      name: "rf_token",
      value: CF_PROJECT_ID,
      url: `http://localhost:${process.env.PLAYWRIGHT_PORT ?? 3013}`,
    },
  ]);

  const project = {
    id: CF_PROJECT_ID,
    name: "Obra Centro",
    // NÃO-PESSOAL é pré-condição: só aí `CashFlowKpiHeader` abre as 4 colunas
    // (`lg:grid-cols-4`) que produzem o tile de 164px.
    type: "REFORMA",
    onboardedAt: "2026-01-01T00:00:00.000Z",
  };

  await page.route("http://localhost:3001/**", async (route) => {
    const path = new URL(route.request().url()).pathname;

    if (path === "/auth/me") {
      return route.fulfill(
        json({
          id: `${CF_PROJECT_ID}-user`,
          username: CF_PROJECT_ID,
          name: "Ana",
          role: "ADMIN",
          tenantId: `${CF_PROJECT_ID}-tenant`,
          allowedModules: [],
          allowedProjects: [],
          allowedProjectTypes: [],
        }),
      );
    }
    if (path === "/projects") return route.fulfill(json([project]));
    if (path === `/projects/${CF_PROJECT_ID}`) return route.fulfill(json(project));
    if (path === `/projects/${CF_PROJECT_ID}/cash-flow`) {
      return route.fulfill(json(cashFlowEntries));
    }
    return route.fulfill(json([]));
  });
}

interface ValueMetrics {
  text: string;
  lines: number;
  clientWidth: number;
  scrollWidth: number;
  fontSize: number;
  right: number;
  textWidth: number;
  whiteSpace: string;
}

/**
 * `Range.getClientRects()` sobre o conteúdo do `<p>` é o que enxerga a quebra
 * de linha: `element.getBoundingClientRect()` devolve UM retângulo mesmo com o
 * texto em duas linhas, e um teste montado nele passaria verde com o `-` órfão.
 */
async function readValue(page: Page, label: string): Promise<ValueMetrics> {
  const el = page.locator(`[data-kpi-value="${label}"]`);
  await expect(el).toBeVisible();
  return el.evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0);
    return {
      text: (node.textContent ?? "").trim(),
      lines: rects.length,
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth,
      fontSize: Number.parseFloat(getComputedStyle(node).fontSize),
      right: rects.length ? Math.max(...rects.map((r) => r.right)) : 0,
      textWidth: rects.length ? Math.max(...rects.map((r) => r.width)) : 0,
      whiteSpace: getComputedStyle(node).whiteSpace,
    };
  });
}

async function openCopilot(page: Page) {
  // Espera a hidratação ANTES de clicar: um clique no FAB ainda estático não
  // registra handler nenhum e o painel fica fechado — o teste mediria o
  // cockpit folgado e passaria verde com o defeito ativo.
  await expect(page.locator("[data-kpi-value]").first()).toBeVisible();
  const openButton = page.getByLabel("Abrir Copiloto Financeiro");
  await expect(openButton).toBeVisible();
  await openButton.click();
  await expect(openButton).toHaveCount(0);

  // A reserva da #578 é PRÉ-CONDIÇÃO desta medição: sem os 408px o conteúdo
  // volta a ter largura folgada e o teste deixaria de exercitar o aperto.
  await expect
    .poll(() =>
      page
        .locator("main.minimal-main")
        .evaluate((m) => Number.parseFloat(getComputedStyle(m).paddingRight)),
    )
    .toBe(408);
}

const EXPECTED: Array<{ key: keyof typeof CENTS; label: string }> = [
  { key: "carteiraHoje", label: "Carteira (dinheiro)" },
  { key: "entrouMes", label: "Entrou no mês" },
  { key: "saiuMes", label: "Saiu no mês" },
  { key: "faltaPagarMes", label: "Ainda falta pagar" },
  { key: "sobraPrevista", label: "Sobra prevista" },
];

test.describe("#588 — valor monetário do cockpit cabe em uma linha", () => {
  test("valores de 6 dígitos com o Copiloto aberto em 1280/1366/1440/1536", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "a reserva do Copiloto é `lg:` — no mobile o painel nem existe",
    );
    await mockApi(page);

    const report: string[] = [];

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/projects/${PROJECT_ID}/conta`);
      await openCopilot(page);

      for (const { key, label } of EXPECTED) {
        const expected = brl(CENTS[key]);
        const m = await readValue(page, label);
        report.push(
          `${width} · ${label}: text="${m.text}" lines=${m.lines} client=${m.clientWidth} scroll=${m.scrollWidth} font=${m.fontSize}`,
        );

        // 1. Nenhum dígito perdido — string contra string, não screenshot.
        expect(
          m.text,
          `${width}px · ${label}: texto renderizado difere do formatado`,
        ).toBe(expected);

        // 2. Uma linha só: o `-` não pode ficar órfão acima do número.
        expect(
          m.lines,
          `${width}px · ${label}: valor quebrou em ${m.lines} linhas`,
        ).toBe(1);

        // "Uma linha" hoje pode ser sorte de largura; o contrato do AGENTS.md é
        // que valor monetário NÃO quebra. Sem a declaração, o primeiro rótulo
        // mais longo ou troca de fonte devolve o `-` órfão.
        expect(
          m.whiteSpace,
          `${width}px · ${label}: valor monetário sem nowrap`,
        ).toBe("nowrap");

        // 3. Sem transbordo: nada vaza para fora da caixa (nem é cortado).
        expect(
          m.scrollWidth,
          `${width}px · ${label}: transborda ${m.scrollWidth - m.clientWidth}px`,
        ).toBeLessThanOrEqual(m.clientWidth);
      }

      // 4. O valor não invade o tile vizinho: a borda direita do texto fica
      //    dentro do próprio card.
      for (const { label } of EXPECTED) {
        const overflow = await page
          .locator(`[data-kpi-value="${label}"]`)
          .evaluate((node) => {
            const card = node.closest("article");
            if (!card) return 0;
            const range = document.createRange();
            range.selectNodeContents(node);
            const rects = Array.from(range.getClientRects()).filter(
              (r) => r.width > 0,
            );
            const right = rects.length
              ? Math.max(...rects.map((r) => r.right))
              : 0;
            return right - card.getBoundingClientRect().right;
          });
        expect(
          overflow,
          `${width}px · ${label}: texto ultrapassa a borda do card em ${overflow}px`,
        ).toBeLessThanOrEqual(0);
      }

      // 5. A página não ganha scroll horizontal por causa do aperto.
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
      ).toBe(true);
    }

    await testInfo.attach("kpi-fit-588", {
      body: report.join("\n"),
      contentType: "text/plain",
    });
  });

  test("com o Copiloto fechado o valor continua íntegro em uma linha", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "cenário desktop com o painel disponível",
    );
    await mockApi(page);
    // As mesmas quatro larguras: com o painel fechado a faixa fica larga e
    // segue com 4 colunas — este é o lado do gate que protege o layout ATUAL
    // de uma "correção" que reflua o cockpit sem necessidade.
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/projects/${PROJECT_ID}/conta`);
      for (const { key, label } of EXPECTED) {
        const m = await readValue(page, label);
        expect(m.text, `${width}px · ${label}`).toBe(brl(CENTS[key]));
        expect(m.lines, `${width}px · ${label}`).toBe(1);
        expect(
          m.scrollWidth,
          `${width}px · ${label}`,
        ).toBeLessThanOrEqual(m.clientWidth);
      }
    }
  });

  test("mobile 390/375 mantém o valor íntegro (lá o Copiloto nem monta)", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "mobile",
      "cenário mobile",
    );
    await mockApi(page);
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 375, height: 667 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto(`/projects/${PROJECT_ID}/conta`);
      for (const { key, label } of EXPECTED) {
        const m = await readValue(page, label);
        expect(m.text, `${viewport.width}px · ${label}`).toBe(brl(CENTS[key]));
        expect(m.lines, `${viewport.width}px · ${label}`).toBe(1);
        expect(
          m.scrollWidth,
          `${viewport.width}px · ${label}`,
        ).toBeLessThanOrEqual(m.clientWidth);
      }
    }
  });
  test("/cash-flow (4 colunas, tile de 164px) cabe com o Copiloto aberto", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "a reserva do Copiloto é `lg:` — no mobile o painel nem existe",
    );
    await mockCashFlowApi(page);

    const report: string[] = [];

    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(`/projects/${CF_PROJECT_ID}/cash-flow`);
      await openCopilot(page);

      for (const { label, text } of CF_EXPECTED) {
        const m = await readValue(page, label);
        report.push(
          `${width} · ${label}: text="${m.text}" lines=${m.lines} client=${m.clientWidth} texto=${Math.round(m.textWidth)} folga=${Math.round(m.clientWidth - m.textWidth)} font=${m.fontSize}`,
        );

        // 1. Nenhum dígito perdido — string contra string.
        expect(
          m.text,
          `${width}px · ${label}: texto renderizado difere do esperado`,
        ).toBe(text);

        // 2. Uma linha só: sem `nowrap` a quebra cai depois do `R$ `, deixando
        //    o sinal negativo órfão na primeira linha — o defeito da #588.
        expect(
          m.lines,
          `${width}px · ${label}: valor quebrou em ${m.lines} linhas`,
        ).toBe(1);

        // 3. Sem transbordo: este é o tile mais estreito do app.
        expect(
          m.scrollWidth,
          `${width}px · ${label}: transborda ${m.scrollWidth - m.clientWidth}px`,
        ).toBeLessThanOrEqual(m.clientWidth);

        // 4. E a declaração, que aqui é a assertiva SENSÍVEL: com `moneyGlance`
        //    a string mais larga desta tela mede 118px contra os 164px do tile
        //    em 1280 — 46px de folga, então a geometria sozinha continuaria
        //    verde se alguém removesse o `whitespace-nowrap` (medido). O que
        //    protege /cash-flow é o contrato do AGENTS.md declarado; a
        //    geometria acima é a barreira para o dia em que entrar uma 5ª
        //    coluna, uma fonte maior ou um formato menos abreviado.
        expect(
          m.whiteSpace,
          `${width}px · ${label}: valor monetário sem nowrap`,
        ).toBe("nowrap");
      }
    }

    await testInfo.attach("kpi-fit-588-cash-flow", {
      body: report.join("\n"),
      contentType: "text/plain",
    });
  });
});
