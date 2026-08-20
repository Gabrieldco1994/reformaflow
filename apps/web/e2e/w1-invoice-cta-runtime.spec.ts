import { expect, test, type Page, type Locator } from "@playwright/test";

/**
 * QA de runtime das CTAs de fatura tocadas por W1 (#448) — 375 / 390 / desktop.
 *
 * Por que este arquivo existe: classes perfeitas não provam que o botão
 * funciona. Este caminho (pagar fatura) já quebrou em produção atrás de um
 * pipeline verde. Aqui cada CTA é MEDIDA em runtime — `getBoundingClientRect`
 * (caixa não-zero) + `document.elementFromPoint` no centro (quem realmente
 * recebe o clique) — nas DUAS telas que montam `PagarFaturaDialog` (/conta e a
 * fila "Precisa de você" do cockpit) e nos TRÊS pontos de entrada de
 * `UndoInvoicePaymentDialog` (CreditCardTile, MobileCardActionsSheet e a linha
 * de fatura em MovimentacoesSection).
 *
 * Screenshots vão para `test-results/w1-qa/`.
 */

const personalId = "w1-qa-runtime";
const CARD_ID = "ckcard000000000000000001";
const ACCOUNT_ID = "ckacct000000000000000001";
const CARD_LAST4 = "4488";
const BANK_LAST4 = "1881";
const DUE_MONTH = "2026-08";
const FATURA_CENTS = 250_00;
const SHOT_DIR = "test-results/w1-qa";
const WIDTHS = [375, 390, 1280] as const;

function json(body: unknown, status = 200) {
  return { status, contentType: "application/json", body: JSON.stringify(body) };
}

function saidaFatura(realizado: boolean) {
  return {
    id: "saida-fatura-1",
    kind: "saida",
    descricao: `Fatura Nubank QA ••${CARD_LAST4}`,
    data: "2026-08-20T12:00:00.000Z",
    forma: "debito",
    valor: FATURA_CENTS,
    realizado,
    status: realizado ? "PAGO" : "PLANEJADO",
    cardId: CARD_ID,
    cardLast4: CARD_LAST4,
    bankLast4: BANK_LAST4,
    tipoDespesa: "OUTROS",
    isInvoice: true,
    editavel: true,
    dueMonth: DUE_MONTH,
    projetoOrigem: null,
    foreignExpenseId: null,
  };
}

function accountView(status: "a pagar" | "paga") {
  return {
    mesSelecionado: DUE_MONTH,
    caixaHoje: 5_000_00,
    entrouMes: 0,
    saiuMes: FATURA_CENTS,
    faltaPagarMes: status === "paga" ? 0 : FATURA_CENTS,
    recebimentosPrevistosMes: 0,
    sobraPrevista: 0,
    devoCartaoTotal: FATURA_CENTS,
    cartoes: [
      {
        cardId: CARD_ID,
        nickname: "Nubank QA",
        last4: CARD_LAST4,
        faturaAtual: FATURA_CENTS,
        faturaPendente: status === "paga" ? 0 : FATURA_CENTS,
        faturaPaga: status === "paga" ? FATURA_CENTS : 0,
        residualDeclarado: 0,
        possuiIntervencaoManual: false,
        ajusteManualTotal: 0,
        dueMonth: DUE_MONTH,
        vencimento: "2026-08-20T12:00:00.000Z",
        status,
        limiteUsadoPct: 25,
        limiteUsado: FATURA_CENTS,
        limiteTotal: 1_000_00,
        actions: status === "paga" ? ["undo"] : ["pay", "undo"],
        fingerprint: "fp-w1-qa",
      },
    ],
    contas: [{ accountId: ACCOUNT_ID, last4: BANK_LAST4, nome: "Itaú QA" }],
    saidas: [saidaFatura(status === "paga")],
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

const monthRow = {
  mes: DUE_MONTH,
  totalDespesas: FATURA_CENTS,
  totalRecebimentos: 0,
  despesasRealizadas: 0,
  recebimentosRealizados: 0,
  saldoMes: -FATURA_CENTS,
  saldoMesRealizado: 0,
  porOrigem: {},
  porCategoria: [{ categoria: "Outros", valor: FATURA_CENTS }],
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
    saiuMes: FATURA_CENTS,
    faltaPagarMes: FATURA_CENTS,
    recebimentosPrevistosMes: 0,
    sobraPrevista: 0,
  },
};

const pendencias = {
  total: 1,
  grupos: [
    {
      tipo: "FATURA_NAO_PAGA",
      label: "Fatura não paga",
      count: 1,
      valorTotal: FATURA_CENTS,
      itens: [
        {
          id: `fatura-${CARD_LAST4}`,
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
};

async function mockApi(
  page: Page,
  status: "a pagar" | "paga",
  payRejects = false,
) {
  const posts: Array<{ path: string; body: any }> = [];
  await page.clock.setFixedTime(new Date("2026-08-12T12:00:00.000Z"));
  await page
    .context()
    .addCookies([{ name: "rf_token", value: "w1-qa", url: "http://localhost:3013" }]);

  await page.route("http://localhost:3001/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST") {
      const raw = request.postData();
      posts.push({ path, body: raw ? JSON.parse(raw) : null });
    }
    if (path === "/auth/me")
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
    if (path === "/auth/config")
      return route.fulfill(json({ registerEnabled: false, guestEnabled: false }));
    if (path === "/projects")
      return route.fulfill(json([{ id: personalId, name: "Pessoal QA", type: "PESSOAL" }]));
    if (path === `/projects/${personalId}`)
      return route.fulfill(
        json({
          id: personalId,
          name: "Pessoal QA",
          type: "PESSOAL",
          onboardedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    if (path === `/projects/${personalId}/monthly-overview`)
      return route.fulfill(json(monthlyOverview));
    if (path === `/projects/${personalId}/monthly-overview/account-view`)
      return route.fulfill(json(accountView(status)));
    if (path === `/projects/${personalId}/monthly-overview/dre-overview`)
      return route.fulfill(json({ anual: { saldoAcumuladoSerie: [] } }));
    if (path === `/projects/${personalId}/pendencias/financeiras`)
      return route.fulfill(json(pendencias));
    if (path.endsWith("/pay-invoice")) {
      return payRejects
        ? route.fulfill(
            json({ message: "cardId e cardLast4 não correspondem ao mesmo cartão." }, 400),
          )
        : route.fulfill(json({ ok: true }));
    }
    if (path.endsWith("/undo-invoice-payment"))
      return route.fulfill(json({ removedCount: 1, revertedParcelas: 1 }));
    return route.fulfill(json([]));
  });
  return posts;
}

/**
 * Mede a CTA de verdade: caixa do layout + quem recebe o clique no centro.
 * Falha se a caixa for zero (o modo de falha que passa por toda review
 * estática) ou se outro elemento estiver por cima do ponto de clique.
 */
async function measure(page: Page, label: string, locator: Locator) {
  await expect(locator).toBeVisible();
  // Um clique real rola até o alvo; sem isso `elementFromPoint` devolve null
  // só porque o centro do botão está abaixo da dobra (falso negativo). Sheets
  // entram animando, então esperamos o centro assentar dentro do viewport.
  await locator.scrollIntoViewIfNeeded();
  await expect
    .poll(
      () =>
        locator.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          const cy = rect.top + rect.height / 2;
          return cy >= 0 && cy <= window.innerHeight;
        }),
      { message: `${label}: centro nunca entrou no viewport`, timeout: 3_000 },
    )
    .toBe(true);
  const metrics = await locator.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    return {
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      hitsSelf: hit === el || (hit != null && el.contains(hit)),
      hitTag: hit ? hit.tagName.toLowerCase() : null,
    };
  });
  // eslint-disable-next-line no-console
  console.log(
    `[w1-qa] ${label} → ${metrics.width}x${metrics.height} @(${metrics.x},${metrics.y}) hit=${metrics.hitTag} self=${metrics.hitsSelf}`,
  );
  expect(metrics.width, `${label}: largura zero`).toBeGreaterThan(0);
  expect(metrics.height, `${label}: altura zero`).toBeGreaterThan(0);
  expect(metrics.hitsSelf, `${label}: outro elemento recebe o clique`).toBe(true);
  return metrics;
}

for (const width of WIDTHS) {
  test.describe(`W1 runtime QA @${width}px`, () => {
    // Um único projeto executa as três larguras (o viewport é setado à mão);
    // rodar nos dois duplicaria a mesma medição.
    test.beforeEach(({}, testInfo) => {
      test.skip(testInfo.project.name !== "desktop", "medição roda uma vez só");
    });
    test.use({ viewport: { width, height: 900 } });

    test("/conta · pagar fatura: CTA de entrada, diálogo e confirmação medidos", async ({
      page,
    }) => {
      const posts = await mockApi(page, "a pagar");
      await page.goto(`/projects/${personalId}/conta`);
      await expect(page.getByText("Tenho na conta hoje", { exact: true })).toBeVisible();

      const isDesktop = width >= 768;
      if (isDesktop) {
        await measure(
          page,
          `conta/tile "Pagar fatura" @${width}`,
          page.getByRole("button", { name: "Pagar fatura", exact: true }).first(),
        );
        await page.getByRole("button", { name: "Pagar fatura", exact: true }).first().click();
      } else {
        await measure(
          page,
          `conta/carrossel cartão @${width}`,
          page.getByRole("button", { name: /Nubank QA · 4488/ }).first(),
        );
        await page.getByRole("button", { name: /Nubank QA · 4488/ }).first().click();
      }

      await expect(page.getByRole("heading", { name: "Pagar fatura" })).toBeVisible();
      await page.screenshot({ path: `${SHOT_DIR}/${width}-conta-pagar-dialog.png`, fullPage: false });
      const confirm = await measure(
        page,
        `PagarFaturaDialog "Confirmar pagamento" @${width}`,
        page.getByRole("button", { name: /Confirmar pagamento/ }),
      );
      expect(confirm.height).toBeGreaterThanOrEqual(44);
      await measure(
        page,
        `PagarFaturaDialog "Fechar" @${width}`,
        page.getByRole("button", { name: "Fechar" }),
      );

      await page.getByRole("button", { name: /Confirmar pagamento/ }).click();
      await expect(page.getByText(/Pagamento da fatura .* registrado/)).toBeVisible();
      await page.screenshot({ path: `${SHOT_DIR}/${width}-conta-pagar-sucesso.png` });
      expect(posts.filter((p) => p.path.endsWith("/pay-invoice"))[0]?.body).toMatchObject({
        cardId: CARD_ID,
        accountId: ACCOUNT_ID,
        cardLast4: CARD_LAST4,
        bankLast4: BANK_LAST4,
      });
    });

    test("/conta · desfazer pagamento pelos 3 pontos de entrada", async ({ page }) => {
      const posts = await mockApi(page, "paga");
      await page.goto(`/projects/${personalId}/conta`);
      await expect(page.getByText("Tenho na conta hoje", { exact: true })).toBeVisible();

      const isDesktop = width >= 768;
      // Entrada 1 (desktop): CreditCardTile. Entrada 2 (mobile):
      // MobileCardActionsSheet — o carrossel não tem espaço pra empilhar botões.
      if (isDesktop) {
        await measure(
          page,
          `CreditCardTile "Desfazer pagamento" @${width}`,
          page.getByRole("button", { name: "Desfazer pagamento", exact: true }).first(),
        );
        await page.getByRole("button", { name: "Desfazer pagamento", exact: true }).first().click();
      } else {
        await page.getByRole("button", { name: /Nubank QA · 4488/ }).first().click();
        await expect(page.getByRole("dialog", { name: /Ações da fatura/ })).toBeVisible();
        await page.screenshot({ path: `${SHOT_DIR}/${width}-conta-actions-sheet.png` });
        await measure(
          page,
          `MobileCardActionsSheet "Desfazer pagamento" @${width}`,
          page.getByRole("button", { name: "Desfazer pagamento", exact: true }).first(),
        );
        await page.getByRole("button", { name: "Desfazer pagamento", exact: true }).first().click();
      }

      const dialog = page.getByRole("dialog", { name: /Desfazer pagamento/ });
      await expect(dialog).toBeVisible();
      await page.screenshot({ path: `${SHOT_DIR}/${width}-conta-desfazer-dialog.png` });
      const confirm = await measure(
        page,
        `UndoInvoicePaymentDialog "Desfazer pagamento" @${width}`,
        dialog.getByRole("button", { name: "Desfazer pagamento", exact: true }),
      );
      expect(confirm.height).toBeGreaterThanOrEqual(44);
      await measure(
        page,
        `UndoInvoicePaymentDialog "Cancelar" @${width}`,
        dialog.getByRole("button", { name: "Cancelar" }),
      );
      await dialog.getByRole("button", { name: "Desfazer pagamento", exact: true }).click();
      await expect(page.getByText(/Pagamento desfeito/)).toBeVisible();
      expect(posts.filter((p) => p.path.endsWith("/undo-invoice-payment"))[0]?.body).toMatchObject({
        cardId: CARD_ID,
        cardLast4: CARD_LAST4,
        dueMonth: DUE_MONTH,
      });

      // Entrada 3: linha de fatura em MovimentacoesSection (ações "⋯" no mobile).
      await page.reload();
      await expect(page.getByText("Tenho na conta hoje", { exact: true })).toBeVisible();
      if (!isDesktop) {
        await page.getByRole("button", { name: "Mais ações" }).first().click();
      }
      await measure(
        page,
        `MovimentacaoRow "Desfazer pagamento" @${width}`,
        page.getByRole("button", { name: "Desfazer pagamento" }).last(),
      );
      await page.getByRole("button", { name: "Desfazer pagamento" }).last().click();
      await expect(page.getByRole("dialog", { name: /Desfazer pagamento/ })).toBeVisible();
      await page.screenshot({ path: `${SHOT_DIR}/${width}-conta-linha-desfazer.png` });
    });

    test("/conta · recusa de identidade: erro visível e a CTA continua clicável", async ({
      page,
    }) => {
      const posts = await mockApi(page, "a pagar", true);
      await page.goto(`/projects/${personalId}/conta`);
      await expect(page.getByText("Tenho na conta hoje", { exact: true })).toBeVisible();

      if (width >= 768) {
        await page.getByRole("button", { name: "Pagar fatura", exact: true }).first().click();
      } else {
        await page.getByRole("button", { name: /Nubank QA · 4488/ }).first().click();
      }
      await expect(page.getByRole("heading", { name: "Pagar fatura" })).toBeVisible();
      await page.getByRole("button", { name: /Confirmar pagamento/ }).click();

      await expect(page.getByText(/mudaram desde que esta tela carregou/i)).toBeVisible();
      await page.waitForTimeout(500); // toast termina de entrar antes do print
      await page.screenshot({ path: `${SHOT_DIR}/${width}-conta-erro-identidade.png` });

      // O usuário NÃO fica num beco sem saída: diálogo aberto, botão medido e
      // clicável de novo. E nada foi reenviado sem a identidade.
      await expect(page.getByRole("heading", { name: "Pagar fatura" })).toBeVisible();
      const retry = await measure(
        page,
        `pós-erro "Confirmar pagamento" @${width}`,
        page.getByRole("button", { name: /Confirmar pagamento/ }),
      );
      expect(retry.height).toBeGreaterThanOrEqual(44);
      const invoicePosts = posts.filter((p) => p.path.endsWith("/pay-invoice"));
      expect(invoicePosts).toHaveLength(1);
      expect(invoicePosts[0].body.cardId).toBe(CARD_ID);
    });

    test("cockpit · fila 'Precisa de você' monta o mesmo diálogo com a identidade", async ({
      page,
    }) => {
      const posts = await mockApi(page, "a pagar");
      await page.goto(`/projects/${personalId}/monthly`);
      const resolver = page.getByRole("button", { name: "Resolver" }).first();
      await measure(page, `cockpit "Resolver" @${width}`, resolver);
      await resolver.click();
      await page.screenshot({ path: `${SHOT_DIR}/${width}-cockpit-fila.png` });

      const item = page.getByRole("button", { name: "Pagar fatura", exact: true }).first();
      await measure(page, `fila item "Pagar fatura" @${width}`, item);
      await item.click();

      await expect(page.getByRole("heading", { name: "Pagar fatura" })).toBeVisible();
      await page.screenshot({ path: `${SHOT_DIR}/${width}-cockpit-pagar-dialog.png` });
      const confirm = await measure(
        page,
        `cockpit PagarFaturaDialog "Confirmar pagamento" @${width}`,
        page.getByRole("button", { name: /Confirmar pagamento/ }),
      );
      expect(confirm.height).toBeGreaterThanOrEqual(44);
      await page.getByRole("button", { name: /Confirmar pagamento/ }).click();
      await expect(page.getByText(/Pagamento da fatura .* registrado/)).toBeVisible();
      await page.screenshot({ path: `${SHOT_DIR}/${width}-cockpit-pagar-sucesso.png` });
      expect(posts.filter((p) => p.path.endsWith("/pay-invoice"))[0]?.body).toMatchObject({
        cardId: CARD_ID,
        accountId: ACCOUNT_ID,
      });
    });
  });
}
