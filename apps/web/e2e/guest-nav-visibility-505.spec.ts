import { expect, test, type Page } from "@playwright/test";
import { deriveObjectiveAccess, ProjectType } from "@reformaflow/domain";

/**
 * #505 — o portão de visibilidade do convidado de demonstração, medido no
 * navegador de verdade.
 *
 * ─── POR QUE ESTE ARQUIVO EXISTE ───────────────────────────────────────────
 *
 * Os testes de unidade (`auth-context.guest-visibility.test.tsx` e
 * `auth/guest-identity.spec.ts`) provam o PREDICADO e a CUNHAGEM. Nenhum dos
 * dois prova o que o usuário efetivamente ALCANÇA: jsdom não roda o
 * `AppShell`, não monta a sidebar, não navega e não redireciona. O defeito
 * desta issue era exatamente de alcance — o convidado via e clicava no
 * aplicativo inteiro.
 *
 * ─── O QUE SE ASSERTA ──────────────────────────────────────────────────────
 *
 * A jornada que a demonstração promete, na ordem em que ela acontece:
 *   (1) o convidado entra e o menu NÃO está vazio;
 *   (2) ele alcança PESSOAL e REFORMA, os dois tipos que `demo.service`
 *       semeia;
 *   (3) ele NÃO enxerga o que não lhe foi concedido (módulo de outro tipo de
 *       projeto nem o item administrativo "Usuários").
 *
 * (1) e (3) juntos são o ponto: endurecer sem conceder daria menu vazio — um
 * beco sem saída — e seria "verde" num teste que só olhasse (3).
 *
 * ─── DE ONDE VEM A PERMISSÃO ───────────────────────────────────────────────
 *
 * `allowedModules` é DERIVADO de `deriveObjectiveAccess`, a mesma função que
 * `auth.service.registerGuest` usa. Um literal escrito aqui passaria a valer
 * como segunda fonte de verdade e continuaria verde no dia em que o servidor
 * mudasse a concessão.
 *
 * ─── U4 (#453): POR QUE A ÂNCORA DO PESSOAL MUDOU ──────────────────────────
 *
 * Este arquivo NÃO exercita a guarda de 3 casos das rotas colapsadas — o
 * convidado TEM `monthlyOverview` (ver `deriveObjectiveAccess` acima), então
 * ele nunca cai no caso 3. O que mudou aqui é só o CARDÁPIO: `expenses`,
 * `receipts`, `credit-cards` e `bank-accounts` saíram de
 * `PROJECT_NAV[PESSOAL]` e viraram o hub `/conta`.
 *
 * A propriedade medida é a MESMA e continua valendo: "o convidado entra e o
 * menu NÃO está vazio — endurecer não pode virar beco sem saída". O que
 * envelheceu foi a ÂNCORA: no PESSOAL, a primeira ação que a demonstração
 * promete (as despesas que `demo.service` semeia) agora se alcança por
 * `/conta`, não por `/expenses`. Trocar a âncora preserva a propriedade;
 * APAGAR a asserção a destruiria — sem ela, "menu vazio" volta a passar.
 *
 * A ausência de `/expenses` no PESSOAL é assertada de PROPÓSITO (barreira):
 * se alguém devolver o slug ao nav, este teste fica VERMELHO e a decisão volta
 * à mesa em vez de reentrar de carona. No REFORMA `expenses` continua no nav e
 * continua sendo exigido — ver o teste de alcance dos dois tipos, abaixo.
 */

const PERSONAL_ID = "guest-505-pessoal";
const REFORMA_ID = "guest-505-reforma";

const GUEST_ACCESS = deriveObjectiveAccess([
  ProjectType.PESSOAL,
  ProjectType.REFORMA,
]);

/** Módulo real que pertence a COMPRA/CARRO — fora da concessão do convidado. */
const UNGRANTED_MODULE = "financing";

/**
 * AS DUAS FORMAS DA MESMA SESSÃO, e por que ambas são obrigatórias.
 *
 * `honesta` é o que o servidor cunha a partir do #505: papel SEM acesso total.
 * Ela prova a jornada, mas NÃO prova a metade cliente — com `role: 'USER'` o
 * `auth-context` antigo já se comportava.
 *
 * `legada` é a sessão que um convidado criado ANTES deste programa carrega no
 * cookie: `role: 'ADMIN'` com `isGuest: true`. É ela que exercita o
 * curto-circuito de papel no navegador — sem a correção do `auth-context` ela
 * revela o menu inteiro e o item "Usuários".
 *
 * As duas TÊM de produzir a mesma tela. É isso que "as duas metades coerentes"
 * significa, e é o que impede este arquivo de ficar verde por construção.
 */
const SESSION_SHAPES = [
  { id: "cunhagem honesta (servidor)", role: "USER" },
  { id: "sessão legada em cache (role ADMIN)", role: "ADMIN" },
] as const;

function json(body: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

/**
 * Monta a sessão do convidado exatamente como o servidor a cunha hoje:
 * papel SEM acesso total (`USER`), `isGuest: true` e o snapshot derivado.
 */
async function mockGuestSession(page: Page, baseURL: string, role: string) {
  await page
    .context()
    .addCookies([{ name: "rf_token", value: "guest-505", url: baseURL }]);
  await page.route("http://localhost:3001/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/auth/me") {
      return route.fulfill(
        json({
          id: "guest-505-user",
          username: "guest_505",
          name: "Convidado",
          role,
          isGuest: true,
          tenantId: "guest-505-tenant",
          allowedModules: [...GUEST_ACCESS.allowedModules],
          allowedProjects: [],
          allowedProjectTypes: [...GUEST_ACCESS.allowedProjectTypes],
        }),
      );
    }
    if (path === "/projects") {
      return route.fulfill(
        json([
          { id: PERSONAL_ID, name: "Pessoal (Demo)", type: "PESSOAL" },
          { id: REFORMA_ID, name: "Reforma (Demo)", type: "REFORMA" },
        ]),
      );
    }
    if (path === `/projects/${PERSONAL_ID}`) {
      return route.fulfill(
        json({
          id: PERSONAL_ID,
          name: "Pessoal (Demo)",
          type: "PESSOAL",
          onboardedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    }
    if (path === `/projects/${REFORMA_ID}`) {
      return route.fulfill(
        json({
          id: REFORMA_ID,
          name: "Reforma (Demo)",
          type: "REFORMA",
          onboardedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    }
    return route.fulfill(json([]));
  });
}

/**
 * A casca tem DUAS superfícies e o mesmo `isAdmin` alimenta as duas: a sidebar
 * no desktop (`DesktopSidebar`) e a folha "Mais" no celular (`MaisSheet`).
 * Medir só uma deixaria a outra livre para regredir — e o convidado de
 * demonstração chega majoritariamente pelo celular.
 */
for (const shape of SESSION_SHAPES) {
  test.describe(`#505 — convidado vê a demonstração, e só ela [${shape.id}]`, () => {
    test.describe("desktop (sidebar)", () => {
      test.skip(
        ({ viewport }) => (viewport?.width ?? 0) < 768,
        "a sidebar só existe em md+",
      );

      test("o menu NÃO está vazio (endurecer não pode virar beco sem saída)", async ({
        page,
        baseURL,
      }) => {
        await mockGuestSession(page, baseURL!, shape.role);
        await page.goto(`/projects/${PERSONAL_ID}/dashboard`);

        const nav = page.locator("nav").first();
        await expect(nav).toBeVisible();
        await expect(nav.locator("a")).not.toHaveCount(0);
        // U4 (#453): a primeira ação que a demonstração promete continua sendo
        // "despesas" — `demo.service` segue semeando nos dois projetos —, mas
        // no PESSOAL ela passou a ser alcançada pelo hub `/conta`. A âncora
        // mudou; a promessa, não.
        await expect(
          nav.locator(`a[href*="/projects/${PERSONAL_ID}/conta"]`).first(),
        ).toBeVisible();
        // Barreira: `expenses` NÃO volta ao nav do PESSOAL por acidente. Sem
        // esta linha, devolver o slug deixaria o teste verde e o colapso do U4
        // seria desfeito em silêncio.
        await expect(
          nav.locator(`a[href*="/projects/${PERSONAL_ID}/expenses"]`),
        ).toHaveCount(0);
      });

      test('NÃO recebe o item administrativo "Usuários"', async ({
        page,
        baseURL,
      }) => {
        await mockGuestSession(page, baseURL!, shape.role);
        await page.goto(`/projects/${PERSONAL_ID}/dashboard`);

        await expect(page.locator("nav").first()).toBeVisible();
        // O bloco só existe sob `isAdmin`. Com a sessão legada, é o `!isGuest`
        // do `auth-context` que o remove — nada mais.
        await expect(page.locator('a[href="/admin/users"]')).toHaveCount(0);
      });

      test("NÃO recebe módulo de tipo de projeto que não lhe foi concedido", async ({
        page,
        baseURL,
      }) => {
        // Pré-condição do próprio teste: se um dia `financing` entrar na
        // concessão do convidado, isto vira tautologia silenciosa em vez de
        // falhar.
        expect(GUEST_ACCESS.allowedModules).not.toContain(UNGRANTED_MODULE);

        await mockGuestSession(page, baseURL!, shape.role);
        await page.goto(`/projects/${PERSONAL_ID}/dashboard`);

        await expect(page.locator("nav").first()).toBeVisible();
        await expect(
          page.locator(`nav a[href*="/${UNGRANTED_MODULE}"]`),
        ).toHaveCount(0);
      });
    });

    test.describe('celular (folha "Mais")', () => {
      test.skip(
        ({ viewport }) => (viewport?.width ?? 0) >= 768,
        'a folha "Mais" só existe abaixo de md',
      );

      test('a folha abre e NÃO oferece o item administrativo "Usuários"', async ({
        page,
        baseURL,
      }) => {
        await mockGuestSession(page, baseURL!, shape.role);
        await page.goto(`/projects/${PERSONAL_ID}/dashboard`);

        const sheet = page.getByRole("dialog");
        // O clique tem de ser RETENTADO, não apenas aguardado: em `next dev` o
        // botão existe e é clicável antes de a hidratação ligar o handler, e
        // o primeiro clique cai no vazio sem erro nenhum. Medido: ~1 em 12
        // execuções abria folha nenhuma. `toPass` reclica até a folha existir.
        await expect(async () => {
          await page.getByRole("button", { name: "Mais opções" }).click();
          await expect(sheet).toBeVisible({ timeout: 1_000 });
        }).toPass({ timeout: 15_000 });
        // Âncora ANTI-VACUIDADE: sem ela, "não achei Usuários" poderia
        // significar apenas que a folha ainda não montou. O título é o nome do
        // projeto e só aparece com os dados assentados.
        //
        // Não se usa "a folha tem algum link": a grade só recebe os módulos
        // SECUNDÁRIOS, e para este convidado ela pode ser legitimamente vazia
        // — medido, essa asserção falhava ~1 em 12 execuções sem que nada
        // estivesse errado.
        await expect(sheet.getByText("Pessoal (Demo)")).toBeVisible();
        await expect(sheet.locator('a[href="/admin/users"]')).toHaveCount(0);
      });
    });

    test("alcança PESSOAL e REFORMA — os dois tipos que a demo semeia", async ({
      page,
      baseURL,
    }) => {
      await mockGuestSession(page, baseURL!, shape.role);

      for (const { projectId, destino } of [
        // U4 (#453): no PESSOAL a rota colapsou. O convidado TEM `expenses` e
        // `monthlyOverview`, então ele cai no caso 2 da guarda e é levado ao
        // hub `/conta`. A propriedade deste teste é "o convidado ALCANÇA os
        // dois tipos que a demo semeia" — não "a URL /expenses sobrevive".
        //
        // A asserção antiga (`/expenses` nos dois) passava por CORRIDA: a URL
        // ainda era /expenses no instante da medição e o redirect chegava
        // depois. Verde por acidente de timing é o mesmo que verde vazio.
        { projectId: PERSONAL_ID, destino: "conta" },
        { projectId: REFORMA_ID, destino: "expenses" },
      ]) {
        await page.goto(`/projects/${projectId}/expenses`);
        // Não basta a URL responder: a tela do módulo tem de MONTAR. `main` é
        // o único marco da casca que existe nos dois viewports (o cabeçalho é
        // `md:hidden` e a sidebar é `md+`), então serve aos dois projetos.
        await expect(page.locator("main").first()).toBeVisible();
        await expect(page).toHaveURL(
          new RegExp(`/projects/${projectId}/${destino}`),
        );
      }
    });
  });
}
