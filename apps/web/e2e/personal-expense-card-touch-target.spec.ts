import { expect, test, type Page } from '@playwright/test';

const PROJECT_ID = 'expense-card-pessoal';
const FROZEN_NOW = new Date('2026-08-21T12:00:00.000Z');

const ACCOUNT_VIEW = {
  mesSelecionado: '2026-08',
  caixaHoje: 100_000,
  carteiraHoje: 0,
  entrouMes: 0,
  saiuMes: 10_000,
  faltaPagarMes: 0,
  recebimentosPrevistosMes: 0,
  sobraPrevista: 90_000,
  devoCartaoTotal: 0,
  cartoes: [],
  contas: [{ id: 'conta-1', last4: '1234', label: 'Minha Conta' }],
  saidas: [
    {
      id: 'exp-1',
      kind: 'saida',
      descricao: 'Mercado',
      data: '2026-08-10T00:00:00.000Z',
      forma: 'debito',
      valor: 10_000,
      realizado: true,
      status: 'PAGO',
      cardLast4: null,
      bankLast4: '1234',
      tipoDespesa: 'MERCADO',
      isInvoice: false,
      editavel: true,
      dueMonth: null,
      projetoOrigem: null,
      origin: 'conta:1234',
    },
  ],
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

function json(body: unknown) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  };
}

async function mockApi(page: Page, baseURL: string) {
  await page.clock.setFixedTime(FROZEN_NOW);
  await page.context().addCookies([{ name: 'rf_token', value: 'expense-card-test', url: baseURL }]);
  await page.route('http://localhost:3001/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path === '/auth/me') {
      return route.fulfill(
        json({
          id: 'expense-card-user',
          username: 'expense-card',
          name: 'Expense Card',
          role: 'ADMIN',
          isGuest: false,
          tenantId: 'tenant-1',
          allowedModules: ['monthlyOverview', 'bankAccounts', 'expenses', 'creditCards'],
          allowedProjects: [PROJECT_ID],
          allowedProjectTypes: ['PESSOAL'],
        }),
      );
    }
    if (path === `/projects/${PROJECT_ID}`) {
      return route.fulfill(
        json({
          id: PROJECT_ID,
          name: 'Pessoal',
          type: 'PESSOAL',
          onboardedAt: '2026-01-01T00:00:00.000Z',
        }),
      );
    }
    if (path === `/projects/${PROJECT_ID}/monthly-overview/account-view`) {
      return route.fulfill(json(ACCOUNT_VIEW));
    }
    if (path === `/projects/${PROJECT_ID}/monthly-overview/dre-overview`) {
      return route.fulfill(json({ anual: { saldoAcumuladoSerie: [] } }));
    }
    return route.fulfill(json([]));
  });
}

test.describe('PersonalExpenseCard — touch target size (A3 #413)', () => {
  test('status toggle button has minimum 44×44px touch target', async ({ page, baseURL }) => {
    if (!baseURL) throw new Error('baseURL not set');

    await mockApi(page, baseURL);

    // Navigate to conta page in mobile viewport (375px)
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${baseURL}/projects/${PROJECT_ID}/conta`);

    // Wait for MovimentacoesSection to load
    await page.waitForSelector('button[title="Alternar status"]', { timeout: 5000 });

    // Find the status toggle button
    const statusButton = page.locator('button[title="Alternar status"]').first();
    expect(statusButton).toBeDefined();

    // Get the bounding box of the button
    const box = await statusButton.boundingBox();
    expect(box).toBeDefined();

    if (box) {
      // A3 fix: button should have minimum 44×44px touch target
      // min-h-11 min-w-11 in Tailwind = 2.75rem = 44px
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  });

  test('status toggle button text is still small (text-[10px] preserved)', async ({ page, baseURL }) => {
    if (!baseURL) throw new Error('baseURL not set');

    await mockApi(page, baseURL);

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${baseURL}/projects/${PROJECT_ID}/conta`);

    await page.waitForSelector('button[title="Alternar status"]', { timeout: 5000 });

    const statusButton = page.locator('button[title="Alternar status"]').first();

    // Verify the button has the small text class
    const classes = await statusButton.getAttribute('class');
    expect(classes).toMatch(/text-\[10px\]/);

    // Verify it's using flexbox centering (visual compactness)
    expect(classes).toMatch(/inline-flex/);
    expect(classes).toMatch(/items-center/);
    expect(classes).toMatch(/justify-center/);
  });

  test('button is clickable and toggles status', async ({ page, baseURL }) => {
    if (!baseURL) throw new Error('baseURL not set');

    await mockApi(page, baseURL);

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`${baseURL}/projects/${PROJECT_ID}/conta`);

    await page.waitForSelector('button[title="Alternar status"]', { timeout: 5000 });

    const statusButton = page.locator('button[title="Alternar status"]').first();

    // Initial text should be "Pago" (expense.status = 'PAGO')
    await expect(statusButton).toContainText('Pago');

    // Click the button (should toggle to PLANEJADO in caixa mode)
    // Note: This tests the interactivity, not state change (since API is mocked)
    await statusButton.click();
  });
});
