import { expect, test, type Page } from '@playwright/test';

/**
 * U4 (issue #453) — redirect das 4 rotas colapsadas para o hub `/conta`.
 *
 * PESSOAL: `/expenses`, `/receipts`, `/credit-cards`, `/bank-accounts`
 * deixaram de ser rotas de nav e redirecionam para `/conta`.
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

async function mockApi(
  page: Page,
  baseURL: string,
) {
  await page.context().addCookies([{ name: 'rf_token', value: 'u4-test', url: baseURL }]);
  await page.route('http://localhost:3001/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/auth/me') {
      return route.fulfill(json({
        id: 'u4-user',
        username: 'u4-test',
        name: 'U4',
        role: 'ADMIN',
        isGuest: false,
        tenantId: 'u4-tenant',
        allowedModules: [
          'monthlyOverview', 'expenses', 'receipts', 'cashFlow',
          'creditCards', 'bankAccounts', 'dashboard', 'schedule',
          'pendencias', 'floorPlans', 'simulation', 'priceCompare',
          'recurringBills', 'financing', 'maintenance', 'reminders',
          'carInfo', 'vehicleDocuments',
        ],
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

test.describe('U4-10 PESSOAL: rotas colapsadas redirecionam para /conta', () => {
  for (const slug of ['expenses', 'receipts', 'credit-cards', 'bank-accounts']) {
    test(`/${slug} → /conta`, async ({ page, baseURL }) => {
      await mockApi(page, baseURL!);
      await page.goto(`/projects/${PESSOAL_ID}/${slug}`);
      await expect(page).toHaveURL(new RegExp(`/projects/${PESSOAL_ID}/conta`), { timeout: 10_000 });
      // Not a 404: page has content
      await expect(page.locator('body')).not.toHaveText(/404/);
    });
  }
});

test.describe('U4-10b não-regressão: REFORMA/CASA/CARRO mantêm navegação', () => {
  test('REFORMA /expenses NÃO redireciona', async ({ page, baseURL }) => {
    await mockApi(page, baseURL!);
    await page.goto(`/projects/${REFORMA_ID}/expenses`);
    // Should stay on expenses, not redirect
    await page.waitForTimeout(2000);
    await expect(page).toHaveURL(new RegExp(`/projects/${REFORMA_ID}/expenses`));
  });

  test('CASA /expenses redireciona para /bills (comportamento pré-existente, não /conta)', async ({ page, baseURL }) => {
    await mockApi(page, baseURL!);
    await page.goto(`/projects/${CASA_ID}/expenses`);
    await expect(page).toHaveURL(new RegExp(`/projects/${CASA_ID}/bills`), { timeout: 10_000 });
  });

  test('CARRO /expenses redireciona para /bills (comportamento pré-existente, não /conta)', async ({ page, baseURL }) => {
    await mockApi(page, baseURL!);
    await page.goto(`/projects/${CARRO_ID}/expenses`);
    await expect(page).toHaveURL(new RegExp(`/projects/${CARRO_ID}/bills`), { timeout: 10_000 });
  });
});
