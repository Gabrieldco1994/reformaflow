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
 * toda superfície, mas só `monthly` (já lê/escreve) e `conta` (alvo dos REDs
 * P14/P20) INTERPRETAM a URL nesta issue. O `expenses` MÓVEL
 * (MobileExpensesScreen usa currentMonthKey(), NÃO lê a URL — fatia própria por
 * decisão do PO), `dre`, `neutros` e `metas` continuam nascendo no mês corrente
 * — U2-P21 fixa isso como lista literal para que ninguém leia o verde do U2 como
 * "mês preservado em toda parte". Fora de escopo (não asserido): safe-area
 * (Chromium resolve env(safe-area-inset-*) como 0) e o bug de fuso das três
 * `currentMonthKey`.
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
  // soBank / reduced: personas HISTÓRICAS. Ambas descrevem usuário de PESSOAL
  // sem `monthlyOverview` — estado que o #529 tornou impossível por definição
  // (`TYPE_MODULES[PESSOAL]` concede o módulo, e PESSOAL é o único tipo que
  // concede). Preservadas só como tabela de derivação do nav (função pura de
  // filtro por permissão); NÃO usar para dirigir navegação, ou o teste passa a
  // exercitar um perfil que a base não produz. Ver U2-E20.
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
  full: ['monthly', 'conta', 'dre', 'neutros', 'recorrentes', 'metas', 'planning', 'planejador', 'cash-flow'],
  soMonthly: ['monthly', 'conta', 'dre', 'neutros', 'planning', 'planejador'],
  soBank: [],
  reduced: ['recorrentes', 'metas'],
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
    // Oclusão por elementsFromPoint (pilha z, topo→base) ignorando SÓ o
    // <nextjs-portal>: é o host da toolbar/overlay do next dev, artefato que
    // NÃO existe em produção e cujo filho `fixed` no rodapé cobre o dock a
    // 375/390. Seu `:host{...!important}` de shadow vence qualquer CSS externo
    // (cascata shadow-inclusiva), então filtra-se aqui, não por estilo. Não
    // afrouxa a medição: um overlay REAL do app (div c/ z-index) permanece na
    // pilha e continua reprovando — provado por teste de injeção. (achado u2-qa)
    const stack = (document.elementsFromPoint(cx, cy) as Element[]).filter(
      (el) => el.tagName.toLowerCase() !== 'nextjs-portal',
    );
    const topmost = stack[0] ?? null;
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

/**
 * Texto VISÍVEL de um container (nós de texto cujos ancestrais não estão em
 * display:none/visibility:hidden e cuja caixa tem área). Necessário no shell
 * MÓVEL: as telas montam a variante mobile E a desktop (`hidden md:block`) no
 * MESMO DOM, então `toContainText`/textContent enxerga o texto OCULTO do desktop
 * e mente. Ex.: /expenses a 375 renderiza o picker mobile ("ago 26", visível) E
 * o ExpensesView desktop ("Mar 26", display:none) — só a leitura por
 * visibilidade prova o que o telefone MOSTRA. Junta com espaço para preservar
 * tokens quebrados em nós irmãos (o picker faz `{short} {yy}` → "ago"+"26").
 */
async function visibleTextOf(page: Page, selector: string): Promise<string> {
  return page.locator(selector).first().evaluate((root) => {
    const isVisible = (el: Element | null): boolean => {
      let cur: Element | null = el;
      while (cur) {
        const cs = getComputedStyle(cur);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
        cur = cur.parentElement;
      }
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const parts: string[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const value = (node.nodeValue ?? '').trim();
      if (value && isVisible((node as Text).parentElement)) parts.push(value);
    }
    return parts.join(' ');
  });
}

// ───────────────────────────────────────────────────────────────────────────
// BEHAVIORAL REDs — provam defeito HOJE, sem depender de seletor da Lane A.
// ───────────────────────────────────────────────────────────────────────────

test.describe('U2 shell mobile — provas comportamentais', () => {
  // U2-E20 — REESCRITO pelo #529. O teste original levava um usuário "só
  // bankAccounts" ao card do PESSOAL e exigia aterrissagem em /bank-accounts.
  // Essa rota deixou de ser destino: colapsou no hub e agora redireciona
  // SEMPRE. E a persona em si ficou impossível por definição —
  // `TYPE_MODULES[PESSOAL]` concede `monthlyOverview`, e PESSOAL é o único tipo
  // que concede, então quem tem um projeto PESSOAL recebe o módulo na leitura
  // (`reconcileUserModules`). Não existe usuário de PESSOAL sem o hub.
  //
  // O que sobrevive é a propriedade que o E20 sempre defendeu, e ela continua
  // valendo: abrir o próprio projeto pelo card NÃO pode terminar em
  // /no-permission. Mantida a doutrina do arquivo (asserção NEGATIVA passa por
  // acidente), o alvo é o slug POSITIVO — o cockpit, primeiro item do nav que
  // esta persona enxerga.
  test('375 — U2-E20 usuário de PESSOAL com bankAccounts abre o próprio card sem cair em /no-permission', async ({
    page,
    baseURL,
  }) => {
    // Persona REALIZÁVEL: o módulo da página + o `monthlyOverview` que o TIPO
    // concede. É o que a base produz de fato; `MODULES.soBank` modela um estado
    // que o #529 tornou inalcançável.
    await bootMobile(page, baseURL!, { modules: ['bankAccounts', 'monthlyOverview'] });
    await page.goto('/projects');
    const card = page.locator('.md\\:hidden').getByText('Pessoal U2', { exact: false }).first();
    await expect(card).toBeVisible();
    await card.click();
    await expect(
      page,
      'abrir o próprio projeto pelo card terminou em /no-permission',
    ).not.toHaveURL(/no-permission/);
    await expect(page).toHaveURL(new RegExp(`/projects/${PESSOAL_ID}/monthly$`));
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
    // Âncora "Projetos" existe no cabeçalho mobile E no rail; a 812 (>=md) o
    // cabeçalho é md:hidden → SÓ o rail está visível (medido: header visible:false,
    // rail visible:true; `.minimal-sidebar a[...]` resolve a EXATAMENTE 1). Escopo
    // por CONTAINER, não `.first()` — este não esconderia uma duplicata real.
    await expectReachable(
      page.locator('.minimal-sidebar a[data-nav-group="projetos"]'),
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
      // Âncora emitida no cabeçalho mobile E no rail (as duas variantes coexistem
      // por media query — tradeoff #490/D-D, a oculta fica display:none). A 375/390
      // (<md) só o cabeçalho é visível → escopo por CONTAINER, como E14/E18.
      await expectReachable(page.locator('[data-mobile-header] a[data-nav-group="projetos"]'), 'âncora Projetos (cabeçalho)');
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

  // U2-E02 [TRAVA de não-oclusão] — nenhum destino do dock é COBERTO:
  // elementFromPoint no centro devolve o próprio (falha nomeia o topmost). Roda
  // em /receipts, onde o FAB "Novo recebimento" (z-40) convive com o dock.
  // Correção do PO: FAB e dock `+` são ADJACENTES (sem oclusão), então esta TRAVA
  // fica verde assim que a Lane A montar `[data-dock]`; se o rework empilhar algo
  // sobre um slot, ela reprova nomeando o intruso. NÃO exige launcher único (isso
  // é o DIAG U2-E10) — por isso não cai junto com ele.
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

  // U2-E10 [DIAG] — REMOVIDO pelo #529, e removido porque o DEFEITO morreu,
  // não porque o teste incomodava.
  //
  // O E10 documentava dois botões redondos de mesmo ícone `Plus` colados em
  // /receipts: o launcher "Lançar" do dock e o FAB "Novo recebimento" da rota.
  // A colisão exigia as DUAS coisas na mesma tela. Hoje nenhum tipo reúne isso:
  //   - PESSOAL: /receipts colapsou e redireciona sempre (#529) — a página
  //     legada não monta, some o FAB;
  //   - REFORMA/COMPRA: /receipts existe, mas o launcher `+` vive só no ramo
  //     `hasFeature(type,'monthlyOverview')` do MobileTabBar, falso fora do
  //     PESSOAL — some o launcher.
  // Ou seja, o par ficou inalcançável em toda a matriz de tipos. Um DIAG que
  // não pode mais reproduzir seu estado não é diagnóstico: é ruído que fica
  // verde (ou vermelho) por motivo errado.
  //
  // Medição honesta: enquanto o caso 3 existiu, eu reproduzi o E10 nele — os
  // dois Plus continuavam adjacentes. Foi o #529, ao matar o caso 3, que
  // fechou a última porta. Se algum dia o launcher voltar a aparecer sobre uma
  // rota com FAB próprio, o E10 precisa ser reescrito a partir dessa tela, não
  // ressuscitado daqui.


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
    // Âncora no cabeçalho mobile E no rail (variantes por media query, #490/D-D);
    // a 375 só o cabeçalho é visível → escopo por CONTAINER, como E14/E18.
    await expectReachable(page.locator('[data-mobile-header] a[data-nav-group="projetos"]'), 'âncora Projetos (não encalha)');
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
  // A âncora "Projetos" é emitida no cabeçalho mobile E no rail desktop; a 375
  // (<md) o rail é hidden → SÓ o cabeçalho está visível (medido: header
  // visible:true, rail visible:false). Escopo por [data-mobile-header] resolve a
  // EXATAMENTE 1 — por CONTAINER, não `.first()` (que mascararia uma duplicata).
  test('375 — U2-E18 cabeçalho: data-scope-project-type=PESSOAL e âncora "Projetos"', async ({ page, baseURL }) => {
    await bootMobile(page, baseURL!, { modules: MODULES.full });
    await page.goto(`/projects/${PESSOAL_ID}/monthly`);
    const scope = page.locator('[data-scope-project-type]');
    await expect(scope, '[data-scope-project-type] ausente — Lane A ainda não marcou').toHaveAttribute(
      'data-scope-project-type',
      'PESSOAL',
    );
    const anchor = page.locator('[data-mobile-header] a[data-nav-group="projetos"]');
    await expect(anchor, 'âncora Projetos ausente no cabeçalho mobile').toBeVisible();
    await expect(anchor, 'âncora deve ser "Projetos", não "Voltar para projetos"').toHaveAttribute('aria-label', 'Projetos');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// OVERLAY ÚNICO E FOCO — mede por [data-overlay], NÃO por role=dialog.
//
// ARMADILHA (verificada em origin/main + tip da Lane A b255c0da): o Mais é
// role="dialog"+aria-modal+data-overlay="mais"; os sheets de LANÇAMENTO
// (mobile-launch/*) NÃO têm role=dialog, aria-modal nem Escape — o D5
// (sheets→diálogos) virou FOLLOW-UP, fora deste PR. Logo contar
// `[role=dialog][aria-modal]:visible` devolveria 1 com Mais E launch na tela (o
// launch é invisível para esse seletor) — VERDE exibindo o defeito. O enum
// overlay:'mais'|'launch'|null (D4) é a promessa real; [data-overlay] é o que a
// torna verificável NOS DOIS.
//
// ⚠️ LACUNA REPORTADA AO PO: o launch NÃO emite data-overlay="launch" hoje.
// Enquanto não emitir, E06/E07 nascem VERMELHOS nomeando a falta (nunca em
// silêncio). É a 1 linha na Lane A que prova a exclusão mútua — sem ela o U2 não
// consegue provar a própria promessa.
// ───────────────────────────────────────────────────────────────────────────

test.describe('U2 shell mobile — overlay único e foco', () => {
  // U2-E06 [D4] — abrir o launch com o Mais ABERTO não empilha dois overlays. O
  // enum torna a exclusão estrutural; dois booleans deixariam coexistir. Dispara
  // o onClick do `+` direto (ele fica atrás do Mais z-50; um clique real acertaria
  // o overlay/backdrop e fecharia o Mais) — teste de ESTADO do enum, não de
  // alcançabilidade (essa é do E01/E02).
  test('375 — U2-E06 abrir launch com o Mais aberto = um único overlay [data-overlay]', async ({ page, baseURL }) => {
    await bootMobile(page, baseURL!, { modules: MODULES.full });
    await page.goto(`/projects/${PESSOAL_ID}/monthly`);
    await openMais(page);
    await page.locator('button[aria-label="Lançar"]').dispatchEvent('click');
    const launch = page.locator('[data-overlay="launch"]');
    await expect(
      launch,
      'launch sem data-overlay="launch" — 1 linha na Lane A (segue o D5 follow-up); sem ela o "1 overlay" mente',
    ).toBeVisible();
    await expect(page.locator('[data-overlay="mais"]'), 'Mais não cedeu ao launch (enum D4 furou — dois overlays)').toBeHidden();
    await expect(page.locator('[data-overlay]:visible'), 'D4: esperado exatamente 1 overlay').toHaveCount(1);
  });

  // U2-E07 [D4] — launch aberto (deep-link), abrir o Mais por TECLADO não empilha.
  // Mesmo enum, gatilho a11y. Mede por [data-overlay].
  test('375 — U2-E07 launch aberto + Mais por teclado = um único overlay [data-overlay]', async ({ page, baseURL }) => {
    await bootMobile(page, baseURL!, { modules: MODULES.full });
    await page.goto(`/projects/${PESSOAL_ID}/monthly?launch=1`);
    const launch = page.locator('[data-overlay="launch"]');
    await expect(
      launch,
      'launch sem data-overlay="launch" — 1 linha na Lane A (segue o D5 follow-up); sem ela o teste mente',
    ).toBeVisible();
    const trigger = page.locator('[data-mais-count]');
    await expect(trigger, 'gatilho Mais [data-mais-count] ausente').toBeVisible();
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-overlay="mais"]'), 'Mais não abriu por teclado').toBeVisible();
    await expect(launch, 'launch não cedeu ao Mais (enum D4 furou — dois overlays)').toBeHidden();
    await expect(page.locator('[data-overlay]:visible'), 'D4: esperado exatamente 1 overlay').toHaveCount(1);
  });

  // U2-E08 — Escape fecha o Mais e devolve o foco ao gatilho. Foco/Escape são
  // asseridos SÓ no Mais (o único que os implementa). O launch NÃO tem Escape nem
  // retorno de foco — lacuna a11y do D5 (FOLLOW-UP, fora deste PR): não asserimos
  // o que sabemos não existir, e não o deixamos parecer coberto.
  test('375 — U2-E08 Escape fecha o Mais e devolve o foco ao gatilho', async ({ page, baseURL }) => {
    await bootMobile(page, baseURL!, { modules: MODULES.full });
    await page.goto(`/projects/${PESSOAL_ID}/monthly`);
    const trigger = page.locator('[data-mais-count]');
    await expect(trigger, 'gatilho Mais [data-mais-count] ausente').toBeVisible();
    await trigger.click();
    const overlay = page.locator('[data-overlay="mais"]');
    await expect(overlay, 'overlay do Mais não abriu').toBeVisible();
    await page.keyboard.press('Escape');
    await expect(overlay, 'Escape não fechou o Mais').toBeHidden();
    await expect(trigger, 'foco não voltou ao gatilho Mais').toBeFocused();
  });

  // U2-E09 — back do navegador fecha o overlay (Mais) em vez de sair da rota.
  test('375 — U2-E09 back fecha o overlay e mantém a rota', async ({ page, baseURL }) => {
    await bootMobile(page, baseURL!, { modules: MODULES.full });
    await page.goto(`/projects/${PESSOAL_ID}/monthly`);
    await openMais(page);
    await page.goBack();
    await expect(page, 'back saiu da rota em vez de fechar o overlay').toHaveURL(new RegExp(`${PESSOAL_ID}/monthly`));
    await expect(page.locator('[data-overlay="mais"]'), 'overlay ainda aberto após back').toBeHidden();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// PRESERVAÇÃO DE MÊS — relógio em agosto/2026, mês de teste março/2026.
// Duas asserções por caso: a URL carrega o mês (contrato do shell — MINHA lane)
// E o destino RENDERIZA março (o destino interpreta — sem isto o verde é vazio).
// Deep-link fixa o mês na origem sem depender do mock completo do seletor de
// meses; o defeito sob teste é o shell dropar o mês e o destino ignorá-lo.
// ───────────────────────────────────────────────────────────────────────────

test.describe('U2 shell mobile — preservação de mês', () => {
  // U2-P14 owns the rendered dock href; U2-P20 owns destination month
  // interpretation; U2-P17 owns real mobile dock click/launch behavior.
  test('375 — U2-P14 dock Conta href preserva o mês (monthly → conta)', async ({ page, baseURL }) => {
    await bootMobile(page, baseURL!, { modules: MODULES.full });
    await page.goto(`/projects/${PESSOAL_ID}/monthly?mes=${TEST_MONTH}`);
    const conta = page.locator('[data-dock-slot="conta"]');
    await expect(conta, 'slot conta ausente no dock — Lane A ainda não marcou').toBeVisible();
    await expect(conta, 'P14 deve assinar o href renderizado do dock').toHaveAttribute(
      'href',
      `/projects/${PESSOAL_ID}/conta?mes=${TEST_MONTH}`,
    );
  });

  // U2-P15 — monthly → Mais: o SHELL carrega `?mes` na URL. É só o que MINHA
  // lane pode provar aqui: o tile do Mais leva o mês adiante (mes OU period).
  // URL-ONLY por decisão do PO — a INTERPRETAÇÃO do mês pelo destino é fatia
  // própria (ver o DIAG P21, que declara `dre` entre os que ignoram `?mes`).
  //
  // U4 (#453): o tile era `expenses`, que saiu de `PROJECT_NAV[PESSOAL]` e
  // portanto sumiu do Mais — o locator não achava nada. Trocado por `dre`, que
  // continua no Mais. A propriedade ("o shell não dropa o mês ao navegar pelo
  // Mais") é a mesma e o teste segue URL-only pelo mesmo motivo: `dre` também
  // não lê a URL hoje, como o P21 declara.
  test('375 — U2-P15 shell carrega o mês ao Mais (monthly → dre), URL-only', async ({ page, baseURL }) => {
    await bootMobile(page, baseURL!, { modules: MODULES.full });
    await page.goto(`/projects/${PESSOAL_ID}/monthly?mes=${TEST_MONTH}`);
    const overlay = await openMais(page);
    const tile = overlay.locator('a[href*="/dre"]');
    await expect(tile, 'tile dre ausente no Mais — Lane A ainda não marcou').toBeVisible();
    await tile.click();
    // contrato do shell (minha lane): o mês viaja na URL (mes OU period). A
    // LEITURA pelo destino é fatia própria — ver o DIAG P21 `dre`.
    await expect(page, 'Mais dropou o mês (href sem mês)').toHaveURL(/\/dre\?.*(mes|period)=2026-03/);
  });

  // U2-P16 — 1280: mesma jornada no RAIL desktop (monthly → conta). O rail passa
  // o mesmo href ao link e ao isPathActive (DesktopSidebar.tsx:228) — o buraco
  // que a auditoria recusou, no lugar exato.
  test('1280 — U2-P16 mês sobrevive no rail desktop (monthly → conta)', async ({ page, baseURL }) => {
    await bootMobile(page, baseURL!, { modules: MODULES.full }, { width: 1280, height: 900 });
    await page.addInitScript(() => window.localStorage.setItem('lifeone:sidebar:collapsed', 'false'));
    await page.goto(`/projects/${PESSOAL_ID}/monthly?mes=${TEST_MONTH}`);
    const rail = page.locator('aside.minimal-sidebar');
    await expect(rail, 'rail desktop ausente a 1280').toBeVisible();
    const contaLink = rail.locator('a[href*="/conta"]').first();
    await expect(contaLink, 'link conta ausente no rail').toBeVisible();
    await contaLink.click();
    await expect(page, 'rail dropou o mês (href sem ?mes)').toHaveURL(new RegExp(`/conta\\?.*mes=${TEST_MONTH}`));
    await expect(page.locator('main'), '/conta ignorou ?mes').toContainText(TEST_MONTH_LABEL);
  });

  // U2-P17 — launch NÃO sobrevive (prova negativa): sair de ?launch=1 não reabre
  // a sheet, mas o mês sobrevive. Se alguém "consertar" com passthrough de
  // launch, ESTE teste reprova.
  test('375 — U2-P17 launch não reabre ao tocar o dock, mas o mês sobrevive', async ({ page, baseURL }) => {
    await bootMobile(page, baseURL!, { modules: MODULES.full });
    await page.goto(`/projects/${PESSOAL_ID}/monthly?launch=1&mes=${TEST_MONTH}`);
    const launch = page.locator('[data-overlay="launch"]');
    await expect(launch, 'launch overlay ausente — Lane A ainda não marcou').toBeVisible();
    await page.keyboard.press('Escape');
    await expect(launch, 'Escape não fechou o launch').toBeHidden();
    const conta = page.locator('[data-dock-slot="conta"]');
    await expect(conta, 'slot conta ausente no dock').toBeVisible();
    await conta.click();
    await expect(page.locator('[data-overlay="launch"]'), 'launch reabriu (passthrough proibido)').toHaveCount(0);
    await expect(page, 'mês não sobreviveu ao dock').toHaveURL(new RegExp(`/conta\\?.*mes=${TEST_MONTH}`));
  });

  // U2-P19 — estado ativo continua aceso com ?mes na URL: o slot corrente tem
  // data-active="true" E aria-current="page" (o §3 — usePathname não traz query,
  // então um href com ?mes mataria o estado ativo se não separassem pathHref).
  test('375 — U2-P19 estado ativo aceso com ?mes na URL (dock)', async ({ page, baseURL }) => {
    await bootMobile(page, baseURL!, { modules: MODULES.full });
    await page.goto(`/projects/${PESSOAL_ID}/monthly?mes=${TEST_MONTH}`);
    const slot = page.locator('[data-dock-slot="monthly"]');
    await expect(slot, 'slot monthly ausente no dock').toBeVisible();
    await expect(slot, 'estado ativo morreu com ?mes na URL (§3)').toHaveAttribute('data-active', 'true');
    await expect(slot, 'aria-current deve acender na página exata').toHaveAttribute('aria-current', 'page');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2ª PRIORIDADE — TRAVAs de regressão e DIAGNÓSTICO de cobertura parcial.
// ───────────────────────────────────────────────────────────────────────────

test.describe('U2 shell mobile — travas e diagnóstico (2ª prioridade)', () => {
  // U2-E15 [TRAVA] — usuário reduzido (sem monthlyOverview): NENHUM href do
  // SHELL (dock + cabeçalho + rail) aponta para módulo ausente. Escopo restrito
  // às raízes do shell — o corpo da página pode ter CTAs próprios (ex.: /expenses
  // linka /monthly no header editorial); isso é da PÁGINA, não do shell.
  // Verde HOJE (dock atual gateia cockpit/conta) e protege contra o rework
  // revelar monthly/conta/dre no shell por engano.
  test('375 — [TRAVA] U2-E15 reduzido: nenhum href de módulo ausente no shell', async ({ page, baseURL }) => {
    await bootMobile(page, baseURL!, { modules: MODULES.reduced });
    await page.goto(`/projects/${PESSOAL_ID}/expenses`);
    await expect(page.locator('[data-mobile-header]'), 'shell não renderizou — skip silencioso?').toBeVisible();
    const forbidden = ['monthly', 'conta', 'dre', 'neutros', 'planning', 'planejador', 'cash-flow'];
    const hrefs = await page.evaluate(() => {
      const roots = document.querySelectorAll(
        '[data-dock], .minimal-dock, [data-mobile-header], aside.minimal-sidebar, nav.minimal-sidebar',
      );
      const acc: string[] = [];
      for (const root of roots) for (const a of root.querySelectorAll('a[href]')) acc.push(a.getAttribute('href') ?? '');
      return acc;
    });
    const leaked = [...new Set(hrefs.map(slugOf).filter((s) => forbidden.includes(s)))];
    expect(leaked, `href(s) de módulo sem permissão vazando no SHELL: ${leaked.join(',')}`).toEqual([]);
  });

  // U2-P18 — focus NÃO vaza entre destinos (colisão de nome: credit-cards usa
  // `focus=closingDay`, bank-accounts usa `focus` para outra coisa). O shell só
  // carrega o allowlist (mes…) ao montar hrefs — buildNavHref DROPA focus.
  //
  // Mede o HREF DO TILE, sem navegar: origem `monthly?mes&focus` (modal-free —
  // monthly ignora focus). NÃO usa credit-cards como origem porque
  // `?focus=closingDay` lá abre um modal bg-black/40 z-50 (sem role/aria/Escape,
  // #522) que oclui o cabeçalho e intercepta o Mais — o teste mediria ATRAVÉS do
  // modal. buildNavHref é agnóstico de tela: o allowlist filtra igual em qualquer
  // origem, então o contrato se prova aqui sem depender daquele modal.
  test('375 — U2-P18 focus não vaza entre destinos (href do tile dropa focus)', async ({ page, baseURL }) => {
    await bootMobile(page, baseURL!, { modules: MODULES.full });
    await page.goto(`/projects/${PESSOAL_ID}/monthly?mes=${TEST_MONTH}&focus=closingDay`);
    const overlay = await openMais(page);
    // U4 (#453): o tile medido era `bank-accounts`, que saiu de
    // `PROJECT_NAV[PESSOAL]` e sumiu do Mais. `cash-flow` o substitui — segue no
    // Mais e serve igual, porque `buildNavHref` é agnóstico de tela: o que se
    // mede aqui é o ALLOWLIST, não o destino.
    const tile = overlay.locator('a[href*="/cash-flow"]');
    await expect(tile, 'tile cash-flow ausente no Mais — Lane A ainda não marcou').toBeVisible();
    const href = (await tile.getAttribute('href')) ?? '';
    // Positivo: o mês (allowlist) VIAJA — senão o negativo passaria por acidente
    // num href que simplesmente descartou toda a query.
    expect(href, `tile não carregou o mês do allowlist: ${href}`).toMatch(
      new RegExp(`/cash-flow\\?.*mes=${TEST_MONTH}`),
    );
    // Negativo (o contrato): focus NÃO está no allowlist ⇒ buildNavHref o dropa.
    expect(href, `focus vazou para o tile (não está no allowlist): ${href}`).not.toMatch(/focus=/);
  });

  // U2-P21 [DIAG, não bloqueia] — destinos AINDA NÃO cobertos por mês são
  // DECLARADOS. Lista LITERAL — quem cobrir um destino edita a lista de propósito
  // (cicatriz: "barrier test não deriva da constante que protege"). HOJE
  // dre/neutros/metas E o `expenses` MÓVEL IGNORAM ?mes (caem no mês corrente);
  // vira RED quando cada fatia entrar (E-9 p/ dre/neutros/metas; a de ligar o
  // expenses móvel à URL — fatia própria, decidida pelo PO). Existe para que
  // ninguém leia o verde do U2 como "mês preservado em toda parte" — a cobertura
  // de mês é PARCIAL E ASSIMÉTRICA (só `monthly` + `conta` interpretam a URL).
  //
  // Cada destino casa o TOKEN NO FORMATO QUE A TELA RENDERIZA, senão o negativo
  // passaria por ACIDENTE e nunca viraria RED: DRE usa monthLabelLong
  // ("março de 2026"); o expenses MÓVEL usa monthLabelShort + 2 dígitos de ano no
  // picker ("mar 26", MobileExpensesScreen:160) — "março de 2026" JAMAIS apareceria
  // lá, então o probe longo seria falso-verde. O expenses ganha guarda POSITIVA
  // (mostra "ago 26" hoje) para provar que o picker renderizou.
  //
  // ⚠️ MEDE TEXTO VISÍVEL (visibleTextOf), NÃO textContent. No shell móvel a tela
  // monta a variante mobile E a desktop (`hidden md:block`) no MESMO DOM. O
  // expenses DESKTOP (ExpensesView) LÊ ?mes e renderiza "Mar 26" — mas OCULTO a
  // 375px; o picker mobile VISÍVEL segue em "ago 26" (useState(currentMonthKey()),
  // MobileExpensesScreen:68, ignora a URL). `toContainText` enxergaria o "Mar 26"
  // OCULTO e falharia dizendo "expenses preservou o mês" — MENTIRA: o telefone
  // mostra agosto. Só a leitura por visibilidade prova o que o usuário vê. (Medido
  // na integração: visível = "…Despesas ago 26…", "Mar 26" tem visible:false.)
  const NAO_COBERTOS_POR_MES: Array<{ slug: string; mesTeste: RegExp; mesCorrente?: RegExp }> = [
    { slug: 'dre', mesTeste: /março de 2026/i },
    { slug: 'neutros', mesTeste: /março de 2026/i },
    { slug: 'metas', mesTeste: /março de 2026/i },
    // #529 removeu a entrada `expenses`. Ela media o picker do
    // `MobileExpensesScreen`, que só monta em PESSOAL e cuja rota agora sempre
    // redireciona — a lacuna declarada existia numa tela que ninguém alcança.
    // Mantê-la faria o DIAG medir o texto de `/conta`, que LÊ ?mes: passaria a
    // reprovar por "não mostrou o mês corrente", nomeando a tela errada.
    // A cobertura de mês segue PARCIAL (só `monthly` e `conta` interpretam a
    // URL); o que mudou é que `expenses` saiu da matriz de destinos do PESSOAL.
  ];
  for (const { slug, mesTeste, mesCorrente } of NAO_COBERTOS_POR_MES) {
    test(`375 — [DIAG] U2-P21 ${slug} ignora ?mes (cobertura parcial declarada)`, async ({ page, baseURL }) => {
      await bootMobile(page, baseURL!, { modules: MODULES.full });
      await page.goto(`/projects/${PESSOAL_ID}/${slug}?mes=${TEST_MONTH}`);
      await expect(page, `${slug} caiu em /no-permission`).not.toHaveURL(/no-permission/);
      // Timeout generoso: `next dev` compila a rota sob demanda na 1ª visita (/dre
      // mediu ~6s a frio) — o default de 5s é FLAKY na borda do compile, não um
      // defeito. Determinismo, não afrouxamento (a asserção de mês segue estrita).
      await expect(page.locator('main'), `${slug} sem main renderizado`).toBeVisible({ timeout: 20_000 });
      // Texto VISÍVEL apenas — o textContent inclui a variante desktop OCULTA que
      // JÁ lê ?mes; medir por visibilidade é o que impede o falso "mês preservado".
      const visivel = await visibleTextOf(page, 'main');
      // TRAVA DE VACUIDADE + ÂNCORA DE DESTINO. O DIAG mede o texto visível de
      // `main`; ele só significa algo se `main` for a tela que o teste nomeia.
      // Há DOIS jeitos de isso deixar de valer, e cada asserção pega um:
      //
      // 1) `main` VAZIO. Quando uma rota colapsa, a guarda devolve `null`
      //    enquanto o router.replace não assenta — `main` existe, está visível,
      //    e não tem texto. Sem esta trava o DIAG mede a string vazia e reprova
      //    lá embaixo em "não mostrou o mês", culpando o probe. Foi exatamente
      //    o que eu medi ao reinserir um slug colapsado aqui: url ainda
      //    `/expenses`, texto `''`. É o análogo do `not.toHaveBeenCalled()` que
      //    os testes unitários usam para não medir tela `null` em silêncio.
      //
      // 2) OUTRA tela. Se o redirect assentar antes da leitura, o texto é de
      //    outra rota e a URL denuncia.
      //
      // Ancorar a URL cedo não cobre nem um nem outro: logo após o `goto`, e
      // mesmo depois do `main` visível, a URL ainda é a de origem porque o
      // efeito de redirect não disparou. Medido nas duas posições antes desta.
      expect(
        visivel.trim(),
        `${slug} rendeu main VAZIO — provável rota colapsada; o DIAG não mediu tela nenhuma`,
      ).not.toBe('');
      await expect(
        page,
        `${slug} redirecionou — o texto medido acima é de OUTRA tela`,
      ).toHaveURL(new RegExp(`/projects/${PESSOAL_ID}/${slug}`));
      if (mesCorrente) {
        // sem isto o negativo passaria por acidente (tela sem rótulo de mês).
        expect(visivel, `${slug} não mostrou o mês CORRENTE (visível) — probe errado?`).toMatch(mesCorrente);
      }
      // HOJE não mostra o mês de TESTE no que é VISÍVEL (lê o corrente, não a URL).
      // Flip → RED quando a fatia MÓVEL entrar; então edite NAO_COBERTOS_POR_MES.
      expect(
        visivel,
        `${slug} JÁ preservou o mês (VISÍVEL) — a fatia móvel entrou? edite NAO_COBERTOS_POR_MES de propósito`,
      ).not.toMatch(mesTeste);
    });
  }
});
