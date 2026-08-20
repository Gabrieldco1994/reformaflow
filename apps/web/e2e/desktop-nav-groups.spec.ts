import { expect, test, type Page } from '@playwright/test';

/**
 * U1 (issue #450) — reorganização da navegação desktop, metade de VIEW.
 *
 * ─── POR QUE ESTE ARQUIVO EXISTE ───────────────────────────────────────────
 *
 * jsdom NÃO TEM LAYOUT: `getBoundingClientRect()` devolve zeros e `0 >= 0`
 * passa. Toda asserção de GEOMETRIA e de ALCANÇABILIDADE seria verde por
 * construção lá. `DesktopSidebar.test.tsx` cuida da ESTRUTURA (o separador
 * existe, o grupo tem role/aria-label, a dica é elemento no DOM e carrega o
 * nome do grupo); a caixa medida vive aqui.
 *
 * E CAIXA PERFEITA NÃO É ALCANÇÁVEL: no #507 mediu-se um link de 207×44px
 * impecáveis em y=826 com a `<nav>` terminando em 768 — `elementFromPoint` no
 * centro devolvia o rodapé. Passava em todo teste de componente e era
 * inalcançável por rolagem de contêiner. Por isso a ordem abaixo é obrigatória
 * e nenhum passo pode ser pulado:
 *
 *   (1) `scrollIntoViewIfNeeded()` no contêiner REAL
 *   (2) medir a caixa
 *   (3) `elementFromPoint` no centro, exigindo o próprio elemento ou descendente
 *   (4) confirmar que o centro caiu DENTRO do client rect do contêiner rolável
 *
 * ─── O QUE NÃO SE ASSERTA AQUI ─────────────────────────────────────────────
 *
 * Não existe teste `scrollHeight - clientHeight === 0`. Medido: o rail JÁ
 * estoura hoje, ANTES do U1 — 492px de conteúdo contra 297–377px disponíveis.
 * Esse verde é inatingível. "Cabe sem rolar" existe só como número
 * DIAGNÓSTICO reportado no console; o que BLOQUEIA é alcançabilidade após
 * rolagem.
 */

const PERSONAL_ID = 'u1-nav-personal';
const REFORMA_ID = 'u1-nav-reforma';
const MIN_TOUCH_TARGET = 44;

/** Contêiner rolável real da lista de módulos (o que a #507 isolou). */
const SCROLLER = 'nav > .overflow-y-auto';

const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1366, height: 768 },
] as const;

/**
 * CASOS DE MEDIÇÃO — papel × permissão.
 *
 * `buildNavGroups` NÃO emite grupo vazio, então o número de seções (e de réguas,
 * e de altura consumida) VARIA com a permissão. Medir só com quem vê tudo dá o
 * PIOR CASO e esconde o típico. Em PESSOAL, `monthlyOverview` sozinho alimenta 6
 * itens espalhados por 4 grupos: sem ele caem "Hoje", "Resultado" e "Auditoria"
 * inteiros.
 *
 * ATENÇÃO — não existe "ADMIN com permissão reduzida": o `auth-context` faz
 * `hasModule: (slug) => isAdmin || allowed.has(slug)`, ou seja ADMIN/OWNER
 * IGNORA `allowedModules`. Cruzar papel × perfil produziria uma linha ADMIN
 * duplicada disfarçada de medição nova. Por isso os casos são explícitos, e o
 * caso ADMIN recebe DE PROPÓSITO a lista reduzida: se ele renderizar como
 * reduzido, o bypass quebrou.
 */
const FULL_MODULES = [
  'monthlyOverview',
  'expenses',
  'receipts',
  'cashFlow',
  'creditCards',
  'bankAccounts',
  'dashboard',
  'schedule',
  'pendencias',
  'floorPlans',
  'simulation',
  'priceCompare',
] as const;

/** Sem `monthlyOverview` e sem `cashFlow`: 6 itens / 2 grupos em PESSOAL. */
const REDUCED_MODULES = ['expenses', 'receipts', 'creditCards', 'bankAccounts'] as const;

const CASES = [
  { id: 'USER permissao=completa', role: 'USER', modules: FULL_MODULES },
  { id: 'USER permissao=reduzida', role: 'USER', modules: REDUCED_MODULES },
  { id: 'ADMIN permissao=bypass', role: 'ADMIN', modules: REDUCED_MODULES },
] as const;

/**
 * Os quatro destinos primários do contrato, na ordem canônica
 * Hoje → Movimentações → Planejamento → Projetos.
 *
 * Os três primeiros são a PRIMEIRA entrada do respectivo grupo dentro da lista
 * rolável. O quarto é o destino ANCORADO do cabeçalho (saída (i) do PO): ele
 * sai do projeto, os outros ficam dentro dele.
 */
const PRIMARY_TARGETS = [
  // `a:first-of-type` e NÃO um slug fixo: com permissão reduzida o primeiro item
  // do grupo muda (sem `monthlyOverview`, Movimentações começa em "Despesas", e
  // não em "Conta"). Fixar o slug reporta o grupo como AUSENTE quando ele está
  // lá — foi exatamente assim que a primeira rodada desta medição se enganou.
  { group: 'hoje', selector: `[data-nav-group="hoje"] a:first-of-type` },
  { group: 'movimentacoes', selector: `[data-nav-group="movimentacoes"] a:first-of-type` },
  { group: 'planejamento', selector: `[data-nav-group="planejamento"] a:first-of-type` },
  { group: 'projetos', selector: `a[data-nav-group="projetos"]` },
] as const;

function json(body: unknown) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) };
}

async function mockApi(
  page: Page,
  role: string,
  baseURL: string,
  modules: readonly string[] = FULL_MODULES,
) {
  // A URL do cookie vem do `baseURL` do runner, nunca de uma porta literal:
  // este monorepo roda várias worktrees em paralelo e a 3013 pode estar
  // ocupada pelo `next dev` de OUTRO agente (`reuseExistingServer` local),
  // caso em que um literal mediria o código dos outros.
  await page.context().addCookies([{ name: 'rf_token', value: 'u1-nav', url: baseURL }]);
  await page.route('http://localhost:3001/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/auth/me') {
      return route.fulfill(
        json({
          id: 'u1-nav-user',
          username: 'u1-nav',
          name: 'Ana',
          role,
          isGuest: false,
          tenantId: 'u1-nav-tenant',
          // A permissão é PARÂMETRO: o número de grupos varia com ela.
          allowedModules: [...modules],
          allowedProjects: [PERSONAL_ID, REFORMA_ID],
          allowedProjectTypes: ['PESSOAL', 'REFORMA'],
        }),
      );
    }
    if (path === `/projects/${PERSONAL_ID}`) {
      return route.fulfill(
        json({ id: PERSONAL_ID, name: 'Pessoal U1', type: 'PESSOAL', onboardedAt: '2026-01-01T00:00:00.000Z' }),
      );
    }
    if (path === `/projects/${REFORMA_ID}`) {
      return route.fulfill(
        json({ id: REFORMA_ID, name: 'Reforma U1', type: 'REFORMA', onboardedAt: '2026-01-01T00:00:00.000Z' }),
      );
    }
    return route.fulfill(json([]));
  });
}

/**
 * A sidebar anima a largura (`transition-[width] duration-200`) e a nav reflui
 * ao expandir. Medir antes de assentar leria geometria em trânsito.
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

/**
 * Mede um destino SEM rolar nada. É o número diagnóstico que o PO pediu:
 * quantos dos quatro primários o usuário vê ao chegar na tela.
 */
async function measureUnscrolled(page: Page, selector: string, scroller: string) {
  return page.evaluate(
    ({ id, scrollerId }) => {
      const element = document.querySelector<HTMLElement>(id);
      const box = document.querySelector<HTMLElement>(scrollerId);
      if (!element || !box) return { found: false as const };
      const rect = element.getBoundingClientRect();
      const scrollRect = box.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const topmost = document.elementFromPoint(centerX, centerY);
      const inScroller = box.contains(element);
      // "Sem rolar" = a caixa INTEIRA já está dentro do recorte visível.
      // Para o ancorado (fora do rolável) o recorte é a própria viewport.
      const clip = inScroller
        ? { top: scrollRect.top, bottom: scrollRect.bottom }
        : { top: 0, bottom: document.documentElement.clientHeight };
      return {
        found: true as const,
        inScroller,
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        height: Math.round(rect.height),
        width: Math.round(rect.width),
        clipTop: Math.round(clip.top),
        clipBottom: Math.round(clip.bottom),
        fullyVisible: rect.top >= clip.top - 0.5 && rect.bottom <= clip.bottom + 0.5,
        hitsItself: Boolean(topmost && (topmost === element || element.contains(topmost))),
        scrollHeight: box.scrollHeight,
        clientHeight: box.clientHeight,
        scrollTop: box.scrollTop,
      };
    },
    { id: selector, scrollerId: scroller },
  );
}

/**
 * O protocolo obrigatório de alcançabilidade, na ordem. Pular qualquer passo
 * reproduz o defeito do #507.
 */
async function expectReachable(page: Page, selector: string, scroller: string) {
  // (1) rolar o CONTÊINER REAL até o elemento
  await page.locator(selector).scrollIntoViewIfNeeded();
  await waitForStableRect(page, selector);

  const measurement = await page.evaluate(
    ({ id, scrollerId }) => {
      const element = document.querySelector<HTMLElement>(id);
      const box = document.querySelector<HTMLElement>(scrollerId);
      if (!element || !box) return { found: false as const };
      // (2) medir a caixa
      const rect = element.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      // (3) hit-test no centro
      const topmost = document.elementFromPoint(centerX, centerY);
      // (4) o centro caiu dentro do client rect do contêiner rolável?
      const scrollRect = box.getBoundingClientRect();
      const inScroller = box.contains(element);
      const clip = inScroller
        ? scrollRect
        : ({
            top: 0,
            bottom: document.documentElement.clientHeight,
            left: 0,
            right: document.documentElement.clientWidth,
          } as DOMRect);
      return {
        found: true as const,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        centerX: Math.round(centerX),
        centerY: Math.round(centerY),
        hitsItself: Boolean(topmost && (topmost === element || element.contains(topmost))),
        topmost: topmost
          ? `${topmost.tagName.toLowerCase()}.${topmost.className?.toString().slice(0, 60)}`
          : 'none',
        centerInsideClip:
          centerY >= clip.top && centerY <= clip.bottom && centerX >= clip.left && centerX <= clip.right,
        clip: `${Math.round(clip.top)}..${Math.round(clip.bottom)}`,
      };
    },
    { id: selector, scrollerId: scroller },
  );

  expect(measurement.found, `${selector} sumiu do DOM`).toBe(true);
  if (!measurement.found) return;
  expect(measurement.height, `${selector} sem altura de toque`).toBeGreaterThanOrEqual(
    MIN_TOUCH_TARGET,
  );
  expect(measurement.width, `${selector} sem largura de toque`).toBeGreaterThanOrEqual(
    MIN_TOUCH_TARGET,
  );
  expect(
    measurement.hitsItself,
    `${selector} não recebe o clique — coberto por: ${measurement.topmost}`,
  ).toBe(true);
  expect(
    measurement.centerInsideClip,
    `${selector} centro em y=${measurement.centerY} fora do recorte ${measurement.clip} — é o defeito do #507`,
  ).toBe(true);
}

async function openExpandedSidebar(page: Page, url: string) {
  // Semear o storage em vez de clicar: o toggle fica no canto inferior
  // esquerdo, exatamente onde o `<nextjs-portal>` do `next dev` se sobrepõe sob
  // carga paralela, o que derruba o teste por ambiente e não por produto.
  await page.addInitScript(() => {
    window.localStorage.setItem('lifeone:sidebar:collapsed', 'false');
  });
  await page.goto(url);
  await expect(page.getByRole('button', { name: /recolher menu lateral/i })).toBeVisible();
}

test.describe('U1 #450 — navegação desktop agrupada', () => {
  test.skip(({ viewport }) => (viewport?.width ?? 0) < 768, 'rail só existe em md+');

  /**
   * Percorre os primários, reporta o número DIAGNÓSTICO e bloqueia na
   * alcançabilidade. Nada de contagem fixa: um primário cujo grupo não foi
   * autorizado simplesmente NÃO EXISTE, e é reportado como tal — errar para
   * baixo é seguro, errar para cima inventa destino que o usuário não tem.
   */
  async function measureAndAssertPrimaries(page: Page, label: string) {
    const lines: string[] = [];
    let fits = 0;
    let present = 0;
    const missing: string[] = [];
    let overflow = '';

    for (const target of PRIMARY_TARGETS) {
      const m = await measureUnscrolled(page, target.selector, SCROLLER);
      if (!m.found) {
        missing.push(target.group);
        continue;
      }
      present += 1;
      overflow = `scrollHeight=${m.scrollHeight} clientHeight=${m.clientHeight} (estouro ${
        m.scrollHeight - m.clientHeight
      }px)`;
      const ok = m.fullyVisible && m.hitsItself;
      if (ok) fits += 1;
      lines.push(
        `${target.group}: y=${m.top}..${m.bottom} recorte=${m.clipTop}..${m.clipBottom} ` +
          `${m.inScroller ? 'rolável' : 'ancorado'} semRolar=${ok}`,
      );
    }

    // Seções/itens REALMENTE renderizados: é o que varia com a permissão e o que
    // explica a diferença de altura entre as linhas da tabela.
    const groups = await page.locator('nav [data-nav-group]').count();
    const items = await page.locator('nav [data-nav-group] a').count();
    const rules = await page.locator('[data-nav-separator]').count();

    // eslint-disable-next-line no-console
    console.log(
      `[U1-MEDIDO] ${label} — ${fits}/${present} primários alcançáveis SEM ROLAR ` +
        `| grupos=${groups} itens=${items} réguas=${rules} ` +
        `(${PRIMARY_TARGETS.length} no contrato, ${missing.length} não autorizado(s)` +
        `${missing.length ? ': ' + missing.join(', ') : ''}) | ${overflow}\n  ` +
        lines.join('\n  '),
    );

    // Projetos é ANCORADO no cabeçalho e não vem do PROJECT_NAV: existe em
    // qualquer permissão. Se sumir, a saída (i) foi desfeita.
    expect(missing, 'Projetos ancorado sumiu').not.toContain('projetos');
    // Guarda anti-verde-vazio: um perfil que não renderizasse NADA passaria o
    // laço acima sem uma asserção sequer.
    expect(present, 'nenhum primário renderizado').toBeGreaterThan(0);

    // ── o que BLOQUEIA: alcançável DEPOIS de rolar o contêiner real ──
    for (const target of PRIMARY_TARGETS) {
      if (missing.includes(target.group)) continue;
      await expectReachable(page, target.selector, SCROLLER);
    }
  }

  for (const testCase of CASES) {
    for (const viewport of VIEWPORTS) {
      const label = `${viewport.width}x${viewport.height} ${testCase.id}`;

      test(`${label}: primários alcançáveis (rail recolhido)`, async ({ page, baseURL }) => {
        await page.setViewportSize(viewport);
        await mockApi(page, testCase.role, baseURL!, testCase.modules);
        await page.goto(`/projects/${PERSONAL_ID}/expenses`);
        await expect(page.locator('[data-nav-group="movimentacoes"]')).toBeVisible();
        await waitForStableRect(page, SCROLLER);

        await measureAndAssertPrimaries(page, `${label} recolhido`);
      });

      test(`${label}: primários alcançáveis (rail expandido)`, async ({ page, baseURL }) => {
        await page.setViewportSize(viewport);
        await mockApi(page, testCase.role, baseURL!, testCase.modules);
        await openExpandedSidebar(page, `/projects/${PERSONAL_ID}/expenses`);
        await waitForStableRect(page, SCROLLER);

        await measureAndAssertPrimaries(page, `${label} expandido`);
      });
    }
  }

  test('ADMIN IGNORA allowedModules — a linha ADMIN é sempre permissão cheia', async ({
    page,
    baseURL,
  }) => {
    // Mesma lista reduzida do caso USER; só muda o papel. Se um dia o bypass do
    // `auth-context` cair, a linha "ADMIN" das medições deixa de ser o pior caso
    // e a tabela entregue ao PO passa a mentir.
    await page.setViewportSize(VIEWPORTS[1]);
    await mockApi(page, 'ADMIN', baseURL!, REDUCED_MODULES);
    await page.goto(`/projects/${PERSONAL_ID}/expenses`);
    await expect(page.locator('[data-nav-group="movimentacoes"]')).toBeVisible();
    // "Hoje" só existe com `monthlyOverview`, que NÃO está na lista reduzida.
    await expect(page.locator('[data-nav-group="hoje"]')).toHaveCount(1);
  });

  test('permissão reduzida: nº de réguas acompanha o nº de grupos, sem seção fantasma', async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(VIEWPORTS[1]);
    await mockApi(page, 'USER', baseURL!, REDUCED_MODULES);
    await page.goto(`/projects/${PERSONAL_ID}/expenses`);
    await expect(page.locator('[data-nav-group="movimentacoes"]')).toBeVisible();

    const groups = await page.locator('nav [data-nav-group]').count();
    expect(groups, 'perfil reduzido deve render ao menos um grupo').toBeGreaterThan(0);
    // n-1 DERIVADO do DOM — nunca literal: a contagem varia com a permissão.
    await expect(page.locator('[data-nav-separator]')).toHaveCount(groups - 1);
    // Grupo sem item autorizado não pode deixar cabeçalho nem `role=group` órfão.
    for (const gone of ['hoje', 'resultado', 'auditoria']) {
      await expect(page.locator(`[data-nav-group="${gone}"]`)).toHaveCount(0);
    }
    // ...e o ancorado sobrevive.
    await expect(page.locator('a[data-nav-group="projetos"]:visible')).toHaveCount(1);
  });

  test('a dica é PINTADA e diz o nome do grupo com o rail recolhido', async ({ page, baseURL }) => {
    await page.setViewportSize(VIEWPORTS[0]);
    await mockApi(page, 'USER', baseURL!);
    await page.goto(`/projects/${PERSONAL_ID}/monthly`);
    await expect(page.locator('[data-nav-group="movimentacoes"]')).toBeVisible();

    // Recolhido, o rótulo "Cartões" é `sr-only` e o cabeçalho "MOVIMENTAÇÕES"
    // nem existe. Se a dica fosse a NATIVA do navegador, ela não estaria no DOM
    // e este teste seria impossível de escrever — é exatamente o ponto.
    const cartoes = page.locator('[data-nav-group="movimentacoes"] a[href$="/credit-cards"]');
    await cartoes.hover();

    const hint = page.getByRole('tooltip');
    await expect(hint).toHaveText('Movimentações · Cartões');

    // Existir no DOM não basta: caixa de área zero é o modo clássico de
    // "existe e o usuário não vê".
    const box = await hint.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(0);
    expect(box?.height ?? 0).toBeGreaterThan(0);

    // E ela não pode roubar o clique do próprio item que a abriu.
    await expectReachable(page, '[data-nav-group="movimentacoes"] a[href$="/credit-cards"]', SCROLLER);

    // Teclado chega na mesma dica.
    //
    // `page.mouse.move(0, 0)` ANTES do foco não é cosmético: `focus()` rola o
    // contêiner, e com o ponteiro parado sobre o rail o item que passa por
    // baixo dele dispara `mouseenter` e rouba a dica. Sem tirar o mouse, este
    // teste mediria o hover, não o teclado.
    await page.mouse.move(0, 0);
    await page.locator('[data-nav-group="auditoria"] a[href$="/neutros"]').focus();
    await expect(page.getByRole('tooltip')).toHaveText('Auditoria · Neutros');
  });

  test('as réguas entre grupos existem recolhido, com 1px, e somem expandido', async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(VIEWPORTS[0]);
    await mockApi(page, 'USER', baseURL!);
    await page.goto(`/projects/${PERSONAL_ID}/monthly`);
    await expect(page.locator('[data-nav-group="movimentacoes"]')).toBeVisible();

    const groups = await page.locator(`${SCROLLER} [data-nav-group]`).count();
    const rules = page.locator('[data-nav-separator]');
    await expect(rules).toHaveCount(groups - 1);

    // `h-px` de verdade: uma régua grossa come orçamento vertical que este rail
    // não tem. Medido no DOM, não lido do CSS.
    const heights = await rules.evaluateAll((nodes) =>
      nodes.map((n) => Math.round(n.getBoundingClientRect().height)),
    );
    expect(heights).toEqual(new Array(groups - 1).fill(1));
    // E precisam ser visíveis (largura > 0), senão são 1px de nada.
    const widths = await rules.evaluateAll((nodes) =>
      nodes.map((n) => Math.round(n.getBoundingClientRect().width)),
    );
    for (const width of widths) expect(width).toBeGreaterThan(0);

    await openExpandedSidebar(page, `/projects/${PERSONAL_ID}/monthly`);
    await expect(page.locator('[data-nav-separator]')).toHaveCount(0);
  });

  test('"Projetos" é destino ancorado e único — não vira quarto item da lista', async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(VIEWPORTS[1]);
    await mockApi(page, 'ADMIN', baseURL!);
    await page.goto(`/projects/${PERSONAL_ID}/monthly`);

    const projetos = page.locator('a[data-nav-group="projetos"]');
    await expect(projetos).toHaveCount(1);
    await expect(projetos).toHaveAttribute('href', '/projects');
    await expect(projetos).toHaveAttribute('aria-label', 'Projetos');
    // Duas entradas para o mesmo destino é o que a saída (i) do PO evita.
    //
    // `:visible` de propósito: o `MobileHeader` também tem um `/projects`, mas
    // é `md:hidden` — existe no DOM e não na tela do desktop. Contar o DOM cru
    // daria 2 e mediria o mobile, que é o U2. De quebra, isto prova que o
    // cabeçalho mobile continua escondido em md+.
    await expect(page.locator('a[href="/projects"]:visible')).toHaveCount(1);
    await expect(page.locator(`${SCROLLER} a[href="/projects"]`)).toHaveCount(0);

    // Ancorado = alcançável sem depender de rolagem alguma.
    const measurement = await measureUnscrolled(page, 'a[data-nav-group="projetos"]', SCROLLER);
    expect(measurement.found).toBe(true);
    if (!measurement.found) return;
    expect(measurement.inScroller).toBe(false);
    expect(measurement.fullyVisible).toBe(true);
    expect(measurement.hitsItself).toBe(true);

    await projetos.click();
    await expect(page).toHaveURL(/\/projects$/);
  });

  test('REG #507: o cluster utilitário ancorado continua clicável com a lista cheia', async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize(VIEWPORTS[1]);
    await mockApi(page, 'ADMIN', baseURL!);
    await openExpandedSidebar(page, `/projects/${PERSONAL_ID}/monthly`);

    // O U1 governa a lista rolável de módulos; o bloco administrativo do #507
    // (Usuários) e o Apoio continuam ancorados e alcançáveis.
    for (const selector of ['a[aria-label="Apoio"]', 'a[aria-label="Usuários"]']) {
      await waitForStableRect(page, selector);
      await expectReachable(page, selector, SCROLLER);
    }
    // ...e o Budget nunca entra nos grupos do U1.
    await expect(page.locator('[data-nav-group] a[href*="budget-allocation"]')).toHaveCount(0);
  });

  test('REFORMA (lista única) rende um só grupo "Módulos", sem régua', async ({ page, baseURL }) => {
    await page.setViewportSize(VIEWPORTS[0]);
    await mockApi(page, 'USER', baseURL!);
    await page.goto(`/projects/${REFORMA_ID}/dashboard`);
    await expect(page.locator('[data-nav-group="modulos"]')).toBeVisible();

    await expect(page.locator(`${SCROLLER} [data-nav-group]`)).toHaveCount(1);
    await expect(page.locator('[data-nav-group="modulos"]')).toHaveAttribute(
      'data-nav-tier',
      'secondary',
    );
    await expect(page.locator('[data-nav-separator]')).toHaveCount(0);
    // Partição total na tela: `expenses` e `receipts` existem no rail.
    await expect(page.locator('[data-nav-group="modulos"] a[href$="/expenses"]')).toHaveCount(1);
    await expect(page.locator('[data-nav-group="modulos"] a[href$="/receipts"]')).toHaveCount(1);
  });
});
