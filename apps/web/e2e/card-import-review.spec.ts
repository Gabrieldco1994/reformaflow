import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * #714 — revisão de compra parcelada "mesmo N, preço diferente" na importação
 * de fatura, com a volta explícita às pendências.
 *
 * CONTRATO DE UI, NÃO JORNADA REAL: o stub de `http://localhost:3001/**` é
 * declarado abaixo e responde a prévia/commit de cartão no formato dos tipos
 * de `card-import-review.ts` (domain b4595443). Componentes reais, servidor
 * falso; nada aqui prova o backend. Mede caixa >= 44px, hit-test, nowrap,
 * overflow e foco em 375/390/1280.
 */

const PESSOAL_ID = "cir-pessoal";
const CARD_ID = "cir-card";
const F1 = "a".repeat(64);
const F2 = "b".repeat(64);

const ALL_MODULES = [
  "monthlyOverview",
  "expenses",
  "receipts",
  "cashFlow",
  "creditCards",
  "bankAccounts",
  "dashboard",
  "schedule",
  "pendencias",
  "recurringBills",
  "reminders",
];

const ACCOUNT_VIEW = {
  mesSelecionado: "2026-09",
  caixaHoje: 0,
  carteiraHoje: 0,
  entrouMes: 0,
  saiuMes: 0,
  faltaPagarMes: 0,
  saidaTotal: 0,
  recebimentosPrevistosMes: 0,
  sobraPrevista: 0,
  devoCartaoTotal: 0,
  cartoes: [],
  contas: [],
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
};

const line = (over: Record<string, unknown>) => ({
  category: null,
  installmentCurrent: null,
  installmentTotal: null,
  duplicate: false,
  willImport: true,
  review: null,
  ...over,
});

// Valor longo e estorno negativo: o "R$ 0,00" de sempre não estressa a largura.
const PREVIEW = {
  source: "CSV_NUBANK",
  periodLabel: "2026-09",
  total: 4,
  duplicated: 0,
  totalAmountCents: 0,
  classificationStatus: "success",
  futureInstallments: [
    line({
      externalId: "f1",
      date: "2026-10-03",
      merchant: "TV SAMSUNG 65 POLEGADAS",
      amountCents: 15000000,
      installmentCurrent: 2,
      installmentTotal: 10,
      willImport: false,
    }),
  ],
  preview: [
    line({
      externalId: "ok",
      date: "2026-09-01",
      merchant: "PADARIA",
      amountCents: 12345678,
    }),
    line({
      externalId: "neg",
      date: "2026-09-02",
      merchant: "ESTORNO LOJA",
      amountCents: -9876543,
    }),
    line({
      externalId: "rev",
      date: "2026-09-03",
      merchant: "TV SAMSUNG 65 POLEGADAS",
      amountCents: 15000000,
      installmentCurrent: 1,
      installmentTotal: 10,
      willImport: false,
      review: {
        externalId: "rev",
        reason: "REVIEW_REQUIRED",
        fingerprint: F1,
        candidates: [
          {
            expenseId: "exp-old",
            titulo: "TV SAMSUNG 65 POLEGADAS",
            installmentCount: 10,
            seriesAmountCents: 10000000,
            dataCompra: "2026-05-10",
          },
        ],
      },
    }),
    line({
      externalId: "blk",
      date: "2026-09-04",
      merchant: "GELADEIRA",
      amountCents: 90000,
      willImport: false,
      review: {
        externalId: "blk",
        reason: "BLOCKED_IDENTITY",
        fingerprint: null,
        candidates: [],
      },
    }),
  ],
};

const baseCommit = {
  source: "CSV_NUBANK",
  periodLabel: "2026-09",
  duplicated: 0,
  settled: 0,
  skipped: 0,
  linked: 0,
  skippedItems: [],
};

function json(body: unknown, status = 200) {
  return {
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

// Pagamento da própria fatura (ignored no fio) + uma compra normal.
const PREVIEW_IGNORED = {
  ...PREVIEW,
  total: 3,
  totalAmountCents: 123456789,
  futureInstallments: [],
  preview: [
    line({
      externalId: "ok",
      date: "2026-09-01",
      merchant: "PADARIA",
      amountCents: 12345678,
    }),
    line({
      externalId: "pay",
      date: "2026-09-05",
      merchant: "PAGAMENTO EFETUADO",
      amountCents: -123456789,
      willImport: false,
      ignored: "INVOICE_PAYMENT",
    }),
    line({
      externalId: "pay2",
      date: "2026-09-06",
      merchant: "PAGAMENTO EFETUADO",
      amountCents: -50000,
      willImport: false,
      ignored: "INVOICE_PAYMENT",
    }),
  ],
};

type Stub = {
  preview?: "ignored";
  commits: string[];
  commitStatus: "partial-then-ok" | "conflict" | "row-error";
};

async function mockApi(page: Page, baseURL: string, stub: Stub) {
  await page.clock.setFixedTime(new Date("2026-09-11T15:00:00.000Z"));
  await page
    .context()
    .addCookies([{ name: "rf_token", value: "cir-test", url: baseURL }]);
  await page.route("http://localhost:3001/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/auth/me")
      return route.fulfill(
        json({
          id: "cir-user",
          username: "cir-test",
          name: "CIR",
          role: "USER",
          isGuest: false,
          tenantId: "cir-tenant",
          allowedModules: [...ALL_MODULES],
          allowedProjects: [PESSOAL_ID],
          allowedProjectTypes: ["PESSOAL"],
        }),
      );
    if (path === "/auth/config")
      return route.fulfill(
        json({ registerEnabled: false, guestEnabled: false }),
      );
    if (path === "/projects")
      return route.fulfill(
        json([{ id: PESSOAL_ID, name: "Pessoal", type: "PESSOAL" }]),
      );
    if (path === `/projects/${PESSOAL_ID}`)
      return route.fulfill(
        json({
          id: PESSOAL_ID,
          name: "Pessoal",
          type: "PESSOAL",
          onboardedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    if (/\/bank-accounts$/.test(path) || path === "/tenant/bank-accounts")
      return route.fulfill(json([]));
    if (/\/credit-cards$/.test(path) || path === "/tenant/credit-cards")
      return route.fulfill(
        json([
          {
            id: CARD_ID,
            projectId: PESSOAL_ID,
            institution: "NUBANK",
            brand: "Mastercard",
            nickname: "Roxo",
            last4: "4242",
          },
          {
            id: "cir-card-2",
            projectId: PESSOAL_ID,
            institution: "ITAU",
            brand: "Visa",
            nickname: "Azul",
            last4: "5555",
          },
        ]),
      );
    if (/^\/projects\/[^/]+\/expenses$/.test(path))
      return route.fulfill(
        json({ items: [], total: 0, page: 1, pageSize: 2000, totalPages: 0 }),
      );
    if (/^\/projects\/[^/]+\/expenses\/paid-origins$/.test(path))
      return route.fulfill(json({ items: [] }));
    if (path.endsWith("/monthly-overview/account-view"))
      return route.fulfill(json(ACCOUNT_VIEW));
    if (path.endsWith("/monthly-overview/dre-overview"))
      return route.fulfill(json({ anual: { saldoAcumuladoSerie: [] } }));
    if (path.endsWith("/monthly-overview/origin-items-yearly"))
      return route.fulfill(
        json({ year: 2026, kind: "all", last4: "", total: 0, items: [] }),
      );
    if (path === "/journeys/eligible") return route.fulfill(json([]));
    if (path.includes("/credit-cards/") && path.endsWith("/import-statement")) {
      if (url.searchParams.get("mode") !== "commit")
        return route.fulfill(
          json(stub.preview === "ignored" ? PREVIEW_IGNORED : PREVIEW),
        );
      stub.commits.push(route.request().postData() ?? "");
      if (stub.commitStatus === "conflict")
        return route.fulfill(
          json(
            {
              code: "SELECTED_ROWS_CHANGED",
              missingCount: 1,
              missingExternalIds: ["ok"],
            },
            409,
          ),
        );
      if (stub.commitStatus === "row-error")
        return route.fulfill(
          json({
            ...baseCommit,
            importId: "imp-1",
            inserted: 1,
            reviewRequired: [],
            notSelected: 2,
            lineResults: [
              { externalId: "ok", outcome: "CREATED" },
              { externalId: "neg", outcome: "ERROR" },
              { externalId: "rev", outcome: "NOT_SELECTED" },
              { externalId: "blk", outcome: "NOT_SELECTED" },
            ],
          }),
        );
      if (stub.commits.length === 1)
        return route.fulfill(
          json({
            ...baseCommit,
            importId: "imp-1",
            inserted: 2,
            reviewRequired: [
              {
                externalId: "rev",
                reason: "REVIEW_REQUIRED",
                fingerprint: F2,
                candidates: [
                  {
                    expenseId: "exp-old",
                    titulo: "TV SAMSUNG 65 POLEGADAS",
                    installmentCount: 10,
                    seriesAmountCents: 12000000,
                    dataCompra: "2026-05-10",
                  },
                ],
              },
            ],
            notSelected: 1,
            lineResults: [
              { externalId: "ok", outcome: "CREATED" },
              { externalId: "neg", outcome: "CREATED" },
              { externalId: "rev", outcome: "REVIEW_REQUIRED" },
              { externalId: "blk", outcome: "NOT_SELECTED" },
            ],
          }),
        );
      return route.fulfill(
        json({
          ...baseCommit,
          importId: "imp-2",
          inserted: 1,
          reviewRequired: [],
          notSelected: 3,
          lineResults: [
            { externalId: "ok", outcome: "NOT_SELECTED" },
            { externalId: "neg", outcome: "NOT_SELECTED" },
            { externalId: "rev", outcome: "CREATED" },
            { externalId: "blk", outcome: "NOT_SELECTED" },
          ],
        }),
      );
    }
    return route.fulfill(json([]));
  });
}

async function openCardImport(page: Page, mobile: boolean) {
  await page.goto(`/projects/${PESSOAL_ID}/conta`);
  await page
    .getByRole("button", { name: "Lançar", exact: true })
    .first()
    .click();
  if (mobile)
    await page.getByRole("button", { name: /Fatura \/ Extrato/i }).click();
  await page.getByRole("button", { name: /Fatura (de|do) cart/i }).click();
  await page
    .locator('[data-mobile-sheet="modal"]')
    .filter({ hasText: "Para qual cartão é essa fatura?" })
    .getByRole("button", { name: /Roxo/ })
    .dispatchEvent("click");
  const dialog = page
    .locator('[data-mobile-sheet="modal"]')
    .filter({ hasText: /Importar fatura/ });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/^Arquivos/).setInputFiles({
    name: "fatura.csv",
    mimeType: "text/plain",
    buffer: Buffer.from("dummy"),
  });
  await dialog
    .getByRole("button", { name: "Conferir arquivos", exact: true })
    .click();
  await expect(dialog.getByText(/Após confirmar:/i)).toBeVisible();
  return dialog;
}

/** Caixa >= 44px e o centro do alvo realmente acerta o próprio controle. */
async function expectTouchable(target: Locator) {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  expect(box, "alvo sem caixa").not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.width).toBeGreaterThanOrEqual(44);
  const hit = await target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const at = document.elementFromPoint(
      r.left + r.width / 2,
      r.top + r.height / 2,
    );
    return !!at && (el === at || el.contains(at) || at.contains(el));
  });
  expect(hit, "elementFromPoint não acertou o alvo").toBe(true);
}

async function expectNoOverflow(dialog: Locator) {
  const overflow = await dialog.evaluate(
    (el) => el.scrollWidth - el.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

async function expectNowrapMoney(dialog: Locator) {
  const wrapped = await dialog.evaluate((root) =>
    [...root.querySelectorAll("strong, span")]
      .filter((el) => /^-?\s*R\$\s*[\d.]+,\d{2}$/.test(el.textContent?.trim() ?? ""))
      .filter((el) => getComputedStyle(el).whiteSpace !== "nowrap")
      .map((el) => el.textContent),
  );
  expect(wrapped, "valores monetários sem nowrap").toEqual([]);
}

function selectedIds(body: string) {
  const m = body.match(/name="selectedExternalIds"\r?\n\r?\n([^\r\n]*)/);
  return m ? (JSON.parse(m[1]) as string[]) : null;
}

const VIEWPORTS = [
  { width: 375, height: 667, mobile: true },
  { width: 390, height: 844, mobile: true },
  { width: 1280, height: 800, mobile: false },
];

for (const vp of VIEWPORTS) {
  test.describe(`Revisão de compra parcelada (#714) — ${vp.width}px`, () => {
    test(`fluxo: aviso, seleção explícita, pendências e retomada`, async ({
      page,
      baseURL,
    }) => {
      const stub: Stub = { commits: [], commitStatus: "partial-then-ok" };
      await mockApi(page, baseURL!, stub);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const dialog = await openCardImport(page, vp.mobile);

      const resumo = dialog.getByText(/Após confirmar:/i);
      await expect(resumo).toContainText("2 novas");
      await expect(resumo).toContainText("1 aguardando decisão");
      await expect(resumo).toContainText("1 bloqueada(s)");
      await expectNowrapMoney(dialog);
      await expectNoOverflow(dialog);
      await expectTouchable(
        dialog.getByRole("button", { name: "Revisar TV SAMSUNG 65 POLEGADAS" }),
      );

      // Parcelas futuras: fato do arquivo, sem soma nem promessa de PLANEJADO.
      const future = dialog.getByRole("group", {
        name: /parcelas futuras informadas na fatura/i,
      });
      await expect(future).toContainText(/não é o cronograma nem o total/i);
      await expect(future).toContainText(/apenas as compras confirmadas/i);
      await expect(future).not.toContainText(/planejado/i);
      const toggle = future.getByRole("button");
      await expectTouchable(toggle);
      await toggle.click();
      await expect(future).toContainText("(2/10)");
      await expectNowrapMoney(dialog);
      await expectNoOverflow(dialog);

      // Editor da linha em revisão: candidato visto, checkbox >= 44px.
      await dialog
        .getByRole("button", { name: "Revisar TV SAMSUNG 65 POLEGADAS" })
        .click();
      await expect(dialog.getByText("⚠ Possível mesma compra")).toBeVisible();
      await expectTouchable(
        dialog.getByRole("checkbox", { name: /é outra compra/i }).locator(".."),
      );
      await expectNowrapMoney(dialog);
      await expectNoOverflow(dialog);
      await dialog.getByRole("button", { name: /cancelar edição/i }).click();

      // A linha bloqueada não oferece override.
      await dialog.getByRole("button", { name: "Revisar GELADEIRA" }).click();
      await expect(
        dialog.getByRole("checkbox", { name: /é outra compra/i }),
      ).toHaveCount(0);
      await dialog.getByRole("button", { name: /cancelar edição/i }).click();

      // 1ª tentativa: só o que está pronto vai na seleção.
      await dialog.getByRole("button", { name: /ver resumo/i }).click();
      await dialog
        .getByRole("button", { name: /confirmar importação/i })
        .click();
      const retry = dialog.getByRole("button", {
        name: /revisar pendências \(1\)/i,
      });
      await expect(retry).toBeVisible();
      expect(stub.commits).toHaveLength(1);
      expect(selectedIds(stub.commits[0])).toEqual(["ok", "neg"]);
      await expectTouchable(retry);
      await expectTouchable(
        dialog.getByRole("button", { name: /concluir mesmo assim/i }),
      );
      await expectNowrapMoney(dialog);
      await expectNoOverflow(dialog);

      // Retomada explícita: nenhum request novo, foco no título, pendência aberta.
      await retry.click();
      expect(stub.commits).toHaveLength(1);
      await expect(
        dialog.getByRole("heading", { name: "Revisão", exact: true }),
      ).toBeFocused();
      await expect(dialog.getByText(/Tentativa 1/)).toHaveCount(1);
      await expect(
        dialog.getByRole("button", { name: "Revisar PADARIA" }),
      ).toHaveCount(0);
      await dialog
        .getByRole("button", { name: "Revisar TV SAMSUNG 65 POLEGADAS" })
        .click();
      const consent = dialog.getByRole("checkbox", { name: /é outra compra/i });
      await expect(consent).not.toBeChecked();
      await expect(dialog.getByText(/120\.000,00/)).toBeVisible();
      await consent.check();
      await dialog.getByRole("button", { name: /aplicar à revisão/i }).click();
      await dialog.getByRole("button", { name: /ver resumo/i }).click();
      await dialog
        .getByRole("button", { name: /confirmar importação/i })
        .click();
      await expect(dialog.getByText("Importação concluída")).toBeVisible();
      expect(stub.commits).toHaveLength(2);
      expect(selectedIds(stub.commits[1])).toEqual(["rev"]);
      expect(stub.commits[1]).toContain(F2);
      expect(stub.commits[1]).not.toContain(F1);
      // Efeito da tentativa 1 continua visível junto da 2.
      await expect(dialog.getByText(/Tentativa 1/)).toHaveCount(1);
      await expect(dialog.getByText(/Tentativa 2/)).toHaveCount(1);
      await expectNowrapMoney(dialog);
      await expectNoOverflow(dialog);
    });

    test(`409 SELECTED_ROWS_CHANGED: pede nova prévia manual e nada é reenviado`, async ({
      page,
      baseURL,
    }) => {
      const stub: Stub = { commits: [], commitStatus: "conflict" };
      await mockApi(page, baseURL!, stub);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const dialog = await openCardImport(page, vp.mobile);
      await dialog.getByRole("button", { name: /ver resumo/i }).click();
      await dialog
        .getByRole("button", { name: /confirmar importação/i })
        .click();
      await expect(dialog.getByRole("alert")).toContainText(/nova prévia/i);
      const fresh = dialog.getByRole("button", { name: /gerar nova prévia/i });
      await expectTouchable(fresh);
      await expectNoOverflow(dialog);
      await fresh.click();
      await expect(
        dialog.getByRole("button", { name: "Conferir arquivos", exact: true }),
      ).toBeVisible();
      expect(stub.commits).toHaveLength(1);
    });

    test(`pagamento de fatura: só leitura, fora da seleção e da soma`, async ({
      page,
      baseURL,
    }) => {
      const stub: Stub = {
        preview: "ignored",
        commits: [],
        commitStatus: "partial-then-ok",
      };
      await mockApi(page, baseURL!, stub);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const dialog = await openCardImport(page, vp.mobile);

      await expect(dialog).toContainText("3 transações no arquivo");
      await expect(dialog).toContainText("1 selecionada(s)");
      await expect(dialog).toContainText(
        "2 pagamento(s) de fatura ignorado(s)",
      );
      await expect(dialog.getByText(/Após confirmar:/i)).toContainText(
        "1 novas",
      );
      await expect(dialog).toContainText("Total do arquivo");
      await expectNowrapMoney(dialog);
      await expectNoOverflow(dialog);

      // Revisar abre só a leitura da razão: sem campos nem ações da linha.
      const revisar = dialog.getByRole("button", {
        name: "Revisar PAGAMENTO EFETUADO",
      });
      await expect(revisar).toHaveCount(2);
      await expectTouchable(revisar.first());
      await revisar.first().click();
      await expect(
        dialog.getByText(/Pagamento de fatura — não é compra/).first(),
      ).toBeVisible();
      await expect(dialog.getByLabel("Descrição")).toHaveCount(0);
      await expect(
        dialog.getByRole("button", { name: /Importar mesmo assim/i }),
      ).toHaveCount(0);
      await expectNoOverflow(dialog);
      // Sem nada a aplicar: só "Fechar" (global) e "Voltar à revisão".
      await expect(
        dialog.getByRole("button", {
          name: /aplicar à revisão|cancelar edição|restaurar/i,
        }),
      ).toHaveCount(0);
      const controles = await dialog
        .locator("button, input, select, textarea, a[href]")
        .evaluateAll((els) =>
          els.map((e) =>
            (e.getAttribute("aria-label") || e.textContent || "").trim(),
          ),
        );
      expect(controles).toEqual(["Fechar", "Voltar à revisão"]);
      const voltar = dialog.getByRole("button", { name: /voltar à revisão/i });
      await expectTouchable(voltar);
      await voltar.click();
      await expect(dialog.getByText(/Após confirmar:/i)).toContainText("1 novas");

      // Confirmar envia só a compra; o pagamento nunca entra na seleção.
      await dialog.getByRole("button", { name: /ver resumo/i }).click();
      await dialog
        .getByRole("button", { name: /confirmar importação/i })
        .click();
      await expect.poll(() => stub.commits.length).toBe(1);
      expect(selectedIds(stub.commits[0])).toEqual(["ok"]);
      expect(stub.commits[0]).not.toContain("pay");
    });

    test(`ERRO de linha: rótulo longo cabe, alvos tocáveis e retomada só por ação`, async ({
      page,
      baseURL,
    }) => {
      const stub: Stub = { commits: [], commitStatus: "row-error" };
      await mockApi(page, baseURL!, stub);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const dialog = await openCardImport(page, vp.mobile);
      await dialog.getByRole("button", { name: /ver resumo/i }).click();
      await dialog
        .getByRole("button", { name: /confirmar importação/i })
        .click();
      const retry = dialog.getByRole("button", {
        name: /revisar pendências \(2\)/i,
      });
      await expect(retry).toBeVisible();
      await expectTouchable(retry);
      await expectNoOverflow(dialog);
      await retry.click();
      expect(stub.commits).toHaveLength(1);
      // Uma vez no histórico da tentativa e outra na linha: ambas visíveis.
      const errorLabels = dialog.getByText(
        "Com erro · revise os dados ou tente novamente",
      );
      await expect(errorLabels).toHaveCount(2);
      for (const label of await errorLabels.all()) await expect(label).toBeVisible();
      await expectTouchable(
        dialog.getByRole("button", { name: "Revisar ESTORNO LOJA" }),
      );
      await expectNowrapMoney(dialog);
      await expectNoOverflow(dialog);
    });
  });
}
