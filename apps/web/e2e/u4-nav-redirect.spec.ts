import { expect, test, type Page } from '@playwright/test';

/**
 * U4 (issue #453) — redirect das 4 rotas colapsadas para o hub `/conta`.
 *
 * Três casos por rota colapsada:
 *   1. Sem módulo da página → /no-permission
 *   2. Com módulo + monthlyOverview → /conta (redirect ao hub)
 *   3. Com módulo, sem monthlyOverview → renderiza a página legada
 *
 * REFORMA/CASA/CARRO: a navegação deles NÃO regride.
 */

const PESSOAL_ID = 'u4-pessoal';
const REFORMA_ID = 'u4-reforma';
const CASA_ID = 'u4-casa';
const CARRO_ID = 'u4-carro';

function json(body: unknown) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) };
}

const ALL_MODULES = [
  'monthlyOverview', 'expenses', 'receipts', 'cashFlow',
  'creditCards', 'bankAccounts', 'dashboard', 'schedule',
  'pendencias', 'floorPlans', 'simulation', 'priceCompare',
  'recurringBills', 'financing', 'maintenance', 'reminders',
  'carInfo', 'vehicleDocuments',
];

async function mockApi(
  page: Page,
  baseURL: string,
  opts: { role?: string; modules?: string[] } = {},
) {
  const role = opts.role ?? 'ADMIN';
  const modules = opts.modules ?? ALL_MODULES;
  await page.context().addCookies([{ name: 'rf_token', value: 'u4-test', url: baseURL }]);
  await page.route('http://localhost:3001/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/auth/me') {
      return route.fulfill(json({
        id: 'u4-user',
        username: 'u4-test',
        name: 'U4',
        role,
        isGuest: false,
        tenantId: 'u4-tenant',
        allowedModules: [...modules],
        allowedProjects: [PESSOAL_ID, REFORMA_ID, CASA_ID, CARRO_ID],
        allowedProjectTypes: ['PESSOAL', 'REFORMA', 'CASA', 'CARRO'],
      }));
    }
    if (path === `/projects/${PESSOAL_ID}`) {
      return route.fulfill(json({ id: PESSOAL_ID, name: 'Pessoal', type: 'PESSOAL', onboardedAt: '2026-01-01T00:00:00.000Z' }));
    }
    if (path === `/projects/${REFORMA_ID}`) {
      return route.fulfill(json({ id: REFORMA_ID, name: 'Reforma', type: 'REFORMA', onboardedAt: '2026-01-01T00:00:00.000Z' }));
    }
    if (path === `/projects/${CASA_ID}`) {
      return route.fulfill(json({ id: CASA_ID, name: 'Casa', type: 'CASA', onboardedAt: '2026-01-01T00:00:00.000Z' }));
    }
    if (path === `/projects/${CARRO_ID}`) {
      return route.fulfill(json({ id: CARRO_ID, name: 'Carro', type: 'CARRO', onboardedAt: '2026-01-01T00:00:00.000Z' }));
    }
    return route.fulfill(json([]));
  });
}

/** slug → módulo que autoriza a página */
const SLUG_MODULE: Record<string, string> = {
  expenses: 'expenses',
  receipts: 'receipts',
  'credit-cards': 'creditCards',
  'bank-accounts': 'bankAccounts',
};

// ─── CASO 2: com módulo + monthlyOverview → /conta ─────────────────────────
test.describe('U4-10 caso 2: PESSOAL rotas colapsadas → /conta (ADMIN)', () => {
  for (const slug of ['expenses', 'receipts', 'credit-cards', 'bank-accounts']) {
    test(`/${slug} → /conta`, async ({ page, baseURL }) => {
      await mockApi(page, baseURL!);
      await page.goto(`/projects/${PESSOAL_ID}/${slug}`);
      await expect(page).toHaveURL(new RegExp(`/projects/${PESSOAL_ID}/conta`), { timeout: 10_000 });
      await expect(page.locator('body')).not.toHaveText(/404/);
    });
  }
});

// ─── CASO 1: sem módulo da página → /no-permission ─────────────────────────
test.describe('U4-10 caso 1: sem módulo → /no-permission', () => {
  for (const slug of ['bank-accounts', 'expenses']) {
    test(`/${slug} sem ${SLUG_MODULE[slug]} → /no-permission`, async ({ page, baseURL }) => {
      // USER com monthlyOverview mas SEM o módulo da página
      const modules = ALL_MODULES.filter((m) => m !== SLUG_MODULE[slug]);
      await mockApi(page, baseURL!, { role: 'USER', modules });
      await page.goto(`/projects/${PESSOAL_ID}/${slug}`);
      await expect(page).toHaveURL(/\/no-permission/, { timeout: 10_000 });
    });
  }
});

// ─── CASO 3: com módulo, sem monthlyOverview → renderiza legada ─────────────
test.describe('U4-10 caso 3: com módulo, sem monthlyOverview → página legada', () => {
  for (const [slug, contentMarker] of [
    ['bank-accounts', 'Nenhuma conta cadastrada'],
    ['credit-cards', 'Cartões de Crédito'],
  ] as const) {
    test(`/${slug} sem monthlyOverview renderiza a página`, async ({ page, baseURL }) => {
      const modules = ALL_MODULES.filter((m) => m !== 'monthlyOverview');
      await mockApi(page, baseURL!, { role: 'USER', modules });
      await page.goto(`/projects/${PESSOAL_ID}/${slug}`);
      // Deve ficar na rota, não redirecionar
      await page.waitForTimeout(2000);
      await expect(page).toHaveURL(new RegExp(`/projects/${PESSOAL_ID}/${slug}`));
      // Renderiza conteúdo da página (não 404, não /no-permission, não /conta)
      await expect(page.getByText(contentMarker, { exact: false }).first()).toBeVisible({ timeout: 10_000 });
    });
  }
});

// ─── NÃO-REGRESSÃO ─────────────────────────────────────────────────────────
test.describe('U4-10b não-regressão: REFORMA/CASA/CARRO mantêm navegação', () => {
  test('REFORMA /expenses NÃO redireciona', async ({ page, baseURL }) => {
    await mockApi(page, baseURL!);
    await page.goto(`/projects/${REFORMA_ID}/expenses`);
    await page.waitForTimeout(2000);
    await expect(page).toHaveURL(new RegExp(`/projects/${REFORMA_ID}/expenses`));
  });

  test('CASA /expenses redireciona para /bills (pré-existente)', async ({ page, baseURL }) => {
    await mockApi(page, baseURL!);
    await page.goto(`/projects/${CASA_ID}/expenses`);
    await expect(page).toHaveURL(new RegExp(`/projects/${CASA_ID}/bills`), { timeout: 10_000 });
  });

  test('CARRO /expenses redireciona para /bills (pré-existente)', async ({ page, baseURL }) => {
    await mockApi(page, baseURL!);
    await page.goto(`/projects/${CARRO_ID}/expenses`);
    await expect(page).toHaveURL(new RegExp(`/projects/${CARRO_ID}/bills`), { timeout: 10_000 });
  });
});
