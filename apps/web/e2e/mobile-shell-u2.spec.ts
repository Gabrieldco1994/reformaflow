import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * U2 (issue #451) — shell mobile, metade de MEDIÇÃO (Lane B / qa-engineer).
 *
 * ─── POR QUE ESTE ARQUIVO EXISTE ───────────────────────────────────────────
 *
 * jsdom NÃO TEM LAYOUT: `getBoundingClientRect()` devolve zeros e `0 >= 44`
 * passa em cima de nada. Toda asserção de GEOMETRIA, ALCANÇABILIDADE, OVERLAY,
 * FOCO e PRESERVAÇÃO-DE-URL vive aqui, em browser real. A ESTRUTURA (existe/
 * não existe, role, aria, contagem) fica no vitest, ao lado dos componentes.
 *
 * Três disciplinas inegociáveis (senão a cobertura vira carimbo):
 *  1. MEDE RUNTIME, não CSS — `getBoundingClientRect` + `elementFromPoint`, e o
 *     centro do alvo tem de cair dentro do recorte rolável (protocolo de 4
 *     passos, herdado de desktop-nav-groups.spec.ts). Caixa perfeita ≠
 *     alcançável (#507: 207×44 inalcançável).
 *  2. CONTA, não olha — duplicata é invisível para humano e óbvia para
 *     `filter((t,i)=>arr.indexOf(t)!==i)`.
 *  3. RELÓGIO CONGELADO num mês DELIBERADAMENTE ≠ do corrente — senão
 *     "preservou o mês" e "caiu no mês corrente" produzem o mesmo verde.
 *     `page.clock.setFixedTime` ANTES de navegar.
 *
 * ─── SEM SKIP SILENCIOSO ───────────────────────────────────────────────────
 *
 * O modo de falha nº 1 aqui é o teste que "passa" por não achar o que deveria
 * varrer. Todo caso assere a VISIBILIDADE do seletor congelado ANTES de medir,
 * para que um contrato ausente FALHE ALTO, nunca passe por acidente.
 *
 * ─── VOCABULÁRIO DE SELETOR CONGELADO (contrato com a Lane A) ──────────────
 *
 *   data-dock-slot="{slug}" · data-mais-count · data-active ·
 *   aria-current="page" · aria-label="Mês anterior"
 *
 * Precisa de um seletor fora dessa lista ⇒ é mudança de contrato, não ajuste
 * escondido no teste.
 *
 * ─── COBERTURA PARCIAL E DECLARADA ─────────────────────────────────────────
 *
 * A preservação de mês é ASSIMÉTRICA de propósito: o shell CARREGA `?mes` em
 * toda superfície, mas só `conta` e `expenses` LÊEM a URL nesta issue. `dre`,
 * `neutros` e `metas` continuam nascendo no mês corrente — U2-P21 fixa isso
 * como lista literal para que ninguém leia o verde do U2 como "mês preservado
 * em toda parte". Fora de escopo (não asserido): safe-area (Chromium resolve
 * env(safe-area-inset-*) como 0) e o bug de fuso das três `currentMonthKey`.
 */

// ── Identidades (o cookie sai do baseURL do runner, nunca de porta literal) ──
const PESSOAL_ID = 'u2-pessoal';
const MIN_TOUCH = 44;
const MIN_LABEL_PX = 11;

/**
 * Relógio: mês CORRENTE (agosto/2026) deliberadamente ≠ mês de TESTE
 * (março/2026). Sem essa diferença, "preservou" e "caiu no corrente"
 * colapsam no mesmo verde.
 */
const FROZEN_NOW = new Date('2026-08-20T12:00:00.000Z');
const TEST_MONTH = '2026-03';
const TEST_MONTH_LABEL = 'março de 2026';
const CURRENT_MONTH_LABEL = 'agosto de 2026';

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 390, height: 844 },
] as const;

/**
 * Shell-destinations que NÃO são `NavModule` (sem módulo, fora de PROJECT_NAV).
 * A Maria FICA no dock por decisão de produto (E-1), mas não entra em
 * `visibleNav`; por isso é excluída da partição de módulos (U2-E05) via lista
 * literal, não via seletor novo.
 */
const SHELL_DEST_SLUGS = ['maria', 'apoio', 'budget-allocation', 'users', 'settings'];

/** Módulos por perfil de permissão (papel × permissão da matriz §2.1). */
const MODULES = {
  full: ['monthlyOverview', 'expenses', 'receipts', 'cashFlow', 'creditCards', 'bankAccounts'],
  // tem monthlyOverview (⇒ monthly/conta visíveis) mas NÃO tem creditCards ⇒ U2-E21
  soMonthly: ['monthlyOverview'],
  soBank: ['bankAccounts'],
  reduced: ['expenses', 'receipts', 'creditCards', 'bankAccounts'],
  semNav: ['dashboard'], // 'dashboard' não existe em PROJECT_NAV[PESSOAL] ⇒ V=[]
} as const;

/**
 * `visibleNav` esperado (slugs), em ordem canônica de PROJECT_NAV[PESSOAL].
 * PINADO — cicatriz "a barrier test must not derive from the constant it
 * protects". Se PROJECT_NAV mudar, alguém edita aqui de propósito.
 */
const EXPECTED_V: Record<keyof typeof MODULES, string[]> = {
  full: ['monthly', 'conta', 'dre', 'neutros', 'expenses', 'receipts', 'recorrentes', 'metas', 'planning', 'planejador', 'cash-flow', 'credit-cards', 'bank-accounts'],
  soMonthly: ['monthly', 'conta', 'dre', 'neutros', 'planning', 'planejador'],
  soBank: ['bank-accounts'],
  reduced: ['expenses', 'receipts', 'recorrentes', 'metas', 'credit-cards', 'bank-accounts'],
  semNav: [],
};

function json(body: unknown) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) };
}

// Objetos mínimos para as telas do cockpit renderizarem (não [], que quebra a
// tipagem de resposta e prende a página no loading).
const accountView = {
  mesSelecionado: TEST_MONTH,
  caixaHoje: 1_010_100,
  entrouMes: 2_020_200,
  saiuMes: 3_030_300,
  faltaPagarMes: 4_040_400,
  recebimentosPrevistosMes: 5_050_500,
  sobraPrevista: 6_060_600,
  devoCartaoTotal: 0,
  cartoes: [],
  contas: [],
  saidas: [],
  comprasCartao: [],
  entradas: [],
  ticketMedio: { valor: 0, nCompras: 0, totalCompras: 0, serie6m: [], media6m: 0, deltaVsMediaPct: null },
};

// Mínimo p/ /conta não estourar: consome `dreData?.anual.saldoAcumuladoSerie`.
const dreOverview = {
  mensal: {
    mes: TEST_MONTH,
    resultado: 0,
    entradas: [],
    saidas: [],
    contaCorrente: { caixaHoje: 0, entrouMes: 0, saiuMes: 0, faltaPagarMes: 0, recebimentosPrevistosMes: 0, sobraPrevista: 0, despesaTotal: 0 },
  },
  anual: { ano: 2026, saldoAcumuladoSerie: [], serie: [], totaisEntradas: [], totaisSaidas: [], totaisGuardado: [], candidatos: [] },
};

const receipts = [
  { id: 'rec-1', valor: 850_000, data: '2026-03-05T12:00:00.000Z', tipo: 'PAGAMENTO', status: 'EM_CAIXA' },
];

interface MockOptions {
  role?: 'USER' | 'ADMIN';
  modules: readonly string[];
  projectType?: string;
  projectId?: string;
  projectName?: string;
  isGuest?: boolean;
}

async function mockApi(page: Page, baseURL: string, opts: MockOptions) {
  const {
    role = 'USER',
    modules,
    projectType = 'PESSOAL',
    projectId = PESSOAL_ID,
    projectName = 'Pessoal U2',
    isGuest = false,
  } = opts;

  // Cookie a partir do baseURL do runner — este monorepo roda várias worktrees
  // em paralelo e a porta pode estar ocupada por `next dev` de OUTRO agente.
  await page.context().addCookies([{ name: 'rf_token', value: 'u2', url: baseURL }]);
  await page.route('http://localhost:3001/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/auth/me') {
      return route.fulfill(
        json({
          id: 'u2-user',
          username: 'u2',
          name: 'Ana',
          role,
          isGuest,
          tenantId: 'u2-tenant',
          allowedModules: [...modules],
          allowedProjects: [projectId],
          allowedProjectTypes: [projectType],
        }),
      );
    }
    if (path === '/projects') {
      return route.fulfill(json([{ id: projectId, name: projectName, type: projectType }]));
    }
    if (path === `/projects/${projectId}`) {
      return route.fulfill(
        json({ id: projectId, name: projectName, type: projectType, onboardedAt: '2026-01-01T00:00:00.000Z' }),
      );
    }
    if (path === `/projects/${projectId}/receipts`) {
      return route.fulfill(json(receipts));
    }
    if (path.endsWith('/monthly-overview/account-view')) {
      return route.fulfill(json(accountView));
    }
    if (path.endsWith('/monthly-overview/dre-overview')) {
      return route.fulfill(json(dreOverview));
    }
    return route.fulfill(json([]));
  });
}

/** Prepara viewport + relógio congelado + mock, NESSA ordem (relógio antes de navegar). */
async function bootMobile(
  page: Page,
  baseURL: string,
  opts: MockOptions,
  viewport: { width: number; height: number } = VIEWPORTS[0],
) {
  await page.setViewportSize(viewport);
  await page.clock.setFixedTime(FROZEN_NOW);
  await mockApi(page, baseURL, opts);
}

/** Último segmento do href, sem query — o slug do módulo/destino. */
function slugOf(href: string): string {
  try {
    const url = new URL(href, 'http://localhost');
    const segs = url.pathname.split('/').filter(Boolean);
    return segs[segs.length - 1] ?? '';
  } catch {
    return href;
  }
}

/**
 * Protocolo obrigatório de alcançabilidade (ordem de desktop-nav-groups:217).
 * Pular qualquer passo reproduz o defeito do #507.
 */
async function expectReachable(target: Locator, name: string, scrollerSel: string | null = null) {
  await expect(target, `${name} não está visível — seletor congelado ausente?`).toBeVisible();
  await target.scrollIntoViewIfNeeded();
  const m = await target.evaluate((element, sel) => {
    const rect = element.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const topmost = document.elementFromPoint(cx, cy);
    const box = sel ? document.querySelector(sel) : null;
    const clip = box
      ? (() => {
          const r = box.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
        })()
      : { top: 0, bottom: document.documentElement.clientHeight, left: 0, right: document.documentElement.clientWidth };
    return {
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      cx: Math.round(cx),
      cy: Math.round(cy),
      hitsSelf: Boolean(topmost && (topmost === element || element.contains(topmost) || topmost.contains(element))),
      topmost: topmost ? `${topmost.tagName.toLowerCase()}.${(topmost.className ?? '').toString().slice(0, 50)}` : 'none',
      insideClip: cx >= clip.left && cx <= clip.right && cy >= clip.top && cy <= clip.bottom,
      clip: `${Math.round(clip.top)}..${Math.round(clip.bottom)}`,
    };
  }, scrollerSel);

  expect(m.height, `${name} sem altura de toque (h=${m.height})`).toBeGreaterThanOrEqual(MIN_TOUCH);
  expect(m.width, `${name} sem largura de toque (w=${m.width})`).toBeGreaterThanOrEqual(MIN_TOUCH);
  expect(m.hitsSelf, `${name} não recebe o clique — coberto por ${m.topmost}`).toBe(true);
  expect(m.insideClip, `${name} centro em y=${m.cy} fora do recorte ${m.clip} (#507)`).toBe(true);
}

// Abre o Mais pelo gatilho congelado e devolve a raiz do overlay.
async function openMais(page: Page): Promise<Locator> {
  const trigger = page.locator('[data-mais-count]');
  await expect(trigger, 'gatilho Mais [data-mais-count] ausente — Lane A ainda não marcou').toBeVisible();
  await trigger.click();
  const overlay = page.locator('[data-overlay="mais"]');
  await expect(overlay, 'overlay [data-overlay="mais"] não abriu').toBeVisible();
  return overlay;
}

// ───────────────────────────────────────────────────────────────────────────
// BEHAVIORAL REDs — provam defeito HOJE, sem depender de seletor da Lane A.
// ───────────────────────────────────────────────────────────────────────────

test.describe('U2 shell mobile — provas comportamentais', () => {
  // U2-E20 — RED→GREEN obrigatório (D11 / E-5). Usuário reduzido (só
  // bankAccounts) toca o card do PESSOAL ⇒ tem de aterrissar no slug ESPECÍFICO
  // /bank-accounts, nunca em /no-permission. Asserção NEGATIVA passa por
  // acidente, então aqui é o slug positivo. Falha hoje: getProjectHomePath usa
  // nav[0].slug (=monthly) sem filtrar permissão ⇒ AppShell → /no-permission.
  test('375 — U2-E20 usuário só bankAccounts abre o próprio PESSOAL pelo card em /bank-accounts', async ({
    page,
    baseURL,
  }) => {
    await bootMobile(page, baseURL!, { modules: MODULES.soBank });
    await page.goto('/projects');
    const card = page.locator('.md\\:hidden').getByText('Pessoal U2', { exact: false }).first();
    await expect(card).toBeVisible();
    await card.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${PESSOAL_ID}/bank-accounts$`));
  });

  // U2-P20 — deep-link direto /conta?mes=2026-03 tem de abrir MARÇO. Prova que
  // o mês é contrato de rota, não efeito colateral de clique. Falha hoje:
  // conta/page.tsx:29 nasce em useState(currentMonthKey()) e ignora a URL ⇒
  // mostra agosto/2026.
  test('375 — U2-P20 deep-link /conta?mes=2026-03 abre março, não o mês corrente', async ({
    page,
    baseURL,
  }) => {
    await bootMobile(page, baseURL!, { modules: MODULES.full });
    await page.goto(`/projects/${PESSOAL_ID}/conta?mes=${TEST_MONTH}`);
    const main = page.locator('main');
    await expect(main).toContainText(TEST_MONTH_LABEL);
    await expect(main).not.toContainText(CURRENT_MONTH_LABEL);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// TRAVAS — verdes HOJE na base atual. Se nascerem vermelhas, a base já está
// quebrada (não dependem de seletor da Lane A).
// ───────────────────────────────────────────────────────────────────────────

test.describe('U2 shell mobile — travas de regressão (verdes hoje)', () => {
  // U2-E19 — home do projeto não muda: card do hub (usuário completo) → /monthly.
  test('375 — [TRAVA] U2-E19 card do hub do usuário completo cai em /monthly', async ({ page, baseURL }) => {
    await bootMobile(page, baseURL!, { modules: MODULES.full });
    await page.goto('/projects');
    const card = page.locator('.md\\:hidden').getByText('Pessoal U2', { exact: false }).first();
    await expect(card).toBeVisible();
    await card.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${PESSOAL_ID}/monthly$`));
  });

  // U2-E17 — slug fora do dock continua alcançável por deep-link direto. Prova
  // que "sair do dock" ≠ "sumir". Usuário COM o módulo (monthlyOverview).
  test('375 — [TRAVA] U2-E17 deep-link /dre renderiza sem cair em /no-permission', async ({ page, baseURL }) => {
    await bootMobile(page, baseURL!, { modules: MODULES.full });
    await page.goto(`/projects/${PESSOAL_ID}/dre`);
    await expect(page).toHaveURL(new RegExp(`/projects/${PESSOAL_ID}/dre$`));
    await expect(page).not.toHaveURL(/no-permission/);
    const box = await page.locator('main').boundingBox();
    expect(box, '/dre sem <main> renderizado').not.toBeNull();
    expect(box!.height, '/dre <main> com caixa de altura zero').toBeGreaterThan(0);
  });

  // U2-E14 — paisagem: o rail desktop assume e o dock some (>=768px ⇒ md:hidden).
  test('812×375 — [TRAVA] U2-E14 paisagem cai no rail desktop, dock ausente', async ({ page, baseURL }) => {
    await bootMobile(page, baseURL!, { modules: MODULES.full }, { width: 812, height: 375 });
    await page.addInitScript(() => window.localStorage.setItem('lifeone:sidebar:collapsed', 'false'));
    await page.goto(`/projects/${PESSOAL_ID}/monthly`);
    await expect(page.locator('.minimal-sidebar')).toBeVisible();
    // Dock some por largura: nenhum dock (nome novo OU atual) visível.
    await expect(page.locator('[data-dock], .minimal-dock')).toBeHidden();
    await expectReachable(
      page.locator('a[data-nav-group="projetos"]'),
      'âncora Projetos (rail, paisagem)',
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// GEOMETRIA / ALCANÇABILIDADE / OVERLAY — RED até a Lane A marcar o DOM
// (data-dock, data-dock-slot, data-launcher, data-overlay, data-mais-count).
// Cada caso FALHA ALTO no guarda de presença — nunca passa por seletor ausente.
// ───────────────────────────────────────────────────────────────────────────

test.describe('U2 shell mobile — geometria do dock e do Mais', () => {
  for (const vp of VIEWPORTS) {
    // U2-E01 — só os TRÊS invariantes (monthly·conta·maria) + âncora + launcher.
    // NÃO menciona credit-cards: o 4º slot é empírico (se truncar a 375 desce pro
    // Mais). A partição U2-E05 é quem cobre o 4º, sem opinar sobre qual.
    test(`${vp.width} — U2-E01 dock: invariantes monthly·conta·maria + âncora + launcher alcançáveis`, async ({ page, baseURL }) => {
      await bootMobile(page, baseURL!, { modules: MODULES.full }, vp);
      await page.goto(`/projects/${PESSOAL_ID}/monthly`);
      const dock = page.locator('[data-dock]');
      await expect(dock, 'dock [data-dock] ausente — Lane A ainda não marcou o DOM').toBeVisible();
      for (const slug of ['monthly', 'conta', 'maria']) {
        await expectReachable(dock.locator(`[data-dock-slot="${slug}"]`), `slot invariante ${slug}`);
      }
      await expectReachable(page.locator('a[data-nav-group="projetos"]'), 'âncora Projetos (cabeçalho)');
      await expectReachable(page.locator('[data-launcher="true"]').first(), 'launcher do dock');
      // o que ESTÁ no dock tem de ser alcançável, sem opinar sobre a contagem.
      const slots = dock.locator('[data-dock-slot]');
      const n = await slots.count();
      expect(n, 'dock sem slots suficientes').toBeGreaterThanOrEqual(3);
      for (let i = 0; i < n; i++) {
        await expectReachable(slots.nth(i), `dock slot #${i}`);
      }
    });
  }

  // U2-E02 — nenhum destino do dock é COBERTO: elementFromPoint no centro devolve
  // o próprio (falha nomeia o topmost). Roda em /receipts, superfície do D6.
  test('375 — U2-E02 nenhum destino do dock é coberto (elementFromPoint devolve o próprio)', async ({ page, baseURL }) => {
    await bootMobile(page, baseURL!, { modules: MODULES.full });
    await page.goto(`/projects/${PESSOAL_ID}/receipts`);
    const dock = page.locator('[data-dock]');
    await expect(dock, 'dock [data-dock] ausente').toBeVisible();
    const covered = await dock.locator('[data-dock-slot], [data-launcher="true"]').evaluateAll((els) =>
      els
        .map((el) => {
          const r = el.getBoundingClientRect();
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          const self = Boolean(top && (top === el || el.contains(top) || top.contains(el)));
          return self
            ? null
            : {
                slug: el.getAttribute('data-dock-slot') ?? el.getAttribute('aria-label') ?? '?',
                top: top ? `${top.tagName.toLowerCase()}.${String(top.className).slice(0, 40)}` : 'none',
              };
        })
        .filter(Boolean),
    );
    expect(covered, `destino(s) coberto(s): ${JSON.stringify(covered)}`).toEqual([]);
  });

  // U2-E03 — rótulos do dock ≥11px, uma linha, não elipsados (D7 — text-[10px]).
  for (const vp of VIEWPORTS) {
    test(`${vp.width} — U2-E03 rótulos do dock ≥11px, 1 linha, sem elipse`, async ({ page, baseURL }) => {
      await bootMobile(page, baseURL!, { modules: MODULES.full }, vp);
      await page.goto(`/projects/${PESSOAL_ID}/monthly`);
      const dock = page.locator('[data-dock]');
      await expect(dock, 'dock [data-dock] ausente').toBeVisible();
      const bad = await dock.locator('[data-dock-slot]').evaluateAll((slots) => {
        const out: unknown[] = [];
        for (const slot of slots) {
          // rótulo = folha com texto próprio (evita medir wrapper/ícone).
          const leaves = [...slot.querySelectorAll<HTMLElement>('*')].filter(
            (el) => el.children.length === 0 && (el.textContent ?? '').trim().length > 0,
          );
          for (const el of leaves) {
            const fs = parseFloat(getComputedStyle(el).fontSize);
            const lines = el.getClientRects().length;
            const ellipsized = el.scrollWidth > el.clientWidth + 1;
            if (fs < 11 || lines !== 1 || ellipsized) {
              out.push({ text: (el.textContent ?? '').trim(), fs, lines, ellipsized });
            }
          }
        }
        return out;
      });
      expect(bad, `rótulo(s) ruins: ${JSON.stringify(bad)}`).toEqual([]);
    });
  }

  // U2-E04 — tiles do Mais ≥44×44, rótulo ≥11px, e o ÚLTIMO tile alcançável após
  // rolar (D7 — text-[10.5px]; e o último tile nunca foi medido).
  test('375 — U2-E04 Mais: tiles ≥44×44, rótulo ≥11px, último alcançável após rolar', async ({ page, baseURL }) => {
    await bootMobile(page, baseURL!, { modules: MODULES.full });
    await page.goto(`/projects/${PESSOAL_ID}/monthly`);
    const overlay = await openMais(page);
    const tiles = overlay.locator('a[href]');
    const n = await tiles.count();
    expect(n, 'Mais sem tiles').toBeGreaterThan(0);
    await expectReachable(tiles.nth(n - 1), 'último tile do Mais', '[data-overlay="mais"]');
    const bad = await tiles.evaluateAll((els) => {
      const out: unknown[] = [];
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width < 44 || r.height < 44) out.push({ href: el.getAttribute('href'), w: Math.round(r.width), h: Math.round(r.height) });
        const leaf = [...el.querySelectorAll<HTMLElement>('*')].find(
          (c) => c.children.length === 0 && (c.textContent ?? '').trim().length > 0,
        );
        if (leaf && parseFloat(getComputedStyle(leaf).fontSize) < 11) {
          out.push({ href: el.getAttribute('href'), fs: getComputedStyle(leaf).fontSize });
        }
      }
      return out;
    });
    expect(bad, `tile(s) ruins: ${JSON.stringify(bad)}`).toEqual([]);
  });

  // U2-E10 — /receipts de PESSOAL tem EXATAMENTE UM launcher visível. Conta a
  // UNIÃO de [data-launcher="true"] com os FABs de rota ATUAIS (por aria-label),
  // deduplicada por identidade: HOJE = 2 (D6, RED) — dock `+` (Lançar) + FAB
  // `Novo recebimento`, a ~2px, FAB z-40 sobre o dock; vira 1 (GREEN) quando o PO
  // liberar `shellOwnsLauncher`. Evidência bruta medida e reportada ao PO
  // (dock `+` @ y734 64×64 z-auto; FAB @ y676 56×56 z-40 → bordas a ~2px).
  test('375 — U2-E10 exatamente um launcher visível em /receipts (PESSOAL)', async ({ page, baseURL }) => {
    await bootMobile(page, baseURL!, { modules: MODULES.full });
    await page.goto(`/projects/${PESSOAL_ID}/receipts`);
    await page.locator('main').waitFor();
    const launchers = await page.evaluate(() => {
      const sel =
        '[data-launcher="true"], button[aria-label="Lançar"], button[aria-label="Novo recebimento"], [data-journey-action="receipt.new"]';
      const set = new Set<Element>();
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && getComputedStyle(el as HTMLElement).visibility !== 'hidden') set.add(el);
      }
      return set.size;
    });
    expect(launchers, 'D6: /receipts deve ter exatamente 1 launcher visível').toBe(1);
  });

  // U2-E11 — nenhum estouro horizontal: scrollers internos (excl. hidden/clip) +
  // fuga de caixa, no cabeçalho, dock e Mais (D10 — documentElement.scrollWidth
  // devolve 375 numa tela com corte, por isso varremos os scrollers internos).
  for (const vp of VIEWPORTS) {
    test(`${vp.width} — U2-E11 sem estouro horizontal no cabeçalho, dock e Mais`, async ({ page, baseURL }) => {
      await bootMobile(page, baseURL!, { modules: MODULES.full }, vp);
      await page.goto(`/projects/${PESSOAL_ID}/monthly`);
      await openMais(page);
      const findings = await page.evaluate((width) => {
        const out: unknown[] = [];
        for (const region of document.querySelectorAll('[data-mobile-header], [data-dock], [data-overlay]')) {
          for (const el of [region, ...region.querySelectorAll('*')]) {
            const cs = getComputedStyle(el as HTMLElement);
            if (cs.overflowX !== 'hidden' && cs.overflowX !== 'clip' && el.scrollWidth > el.clientWidth + 1) {
              out.push({ scan: 'scroller', tag: el.tagName.toLowerCase(), sw: el.scrollWidth, cw: el.clientWidth });
            }
            const r = el.getBoundingClientRect();
            if (r.right > width + 1 || r.left < -1) {
              out.push({ scan: 'escape', tag: el.tagName.toLowerCase(), left: Math.round(r.left), right: Math.round(r.right) });
            }
          }
        }
        return out;
      }, vp.width);
      expect(findings, `estouro(s): ${JSON.stringify(findings)}`).toEqual([]);
    });
  }

  // U2-E12 — alturas 500 e 400 (teclado): o dock inteiro cabe na viewport.
  for (const height of [500, 400]) {
    test(`375×${height} — U2-E12 dock inteiro dentro da viewport`, async ({ page, baseURL }) => {
      await bootMobile(page, baseURL!, { modules: MODULES.full }, { width: 375, height });
      await page.goto(`/projects/${PESSOAL_ID}/monthly`);
      const dock = page.locator('[data-dock]');
      await expect(dock, 'dock [data-dock] ausente').toBeVisible();
      const box = await dock.boundingBox();
      expect(box, 'dock sem caixa').not.toBeNull();
      expect(
        box!.y + box!.height,
        `dock ultrapassa a viewport (bottom=${Math.round(box!.y + box!.height)} > ${height})`,
      ).toBeLessThanOrEqual(height + 1);
    });
  }

  // U2-E13 — reduced motion zera transição/animação no shell (D9 — só o voice-orb
  // era coberto).
  test('375 — U2-E13 reduced motion: sem transição/animação no dock, overlay e cabeçalho', async ({ page, baseURL }) => {
    await bootMobile(page, baseURL!, { modules: MODULES.full });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`/projects/${PESSOAL_ID}/monthly`);
    await openMais(page);
    const moving = await page.evaluate(() => {
      const out: unknown[] = [];
      const has = (v: string) => v.split(',').some((s) => parseFloat(s) > 0);
      for (const region of document.querySelectorAll('[data-dock], [data-overlay], [data-mobile-header]')) {
        for (const el of [region, ...region.querySelectorAll('*')]) {
          const cs = getComputedStyle(el as HTMLElement);
          if (has(cs.transitionDuration) || has(cs.animationDuration)) {
            out.push({ tag: el.tagName.toLowerCase(), t: cs.transitionDuration, a: cs.animationDuration });
          }
        }
      }
      return out;
    });
    expect(moving, `elemento(s) ainda animando: ${JSON.stringify(moving)}`).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// PARTIÇÃO E PERMISSÃO — cobertura completa e sem duplicata, guardas de módulo.
// ───────────────────────────────────────────────────────────────────────────

test.describe('U2 shell mobile — partição e permissão', () => {
  // U2-E05 — partição: (dock ∪ Mais) de módulos === visibleNav, + maria; sem
  // duplicata. credit-cards em EXATAMENTE um dos dois (dock OU Mais), nunca nos
  // dois (D3) e nunca faltando (D1). Sobrevive aos dois desfechos do 4º slot.
  test('375 — U2-E05 dock ∪ Mais === visibleNav ∪ {maria}, sem duplicata', async ({ page, baseURL }) => {
    await bootMobile(page, baseURL!, { modules: MODULES.full });
    await page.goto(`/projects/${PESSOAL_ID}/monthly`);
    const dock = page.locator('[data-dock]');
    await expect(dock, 'dock [data-dock] ausente').toBeVisible();
    const dockSlugs = await dock.locator('[data-dock-slot]').evaluateAll((els) => els.map((e) => e.getAttribute('data-dock-slot') ?? ''));
    const overlay = await openMais(page);
    const maisRaw = await overlay.locator('a[href]').evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));
    const maisSlugs = maisRaw.map(slugOf).filter((s) => !SHELL_DEST_SLUGS.includes(s));
    const union = [...dockSlugs, ...maisSlugs];
    const dupes = union.filter((t, i) => union.indexOf(t) !== i);
    expect(dupes, `slug(s) em dois lugares (D3): ${dupes.join(',')}`).toEqual([]);
    expect(new Set(union), 'partição ≠ visibleNav ∪ {maria}').toEqual(new Set([...EXPECTED_V.full, 'maria']));
  });

  // U2-E16 — V vazio: a Maria FICA (decisão de produto; correção do PO ao spec).
  // Esperado ≠ spec §6.4 ("[data-dock] ausente"): dock PRESENTE contendo só o
  // slot da Maria, nenhum slot de módulo. O usuário não fica encalhado.
  test('375 — U2-E16 visibleNav vazio: dock presente com só a Maria (correção PO)', async ({ page, baseURL }) => {
    await bootMobile(page, baseURL!, { modules: MODULES.semNav });
    await page.goto(`/projects/${PESSOAL_ID}/maria`);
    const dock = page.locator('[data-dock]');
    await expect(dock, 'dock deve PERMANECER — Maria fica mesmo com V vazio').toBeVisible();
    const slugs = await dock.locator('[data-dock-slot]').evaluateAll((els) => els.map((e) => e.getAttribute('data-dock-slot') ?? ''));
    expect(slugs, 'dock com V vazio deve conter só maria').toEqual(['maria']);
    await expectReachable(page.locator('a[data-nav-group="projetos"]'), 'âncora Projetos (não encalha)');
  });

  // U2-E21 — usuário com monthlyOverview mas SEM creditCards NÃO vê o slot de
  // Cartões no dock. Prova o guarda de permissão do D2 (hoje MobileTabBar
  // renderiza Cartões incondicionalmente, :89). monthly/conta permanecem.
  test('375 — U2-E21 sem creditCards: dock sem slot de Cartões, com monthly/conta', async ({ page, baseURL }) => {
    await bootMobile(page, baseURL!, { modules: MODULES.soMonthly });
    await page.goto(`/projects/${PESSOAL_ID}/monthly`);
    const dock = page.locator('[data-dock]');
    await expect(dock, 'dock [data-dock] ausente').toBeVisible();
    await expect(dock.locator('[data-dock-slot="credit-cards"]'), 'Cartões não deve estar no dock sem o módulo (D2)').toHaveCount(0);
    await expect(dock.locator('[data-dock-slot="monthly"]')).toBeVisible();
    await expect(dock.locator('[data-dock-slot="conta"]')).toBeVisible();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// CABEÇALHO / ESCOPO — âncora Projetos é "Projetos", não "Voltar" (defeito hoje).
// ───────────────────────────────────────────────────────────────────────────

test.describe('U2 shell mobile — cabeçalho / escopo', () => {
  // U2-E18 — escopo no cabeçalho: tipo visível; âncora é "Projetos", não "Voltar".
  // aria-label="Projetos" prova o defeito HOJE (MobileHeader.tsx:28 é "Voltar
  // para projetos"); [data-scope-project-type] é o marcador da Lane A.
  test('375 — U2-E18 cabeçalho: data-scope-project-type=PESSOAL e âncora "Projetos"', async ({ page, baseURL }) => {
    await bootMobile(page, baseURL!, { modules: MODULES.full });
    await page.goto(`/projects/${PESSOAL_ID}/monthly`);
    const scope = page.locator('[data-scope-project-type]');
    await expect(scope, '[data-scope-project-type] ausente — Lane A ainda não marcou').toHaveAttribute(
      'data-scope-project-type',
      'PESSOAL',
    );
    const anchor = page.locator('a[data-nav-group="projetos"]');
    await expect(anchor, 'âncora Projetos ausente no cabeçalho mobile').toBeVisible();
    await expect(anchor, 'âncora deve ser "Projetos", não "Voltar para projetos"').toHaveAttribute('aria-label', 'Projetos');
  });
});
