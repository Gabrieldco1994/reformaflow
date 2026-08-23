import { expect, test, type Page } from "@playwright/test";

/**
 * E2E DINÂMICO DE JORNADAS (Etapa D do épico #338).
 *
 * Intercepta `GET /journeys/eligible` devolvendo jornadas de TAMANHOS
 * DIFERENTES e conclui o fluxo percorrendo a configuração devolvida — nunca uma
 * lista fixa de passos. Trocar uma jornada de 4 para 6 etapas em produção não
 * pode exigir nenhuma edição neste arquivo: o único número que aparece abaixo é
 * o `stepCount` do CENÁRIO, e as asserções derivam dele.
 *
 * O contrato consumido aqui é o mesmo do domínio (`resolveJourneyPlan`):
 * passos habilitados, na ordem de `order`, com `SKIP` fora do denominador.
 */

const PANEL = "[data-journey-panel]";
const PROGRESS = "[data-journey-progress]";
const STEP = "[data-journey-step]";

interface EligibleStep {
  stepKey: string;
  order: number;
  enabled: boolean;
  skippable: boolean;
  experience: "SUMMARY" | "FULL";
  label: string;
  subtitle: string | null;
}

/** Builder do payload de `eligible` — espelho do `makeStep` do domínio. */
function step(
  overrides: Partial<EligibleStep> & { stepKey: string; order: number },
): EligibleStep {
  return {
    enabled: true,
    skippable: true,
    experience: "FULL",
    label: overrides.stepKey,
    subtitle: null,
    ...overrides,
  };
}

/**
 * `stepKey`s REAIS do catálogo (`knownStepKeys`, ativo desde a Etapa E parte 2)
 * — nunca sintéticos como "step-1". Com o guard ligado, um `stepKey` que o
 * runtime não reconhece é filtrado do plano (`UNKNOWN_STEP_KEY`), então um
 * fixture com chave inventada simplesmente não aparece na tela, e os testes
 * que dependem de "a etapa N está visível" quebram por engano — não porque o
 * runtime tem bug, mas porque o fixture nunca existiu no catálogo. Pool
 * grande o bastante para as jornadas de várias etapas deste arquivo (até 6)
 * sem repetir chave dentro da mesma jornada.
 */
const KNOWN_STEP_KEY_POOL = [
  "expense",
  "receipt",
  "bill",
  "car",
  "plant",
  "dashboard",
  "cash-flow",
  "conta",
  "dre",
  "neutros",
];

function steps(
  count: number,
  decorate: (index: number) => Partial<EligibleStep> = () => ({}),
) {
  return Array.from({ length: count }, (_, index) =>
    step({
      stepKey: KNOWN_STEP_KEY_POOL[index % KNOWN_STEP_KEY_POOL.length],
      order: index,
      ...decorate(index),
    }),
  );
}

function journey(overrides: {
  key?: string;
  steps: EligibleStep[];
  repeatPolicy?: "ONCE_PER_USER" | "ONCE_PER_PROJECT" | "ALWAYS";
  targetScope?: "ALL_PROJECTS" | "PROJECT_TYPE" | "PROJECT";
  allowCrossProjectNavigation?: boolean;
}) {
  return {
    key: overrides.key ?? "e2e:journey",
    name: "Jornada E2E",
    active: true,
    targetScope: overrides.targetScope ?? "ALL_PROJECTS",
    targetProjectType: null,
    targetProjectId: null,
    repeatPolicy: overrides.repeatPolicy ?? "ONCE_PER_USER",
    allowCrossProjectNavigation: overrides.allowCrossProjectNavigation ?? false,
    steps: overrides.steps,
    triggers: [
      {
        triggerType: "SCREEN_VISIT",
        screenKey: "monthly",
        actionKey: null,
        device: "any",
        active: true,
      },
    ],
  };
}

const apiUser = {
  id: "u1",
  username: "maria",
  name: "Maria",
  role: "USER",
  tenantId: "t1",
  allowedProjectTypes: ["PESSOAL"],
  allowedModules: ["monthlyOverview", "dashboard", "expenses"],
  allowedProjects: [],
};

async function stubSession(page: Page) {
  await page
    .context()
    .addCookies([
      { name: "rf_token", value: "test-session", url: "http://localhost:3013" },
    ]);
  await page.route("**/auth/me", (route) => route.fulfill({ json: apiUser }));
  await page.route("**/auth/config", (route) =>
    route.fulfill({ json: { registerEnabled: false, guestEnabled: false } }),
  );
  await page.route("**/projects", (route) =>
    route.fulfill({ json: [{ id: "p1", name: "Pessoal", type: "PESSOAL" }] }),
  );
  await page.route("**/projects/p1", (route) =>
    route.fulfill({ json: { id: "p1", name: "Pessoal", type: "PESSOAL" } }),
  );
  await page.route("**/journeys/*/complete", (route) =>
    route.fulfill({ status: 204, body: "" }),
  );
}

async function stubEligible(
  page: Page,
  journeys: ReturnType<typeof journey>[],
) {
  await page.route("**/journeys/eligible*", (route) =>
    route.fulfill({ json: journeys }),
  );
}

/** Passos que o executor DEVE mostrar, derivados do payload (mesma regra do domínio). */
function expectedSteps(config: EligibleStep[]) {
  return [...config].sort((a, b) => a.order - b.order).filter((s) => s.enabled);
}

/** Percorre TODO o plano clicando em Continuar, sem conhecer o tamanho. */
async function walkJourney(page: Page, expected: EligibleStep[]) {
  for (let index = 0; index < expected.length; index += 1) {
    await expect(page.locator(STEP)).toHaveAttribute(
      "data-journey-step",
      expected[index].stepKey,
    );
    await expect(page.locator(PROGRESS)).toHaveText(
      `${index + 1}/${expected.length}`,
    );
    await page.locator(PANEL).getByRole("button", { name: /Continuar|Concluir/ }).click();
  }
  await expect(page.locator(PANEL)).toHaveCount(0);
}

test.describe("jornada dirigida pela configuração devolvida por /journeys/eligible", () => {
  for (const stepCount of [1, 4, 6]) {
    test(`conclui uma jornada de ${stepCount} etapas percorrendo o payload`, async ({
      page,
    }) => {
      const config = steps(stepCount);
      await stubSession(page);
      await stubEligible(page, [journey({ steps: config })]);

      await page.goto("/projects/p1/monthly");

      await walkJourney(page, expectedSteps(config));
    });
  }

  test("jornada vazia não abre painel nenhum", async ({ page }) => {
    await stubSession(page);
    await stubEligible(page, [journey({ steps: [] })]);

    await page.goto("/projects/p1/monthly");

    await expect(page.locator(PANEL)).toHaveCount(0);
  });

  test("jornada desativada não abre", async ({ page }) => {
    await stubSession(page);
    await stubEligible(page, []);

    await page.goto("/projects/p1/monthly");

    await expect(page.locator(PANEL)).toHaveCount(0);
  });

  test("envia screenKey e retoma o passo persistido após reload", async ({
    page,
  }) => {
    const config = steps(5);
    const requestedScreens: Array<string | null> = [];
    await stubSession(page);
    await page.route("**/journeys/eligible*", (route) => {
      const screenKey = new URL(route.request().url()).searchParams.get(
        "screenKey",
      );
      requestedScreens.push(screenKey);
      if (!screenKey) {
        return route.fulfill({
          status: 400,
          json: { message: "SCREEN_VISIT exige screenKey na consulta." },
        });
      }
      return route.fulfill({ json: [journey({ steps: config })] });
    });

    await page.goto("/projects/p1/monthly");
    await expect(page.locator(PROGRESS)).toHaveText("1/5");
    await page
      .locator(PANEL)
      .getByRole("button", { name: "Continuar" })
      .click();
    await expect(page.locator(PROGRESS)).toHaveText("2/5");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const raw = sessionStorage.getItem("lifeone:journey-runtime");
          return raw ? JSON.parse(raw).stepIndex : null;
        }),
      )
      .toBe(1);
    expect(requestedScreens).toEqual(["monthly"]);

    await page.reload();

    await expect(page.locator(PROGRESS)).toHaveText("2/5");
    expect(requestedScreens).toEqual(["monthly"]);
  });

  test("passo desligado sai do fluxo e do denominador do progresso", async ({
    page,
  }) => {
    const config = steps(6, (index) => (index === 2 ? { enabled: false } : {}));
    await stubSession(page);
    await stubEligible(page, [journey({ steps: config })]);

    await page.goto("/projects/p1/monthly");

    await walkJourney(page, expectedSteps(config));
  });

  // A condição SKIP/BLOCK por passo (`conditionKey`/`conditionUnmetBehavior`)
  // nunca existiu no modelo Prisma `JourneyStep` — o código que a consumia em
  // `resolveJourneyPlan` era morto (nunca executou em produção) e foi removido
  // em `packages/domain/src/config/journey-plan.ts`. O teste que existia aqui
  // ("condição SKIP some e BLOCK permanece no plano sem avançar") testava só
  // o fixture do e2e, não o comportamento real da API — removido junto.

  test("reorder do admin muda a ordem percorrida", async ({ page }) => {
    // Chaves REAIS do catálogo (não "primeiro"/"meio"/"ultimo" — esses eram
    // só rótulos semânticos). A ordem é sempre a do campo `order`, nunca a do
    // nome da chave nem a da posição no array declarado abaixo.
    const config = [
      step({ stepKey: "dashboard", order: 9 }), // último, apesar de vir primeiro no array
      step({ stepKey: "expense", order: 0 }), // primeiro
      step({ stepKey: "receipt", order: 5 }), // meio
    ];
    await stubSession(page);
    await stubEligible(page, [journey({ steps: config })]);

    await page.goto("/projects/p1/monthly");

    await walkJourney(page, expectedSteps(config));
  });

  // Regressão (Etapa E parte 2): um `stepKey` operacional (`expense`, `bill`
  // etc.) some com o rodapé genérico quando a experiência é SUMMARY — o
  // componente real assume as próprias ações. Este teste mede o painel
  // GENÉRICO (que renderiza `data-journey-experience` e avança via
  // "Continuar"/"Concluir"), então usa chaves SUMMARY do catálogo
  // INFORMATIVO (sem componente operacional) para as etapas resumidas —
  // "expense"/"bill" continuam cobertos, só que como etapas FULL aqui.
  test("mistura SUMMARY/FULL: cada etapa renderiza a experiência configurada", async ({
    page,
  }) => {
    const config = [
      step({ stepKey: "conta", order: 0, experience: "SUMMARY" }),
      step({ stepKey: "expense", order: 1, experience: "FULL" }),
      step({ stepKey: "cash-flow", order: 2, experience: "SUMMARY" }),
      step({ stepKey: "bill", order: 3, experience: "FULL" }),
    ];
    await stubSession(page);
    await stubEligible(page, [journey({ steps: config })]);

    await page.goto("/projects/p1/monthly");

    for (const expected of expectedSteps(config)) {
      await expect(page.locator(STEP)).toHaveAttribute(
        "data-journey-experience",
        expected.experience,
      );
      await page.locator(PANEL).getByRole("button", { name: /Continuar|Concluir/ }).click();
    }
  });

  test("etapa obrigatória não oferece Pular", async ({ page }) => {
    const config = steps(2, (index) => ({ skippable: index !== 0 }));
    await stubSession(page);
    await stubEligible(page, [journey({ steps: config })]);

    await page.goto("/projects/p1/monthly");

    // O painel precisa estar de pé: sem isto o `toHaveCount(0)` abaixo passa
    // vacuamente quando a jornada nem abre.
    await expect(page.locator(PANEL)).toBeVisible();
    await expect(
      page.locator(PANEL).getByRole("button", { name: "Pular" }),
    ).toHaveCount(0);
  });

  // Regressão: com `knownStepKeys` ativo (Etapa E, parte 2), um `stepKey` que
  // o runtime não reconhece é filtrado do plano (`UNKNOWN_STEP_KEY`,
  // resolveJourneyPlan) — nunca aparece na trilha, e a jornada segue com os
  // passos conhecidos ao redor dele, sem travar nem quebrar a tela. É o
  // "fallback seguro" ponta-a-ponta: o admin pode ter salvo uma etapa cujo
  // componente saiu de um deploy futuro, e ninguém trava por causa disso.
  test("stepKey desconhecido some do plano (fallback seguro) e não derruba a aplicação", async ({
    page,
  }) => {
    const config = [
      step({ stepKey: "expense", order: 0 }),
      step({ stepKey: "chave-nunca-cadastrada-no-catalogo", order: 1 }),
      step({ stepKey: "receipt", order: 2 }),
    ];
    await stubSession(page);
    await stubEligible(page, [journey({ steps: config })]);

    await page.goto("/projects/p1/monthly");

    const expectedKnown = config.filter(
      (s) => s.stepKey !== "chave-nunca-cadastrada-no-catalogo",
    );
    await walkJourney(page, expectedKnown);

    // A aplicação segue de pé depois de concluir — nenhuma etapa desconhecida
    // derrubou a tela nem travou o fluxo no meio do caminho.
    await expect(page.locator("body")).toBeVisible();
  });

  test("configuração alterada entre duas execuções: 4 etapas, depois 6, sem rebuild", async ({
    page,
  }) => {
    await stubSession(page);

    await stubEligible(page, [
      journey({ steps: steps(4), repeatPolicy: "ALWAYS" }),
    ]);
    await page.goto("/projects/p1/monthly");
    await walkJourney(page, expectedSteps(steps(4)));

    // O admin publica 6 etapas; nenhum deploy da web aconteceu no meio.
    await page.unroute("**/journeys/eligible*");
    await stubEligible(page, [
      journey({ steps: steps(6), repeatPolicy: "ALWAYS" }),
    ]);
    await page.reload();

    await walkJourney(page, expectedSteps(steps(6)));
  });

  test("ALWAYS reabre a jornada na visita seguinte; ONCE_PER_USER não", async ({
    page,
  }) => {
    await stubSession(page);
    await stubEligible(page, [
      journey({ steps: steps(1), repeatPolicy: "ALWAYS" }),
    ]);

    await page.goto("/projects/p1/monthly");
    await walkJourney(page, expectedSteps(steps(1)));

    await page.reload();
    await expect(page.locator(PANEL)).toBeVisible();

    // A retomada por sessionStorage é para jornada EM ANDAMENTO — o painel
    // reaberto pelo ALWAYS acima ainda não foi concluído/dispensado, então
    // ele PRECISA sobreviver a um reload (regra de ouro #13 da sessão: jornada
    // em andamento continua sendo retomada). Sem concluir aqui, o próximo
    // reload reabriria este MESMO painel a partir do sessionStorage,
    // independente do que a API responder — não seria uma checagem real de
    // "ONCE_PER_USER não reabre", e sim um alarme falso.
    await walkJourney(page, expectedSteps(steps(1)));

    // Concluída para ONCE_PER_USER: a API deixa de devolvê-la.
    await page.unroute("**/journeys/eligible*");
    await stubEligible(page, []);
    await page.reload();
    await expect(page.locator(PANEL)).toHaveCount(0);
  });

  test("falha de rede ao carregar as jornadas não derruba a tela", async ({
    page,
  }) => {
    await stubSession(page);
    await page.route("**/journeys/eligible*", (route) => route.abort("failed"));

    await page.goto("/projects/p1/monthly");

    await expect(page.locator(PANEL)).toHaveCount(0);
    await expect(page.locator("body")).toBeVisible();
  });
});
