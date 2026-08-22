import { expect, test, type Page } from "@playwright/test";

/**
 * `/conta` — censo de nomes acessíveis EM RUNTIME, nos dois viewports.
 *
 * Por que Playwright e não jsdom: metade dos controles desta tela é
 * `hidden md:flex` ou `md:hidden`. jsdom não faz layout, então os dois mundos
 * coexistem no DOM e um censo lá acusa duplicata que nenhum usuário vê — ou
 * pior, passa por engano. Aqui o censo só conta o que o layout de verdade
 * mostra (`:visible`), no viewport de verdade.
 *
 * Dois defeitos medidos por QA independente e reproduzidos aqui:
 *
 *  A1 — CINCO botões com `aria-label="Ajuda"` idêntico (os "ⓘ" dos KPIs). Cada
 *       um abre um texto diferente; para leitor de tela são cinco entradas
 *       indistinguíveis na lista de controles. A raiz era `InfoHint`, cujo
 *       fallback era só "Ajuda", e `KpiTile`, que não passava contexto.
 *
 *  A2 — DOIS controles chamados "Projetos": o link de navegação da sidebar
 *       (leva para `/projects`) e o toggle de agrupamento da lista de
 *       lançamentos (não navega, reagrupa). Mesmo nome, destinos opostos. O
 *       link é contrato de navegação (#450, `data-nav-group`), então quem muda
 *       de nome é o toggle.
 */

const PROJECT_ID = "dedup-qa-conta";
const MONTH = "2026-08";

function json(body: unknown, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

const accountView = {
  mesSelecionado: MONTH,
  caixaHoje: 5_000_00,
  entrouMes: 3_000_00,
  saiuMes: 1_200_00,
  faltaPagarMes: 800_00,
  recebimentosPrevistosMes: 0,
  sobraPrevista: 7_000_00,
  devoCartaoTotal: 0,
  cartoes: [],
  contas: [{ accountId: "acct-1", last4: "1881", nome: "Itaú QA" }],
  saidas: [
    {
      id: "saida-1",
      kind: "saida",
      descricao: "Mercado",
      data: `${MONTH}-05T12:00:00.000Z`,
      forma: "debito",
      valor: 1_200_00,
      realizado: true,
      status: "PAGO",
      cardId: null,
      cardLast4: null,
      bankLast4: "1881",
      tipoDespesa: "OUTROS",
      isInvoice: false,
      editavel: true,
      dueMonth: MONTH,
      projetoOrigem: null,
      foreignExpenseId: null,
      actions: [],
      fingerprint: null,
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

async function mockConta(page: Page) {
  await page
    .context()
    .addCookies([{ name: "rf_token", value: "dedup-qa", domain: "localhost", path: "/" }]);

  await page.route("http://localhost:3001/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/auth/me")
      return route.fulfill(
        json({
          id: "dedup-qa-user",
          username: "dedup-qa",
          name: "QA Dedup",
          role: "ADMIN",
          tenantId: "dedup-qa-tenant",
          allowedModules: [],
          allowedProjects: [],
          allowedProjectTypes: [],
        }),
      );
    if (path === "/auth/config")
      return route.fulfill(json({ registerEnabled: false, guestEnabled: false }));
    if (path === "/projects")
      return route.fulfill(json([{ id: PROJECT_ID, name: "Pessoal QA", type: "PESSOAL" }]));
    if (path === `/projects/${PROJECT_ID}`)
      return route.fulfill(
        json({
          id: PROJECT_ID,
          name: "Pessoal QA",
          type: "PESSOAL",
          onboardedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    if (path === `/projects/${PROJECT_ID}/monthly-overview/account-view`)
      return route.fulfill(json(accountView));
    if (path === `/projects/${PROJECT_ID}/monthly-overview/dre-overview`)
      return route.fulfill(json({ anual: { saldoAcumuladoSerie: [] } }));
    return route.fulfill(json([]));
  });
}

/**
 * Nome anunciado de cada controle VISÍVEL, medido no navegador.
 *
 * `innerText` (não `textContent`) porque só ele respeita `display:none` — um
 * rótulo escondido dentro de um botão visível não é anunciado como parte do
 * nome pelo layout, e contá-lo produziria colisão fantasma.
 */
async function visibleNameCensus(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("button, a[href]")]
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .map((el) => {
        const aria = el.getAttribute("aria-label");
        if (aria && aria.trim()) return aria.trim();
        return ((el as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim();
      })
      .filter(Boolean),
  );
}

function duplicates(names: string[]): string[] {
  return [...new Set(names.filter((name, i) => names.indexOf(name) !== i))];
}

async function openConta(page: Page) {
  await mockConta(page);
  await page.goto(`/projects/${PROJECT_ID}/conta?month=${MONTH}`);
  // Os KPIs só existem depois que `account-view` responde.
  await expect(page.getByText("Entrou no mês").first()).toBeVisible({ timeout: 15_000 });
}

test.describe("/conta — nenhum nome acessível designa duas ações", () => {
  for (const width of [375, 390]) {
    test(`A1 · alvos de ajuda têm pelo menos 44×44 em ${width}px`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "desktop",
        "viewports are explicitly owned by this test",
      );
      await page.setViewportSize({ width, height: 844 });
      await openConta(page);

      const ajudas = page.locator('button[aria-label^="Ajuda sobre"]:visible');
      await expect(ajudas).toHaveCount(5);
      const dimensoes = await ajudas.evaluateAll((elements) =>
        elements.map((element) => {
          const { width, height } = element.getBoundingClientRect();
          const slot = element.parentElement?.getBoundingClientRect();
          const icon = element.querySelector("svg")?.getBoundingClientRect();
          return {
            width,
            height,
            slotWidth: slot?.width,
            slotHeight: slot?.height,
            iconWidth: icon?.width,
            iconHeight: icon?.height,
          };
        }),
      );
      for (const dimensao of dimensoes) {
        expect(dimensao.width).toBeGreaterThanOrEqual(44);
        expect(dimensao.height).toBeGreaterThanOrEqual(44);
        expect(dimensao.slotWidth).toBe(16);
        expect(dimensao.slotHeight).toBe(16);
        expect(dimensao.iconWidth).toBe(14);
        expect(dimensao.iconHeight).toBe(14);
      }

      await ajudas.first().focus();
      await expect(ajudas.first()).toBeFocused();
      await expect(page.getByRole("tooltip")).toBeVisible();
    });
  }

  test("A1 · cada ajuda ⓘ diz de QUAL indicador ela fala", async ({ page }) => {
    await openConta(page);
    const nomes = await visibleNameCensus(page);

    const ajudas = nomes.filter((n) => n.startsWith("Ajuda"));
    // Guarda contra falso verde: se o censo parar de enxergar os ⓘ (mudou o
    // seletor, o fixture quebrou), a asserção de unicidade passaria vazia.
    expect(ajudas.length, `censo de ajudas: ${JSON.stringify(ajudas)}`).toBeGreaterThanOrEqual(4);
    expect(duplicates(ajudas), `censo de ajudas: ${JSON.stringify(ajudas)}`).toEqual([]);
    expect(nomes.filter((n) => n === "Ajuda")).toHaveLength(0);
  });

  test("A2 · 'Projetos' nomeia um controle só", async ({ page }) => {
    await openConta(page);
    const nomes = await visibleNameCensus(page);

    expect(nomes.filter((n) => n === "Projetos"), `censo: ${JSON.stringify(nomes)}`).toHaveLength(
      1,
    );
  });

  test("A2 · o segmented control fala uma gramática só", async ({ page }) => {
    await openConta(page);
    const grupoPorProjeto = page.getByTitle("Ver por projeto e categoria");

    if (test.info().project.name === "desktop") {
      // "Lista | Por categoria | Por projeto": metade dos rótulos numa gramática
      // e metade noutra é pior que o diff maior.
      await expect(page.getByTitle("Ver por categoria")).toHaveText(/Por categoria/);
      await expect(grupoPorProjeto).toHaveText(/Por projeto/);
      await expect(grupoPorProjeto).toBeVisible();
    } else {
      // No mobile o agrupamento por projeto não é OFERECIDO — o drill-down é
      // largo demais para o sheet. Repare que ele continua no DOM
      // (`hidden md:flex`): é exatamente por isso que este censo é Playwright
      // e não jsdom. Sem skip: a invisibilidade é a asserção.
      await expect(grupoPorProjeto).toHaveCount(1);
      await expect(grupoPorProjeto).toBeHidden();
    }
  });

  test("censo completo: nenhum rótulo visível designa dois controles", async ({ page }) => {
    await openConta(page);
    const nomes = await visibleNameCensus(page);

    /**
     * O fixture NÃO tem cartão de crédito de propósito. Com cartão, "Desfazer
     * pagamento" e "Ajustar fatura…" aparecem duas vezes — uma no card do
     * cartão, outra na linha de fatura do extrato. São objetos diferentes (o
     * cartão vs. aquele lançamento), então o conserto é desambiguar o nome, não
     * apagar um deles; e mexer ali reancora os seletores de
     * `w1-invoice-cta-runtime`, que guarda um fluxo de pagamento com incidente
     * aberto em produção. Issue própria, fora deste censo.
     */
    expect(duplicates(nomes), `censo completo: ${JSON.stringify(nomes)}`).toEqual([]);
  });
});

test.describe("/projects — uma CTA de criação por viewport", () => {
  test("mantém só um gatilho visível para criar projeto", async ({ page }) => {
    await mockConta(page);
    await page.goto("/projects");
    await expect(
      page.getByRole("heading", { name: "Meus Projetos" }),
    ).toBeVisible();

    // `getByRole` ignora a árvore de acessibilidade escondida pelo breakpoint:
    // diferente do jsdom, esta contagem prova o viewport renderizado de verdade.
    await expect(
      page.getByRole("button", { name: /^Novo projeto$/i }),
    ).toHaveCount(1);
    await expect(
      page.locator('[data-journey-action="project.new"]:visible'),
    ).toHaveCount(1);
  });
});
