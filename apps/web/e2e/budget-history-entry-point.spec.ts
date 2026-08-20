import { expect, test, type Page } from '@playwright/test';

/**
 * #504 — o ponto de entrada do histórico congelado de Alocação de Budget.
 *
 * Por que E2E e não só jsdom: o defeito do #449/#500 passou por CI verde e por
 * revisão estática. Um QA de runtime é que achou
 * `PAGES WITH BUDGET ENTRY POINT: []` / `navHasBudgetLink = false`. Um link com
 * as classes certas e caixa de altura zero — ou coberto por outro elemento —
 * passa em qualquer teste de markup e simplesmente não existe para o usuário.
 *
 * Por isso aqui NÃO se lê CSS: mede-se `getBoundingClientRect()` e confirma-se
 * com `document.elementFromPoint()` no centro do elemento que o clique cai nele
 * (ou em um filho seu), além do alvo de toque mínimo de 44px.
 */

const PERSONAL_ID = 'budget-entry-personal';
const REFORMA_ID = 'budget-entry-reforma';
const ENTRY_LABEL = 'Histórico de Budget';
const MIN_TOUCH_TARGET = 44;

type Session = { role: string; isGuest?: boolean };

function json(body: unknown) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) };
}

/**
 * A sidebar anima a largura (`transition-[width] duration-200`) e a nav
 * reflui ao expandir. Medir antes de assentar leria uma geometria em trânsito
 * — mediria ruído, não o que o usuário vê. Espera dois frames com o mesmo
 * retângulo antes de deixar medir.
 */
async function waitForStableRect(page: Page, selector: string) {
  await page.waitForFunction(
    (id) => {
      const element = document.querySelector(id);
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const signature = `${rect.top}:${rect.left}:${rect.width}:${rect.height}`;
      const previous = (window as unknown as { __rectSignature?: string }).__rectSignature;
      (window as unknown as { __rectSignature?: string }).__rectSignature = signature;
      return previous === signature;
    },
    selector,
    { polling: 100 },
  );
}

async function mockApi(page: Page, session: Session) {
  await page.context().addCookies([
    { name: 'rf_token', value: 'budget-entry', url: 'http://localhost:3013' },
  ]);
  await page.route('http://localhost:3001/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/auth/me') {
      return route.fulfill(
        json({
          id: 'budget-entry-user',
          username: 'budget-entry',
          name: 'Admin Budget',
          role: session.role,
          isGuest: session.isGuest ?? false,
          tenantId: 'budget-entry-tenant',
          allowedModules: ['monthlyOverview', 'expenses', 'receipts', 'cashFlow', 'creditCards', 'bankAccounts'],
          allowedProjects: [PERSONAL_ID, REFORMA_ID],
          allowedProjectTypes: ['PESSOAL', 'REFORMA'],
        }),
      );
    }
    if (path === `/projects/${PERSONAL_ID}`) {
      return route.fulfill(
        json({ id: PERSONAL_ID, name: 'Pessoal 504', type: 'PESSOAL', onboardedAt: '2026-01-01T00:00:00.000Z' }),
      );
    }
    if (path === `/projects/${REFORMA_ID}`) {
      return route.fulfill(
        json({ id: REFORMA_ID, name: 'Reforma 504', type: 'REFORMA', onboardedAt: '2026-01-01T00:00:00.000Z' }),
      );
    }
    if (path.startsWith('/budget-allocations/available')) return route.fulfill(json(16249950));
    if (path.startsWith('/budget-allocations/summary')) {
      return route.fulfill(
        json({
          totalAllocated: 23500000,
          totalExpenses: 5000,
          totalReceipts: 40000000,
          allocations: [{ projectName: 'Reforma 504', projectType: 'REFORMA', total: 23500000 }],
        }),
      );
    }
    return route.fulfill(json([]));
  });
}

/**
 * A medição que importa: caixa real + hit-test no centro.
 *
 * `elementFromPoint` devolve o elemento MAIS ACIMA naquele pixel. Aceitamos o
 * próprio link ou um descendente dele (o ícone/rótulo). Qualquer outra coisa
 * significa que algo está por cima e o usuário não consegue clicar.
 */
async function measureEntryPoint(page: Page, selector: string) {
  return page.evaluate((id) => {
    const element = document.querySelector<HTMLElement>(id);
    if (!element) return { found: false as const };
    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const topmost = document.elementFromPoint(centerX, centerY);
    return {
      found: true as const,
      width: rect.width,
      height: rect.height,
      href: element.getAttribute('href'),
      insideViewport:
        rect.left >= 0 &&
        rect.top >= 0 &&
        rect.right <= document.documentElement.clientWidth + 1 &&
        rect.bottom <= document.documentElement.clientHeight + 1,
      hitsItself: Boolean(topmost && (topmost === element || element.contains(topmost))),
      // Quem está por cima, quando está: sem isto a falha só diz "false" e não
      // dá para saber o que cobriu o ponto de entrada.
      topmost: topmost
        ? `${topmost.tagName.toLowerCase()}.${topmost.className?.toString().slice(0, 80)}`
        : 'none',
    };
  }, selector);
}

function expectRealClickableTarget(
  measurement: Awaited<ReturnType<typeof measureEntryPoint>>,
  expectedHref: string,
) {
  expect(measurement.found).toBe(true);
  if (!measurement.found) return;
  expect(measurement.href).toBe(expectedHref);
  // Caixa de altura/largura zero é o modo clássico de "existe no DOM e não
  // existe na tela". 44px é o mínimo de toque exigido pelo AGENTS.md.
  expect(measurement.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
  expect(measurement.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
  expect(measurement.insideViewport).toBe(true);
  expect(
    measurement.hitsItself,
    `centro do ponto de entrada coberto por: ${measurement.topmost}`,
  ).toBe(true);
}

/**
 * Expande a sidebar pelo estado persistido em vez de clicar no botão.
 *
 * O toggle "Expandir menu lateral" fica no canto inferior esquerdo — exatamente
 * onde o `<nextjs-portal>` (indicador de build do `next dev`) se sobrepõe sob
 * carga paralela, o que intercepta o clique e derruba o teste por motivo de
 * ambiente, não de produto. Semear `localStorage` reproduz o mesmo estado que o
 * usuário teria na volta à tela, sem depender do overlay de dev.
 */
async function openExpandedSidebar(page: Page, url: string) {
  await page.addInitScript(() => {
    window.localStorage.setItem('lifeone:sidebar:collapsed', 'false');
  });
  await page.goto(url);
  await expect(page.getByRole('button', { name: /recolher menu lateral/i })).toBeVisible();
}

test.describe('#504 ponto de entrada do histórico congelado de budget', () => {
  test('desktop 1440: ADMIN acha o item na sidebar, recolhida E expandida, e ele leva à tela', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockApi(page, { role: 'ADMIN' });
    await page.goto(`/projects/${PERSONAL_ID}/monthly`);

    const entry = page.getByTestId('sidebar-budget-history');
    await expect(entry).toBeVisible();

    // Estado padrão da sidebar é RECOLHIDO: o item precisa existir e ser
    // clicável já aí, senão depende de o usuário expandir para descobrir.
    await waitForStableRect(page, '[data-testid="sidebar-budget-history"]');
    expectRealClickableTarget(
      await measureEntryPoint(page, '[data-testid="sidebar-budget-history"]'),
      `/projects/${PERSONAL_ID}/budget-allocation`,
    );

    await openExpandedSidebar(page, `/projects/${PERSONAL_ID}/monthly`);
    await expect(entry).toContainText(ENTRY_LABEL);
    await waitForStableRect(page, '[data-testid="sidebar-budget-history"]');
    expectRealClickableTarget(
      await measureEntryPoint(page, '[data-testid="sidebar-budget-history"]'),
      `/projects/${PERSONAL_ID}/budget-allocation`,
    );

    // O ponto de entrada precisa CHEGAR na tela, não só existir.
    await entry.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${PERSONAL_ID}/budget-allocation$`));
    await expect(page.getByRole('heading', { name: 'Alocação de Budget' })).toBeVisible();
    await expect(page.getByText('Somente leitura.')).toBeVisible();
  });

  /**
   * Regressão do que a medição revelou: com a `<nav>` inteira rolando, o
   * cluster utilitário caía fora da área visível num PESSOAL de ADMIN a
   * 1440x900 — "Usuários" ficava em y=826 com a nav terminando em 768 e o
   * `elementFromPoint` devolvia o rodapé. Adicionar mais um item ali teria
   * enterrado os dois. Agora só a lista de módulos rola.
   */
  test('desktop 1440: o cluster utilitário inteiro continua clicável com a nav cheia', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockApi(page, { role: 'ADMIN' });
    await openExpandedSidebar(page, `/projects/${PERSONAL_ID}/monthly`);

    for (const selector of [
      'a[aria-label="Apoio"]',
      '[data-testid="sidebar-budget-history"]',
      'a[aria-label="Usuários"]',
    ]) {
      await waitForStableRect(page, selector);
      const measurement = await measureEntryPoint(page, selector);
      expect(measurement.found, `${selector} sumiu do DOM`).toBe(true);
      if (!measurement.found) continue;
      expect(measurement.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
      expect(
        measurement.hitsItself,
        `${selector} não recebe o clique — coberto por: ${measurement.topmost}`,
      ).toBe(true);
    }
  });

  test('mobile 375: ADMIN acha o item no menu "Mais" e ele leva à tela', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await mockApi(page, { role: 'ADMIN' });
    await page.goto(`/projects/${PERSONAL_ID}/monthly`);

    await page.getByRole('button', { name: 'Mais opções' }).click();
    const tile = page.getByTestId('mais-budget-history');
    await expect(tile).toBeVisible();

    await waitForStableRect(page, '[data-testid="mais-budget-history"]');
    expectRealClickableTarget(
      await measureEntryPoint(page, '[data-testid="mais-budget-history"]'),
      `/projects/${PERSONAL_ID}/budget-allocation`,
    );

    await tile.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${PERSONAL_ID}/budget-allocation$`));
    await expect(page.getByRole('heading', { name: 'Alocação de Budget' })).toBeVisible();
  });

  test('a tela congelada não promete alocação e o CTA de bloqueio tem 44px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await mockApi(page, { role: 'ADMIN' });
    await page.goto(`/projects/${PERSONAL_ID}/budget-allocation`);

    await expect(page.getByText('Saldo não alocado')).toBeVisible();
    await expect(page.getByText('R$ 162.499,50')).toBeVisible();
    const body = (await page.locator('body').textContent()) ?? '';
    expect(body).not.toMatch(/para alocar/i);
    expect(body).not.toMatch(/poder alocar/i);
    expect(body).not.toMatch(/adicione recebimentos/i);

    // Tela de bloqueio (projeto não-PESSOAL): o QA achou este "Voltar" com 40px.
    await page.goto(`/projects/${REFORMA_ID}/budget-allocation`);
    const voltar = page.getByRole('button', { name: 'Voltar' });
    await expect(voltar).toBeVisible();
    const box = await voltar.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
  });

  for (const [name, session] of [
    ['USER comum', { role: 'USER' }],
    ['convidado de demo com role ADMIN (#497)', { role: 'ADMIN', isGuest: true }],
  ] as Array<[string, Session]>) {
    test(`${name} não enxerga o ponto de entrada em nenhum viewport`, async ({ page }) => {
      await mockApi(page, session);

      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`/projects/${PERSONAL_ID}/monthly`);
      await expect(page.getByTestId('sidebar-budget-history')).toHaveCount(0);

      await page.setViewportSize({ width: 375, height: 667 });
      await page.reload();
      await page.getByRole('button', { name: 'Mais opções' }).click();
      await expect(page.getByTestId('mais-budget-history')).toHaveCount(0);
    });
  }

  test('ADMIN não enxerga o ponto de entrada em projeto não-PESSOAL', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockApi(page, { role: 'ADMIN' });
    await page.goto(`/projects/${REFORMA_ID}/dashboard`);

    await expect(page.getByRole('link', { name: 'Dashboard' }).first()).toBeVisible();
    await expect(page.getByTestId('sidebar-budget-history')).toHaveCount(0);
  });
});
