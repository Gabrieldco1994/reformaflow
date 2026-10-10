import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Contrato de UI (componente real + API stubada — NÃO é QA de backend) do botão
 * "Mais ações" de `MovimentacaoRow` no mobile (fluxo Conta → fatura → Mais
 * ações → Editar). O QA de jornada mediu 36×36 a 375/390px; o piso do projeto
 * é 44×44. Mede a caixa real (`getBoundingClientRect`) + hit-test
 * (`elementFromPoint`) a 375 / 390 / 1280, com valor negativo de 6 dígitos
 * (R$ 123.456,78) na linha da fatura e o painel de compras da fatura ABERTO.
 * A 1280 o botão é `md:hidden` (desktop usa ícones inline): só o layout
 * (sem overflow, valor nowrap) é medido.
 */

const personalId = "movrow-more-actions";
const CARD_LAST4 = "9911";
const DUE_MONTH = "2026-08";
const SHOT_DIR = "test-results/movrow-more-actions";
const WIDTHS = [375, 390, 1280] as const;
// R$ 123.456,78 — 6 dígitos antes da vírgula (pior caso de largura do valor).
const SIX_DIGIT_CENTS = 12_345_678;

function json(body: unknown, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

const fatura = {
  id: "fatura-6d",
  kind: "saida",
  descricao: `Fatura QA ••${CARD_LAST4}`,
  data: "2026-08-20T12:00:00.000Z",
  forma: "debito",
  valor: SIX_DIGIT_CENTS,
  realizado: false,
  status: "PLANEJADO",
  cardId: "card-qa-1",
  cardLast4: CARD_LAST4,
  bankLast4: null,
  tipoDespesa: "OUTROS",
  isInvoice: true,
  editavel: true,
  dueMonth: DUE_MONTH,
  projetoOrigem: null,
  foreignExpenseId: null,
  actions: ["pay"],
  fingerprint: null,
};

const compra = {
  id: "compra-6d",
  kind: "saida",
  descricao: "Compra QA no cartão",
  data: "2026-08-05T12:00:00.000Z",
  forma: "credito",
  valor: SIX_DIGIT_CENTS,
  realizado: false,
  status: "PLANEJADO",
  cardLast4: CARD_LAST4,
  bankLast4: null,
  tipoDespesa: "OUTROS",
  isInvoice: false,
  editavel: true,
  expenseIsCredit: false, // ordinary positive purchase: server root signal (not a permission)
  dueMonth: DUE_MONTH,
  projetoOrigem: null,
  foreignExpenseId: null,
};

function accountView() {
  return {
    mesSelecionado: DUE_MONTH,
    caixaHoje: 5_000_00,
    entrouMes: 0,
    saiuMes: fatura.valor,
    faltaPagarMes: fatura.valor,
    recebimentosPrevistosMes: 0,
    sobraPrevista: 0,
    devoCartaoTotal: fatura.valor,
    cartoes: [
      {
        cardId: "card-qa-1",
        nickname: "QA Cartão",
        last4: CARD_LAST4,
        faturaAtual: fatura.valor,
        faturaPendente: fatura.valor,
        faturaPaga: 0,
        residualDeclarado: 0,
        possuiIntervencaoManual: false,
        ajusteManualTotal: 0,
        dueMonth: DUE_MONTH,
        vencimento: "2026-08-20T12:00:00.000Z",
        status: "a pagar",
        limiteUsadoPct: 10,
        limiteUsado: fatura.valor,
        limiteTotal: 1_000_00,
        actions: ["pay"],
        fingerprint: null,
      },
    ],
    contas: [],
    saidas: [fatura],
    comprasCartao: [compra],
    entradas: [],
    ticketMedio: { valor: 0, nCompras: 0, totalCompras: 0, serie6m: [], media6m: 0, deltaVsMediaPct: null },
  };
}

const monthRow = {
  mes: DUE_MONTH,
  totalDespesas: fatura.valor,
  totalRecebimentos: 0,
  despesasRealizadas: 0,
  recebimentosRealizados: 0,
  saldoMes: -fatura.valor,
  saldoMesRealizado: 0,
  porOrigem: {},
  porCategoria: [{ categoria: "Outros", valor: fatura.valor }],
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
  cards: [{ last4: CARD_LAST4, nickname: "QA Cartão", closingDay: 10, dueDay: 20 }],
  caixa: { hoje: 5_000_00, saldoInicial: 5_000_00, temSaldoInicial: true, porMes: [{ mes: DUE_MONTH, caixa: 5_000_00 }] },
  projecao: {
    caixaHoje: 5_000_00,
    entrouMes: 0,
    saiuMes: fatura.valor,
    faltaPagarMes: fatura.valor,
    recebimentosPrevistosMes: 0,
    sobraPrevista: 0,
  },
};

async function mockApi(page: Page) {
  await page.clock.setFixedTime(new Date("2026-08-12T12:00:00.000Z"));
  await page
    .context()
    .addCookies([{ name: "rf_token", value: "movrow-more-actions", url: `http://localhost:${process.env.PLAYWRIGHT_PORT ?? 3013}` }]);
  await page.route("http://localhost:3001/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/auth/me")
      return route.fulfill(
        json({
          id: "movrow-more-actions-user",
          username: "movrow-more",
          name: "QA Mais ações",
          role: "ADMIN",
          tenantId: "movrow-more-actions-tenant",
          allowedModules: [],
          allowedProjects: [],
          allowedProjectTypes: [],
        }),
      );
    if (path === "/auth/config") return route.fulfill(json({ registerEnabled: false, guestEnabled: false }));
    if (path === "/projects") return route.fulfill(json([{ id: personalId, name: "Pessoal QA", type: "PESSOAL" }]));
    if (path === `/projects/${personalId}`)
      return route.fulfill(
        json({ id: personalId, name: "Pessoal QA", type: "PESSOAL", onboardedAt: "2026-01-01T00:00:00.000Z" }),
      );
    if (path === `/projects/${personalId}/monthly-overview`) return route.fulfill(json(monthlyOverview));
    if (path === `/projects/${personalId}/monthly-overview/account-view`) return route.fulfill(json(accountView()));
    if (path === `/projects/${personalId}/monthly-overview/dre-overview`)
      return route.fulfill(json({ anual: { saldoAcumuladoSerie: [] } }));
    if (path === `/projects/${personalId}/pendencias/financeiras`) return route.fulfill(json({ total: 0, grupos: [] }));
    return route.fulfill(json([]));
  });
}

async function boxOf(locator: Locator) {
  return locator.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = (x: number, y: number) => {
      const h = document.elementFromPoint(x, y);
      return h === el || (h != null && el.contains(h));
    };
    return {
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      right: r.right,
      hitCenter: hit(r.left + r.width / 2, r.top + r.height / 2),
      hitCorner: hit(r.left + 2, r.top + 2),
    };
  });
}

for (const width of WIDTHS) {
  test.describe(`MovimentacaoRow "Mais ações" @${width}px`, () => {
    test.beforeEach(({}, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "medição roda uma vez só");
    });
    test.use({ viewport: { width, height: 900 } });

    test("alvo ≥44×44 com valor −6 dígitos e painel da fatura aberto, sem overflow", async ({ page }, testInfo) => {
      await mockApi(page);
      await page.goto(`/projects/${personalId}/conta`);
      await expect(page.getByText("Tenho na conta hoje", { exact: true })).toBeVisible();

      const invoiceRow = page.getByTestId("movimentacao-row").filter({ hasText: /Fatura QA/ });
      await invoiceRow.getByTitle("Ver compras da fatura").click();
      await expect(page.getByText("Compra QA no cartão")).toBeVisible();
      const nestedRow = page.getByTestId("movimentacao-row").filter({ hasText: "Compra QA no cartão" });

      const metrics: Record<string, unknown> = { width };
      for (const [label, row] of [
        ["fatura", invoiceRow],
        ["compra", nestedRow],
      ] as const) {
        const money = row.locator("span.whitespace-nowrap").first();
        await expect(money).toContainText("123.456,78");
        const moneyStyle = await money.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return {
            whiteSpace: getComputedStyle(el).whiteSpace,
            height: r.height,
            right: r.right,
            lineHeight: parseFloat(getComputedStyle(el).lineHeight) || 0,
          };
        });
        expect(moneyStyle.whiteSpace, `${label}: valor deve ser nowrap`).toBe("nowrap");
        expect(moneyStyle.height, `${label}: valor quebrou em duas linhas`).toBeLessThan(moneyStyle.lineHeight * 1.6 + 1);

        const rowBox = await row.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { height: r.height, right: r.right, left: r.left };
        });
        const title = row.locator("span.truncate").first();
        const titleWidth = await title.evaluate((el) => el.getBoundingClientRect().width);
        metrics[label] = { moneyRight: moneyStyle.right, rowHeight: rowBox.height, titleWidth };

        const more = row.getByRole("button", { name: "Mais ações" });
        if (width < 768) {
          await more.scrollIntoViewIfNeeded();
          const box = await boxOf(more);
          metrics[`${label}MaisAcoes`] = { width: box.width, height: box.height, x: box.x, y: box.y };
          // eslint-disable-next-line no-console
          console.log(`[movrow-more-actions] partial ${JSON.stringify(metrics)}`);
          expect(box.width, `${label}@${width}: largura de Mais ações`).toBeGreaterThanOrEqual(44);
          expect(box.height, `${label}@${width}: altura de Mais ações`).toBeGreaterThanOrEqual(44);
          expect(box.hitCenter, `${label}@${width}: centro de Mais ações coberto por outro elemento`).toBe(true);
          expect(box.hitCorner, `${label}@${width}: quina de Mais ações coberta por outro elemento`).toBe(true);
          // O alvo não sai da linha nem cobre o valor monetário.
          expect(box.right, `${label}@${width}: Mais ações vaza da linha`).toBeLessThanOrEqual(rowBox.right + 0.5);
          expect(box.x, `${label}@${width}: Mais ações sobrepõe o valor`).toBeGreaterThanOrEqual(moneyStyle.right - 0.5);
          // O chip de status (CTA da fatura) continua clicável no centro.
          const status = row.getByTestId("movimentacao-status");
          if (await status.count()) {
            const statusBox = await boxOf(status);
            expect(statusBox.hitCenter, `${label}@${width}: chip de status perdeu o hit-test`).toBe(true);
          }
        } else {
          await expect(more, "desktop usa ícones inline (Mais ações é md:hidden)").toBeHidden();
        }
      }

      const overflow = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      metrics.overflow = overflow;
      expect(overflow.scrollWidth, `${width}px: overflow horizontal na página`).toBeLessThanOrEqual(overflow.innerWidth);

      if (width < 768) {
        await invoiceRow.getByRole("button", { name: "Mais ações" }).click();
        const edit = page.getByRole("button", { name: "Editar", exact: true });
        await expect(edit).toBeVisible();
        // O sheet anima a entrada: espera o hit-test estabilizar em vez de medir no meio do slide.
        await expect.poll(async () => (await boxOf(edit)).hitCenter, { timeout: 5_000 }).toBe(true);
        const editBox = await boxOf(edit);
        metrics.sheetEditar = { width: editBox.width, height: editBox.height };
        expect(editBox.height).toBeGreaterThanOrEqual(44);
      }

      await page.screenshot({ path: `${SHOT_DIR}/${width}-mais-acoes.png` });
      testInfo.annotations.push({ type: "metrics", description: JSON.stringify(metrics) });
      // eslint-disable-next-line no-console
      console.log(`[movrow-more-actions] ${JSON.stringify(metrics)}`);
    });
  });
}
