import { test, expect, type Page, type ViewportSize } from '@playwright/test';

/**
 * U3 (issue #452) — FinancialItemCardV1 E2E: sheet/drawer responsive detail.
 *
 * Affordance: **ícone-avatar** da linha (aria-label="Ver detalhe") abre o
 * detalhe. Título → editar (legacy). Menu ⋮ → ações.
 *
 * Disciplinas:
 *  1. Relógio congelado ANTES de navegar.
 *  2. API interceptada — nenhum banco tocado.
 *  3. Porta PLAYWRIGHT_PORT (3180 — livre).
 *  4. Teste que não encontra o alvo FALHA ALTO.
 *  5. Medição de runtime (bounding box + elementFromPoint), não CSS.
 */

const PROJECT_ID = 'u3-pessoal';
const FROZEN = new Date('2026-07-15T12:00:00.000Z');

// ── Fixtures ──────────────────────────────────────────────────────────────

const ITEM_V1_EXPENSE = {
  id: 'exp-u3-1',
  kind: 'saida' as const,
  descricao: 'Material de construção',
  data: '2026-07-05',
  forma: 'pix' as const,
  valor: 20696,
  realizado: true,
  status: 'PAGO',
  cardId: null,
  actions: [] as string[],
  fingerprint: null,
  cardLast4: null,
  bankLast4: '0001',
  tipoDespesa: 'MATERIAL',
  isInvoice: false,
  editavel: true,
  dueMonth: null,
  projetoOrigem: { id: PROJECT_ID, name: 'Pessoal U3', type: 'PESSOAL' },
  purposeLabel: 'Compra de material',
  title: 'Cimento e areia',
  supplier: 'Leroy Merlin',
  installment: '2/6',
  paymentForm: 'PIX',
  hasEvidence: false,
  isEspelho: false,
  isNeutral: false,
};

const ITEM_V1_NO_ACTIONS = {
  ...ITEM_V1_EXPENSE,
  id: 'exp-u3-2',
  descricao: 'Gasto sem ação',
  title: null as string | null,
  supplier: null as string | null,
  installment: null as string | null,
  actions: [] as string[],
  editavel: false,
  projetoOrigem: null,
  purposeLabel: 'Outros',
};

const ITEM_V1_RECEIPT = {
  id: 'rec-u3-1',
  kind: 'entrada' as const,
  descricao: 'Salário',
  data: '2026-07-03',
  tipo: 'Salário',
  valor: 500025,
  bankLast4: '0001',
  status: 'EM_CAIXA' as const,
  purposeLabel: 'Recebimento mensal',
  title: 'Salário julho',
  hasEvidence: false,
  isNeutral: false,
};

// ── API stubs ─────────────────────────────────────────────────────────────

function json(body: unknown) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) };
}

const AUTH_ME = {
  id: 'user-u3', username: 'u3test', name: 'QA U3', role: 'ADMIN',
  tenantId: 'tenant-u3', allowedModules: [], allowedProjects: [], allowedProjectTypes: [],
};

const ACCOUNT_VIEW = {
  mesSelecionado: '2026-07',
  caixaHoje: 500025, entrouMes: 500025, saiuMes: 20696,
  faltaPagarMes: 0, recebimentosPrevistosMes: 0, sobraPrevista: 479329,
  devoCartaoTotal: 0,
  cartoes: [],
  contas: [{ last4: '0001', nome: 'Itaú Personnalité' }],
  saidas: [ITEM_V1_EXPENSE, ITEM_V1_NO_ACTIONS],
  comprasCartao: [],
  entradas: [ITEM_V1_RECEIPT],
  ticketMedio: { valor: 0, nCompras: 0, totalCompras: 0, serie6m: [], media6m: 0, deltaVsMediaPct: null },
};

const DRE_OVERVIEW = {
  mensal: {
    mes: '2026-07', resultado: 0, entradas: [], saidas: [],
    contaCorrente: { caixaHoje: 0, entrouMes: 0, saiuMes: 0, faltaPagarMes: 0, recebimentosPrevistosMes: 0, sobraPrevista: 0, despesaTotal: 0 },
  },
  anual: { ano: 2026, saldoAcumuladoSerie: [], serie: [], totaisEntradas: [], totaisSaidas: [], totaisGuardado: [], candidatos: [] },
};

async function setupPage(page: Page, baseURL: string, viewport: ViewportSize) {
  await page.clock.setFixedTime(FROZEN);
  await page.setViewportSize(viewport);
  await page.context().addCookies([{ name: 'rf_token', value: 'test', url: baseURL }]);

  await page.route('http://localhost:3001/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/auth/me') return route.fulfill(json(AUTH_ME));
    if (path === '/projects') return route.fulfill(json([
      { id: PROJECT_ID, name: 'Pessoal U3', type: 'PESSOAL', role: 'OWNER' },
    ]));
    if (path === `/projects/${PROJECT_ID}`) return route.fulfill(json(
      { id: PROJECT_ID, name: 'Pessoal U3', type: 'PESSOAL', onboardedAt: '2026-01-01T00:00:00.000Z' },
    ));
    if (path.endsWith('/monthly-overview/account-view'))
      return route.fulfill(json(ACCOUNT_VIEW));
    if (path.endsWith('/monthly-overview/dre-overview'))
      return route.fulfill(json(DRE_OVERVIEW));
    if (path === `/projects/${PROJECT_ID}/credit-cards`)
      return route.fulfill(json([]));
    return route.fulfill(json([]));
  });
}

async function navigateToConta(page: Page) {
  await page.goto(`/projects/${PROJECT_ID}/conta`);
  await expect(page.getByText('Cimento e areia').first()).toBeVisible({ timeout: 15_000 });
}

/** Click the avatar icon button (aria-label="Ver detalhe") of the first expense. */
async function openExpenseDetail(page: Page) {
  await page.getByLabel('Ver detalhe').first().click();
}

// ═══════════════════════════════════════════════════════════════════════════
// U3-E01 — 375px: BRL formatting, not raw centavos
// ═══════════════════════════════════════════════════════════════════════════
test.describe('U3-E01: BRL formatting @375', () => {
  test('displays R$ formatted value, not raw centavos', async ({ page, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'viewport owned by this spec');
    await setupPage(page, baseURL!, { width: 375, height: 812 });
    await navigateToConta(page);

    const bodyText = await page.evaluate(() => document.body.innerText);
    expect(bodyText).toMatch(/R\$\s*206,96/);
    expect(bodyText).toMatch(/R\$\s*5\.000,25/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// U3-E02 — 390px: tap avatar opens sheet with status, date, origin, value
// ═══════════════════════════════════════════════════════════════════════════
test.describe('U3-E02: detail sheet @390', () => {
  test('sheet contains status, date, origin, value, supplier, installment', async ({ page, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'viewport owned by this spec');
    await setupPage(page, baseURL!, { width: 390, height: 844 });
    await navigateToConta(page);
    await openExpenseDetail(page);

    const sheet = page.getByTestId('financial-detail-sheet');
    await expect(sheet).toBeVisible({ timeout: 5_000 });

    const t = await sheet.innerText();
    expect(t).toContain('Pago');
    expect(t).toMatch(/05\/07\/2026/);
    expect(t).toContain('Pessoal U3');
    expect(t).toMatch(/R\$\s*206,96/);
    expect(t).toContain('Leroy Merlin');
    expect(t).toContain('2/6');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// U3-E03 — 1280px: click avatar opens drawer with same fields
// ═══════════════════════════════════════════════════════════════════════════
test.describe('U3-E03: detail drawer @1280', () => {
  test('drawer contains status, date, origin, value, supplier, installment', async ({ page, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'viewport owned by this spec');
    await setupPage(page, baseURL!, { width: 1280, height: 800 });
    await navigateToConta(page);
    await openExpenseDetail(page);

    const drawer = page.getByTestId('financial-detail-drawer');
    await expect(drawer).toBeVisible({ timeout: 5_000 });

    const t = await drawer.innerText();
    expect(t).toContain('Pago');
    expect(t).toMatch(/05\/07\/2026/);
    expect(t).toContain('Pessoal U3');
    expect(t).toMatch(/R\$\s*206,96/);
    expect(t).toContain('Leroy Merlin');
    expect(t).toContain('2/6');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// U3-E04 — 375px: close detail preserves scroll + filters
// ═══════════════════════════════════════════════════════════════════════════
test.describe('U3-E04: close preserves scroll + filters @375', () => {
  test('scroll position and URL survive detail round-trip', async ({ page, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'viewport owned by this spec');
    await setupPage(page, baseURL!, { width: 375, height: 812 });
    await navigateToConta(page);

    // Inject spacer to guarantee scrollability
    await page.evaluate(() => {
      const spacer = document.createElement('div');
      spacer.style.height = '2000px';
      document.body.appendChild(spacer);
    });
    await page.evaluate(() => window.scrollTo(0, 300));
    await page.waitForTimeout(200);
    const scrollBefore = await page.evaluate(() => window.scrollY);
    expect(scrollBefore).toBeGreaterThanOrEqual(100);
    const urlBefore = page.url();

    await openExpenseDetail(page);
    const sheet = page.getByTestId('financial-detail-sheet');
    await expect(sheet).toBeVisible({ timeout: 5_000 });

    await page.getByLabel('Fechar').click();
    await expect(sheet).not.toBeVisible({ timeout: 3_000 });

    const scrollAfter = await page.evaluate(() => window.scrollY);
    expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThanOrEqual(5);
    expect(page.url()).toBe(urlBefore);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// U3-E05 — deep-link: ?item= selects item in scoped response
// ═══════════════════════════════════════════════════════════════════════════
test.describe('U3-E05: deep-link selects scoped item', () => {
  test('?item= auto-opens detail from existing data, no universal fetch', async ({ page, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'viewport owned by this spec');
    await setupPage(page, baseURL!, { width: 390, height: 844 });

    const apiCalls: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('localhost:3001'))
        apiCalls.push(new URL(req.url()).pathname);
    });

    await page.goto(`/projects/${PROJECT_ID}/conta?item=${ITEM_V1_EXPENSE.id}`);
    await expect(page.getByText('Cimento e areia').first()).toBeVisible({ timeout: 15_000 });

    // Detail MUST auto-open for the item specified in URL
    const sheet = page.getByTestId('financial-detail-sheet');
    await expect(sheet).toBeVisible({ timeout: 5_000 });
    expect(await sheet.innerText()).toContain('Pessoal U3');

    // No universal /financial-items/:id endpoint called
    const universalCalls = apiCalls.filter(p =>
      /\/financial-items\//.test(p) || /\/items\/exp-u3-1/.test(p),
    );
    expect(universalCalls).toHaveLength(0);
  });

  test('unknown item id is silent — no detail, no extra request', async ({ page, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'viewport owned by this spec');
    await setupPage(page, baseURL!, { width: 390, height: 844 });

    const apiCalls: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('localhost:3001'))
        apiCalls.push(new URL(req.url()).pathname);
    });

    await page.goto(`/projects/${PROJECT_ID}/conta?item=nonexistent-id-999`);
    await expect(page.getByText('Cimento e areia').first()).toBeVisible({ timeout: 15_000 });

    // No detail opens
    await page.waitForTimeout(1_000);
    expect(await page.getByTestId('financial-detail-sheet').count()).toBe(0);
    expect(await page.getByTestId('financial-detail-drawer').count()).toBe(0);

    // No universal endpoint called
    const universalCalls = apiCalls.filter(p => /\/financial-items\//.test(p));
    expect(universalCalls).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// U3-E06 [TRAVA] — 375px: no evidence indicator in V1
// ═══════════════════════════════════════════════════════════════════════════
test.describe('U3-E06 [TRAVA]: no evidence indicator in V1 @375', () => {
  test('hasEvidence always false — no "comprovante" badge anywhere', async ({ page, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'viewport owned by this spec');
    await setupPage(page, baseURL!, { width: 375, height: 812 });
    await navigateToConta(page);
    await openExpenseDetail(page);

    const sheet = page.getByTestId('financial-detail-sheet');
    await expect(sheet).toBeVisible({ timeout: 5_000 });

    const bodyText = await page.evaluate(() => document.body.innerText);
    expect(bodyText.toLowerCase()).not.toContain('comprovante');
    await expect(page.getByText('Com comprovante')).toHaveCount(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// U3-E07 — 375px: detail has zero action buttons (context only, AC2)
// ═══════════════════════════════════════════════════════════════════════════
test.describe('U3-E07: no CTA in detail @375', () => {
  test('detail renders only close button — zero action CTAs', async ({ page, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'viewport owned by this spec');
    await setupPage(page, baseURL!, { width: 375, height: 812 });
    await navigateToConta(page);
    await openExpenseDetail(page);

    const sheet = page.getByTestId('financial-detail-sheet');
    await expect(sheet).toBeVisible({ timeout: 5_000 });

    const buttons = sheet.getByRole('button');
    const count = await buttons.count();
    expect(count).toBe(1);
    await expect(buttons.first()).toHaveAttribute('aria-label', 'Fechar');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// U3-E08 — 375px: sheet present AND drawer absent from DOM
// ═══════════════════════════════════════════════════════════════════════════
test.describe('U3-E08: sheet⊕drawer @375', () => {
  test('sheet in DOM, drawer NOT in DOM (conditional mount)', async ({ page, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'viewport owned by this spec');
    await setupPage(page, baseURL!, { width: 375, height: 812 });
    await navigateToConta(page);
    await openExpenseDetail(page);

    await expect(page.getByTestId('financial-detail-sheet')).toBeVisible({ timeout: 5_000 });
    expect(await page.getByTestId('financial-detail-drawer').count()).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// U3-E09 — 1280px: drawer present AND sheet absent from DOM
// ═══════════════════════════════════════════════════════════════════════════
test.describe('U3-E09: drawer⊕sheet @1280', () => {
  test('drawer in DOM, sheet NOT in DOM (conditional mount)', async ({ page, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'viewport owned by this spec');
    await setupPage(page, baseURL!, { width: 1280, height: 800 });
    await navigateToConta(page);
    await openExpenseDetail(page);

    await expect(page.getByTestId('financial-detail-drawer')).toBeVisible({ timeout: 5_000 });
    expect(await page.getByTestId('financial-detail-sheet').count()).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// U3-E10 — 375px: three clickable targets in a row do NOT collide
// ═══════════════════════════════════════════════════════════════════════════
test.describe('U3-E10: row click-target isolation @375', () => {
  test('avatar opens detail, title does NOT, menu does NOT — each receives own click', async ({ page, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'viewport owned by this spec');
    await setupPage(page, baseURL!, { width: 375, height: 812 });
    await navigateToConta(page);

    // ── 1. Measure the avatar button ──
    const avatarBtn = page.getByLabel('Ver detalhe').first();
    await expect(avatarBtn).toBeVisible();
    const avatarBox = await avatarBtn.boundingBox();
    expect(avatarBox).not.toBeNull();
    // Touch target ≥ 44×44
    expect(avatarBox!.width).toBeGreaterThanOrEqual(44);
    expect(avatarBox!.height).toBeGreaterThanOrEqual(44);

    // ── 2. elementFromPoint: avatar center hits the avatar button ──
    const avatarCenterX = avatarBox!.x + avatarBox!.width / 2;
    const avatarCenterY = avatarBox!.y + avatarBox!.height / 2;
    const avatarHit = await page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        return el?.closest('[aria-label="Ver detalhe"]') !== null;
      },
      { x: avatarCenterX, y: avatarCenterY },
    );
    expect(avatarHit).toBe(true);

    // ── 3. Click avatar → detail opens ──
    await avatarBtn.click();
    const sheet = page.getByTestId('financial-detail-sheet');
    await expect(sheet).toBeVisible({ timeout: 5_000 });
    // Close it
    await page.getByLabel('Fechar').click();
    await expect(sheet).not.toBeVisible({ timeout: 3_000 });

    // ── 4. Click title → detail does NOT open ──
    const titleBtn = page.getByText('Cimento e areia').first();
    await expect(titleBtn).toBeVisible();
    const titleBox = await titleBtn.boundingBox();
    expect(titleBox).not.toBeNull();

    // elementFromPoint: title center hits a button but NOT the avatar
    const titleCenterX = titleBox!.x + titleBox!.width / 2;
    const titleCenterY = titleBox!.y + titleBox!.height / 2;
    const titleHitsAvatar = await page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        return el?.closest('[aria-label="Ver detalhe"]') !== null;
      },
      { x: titleCenterX, y: titleCenterY },
    );
    expect(titleHitsAvatar).toBe(false);

    await titleBtn.click();
    await page.waitForTimeout(500);
    // Detail must NOT have opened — title click goes to edit, not detail
    expect(await page.getByTestId('financial-detail-sheet').count()).toBe(0);

    // Title click on editable item opens edit modal — dismiss it before
    // testing the menu trigger, otherwise the fixed overlay blocks clicks.
    // Look for the modal backdrop or close/cancel button.
    const modalBackdrop = page.locator('.bg-darc-velvet\\/85, [data-state="open"]').first();
    if (await modalBackdrop.isVisible().catch(() => false)) {
      // Press Escape to close the modal
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }

    // ── 5. Menu trigger → detail does NOT open ──
    const menuTrigger = page.locator('button[aria-label="Mais ações"]').first();
    await expect(menuTrigger).toBeVisible({ timeout: 3_000 });

    const menuBox = await menuTrigger.boundingBox();
    expect(menuBox).not.toBeNull();

    const menuCenterX = menuBox!.x + menuBox!.width / 2;
    const menuCenterY = menuBox!.y + menuBox!.height / 2;
    const menuHitsAvatar = await page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        return el?.closest('[aria-label="Ver detalhe"]') !== null;
      },
      { x: menuCenterX, y: menuCenterY },
    );
    expect(menuHitsAvatar).toBe(false);

    await menuTrigger.click();
    await page.waitForTimeout(300);
    // Detail must NOT have opened from menu click
    expect(await page.getByTestId('financial-detail-sheet').count()).toBe(0);
  });
});
