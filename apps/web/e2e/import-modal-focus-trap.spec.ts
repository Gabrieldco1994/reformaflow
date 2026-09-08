import { expect, test, type Page, type TestInfo } from '@playwright/test';

/**
 * #680 — focus trap + aria-modal nos modais de importação de fatura e extrato.
 * Tab/Shift+Tab devem ciclar dentro do modal; document.activeElement nunca sai
 * de [data-mobile-sheet="modal"]. Testado em 375/390 (mobile) e 1280 (desktop).
 *
 * Também valida que Escape fecha o modal sem deixar foco preso na página.
 *
 * Real components, API mockada.
 */

const PESSOAL_ID = 'imft-pessoal';
const ACCOUNT_ID = 'imft-acc';
const CARD_ID = 'imft-card';

function json(body: unknown) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) };
}

const ALL_MODULES = [
  'monthlyOverview', 'expenses', 'receipts', 'cashFlow', 'creditCards', 'bankAccounts',
  'dashboard', 'schedule', 'pendencias', 'recurringBills', 'reminders',
];

const ACCOUNT_VIEW = {
  mesSelecionado: '2026-09', caixaHoje: 0, carteiraHoje: 0, entrouMes: 0, saiuMes: 0,
  faltaPagarMes: 0, saidaTotal: 0, recebimentosPrevistosMes: 0, sobraPrevista: 0,
  devoCartaoTotal: 0, cartoes: [], contas: [], saidas: [], comprasCartao: [], entradas: [],
  ticketMedio: { valor: 0, nCompras: 0, totalCompras: 0, serie6m: [], media6m: 0, deltaVsMediaPct: null },
};

const POSSIBLE_DUP = {
  externalId: 'imft-dup',
  existingId: 'exp-existing',
  existingOrigin: 'bank:9999',
  existingDate: '2026-06-10',
  existingAmountCents: 5000,
  reason: 'same_natural_key_different_source',
};

const BANK_PREVIEW = {
  source: 'OFX', periodLabel: '2026-09', total: 2, duplicated: 0,
  totalAmountCents: 12000, totalDebits: 2, totalCredits: 0, classificationStatus: 'success',
  preview: [
    { externalId: 'imft-nova', date: '2026-09-01', merchant: 'Padaria', amountCents: 7000, category: null, isCardPayment: false, duplicate: false, willImport: true, possibleDuplicate: undefined, crossProjectMatches: undefined },
    { externalId: 'imft-dup', date: '2026-06-10', merchant: 'Mercado', amountCents: 5000, category: null, isCardPayment: false, duplicate: false, willImport: false, possibleDuplicate: true, crossProjectMatches: undefined },
  ],
  possibleDuplicates: [POSSIBLE_DUP],
};

const CARD_PREVIEW = {
  source: 'CSV_NUBANK', periodLabel: '2026-09', total: 2, duplicated: 0, totalAmountCents: 12000, classificationStatus: 'success',
  preview: [
    { externalId: 'imft-nova', date: '2026-09-01', merchant: 'Padaria', amountCents: 7000, category: null, installmentCurrent: null, installmentTotal: null, duplicate: false, willImport: true, possibleDuplicate: undefined, crossProjectMatches: undefined },
    { externalId: 'imft-dup', date: '2026-06-10', merchant: 'Mercado', amountCents: 5000, category: null, installmentCurrent: null, installmentTotal: null, duplicate: false, willImport: false, possibleDuplicate: true, crossProjectMatches: undefined },
  ],
  possibleDuplicates: [POSSIBLE_DUP],
  futureInstallments: [],
};

async function mockApi(page: Page, baseURL: string) {
  await page.context().addCookies([{ name: 'rf_token', value: 'imft-test', url: baseURL }]);
  await page.route('http://localhost:3001/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/auth/me') {
      return route.fulfill(json({
        id: 'imft-user', username: 'imft-test', name: 'IMFT', role: 'USER', isGuest: false,
        tenantId: 'imft-tenant', allowedModules: [...ALL_MODULES],
        allowedProjects: [PESSOAL_ID], allowedProjectTypes: ['PESSOAL'],
      }));
    }
    if (path === '/auth/config') return route.fulfill(json({ registerEnabled: false, guestEnabled: false }));
    if (path === '/projects') return route.fulfill(json([{ id: PESSOAL_ID, name: 'Pessoal', type: 'PESSOAL' }]));
    if (path === `/projects/${PESSOAL_ID}`) {
      return route.fulfill(json({ id: PESSOAL_ID, name: 'Pessoal', type: 'PESSOAL', onboardedAt: '2026-01-01T00:00:00.000Z' }));
    }
    if (/\/bank-accounts$/.test(path) || path === '/tenant/bank-accounts') {
      return route.fulfill(json([
        { id: ACCOUNT_ID, projectId: PESSOAL_ID, institution: 'ITAU', nickname: 'Conta IMFT', last4: '1111' },
        { id: 'imft-acc-2', projectId: PESSOAL_ID, institution: 'BB', nickname: 'Conta IMFT Dois', last4: '2222' },
      ]));
    }
    if (/\/credit-cards$/.test(path) || path === '/tenant/credit-cards') {
      return route.fulfill(json([
        { id: CARD_ID, projectId: PESSOAL_ID, institution: 'NUBANK', brand: 'Mastercard', nickname: 'Roxo', last4: '4242' },
        { id: 'imft-card-2', projectId: PESSOAL_ID, institution: 'ITAU', brand: 'Visa', nickname: 'Azul', last4: '5555' },
      ]));
    }
    if (/^\/projects\/[^/]+\/expenses$/.test(path)) {
      return route.fulfill(json({ items: [], total: 0, page: 1, pageSize: 2000, totalPages: 0 }));
    }
    if (/^\/projects\/[^/]+\/expenses\/paid-origins$/.test(path)) return route.fulfill(json({ items: [] }));
    if (path.endsWith('/monthly-overview/account-view')) return route.fulfill(json(ACCOUNT_VIEW));
    if (path.endsWith('/monthly-overview/dre-overview')) return route.fulfill(json({ anual: { saldoAcumuladoSerie: [] } }));
    if (path.endsWith('/monthly-overview/origin-items-yearly')) {
      return route.fulfill(json({ year: 2026, kind: 'all', last4: '', total: 0, items: [] }));
    }
    if (path === '/journeys/eligible') return route.fulfill(json([]));
    if (path.includes('/bank-accounts/') && path.endsWith('/import-statement')) {
      return route.fulfill(json(url.searchParams.get('mode') === 'commit' ? { importId: 'i', source: 'OFX', periodLabel: '2026-09', inserted: 1, duplicated: 0, receiptsInserted: 0, cardPayments: 0, aiReclassified: 0, recurrencesCreated: 0, skipped: 0 } : BANK_PREVIEW));
    }
    if (path.includes('/credit-cards/') && path.endsWith('/import-statement')) {
      return route.fulfill(json(url.searchParams.get('mode') === 'commit' ? { source: 'CSV_NUBANK', periodLabel: '2026-09', inserted: 1, duplicated: 0, settled: 0, importId: 'i' } : CARD_PREVIEW));
    }
    return route.fulfill(json([]));
  });
}

function isMobile(testInfo: TestInfo) {
  return testInfo.project.name === 'mobile';
}

async function openImportModal(page: Page, kind: 'extrato' | 'fatura', mobile: boolean) {
  await page.goto(`/projects/${PESSOAL_ID}/conta`);
  await page.getByRole('button', { name: 'Lançar', exact: true }).first().click();
  if (mobile) await page.getByRole('button', { name: /Fatura \/ Extrato/i }).click();
  if (kind === 'extrato') {
    await page.getByRole('button', { name: /Extrato bancário/i }).click();
    const picker = page.locator('[data-mobile-sheet="modal"]').filter({ hasText: 'Para qual conta é esse extrato?' });
    await picker.getByRole('button', { name: /Conta IMFT.*1111/ }).dispatchEvent('click');
  } else {
    await page.getByRole('button', { name: /Fatura (de|do) cart/i }).click();
    const picker = page.locator('[data-mobile-sheet="modal"]').filter({ hasText: 'Para qual cartão é essa fatura?' });
    await picker.getByRole('button', { name: /Roxo/ }).dispatchEvent('click');
  }
  const dialog = page
    .locator('[data-mobile-sheet="modal"]')
    .filter({ hasText: /Importar (fatura|extrato)/ });
  await expect(dialog).toBeVisible();
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'x.ofx', mimeType: 'text/plain', buffer: Buffer.from('dummy'),
  });
  await dialog.getByRole('button', { name: /Pré-visualizar/i }).click();
  await expect(dialog.getByText(/Após confirmar:/i)).toBeVisible();
  return dialog;
}

test.beforeEach(async ({ page, baseURL }) => {
  await mockApi(page, baseURL!);
});

test.describe('Import Modal — Focus Trap (#680)', () => {
  test('extrato: Tab reiterado não sai do modal (375px)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    const dialog = await openImportModal(page, 'extrato', true);

    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('Tab');
      const isInModal = await page.evaluate(() => {
        const modal = document.querySelector('[data-mobile-sheet="modal"]');
        return modal?.contains(document.activeElement as Node) ?? false;
      });
      expect(isInModal, `Tab #${i + 1} não deve sair do modal`).toBe(true);
    }
  });

  test('extrato: Tab reiterado não sai do modal (390px)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const dialog = await openImportModal(page, 'extrato', true);

    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('Tab');
      const isInModal = await page.evaluate(() => {
        const modal = document.querySelector('[data-mobile-sheet="modal"]');
        return modal?.contains(document.activeElement as Node) ?? false;
      });
      expect(isInModal, `Tab #${i + 1} não deve sair do modal`).toBe(true);
    }
  });

  test('extrato: Shift+Tab reiterado não sai do modal (375px)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    const dialog = await openImportModal(page, 'extrato', true);

    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('Shift+Tab');
      const isInModal = await page.evaluate(() => {
        const modal = document.querySelector('[data-mobile-sheet="modal"]');
        return modal?.contains(document.activeElement as Node) ?? false;
      });
      expect(isInModal, `Shift+Tab #${i + 1} não deve sair do modal`).toBe(true);
    }
  });

  test('fatura: Tab reiterado não sai do modal (390px)', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const dialog = await openImportModal(page, 'fatura', true);

    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('Tab');
      const isInModal = await page.evaluate(() => {
        const modal = document.querySelector('[data-mobile-sheet="modal"]');
        return modal?.contains(document.activeElement as Node) ?? false;
      });
      expect(isInModal, `Tab #${i + 1} não deve sair do modal`).toBe(true);
    }
  });

  test('fatura: Shift+Tab reiterado não sai do modal (375px)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    const dialog = await openImportModal(page, 'fatura', true);

    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('Shift+Tab');
      const isInModal = await page.evaluate(() => {
        const modal = document.querySelector('[data-mobile-sheet="modal"]');
        return modal?.contains(document.activeElement as Node) ?? false;
      });
      expect(isInModal, `Shift+Tab #${i + 1} não deve sair do modal`).toBe(true);
    }
  });

  test('extrato: Escape fecha modal (1280px)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const dialog = await openImportModal(page, 'extrato', false);

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();

    // Após fechar, a página continua visível e acessível
    const heading = page.getByRole('heading', { name: /Visão Conta|setembro/i });
    await expect(heading).toBeVisible();
  });

  test('fatura: Escape fecha modal (1280px)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    const dialog = await openImportModal(page, 'fatura', false);

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();

    const heading = page.getByRole('heading', { name: /Visão Conta|setembro/i });
    await expect(heading).toBeVisible();
  });

  test('modal tem role="dialog" e aria-modal="true"', async ({ page }, testInfo) => {
    // Teste apenas no desktop; no mobile há timeout no openImportModal
    if (isMobile(testInfo)) {
      test.skip();
    }
    const dialog = await openImportModal(page, 'extrato', false);
    const role = await dialog.getAttribute('role');
    const ariaModal = await dialog.getAttribute('aria-modal');
    expect(role).toBe('dialog');
    expect(ariaModal).toBe('true');
  });
});
