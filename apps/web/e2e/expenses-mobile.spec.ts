import { test, expect, type Page, type ViewportSize } from "@playwright/test";

const projectId = "pessoal-test";
const expenses = [
  {
    id: "card-paid",
    projectId,
    tipoDespesa: "MERCADO",
    titulo: "Compra no cartão",
    valor: 12990,
    quantidade: 1,
    valorTotal: 12990,
    formaPagamento: "CARTAO_CREDITO",
    cardLast4: "4242",
    dataPagamento: "2026-07-05T12:00:00.000Z",
    dataCompra: "2026-07-05T12:00:00.000Z",
    status: "PAGO",
  },
  {
    id: "account-paid",
    projectId,
    tipoDespesa: "MORADIA",
    titulo: "Conta paga à vista",
    valor: 4500,
    quantidade: 1,
    valorTotal: 4500,
    formaPagamento: "PIX",
    bankLast4: "0001",
    dataPagamento: "2026-07-10T12:00:00.000Z",
    dataCompra: "2026-07-10T12:00:00.000Z",
    status: "PAGO",
  },
  {
    id: "planned",
    projectId,
    tipoDespesa: "LAZER",
    titulo: "Plano de viagem",
    valor: 30000,
    quantidade: 1,
    valorTotal: 30000,
    formaPagamento: "A_VISTA",
    dataPagamento: "2026-07-20T12:00:00.000Z",
    status: "PLANEJADO",
    paidParcelas: null,
  },
];

function json(body: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

async function openExpenses(page: Page, viewport: ViewportSize) {
  await page.setViewportSize(viewport);
  await page
    .context()
    .addCookies([
      { name: "rf_token", value: "test", url: "http://localhost:3013" },
    ]);
  await page.route("http://localhost:3001/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/auth/me")
      return route.fulfill(
        json({
          id: "user-test",
          username: "test",
          name: "Usuário Teste",
          role: "OWNER",
          tenantId: "tenant-test",
          allowedModules: [],
          allowedProjects: [],
          allowedProjectTypes: [],
        }),
      );
    if (path === `/projects/${projectId}/expenses/cross-project`)
      return route.fulfill(json([]));
    if (path === `/projects/${projectId}/expenses/planned`)
      return route.fulfill(
        json(expenses.filter((expense) => expense.status === "PLANEJADO")),
      );
    if (path === `/projects/${projectId}/expenses`)
      return route.fulfill(
        json({
          items: expenses,
          total: expenses.length,
          page: 1,
          pageSize: 2000,
          totalPages: 1,
        }),
      );
    if (path === `/projects/${projectId}`)
      return route.fulfill(
        json({
          id: projectId,
          name: "Pessoal Teste",
          type: "PESSOAL",
          rooms: [],
        }),
      );
    if (path === "/tenant/credit-cards")
      return route.fulfill(
        json([
          {
            id: "card-1",
            last4: "4242",
            nickname: "Teste",
            brand: "VISA",
            closingDay: 10,
            dueDay: 17,
          },
        ]),
      );
    if (path === "/tenant/bank-accounts")
      return route.fulfill(
        json([
          {
            id: "account-1",
            last4: "0001",
            nickname: "Conta Teste",
            institution: "Banco Teste",
          },
        ]),
      );
    if (path === "/projects")
      return route.fulfill(
        json([{ id: projectId, name: "Pessoal Teste", type: "PESSOAL" }]),
      );
    if (path === `/projects/${projectId}/category-budgets`)
      return route.fulfill(json([]));
    // A MobileExpensesScreen (nova superfície mobile) lê a lista de
    // /monthly-overview/origin-items-yearly (não de /expenses, que só a tabela
    // desktop consome) e a carteira de /monthly-overview/account-view.
    if (
      path === `/projects/${projectId}/monthly-overview/origin-items-yearly`
    )
      return route.fulfill(
        json({
          year: 2026,
          kind: "all",
          last4: "",
          total: 47480,
          items: [
            {
              mes: "2026-07",
              data: "2026-07-05",
              descricao: "Compra no cartão",
              valor: 12990,
              tipoDespesa: "ALIMENTACAO",
              status: "PAGO",
              projetoOrigem: null,
              origem: {
                kind: "card",
                last4: "5876",
                nickname: "Itaú Mastercard",
              },
            },
            {
              mes: "2026-07",
              data: "2026-07-10",
              descricao: "Conta paga à vista",
              valor: 4500,
              tipoDespesa: "MORADIA",
              status: "PAGO",
              projetoOrigem: null,
              origem: {
                kind: "conta",
                last4: "4247",
                nickname: "Itaú Personnalité",
              },
            },
            {
              mes: "2026-07",
              data: "2026-07-20",
              descricao: "Plano de viagem",
              valor: 30000,
              tipoDespesa: "LAZER",
              status: "PLANEJADO",
              projetoOrigem: null,
            },
          ],
        }),
      );
    if (path === `/projects/${projectId}/monthly-overview/account-view`)
      return route.fulfill(
        json({
          mesSelecionado: "2026-07",
          caixaHoje: 0,
          entrouMes: 0,
          saiuMes: 17490,
          faltaPagarMes: 0,
          recebimentosPrevistosMes: 0,
          sobraPrevista: 0,
          devoCartaoTotal: 12990,
          cartoes: [
            {
              nickname: "Itaú Mastercard",
              last4: "5876",
              faturaAtual: 12990,
              faturaPendente: 12990,
              dueMonth: "2026-07",
              vencimento: "2026-07-17",
              status: "a pagar",
              limiteUsadoPct: null,
              limiteUsado: null,
              limiteTotal: null,
            },
          ],
          contas: [{ last4: "4247", nome: "Itaú Personnalité" }],
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
        }),
      );
    // Cadastro dos cartões do PROJETO ATUAL (closingDay real → status da fatura).
    if (path === `/projects/${projectId}/credit-cards`)
      return route.fulfill(
        json([
          {
            id: "card-5876",
            last4: "5876",
            nickname: "Itaú Mastercard",
            brand: "MASTERCARD",
            institution: "Itaú",
            closingDay: 10,
            dueDay: 17,
          },
        ]),
      );
    return route.fulfill(json([]));
  });
  await page.goto(`/projects/${projectId}/expenses?period=ALL&view=general`);
  // Ambas as árvores (mobile `lg:hidden` + desktop `hidden lg:block`) ficam no
  // DOM; filtramos por visibilidade para casar com o breakpoint em teste.
  await expect(
    page.getByRole("heading", { name: "Despesas" }).filter({ visible: true }),
  ).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page) {
  const { clientWidth, scrollWidth } = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
}

test.describe("Expenses — phase-AB mobile quick wins", () => {
  for (const viewport of [
    { width: 360, height: 800 },
    { width: 390, height: 844 },
    { width: 402, height: 840 },
  ]) {
    test(`mobile ${viewport.width}x${viewport.height}`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "desktop",
        "viewports are explicitly owned by this spec",
      );
      await openExpenses(page, viewport);
      await expectNoHorizontalOverflow(page);

      // Resumo "Gastei de verdade" com quebra por origem (mobile screen).
      await expect(
        page.getByText(/Gastei de verdade/i).filter({ visible: true }),
      ).toBeVisible();
      await expect(
        page.getByText("No cartão", { exact: true }).filter({ visible: true }),
      ).toBeVisible();
      await expect(
        page
          .getByText("Saiu da conta", { exact: true })
          .filter({ visible: true }),
      ).toBeVisible();

      // bug 4: carteira de cartões "físicos" — gradiente + •••• last4 + badge
      // de fatura (status derivado do cadastro real via card-wallet-status).
      await expect(
        page.getByText("Carteira · faturas espelham o banco"),
      ).toBeVisible();
      await expect(page.getByText("•••• 5876")).toBeVisible();
      await expect(page.getByText("fatura aberta")).toBeVisible();

      // A despesa do cartão aparece na lista mobile (agrupada por dia).
      await expect(
        page
          .getByText("Compra no cartão", { exact: true })
          .filter({ visible: true }),
      ).toBeVisible();

      // Piso v3.1: chips de filtro com alvo ≥44px + toggle de neutros presente.
      const todosChip = page
        .getByRole("button", { name: "Todos", exact: true })
        .filter({ visible: true });
      await expect(todosChip).toBeVisible();
      expect((await todosChip.boundingBox())?.height).toBeGreaterThanOrEqual(
        44,
      );
      await expect(
        page
          .getByText("Mostrar neutros", { exact: true })
          .filter({ visible: true }),
      ).toBeVisible();
    });
  }

  test("desktop 1280x800", async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "viewport is explicitly owned by this spec",
    );
    await openExpenses(page, { width: 1280, height: 800 });
    await expectNoHorizontalOverflow(page);
    // A tabela desktop (única árvore visível em ≥lg) continua listando a despesa.
    await expect(
      page
        .getByText("Compra no cartão", { exact: true })
        .filter({ visible: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Nova despesa", exact: true }),
    ).toHaveCount(1);
    await expect(page.getByRole("button", { name: /Filtrar/ })).toBeHidden();
    await expect(page.getByPlaceholder("Buscar despesas...")).toBeVisible();
    await expect(page.getByRole("button", { name: "Filtros" })).toBeVisible();
    const desktopCta = page.getByRole("button", {
      name: "Nova despesa",
      exact: true,
    });
    expect(
      await desktopCta.evaluate((el) => getComputedStyle(el).position),
    ).not.toBe("fixed");
  });
});
