import { expect, test, type Page, type TestInfo } from "@playwright/test";

/**
 * #680 review — o CTA "Confirmar importação" dos modais de fatura e extrato
 * media abaixo de 44px de altura no mobile (390px: 36px; 375px: 56px por quebra,
 * sem garantia de mínimo). A Carteira já tinha `min-h-11`. Aqui medimos, no
 * navegador real, `getBoundingClientRect` >= 44 e hit-test no centro para os dois
 * CTAs em 375/390 — e conferimos que o desktop (1280) segue intacto.
 *
 * Também medimos o rótulo clicável "Importar mesmo assim" da linha Tier B no
 * extrato — evidência que faltou no QA anterior.
 *
 * Real components, API mockada. Roda nos projetos `desktop` (1280) e `mobile`
 * (Pixel 5 / 390); o de 375 é um resize explícito só no projeto mobile.
 */

const PESSOAL_ID = "ictt-pessoal";
const ACCOUNT_ID = "ictt-acc";
const CARD_ID = "ictt-card";

function json(body: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

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

const POSSIBLE_DUP = {
  externalId: "ictt-dup",
  existingId: "exp-existing",
  existingOrigin: "bank:9999",
  existingDate: "2026-06-10",
  existingAmountCents: 5000,
  reason: "same_natural_key_different_source",
};

const BANK_PREVIEW = {
  source: "OFX",
  periodLabel: "2026-09",
  total: 2,
  duplicated: 0,
  totalAmountCents: 12000,
  totalDebits: 2,
  totalCredits: 0,
  preview: [
    {
      externalId: "ictt-nova",
      date: "2026-09-01",
      merchant: "Padaria",
      amountCents: 123456789,
      category: null,
      duplicate: false,
      willImport: true,
    },
    {
      externalId: "ictt-dup",
      date: "2026-06-10",
      merchant: "Mercado",
      amountCents: 5000,
      category: null,
      duplicate: false,
      willImport: false,
      possibleDuplicate: POSSIBLE_DUP,
    },
  ],
  possibleDuplicates: [POSSIBLE_DUP],
};

const CARD_PREVIEW = {
  source: "CSV_NUBANK",
  periodLabel: "2026-09",
  total: 2,
  duplicated: 0,
  totalAmountCents: 12000,
  preview: [
    {
      externalId: "ictt-nova",
      date: "2026-09-01",
      merchant: "Padaria",
      amountCents: -123456789,
      category: null,
      installmentCurrent: null,
      installmentTotal: null,
      duplicate: false,
      willImport: true,
    },
    {
      externalId: "ictt-dup",
      date: "2026-06-10",
      merchant: "Mercado",
      amountCents: 5000,
      category: null,
      installmentCurrent: null,
      installmentTotal: null,
      duplicate: false,
      willImport: false,
      possibleDuplicate: POSSIBLE_DUP,
    },
  ],
  possibleDuplicates: [POSSIBLE_DUP],
};

async function mockApi(page: Page, baseURL: string, withoutAccount = false) {
  await page.clock.setFixedTime(new Date("2026-09-11T15:00:00.000Z"));
  await page
    .context()
    .addCookies([{ name: "rf_token", value: "ictt-test", url: baseURL }]);
  await page.route("http://localhost:3001/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/auth/me") {
      return route.fulfill(
        json({
          id: "ictt-user",
          username: "ictt-test",
          name: "ICTT",
          role: "USER",
          isGuest: false,
          tenantId: "ictt-tenant",
          allowedModules: [...ALL_MODULES],
          allowedProjects: [PESSOAL_ID],
          allowedProjectTypes: ["PESSOAL"],
        }),
      );
    }
    if (path === "/auth/config")
      return route.fulfill(
        json({ registerEnabled: false, guestEnabled: false }),
      );
    if (path === "/projects")
      return route.fulfill(
        json([{ id: PESSOAL_ID, name: "Pessoal", type: "PESSOAL" }]),
      );
    if (path === `/projects/${PESSOAL_ID}`) {
      return route.fulfill(
        json({
          id: PESSOAL_ID,
          name: "Pessoal",
          type: "PESSOAL",
          onboardedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    }
    if (/\/bank-accounts$/.test(path) || path === "/tenant/bank-accounts") {
      if (withoutAccount) return route.fulfill(json([]));
      // 2 contas de propósito: com 1 só, o picker auto-avança e não dá para medir o modal pelo picker.
      return route.fulfill(
        json([
          {
            id: ACCOUNT_ID,
            projectId: PESSOAL_ID,
            institution: "ITAU",
            nickname: "Conta ICTT",
            last4: "1111",
          },
          {
            id: "ictt-acc-2",
            projectId: PESSOAL_ID,
            institution: "BB",
            nickname: "Conta ICTT Dois",
            last4: "2222",
          },
        ]),
      );
    }
    if (/\/credit-cards$/.test(path) || path === "/tenant/credit-cards") {
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
            id: "ictt-card-2",
            projectId: PESSOAL_ID,
            institution: "ITAU",
            brand: "Visa",
            nickname: "Azul",
            last4: "5555",
          },
        ]),
      );
    }
    if (/^\/projects\/[^/]+\/expenses$/.test(path)) {
      return route.fulfill(
        json({ items: [], total: 0, page: 1, pageSize: 2000, totalPages: 0 }),
      );
    }
    if (/^\/projects\/[^/]+\/expenses\/paid-origins$/.test(path))
      return route.fulfill(json({ items: [] }));
    if (path.endsWith("/monthly-overview/account-view"))
      return route.fulfill(json(ACCOUNT_VIEW));
    if (path.endsWith("/monthly-overview/dre-overview"))
      return route.fulfill(json({ anual: { saldoAcumuladoSerie: [] } }));
    if (path.endsWith("/monthly-overview/origin-items-yearly")) {
      return route.fulfill(
        json({ year: 2026, kind: "all", last4: "", total: 0, items: [] }),
      );
    }
    if (path === "/journeys/eligible") return route.fulfill(json([]));
    if (
      path.endsWith("/receipts/import") &&
      url.searchParams.get("origin") === "none"
    ) {
      return route.fulfill(
        json(
          url.searchParams.get("mode") === "commit"
            ? { inserted: 1, failed: 0 }
            : {
                ...BANK_PREVIEW,
                preview: BANK_PREVIEW.preview.map((row) => ({
                  ...row,
                  description: row.merchant,
                  type: "DESPESA",
                  status: "PAGO",
                })),
              },
        ),
      );
    }
    if (
      path.includes("/bank-accounts/") &&
      path.endsWith("/import-statement")
    ) {
      return route.fulfill(
        json(
          url.searchParams.get("mode") === "commit"
            ? {
                importId: "i",
                source: "OFX",
                periodLabel: "2026-09",
                inserted: 1,
                duplicated: 0,
                receiptsInserted: 0,
                cardPayments: 0,
                aiReclassified: 0,
                recurrencesCreated: 0,
                skipped: 0,
              }
            : BANK_PREVIEW,
        ),
      );
    }
    if (path.includes("/credit-cards/") && path.endsWith("/import-statement")) {
      return route.fulfill(
        json(
          url.searchParams.get("mode") === "commit"
            ? {
                source: "CSV_NUBANK",
                periodLabel: "2026-09",
                inserted: 1,
                duplicated: 0,
                settled: 0,
                importId: "i",
              }
            : CARD_PREVIEW,
        ),
      );
    }
    return route.fulfill(json([]));
  });
}

function isMobile(testInfo: TestInfo) {
  return testInfo.project.name === "mobile";
}

/** Abre o modal de importação (extrato ou fatura) com a prévia já carregada. */
async function openImportModal(
  page: Page,
  kind: "extrato" | "fatura" | "carteira",
  mobile: boolean,
) {
  await page.goto(`/projects/${PESSOAL_ID}/conta`);
  await page
    .getByRole("button", { name: "Lançar", exact: true })
    .first()
    .click();
  if (mobile)
    await page.getByRole("button", { name: /Fatura \/ Extrato/i }).click();
  if (kind === "extrato" || kind === "carteira") {
    await page.getByRole("button", { name: /Extrato bancário/i }).click();
    const picker = page
      .locator('[data-mobile-sheet="modal"]')
      .filter({ hasText: "Para qual conta é esse extrato?" });
    // dispatchEvent: o botão desmonta no mesmo commit em que o modal monta;
    // um `.click()` normal entra em detach-retry.
    if (kind === "carteira")
      await picker
        .getByRole("button", { name: /Importar para Carteira/i })
        .click();
    else
      await picker
        .getByRole("button", { name: /Conta ICTT.*1111/ })
        .dispatchEvent("click");
  } else {
    await page.getByRole("button", { name: /Fatura (de|do) cart/i }).click();
    const picker = page
      .locator('[data-mobile-sheet="modal"]')
      .filter({ hasText: "Para qual cartão é essa fatura?" });
    await picker.getByRole("button", { name: /Roxo/ }).dispatchEvent("click");
  }
  const dialog =
    kind === "carteira"
      ? page.getByRole("dialog", { name: /Importar sem conta/i })
      : page
          .locator('[data-mobile-sheet="modal"]')
          .filter({ hasText: /Importar (fatura|extrato)/ });
  await expect(dialog).toBeVisible();
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "x.ofx",
    mimeType: "text/plain",
    buffer: Buffer.from("dummy"),
  });
  await dialog
    .getByRole("button", { name: /Pré-visualizar|Conferir arquivos/i })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Revisar Padaria" }),
  ).toBeVisible();
  const money = dialog
    .getByRole("button", { name: "Revisar Padaria" })
    .locator("..")
    .getByText(/-R\$\s*1\.234\.567,89/);
  await expect(money).toBeVisible();
  expect(
    await money.evaluate((node) => getComputedStyle(node).whiteSpace),
  ).toBe("nowrap");
  return dialog;
}

async function noHorizontalOverflow(page: Page) {
  return page.evaluate(() => {
    const de = document.documentElement;
    return (
      de.scrollWidth <= de.clientWidth + 1 &&
      document.body.scrollWidth <= de.clientWidth + 1
    );
  });
}

for (const kind of ["extrato", "fatura", "carteira"] as const) {
  test(`${kind}: "Confirmar importação" >= 44px e clicável (viewport do projeto)`, async ({
    page,
    baseURL,
  }, testInfo) => {
    const mobile = isMobile(testInfo);
    await mockApi(page, baseURL!, kind === "carteira");
    const dialog = await openImportModal(page, kind, mobile);
    await dialog.getByRole("button", { name: "Ver resumo" }).click();

    const confirmar = dialog.getByRole("button", {
      name: /Confirmar importação/i,
    });
    await confirmar.scrollIntoViewIfNeeded();
    const box = await confirmar.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);

    const centerHit = await page.evaluate(
      ({ x, y }) => {
        const btn = [...document.querySelectorAll("button")].find((b) =>
          /Confirmar importação/i.test(b.textContent ?? ""),
        );
        const hit = document.elementFromPoint(x, y);
        return !!btn && !!hit && (btn === hit || btn.contains(hit));
      },
      { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
    );
    expect(centerHit).toBe(true);
    const cancelar = dialog.getByRole("button", {
      name: "Cancelar",
      exact: true,
    });
    await cancelar.scrollIntoViewIfNeeded();
    const cancelBox = await cancelar.boundingBox();
    expect(cancelBox).not.toBeNull();
    expect(cancelBox!.height).toBeGreaterThanOrEqual(44);
    expect(cancelBox!.width).toBeGreaterThanOrEqual(44);
    expect(
      await cancelar.evaluate((button) => {
        const rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.x + rect.width / 2,
          rect.y + rect.height / 2,
        );
        return !!hit && (button === hit || button.contains(hit));
      }),
    ).toBe(true);

    expect(await noHorizontalOverflow(page)).toBe(true);
  });

  test(`${kind}: "Confirmar importação" >= 44px em 375px`, async ({
    page,
    baseURL,
  }, testInfo) => {
    test.skip(!isMobile(testInfo), "resize de 375px só no projeto mobile");
    await page.setViewportSize({ width: 375, height: 812 });
    await mockApi(page, baseURL!, kind === "carteira");
    const dialog = await openImportModal(page, kind, true);
    await dialog.getByRole("button", { name: "Ver resumo" }).click();

    const confirmar = dialog.getByRole("button", {
      name: /Confirmar importação/i,
    });
    await confirmar.scrollIntoViewIfNeeded();
    const box = await confirmar.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    const cancelBox = await dialog
      .getByRole("button", { name: "Cancelar", exact: true })
      .boundingBox();
    expect(cancelBox).not.toBeNull();
    expect(cancelBox!.height).toBeGreaterThanOrEqual(44);
    expect(await noHorizontalOverflow(page)).toBe(true);
  });
}

test('extrato: rótulo "Importar mesmo assim" da linha Tier B >= 44px e clicável', async ({
  page,
  baseURL,
}, testInfo) => {
  const mobile = isMobile(testInfo);
  await mockApi(page, baseURL!);
  const dialog = await openImportModal(page, "extrato", mobile);
  await dialog.getByRole("button", { name: "Revisar Mercado" }).click();
  await expect(dialog.getByText("⚠ Possível duplicata")).toBeVisible();
  const label = dialog.locator("label", { hasText: "Importar mesmo assim" });
  await label.scrollIntoViewIfNeeded();
  const box = await label.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);

  const hit = await page.evaluate(
    ({ x, y }) => {
      const lab = [...document.querySelectorAll("label")].find((l) =>
        /Importar mesmo assim/.test(l.textContent ?? ""),
      );
      const at = document.elementFromPoint(x, y);
      return !!lab && !!at && (lab === at || lab.contains(at));
    },
    { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
  );
  expect(hit).toBe(true);

  // a data do payload (existingDate ISO) aparece formatada no aviso Tier B
  await expect(
    dialog.locator("p", { hasText: "Mesma data e valor" }),
  ).toContainText("10/06/2026");
});

test("revisão: editor não empilha modal nem reprocessa e restaura foco quando o filtro oculta a linha", async ({
  page,
  baseURL,
}, testInfo) => {
  let previewRequests = 0;
  page.on("request", (request) => {
    if (
      request.url().includes("/import-statement?") &&
      new URL(request.url()).searchParams.get("mode") === "preview"
    )
      previewRequests++;
  });
  await mockApi(page, baseURL!);
  const dialog = await openImportModal(page, "extrato", isMobile(testInfo));
  await dialog.getByRole("button", { name: /Pendências/ }).click();
  await dialog.getByRole("button", { name: "Revisar Mercado" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await dialog.getByRole("checkbox", { name: /Importar mesmo assim/ }).check();
  await dialog.getByRole("button", { name: "Aplicar à revisão" }).click();
  await expect(
    dialog.getByRole("heading", { name: "Revisão", exact: true }),
  ).toBeFocused();
  await expect(
    dialog.getByRole("button", { name: "Revisar Mercado" }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: /Todos/ }).click();
  await dialog.getByRole("button", { name: "Revisar Mercado" }).click();
  await expect(
    dialog.getByRole("checkbox", { name: /Importar mesmo assim/ }),
  ).toBeChecked();
  await dialog.getByLabel("Descrição", { exact: true }).fill("Não aplicar");
  page.once("dialog", (warning) => warning.dismiss());
  await page.keyboard.press("Escape");
  await expect(dialog.getByLabel("Descrição", { exact: true })).toHaveValue(
    "Não aplicar",
  );
  page.once("dialog", (warning) => warning.accept());
  await page.keyboard.press("Escape");
  await expect(
    dialog.getByRole("button", { name: "Revisar Mercado" }),
  ).toBeFocused();
  expect(previewRequests).toBe(1);
});
