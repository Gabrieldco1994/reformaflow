import { expect, test, type Page } from '@playwright/test';

/**
 * #659 — RED spec (design phase). Real journey: PESSOAL project with zero bank
 * accounts, launcher exposes "Importar para Carteira" reachably. Modeled on
 * `w5-empty-states-multitype.spec.ts` (route-mock pattern, `rf_token` cookie +
 * `/auth/me`, `page.clock.setFixedTime` before `goto` per golden rule #22).
 * Runs desktop (1280) and mobile (375/390) — desktop uses `NovaDespesaLauncher`
 * via `/conta`, mobile uses `MobileLaunchSheetContainer` via the "+" tab.
 */

const PESSOAL_ID = 'e659-pessoal';
const FIXED_TIME = new Date('2026-09-02T12:00:00.000Z');

function json(body: unknown) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) };
}

const ALL_MODULES = [
  'monthlyOverview', 'expenses', 'receipts', 'cashFlow',
  'creditCards', 'bankAccounts', 'dashboard', 'schedule',
  'pendencias', 'floorPlans', 'simulation', 'priceCompare',
  'recurringBills', 'financing', 'maintenance', 'reminders',
  'carInfo', 'vehicleDocuments', 'recurrences',
];

const ACCOUNT_VIEW = {
  mesSelecionado: '2026-09', caixaHoje: 0, carteiraHoje: 0, entrouMes: 0, saiuMes: 0,
  faltaPagarMes: 0, saidaTotal: 0, recebimentosPrevistosMes: 0, sobraPrevista: 0,
  devoCartaoTotal: 0, cartoes: [], contas: [], saidas: [], comprasCartao: [], entradas: [],
  ticketMedio: { valor: 0, nCompras: 0, totalCompras: 0, serie6m: [], media6m: 0, deltaVsMediaPct: null },
};

async function mockApi(page: Page, baseURL: string) {
  await page.context().addCookies([{ name: 'rf_token', value: 'e659-test', url: baseURL }]);
  await page.route('http://localhost:3001/**', async (route) => {
    const path = new URL(route.request().url()).pathname;

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
    // Zero contas — a rota-alvo do cenário.
    if (path === '/tenant/bank-accounts' || /\/bank-accounts$/.test(path)) {
      return route.fulfill(json([]));
    }
    if (path === '/tenant/credit-cards' || /\/credit-cards$/.test(path)) {
      return route.fulfill(json([]));
    }
    if (/^\/projects\/[^/]+\/expenses$/.test(path)) {
      return route.fulfill(json({ items: [], total: 0, page: 1, pageSize: 2000, totalPages: 0 }));
    }
    if (/^\/projects\/[^/]+\/expenses\/paid-origins$/.test(path)) {
      return route.fulfill(json({ items: [] }));
    }
    if (path.endsWith('/monthly-overview/account-view')) {
      return route.fulfill(json(ACCOUNT_VIEW));
    }
    if (path.endsWith('/monthly-overview/dre-overview')) {
      return route.fulfill(json({ anual: { saldoAcumuladoSerie: [] } }));
    }
    if (path.endsWith('/monthly-overview/origin-items-yearly')) {
      return route.fulfill(json({ year: 2026, kind: 'all', last4: '', total: 0, items: [] }));
    }
    if (path === '/journeys/eligible') {
      return route.fulfill(json([]));
    }
    if (path.endsWith('/receipts/import')) {
      const url = new URL(route.request().url());
      if (url.searchParams.get('mode') === 'preview') {
        return route.fulfill(json({
          total: 1, totalAmountCents: 5000, duplicated: 0,
          rows: [{ externalId: 'e659-1', date: '2026-09-01', description: 'Mercado', amountCents: 5000, type: 'DESPESA', status: 'EM_CAIXA' }],
        }));
      }
      return route.fulfill(json({ inserted: 1, failed: 0 }));
    }
    return route.fulfill(json([]));
  });
}

function trap403(page: Page, hits: string[]) {
  page.on('response', (res) => {
    if (res.status() === 403) hits.push(res.url());
  });
}

async function assertTouchTarget44(locator: import('@playwright/test').Locator, name: string | RegExp) {
  const box = await locator.boundingBox();
  expect(box, `sem bounding box para "${name}"`).not.toBeNull();
  expect(box!.height).toBeGreaterThanOrEqual(44);
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_TIME);
});

test.describe('#659 · Desktop 1280 — Carteira alcançável via NovaDespesaLauncher', () => {
  test('zero contas → "Importar para Carteira" antes de "Nova conta", abre com extrato pré-selecionado, cancela sem loop, comita até Concluir', async ({ page, baseURL }) => {
    const hits: string[] = [];
    trap403(page, hits);
    await mockApi(page, baseURL!);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/projects/${PESSOAL_ID}/conta`);

    await page.getByRole('button', { name: 'Lançar', exact: true }).first().click();
    await page.getByRole('button', { name: /Extrato bancário/i }).click();

    const picker = page.locator('[data-mobile-sheet="modal"]', { hasText: 'Para qual conta é esse extrato?' });
    const importarBtn = picker.getByRole('button', { name: 'Importar para Carteira' });
    const novaContaBtn = picker.getByRole('button', { name: 'Nova conta' });
    await expect(importarBtn).toBeVisible();
    await expect(novaContaBtn).toBeVisible();
    await assertTouchTarget44(importarBtn, 'Importar para Carteira');

    await importarBtn.click();
    const dialog = page.getByRole('dialog', { name: 'Importar sem conta' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Extrato bancário', exact: true })).toHaveAttribute('aria-pressed', 'true');

    // cancelar → volta ao picker, sem segundo modal
    await dialog.getByRole('button', { name: 'Fechar' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(importarBtn).toBeVisible();

    // reabrir e comitar um fixture mínimo
    await importarBtn.click();
    const dialog2 = page.getByRole('dialog');
    await dialog2.locator('input[type="file"]').setInputFiles({
      name: 'extrato.csv', mimeType: 'text/csv', buffer: Buffer.from('data,desc,valor\n2026-09-01,Mercado,50.00'),
    });
    await dialog2.getByRole('button', { name: 'Conferir arquivos' }).click();
    await expect(dialog2.getByText(/Conferência:/)).toBeVisible();
    await dialog2.getByRole('button', { name: 'Confirmar importação' }).click();
    // O título do dialog muda para "Importação concluída!" na tela de sucesso
    // (mesmo h2/titleId), então a busca do dialog não pode mais filtrar por
    // name — só o conteúdo interno é reafirmado a partir daqui.
    await expect(dialog2.getByText('Importação concluída!')).toBeVisible();

    // sucesso NÃO deve auto-fechar — segue visível
    await page.waitForTimeout(2000);
    await expect(dialog2.getByText('Importação concluída!')).toBeVisible();
    await dialog2.getByRole('button', { name: 'Concluir' }).click();
    await expect(dialog2).toHaveCount(0);

    expect(hits, `403 inesperado: ${hits.join(', ')}`).toEqual([]);
  });
});

for (const width of [375, 390]) {
  test.describe(`#659 · Mobile ${width} — Carteira alcançável via MobileLaunchSheetContainer`, () => {
    test(`zero contas → "Importar para Carteira" antes de "Nova conta" (${width}px)`, async ({ page, baseURL }) => {
      const hits: string[] = [];
      trap403(page, hits);
      await mockApi(page, baseURL!);
      await page.setViewportSize({ width, height: 812 });
      await page.goto(`/projects/${PESSOAL_ID}/conta`);

      await page.getByRole('button', { name: 'Lançar', exact: true }).first().click();
      await page.getByRole('button', { name: /Fatura \/ Extrato/i }).click();
      await page.getByRole('button', { name: /Extrato bancário/i }).click();

      const picker = page.locator('[data-mobile-sheet="modal"]', { hasText: 'Para qual conta é esse extrato?' });
      const importarBtn = picker.getByRole('button', { name: 'Importar para Carteira' });
      const novaContaBtn = picker.getByRole('button', { name: 'Nova conta' });
      await expect(importarBtn).toBeVisible();
      await expect(novaContaBtn).toBeVisible();
      await assertTouchTarget44(importarBtn, 'Importar para Carteira');
      await assertTouchTarget44(novaContaBtn, 'Nova conta');

      expect(hits, `403 inesperado: ${hits.join(', ')}`).toEqual([]);
    });
  });
}
