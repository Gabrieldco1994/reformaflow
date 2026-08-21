import { test, expect, type Page, type ViewportSize } from "@playwright/test";

/**
 * ─── O QUE ESTE ARQUIVO DEIXOU DE COBRIR, E POR QUÊ (#453 / #529) ──────────
 *
 * Este arquivo tinha 3 testes de viewport móvel (360/390/402) que mediam o
 * `MobileExpensesScreen`: os cartões "Gastei de verdade", "Saiu da conta",
 * "Carteira · faturas espelham o banco", o chip "Todos", "Mostrar
 * investimentos". Eles foram REMOVIDOS, não consertados.
 *
 * Motivo: `expenses/page.tsx` só monta o `MobileExpensesScreen` quando
 * `projectType === 'PESSOAL'` (a linha `if (projectType !== 'PESSOAL') return
 * <ExpensesView/>`). E o #529 tornou o redirect ao hub INCONDICIONAL no
 * PESSOAL — `/expenses` desse tipo nunca mais monta. As duas condições juntas
 * tornam aquela superfície inalcançável para qualquer perfil, em qualquer tipo
 * de projeto. Não existe fixture honesta que a alcance.
 *
 * NÃO adianta mover para REFORMA: lá a mesma rota renderiza o `ExpensesView`,
 * que é OUTRO componente e não tem nenhum daqueles elementos. Os testes
 * passariam a medir outra tela — exatamente o erro que estes comentários
 * existem para impedir.
 *
 * Se o `MobileExpensesScreen` voltar a ser alcançável, a cobertura tem de ser
 * reescrita a partir do perfil que o alcança, não ressuscitada daqui.
 *
 * O que SOBROU é o teste desktop, que mede o `ExpensesView` — componente vivo
 * e alcançável. Ele migrou de PESSOAL para REFORMA pelo mesmo motivo dos
 * testes do #490: a propriedade é da TELA e independe do tipo.
 */

const projectId = "reforma-test";
const expenses = [
  {
    id: "card-paid",
    projectId,
    tipoDespesa: "MATERIAL_CONSTRUCAO",
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
  // As fixtures abaixo sao de julho/2026 e a tela filtra pelo mes corrente:
  // sem congelar o relogio o teste passa a falhar na virada de mes.
  await page.clock.setFixedTime(new Date("2026-07-15T12:00:00.000Z"));
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
          role: "ADMIN",
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
          name: "Reforma Teste",
          type: "REFORMA",
          onboardedAt: "2026-01-01T00:00:00.000Z",
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
        json([{ id: projectId, name: "Reforma Teste", type: "REFORMA" }]),
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
              tipoDespesa: "MATERIAL_CONSTRUCAO",
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
    // REFORMA faz uma query que o PESSOAL não fazia (`enabled: projectType !==
    // 'PESSOAL'`). Sem esta rota o fallback devolvia `[]`, e
    // `buildPaidOriginIndex` itera `response.items` — `undefined` → estouro e
    // ErrorBoundary; a tela nem chegava a montar.
    if (path === `/projects/${projectId}/expenses/paid-origins`)
      return route.fulfill(json({ items: [] }));
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

test.describe("Expenses — phase-AB, tabela desktop do ExpensesView", () => {

  test("desktop 1280x800", async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "viewport is explicitly owned by this spec",
    );
    await openExpenses(page, { width: 1280, height: 800 });
    await expect(
      page,
      "guarda U4 disparou em REFORMA — a fixture não deveria colapsar aqui",
    ).toHaveURL(new RegExp(`/projects/${projectId}/expenses`));
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
