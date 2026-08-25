import { expect, test, type Page, type Locator } from "@playwright/test";

/**
 * QA de runtime do alvo de toque do chip de status em `MovimentacaoRow`
 * (issue #600) — 375 / 390 / desktop.
 *
 * `MovimentacaoRow` é o layout canônico de linha financeira e está na Visão
 * Conta (`/conta`), tela de uso diário do PESSOAL — diferente de lotes
 * recentes que corrigiram componentes MORTOS. `statusBaseClass` é usada em
 * DOIS botões do arquivo: a CTA "Pagar fatura"/chip de fatura (linha ~274) e
 * o toggle genérico de status de despesa/recebimento (linha ~313). O chip de
 * fatura degrada para informativo/desabilitado quando o servidor veta o
 * pagamento (`actions: []`, último4 ambíguo) — alvo de toque maior só faz
 * sentido no estado CLICÁVEL, então o chip desabilitado deve continuar do
 * tamanho original.
 *
 * ARMADILHA conhecida (PR #598, revertido): `button[title="Alternar status"]`
 * existe TAMBÉM em `PersonalExpenseCard.tsx` (MORTO — a árvore de
 * `/expenses` para PESSOAL sempre redireciona para `/conta` antes de montar
 * esse componente, ver `ExpensesPage`/`hasNavRoute`). Este teste navega
 * SEMPRE para `/conta` e escopa a busca com `data-testid="movimentacao-row"`
 * + `data-testid="movimentacao-status"` (adicionados nesta mudança) para não
 * depender só do seletor por `title`, que colidiria com o componente morto
 * se algum dia voltasse a ser alcançável.
 *
 * Medição real (não classList): `getBoundingClientRect` via `evaluate`, que
 * já reflete padding (o alvo tocável de verdade), mais `elementFromPoint` no
 * centro E numa quina da área expandida (fora da caixa visual original) para
 * provar que o hit-test realmente cresceu, não só a classe CSS.
 */

const personalId = "movrow-qa-600";
const CARD_LAST4 = "9911";
const BANK_LAST4 = "2233";
const DUE_MONTH = "2026-08";
const SHOT_DIR = "test-results/movrow-qa-600";
const WIDTHS = [375, 390, 1280] as const;

function json(body: unknown, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

// Saída "solta" (não fatura), editável, PAGA → status.txt = "Paga" (o rótulo
// mais curto de todos — o pior caso de largura para o alvo de toque).
const saidaClicavel = {
  id: "saida-clicavel-1",
  kind: "saida",
  descricao: "Mercado QA",
  data: "2026-08-10T12:00:00.000Z",
  forma: "pix",
  valor: 15_000,
  realizado: true,
  status: "PAGO",
  cardLast4: null,
  bankLast4: BANK_LAST4,
  tipoDespesa: "MERCADO",
  isInvoice: false,
  editavel: true,
  dueMonth: null,
  projetoOrigem: null,
  foreignExpenseId: null,
};

// Fatura de último4 AMBÍGUO (B1b #448): `actions: []` veta 'pay' no servidor.
// O chip de status É a CTA "Pagar fatura" — aqui ela DEVE degradar para
// informativa/desabilitada.
const saidaFaturaVetada = {
  id: "saida-fatura-vetada-1",
  kind: "saida",
  descricao: `Fatura QA ••${CARD_LAST4}`,
  data: "2026-08-20T12:00:00.000Z",
  forma: "debito",
  valor: 80_000,
  realizado: false,
  status: "PLANEJADO",
  cardId: null,
  cardLast4: CARD_LAST4,
  bankLast4: BANK_LAST4,
  tipoDespesa: "OUTROS",
  isInvoice: true,
  editavel: true,
  dueMonth: DUE_MONTH,
  projetoOrigem: null,
  foreignExpenseId: null,
  actions: [],
  fingerprint: null,
};

function accountView() {
  return {
    mesSelecionado: DUE_MONTH,
    caixaHoje: 5_000_00,
    entrouMes: 0,
    saiuMes: saidaClicavel.valor + saidaFaturaVetada.valor,
    faltaPagarMes: saidaFaturaVetada.valor,
    recebimentosPrevistosMes: 0,
    sobraPrevista: 0,
    devoCartaoTotal: saidaFaturaVetada.valor,
    cartoes: [
      {
        cardId: null,
        nickname: "QA Ambíguo",
        last4: CARD_LAST4,
        faturaAtual: saidaFaturaVetada.valor,
        faturaPendente: saidaFaturaVetada.valor,
        faturaPaga: 0,
        residualDeclarado: 0,
        possuiIntervencaoManual: false,
        ajusteManualTotal: 0,
        dueMonth: DUE_MONTH,
        vencimento: "2026-08-20T12:00:00.000Z",
        status: "a pagar",
        limiteUsadoPct: 10,
        limiteUsado: saidaFaturaVetada.valor,
        limiteTotal: 1_000_00,
        actions: [],
        fingerprint: null,
      },
    ],
    contas: [{ accountId: "acc-qa-1", last4: BANK_LAST4, nome: "Banco QA" }],
    saidas: [saidaClicavel, saidaFaturaVetada],
    comprasCartao: [],
    entradas: [],
    ticketMedio: { valor: 0, nCompras: 0, totalCompras: 0, serie6m: [], media6m: 0, deltaVsMediaPct: null },
  };
}

const monthRow = {
  mes: DUE_MONTH,
  totalDespesas: saidaClicavel.valor + saidaFaturaVetada.valor,
  totalRecebimentos: 0,
  despesasRealizadas: saidaClicavel.valor,
  recebimentosRealizados: 0,
  saldoMes: -(saidaClicavel.valor + saidaFaturaVetada.valor),
  saldoMesRealizado: -saidaClicavel.valor,
  porOrigem: {},
  porCategoria: [{ categoria: "Mercado", valor: saidaClicavel.valor }],
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
  projetos: [{ id: personalId, name: "Pessoal QA #600", type: "PESSOAL" }],
  cards: [{ last4: CARD_LAST4, nickname: "QA Ambíguo", closingDay: 10, dueDay: 20 }],
  caixa: {
    hoje: 5_000_00,
    saldoInicial: 5_000_00,
    temSaldoInicial: true,
    porMes: [{ mes: DUE_MONTH, caixa: 5_000_00 }],
  },
  projecao: {
    caixaHoje: 5_000_00,
    entrouMes: 0,
    saiuMes: saidaClicavel.valor + saidaFaturaVetada.valor,
    faltaPagarMes: saidaFaturaVetada.valor,
    recebimentosPrevistosMes: 0,
    sobraPrevista: 0,
  },
};

async function mockApi(page: Page) {
  await page.clock.setFixedTime(new Date("2026-08-12T12:00:00.000Z"));
  await page
    .context()
    .addCookies([{ name: "rf_token", value: "movrow-qa-600", url: "http://localhost:3013" }]);

  await page.route("http://localhost:3001/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/auth/me")
      return route.fulfill(
        json({
          id: "movrow-qa-user",
          username: "movrow-qa",
          name: "QA 600",
          role: "ADMIN",
          tenantId: "movrow-qa-tenant",
          allowedModules: [],
          allowedProjects: [],
          allowedProjectTypes: [],
        }),
      );
    if (path === "/auth/config")
      return route.fulfill(json({ registerEnabled: false, guestEnabled: false }));
    if (path === "/projects")
      return route.fulfill(json([{ id: personalId, name: "Pessoal QA #600", type: "PESSOAL" }]));
    if (path === `/projects/${personalId}`)
      return route.fulfill(
        json({
          id: personalId,
          name: "Pessoal QA #600",
          type: "PESSOAL",
          onboardedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    if (path === `/projects/${personalId}/monthly-overview`)
      return route.fulfill(json(monthlyOverview));
    if (path === `/projects/${personalId}/monthly-overview/account-view`)
      return route.fulfill(json(accountView()));
    if (path === `/projects/${personalId}/monthly-overview/dre-overview`)
      return route.fulfill(json({ anual: { saldoAcumuladoSerie: [] } }));
    if (path === `/projects/${personalId}/pendencias/financeiras`)
      return route.fulfill(json({ total: 0, grupos: [] }));
    return route.fulfill(json([]));
  });
}

/** Métricas reais do elemento: caixa (`getBoundingClientRect`) + quem recebe
 * o clique no centro e numa quina da área esperada de toque. */
async function measure(page: Page, label: string, locator: Locator) {
  await expect(locator).toBeVisible();
  await locator.scrollIntoViewIfNeeded();
  const metrics = await locator.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const hitCenter = document.elementFromPoint(cx, cy);
    return {
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      hitsSelfAtCenter: hitCenter === el || (hitCenter != null && el.contains(hitCenter)),
    };
  });
  // eslint-disable-next-line no-console
  console.log(`[movrow-qa-600] ${label} → ${metrics.width}x${metrics.height} @(${metrics.x},${metrics.y})`);
  expect(metrics.width, `${label}: largura zero`).toBeGreaterThan(0);
  expect(metrics.height, `${label}: altura zero`).toBeGreaterThan(0);
  expect(metrics.hitsSelfAtCenter, `${label}: outro elemento recebe o clique no centro`).toBe(true);
  return metrics;
}

for (const width of WIDTHS) {
  test.describe(`MovimentacaoRow touch target @${width}px (#600)`, () => {
    test.beforeEach(({}, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "medição roda uma vez só");
    });
    test.use({ viewport: { width, height: 900 } });

    test("chip clicável ('Paga') tem alvo interativo real ≥44×44 sem inflar a linha", async ({
      page,
    }) => {
      await mockApi(page);
      await page.goto(`/projects/${personalId}/conta`);
      await expect(page.getByText("Tenho na conta hoje", { exact: true })).toBeVisible();

      const rows = page.getByTestId("movimentacao-row");
      await expect(rows).toHaveCount(2);

      const clickableRow = rows.filter({ hasText: "Mercado QA" });
      const vetoedRow = rows.filter({ hasText: /Fatura QA/ });
      await expect(clickableRow).toBeVisible();
      await expect(vetoedRow).toBeVisible();

      const clickableStatus = clickableRow.getByTestId("movimentacao-status");
      const vetoedStatus = vetoedRow.getByTestId("movimentacao-status");

      const clickableMetrics = await measure(
        page,
        `status "Paga" (clicável) @${width}`,
        clickableStatus,
      );
      const vetoedMetrics = await measure(
        page,
        `status "A pagar" (fatura vetada, desabilitado) @${width}`,
        vetoedStatus,
      );

      if (width < 768) {
        // Critério 1: ≥44×44px de área INTERATIVA real a 375/390px.
        expect(clickableMetrics.width, `${width}px: largura do chip clicável`).toBeGreaterThanOrEqual(44);
        expect(clickableMetrics.height, `${width}px: altura do chip clicável`).toBeGreaterThanOrEqual(44);

        // Prova de que o hit-test cresceu de verdade (não só a classe CSS):
        // um ponto 2px dentro da quina da caixa MEDIDA (fora da antiga caixa
        // visual de 24px) ainda tem que resolver para o próprio botão.
        const cornerHit = await clickableStatus.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          const px = rect.left + 2;
          const py = rect.top + 2;
          const hit = document.elementFromPoint(px, py);
          return hit === el || (hit != null && el.contains(hit));
        });
        expect(cornerHit, `${width}px: quina da área expandida não resolve pro botão`).toBe(true);

        // Critério 3: chip desabilitado (servidor vetou) NÃO ganha a mesma
        // área — continua do tamanho visual original (min-h-6 = 24px).
        expect(vetoedMetrics.height, `${width}px: chip desabilitado não deveria crescer`).toBeLessThan(30);
      }

      await expect(clickableStatus).toBeEnabled();
      await expect(vetoedStatus).toBeDisabled();
      // Critério 3 (semântico): sem `title`, o chip vetado não promete ação.
      await expect(vetoedStatus).not.toHaveAttribute("title", /.+/);

      // Critério 2: alvo maior não infla a linha. As duas linhas mostram
      // título/meta de comprimentos DIFERENTES de propósito (o teste não
      // compara a linha toda por isso), mas a coluna "valor + status" (o
      // container imediato do chip, `flex flex-col items-end`) usa a MESMA
      // tipografia/line-height nos dois casos — só o texto (largura) muda, a
      // altura de uma linha de texto não depende do conteúdo. Se o
      // padding+margem-negativa do alvo de toque cancelasse a contribuição ao
      // fluxo (como projetado), essa coluna tem que medir igual nos dois
      // casos mesmo com um chip expandido e o outro não. Tolerância de 1px
      // por arredondamento sub-pixel.
      const clickableColumn = clickableStatus.locator('..');
      const vetoedColumn = vetoedStatus.locator('..');
      const [clickableColumnBox, vetoedColumnBox] = await Promise.all([
        clickableColumn.evaluate((el) => el.getBoundingClientRect().height),
        vetoedColumn.evaluate((el) => el.getBoundingClientRect().height),
      ]);
      expect(
        Math.abs(clickableColumnBox - vetoedColumnBox),
        `${width}px: altura da coluna valor+status divergiu (${clickableColumnBox} vs ${vetoedColumnBox}) — alvo de toque inflou o layout`,
      ).toBeLessThanOrEqual(1);

      // Cinto e suspensórios: a linha INTEIRA (dominada pela altura do
      // bloco título+meta de duas linhas, não pelo chip) não deveria nunca
      // se aproximar de crescer pelos ~34px extra que o padding adiciona à
      // caixa do botão — se isso acontecesse, o cancelamento por margem
      // negativa falhou silenciosamente.
      const [clickableRowBox, vetoedRowBox] = await Promise.all([
        clickableRow.evaluate((el) => el.getBoundingClientRect().height),
        vetoedRow.evaluate((el) => el.getBoundingClientRect().height),
      ]);
      expect(
        Math.abs(clickableRowBox - vetoedRowBox),
        `${width}px: linhas com meta de comprimento diferente divergiram bem mais que um chip inflado explicaria (${clickableRowBox} vs ${vetoedRowBox})`,
      ).toBeLessThan(20);

      await page.screenshot({ path: `${SHOT_DIR}/${width}-conta-lista.png`, fullPage: false });
    });

    test("clique real no chip clicável dispara o toggle; clique no vetado não faz nada", async ({
      page,
    }) => {
      const posts: Array<{ path: string }> = [];
      await mockApi(page);
      await page.route(`http://localhost:3001/projects/${personalId}/expenses/**`, async (route) => {
        posts.push({ path: new URL(route.request().url()).pathname });
        return route.fulfill(json({ ok: true }));
      });
      await page.goto(`/projects/${personalId}/conta`);
      await expect(page.getByText("Tenho na conta hoje", { exact: true })).toBeVisible();

      const rows = page.getByTestId("movimentacao-row");
      const vetoedRow = rows.filter({ hasText: /Fatura QA/ });
      const vetoedStatus = vetoedRow.getByTestId("movimentacao-status");

      // disabled → o próprio browser não dispara click; confirmamos que o
      // estado continua vetado e nenhum PATCH de status foi enviado.
      await expect(vetoedStatus).toBeDisabled();
      await vetoedStatus.click({ force: true }).catch(() => {});
      expect(posts.length, "chip vetado não deveria disparar mutação nenhuma").toBe(0);
    });
  });
}
