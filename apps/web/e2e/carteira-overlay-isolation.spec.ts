import { expect, test, type Page } from '@playwright/test';

/**
 * #659 F3 — stacked overlays / background isolation. Real components, mocked API.
 * When the Carteira importer is open, the account-picker <Modal> must be
 * unmounted, the page behind must be `inert` (no hit-testing, no Tab escape,
 * SR browse-mode blocked), and Escape/Cancel return to the picker with focus on
 * "Importar para Carteira". Concluir ends the flow. Runs on both the `desktop`
 * (1280) and `mobile` (Pixel 5 / 390) projects; the mobile project also gets a
 * 375-wide check. Modeled on carteira-launcher-reachability.spec.ts.
 */

const PESSOAL_ID = 'e659-pessoal';
const FIXED_TIME = new Date('2026-09-02T12:00:00.000Z');

function json(body: unknown) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) };
}

const ALL_MODULES = [
  'monthlyOverview', 'expenses', 'receipts', 'cashFlow', 'creditCards', 'bankAccounts',
  'dashboard', 'schedule', 'pendencias', 'floorPlans', 'simulation', 'priceCompare',
  'recurringBills', 'financing', 'maintenance', 'reminders', 'carInfo', 'vehicleDocuments', 'recurrences',
];

const ACCOUNT_VIEW = {
  mesSelecionado: '2026-09', caixaHoje: 0, carteiraHoje: 0, entrouMes: 0, saiuMes: 0,
  faltaPagarMes: 0, saidaTotal: 0, recebimentosPrevistosMes: 0, sobraPrevista: 0,
  devoCartaoTotal: 0, cartoes: [], contas: [], saidas: [], comprasCartao: [], entradas: [],
  ticketMedio: { valor: 0, nCompras: 0, totalCompras: 0, serie6m: [], media6m: 0, deltaVsMediaPct: null },
};

async function mockApi(page: Page, baseURL: string, accounts: unknown[] = []) {
  await page.context().addCookies([{ name: 'rf_token', value: 'e659-test', url: baseURL }]);
  await page.route('http://localhost:3001/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/auth/me') {
      return route.fulfill(json({
        id: 'e659-user', username: 'e659-test', name: 'E659', role: 'USER', isGuest: false,
        tenantId: 'e659-tenant', allowedModules: [...ALL_MODULES],
        allowedProjects: [PESSOAL_ID], allowedProjectTypes: ['PESSOAL'],
      }));
    }
    if (path === `/projects/${PESSOAL_ID}`) {
      return route.fulfill(json({ id: PESSOAL_ID, name: 'Pessoal', type: 'PESSOAL', onboardedAt: '2026-01-01T00:00:00.000Z' }));
    }
    if (/\/bank-accounts$/.test(path) || path === '/tenant/bank-accounts') return route.fulfill(json(accounts));
    if (/\/credit-cards$/.test(path) || path === '/tenant/credit-cards') return route.fulfill(json([]));
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
    if (path.endsWith('/receipts/import')) {
      if (url.searchParams.get('mode') === 'preview') {
        return route.fulfill(json({
          total: 2, totalAmountCents: 8000, duplicated: 0,
          rows: [
            { externalId: 'e659-1', date: '2026-09-01', description: 'Mercado', amountCents: 5000, type: 'DESPESA', status: 'EM_CAIXA' },
            { externalId: 'e659-2', date: '2026-09-02', description: 'Farmácia', amountCents: 3000, type: 'DESPESA', status: 'EM_CAIXA' },
          ],
        }));
      }
      return route.fulfill(json({ inserted: 2, failed: 0 }));
    }
    return route.fulfill(json([]));
  });
}

function isMobile(testInfo: import('@playwright/test').TestInfo) {
  return testInfo.project.name === 'mobile';
}

async function openPicker(page: Page, mobile: boolean) {
  await page.goto(`/projects/${PESSOAL_ID}/conta`);
  await page.getByRole('button', { name: 'Lançar', exact: true }).first().click();
  if (mobile) await page.getByRole('button', { name: /Fatura \/ Extrato/i }).click();
  await page.getByRole('button', { name: /Extrato bancário/i }).click();
  return page.locator('[data-mobile-sheet="modal"]', { hasText: 'Para qual conta é esse extrato?' });
}

async function openCarteira(page: Page, mobile: boolean) {
  const picker = await openPicker(page, mobile);
  await picker.getByRole('button', { name: 'Importar para Carteira' }).click();
  await expect(page.getByRole('dialog', { name: 'Importar sem conta' })).toBeVisible();
}

/** Count elements matching text that are NOT inside an [inert] subtree. */
function nonInertCount(page: Page, text: string) {
  return page.evaluate((t) => {
    const all = Array.from(document.querySelectorAll('button, a'));
    return all.filter((el) => {
      const name = ((el.textContent ?? '') + ' ' + (el.getAttribute('aria-label') ?? '')).trim();
      return name.includes(t) && !el.closest('[inert]');
    }).length;
  }, text);
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_TIME);
});

test('picker unmounts, background inert, one "Fechar", Tab is trapped', async ({ page, baseURL }, testInfo) => {
  const mobile = isMobile(testInfo);
  await mockApi(page, baseURL!);
  await openCarteira(page, mobile);

  // The picker <Modal> is gone from the DOM.
  await expect(page.getByText('Para qual conta é esse extrato?')).toHaveCount(0);

  // Exactly one reachable (non-inert) "Fechar" and zero non-inert "Nova conta".
  expect(await nonInertCount(page, 'Fechar')).toBe(1);
  expect(await nonInertCount(page, 'Nova conta')).toBe(0);

  // Every body child that is not the portal is inert.
  const leaked = await page.evaluate(() => {
    const portal = document.querySelector('[data-carteira-import-portal]');
    return Array.from(document.body.children)
      .filter((el) => el !== portal && !el.hasAttribute('inert'))
      .map((el) => el.tagName + '.' + (el as HTMLElement).className);
  });
  expect(leaked, `non-inert body children behind dialog: ${leaked.join(' | ')}`).toEqual([]);

  // elementFromPoint at the viewport centre lands inside the dialog overlay,
  // never on page-behind content.
  const overDialog = await page.evaluate(() => {
    const el = document.elementFromPoint(window.innerWidth / 2, 4);
    return !!el?.closest('[data-carteira-import-portal]');
  });
  expect(overDialog).toBe(true);

  // Tab / Shift+Tab many times — focus never escapes the dialog.
  const dialog = page.getByRole('dialog', { name: 'Importar sem conta' });
  await dialog.getByRole('button', { name: 'Fechar' }).focus();
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press(key);
      const inside = await page.evaluate(() => {
        const d = document.querySelector('[role="dialog"][aria-modal="true"]');
        return !!d && d.contains(document.activeElement);
      });
      expect(inside, `focus escaped dialog on ${key} #${i}`).toBe(true);
    }
  }
});

test('Escape returns to the picker, focuses "Importar para Carteira", no double-close', async ({ page, baseURL }, testInfo) => {
  const mobile = isMobile(testInfo);
  await mockApi(page, baseURL!);
  await openCarteira(page, mobile);

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Importar sem conta' })).toHaveCount(0);
  await expect(page.getByText('Para qual conta é esse extrato?')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Importar para Carteira' })).toBeFocused();
});

test('Cancel button behaves like Escape', async ({ page, baseURL }, testInfo) => {
  const mobile = isMobile(testInfo);
  await mockApi(page, baseURL!);
  await openCarteira(page, mobile);

  await page.getByRole('dialog', { name: 'Importar sem conta' }).getByRole('button', { name: 'Cancelar' }).click();
  await expect(page.getByRole('dialog', { name: 'Importar sem conta' })).toHaveCount(0);
  await expect(page.getByText('Para qual conta é esse extrato?')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Importar para Carteira' })).toBeFocused();
});

test('Concluir after a real CSV import: modal closes, picker does not reopen', async ({ page, baseURL }, testInfo) => {
  const mobile = isMobile(testInfo);
  await mockApi(page, baseURL!);
  await page.goto(`/projects/${PESSOAL_ID}/conta`);
  const launcher = page.getByRole('button', { name: 'Lançar', exact: true }).first();
  await launcher.click();
  // marca o elemento que tinha o foco ao abrir o fluxo
  await page.evaluate(() => (document.activeElement as HTMLElement)?.setAttribute('data-e659-opener', '1'));
  if (mobile) await page.getByRole('button', { name: /Fatura \/ Extrato/i }).click();
  await page.getByRole('button', { name: /Extrato bancário/i }).click();
  await page
    .locator('[data-mobile-sheet="modal"]', { hasText: 'Para qual conta é esse extrato?' })
    .getByRole('button', { name: 'Importar para Carteira' })
    .click();
  await expect(page.getByRole('dialog', { name: 'Importar sem conta' })).toBeVisible();

  const dialog = page.getByRole('dialog');
  await dialog.locator('input[type="file"]').setInputFiles({
    name: 'extrato.csv', mimeType: 'text/csv',
    buffer: Buffer.from('data,desc,valor\n2026-09-01,Mercado,50.00\n2026-09-02,Farmacia,30.00'),
  });
  await dialog.getByRole('button', { name: 'Conferir arquivos' }).click();
  await expect(dialog.getByText(/Conferência:/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Confirmar importação' }).click();
  await expect(dialog.getByText('Importação concluída!')).toBeVisible();
  await dialog.getByRole('button', { name: 'Concluir' }).click();

  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Para qual conta é esse extrato?')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Importar para Carteira' })).toHaveCount(0);
  // No page child left inert after teardown.
  const stillInert = await page.evaluate(() =>
    Array.from(document.body.children).filter((el) => el.hasAttribute('inert')).length);
  expect(stillInert).toBe(0);
  expect(await page.evaluate(() => document.activeElement?.isConnected ?? false)).toBe(true);
  // F3 follow-up: no Concluir o foco volta ao gatilho "Lançar" que abriu o
  // fluxo — nunca fica preso no <body> (o picker <Modal> já desmontou, então o
  // restore interno do importer só tinha o <body> para devolver).
  const activeInfo = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    const name = ((el?.textContent ?? '') + ' ' + (el?.getAttribute('aria-label') ?? '')).trim();
    return {
      isBody: el === document.body,
      returnedToOpener: (el?.hasAttribute('data-e659-opener') ?? false) || name === 'Lançar',
      name,
    };
  });
  expect(activeInfo, JSON.stringify(activeInfo)).toMatchObject({ isBody: false, returnedToOpener: true });
});

test('375px (mobile project only): same isolation guarantees', async ({ page, baseURL }, testInfo) => {
  test.skip(!isMobile(testInfo), 'narrow-width variant runs on the mobile project');
  await page.setViewportSize({ width: 375, height: 800 });
  await mockApi(page, baseURL!);
  await openCarteira(page, true);
  await expect(page.getByText('Para qual conta é esse extrato?')).toHaveCount(0);
  expect(await nonInertCount(page, 'Fechar')).toBe(1);
  expect(await nonInertCount(page, 'Nova conta')).toBe(0);
});

test('existing-account path unchanged: picker lists accounts, no Carteira CTA', async ({ page, baseURL }, testInfo) => {
  const mobile = isMobile(testInfo);
  await mockApi(page, baseURL!, [
    { id: 'a1', nickname: 'Itaú', last4: '1234' },
    { id: 'a2', nickname: 'Nubank', last4: '5678' },
  ]);
  const picker = await openPicker(page, mobile);
  await expect(picker.getByRole('button', { name: /Itaú/i })).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Importar para Carteira' })).toHaveCount(0);
});
