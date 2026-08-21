import { expect, test, type Page } from '@playwright/test';

/**
 * U4 (issue #453) — redirect das 4 rotas colapsadas para o hub `/conta`.
 *
 * DOIS casos por rota colapsada (decisão do PO no #529 — o antigo "caso 3"
 * MORREU):
 *   1. Sem módulo da página → /no-permission
 *   2. Com módulo → /conta (redirect ao hub), INCONDICIONAL
 *
 * O que era o caso 3 ("com módulo, sem `monthlyOverview` → renderiza a página
 * legada") deixou de ser estado suportado no PESSOAL. Não removi aquele teste
 * em silêncio: ele virou o describe "U4-10c", que afirma a regra NOVA no mesmo
 * perfil que antes exercitava a regra velha. É uma asserção mais FORTE do que
 * a anterior, porque não depende mais de perfil de permissão nenhum — antes o
 * destino variava com `monthlyOverview`, agora é o mesmo para todo mundo que
 * tenha o módulo.
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
  opts: { role?: string; modules?: string[]; projectTypes?: string[] } = {},
) {
  const role = opts.role ?? 'ADMIN';
  const modules = opts.modules ?? ALL_MODULES;
  const projectTypes = opts.projectTypes ?? ['PESSOAL', 'REFORMA', 'CASA', 'CARRO'];
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
        allowedProjectTypes: [...projectTypes],
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

// ─── CASO 2 (cont.): SEM monthlyOverview a rota colapsada NÃO RENDERIZA ────
// Este describe ocupa o lugar do antigo "caso 3", que afirmava que este mesmo
// perfil renderizava a página legada. O #529 matou esse estado. Mantive o
// perfil idêntico (módulo da página SIM, `monthlyOverview` NÃO) de propósito:
// é o ÚNICO perfil que discrimina a mudança. Com `monthlyOverview` o destino
// já era /conta antes e depois — um teste assim passaria verde mesmo se alguém
// reintroduzisse `&& hasModule('monthlyOverview')`. Cobre os QUATRO slugs; o
// teste antigo cobria dois.
//
// O QUE ESTE TESTE APRENDEU (medido, não suposto): a primeira versão exigia
// aterrissagem em /conta e ficava verde isolada e VERMELHA na suíte cheia,
// recebendo /no-permission. Não era flake: /conta É o hub, e o hub exige
// `monthlyOverview` — que este perfil, por definição, não tem. Então a cadeia
// real é /<slug> → /conta → /no-permission, e /conta é um PONTO DE PASSAGEM.
// Sob carga o segundo salto assenta antes do meu poll. Eu estava ancorando um
// transitório e chamando de destino.
//
// A propriedade do #529 não é "vai para /conta"; é "a rota colapsada não
// renderiza mais a página legada, entrega ao hub e o hub decide". Por isso a
// asserção forte é SAIR do slug (determinística, e o que quebra se o caso 3
// voltar), e o destino assentado é registrado como /no-permission — que é a
// consequência honesta de um perfil que o #529 tornou inexistente.
const CONTENT_MARKER: Record<string, string> = {
  'bank-accounts': 'Nenhuma conta cadastrada',
  'credit-cards': 'Cartões de Crédito',
};

test.describe('U4-10c sem monthlyOverview: o redirect ao hub é INCONDICIONAL', () => {
  for (const slug of ['expenses', 'receipts', 'credit-cards', 'bank-accounts']) {
    test(`/${slug} sem monthlyOverview não renderiza a rota colapsada`, async ({ page, baseURL }) => {
      const modules = ALL_MODULES.filter((m) => m !== 'monthlyOverview');
      await mockApi(page, baseURL!, { role: 'USER', modules });
      await page.goto(`/projects/${PESSOAL_ID}/${slug}`);
      // A ASSERÇÃO DO #529: a rota colapsada deixa de ser destino. É ela que
      // fica vermelha se `&& hasModule('monthlyOverview')` voltar à guarda —
      // nesse caso o usuário PERMANECE aqui, com a página legada montada.
      await expect(
        page,
        `#529: /${slug} continuou sendo destino — o caso 3 voltou`,
      ).not.toHaveURL(new RegExp(`/projects/${PESSOAL_ID}/${slug}`), { timeout: 10_000 });
      // Destino ASSENTADO, medido: o hub exige `monthlyOverview`, então este
      // perfil é repassado adiante. Ancorar /conta seria ancorar o transitório.
      await expect(
        page,
        `destino assentado mudou — remedir a cadeia /${slug} → /conta → ?`,
      ).toHaveURL(/\/no-permission/, { timeout: 10_000 });
      // Barreira: se a página legada voltar a montar, o teste fica VERMELHO
      // dizendo o que voltou — em vez de passar por a URL ter oscilado.
      const marker = CONTENT_MARKER[slug];
      if (marker) {
        await expect(
          page.getByText(marker, { exact: false }),
          `a página legada de ${slug} renderizou — o caso 3 voltou`,
        ).toHaveCount(0);
      }
    });
  }
});

// ─── RESSALVA DO SRE: o legado `allowed_project_types = []` ────────────────
// O blast radius do #529 foi ~zero por uma razão ESTRUTURAL, não por sorte:
// `TYPE_MODULES[PESSOAL]` concede `monthlyOverview` e PESSOAL é o único tipo
// que concede, então quem tem PESSOAL em `allowed_project_types` recebe o
// módulo na leitura (`reconcileUserModules`) e nunca esteve no perfil de risco.
// A classe de risco era só o legado com `allowed_project_types = []`.
//
// Essa proteção é uma PROPRIEDADE DE DADOS, não do código desta página: se
// algum fluxo voltar a criar usuário com tipos vazios, a classe volta. Esta
// trava existe para que, se isso acontecer, a consequência apareça AQUI e não
// num ticket de suporte seis meses depois.
//
// MEDIDO (não suposto): o destino é `/no-permission`, NÃO `/conta`. Eu tinha
// escrito `/conta` e o teste ficou vermelho — a medição corrigiu a hipótese.
// A razão importa: `allowed_project_types = []` é barrado pelo gate de TIPO
// no `AppShell`, que roda ANTES da guarda desta página. Ou seja, a classe de
// risco do SRE tem DUAS proteções independentes: o gate de tipo e, depois, o
// redirect incondicional. O que esta trava afirma é a propriedade que interessa
// nas duas — o legado NUNCA renderiza a página colapsada.
test.describe('U4-10d trava: usuário legado sem allowed_project_types', () => {
  for (const slug of ['expenses', 'bank-accounts']) {
    test(`/${slug} com allowedProjectTypes=[] nunca renderiza a legada`, async ({ page, baseURL }) => {
      const modules = ALL_MODULES.filter((m) => m !== 'monthlyOverview');
      await mockApi(page, baseURL!, { role: 'USER', modules, projectTypes: [] });
      await page.goto(`/projects/${PESSOAL_ID}/${slug}`);
      // 1ª camada: o gate de TIPO barra antes da guarda da página.
      await expect(
        page,
        'usuário legado (tipos vazios) não caiu no gate de tipo — a 1ª camada saiu',
      ).toHaveURL(/\/no-permission/, { timeout: 10_000 });
      // A propriedade que importa, independente de QUAL camada barrou: a rota
      // colapsada não montou. Se um dia o gate de tipo mudar, esta linha segue
      // valendo e o teste continua dizendo a verdade.
      await expect(
        page,
        `a rota colapsada /${slug} montou para o usuário legado`,
      ).not.toHaveURL(new RegExp(`/projects/${PESSOAL_ID}/${slug}`));
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
