import { expect, test, type Page } from "@playwright/test";

/**
 * QA (issue #423) — E2E do detalhe de rateio read-only.
 *
 * Contrato canônico (arquiteto, amendment de segurança
 * `security-tenant-lens`): `ExpenseService.getRateio` / `GET :id/rateio`,
 * payload `{ sourceExpenseId, rateado, totalSourceCents, rateadoCents,
 * sobraCents, removedTargetsCount, hiddenTargetsCount, hiddenAllocationCents,
 * items[] }`, cada item `{ targetExpenseId, titulo, fornecedor, projectName,
 * status, allocationCents, plannedValorTotalCents }`. N=0 (fonte sem
 * NENHUMA RateioAllocation) responde 200 `{ rateado: false, sobraCents:
 * totalSourceCents, items: [] }` — NUNCA 404 (404 é reservado para "despesa
 * não existe"). Toda chamada de rede é interceptada via `page.route`
 * (nenhum backend real é necessário) — mesmo padrão de
 * `phase-d-responsive.spec.ts` e `expenses-fab-runtime.spec.ts`.
 *
 * Ganchos de teste (contrato §6.4, `RateioDetalheSection.tsx`):
 *   - `[data-testid="rateio-detalhe"]`  wrapper, com atributos NUMÉRICOS
 *     `data-total-cents` / `data-rateado-cents` / `data-sobra-cents` /
 *     `data-hidden-targets-count` / `data-hidden-allocation-cents`
 *     (contrato de dado, nunca depender de `R$ 12.771,00` renderizado)
 *   - `[data-testid="rateio-item"]`     uma linha por alocação VISÍVEL
 *   - `[data-testid="rateio-hidden"]`   linha informativa quando
 *     `hiddenTargetsCount > 0` (sem `role="alert"`, sem âmbar — oculto não
 *     é divergência: já está dentro de `rateadoCents`)
 *   - `[data-testid="rateio-loading"]`  estado de carregamento
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
const reformaTargetId = "tgt-4";
const TOTAL_CENTS = 1_277_100; // R$ 12.771,00

function json(body: unknown, status = 200) {
  return {
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

/** 9 alvos da REFORMA cuja soma FECHA exatamente o total da compra. */
function nineAllocationItems() {
  const cents = [
    142_400, 141_400, 142_400, 141_400, 142_400, 141_400, 141_900, 141_900,
    141_900,
  ];
  const sum = cents.reduce((s, v) => s + v, 0);
  if (sum !== TOTAL_CENTS)
    throw new Error(`fixture quebrada: ${sum} != ${TOTAL_CENTS}`);
  return cents.map((allocationCents, i) => ({
    targetExpenseId: `tgt-${i}`,
    titulo: `Item ${i + 1} da reforma`,
    fornecedor: null,
    projectId: reformaId,
    projectName: "Reforma Cozinha",
    projectType: "REFORMA",
    status: "PLANEJADO",
    allocationCents,
    plannedValorTotalCents: allocationCents,
  }));
}

/** Payload canônico do GET :id/rateio (contrato §6.1/§6.2 do arquiteto). */
function rateioDetailPayload(opts?: {
  items?: ReturnType<typeof nineAllocationItems>;
  hiddenTargetsCount?: number;
  hiddenAllocationCents?: number;
  removedTargetsCount?: number;
}) {
  const items = opts?.items ?? nineAllocationItems();
  const hiddenTargetsCount = opts?.hiddenTargetsCount ?? 0;
  const hiddenAllocationCents = opts?.hiddenAllocationCents ?? 0;
  const removedTargetsCount = opts?.removedTargetsCount ?? 0;
  const visibleCents = items.reduce((s, it) => s + it.allocationCents, 0);
  const rateadoCents = visibleCents + hiddenAllocationCents; // I-A/I-D
  return {
    sourceExpenseId: sourceId,
    rateado: true,
    totalSourceCents: TOTAL_CENTS,
    rateadoCents,
    sobraCents: TOTAL_CENTS - rateadoCents,
    removedTargetsCount,
    hiddenTargetsCount,
    hiddenAllocationCents,
    items,
  };
}

/** N=0: fonte SEM nenhuma RateioAllocation — 200, nunca 404 (contrato §6.3). */
function rateioEmptyPayload() {
  return {
    sourceExpenseId: sourceId,
    rateado: false,
    totalSourceCents: TOTAL_CENTS,
    rateadoCents: 0,
    sobraCents: TOTAL_CENTS,
    removedTargetsCount: 0,
    hiddenTargetsCount: 0,
    hiddenAllocationCents: 0,
    items: [],
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

const reformaTargetExpense = {
  id: reformaTargetId,
  projectId: reformaId,
  tipoDespesa: "MATERIAL_CONSTRUCAO",
  valor: 142_400,
  quantidade: 1,
  valorTotal: 142_400,
  titulo: "Item 5 da reforma",
  fornecedor: null,
  formaPagamento: "A_VISTA",
  dataPagamento: null,
  status: "PLANEJADO",
  // A resolução da fonte é canônica via RateioAllocation, não por este legado.
  linkedExpenseId: null,
  cardLast4: null,
  bankLast4: null,
};

const reformaTargetAccountItem = {
  ...reformaTargetExpense,
  foreignExpenseId: reformaTargetId,
  projetoOrigem: {
    id: reformaId,
    name: "Reforma Cozinha",
    type: "REFORMA",
  },
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
        projetoOrigem: saida.projetoOrigem ?? null,
        foreignExpenseId: saida.foreignExpenseId ?? null,
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
}

/** Registra todo request NÃO-GET — a leitura do detalhe nunca deve disparar mutação. */
async function mockApi(
  page: Page,
  opts: {
    source?: Record<string, unknown>;
    accountExpense?: Record<string, unknown>;
    targetExpense?: Record<string, unknown>;
    targetRateioPayload?: unknown;
    rateioStatus?: "ok" | "empty" | "error-then-ok";
    rateioPayload?: unknown;
  },
) {
  const apiRequests: Array<{
    method: string;
    path: string;
    body: unknown;
  }> = [];
  const mutations: string[] = [];
  let rateioCallCount = 0;
  await page.clock.setFixedTime(new Date("2026-08-12T12:00:00.000Z"));
  await page
    .context()
    .addCookies([
      { name: "rf_token", value: "rateio-qa", url: "http://localhost:3013" },
    ]);

  await page.route("http://localhost:3001/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const rawBody = request.postData();
    apiRequests.push({
      method: request.method(),
      path,
      body: rawBody ? JSON.parse(rawBody) : null,
    });
    if (request.method() !== "GET")
      mutations.push(`${request.method()} ${request.url()}`);

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
    if (path === "/auth/config")
      return route.fulfill(
        json({ registerEnabled: false, guestEnabled: false }),
      );
    if (path === "/projects") {
      return route.fulfill(
        json([
          { id: personalId, name: "Pessoal QA", type: "PESSOAL" },
          { id: reformaId, name: "Reforma Cozinha", type: "REFORMA" },
        ]),
      );
    }
    if (path === `/projects/${personalId}`) {
      return route.fulfill(
        json({
          id: personalId,
          name: "Pessoal QA",
          type: "PESSOAL",
          onboardedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    }
    if (path === `/projects/${personalId}/monthly-overview/account-view`) {
      return route.fulfill(
        json(
          accountViewWith(opts.accountExpense ?? opts.source ?? sourceExpense),
        ),
      );
    }
    // A tela /conta também busca o dre-overview (sobra prevista acumulada) —
    // sem este handler o fallback genérico `[]` faz `dreData?.anual` estourar
    // ("Cannot read properties of undefined (reading 'saldoAcumuladoSerie')"),
    // a página cai no ErrorBoundary e "Tenho na conta hoje" nunca renderiza
    // (mesmo shape mínimo usado por phase-d-responsive.spec.ts).
    if (path === `/projects/${personalId}/monthly-overview/dre-overview`) {
      return route.fulfill(json({ anual: { saldoAcumuladoSerie: [] } }));
    }
    if (path === `/projects/${reformaId}/expenses/${reformaTargetId}/rateio`) {
      return route.fulfill(
        json(opts.targetRateioPayload ?? rateioDetailPayload()),
      );
    }
    if (path === `/projects/${reformaId}/expenses/${reformaTargetId}`) {
      return route.fulfill(json(opts.targetExpense ?? reformaTargetExpense));
    }
    const expenseMatch = path.match(
      new RegExp(`^/projects/${personalId}/expenses/([^/]+)$`),
    );
    if (expenseMatch) {
      const id = expenseMatch[1];
      const exp =
        id === sourceExpense.id ? (opts.source ?? sourceExpense) : plainExpense;
      return route.fulfill(json(exp));
    }
    const rateioMatch = path.match(
      new RegExp(`^/projects/${personalId}/expenses/([^/]+)/rateio$`),
    );
    if (rateioMatch) {
      const id = rateioMatch[1];
      if (id !== sourceExpense.id)
        return route.fulfill(json(rateioEmptyPayload()));
      rateioCallCount += 1;
      if (opts.rateioPayload) return route.fulfill(json(opts.rateioPayload));
      if (opts.rateioStatus === "empty")
        return route.fulfill(json(rateioEmptyPayload()));
      // `Providers` configura retry automático do React Query para 5xx
      // (falha 500 não é 4xx, então `retry: failureCount < 2` dispara 2
      // novas tentativas ANTES de `isError` virar true — call 1 = 1ª
      // tentativa, calls 2/3 = retries automáticos). Só a partir da 4ª
      // chamada (o clique manual em "Tentar novamente" → `refetch()`) é
      // que devemos responder OK, senão o retry automático "engole" o
      // erro silenciosamente e a UI de erro nunca aparece.
      if (opts.rateioStatus === "error-then-ok" && rateioCallCount <= 3) {
        return route.fulfill(json({ message: "Erro interno" }, 500));
      }
      return route.fulfill(json(rateioDetailPayload()));
    }
    if (
      request.method() === "POST" &&
      path === `/projects/${personalId}/expenses/${sourceId}/ratear`
    ) {
      return route.fulfill(json({ sourceExpenseId: sourceId }));
    }
    return route.fulfill(json([]));
  });

  return { apiRequests, mutations, rateioCallCount: () => rateioCallCount };
}

async function openConta(page: Page) {
  await page.goto(`/projects/${personalId}/conta`);
  await expect(
    page.getByText("Tenho na conta hoje", { exact: true }),
  ).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page) {
  const sizes = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(sizes.document).toBeLessThanOrEqual(sizes.viewport + 1);
}

function formatPtBrCents(cents: number) {
  const inteiro = Math.floor(cents / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${inteiro},${String(cents % 100).padStart(2, "0")}`;
}

test.describe("Jornada TelhaNorte de rateio (#428) — Visão Conta", () => {
  test("fonte PESSOAL já rateada reabre Ratear compra com o conjunto completo prefilled e POST conserva centavos", async ({
    page,
  }) => {
    const expectedItems = nineAllocationItems();
    const { apiRequests } = await mockApi(page, { rateioStatus: "ok" });
    await openConta(page);

    const sourceTrigger = page.getByRole("button", {
      name: "Compras TelhaNorte",
      exact: true,
    });
    await expect(sourceTrigger).toHaveCount(1);
    await sourceTrigger.click();
    await expect(page.locator('[data-testid="rateio-detalhe"]')).toBeVisible();

    const openRateio = page.getByRole("button", {
      name: "Ratear compra",
      exact: true,
    });
    await expect(openRateio).toHaveCount(1);
    await expect(openRateio).toBeVisible();
    await openRateio.click();

    const ratearModal = page.locator('[data-mobile-sheet="modal"]').filter({
      has: page.getByRole("heading", {
        name: "Ratear compra",
        exact: true,
      }),
    });
    await expect(ratearModal).toHaveCount(1);
    await expect(ratearModal).toBeVisible();

    const allocationInputs = ratearModal.getByLabel(/^Valor alocado para /);
    await expect(allocationInputs).toHaveCount(expectedItems.length);
    const allocationLabels = await allocationInputs.evaluateAll((inputs) =>
      inputs.map((input) => input.getAttribute("aria-label")),
    );
    expect(allocationLabels).toEqual(
      expectedItems.map((item) => `Valor alocado para ${item.titulo}`),
    );
    expect(new Set(allocationLabels).size).toBe(expectedItems.length);

    for (const item of expectedItems) {
      const targetTitle = ratearModal.getByText(item.titulo, { exact: true });
      await expect(targetTitle).toHaveCount(1);
      await expect(targetTitle).toBeVisible();

      const allocationInput = ratearModal.getByLabel(
        `Valor alocado para ${item.titulo}`,
        { exact: true },
      );
      await expect(allocationInput).toHaveCount(1);
      await expect(allocationInput).toBeVisible();
      await expect(allocationInput).toHaveValue(
        formatPtBrCents(item.allocationCents),
      );
    }

    const desfazer = ratearModal.getByRole("button", {
      name: "Desfazer rateio",
      exact: true,
    });
    const salvar = ratearModal.getByRole("button", {
      name: "Salvar rateio",
      exact: true,
    });
    await expect(desfazer).toHaveCount(1);
    await expect(desfazer).toBeVisible();
    await expect(salvar).toHaveCount(1);
    await expect(salvar).toBeEnabled();
    await salvar.click();

    const ratearPath = `/projects/${personalId}/expenses/${sourceId}/ratear`;
    await expect
      .poll(
        () =>
          apiRequests.filter(
            (request) =>
              request.method === "POST" && request.path === ratearPath,
          ).length,
        { message: "POST de rateio deve ser enviado exatamente uma vez" },
      )
      .toBe(1);
    const ratearPosts = apiRequests.filter(
      (request) => request.method === "POST" && request.path === ratearPath,
    );
    expect(ratearPosts).toEqual([
      {
        method: "POST",
        path: ratearPath,
        body: {
          allocations: expectedItems.map((item) => ({
            targetExpenseId: item.targetExpenseId,
            allocation: item.allocationCents,
          })),
        },
      },
    ]);
    const submitted = (
      ratearPosts[0].body as {
        allocations: Array<{
          targetExpenseId: string;
          allocation: number;
        }>;
      }
    ).allocations;
    expect(submitted).toHaveLength(expectedItems.length);
    expect(new Set(submitted.map((item) => item.targetExpenseId)).size).toBe(
      expectedItems.length,
    );
    expect(submitted.reduce((sum, item) => sum + item.allocation, 0)).toBe(
      TOTAL_CENTS,
    );
  });

  test("após editar e reabrir, refaz GET e mostra o rateio atual sem oferecer alvo já preenchido", async ({
    page,
  }) => {
    const initialItems = nineAllocationItems();
    const updatedItems = initialItems.map((item) => {
      if (item.targetExpenseId === "tgt-0")
        return { ...item, allocationCents: 140_000 };
      if (item.targetExpenseId === "tgt-1")
        return { ...item, allocationCents: 143_800 };
      return item;
    });
    expect(
      updatedItems.reduce((sum, item) => sum + item.allocationCents, 0),
    ).toBe(TOTAL_CENTS);

    let currentItems = initialItems;
    let rateioGetCount = 0;
    let crossProjectGetCount = 0;
    const ratearBodies: unknown[] = [];
    await mockApi(page, { rateioStatus: "ok" });

    const rateioUrl = `http://localhost:3001/projects/${personalId}/expenses/${sourceId}/rateio`;
    const ratearUrl = `http://localhost:3001/projects/${personalId}/expenses/${sourceId}/ratear`;
    await page.route(rateioUrl, async (route) => {
      rateioGetCount += 1;
      await route.fulfill(json(rateioDetailPayload({ items: currentItems })));
    });
    await page.route(ratearUrl, async (route) => {
      const body = route.request().postDataJSON() as {
        allocations: Array<{
          targetExpenseId: string;
          allocation: number;
        }>;
      };
      ratearBodies.push(body);
      const submittedByTarget = new Map(
        body.allocations.map((item) => [item.targetExpenseId, item.allocation]),
      );
      currentItems = currentItems.map((item) => ({
        ...item,
        allocationCents:
          submittedByTarget.get(item.targetExpenseId) ?? item.allocationCents,
      }));
      await route.fulfill(json({ sourceExpenseId: sourceId }));
    });
    await page.route(
      new RegExp(
        `^http://localhost:3001/projects/${personalId}/expenses/cross-project(?:\\?.*)?$`,
      ),
      async (route) => {
        crossProjectGetCount += 1;
        await route.fulfill(
          json([
            {
              id: initialItems[0].targetExpenseId,
              titulo: initialItems[0].titulo,
              fornecedor: null,
              valorTotal: initialItems[0].plannedValorTotalCents,
              status: "PLANEJADO",
              project: {
                id: reformaId,
                name: "Reforma Cozinha",
                type: "REFORMA",
              },
            },
            {
              id: "tgt-disponivel",
              titulo: "Item 1 reserva da reforma",
              fornecedor: null,
              valorTotal: 50_000,
              status: "PLANEJADO",
              project: {
                id: reformaId,
                name: "Reforma Cozinha",
                type: "REFORMA",
              },
            },
          ]),
        );
      },
    );

    await openConta(page);
    const sourceTrigger = page.getByRole("button", {
      name: "Compras TelhaNorte",
      exact: true,
    });
    await sourceTrigger.click();
    await page
      .getByRole("button", { name: "Ratear compra", exact: true })
      .click();

    let ratearModal = page.locator('[data-mobile-sheet="modal"]').filter({
      has: page.getByRole("heading", {
        name: "Ratear compra",
        exact: true,
      }),
    });
    await expect(ratearModal).toBeVisible();
    const allocationInputs = ratearModal.getByLabel(/^Valor alocado para /);
    await expect(allocationInputs).toHaveCount(initialItems.length);

    const search = ratearModal.getByRole("textbox", {
      name: "Distribuir entre planejadas de outro projeto",
      exact: true,
    });
    await search.fill("Item 1");
    await expect
      .poll(() => crossProjectGetCount, {
        message: "a busca cross-project deve responder com os dois candidatos",
      })
      .toBeGreaterThan(0);
    await expect(
      ratearModal.getByRole("button", {
        name: /^Item 1 reserva da reforma/,
      }),
    ).toBeVisible();
    await expect(
      ratearModal.getByRole("button", {
        name: /^Item 1 da reforma/,
      }),
    ).toHaveCount(0);

    await ratearModal
      .getByLabel(`Valor alocado para ${initialItems[0].titulo}`, {
        exact: true,
      })
      .fill(formatPtBrCents(updatedItems[0].allocationCents));
    await ratearModal
      .getByLabel(`Valor alocado para ${initialItems[1].titulo}`, {
        exact: true,
      })
      .fill(formatPtBrCents(updatedItems[1].allocationCents));
    const rateioGetsBeforeSave = rateioGetCount;
    expect(rateioGetsBeforeSave).toBeGreaterThan(0);
    const saveRateio = ratearModal.getByRole("button", {
      name: "Salvar rateio",
      exact: true,
    });
    await expect(saveRateio).toBeEnabled();
    await saveRateio.click();

    await expect.poll(() => ratearBodies.length).toBe(1);
    expect(ratearBodies).toEqual([
      {
        allocations: updatedItems.map((item) => ({
          targetExpenseId: item.targetExpenseId,
          allocation: item.allocationCents,
        })),
      },
    ]);
    await expect(ratearModal).toBeHidden();

    await sourceTrigger.click();
    await expect
      .poll(() => rateioGetCount, {
        message: "o detalhe deve refazer o GET após salvar o rateio",
      })
      .toBeGreaterThan(rateioGetsBeforeSave);
    await page
      .getByRole("button", { name: "Ratear compra", exact: true })
      .click();

    ratearModal = page.locator('[data-mobile-sheet="modal"]').filter({
      has: page.getByRole("heading", {
        name: "Ratear compra",
        exact: true,
      }),
    });
    await expect(ratearModal).toBeVisible();
    await expect(
      ratearModal.getByLabel(`Valor alocado para ${updatedItems[0].titulo}`, {
        exact: true,
      }),
    ).toHaveValue(formatPtBrCents(updatedItems[0].allocationCents));
    await expect(
      ratearModal.getByLabel(`Valor alocado para ${updatedItems[1].titulo}`, {
        exact: true,
      }),
    ).toHaveValue(formatPtBrCents(updatedItems[1].allocationCents));
  });

  test("editar alvo REFORMA resolve a fonte canônica e mostra todas as alocações uma vez, somente leitura e sem mutação", async ({
    page,
  }) => {
    const expectedItems = nineAllocationItems();
    const targetRateioPayload = rateioDetailPayload();
    expect(targetRateioPayload.sourceExpenseId).toBe(sourceId);
    expect(targetRateioPayload.items).toEqual(expectedItems);
    const { apiRequests } = await mockApi(page, {
      accountExpense: reformaTargetAccountItem,
      targetExpense: reformaTargetExpense,
      targetRateioPayload,
    });
    await openConta(page);

    const targetTrigger = page.getByRole("button", {
      name: "Item 5 da reforma",
      exact: true,
    });
    await expect(targetTrigger).toHaveCount(1);
    await targetTrigger.click();

    const expenseModal = page.locator('[data-mobile-sheet="modal"]').filter({
      has: page.getByRole("heading", {
        name: "Editar Despesa",
        exact: true,
      }),
    });
    await expect(expenseModal).toHaveCount(1);
    await expect(expenseModal).toBeVisible();

    const detalhe = expenseModal.locator('[data-testid="rateio-detalhe"]');
    await expect(detalhe).toBeVisible();
    await expect(detalhe).toHaveAttribute(
      "data-rateado-cents",
      String(TOTAL_CENTS),
    );
    await expect(detalhe).toHaveAttribute("data-sobra-cents", "0");

    const readonlyRows = detalhe.locator('[data-testid="rateio-item"]');
    await expect(readonlyRows).toHaveCount(expectedItems.length);
    const displayedTargetIds = await readonlyRows.evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-target-expense-id")),
    );
    expect(displayedTargetIds).toEqual(
      expectedItems.map((item) => item.targetExpenseId),
    );
    expect(new Set(displayedTargetIds).size).toBe(expectedItems.length);
    for (const row of await readonlyRows.all()) {
      await expect(row).toBeVisible();
    }

    await expect(
      detalhe.locator('input, select, textarea, [contenteditable="true"]'),
    ).toHaveCount(0);
    await expect(expenseModal.getByLabel(/^Valor alocado para /)).toHaveCount(
      0,
    );
    await expect(
      expenseModal.getByRole("button", {
        name: "Ratear compra",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      expenseModal.getByRole("button", {
        name: "Desfazer rateio",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      expenseModal.getByRole("button", { name: "Salvar", exact: true }),
    ).toHaveCount(1);
    await expect(
      expenseModal.getByRole("button", {
        name: "Cancelar",
        exact: true,
      }),
    ).toHaveCount(1);

    const targetRateioPath = `/projects/${reformaId}/expenses/${reformaTargetId}/rateio`;
    expect(
      apiRequests.filter(
        (request) =>
          request.method === "GET" && request.path === targetRateioPath,
      ),
    ).toEqual([
      {
        method: "GET",
        path: targetRateioPath,
        body: null,
      },
    ]);
    expect(apiRequests.filter((request) => request.method !== "GET")).toEqual(
      [],
    );
  });
});

test.describe("Detalhe de rateio read-only (#423) — Visão Conta", () => {
  test("clique na fonte rateada abre o detalhe com as 9 alocações e soma exata", async ({
    page,
  }) => {
    await mockApi(page, { rateioStatus: "ok" });
    await openConta(page);

    await page.getByRole("button", { name: "Compras TelhaNorte" }).click();

    const detalhe = page.locator('[data-testid="rateio-detalhe"]');
    await expect(detalhe).toBeVisible();

    const rows = page.locator('[data-testid="rateio-item"]');
    await expect(rows).toHaveCount(9);

    const [totalCents, rateadoCents, sobraCents, hiddenCount, hiddenCents] =
      await Promise.all([
        detalhe.getAttribute("data-total-cents"),
        detalhe.getAttribute("data-rateado-cents"),
        detalhe.getAttribute("data-sobra-cents"),
        detalhe.getAttribute("data-hidden-targets-count"),
        detalhe.getAttribute("data-hidden-allocation-cents"),
      ]);
    expect(Number(totalCents)).toBe(TOTAL_CENTS);
    expect(Number(rateadoCents)).toBe(TOTAL_CENTS);
    expect(Number(sobraCents)).toBe(0);
    expect(Number(hiddenCount)).toBe(0);
    expect(Number(hiddenCents)).toBe(0);
  });

  test("bug do primeiro-alvo-só: as 9 linhas aparecem, não só a despesa de linkedExpenseId (tgt-0)", async ({
    page,
  }) => {
    await mockApi(page, { rateioStatus: "ok" });
    await openConta(page);
    await page.getByRole("button", { name: "Compras TelhaNorte" }).click();

    const rows = page.locator('[data-testid="rateio-item"]');
    await expect(rows).toHaveCount(9);
    const ids = await rows.evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-target-expense-id")),
    );
    expect(new Set(ids).size).toBe(9); // nenhuma duplicata
    expect(ids).toContain("tgt-0");
    expect(ids).toContain("tgt-8"); // além do "canônico", os outros 8 também aparecem
  });

  test("rótulos não duplicam: cada uma das 9 despesas aparece exatamente 1 vez na lista", async ({
    page,
  }) => {
    await mockApi(page, { rateioStatus: "ok" });
    await openConta(page);
    await page.getByRole("button", { name: "Compras TelhaNorte" }).click();

    const rows = page.locator('[data-testid="rateio-item"]');
    await expect(rows).toHaveCount(9);
    const titles = await rows.evaluateAll((els) =>
      els.map((el) => el.textContent?.trim()),
    );
    const dupes = titles.filter((t, i) => titles.indexOf(t) !== i);
    expect(dupes).toEqual([]);
  });

  test("read-only: esconde a affordance MUTÁVEL de vincular/remover despesa de outro projeto", async ({
    page,
  }) => {
    await mockApi(page, { rateioStatus: "ok" });
    await openConta(page);
    await page.getByRole("button", { name: "Compras TelhaNorte" }).click();
    await expect(page.locator('[data-testid="rateio-detalhe"]')).toBeVisible();

    // O widget de vínculo MUTÁVEL (busca + "Remover") não pode aparecer para
    // uma fonte já rateada — a issue #423 é só leitura, edição continua pelo
    // "Ratear compra" já existente, não por aqui.
    await expect(
      page.locator('[data-testid="vinculos-cross-project-editor"]'),
    ).toHaveCount(0);
  });

  test("nenhuma mutação disparada ao abrir o detalhe (GET puro)", async ({
    page,
  }) => {
    const { mutations } = await mockApi(page, { rateioStatus: "ok" });
    await openConta(page);
    await page.getByRole("button", { name: "Compras TelhaNorte" }).click();
    await expect(page.locator('[data-testid="rateio-detalhe"]')).toBeVisible();

    const rateioMutations = mutations.filter(
      (m) => m.includes("/rateio") || m.includes("/ratear"),
    );
    expect(rateioMutations).toEqual([]);
  });

  test("loading: mostra indicador antes dos dados chegarem", async ({
    page,
  }) => {
    await mockApi(page, { rateioStatus: "ok" });
    await page.route(
      `http://localhost:3001/projects/${personalId}/expenses/${sourceId}/rateio`,
      async (route) => {
        await new Promise((r) => setTimeout(r, 600));
        await route.fulfill(json(rateioDetailPayload()));
      },
    );
    await openConta(page);
    await page.getByRole("button", { name: "Compras TelhaNorte" }).click();

    await expect(page.locator('[data-testid="rateio-loading"]')).toBeVisible();
    await expect(
      page.locator('[data-testid="rateio-item"]').first(),
    ).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-testid="rateio-loading"]')).toBeHidden();
  });

  test("error + retry: erro exibido, retry busca de novo e mostra os dados", async ({
    page,
  }) => {
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

  test("N=0 (fonte sem NENHUMA RateioAllocation): 200 rateado:false, sem seção read-only, sem crash", async ({
    page,
  }) => {
    await mockApi(page, { rateioStatus: "empty" });
    await openConta(page);
    await page.getByRole("button", { name: "Compras TelhaNorte" }).click();

    // Contrato §6.3: 200 { rateado: false, sobraCents: total, items: [] }
    // — NUNCA 404 (404 = despesa não existe). A seção renderiza `null`
    // porque `!rateado`; isso é comportamento de UI, não erro de rede.
    await expect(page.locator('[data-testid="rateio-detalhe"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="rateio-error"]')).toHaveCount(0);
    // e a tela não quebra: continua mostrando o formulário normal
    await expect(page.getByRole("button", { name: "Salvar" })).toBeVisible();
  });

  test("despesa NÃO rateada: fluxo de vínculo mutável permanece inalterado", async ({
    page,
  }) => {
    await mockApi(page, { source: plainExpense, rateioStatus: "empty" });
    await openConta(page);
    await page.getByRole("button", { name: "Mercado do mês" }).click();

    await expect(page.locator('[data-testid="rateio-detalhe"]')).toHaveCount(0);
    // O editor de vínculo mutável vive dentro de "Mais opções" (campos
    // avançados recolhidos por padrão em `ExpenseFormModal` — reduz
    // fricção do formulário); é preciso abrir a seção antes de checar
    // visibilidade, senão ela está no DOM porém oculta por `hidden`.
    // Escopado ao `<form>`: em mobile o menu inferior TEM outro botão
    // "Mais opções" (nav global) — sem escopo, o locator vira ambíguo.
    await page
      .locator("form")
      .getByRole("button", { name: "Mais opções" })
      .click();
    await expect(
      page.locator('[data-testid="vinculos-cross-project-editor"]'),
    ).toBeVisible();
  });

  test("viewer restrito: 8 de 9 alocações ocultas — nenhum título/projeto alheio no DOM", async ({
    page,
  }) => {
    // Cenário do contrato (§7.7): usuário sem lente sobre a OBRA vê só o
    // alvo que ele enxerga; os outros 8 viram contador agregado — nunca
    // linhas redigidas (I-E: nenhum campo de alvo oculto vaza, nem sequer
    // targetExpenseId).
    const visibleItem = nineAllocationItems()[0];
    const hiddenAllocationCents = TOTAL_CENTS - visibleItem.allocationCents; // 1_134_700
    const payload = rateioDetailPayload({
      items: [visibleItem],
      hiddenTargetsCount: 8,
      hiddenAllocationCents,
    });
    await mockApi(page, { rateioPayload: payload });
    await openConta(page);
    await page.getByRole("button", { name: "Compras TelhaNorte" }).click();

    const detalhe = page.locator('[data-testid="rateio-detalhe"]');
    await expect(detalhe).toBeVisible();
    await expect(detalhe).toHaveAttribute("data-hidden-targets-count", "8");
    await expect(detalhe).toHaveAttribute(
      "data-hidden-allocation-cents",
      String(hiddenAllocationCents),
    );
    await expect(page.locator('[data-testid="rateio-item"]')).toHaveCount(1);
    // I-A: identidade do dinheiro se mantém mesmo com 8 ocultos — sobra continua 0.
    await expect(detalhe).toHaveAttribute("data-sobra-cents", "0");
    await expect(detalhe).toHaveAttribute(
      "data-rateado-cents",
      String(TOTAL_CENTS),
    );

    // I-E: nenhum nome/título/id de alvo oculto vaza para o DOM.
    await expect(page.locator("body")).not.toContainText("Obra do Vizinho");
    for (let i = 1; i < 9; i += 1) {
      await expect(page.locator("body")).not.toContainText(
        `Item ${i + 1} da reforma`,
      );
    }
    const idsInDom = await page
      .locator('[data-testid="rateio-item"]')
      .evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-target-expense-id")),
      );
    for (let i = 1; i < 9; i += 1) {
      expect(idsInDom).not.toContain(`tgt-${i}`);
    }

    // Linha informativa de ocultos, sem virar alerta de divergência. Escopo
    // no `detalhe` — `page.getByRole("alert")` sozinho também casaria com a
    // região `aria-live` sempre presente do `<Toaster>` (sonner) no layout
    // raiz, que nada tem a ver com a seção de rateio.
    await expect(page.locator('[data-testid="rateio-hidden"]')).toBeVisible();
    await expect(detalhe.getByRole("alert")).toHaveCount(0);
  });

  test("N=0 com alocações ocultas: hiddenTargetsCount > 0 mostra totais e a linha de ocultos, nunca em branco", async ({
    page,
  }) => {
    // Fronteira: TODOS os alvos ativos estão fora da lente — `items: []`,
    // mas `rateado: true` (ele sabe que a compra dele foi rateada). A
    // seção NÃO pode cair no `return null` (que é só para `!rateado`).
    const payload = rateioDetailPayload({
      items: [],
      hiddenTargetsCount: 9,
      hiddenAllocationCents: TOTAL_CENTS,
    });
    await mockApi(page, { rateioPayload: payload });
    await openConta(page);
    await page.getByRole("button", { name: "Compras TelhaNorte" }).click();

    const detalhe = page.locator('[data-testid="rateio-detalhe"]');
    await expect(detalhe).toBeVisible();
    await expect(page.locator('[data-testid="rateio-item"]')).toHaveCount(0);
    await expect(detalhe).toHaveAttribute("data-hidden-targets-count", "9");
    await expect(detalhe).toHaveAttribute("data-sobra-cents", "0");
    await expect(page.locator('[data-testid="rateio-hidden"]')).toContainText(
      "9",
    );
  });

  for (const width of [375, 390]) {
    test(`${width}px: modal do detalhe sem overflow horizontal`, async ({
      page,
    }) => {
      await mockApi(page, { rateioStatus: "ok" });
      await page.setViewportSize({ width, height: 812 });
      await openConta(page);
      await page.getByRole("button", { name: "Compras TelhaNorte" }).click();
      await expect(
        page.locator('[data-testid="rateio-detalhe"]'),
      ).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });

    test(`${width}px: cada uma das 9 despesas continua aparecendo exatamente 1 vez (sem duplicar em layout mobile)`, async ({
      page,
    }) => {
      await mockApi(page, { rateioStatus: "ok" });
      await page.setViewportSize({ width, height: 812 });
      await openConta(page);
      await page.getByRole("button", { name: "Compras TelhaNorte" }).click();

      const rows = page.locator('[data-testid="rateio-item"]');
      await expect(rows).toHaveCount(9);
      const ids = await rows.evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-target-expense-id")),
      );
      expect(new Set(ids).size).toBe(9);
    });
  }

  test("teclado: Tab alcança a linha, Enter abre, Escape fecha", async ({
    page,
  }) => {
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

  test("alvo de toque: botão de fechar/cancelar o modal >=44px (piso tipográfico do repo)", async ({
    page,
  }) => {
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
