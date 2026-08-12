import { expect, test, type Page } from "@playwright/test";

/**
 * QA (issue #423) — E2E do detalhe de rateio read-only.
 *
 * Nesta branch (`test/rateio-details`) a produção ainda NÃO existe: nem o
 * endpoint `GET /projects/:projectId/expenses/:id/rateio` nem a seção/modal
 * "Despesas rateadas" no `ExpenseFormModal`. Este spec fixa RED
 * deliberadamente — é o CONTRATO (issue #423 + brief do orquestrador) que o
 * `frontend-expert`/`backend-expert` precisam satisfazer. Não execute contra
 * `dev.db`: toda chamada de rede é interceptada via `page.route` (nenhum
 * backend real é necessário) — mesmo padrão de `phase-d-responsive.spec.ts`
 * e `expenses-fab-runtime.spec.ts`.
 *
 * Ganchos de teste assumidos (documentar/pedir ao frontend-expert se
 * divergir — ver retorno do QA):
 *   - `[data-testid="rateio-detalhe"]`       wrapper da seção/modal read-only
 *   - `[data-testid="rateio-item"]`          uma linha por alocação
 *   - `[data-total-cents]` / `[data-allocated-cents]` / `[data-sobra-cents]`
 *     atributos NUMÉRICOS no wrapper (contrato de dado, não texto formatado
 *     em BRL — nunca depender de `R$ 12.771,00` renderizado)
 *   - `[data-testid="rateio-loading"]`        estado de carregamento
 *   - `[data-testid="rateio-error"]` + `[data-testid="rateio-retry"]`
 *   - `[data-testid="vinculos-cross-project-editor"]` widget MUTÁVEL de
 *     "Vincular a despesa de outro projeto" (`VinculosFields`) — deve
 *     desaparecer/virar read-only quando a fonte tem rateio.
 *
 * Cenário: compra "Compras TelhaNorte" (PESSOAL), R$ 12.771,00 parcelada em
 * 10x, rateada entre 9 despesas planejadas da REFORMA (issue #423, exemplo
 * literal do enunciado).
 */

const personalId = "rateio-qa-personal";
const reformaId = "rateio-qa-reforma";
const sourceId = "cmr9mq9l50001cuy6mhhex5nu"; // id literal do exemplo da issue
const TOTAL_CENTS = 1_277_100; // R$ 12.771,00

function json(body: unknown, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

/** 9 alvos da REFORMA cuja soma FECHA exatamente o total da compra. */
function nineAllocationItems() {
  const cents = [142_400, 141_400, 142_400, 141_400, 142_400, 141_400, 141_900, 141_900, 141_900];
  const sum = cents.reduce((s, v) => s + v, 0);
  if (sum !== TOTAL_CENTS) throw new Error(`fixture quebrada: ${sum} != ${TOTAL_CENTS}`);
  return cents.map((allocation, i) => ({
    targetExpenseId: `tgt-${i}`,
    titulo: `Item ${i + 1} da reforma`,
    fornecedor: null,
    project: { id: reformaId, name: "Reforma Cozinha", type: "REFORMA" },
    allocation,
    plannedValorTotal: allocation,
    targetRemoved: false,
  }));
}

function rateioDetailPayload(items = nineAllocationItems()) {
  const allocatedCents = items.reduce((s, it) => s + it.allocation, 0);
  return {
    sourceId,
    totalCents: TOTAL_CENTS,
    allocatedCents,
    sobraCents: TOTAL_CENTS - allocatedCents,
    items,
  };
}

const sourceExpense = {
  id: sourceId,
  projectId: personalId,
  tipoDespesa: "OUTROS",
  valor: 127_710,
  quantidade: 1,
  valorTotal: TOTAL_CENTS,
  titulo: "Compras TelhaNorte",
  fornecedor: "TelhaNorte",
  formaPagamento: "PARCELADO",
  quantidadeParcela: 10,
  dataInicioParcela: "2026-05-10T12:00:00.000Z",
  status: "PLANEJADO",
  linkedExpenseId: "tgt-0", // vínculo "canônico" antigo — só o 1º alvo
  cardLast4: null,
  bankLast4: null,
};

const plainExpense = {
  id: "expense-sem-rateio",
  projectId: personalId,
  tipoDespesa: "ALIMENTACAO",
  valor: 5_000,
  quantidade: 1,
  valorTotal: 5_000,
  titulo: "Mercado do mês",
  fornecedor: "Supermercado",
  formaPagamento: "A_VISTA",
  dataPagamento: "2026-08-05T12:00:00.000Z",
  status: "PAGO",
  linkedExpenseId: null,
  cardLast4: null,
  bankLast4: null,
};

function accountViewWith(saida: Record<string, unknown>) {
  return {
    mesSelecionado: "2026-08",
    caixaHoje: 0,
    entrouMes: 0,
    saiuMes: TOTAL_CENTS,
    faltaPagarMes: 0,
    recebimentosPrevistosMes: 0,
    sobraPrevista: 0,
    devoCartaoTotal: 0,
    cartoes: [],
    contas: [],
    saidas: [
      {
        id: saida.id,
        kind: "saida",
        descricao: saida.titulo,
        data: "2026-08-10T12:00:00.000Z",
        forma: "pix",
        valor: saida.valorTotal,
        realizado: false,
        status: saida.status,
        cardLast4: null,
        bankLast4: null,
        tipoDespesa: saida.tipoDespesa,
        isInvoice: false,
        editavel: true,
        dueMonth: null,
        projetoOrigem: null,
      },
    ],
    comprasCartao: [],
    entradas: [],
    ticketMedio: { valor: 0, nCompras: 0, totalCompras: 0, serie6m: [], media6m: 0, deltaVsMediaPct: null },
  };
}

/** Registra todo request NÃO-GET — a leitura do detalhe nunca deve disparar mutação. */
async function mockApi(page: Page, opts: { source?: Record<string, unknown>; rateioStatus?: "ok" | "empty404" | "error-then-ok" }) {
  const mutations: string[] = [];
  let rateioCallCount = 0;
  await page.clock.setFixedTime(new Date("2026-08-12T12:00:00.000Z"));
  await page
    .context()
    .addCookies([{ name: "rf_token", value: "rateio-qa", url: "http://localhost:3013" }]);

  await page.route("http://localhost:3001/**", async (route) => {
    const request = route.request();
    if (request.method() !== "GET") mutations.push(`${request.method()} ${request.url()}`);
    const path = new URL(request.url()).pathname;

    if (path === "/auth/me") {
      return route.fulfill(
        json({
          id: "rateio-qa-user",
          username: "rateio-qa",
          name: "QA Rateio",
          role: "ADMIN",
          tenantId: "rateio-qa-tenant",
          allowedModules: [],
          allowedProjects: [],
          allowedProjectTypes: [],
        }),
      );
    }
    if (path === "/auth/config") return route.fulfill(json({ registerEnabled: false, guestEnabled: false }));
    if (path === "/projects") {
      return route.fulfill(json([{ id: personalId, name: "Pessoal QA", type: "PESSOAL" }]));
    }
    if (path === `/projects/${personalId}`) {
      return route.fulfill(
        json({ id: personalId, name: "Pessoal QA", type: "PESSOAL", onboardedAt: "2026-01-01T00:00:00.000Z" }),
      );
    }
    if (path === `/projects/${personalId}/monthly-overview/account-view`) {
      return route.fulfill(json(accountViewWith(opts.source ?? sourceExpense)));
    }
    const expenseMatch = path.match(new RegExp(`^/projects/${personalId}/expenses/([^/]+)$`));
    if (expenseMatch) {
      const id = expenseMatch[1];
      const exp = id === sourceExpense.id ? (opts.source ?? sourceExpense) : plainExpense;
      return route.fulfill(json(exp));
    }
    const rateioMatch = path.match(new RegExp(`^/projects/${personalId}/expenses/([^/]+)/rateio$`));
    if (rateioMatch) {
      const id = rateioMatch[1];
      if (id !== sourceExpense.id) return route.fulfill(json({ statusCode: 404, message: "Rateio não encontrado" }, 404));
      rateioCallCount += 1;
      if (opts.rateioStatus === "empty404") return route.fulfill(json({ statusCode: 404, message: "Rateio não encontrado" }, 404));
      if (opts.rateioStatus === "error-then-ok" && rateioCallCount === 1) {
        return route.fulfill(json({ message: "Erro interno" }, 500));
      }
      return route.fulfill(json(rateioDetailPayload()));
    }
    return route.fulfill(json([]));
  });

  return { mutations, rateioCallCount: () => rateioCallCount };
}

async function openConta(page: Page) {
  await page.goto(`/projects/${personalId}/conta`);
  await expect(page.getByText("Tenho na conta hoje", { exact: true })).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page) {
  const sizes = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(sizes.document).toBeLessThanOrEqual(sizes.viewport + 1);
}

test.describe("Detalhe de rateio read-only (#423) — Visão Conta", () => {
  test("clique na fonte rateada abre o detalhe com as 9 alocações e soma exata", async ({ page }) => {
    await mockApi(page, { rateioStatus: "ok" });
    await openConta(page);

    await page.getByRole("button", { name: "Compras TelhaNorte" }).click();

    const detalhe = page.locator('[data-testid="rateio-detalhe"]');
    await expect(detalhe).toBeVisible();

    const rows = page.locator('[data-testid="rateio-item"]');
    await expect(rows).toHaveCount(9);

    const [totalCents, allocatedCents, sobraCents] = await Promise.all([
      detalhe.getAttribute("data-total-cents"),
      detalhe.getAttribute("data-allocated-cents"),
      detalhe.getAttribute("data-sobra-cents"),
    ]);
    expect(Number(totalCents)).toBe(TOTAL_CENTS);
    expect(Number(allocatedCents)).toBe(TOTAL_CENTS);
    expect(Number(sobraCents)).toBe(0);
  });

  test("bug do primeiro-alvo-só: as 9 linhas aparecem, não só a despesa de linkedExpenseId (tgt-0)", async ({ page }) => {
    await mockApi(page, { rateioStatus: "ok" });
    await openConta(page);
    await page.getByRole("button", { name: "Compras TelhaNorte" }).click();

    const rows = page.locator('[data-testid="rateio-item"]');
    await expect(rows).toHaveCount(9);
    const ids = await rows.evaluateAll((els) => els.map((el) => el.getAttribute("data-target-expense-id")));
    expect(new Set(ids).size).toBe(9); // nenhuma duplicata
    expect(ids).toContain("tgt-0");
    expect(ids).toContain("tgt-8"); // além do "canônico", os outros 8 também aparecem
  });

  test("rótulos não duplicam: cada uma das 9 despesas aparece exatamente 1 vez na lista", async ({ page }) => {
    await mockApi(page, { rateioStatus: "ok" });
    await openConta(page);
    await page.getByRole("button", { name: "Compras TelhaNorte" }).click();

    const rows = page.locator('[data-testid="rateio-item"]');
    await expect(rows).toHaveCount(9);
    const titles = await rows.evaluateAll((els) => els.map((el) => el.textContent?.trim()));
    const dupes = titles.filter((t, i) => titles.indexOf(t) !== i);
    expect(dupes).toEqual([]);
  });

  test("read-only: esconde a affordance MUTÁVEL de vincular/remover despesa de outro projeto", async ({ page }) => {
    await mockApi(page, { rateioStatus: "ok" });
    await openConta(page);
    await page.getByRole("button", { name: "Compras TelhaNorte" }).click();
    await expect(page.locator('[data-testid="rateio-detalhe"]')).toBeVisible();

    // O widget de vínculo MUTÁVEL (busca + "Remover") não pode aparecer para
    // uma fonte já rateada — a issue #423 é só leitura, edição continua pelo
    // "Ratear compra" já existente, não por aqui.
    await expect(page.locator('[data-testid="vinculos-cross-project-editor"]')).toHaveCount(0);
  });

  test("nenhuma mutação disparada ao abrir o detalhe (GET puro)", async ({ page }) => {
    const { mutations } = await mockApi(page, { rateioStatus: "ok" });
    await openConta(page);
    await page.getByRole("button", { name: "Compras TelhaNorte" }).click();
    await expect(page.locator('[data-testid="rateio-detalhe"]')).toBeVisible();

    const rateioMutations = mutations.filter((m) => m.includes("/rateio") || m.includes("/ratear"));
    expect(rateioMutations).toEqual([]);
  });

  test("loading: mostra indicador antes dos dados chegarem", async ({ page }) => {
    await mockApi(page, { rateioStatus: "ok" });
    await page.route(`http://localhost:3001/projects/${personalId}/expenses/${sourceId}/rateio`, async (route) => {
      await new Promise((r) => setTimeout(r, 600));
      await route.fulfill(json(rateioDetailPayload()));
    });
    await openConta(page);
    await page.getByRole("button", { name: "Compras TelhaNorte" }).click();

    await expect(page.locator('[data-testid="rateio-loading"]')).toBeVisible();
    await expect(page.locator('[data-testid="rateio-item"]').first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-testid="rateio-loading"]')).toBeHidden();
  });

  test("error + retry: erro exibido, retry busca de novo e mostra os dados", async ({ page }) => {
    await mockApi(page, { rateioStatus: "error-then-ok" });
    await openConta(page);
    await page.getByRole("button", { name: "Compras TelhaNorte" }).click();

    await expect(page.locator('[data-testid="rateio-error"]')).toBeVisible();
    const retry = page.locator('[data-testid="rateio-retry"]');
    await expect(retry).toBeVisible();
    await retry.click();

    await expect(page.locator('[data-testid="rateio-item"]')).toHaveCount(9);
    await expect(page.locator('[data-testid="rateio-error"]')).toBeHidden();
  });

  test("fonte sem RateioAllocation: sem crash, sem seção read-only (empty/404)", async ({ page }) => {
    await mockApi(page, { rateioStatus: "empty404" });
    await openConta(page);
    await page.getByRole("button", { name: "Compras TelhaNorte" }).click();

    await expect(page.locator('[data-testid="rateio-detalhe"]')).toHaveCount(0);
    // e a tela não quebra: continua mostrando o formulário normal
    await expect(page.getByRole("button", { name: "Salvar" })).toBeVisible();
  });

  test("despesa NÃO rateada: fluxo de vínculo mutável permanece inalterado", async ({ page }) => {
    await mockApi(page, { source: plainExpense, rateioStatus: "empty404" });
    await openConta(page);
    await page.getByRole("button", { name: "Mercado do mês" }).click();

    await expect(page.locator('[data-testid="rateio-detalhe"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="vinculos-cross-project-editor"]')).toBeVisible();
  });

  for (const width of [375, 390]) {
    test(`${width}px: modal do detalhe sem overflow horizontal`, async ({ page }) => {
      await mockApi(page, { rateioStatus: "ok" });
      await page.setViewportSize({ width, height: 812 });
      await openConta(page);
      await page.getByRole("button", { name: "Compras TelhaNorte" }).click();
      await expect(page.locator('[data-testid="rateio-detalhe"]')).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });
  }

  test("teclado: Tab alcança a linha, Enter abre, Escape fecha", async ({ page }) => {
    await mockApi(page, { rateioStatus: "ok" });
    await openConta(page);

    const trigger = page.getByRole("button", { name: "Compras TelhaNorte" });
    await trigger.focus();
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Enter");

    const detalhe = page.locator('[data-testid="rateio-detalhe"]');
    await expect(detalhe).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(detalhe).toBeHidden();
  });

  test("alvo de toque: botão de fechar/cancelar o modal >=44px (piso tipográfico do repo)", async ({ page }) => {
    await mockApi(page, { rateioStatus: "ok" });
    await openConta(page);
    await page.getByRole("button", { name: "Compras TelhaNorte" }).click();
    await expect(page.locator('[data-testid="rateio-detalhe"]')).toBeVisible();

    const cancelar = page.getByRole("button", { name: "Cancelar" });
    await expect(cancelar).toBeVisible();
    const box = await cancelar.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  });
});
