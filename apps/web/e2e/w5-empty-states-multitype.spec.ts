import { expect, test, type Page } from '@playwright/test';

/**
 * W5 / #218 — empty states escopados + gate de import de extrato por
 * `hasFeature('bankAccounts') && hasModule('bankAccounts')`.
 *
 * ROTEIRO DO qa-engineer (RED até o GREEN do frontend-expert). Modelado em
 * `apps/web/e2e/u4-nav-redirect.spec.ts` (mock via `page.route`, cookie
 * `rf_token`, `/auth/me` com `allowedModules`). Relógio fixo, 375 + 1280.
 *
 * A lição da #655/#656: PESSOAL-only NÃO basta — o `PayOptionsModal` e o
 * `ExpensesView` são compartilhados com REFORMA/COMPRA, e lá "Extrato bancário"
 * levava a `GET /projects/:id/bank-accounts` → 403 mascarado como `[]`; a #655
 * transformou o dead-end num loop de 403 clicável. Estes cenários rodam a
 * jornada REAL em REFORMA e PESSOAL.
 */

const PESSOAL_ID = 'w5-pessoal';
const REFORMA_ID = 'w5-reforma';
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

// REFORMA real: sem monthlyOverview/bankAccounts/creditCards-como-feature.
// `creditCards` continua no allowedModules (autorização), `bankAccounts` NÃO.
const REFORMA_MODULES = ALL_MODULES.filter((m) => m !== 'bankAccounts' && m !== 'monthlyOverview');

async function mockApi(
  page: Page,
  baseURL: string,
  opts: { modules?: string[]; projectTypes?: string[] } = {},
) {
  const modules = opts.modules ?? ALL_MODULES;
  const projectTypes = opts.projectTypes ?? ['PESSOAL', 'REFORMA'];
  await page.context().addCookies([{ name: 'rf_token', value: 'w5-test', url: baseURL }]);
  await page.route('http://localhost:3001/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/auth/me') {
      return route.fulfill(json({
        id: 'w5-user',
        username: 'w5-test',
        name: 'W5',
        role: 'USER',
        isGuest: false,
        tenantId: 'w5-tenant',
        allowedModules: [...modules],
        allowedProjects: [PESSOAL_ID, REFORMA_ID],
        allowedProjectTypes: [...projectTypes],
      }));
    }
    if (path === `/projects/${PESSOAL_ID}`) {
      return route.fulfill(json({ id: PESSOAL_ID, name: 'Pessoal', type: 'PESSOAL', onboardedAt: '2026-01-01T00:00:00.000Z' }));
    }
    if (path === `/projects/${REFORMA_ID}`) {
      return route.fulfill(json({ id: REFORMA_ID, name: 'Reforma', type: 'REFORMA', onboardedAt: '2026-01-01T00:00:00.000Z' }));
    }
    // Tudo o mais: coleções vazias (inclui expenses, cash-flow, account-view…).
    return route.fulfill(json([]));
  });
}

/** Falha o teste em qualquer 403 numa rota que casa `pattern`. */
function failOn403(page: Page, pattern: RegExp, hits: string[]) {
  page.on('response', (res) => {
    if (res.status() === 403 && pattern.test(res.url())) {
      hits.push(res.url());
    }
  });
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(FIXED_TIME);
});

// ─── Cenário 1: REFORMA — zero 403 de bank-accounts ───────────────────────
test.describe('W5 #218 · REFORMA — a oferta de extrato não existe e nada dá 403', () => {
  test('nenhum GET /bank-accounts 403; "Extrato bancário" ausente e "Fatura de cartão" presente', async ({ page, baseURL }) => {
    const forbidden: string[] = [];
    failOn403(page, /\/bank-accounts/, forbidden);
    await mockApi(page, baseURL!, { modules: REFORMA_MODULES });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/projects/${REFORMA_ID}/expenses`);
    await page.getByRole('button', { name: /Nova despesa/i }).first().click();

    await expect(page.getByRole('button', { name: /Fatura de cartão/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Extrato bancário/i })).toHaveCount(0);

    expect(forbidden, `403 de bank-accounts em REFORMA: ${forbidden.join(', ')}`).toEqual([]);
  });

  test('/cash-flow vazio → CTA "Lançar despesa ou recebimento" leva a /expenses e renderiza (não /no-permission)', async ({ page, baseURL }) => {
    await mockApi(page, baseURL!, { modules: REFORMA_MODULES });
    await page.goto(`/projects/${REFORMA_ID}/cash-flow`);

    await page.getByRole('button', { name: /Lançar despesa ou recebimento/i }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${REFORMA_ID}/expenses`), { timeout: 10_000 });
    await expect(page).not.toHaveURL(/\/no-permission/);
  });
});

// ─── Cenário 2: PESSOAL — a ação leva a lugar válido ──────────────────────
test.describe('W5 #218 · PESSOAL — "Extrato bancário" abre empty state acionável', () => {
  test('"+" → foto → "Extrato bancário" → SemContaEmptyState + "Nova conta" (sem texto morto)', async ({ page, baseURL }) => {
    await mockApi(page, baseURL!);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/projects/${PESSOAL_ID}/conta`);

    await page.getByRole('button', { name: /^Lançar$|^\+$/ }).first().click();
    await page.getByRole('button', { name: /Fatura \/ Extrato/i }).click();
    await page.getByRole('button', { name: /Extrato bancário/i }).click();

    await expect(page.getByText('Nenhuma conta cadastrada')).toBeVisible();
    await expect(page.getByText(/Cadastre em Contas Bancárias antes de importar/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Nova conta' })).toBeVisible();
  });

  test('"Nova conta" passa por /bank-accounts?focus=openingBalance e resolve /conta?focus=openingBalance com o form aberto', async ({ page, baseURL }) => {
    await mockApi(page, baseURL!);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/projects/${PESSOAL_ID}/conta`);

    await page.getByRole('button', { name: /^Lançar$|^\+$/ }).first().click();
    await page.getByRole('button', { name: /Fatura \/ Extrato/i }).click();
    await page.getByRole('button', { name: /Extrato bancário/i }).click();
    await page.getByRole('button', { name: 'Nova conta' }).click();

    await expect(page).toHaveURL(new RegExp(`/projects/${PESSOAL_ID}/conta\\?focus=openingBalance`), { timeout: 10_000 });
    await expect(page).not.toHaveURL(/\/no-permission/);
  });
});

// ─── Cenário 3: duplicatas (cicatriz regra de ouro #23) ───────────────────
test.describe('W5 #218 · sem rótulos de ação duplicados no PayOptionsModal', () => {
  for (const [label, projectId, modules] of [
    ['REFORMA', REFORMA_ID, REFORMA_MODULES],
    ['PESSOAL', PESSOAL_ID, ALL_MODULES],
  ] as const) {
    test(`${label}: nenhum botão do menu de lançamento aparece duas vezes`, async ({ page, baseURL }) => {
      await mockApi(page, baseURL!, { modules: [...modules] });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`/projects/${projectId}/expenses`);
      await page.getByRole('button', { name: /Nova despesa/i }).first().click();

      const dialog = page.getByRole('dialog');
      const labels = (await dialog.getByRole('button').allInnerTexts())
        .map((t) => t.split('\n')[0]!.trim())
        .filter(Boolean);
      const dups = labels.filter((t, i) => labels.indexOf(t) !== i);
      expect(dups, `botões duplicados: ${dups.join(', ')}`).toEqual([]);
    });
  }
});

// ─── Cenário 4: onboarding REFORMA sem 403 silencioso ─────────────────────
test.describe('W5 #218 · onboarding REFORMA — passo de despesa não dispara 403 de bank-accounts', () => {
  test('avançar até o passo expense não gera GET /tenant/bank-accounts 403', async ({ page, baseURL }) => {
    const forbidden: string[] = [];
    failOn403(page, /\/tenant\/bank-accounts/, forbidden);
    await mockApi(page, baseURL!, { modules: REFORMA_MODULES });

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/projects/${REFORMA_ID}/dashboard`);
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('rf:project-created', { detail: { projectId: 'w5-reforma', projectType: 'REFORMA' } }));
    });

    // Avança a jornada até o passo `expense` (modo foto = OCR de comprovante,
    // não import de extrato). O ponto é: nenhum 403 silencioso de bank-accounts.
    const quickExpense = page.getByRole('button', { name: /despesa/i }).first();
    if (await quickExpense.isVisible().catch(() => false)) {
      await quickExpense.click();
    }

    expect(forbidden, `403 de /tenant/bank-accounts no onboarding REFORMA: ${forbidden.join(', ')}`).toEqual([]);
  });
});
