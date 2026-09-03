import { expect, test, type Page } from '@playwright/test';

/**
 * W5 / #218 — empty states escopados + gate de import de extrato por
 * `hasFeature('bankAccounts') && hasModule('bankAccounts')`.
 *
 * Modelado nos e2e vizinhos que RENDERIZAM `ExpensesView`/`/conta`
 * (`expenses-mobile.spec.ts`, `conta-bank-management.spec.ts`): mock via
 * `page.route`, cookie `rf_token`, `/auth/me` com `allowedModules`, e as FORMAS
 * de resposta reais (`/expenses` → `ExpensesPage`, `account-view` → objeto…
 * — o catch-all `[]` derrubava o `ExpensesView` no `buildPaidOriginIndex`).
 *
 * O mock ESPELHA o `ModulesGuard`: qualquer rota de bank-accounts responde 403
 * quando o usuário não tem `bankAccounts` em `allowedModules` — o 403 real que a
 * #655 mascarava. Assim os cenários 1 e 4 são regressões de verdade: se o gate
 * quebrar, o front dispara a chamada e o 403 falha o teste.
 *
 * Relógio fixo. A spec controla as próprias larguras → roda só no projeto
 * `desktop` (padrão do repo).
 */

const PESSOAL_ID = 'w5-pessoal';
const REFORMA_ID = 'w5-reforma';
const FIXED_TIME = new Date('2026-09-02T12:00:00.000Z');

function json(body: unknown) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) };
}
function forbidden() {
  return { status: 403, contentType: 'application/json', body: JSON.stringify({ statusCode: 403, message: 'Forbidden' }) };
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

const EXPENSES_PAGE = { items: [], total: 0, page: 1, pageSize: 2000, totalPages: 0 };

const ACCOUNT_VIEW = {
  mesSelecionado: '2026-09',
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
  ticketMedio: { valor: 0, nCompras: 0, totalCompras: 0, serie6m: [], media6m: 0, deltaVsMediaPct: null },
};

async function mockApi(
  page: Page,
  baseURL: string,
  opts: { modules?: string[]; projectTypes?: string[] } = {},
) {
  const modules = opts.modules ?? ALL_MODULES;
  const projectTypes = opts.projectTypes ?? ['PESSOAL', 'REFORMA'];
  const canBank = modules.includes('bankAccounts');
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

    // ─── ModulesGuard: 403 real de bank-accounts sem o módulo ──────────────
    if (path === '/tenant/bank-accounts' || /\/bank-accounts(\/.*)?$/.test(path)) {
      return canBank ? route.fulfill(json([])) : route.fulfill(forbidden());
    }

    // ─── Formas que o catch-all `[]` quebrava ─────────────────────────────
    if (/^\/projects\/[^/]+\/expenses$/.test(path)) {
      return route.fulfill(json(EXPENSES_PAGE));
    }
    // `buildPaidOriginIndex` itera `response.items` — `[]` → estouro/ErrorBoundary.
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
      return route.fulfill(json([])); // cenário 4 sobrescreve com `**/journeys/eligible*`
    }

    // Tudo o mais: coleções vazias.
    return route.fulfill(json([]));
  });
}

/** Registra qualquer 403 numa rota que casa `pattern`. */
function trap403(page: Page, pattern: RegExp, hits: string[]) {
  page.on('response', (res) => {
    if (res.status() === 403 && pattern.test(res.url())) hits.push(res.url());
  });
}

/** Localiza o modal de `@/components/ui/modal` (sem `role=dialog`) pelo título. */
function uiModal(page: Page, title: string) {
  return page.locator('[data-mobile-sheet="modal"]').filter({ hasText: title });
}

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'a spec controla as próprias larguras');
  await page.clock.setFixedTime(FIXED_TIME);
});

// ─── Cenário 1: REFORMA — zero 403 de bank-accounts ───────────────────────
test.describe('W5 #218 · REFORMA — a oferta de extrato não existe e nada dá 403', () => {
  test('nenhum GET /bank-accounts 403; "Extrato bancário" ausente e "Fatura de cartão" presente', async ({ page, baseURL }) => {
    const hits: string[] = [];
    trap403(page, /\/bank-accounts/, hits);
    await mockApi(page, baseURL!, { modules: REFORMA_MODULES });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/projects/${REFORMA_ID}/expenses`);
    await page.getByRole('button', { name: 'Nova despesa', exact: true }).first().click();

    const modal = uiModal(page, 'Novo lançamento');
    await expect(modal.getByRole('button', { name: /Fatura de cartão/i })).toBeVisible();
    await expect(modal.getByRole('button', { name: /Extrato bancário/i })).toHaveCount(0);

    expect(hits, `403 de bank-accounts em REFORMA: ${hits.join(', ')}`).toEqual([]);
  });

  test('/cash-flow vazio → CTA "Lançar despesa ou recebimento" leva a /expenses e renderiza (não /no-permission)', async ({ page, baseURL }) => {
    await mockApi(page, baseURL!, { modules: REFORMA_MODULES });
    await page.setViewportSize({ width: 1280, height: 900 });
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

    await page.getByRole('button', { name: 'Lançar', exact: true }).first().click();
    await page.getByRole('button', { name: /Fatura \/ Extrato/i }).click();
    await page.getByRole('button', { name: /Extrato bancário/i }).click();

    const modal = uiModal(page, 'Para qual conta é esse extrato?');
    await expect(modal.getByText('Nenhuma conta cadastrada')).toBeVisible();
    await expect(modal.getByText(/Cadastre em Contas Bancárias antes de importar/)).toHaveCount(0);
    await expect(modal.getByRole('button', { name: 'Nova conta' })).toBeVisible();
  });

  test('"Nova conta" passa por /bank-accounts?focus=openingBalance e resolve /conta?focus=openingBalance', async ({ page, baseURL }) => {
    await mockApi(page, baseURL!);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(`/projects/${PESSOAL_ID}/conta`);

    await page.getByRole('button', { name: 'Lançar', exact: true }).first().click();
    await page.getByRole('button', { name: /Fatura \/ Extrato/i }).click();
    await page.getByRole('button', { name: /Extrato bancário/i }).click();
    await uiModal(page, 'Para qual conta é esse extrato?').getByRole('button', { name: 'Nova conta' }).click();

    await expect(page).toHaveURL(new RegExp(`/projects/${PESSOAL_ID}/conta\\?focus=openingBalance`), { timeout: 10_000 });
    await expect(page).not.toHaveURL(/\/no-permission/);
  });
});

// ─── Cenário 3: duplicatas (cicatriz regra de ouro #23) ───────────────────
test.describe('W5 #218 · sem rótulos de ação duplicados no PayOptionsModal', () => {
  test('REFORMA: nenhum botão do menu de lançamento aparece duas vezes', async ({ page, baseURL }) => {
    await mockApi(page, baseURL!, { modules: REFORMA_MODULES });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/projects/${REFORMA_ID}/expenses`);
    await page.getByRole('button', { name: 'Nova despesa', exact: true }).first().click();
    await expectNoDuplicateActionLabels(page);
  });

  test('PESSOAL: nenhum botão do menu de lançamento aparece duas vezes', async ({ page, baseURL }) => {
    await mockApi(page, baseURL!);
    // PESSOAL: `/expenses` redireciona ao hub; o PayOptionsModal vem do
    // `NovaDespesaLauncher` fiado no `/conta` (botão "Lançar" desktop).
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/projects/${PESSOAL_ID}/conta`);
    await page.getByRole('button', { name: 'Lançar', exact: true }).first().click();
    await expectNoDuplicateActionLabels(page);
  });
});

async function expectNoDuplicateActionLabels(page: Page) {
  const modal = uiModal(page, 'Novo lançamento');
  await expect(modal).toBeVisible();
  const labels = (await modal.getByRole('button').allInnerTexts())
    .map((t) => t.split('\n')[0]!.trim())
    .filter(Boolean);
  const dups = labels.filter((t, i) => labels.indexOf(t) !== i);
  expect(dups, `botões duplicados: ${dups.join(', ')}`).toEqual([]);
}

// ─── Cenário 4: onboarding REFORMA sem 403 silencioso ─────────────────────
test.describe('W5 #218 · onboarding REFORMA — passo de despesa não dispara 403 de bank-accounts', () => {
  test('painel da jornada no passo expense não gera GET /tenant/bank-accounts 403', async ({ page, baseURL }) => {
    const hits: string[] = [];
    trap403(page, /\/tenant\/bank-accounts/, hits);
    await mockApi(page, baseURL!, { modules: REFORMA_MODULES });

    // Jornada real: SCREEN_VISIT abre o painel no passo `expense`
    // (SUMMARY → `QuickExpenseStep`). Modo foto = OCR de comprovante, não import
    // de extrato — o ponto é: nenhum 403 silencioso de bank-accounts.
    await page.route('**/journeys/eligible*', (route) =>
      route.fulfill(json([
        {
          key: 'w5:onboarding-reforma',
          name: 'Onboarding REFORMA',
          active: true,
          targetScope: 'ALL_PROJECTS',
          targetProjectType: null,
          targetProjectId: null,
          repeatPolicy: 'ALWAYS',
          allowCrossProjectNavigation: false,
          steps: [
            {
              stepKey: 'expense',
              order: 0,
              enabled: true,
              skippable: true,
              experience: 'SUMMARY',
              label: 'Traga seus gastos',
              subtitle: null,
              conditionKey: null,
              conditionUnmetBehavior: 'SKIP',
              targetProjectType: null,
            },
          ],
          triggers: [
            { triggerType: 'SCREEN_VISIT', screenKey: 'expenses', actionKey: null, device: 'any', active: true },
          ],
        },
      ])),
    );
    await page.route('**/journeys/*/complete', (route) => route.fulfill({ status: 204, body: '' }));

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/projects/${REFORMA_ID}/expenses`);

    // Painel da jornada montado no passo `expense` (SUMMARY → QuickExpenseStep).
    await expect(page.locator('[data-journey-step="expense"]')).toBeVisible({ timeout: 15_000 });
    // Dá tempo de qualquer query do passo disparar (a de bank-accounts NÃO deve).
    await page.waitForTimeout(600);

    expect(hits, `403 de /tenant/bank-accounts no onboarding REFORMA: ${hits.join(', ')}`).toEqual([]);
  });
});

// ─── Cenário 5: ImportMassStep (stepKey `import`) SUMMARY em tipo != PESSOAL ──
// Exigência do review de #658: o passo de import em massa forçado em SUMMARY
// para um tipo NÃO-PESSOAL não pode disparar NENHUM GET /tenant/bank-accounts
// (a query é `enabled: canUseBankAccounts`, e `bankAccounts` é PESSOAL-only nos
// três mapas). Diferente do cenário 4 (stepKey `expense` → QuickExpenseStep),
// aqui o componente montado é o próprio `ImportMassStep`, com captura de rede
// real: zero requisição ao path e zero 403 observado.
function importJourney(screenKey: string) {
  return {
    key: 'w5:onboarding-import',
    name: 'Onboarding import em massa',
    active: true,
    targetScope: 'ALL_PROJECTS',
    targetProjectType: null,
    targetProjectId: null,
    repeatPolicy: 'ALWAYS',
    allowCrossProjectNavigation: false,
    steps: [
      {
        stepKey: 'import',
        order: 0,
        enabled: true,
        skippable: true,
        experience: 'SUMMARY',
        label: 'Importe seus lançamentos de uma vez',
        subtitle: null,
        conditionKey: null,
        conditionUnmetBehavior: 'SKIP',
        targetProjectType: null,
      },
    ],
    triggers: [
      { triggerType: 'SCREEN_VISIT', screenKey, actionKey: null, device: 'any', active: true },
    ],
  };
}

test.describe('W5 #658 · ImportMassStep SUMMARY em REFORMA — zero GET /tenant/bank-accounts, zero 403', () => {
  test('passo `import` renderiza (import de cartão funciona) sem tocar /tenant/bank-accounts', async ({ page, baseURL }) => {
    const hits: string[] = [];
    const requests: string[] = [];
    trap403(page, /\/bank-accounts/, hits);
    page.on('request', (r) => requests.push(r.url()));

    await mockApi(page, baseURL!, { modules: REFORMA_MODULES });
    // Cartão presente: a query de credit-cards (NÃO gateada) deve funcionar e o
    // botão "Fatura do cartão" aparecer, provando que o passo está vivo.
    await page.route('**/tenant/credit-cards', (route) =>
      route.fulfill(json([{ id: 'cc1', brand: 'Visa', last4: '4242', nickname: 'Cartão principal' }])),
    );
    await page.route('**/journeys/eligible*', (route) => route.fulfill(json([importJourney('expenses')])));
    await page.route('**/journeys/*/complete', (route) => route.fulfill({ status: 204, body: '' }));

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/projects/${REFORMA_ID}/expenses`);

    const stepPanel = page.locator('[data-journey-step="import"]');
    await expect(stepPanel).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Fatura do cartão' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Importar sem vincular' })).toBeVisible();

    // Dá tempo de qualquer query do passo disparar.
    await page.waitForTimeout(600);

    const bankAccountCalls = requests.filter((u) => /tenant\/bank-accounts/.test(u));
    expect(bankAccountCalls, `GET /tenant/bank-accounts no import REFORMA: ${bankAccountCalls.join(', ')}`).toEqual([]);
    expect(hits, `403 de bank-accounts no import REFORMA: ${hits.join(', ')}`).toEqual([]);
  });

  // Espelho: em PESSOAL com o módulo liberado a query DISPARA (200), garantindo
  // que o gate não desligou o caminho legítimo.
  test('PESSOAL com bankAccounts liberado: o passo `import` chama GET /tenant/bank-accounts (200, sem 403)', async ({ page, baseURL }) => {
    const hits: string[] = [];
    const requests: string[] = [];
    trap403(page, /\/bank-accounts/, hits);
    page.on('request', (r) => requests.push(r.url()));

    await mockApi(page, baseURL!); // ALL_MODULES → canBank
    // PESSOAL: /expenses redireciona ao hub /conta (screenKey `conta`).
    await page.route('**/journeys/eligible*', (route) => route.fulfill(json([importJourney('conta')])));
    await page.route('**/journeys/*/complete', (route) => route.fulfill({ status: 204, body: '' }));

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/projects/${PESSOAL_ID}/conta`);

    await expect(page.locator('[data-journey-step="import"]')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(600);

    const bankAccountCalls = requests.filter((u) => /tenant\/bank-accounts/.test(u));
    expect(bankAccountCalls.length, 'PESSOAL deveria chamar /tenant/bank-accounts').toBeGreaterThan(0);
    expect(hits, `403 inesperado em PESSOAL: ${hits.join(', ')}`).toEqual([]);
  });
});
