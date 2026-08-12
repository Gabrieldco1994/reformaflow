import { test, expect, type Page, type ViewportSize } from "@playwright/test";

/**
 * RED spec — issue #424 (origem por parcela na REFORMA).
 *
 * Endpoint `GET /projects/:id/expenses/paid-origins` e a derivação
 * (`buildPaidOrigins`) são cobertos por `paid-origins.builder.spec.ts` /
 * `paid-origins.service.spec.ts` (jest) e `paid-origin-label.test.ts`
 * (vitest). Este arquivo cobre a ÁRVORE REAL: `ExpensesView` →
 * `MonthlyExpenseView` (per-occurrence, view=general) e
 * `CategoryExpenseView` (aggregate, view=category) — as duas superfícies
 * responsivas que de fato renderizam despesas da REFORMA (§1.2 do design:
 * `ExpenseDesktopTable`/`MobileExpenseList` são código morto).
 *
 * Endpoint mockado via `page.route`; a árvore de página é real (Next dev).
 */

const projectId = "reforma-test";

const PESSOAL_SOURCE = { id: "proj-pessoal", name: "Pessoal" };

interface PaidOriginRef {
  kind: "card" | "bank";
  last4: string;
  nickname: string | null;
  institution: string | null;
  sourceProjectId: string;
  sourceProjectName: string;
}

const NUBANK: PaidOriginRef = {
  kind: "card",
  last4: "3541",
  nickname: "Nubank",
  institution: "Mastercard",
  sourceProjectId: PESSOAL_SOURCE.id,
  sourceProjectName: PESSOAL_SOURCE.name,
};

const LATAM: PaidOriginRef = {
  kind: "card",
  last4: "5572",
  nickname: "Latam",
  institution: "Mastercard",
  sourceProjectId: PESSOAL_SOURCE.id,
  sourceProjectName: PESSOAL_SOURCE.name,
};

// Identidade que SÓ existiria se o back-end vazasse um vestígio da origem
// redigida. Nunca deve aparecer em `items` nem no corpo bruto da resposta.
const HIDDEN_LAST4 = "4444";
const HIDDEN_NICKNAME = "CofreSecreto";

function json(body: unknown, status = 200) {
  return {
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

// --- Fixtures de despesas (alvo REFORMA) ------------------------------
// O1: o alvo NUNCA carrega cardLast4/bankLast4 — a origem só existe em
// `paid-origins`. Datas/valores são literais pinados (sem faker/Date()).

function infraExpense(id: string, titulo: string) {
  return {
    id,
    projectId,
    tipoDespesa: "MATERIAL_CONSTRUCAO",
    titulo,
    valor: 100000,
    quantidade: 1,
    valorTotal: 600000,
    formaPagamento: "PARCELADO",
    quantidadeParcela: 6,
    dataPagamento: "2026-03-15T12:00:00.000Z",
    dataInicioParcela: "2026-03-15T12:00:00.000Z",
    status: "PLANEJADO",
    paidParcelas: null,
    cardLast4: null,
    bankLast4: null,
  };
}

function telhanorteExpense(i: number) {
  return {
    id: `tgt-telha-${i}`,
    projectId,
    tipoDespesa: "MATERIAL_CONSTRUCAO",
    titulo: `Telhanorte ${i + 1}`,
    valor: 50000,
    quantidade: 1,
    valorTotal: 50000,
    formaPagamento: "A_VISTA",
    dataPagamento: "2026-04-10T12:00:00.000Z",
    status: "PAGO",
    cardLast4: null,
    bankLast4: null,
  };
}

const INFRA_SAME = infraExpense("tgt-infra-same", "Reforma Infra A");
const INFRA_MIXED = infraExpense("tgt-infra-mixed", "Reforma Infra B");
const TELHANORTE = Array.from({ length: 9 }, (_, i) => telhanorteExpense(i));
const REDACTED_TARGET = {
  id: "tgt-redacted",
  projectId,
  tipoDespesa: "MATERIAL_CONSTRUCAO",
  titulo: "Fatura Oculta",
  valor: 80000,
  quantidade: 1,
  valorTotal: 80000,
  formaPagamento: "A_VISTA",
  dataPagamento: "2026-04-05T12:00:00.000Z",
  status: "PAGO",
  cardLast4: null,
  bankLast4: null,
};
const WALLET_TARGET = {
  id: "tgt-carteira",
  projectId,
  tipoDespesa: "MATERIAL_CONSTRUCAO",
  titulo: "Compra na carteira",
  valor: 30000,
  quantidade: 1,
  valorTotal: 30000,
  formaPagamento: "A_VISTA",
  dataPagamento: "2026-04-08T12:00:00.000Z",
  status: "PAGO",
  cardLast4: null,
  bankLast4: null,
};

const FULL_EXPENSES = [
  INFRA_SAME,
  INFRA_MIXED,
  ...TELHANORTE,
  REDACTED_TARGET,
  WALLET_TARGET,
];

// --- Fixture de paid-origins -------------------------------------------
// O9: parcelaIndex é 0-based; occIndex (1-based) 5/6 ↔ parcelaIndex 4/5.
// `tgt-redacted` e `tgt-carteira` NÃO aparecem em `items` — O7 (redação por
// omissão) e O8 (carteira não emite origem).

const FULL_PAID_ORIGINS = {
  items: [
    {
      expenseId: "tgt-infra-same",
      via: "settlement",
      multiple: false,
      parcelas: [
        { parcelaIndex: 4, origin: NUBANK },
        { parcelaIndex: 5, origin: NUBANK },
      ],
      origins: [NUBANK],
    },
    {
      expenseId: "tgt-infra-mixed",
      via: "settlement",
      multiple: true,
      parcelas: [
        { parcelaIndex: 4, origin: NUBANK },
        { parcelaIndex: 5, origin: LATAM },
      ],
      origins: [NUBANK, LATAM],
    },
    ...TELHANORTE.map((t) => ({
      expenseId: t.id,
      via: "rateio",
      multiple: false,
      parcelas: [],
      origins: [LATAM],
    })),
  ],
};

// Confirma, em tempo de definição do fixture, que o vestígio "secreto" nunca
// entra no corpo mockado — se algum dia alguém colar essa origem em
// FULL_PAID_ORIGINS por engano, este teste acusa antes mesmo do Playwright.
const FULL_PAID_ORIGINS_BODY = JSON.stringify(FULL_PAID_ORIGINS);
if (
  FULL_PAID_ORIGINS_BODY.includes(HIDDEN_LAST4) ||
  FULL_PAID_ORIGINS_BODY.includes(HIDDEN_NICKNAME)
) {
  throw new Error("fixture inválido: vestígio oculto vazou no mock");
}

type PaidOriginsMode = "ok" | "delay" | "error500";

function commonRoutes(page: Page) {
  return page.route("http://localhost:3001/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/auth/me")
      return route.fulfill(
        json({
          id: "user-test",
          username: "test",
          name: "Usuário Teste",
          role: "ADMIN",
          tenantId: "tenant-test",
          allowedModules: [],
          allowedProjects: [],
          allowedProjectTypes: [],
        }),
      );
    if (path === "/auth/config")
      return route.fulfill(
        json({ registerEnabled: false, guestEnabled: false }),
      );
    if (path === `/projects/${projectId}`)
      return route.fulfill(
        json({
          id: projectId,
          name: "Reforma Teste",
          type: "REFORMA",
          onboardedAt: "2026-01-01T00:00:00.000Z",
          rooms: [],
        }),
      );
    if (path === "/projects")
      return route.fulfill(
        json([{ id: projectId, name: "Reforma Teste", type: "REFORMA" }]),
      );
    if (path === "/tenant/credit-cards") return route.fulfill(json([]));
    if (path === "/tenant/bank-accounts") return route.fulfill(json([]));
    if (path === `/projects/${projectId}/expenses/cross-project`)
      return route.fulfill(json([]));
    if (path === `/projects/${projectId}/category-budgets`)
      return route.fulfill(json([]));
    // catch-all: o alvo deste arquivo é o comportamento de paid-origins, não
    // o restante da árvore.
    return route.fulfill(json([]));
  });
}

async function openReformaExpenses(
  page: Page,
  viewport: ViewportSize,
  opts: {
    view: "general" | "category";
    expenses?: unknown[];
    paidOrigins?: unknown;
    paidOriginsMode?: PaidOriginsMode;
  },
) {
  const {
    view,
    expenses = FULL_EXPENSES,
    paidOrigins = FULL_PAID_ORIGINS,
    paidOriginsMode = "ok",
  } = opts;

  // AGENTS.md: congelar o relógio ANTES do goto para qualquer teste
  // dependente de data/mês corrente.
  await page.clock.setFixedTime(new Date("2026-07-15T12:00:00.000Z"));
  await page.setViewportSize(viewport);
  await page
    .context()
    .addCookies([
      { name: "rf_token", value: "test", url: "http://localhost:3013" },
    ]);

  await commonRoutes(page);

  await page.route(
    `http://localhost:3001/projects/${projectId}/expenses/paid-origins`,
    async (route) => {
      if (paidOriginsMode === "error500") {
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ message: "erro interno" }),
        });
      }
      if (paidOriginsMode === "delay") {
        // Nunca resolve dentro da janela do teste — simula loading eterno
        // sem travar o Playwright (timeout do próprio teste corta a espera).
        await new Promise((resolve) => setTimeout(resolve, 60_000));
      }
      return route.fulfill(json(paidOrigins));
    },
  );

  await page.route(
    `http://localhost:3001/projects/${projectId}/expenses**`,
    async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname !== `/projects/${projectId}/expenses`) {
        return route.fallback();
      }
      return route.fulfill(
        json({
          items: expenses,
          total: expenses.length,
          page: 1,
          pageSize: 2000,
          totalPages: 1,
        }),
      );
    },
  );

  await page.goto(`/projects/${projectId}/expenses?period=ALL&view=${view}`);
  await expect(
    page.getByRole("heading", { name: "Despesas" }).filter({ visible: true }),
  ).toBeVisible();
}

function attachDiagnostics(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const badResponses: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
  });
  page.on("response", (res) => {
    const status = res.status();
    if (status >= 400) badResponses.push(`${status} ${res.url()}`);
  });
  return { consoleErrors, pageErrors, badResponses };
}

async function expectNoHorizontalOverflow(page: Page) {
  const { clientWidth, scrollWidth } = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
}

// Linha da despesa, escopada pelo container real de row (mesma classe em
// MonthlyExpenseView e CategoryExpenseView) — evita falso-positivo por
// texto solto em outro lugar da árvore.
function rowByText(page: Page, text: string) {
  return page.locator("div.px-4.py-2\\.5", { hasText: text });
}

const VIEWPORTS: ViewportSize[] = [
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
];

test.describe("Expenses — origem por parcela na REFORMA (#424)", () => {
  for (const viewport of VIEWPORTS) {
    test(`view=general — origem por ocorrência @ ${viewport.width}px`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "desktop",
        "viewports are explicitly owned by this spec",
      );
      const diag = attachDiagnostics(page);
      await openReformaExpenses(page, viewport, { view: "general" });
      await expectNoHorizontalOverflow(page);

      // Lista continua funcional e as três famílias de despesa aparecem.
      await expect(
        page.getByText("Reforma Infra A", { exact: true }).first(),
      ).toBeVisible();
      await expect(
        page.getByText("Reforma Infra B", { exact: true }).first(),
      ).toBeVisible();
      await expect(
        page.getByText("Telhanorte 1", { exact: true }).first(),
      ).toBeVisible();
      await expect(
        page.getByText("Fatura Oculta", { exact: true }).first(),
      ).toBeVisible();
      await expect(
        page.getByText("Compra na carteira", { exact: true }).first(),
      ).toBeVisible();

      // O5: infra-same — MESMO cartão nas 2 parcelas (índice 4 e 5) → 2
      // rótulos "Nubank ••3541" (não 1, não 3 — nem colapsa nem duplica).
      // O5/O6: infra-mixed — 1x "Nubank ••3541" (parcela 5/6, índice 4) e
      // 1x "Latam ••5572" (parcela 6/6, índice 5) — precedência/dedup não se
      // confundem entre despesas diferentes.
      // O4: Telhanorte — via=rateio aplica a MESMA origem a cada uma das 9
      // despesas rateadas → 9x "Latam ••5572", nem mais nem menos.
      await expect(page.getByText("Nubank ••3541")).toHaveCount(3);
      await expect(page.getByText("Latam ••5572")).toHaveCount(10);
      // Nenhum rótulo pode ser um subconjunto textual de outro (ex.: dedup
      // por prefixo) — a soma bate exatamente com o total de badges "••".
      await expect(page.getByText(/••/)).toHaveCount(13);

      // O9 fim-a-fim: o rótulo do cartão está na OCORRÊNCIA correta —
      // parcela 5/6 (occIndex 5 ↔ parcelaIndex 4) é Nubank, parcela 6/6
      // (occIndex 6 ↔ parcelaIndex 5) é Latam. Nunca o inverso.
      await expect(
        rowByText(page, "parcela 5/6")
          .filter({ hasText: "Reforma Infra B" })
          .filter({ hasText: "Nubank ••3541" }),
      ).toHaveCount(1);
      await expect(
        rowByText(page, "parcela 6/6")
          .filter({ hasText: "Reforma Infra B" })
          .filter({ hasText: "Latam ••5572" }),
      ).toHaveCount(1);
      await expect(
        rowByText(page, "parcela 6/6")
          .filter({ hasText: "Reforma Infra B" })
          .filter({ hasText: "Nubank" }),
      ).toHaveCount(0);

      // O8/O7: carteira e alvo redigido não mostram NENHUM badge de origem.
      await expect(
        rowByText(page, "Compra na carteira").filter({ hasText: /••/ }),
      ).toHaveCount(0);
      await expect(
        rowByText(page, "Fatura Oculta").filter({ hasText: /••/ }),
      ).toHaveCount(0);
      await expect(page.getByText(HIDDEN_LAST4)).toHaveCount(0);
      await expect(page.getByText(HIDDEN_NICKNAME)).toHaveCount(0);

      // O1: o badge é somente leitura — não é botão, não abre modal.
      await expect(page.getByRole("button", { name: /Nubank/ })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /Latam/ })).toHaveCount(0);

      // Hit-testing: chip de ação pré-existente continua presente/visível
      // mesmo com o badge novo na mesma linha (regressão de layout). O texto
      // "Pago" só é visível a partir do breakpoint `sm:` (a `<span>` some em
      // 375/390px), então localizamos pelo `title`, estável em qualquer
      // largura, em vez do nome acessível (que muda com o breakpoint).
      const statusChip = page
        .getByTitle("Clique para alternar entre Planejado e Pago")
        .first();
      await expect(statusChip).toBeVisible();
      const box = await statusChip.boundingBox();
      expect(box).not.toBeNull();
      // Piso real, não arbitrário: abaixo do breakpoint `sm:` o `<span>`
      // "Pago"/"Planejado" some por design (comentário acima) e só o ícone
      // (w-3.5 h-3.5 = 14px) + `py-0.5` (2px+2px) renderiza — 18px é o
      // mínimo LEGÍTIMO nessa largura, não um alvo de toque (AGENTS.md exige
      // 44px só para alvos de toque; este chip é inline e explicitamente
      // isento). 18px não corta o ícone (14px cabe nos 18px) nem viola o
      // piso tipográfico (nenhum texto <11px é renderizado aqui). 20px não
      // correspondia a nenhum requisito documentado — apenas ao valor
      // (maior, com texto) do breakpoint desktop.
      expect(box!.height).toBeGreaterThanOrEqual(18); // chip inline, não é o alvo de 44px
      // O alvo de toque real (CTA) segue o piso v3.1.
      const cta = page
        .getByRole("button", { name: "Nova despesa", exact: true })
        .filter({ visible: true });
      if ((await cta.count()) > 0) {
        const ctaBox = await cta.first().boundingBox();
        if (ctaBox) expect(ctaBox.height).toBeGreaterThanOrEqual(44);
      }

      expect(diag.pageErrors).toEqual([]);
      expect(diag.consoleErrors).toEqual([]);
      expect(diag.badResponses).toEqual([]);
    });

    test(`view=category — origem agregada por despesa @ ${viewport.width}px`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "desktop",
        "viewports are explicitly owned by this spec",
      );
      const diag = attachDiagnostics(page);
      await openReformaExpenses(page, viewport, { view: "category" });
      await expectNoHorizontalOverflow(page);

      // O5: infra-same tem 1 única origem (Nubank em ambas parcelas) →
      // agregado mostra o rótulo específico, não "Múltiplas origens".
      await expect(
        rowByText(page, "Reforma Infra A").filter({ hasText: "Nubank ••3541" }),
      ).toHaveCount(1);
      await expect(
        rowByText(page, "Reforma Infra A").filter({
          hasText: "Múltiplas origens",
        }),
      ).toHaveCount(0);

      // O6: infra-mixed tem 2 origens distintas → agregado mostra SOMENTE
      // "Múltiplas origens", nunca um last4/nickname específico (evita
      // vazar qual das duas origens "venceu").
      await expect(
        rowByText(page, "Reforma Infra B").filter({
          hasText: "Múltiplas origens",
        }),
      ).toHaveCount(1);
      await expect(
        rowByText(page, "Reforma Infra B").filter({ hasText: "Nubank" }),
      ).toHaveCount(0);
      await expect(
        rowByText(page, "Reforma Infra B").filter({ hasText: "Latam" }),
      ).toHaveCount(0);

      // O4: cada uma das 9 despesas Telhanorte é sua própria linha agregada
      // com a MESMA origem — 9 rótulos "Latam ••5572", 1 por despesa.
      await expect(page.getByText("Latam ••5572")).toHaveCount(9);
      await expect(page.getByText("Múltiplas origens")).toHaveCount(1);
      await expect(page.getByText("Nubank ••3541")).toHaveCount(1);
      await expect(page.getByText(/••/)).toHaveCount(10);

      // O8/O7: carteira e redigido continuam sem badge no agregado também.
      await expect(
        rowByText(page, "Compra na carteira").filter({ hasText: /••/ }),
      ).toHaveCount(0);
      await expect(
        rowByText(page, "Fatura Oculta").filter({ hasText: /••/ }),
      ).toHaveCount(0);
      await expect(page.getByText(HIDDEN_LAST4)).toHaveCount(0);
      await expect(page.getByText(HIDDEN_NICKNAME)).toHaveCount(0);

      expect(diag.pageErrors).toEqual([]);
      expect(diag.consoleErrors).toEqual([]);
      expect(diag.badResponses).toEqual([]);
    });

    test(`redação por acesso — sem vestígio de last4/nickname @ ${viewport.width}px`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "desktop",
        "viewports are explicitly owned by this spec",
      );
      const diag = attachDiagnostics(page);
      let capturedBody = "";
      page.on("response", async (res) => {
        if (
          res.url() ===
          `http://localhost:3001/projects/${projectId}/expenses/paid-origins`
        ) {
          capturedBody = await res.text().catch(() => "");
        }
      });

      // O10/O7: o back-end redige por OMISSÃO — o alvo simplesmente não
      // aparece em `items`, mesmo que exista uma origem "de verdade" que o
      // requester não pode ver. Simulamos o contrato: `items: []`.
      await openReformaExpenses(page, viewport, {
        view: "general",
        expenses: [REDACTED_TARGET],
        paidOrigins: { items: [] },
      });
      await expectNoHorizontalOverflow(page);

      await expect(
        page.getByText("Fatura Oculta", { exact: true }).first(),
      ).toBeVisible();
      await expect(page.getByText(/••/)).toHaveCount(0);
      await expect(page.getByText(HIDDEN_LAST4)).toHaveCount(0);
      await expect(page.getByText(HIDDEN_NICKNAME)).toHaveCount(0);
      expect(capturedBody).not.toContain(HIDDEN_LAST4);
      expect(capturedBody).not.toContain(HIDDEN_NICKNAME);
      expect(capturedBody).not.toContain("last4");

      expect(diag.pageErrors).toEqual([]);
      expect(diag.consoleErrors).toEqual([]);
    });

    test(`carteira sem origem — nenhum badge @ ${viewport.width}px`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "desktop",
        "viewports are explicitly owned by this spec",
      );
      const diag = attachDiagnostics(page);
      // O8: fonte carteira (sem cartão/conta) nunca emite origem.
      await openReformaExpenses(page, viewport, {
        view: "general",
        expenses: [WALLET_TARGET],
        paidOrigins: { items: [] },
      });
      await expectNoHorizontalOverflow(page);

      await expect(
        page.getByText("Compra na carteira", { exact: true }).first(),
      ).toBeVisible();
      await expect(page.getByText(/••/)).toHaveCount(0);

      expect(diag.pageErrors).toEqual([]);
      expect(diag.consoleErrors).toEqual([]);
    });

    test(`paid-origins pendente (loading) não quebra a lista @ ${viewport.width}px`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "desktop",
        "viewports are explicitly owned by this spec",
      );
      const diag = attachDiagnostics(page);
      await openReformaExpenses(page, viewport, {
        view: "general",
        expenses: [INFRA_SAME],
        paidOriginsMode: "delay",
      });
      await expectNoHorizontalOverflow(page);

      // Estado de loading: nenhum badge, lista continua renderizada, sem
      // spinner/erro dentro da linha de valor monetário (AGENTS.md:60).
      await expect(
        page.getByText("Reforma Infra A", { exact: true }).first(),
      ).toBeVisible();
      await expect(page.getByText(/••/)).toHaveCount(0);

      expect(diag.pageErrors).toEqual([]);
      expect(diag.consoleErrors).toEqual([]);
    });

    test(`paid-origins com erro 500 não quebra a lista @ ${viewport.width}px`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "desktop",
        "viewports are explicitly owned by this spec",
      );
      const diag = attachDiagnostics(page);
      await openReformaExpenses(page, viewport, {
        view: "general",
        expenses: [INFRA_SAME],
        paidOriginsMode: "error500",
      });
      await expectNoHorizontalOverflow(page);

      // A lista principal (endpoint /expenses) segue 200 — só paid-origins
      // falhou. A UI deve degradar sem badge, nunca quebrar a linha.
      await expect(
        page.getByText("Reforma Infra A", { exact: true }).first(),
      ).toBeVisible();
      await expect(page.getByText(/••/)).toHaveCount(0);

      // Nenhuma exceção não-tratada. O `console.error` app-level (via
      // `isError` do react-query) também deve ficar mudo — mas o Chromium
      // SEMPRE emite "Failed to load resource: ... 500 ..." como mensagem de
      // console tipo "error" para QUALQUER fetch/XHR com status >=400, é
      // gerado pela camada de rede do navegador, não pelo código do app, e
      // dispara mesmo com o fetch envolto em try/catch silencioso (validado
      // fora da árvore da aplicação). Como este teste INDUZ deliberadamente
      // o 500 em paid-origins, esse ruído de rede é esperado nesta única
      // origem — filtramos exatamente esse ruído, no mesmo espírito do
      // filtro já aplicado a `badResponses` logo abaixo, sem mascarar
      // nenhum outro console.error real.
      expect(diag.pageErrors).toEqual([]);
      const unexpectedConsoleErrors = diag.consoleErrors.filter(
        (entry) => !/Failed to load resource.*status of 500/.test(entry),
      );
      expect(unexpectedConsoleErrors).toEqual([]);
      // A ÚNICA resposta >=400 esperada é a de paid-origins.
      const unexpectedBad = diag.badResponses.filter(
        (entry) => !entry.includes("/expenses/paid-origins"),
      );
      expect(unexpectedBad).toEqual([]);
    });
  }
});
