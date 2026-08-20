import { expect, test, type Page } from "@playwright/test";

/**
 * W1 (#448) — identidades explícitas (`cardId`/`accountId`) + contrato
 * MIXED-VERSION das ações de fatura e do rateio parcial.
 *
 * Deploy não é atômico: bundle antigo conversa com API nova e bundle novo
 * conversa com API antiga. Este spec cobre as DUAS direções, sempre pelo
 * resultado VISÍVEL pro usuário (nunca por implementação):
 *
 *   A) web novo + API nova   → payload carrega `cardId`/`accountId` E o
 *                              último4 legado; ação completa.
 *   B) web novo + API antiga → account-view sem ids ⇒ payload sem as chaves
 *                              novas (byte-a-byte o legado); ação completa.
 *   C) web novo + API antiga ESTRITA (rejeita chave desconhecida, 400) e
 *      web novo + API nova que RECUSA a identidade (400 de divergência) →
 *      erro honesto e visível, EXATAMENTE 1 POST (nunca há reenvio sem os
 *      ids — isso seria downgrade de identidade), diálogo aberto e CTA ainda
 *      clicável (sem CTA morta, sem falso sucesso, sem escrita no lugar
 *      errado).
 *   D) web antigo + API nova (rateio parcial) → payload redigido, sem a
 *      metadata `hiddenTargetsCount`/`hiddenAllocationCents`: nada de `NaN`,
 *      nada de linha de ocultos, nenhuma metadata vazando no DOM, e o POST de
 *      ratear NÃO amplia escopo (alvos ⊆ alvos visíveis).
 *
 * Toda a rede é interceptada com `page.route` — nenhum backend real sobe.
 * Relógio congelado ANTES do goto (`page.clock.setFixedTime`), suíte validada
 * com TZ=UTC.
 */

const personalId = "w1-identity-personal";
const CARD_ID = "ckcard000000000000000001";
const ACCOUNT_ID = "ckacct000000000000000001";
const CARD_LAST4 = "4488";
const BANK_LAST4 = "1881";
const DUE_MONTH = "2026-08";
const FATURA_CENTS = 250_00;
const FINGERPRINT = "fp-w1-4488-2026-08";
const SOURCE_ID = "cksource00000000000000001";
const SOURCE_TOTAL_CENTS = 300_00;

function json(body: unknown, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

type Mode = "new-api" | "legacy-api";

function cardFixture(
  mode: Mode,
  status: "a pagar" | "paga" | "parcial",
  ambiguous = false,
) {
  return {
    // B1b (#448): último4 AMBÍGUO (>1 cartão ativo com aquele final no projeto)
    // não publica id nem verbo — `payInvoice`/`undoInvoicePayment` respondem
    // 409 nesse caso, e emitir o id adivinhado deixaria um web novo mandá-lo de
    // volta e passar por cima do 409.
    ...(mode === "new-api" && ambiguous
      ? { cardId: null, actions: [], fingerprint: null }
      : {}),
    ...(mode === "new-api" && !ambiguous
      ? { cardId: CARD_ID, actions: status === "paga" ? ["undo"] : ["pay", "undo"], fingerprint: FINGERPRINT }
      : {}),
    nickname: "Nubank QA",
    last4: CARD_LAST4,
    faturaAtual: FATURA_CENTS,
    faturaPendente: status === "paga" ? 0 : FATURA_CENTS,
    faturaPaga: status === "a pagar" ? 0 : FATURA_CENTS,
    residualDeclarado: 0,
    possuiIntervencaoManual: false,
    ajusteManualTotal: 0,
    dueMonth: DUE_MONTH,
    vencimento: "2026-08-20T12:00:00.000Z",
    status,
    limiteUsadoPct: 25,
    limiteUsado: FATURA_CENTS,
    limiteTotal: 1_000_00,
  };
}

function contaFixture(mode: Mode) {
  return {
    ...(mode === "new-api" ? { accountId: ACCOUNT_ID } : {}),
    last4: BANK_LAST4,
    nome: "Itaú QA",
  };
}

/** Compra rateada da fonte PESSOAL — entra na lista de movimentações. */
function sourceSaida() {
  return {
    id: SOURCE_ID,
    kind: "saida",
    descricao: "Compras TelhaNorte",
    data: "2026-08-10T12:00:00.000Z",
    forma: "pix",
    valor: SOURCE_TOTAL_CENTS,
    realizado: false,
    status: "PLANEJADO",
    cardLast4: null,
    bankLast4: null,
    tipoDespesa: "OUTROS",
    isInvoice: false,
    editavel: true,
    dueMonth: null,
    projetoOrigem: null,
    foreignExpenseId: null,
  };
}

/** Linha de FATURA na lista de movimentações (`saidas[].isInvoice`). */
function invoiceSaida(mode: Mode, ambiguous: boolean) {
  return {
    id: null,
    kind: "saida",
    descricao: "Fatura Nubank QA",
    data: "2026-08-20T12:00:00.000Z",
    forma: "cartao",
    valor: FATURA_CENTS,
    realizado: false,
    status: "PLANEJADO",
    ...(mode === "new-api"
      ? ambiguous
        ? { cardId: null, actions: [], fingerprint: null }
        : { cardId: CARD_ID, actions: ["pay"], fingerprint: FINGERPRINT }
      : {}),
    cardLast4: CARD_LAST4,
    bankLast4: null,
    tipoDespesa: "PAGAMENTO_FATURA_CARTAO",
    isInvoice: true,
    editavel: false,
    dueMonth: DUE_MONTH,
    projetoOrigem: null,
    foreignExpenseId: null,
  };
}

function accountView(
  mode: Mode,
  cardStatus: "a pagar" | "paga" | "parcial",
  opts?: { ambiguous?: boolean; withInvoiceRow?: boolean },
) {
  const ambiguous = opts?.ambiguous ?? false;
  return {
    mesSelecionado: DUE_MONTH,
    caixaHoje: 5_000_00,
    entrouMes: 0,
    saiuMes: SOURCE_TOTAL_CENTS,
    faltaPagarMes: FATURA_CENTS,
    recebimentosPrevistosMes: 0,
    sobraPrevista: 0,
    devoCartaoTotal: FATURA_CENTS,
    cartoes: [cardFixture(mode, cardStatus, ambiguous)],
    contas: [contaFixture(mode)],
    saidas: opts?.withInvoiceRow
      ? [invoiceSaida(mode, ambiguous), sourceSaida()]
      : [sourceSaida()],
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

const sourceExpense = {
  id: SOURCE_ID,
  projectId: personalId,
  tipoDespesa: "OUTROS",
  valor: SOURCE_TOTAL_CENTS,
  quantidade: 1,
  valorTotal: SOURCE_TOTAL_CENTS,
  titulo: "Compras TelhaNorte",
  fornecedor: "TelhaNorte",
  formaPagamento: "A_VISTA",
  dataPagamento: "2026-08-10T12:00:00.000Z",
  status: "PLANEJADO",
  linkedExpenseId: null,
  cardLast4: null,
  bankLast4: null,
};

/**
 * Rateio visível pela metade.
 *  - `redacted`: contrato B1b (o atual). `rateadoCents` é Σ dos itens
 *    VISÍVEIS, então o payload é deep-equal ao de uma compra sem nada oculto —
 *    é isso que impede o web de inferir, e por isso a sobra aparece.
 *  - `legacy`: servidor pré-B1b, que ainda emite `hiddenTargetsCount`/
 *    `hiddenAllocationCents` e um `rateadoCents` total-aware. Mantido para
 *    provar que o bundle novo IGNORA os campos mortos em vez de renderizá-los.
 */
function rateioPayload(kind: "legacy" | "redacted") {
  const items = [
    {
      targetExpenseId: "tgt-visivel-1",
      titulo: "Item visível 1",
      fornecedor: null,
      projectId: personalId,
      projectName: "Pessoal QA",
      projectType: "PESSOAL",
      status: "PLANEJADO",
      allocationCents: 100_00,
      plannedValorTotalCents: 100_00,
    },
  ];
  const base = {
    sourceExpenseId: SOURCE_ID,
    rateado: true,
    totalSourceCents: SOURCE_TOTAL_CENTS,
    rateadoCents: kind === "legacy" ? 300_00 : 100_00,
    sobraCents: kind === "legacy" ? 0 : 200_00,
    items,
  };
  if (kind === "legacy") {
    return {
      ...base,
      removedTargetsCount: 0,
      hiddenTargetsCount: 2,
      hiddenAllocationCents: 200_00,
    };
  }
  return base;
}

/** Fixture mínima do cockpit `/monthly` — a fila de pendências mora lá também. */
const monthRow = {
  mes: DUE_MONTH,
  totalDespesas: SOURCE_TOTAL_CENTS,
  totalRecebimentos: 0,
  despesasRealizadas: 0,
  recebimentosRealizados: 0,
  saldoMes: -SOURCE_TOTAL_CENTS,
  saldoMesRealizado: 0,
  porOrigem: {},
  porCategoria: [{ categoria: "Outros", valor: SOURCE_TOTAL_CENTS }],
};

const monthlyOverview = {
  mesAtual: DUE_MONTH,
  meses: [{ ...monthRow, mes: "2026-07" }, monthRow],
  comparativo: {
    current: monthRow,
    previous: null,
    deltaDespesas: 0,
    deltaDespesasPct: null,
    deltaRecebimentos: 0,
    deltaRecebimentosPct: null,
    deltaSaldo: 0,
  },
  mesAtualEntries: [],
  entries: [],
  projetos: [{ id: personalId, name: "Pessoal QA", type: "PESSOAL" }],
  cards: [{ last4: CARD_LAST4, nickname: "Nubank QA", closingDay: 10, dueDay: 20 }],
  caixa: {
    hoje: 5_000_00,
    saldoInicial: 5_000_00,
    temSaldoInicial: true,
    porMes: [{ mes: DUE_MONTH, caixa: 5_000_00 }],
  },
  projecao: {
    caixaHoje: 5_000_00,
    entrouMes: 0,
    saiuMes: SOURCE_TOTAL_CENTS,
    faltaPagarMes: FATURA_CENTS,
    recebimentosPrevistosMes: 0,
    sobraPrevista: 0,
  },
};

type PayResponse =
  | { kind: "ok" }
  | { kind: "reject-unknown-property" }
  | { kind: "reject-mismatch" }
  | { kind: "reject-ambiguous" };

async function mockApi(
  page: Page,
  opts: {
    mode: Mode;
    cardStatus?: "a pagar" | "paga" | "parcial";
    payResponse?: PayResponse;
    undoResponse?: PayResponse;
    rateio?: "legacy" | "redacted";
    withPendencia?: boolean;
    ambiguousCard?: boolean;
    withInvoiceRow?: boolean;
  },
) {
  const requests: Array<{ method: string; path: string; body: any }> = [];
  await page.clock.setFixedTime(new Date("2026-08-12T12:00:00.000Z"));
  await page
    .context()
    .addCookies([
      { name: "rf_token", value: "w1-qa", url: "http://localhost:3013" },
    ]);

  const cardStatus = opts.cardStatus ?? "a pagar";

  await page.route("http://localhost:3001/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const rawBody = request.postData();
    requests.push({
      method: request.method(),
      path,
      body: rawBody ? JSON.parse(rawBody) : null,
    });

    if (path === "/auth/me") {
      return route.fulfill(
        json({
          id: "w1-qa-user",
          username: "w1-qa",
          name: "QA W1",
          role: "ADMIN",
          tenantId: "w1-qa-tenant",
          allowedModules: [],
          allowedProjects: [],
          allowedProjectTypes: [],
        }),
      );
    }
    if (path === "/auth/config")
      return route.fulfill(json({ registerEnabled: false, guestEnabled: false }));
    if (path === "/projects")
      return route.fulfill(json([{ id: personalId, name: "Pessoal QA", type: "PESSOAL" }]));
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
    if (path === `/projects/${personalId}/monthly-overview`)
      return route.fulfill(json(monthlyOverview));
    if (path === `/projects/${personalId}/monthly-overview/account-view`)
      return route.fulfill(
        json(
          accountView(opts.mode, cardStatus, {
            ambiguous: opts.ambiguousCard,
            withInvoiceRow: opts.withInvoiceRow,
          }),
        ),
      );
    if (path === `/projects/${personalId}/monthly-overview/dre-overview`)
      return route.fulfill(json({ anual: { saldoAcumuladoSerie: [] } }));
    if (path === `/projects/${personalId}/pendencias/financeiras`) {
      if (!opts.withPendencia) return route.fulfill(json({ total: 0, grupos: [] }));
      return route.fulfill(
        json({
          total: 1,
          grupos: [
            {
              tipo: "FATURA_NAO_PAGA",
              label: "Fatura não paga",
              count: 1,
              valorTotal: FATURA_CENTS,
              itens: [
                {
                  id: `fatura-${CARD_LAST4}-${DUE_MONTH}`,
                  tipo: "FATURA_NAO_PAGA",
                  label: "Pagar fatura",
                  descricao: `Fatura Nubank QA ••${CARD_LAST4}`,
                  valor: FATURA_CENTS,
                  data: "2026-08-20T12:00:00.000Z",
                  cardLast4: CARD_LAST4,
                  dueMonth: DUE_MONTH,
                },
              ],
            },
          ],
        }),
      );
    }
    if (path === `/projects/${personalId}/expenses/${SOURCE_ID}/rateio`)
      return route.fulfill(json(rateioPayload(opts.rateio ?? "redacted")));
    if (path.startsWith(`/projects/${personalId}/expenses/`) && request.method() === "GET")
      return route.fulfill(json(sourceExpense));

    if (
      request.method() === "POST" &&
      path === `/projects/${personalId}/monthly-overview/pay-invoice`
    ) {
      const response = opts.payResponse ?? { kind: "ok" };
      if (response.kind === "reject-unknown-property") {
        return route.fulfill(
          json({ message: ["property cardId should not exist"], error: "Bad Request" }, 400),
        );
      }
      if (response.kind === "reject-mismatch") {
        return route.fulfill(
          json({ message: "cardId e cardLast4 não correspondem ao mesmo cartão." }, 400),
        );
      }
      if (response.kind === "reject-ambiguous") {
        // B1b: mensagem TERSE do servidor — não diz quantas duplicatas há.
        return route.fulfill(json({ message: "Cartão ambíguo" }, 409));
      }
      return route.fulfill(json({ ok: true, paidCents: FATURA_CENTS }));
    }
    if (
      request.method() === "POST" &&
      path === `/projects/${personalId}/monthly-overview/undo-invoice-payment`
    ) {
      const response = opts.undoResponse ?? { kind: "ok" };
      if (response.kind === "reject-unknown-property") {
        return route.fulfill(
          json({ message: ["property cardId should not exist"], error: "Bad Request" }, 400),
        );
      }
      if (response.kind === "reject-mismatch") {
        return route.fulfill(
          json({ message: "cardId e cardLast4 não correspondem ao mesmo cartão." }, 400),
        );
      }
      if (response.kind === "reject-ambiguous") {
        return route.fulfill(json({ message: "Cartão ambíguo" }, 409));
      }
      return route.fulfill(json({ removedCount: 1, removedCents: FATURA_CENTS }));
    }
    if (
      request.method() === "POST" &&
      path === `/projects/${personalId}/expenses/${SOURCE_ID}/ratear`
    ) {
      return route.fulfill(json({ sourceExpenseId: SOURCE_ID }));
    }

    return route.fulfill(json([]));
  });

  const posts = (suffix: string) =>
    requests.filter((r) => r.method === "POST" && r.path.endsWith(suffix));
  return { requests, posts };
}

async function openConta(page: Page) {
  await page.goto(`/projects/${personalId}/conta`);
  await expect(page.getByText("Tenho na conta hoje", { exact: true })).toBeVisible();
}

/**
 * Abre "Pagar fatura" pelo caminho REAL de cada viewport: no desktop pelo
 * botão do CreditCardTile (grid `hidden md:grid`), no mobile pelo toque no
 * cartão do carrossel (status "a pagar" roteia direto pro diálogo).
 */
async function openPayDialog(page: Page) {
  const viewport = page.viewportSize();
  const isDesktop = (viewport?.width ?? 0) >= 768;
  if (isDesktop) {
    await page.getByRole("button", { name: "Pagar fatura", exact: true }).first().click();
  } else {
    await page.getByRole("button", { name: /Nubank QA · 4488/ }).first().click();
  }
  await expect(page.getByRole("heading", { name: "Pagar fatura" })).toBeVisible();
}

/** Mede a CTA em runtime: caixa não-zero, ≥44px e realmente hit-testável. */
async function assertHittableCta(page: Page, name: string | RegExp) {
  const cta = page.getByRole("button", { name }).first();
  await expect(cta).toBeVisible();
  const box = await cta.boundingBox();
  expect(box, `CTA "${name}" sem caixa de layout`).not.toBeNull();
  expect(box!.width).toBeGreaterThan(0);
  expect(box!.height).toBeGreaterThan(0);
  const hit = await page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x as number, y as number);
      return el ? el.tagName + "|" + (el.textContent ?? "").slice(0, 40) : null;
    },
    [box!.x + box!.width / 2, box!.y + box!.height / 2],
  );
  expect(hit, `nada recebe o clique no centro da CTA "${name}"`).not.toBeNull();
  return box!;
}

test.describe("W1 #448 — identidade explícita nas ações de fatura", () => {
  test("A) API nova: pay-invoice carrega cardId + accountId E os últimos4 legados", async ({
    page,
  }) => {
    const { posts } = await mockApi(page, { mode: "new-api" });
    await openConta(page);
    await openPayDialog(page);

    await assertHittableCta(page, "Confirmar pagamento");
    await page.getByRole("button", { name: "Confirmar pagamento" }).click();

    await expect(page.getByText(/Pagamento da fatura .* registrado/)).toBeVisible();
    const body = posts("/pay-invoice")[0]?.body;
    expect(body).toMatchObject({
      cardId: CARD_ID,
      cardLast4: CARD_LAST4,
      accountId: ACCOUNT_ID,
      bankLast4: BANK_LAST4,
      month: DUE_MONTH,
      amountCents: FATURA_CENTS,
    });
    expect(typeof body.paymentDate).toBe("string");
  });

  test("B) API antiga (sem ids no account-view): payload legado, sem as chaves novas, e a ação completa", async ({
    page,
  }) => {
    const { posts } = await mockApi(page, { mode: "legacy-api" });
    await openConta(page);
    await openPayDialog(page);
    await page.getByRole("button", { name: "Confirmar pagamento" }).click();

    await expect(page.getByText(/Pagamento da fatura .* registrado/)).toBeVisible();
    const body = posts("/pay-invoice")[0]?.body;
    expect(Object.keys(body)).not.toContain("cardId");
    expect(Object.keys(body)).not.toContain("accountId");
    expect(body).toMatchObject({
      cardLast4: CARD_LAST4,
      bankLast4: BANK_LAST4,
      month: DUE_MONTH,
    });
  });

  test("C1) API antiga estrita rejeita a chave nova: erro honesto, 1 POST só (sem downgrade) e CTA viva", async ({
    page,
  }) => {
    const { posts } = await mockApi(page, {
      mode: "new-api",
      payResponse: { kind: "reject-unknown-property" },
    });
    await openConta(page);
    await openPayDialog(page);
    await page.getByRole("button", { name: "Confirmar pagamento" }).click();

    await expect(
      page.getByText(/não reconhece a identificação do cartão/i),
    ).toBeVisible();
    await expect(page.getByText(/Pagamento da fatura .* registrado/)).toHaveCount(0);

    // Nunca reenviar sem os ids: um único POST, e ele carregava a identidade.
    await page.waitForTimeout(600);
    const invoicePosts = posts("/pay-invoice");
    expect(invoicePosts).toHaveLength(1);
    expect(invoicePosts[0].body.cardId).toBe(CARD_ID);

    // Diálogo aberto e CTA ainda clicável — sem CTA morta.
    await expect(page.getByRole("heading", { name: "Pagar fatura" })).toBeVisible();
    await assertHittableCta(page, "Confirmar pagamento");
  });

  test("C2) API nova recusa a identidade (divergência): mensagem honesta e nenhum reenvio sem cardId", async ({
    page,
  }) => {
    const { posts } = await mockApi(page, {
      mode: "new-api",
      payResponse: { kind: "reject-mismatch" },
    });
    await openConta(page);
    await openPayDialog(page);
    await page.getByRole("button", { name: "Confirmar pagamento" }).click();

    await expect(page.getByText(/mudaram desde que esta tela carregou/i)).toBeVisible();
    await page.waitForTimeout(600);
    const invoicePosts = posts("/pay-invoice");
    expect(invoicePosts).toHaveLength(1);
    for (const post of invoicePosts) expect(post.body.cardId).toBe(CARD_ID);
    await expect(page.getByRole("heading", { name: "Pagar fatura" })).toBeVisible();
  });

  test("D) desfazer pagamento: manda cardId na API nova e degrada pro último4 na antiga", async ({
    page,
  }) => {
    const novo = await mockApi(page, { mode: "new-api", cardStatus: "paga" });
    await openConta(page);
    const viewport = page.viewportSize();
    const isDesktop = (viewport?.width ?? 0) >= 768;
    if (isDesktop) {
      await page.getByRole("button", { name: "Desfazer pagamento", exact: true }).first().click();
    } else {
      await page.getByRole("button", { name: /Nubank QA · 4488/ }).first().click();
      await expect(page.getByRole("dialog", { name: /Ações da fatura/ })).toBeVisible();
      await page.getByRole("button", { name: "Desfazer pagamento", exact: true }).first().click();
    }
    const dialog = page.getByRole("dialog", { name: /Desfazer pagamento/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/Isso vai reabrir as compras dessa fatura/)).toBeVisible();

    const confirm = dialog.getByRole("button", { name: "Desfazer pagamento", exact: true });
    const box = await confirm.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await confirm.click();

    await expect(page.getByText(/Pagamento desfeito/)).toBeVisible();
    const body = novo.posts("/undo-invoice-payment")[0]?.body;
    expect(body).toMatchObject({
      cardId: CARD_ID,
      cardLast4: CARD_LAST4,
      dueMonth: DUE_MONTH,
    });
  });

  test("D2) desfazer na API antiga: sem chave nova no payload e a ação completa", async ({
    page,
  }) => {
    const { posts } = await mockApi(page, { mode: "legacy-api", cardStatus: "paga" });
    await openConta(page);
    const viewport = page.viewportSize();
    const isDesktop = (viewport?.width ?? 0) >= 768;
    if (isDesktop) {
      await page.getByRole("button", { name: "Desfazer pagamento", exact: true }).first().click();
    } else {
      await page.getByRole("button", { name: /Nubank QA · 4488/ }).first().click();
      await page.getByRole("button", { name: "Desfazer pagamento", exact: true }).first().click();
    }
    const dialog = page.getByRole("dialog", { name: /Desfazer pagamento/ });
    await dialog.getByRole("button", { name: "Desfazer pagamento", exact: true }).click();

    await expect(page.getByText(/Pagamento desfeito/)).toBeVisible();
    const body = posts("/undo-invoice-payment")[0]?.body;
    expect(Object.keys(body)).not.toContain("cardId");
    expect(body).toMatchObject({ cardLast4: CARD_LAST4, dueMonth: DUE_MONTH });
  });

  test("E) segunda tela que monta o diálogo (fila de pendências) também manda a identidade", async ({
    page,
  }) => {
    const { posts } = await mockApi(page, { mode: "new-api", withPendencia: true });
    await page.goto(`/projects/${personalId}/monthly`);
    const resolver = page.getByRole("button", { name: "Resolver" }).first();
    await expect(resolver).toBeVisible();
    await resolver.click();
    await page.getByRole("button", { name: "Pagar fatura", exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "Pagar fatura" })).toBeVisible();
    await assertHittableCta(page, "Confirmar pagamento");
    await page.getByRole("button", { name: "Confirmar pagamento" }).click();

    await expect(page.getByText(/Pagamento da fatura .* registrado/)).toBeVisible();
    expect(posts("/pay-invoice")[0]?.body).toMatchObject({
      cardId: CARD_ID,
      accountId: ACCOUNT_ID,
      cardLast4: CARD_LAST4,
      bankLast4: BANK_LAST4,
    });
  });
});

test.describe("W1 #448 — último4 ambíguo (B1b): capability veta a CTA, 409 é erro honesto", () => {
  test("F) cartão com `actions: []`: nenhuma CTA de pagar/desfazer é desenhada e nada é postado", async ({
    page,
  }) => {
    // O servidor já decidiu que essa fatura não tem verbo executável. Desenhar
    // "Pagar fatura" ali seria fabricar a CTA morta que este issue existe para
    // não produzir: o único desfecho possível seria 409.
    const { posts } = await mockApi(page, {
      mode: "new-api",
      ambiguousCard: true,
      withInvoiceRow: true,
      withPendencia: true,
    });
    await openConta(page);

    const isDesktop = (page.viewportSize()?.width ?? 0) >= 768;

    await expect(page.getByRole("button", { name: "Pagar fatura", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Desfazer pagamento" })).toHaveCount(0);

    // A linha de fatura continua VISÍVEL (a informação não some) — só o chip
    // deixa de prometer ação.
    await expect(page.getByText("Fatura Nubank QA").first()).toBeVisible();

    if (isDesktop) {
      // "Ajustar…" continua vivo no tile: vai para /invoice-adjustments, que
      // deliberadamente NÃO tem 409 de final ambíguo.
      await expect(page.getByRole("button", { name: /Ajustar/ }).first()).toBeVisible();
    } else {
      // No mobile os botões do tile não existem (grid é md:+). O tap do
      // carrossel é a única porta de pagamento — e ela NÃO pode abrir o
      // diálogo: cai no sheet, que explica e mantém a alternativa viva.
      await page.getByRole("button", { name: /Nubank QA · 4488/ }).first().click();
      await expect(page.getByRole("heading", { name: "Pagar fatura" })).toHaveCount(0);
      await expect(page.getByText(/Mais de um cartão com esse final/i)).toBeVisible();
      await expect(page.getByRole("button", { name: /Ajustar fatura/ })).toBeVisible();
    }

    expect(posts("/pay-invoice")).toHaveLength(0);
    expect(posts("/undo-invoice-payment")).toHaveLength(0);
  });

  test("F2) fila de pendências: item vira aviso acionável em vez de botão que 409", async ({
    page,
  }) => {
    const { posts } = await mockApi(page, {
      mode: "new-api",
      ambiguousCard: true,
      withPendencia: true,
    });
    await page.goto(`/projects/${personalId}/monthly`);
    await page.getByRole("button", { name: "Resolver" }).first().click();

    // A fila (`/pendencias`) não conhece capabilities; quem conhece é a Visão
    // Conta. Com ela dizendo "sem 'pay'", o item não oferece mais o botão.
    await expect(page.getByText(/Mais de um cartão com esse final/i)).toBeVisible();
    await expect(page.getByRole("button", { name: "Pagar fatura", exact: true })).toHaveCount(0);
    expect(posts("/pay-invoice")).toHaveLength(0);
  });

  test("G) tela velha + duplicata criada depois: 409 vira erro honesto, sem downgrade e sem CTA morta", async ({
    page,
  }) => {
    // Rede de segurança do veto: a tela carregou quando o final ainda era
    // único, então a CTA existe. O servidor recusa com 409 — e o web NÃO pode
    // reenviar sem os ids (downgrade de identidade) nem deixar o usuário no
    // escuro.
    const { posts } = await mockApi(page, {
      mode: "new-api",
      payResponse: { kind: "reject-ambiguous" },
    });
    await openConta(page);
    await openPayDialog(page);
    await page.getByRole("button", { name: "Confirmar pagamento" }).click();

    await expect(
      page.getByText(/mais de um cartão com esse final/i).first(),
    ).toBeVisible();
    // Nenhuma tentativa automática sem os ids: exatamente 1 POST, com a
    // identidade completa.
    expect(posts("/pay-invoice")).toHaveLength(1);
    expect(posts("/pay-invoice")[0]?.body).toMatchObject({
      cardId: CARD_ID,
      cardLast4: CARD_LAST4,
    });
    // O diálogo continua aberto e a CTA continua clicável (nem 404 nem beco).
    await expect(page.getByRole("heading", { name: "Pagar fatura" })).toBeVisible();
    await assertHittableCta(page, "Confirmar pagamento");
    // E a mensagem não publica contagem de duplicatas.
    const alerta = (await page.getByText(/mais de um cartão com esse final/i).first().innerText());
    expect(alerta).not.toMatch(/\b\d+\b/);
  });

  test("G2) desfazer com 409: mesma regra — erro honesto, um POST só", async ({ page }) => {
    const { posts } = await mockApi(page, {
      mode: "new-api",
      cardStatus: "paga",
      undoResponse: { kind: "reject-ambiguous" },
    });
    await openConta(page);
    const isDesktop = (page.viewportSize()?.width ?? 0) >= 768;
    if (!isDesktop) {
      await page.getByRole("button", { name: /Nubank QA/ }).first().click();
    }
    await page.getByRole("button", { name: "Desfazer pagamento" }).first().click();
    await expect(page.getByRole("heading", { name: /Desfazer pagamento/ })).toBeVisible();
    await page.getByRole("button", { name: /^Desfazer/ }).last().click();

    await expect(page.getByText(/mais de um cartão com esse final/i).first()).toBeVisible();
    expect(posts("/undo-invoice-payment")).toHaveLength(1);
    expect(posts("/undo-invoice-payment")[0]?.body).toMatchObject({
      cardId: CARD_ID,
      cardLast4: CARD_LAST4,
    });
  });
});

test.describe("W1 #448 — rateio parcial mixed-version", () => {
  test("web antigo + API nova: payload redigido não vira NaN, não inventa linha de ocultos e não vaza metadata", async ({
    page,
  }) => {
    await mockApi(page, { mode: "new-api", rateio: "redacted" });
    await openConta(page);
    await page.getByRole("button", { name: "Compras TelhaNorte", exact: true }).click();

    const detalhe = page.locator('[data-testid="rateio-detalhe"]');
    await expect(detalhe).toBeVisible();
    await expect(page.locator('[data-testid="rateio-item"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="rateio-hidden"]')).toHaveCount(0);
    await expect(detalhe).not.toHaveAttribute("data-hidden-targets-count", /.*/);

    // Viewer restrito vê sobra ≠ 0 LEGITIMAMENTE sob o contrato novo: a cópia
    // não pode acusar defeito de dado de quem não fez nada errado.
    await expect(detalhe).toHaveAttribute("data-sobra-cents", "20000");
    const alerta = detalhe.getByRole("alert");
    await expect(alerta).toContainText("Esta compra tem R$ 200,00 sem alocação em planejadas.");
    await expect(page.getByText(/não fecha o total desta compra/i)).toHaveCount(0);
    // A copy também não pode denunciar a existência do participante omitido.
    await expect(alerta).not.toContainText(/você vê|vis[íi]ve|oculta|sem acesso/i);

    const text = (await page.locator("body").innerText()).toLowerCase();
    expect(text).not.toContain("nan");
    // Metadata de identidade nunca é renderizada em nenhuma tela.
    expect(text).not.toContain(CARD_ID);
    expect(text).not.toContain(ACCOUNT_ID);
    expect(text).not.toContain(FINGERPRINT);
  });

  test("web antigo + API nova: 'Ratear compra' continua vivo com o payload redigido e ler não escreve", async ({
    page,
  }) => {
    const { posts } = await mockApi(page, { mode: "new-api", rateio: "redacted" });
    await openConta(page);

    // A CTA de rateio é a ação da LINHA (MovimentacaoRow), fora de qualquer
    // modal — é ela que a remoção da metadata poderia ter matado. No mobile
    // ela mora atrás do sheet "Mais ações"; no desktop é botão direto.
    const isDesktop = (page.viewportSize()?.width ?? 0) >= 768;
    if (!isDesktop) {
      await page.getByRole("button", { name: "Mais ações" }).first().click();
    }
    const ratear = page.getByRole("button", { name: "Ratear entre projetos" }).first();
    await expect(ratear).toBeVisible();
    const box = await ratear.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);
    await ratear.click();

    // Editor abre e continua EDITÁVEL: sem payload de ocultos, travar seria
    // matar a ação pra todo mundo (a barreira de escrita é o servidor).
    await expect(page.getByRole("heading", { name: "Ratear compra" })).toBeVisible();
    await expect(page.getByText(/planejada removida/i)).toHaveCount(0);
    await expect(page.getByText(/alocações ocultas/i)).toHaveCount(0);
    const busca = page.getByLabel("Distribuir entre planejadas de outro projeto");
    await expect(busca).toBeEnabled();

    // Ler/abrir nunca escreve.
    expect(posts("/ratear")).toHaveLength(0);
  });

  test("web novo + API pré-B1b: campos mortos são IGNORADOS, não renderizados", async ({
    page,
  }) => {
    // A outra direção do mesmo contrato. Um servidor antigo ainda manda
    // `hiddenTargetsCount`/`hiddenAllocationCents` (e um `rateadoCents`
    // total-aware). O bundle novo não pode publicar essa metadata — nem como
    // texto, nem como data-attribute — senão a decisão de parar de emiti-la
    // vira letra morta durante toda a janela de deploy não-atômico.
    await mockApi(page, { mode: "new-api", rateio: "legacy" });
    await openConta(page);
    await page.getByRole("button", { name: "Compras TelhaNorte", exact: true }).click();

    const detalhe = page.locator('[data-testid="rateio-detalhe"]');
    await expect(detalhe).toBeVisible();
    await expect(page.locator('[data-testid="rateio-item"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="rateio-hidden"]')).toHaveCount(0);
    await expect(detalhe).not.toHaveAttribute("data-hidden-targets-count", /.*/);
    await expect(detalhe).not.toHaveAttribute("data-hidden-allocation-cents", /.*/);

    // Com `rateadoCents` total-aware do servidor antigo a sobra dá 0 — então
    // nem alarme aparece. O que importa: nada de "2 alocações em projetos sem
    // acesso" e nada de R$ NaN.
    const text = (await page.locator("body").innerText()).toLowerCase();
    expect(text).not.toContain("nan");
    expect(text).not.toContain("sem acesso");
    expect(text).not.toContain("ocultas");
  });
});
