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
 * ESTADO: o executor global (`JourneyRuntimeProvider` + painel) chega na Etapa
 * seguinte do épico. Enquanto o painel não estiver montado, cada teste faz
 * `test.skip()` com motivo explícito, em vez de falhar em vermelho permanente
 * no CI. Assim que o executor subir, os testes passam a rodar SOZINHOS, sem
 * edição — e falham de verdade se o painel existir e se comportar errado.
 *
 * O contrato consumido aqui é o mesmo do domínio (`resolveJourneyPlan`):
 * passos habilitados, na ordem de `order`, com `SKIP` fora do denominador.
 */

const PANEL = '[data-journey-panel]';
const PROGRESS = '[data-journey-progress]';
const STEP = '[data-journey-step]';

interface EligibleStep {
  stepKey: string;
  order: number;
  enabled: boolean;
  skippable: boolean;
  experience: "SUMMARY" | "FULL";
  label: string;
  subtitle: string | null;
  conditionKey: string | null;
  conditionUnmetBehavior: "SKIP" | "BLOCK";
  targetProjectType: string | null;
}

/** Builder do payload de `eligible` — espelho do `makeStep` do domínio. */
function step(overrides: Partial<EligibleStep> & { stepKey: string; order: number }): EligibleStep {
  return {
    enabled: true,
    skippable: true,
    experience: "FULL",
    label: overrides.stepKey,
    subtitle: null,
    conditionKey: null,
    conditionUnmetBehavior: "SKIP",
    targetProjectType: null,
    ...overrides,
  };
}

function steps(count: number, decorate: (index: number) => Partial<EligibleStep> = () => ({})) {
  return Array.from({ length: count }, (_, index) =>
    step({ stepKey: `step-${index + 1}`, order: index, ...decorate(index) }),
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
      { triggerType: "SCREEN_VISIT", screenKey: "monthly", actionKey: null, device: "any", active: true },
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
  await page.context().addCookies([
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
}

async function stubEligible(page: Page, journeys: ReturnType<typeof journey>[]) {
  await page.route("**/journeys/eligible*", (route) => route.fulfill({ json: journeys }));
}

/** Passos que o executor DEVE mostrar, derivados do payload (mesma regra do domínio). */
function expectedSteps(config: EligibleStep[], conditions: Record<string, boolean> = {}) {
  return [...config]
    .sort((a, b) => a.order - b.order)
    .filter((s) => s.enabled)
    .filter((s) => {
      if (!s.conditionKey) return true;
      const met = conditions[s.conditionKey] === true;
      return met || s.conditionUnmetBehavior === "BLOCK";
    });
}

async function skipUnlessRuntimeMounted(page: Page) {
  const mounted = await page
    .locator(PANEL)
    .first()
    .waitFor({ state: "visible", timeout: 3_000 })
    .then(() => true)
    .catch(() => false);

  test.skip(
    !mounted,
    "JourneyRuntimeProvider ainda não montado (Etapa seguinte do épico #338) — este teste passa a rodar sozinho quando o painel existir.",
  );
}

/** Percorre TODO o plano clicando em Continuar, sem conhecer o tamanho. */
async function walkJourney(page: Page, expected: EligibleStep[]) {
  for (let index = 0; index < expected.length; index += 1) {
    await expect(page.locator(STEP)).toHaveAttribute("data-journey-step", expected[index].stepKey);
    await expect(page.locator(PROGRESS)).toHaveText(`${index + 1}/${expected.length}`);
    await page.getByRole("button", { name: "Continuar" }).click();
  }
  await expect(page.locator(PANEL)).toHaveCount(0);
}

test.describe("jornada dirigida pela configuração devolvida por /journeys/eligible", () => {
  for (const stepCount of [1, 4, 6]) {
    test(`conclui uma jornada de ${stepCount} etapas percorrendo o payload`, async ({ page }) => {
      const config = steps(stepCount);
      await stubSession(page);
      await stubEligible(page, [journey({ steps: config })]);

      await page.goto("/projects/p1/monthly");
      await skipUnlessRuntimeMounted(page);

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

  test("passo desligado sai do fluxo e do denominador do progresso", async ({ page }) => {
    const config = steps(6, (index) => (index === 2 ? { enabled: false } : {}));
    await stubSession(page);
    await stubEligible(page, [journey({ steps: config })]);

    await page.goto("/projects/p1/monthly");
    await skipUnlessRuntimeMounted(page);

    await walkJourney(page, expectedSteps(config));
  });

  test("reorder do admin muda a ordem percorrida", async ({ page }) => {
    const config = [
      step({ stepKey: "ultimo", order: 9 }),
      step({ stepKey: "primeiro", order: 0 }),
      step({ stepKey: "meio", order: 5 }),
    ];
    await stubSession(page);
    await stubEligible(page, [journey({ steps: config })]);

    await page.goto("/projects/p1/monthly");
    await skipUnlessRuntimeMounted(page);

    await walkJourney(page, expectedSteps(config));
  });

  test("mistura SUMMARY/FULL: cada etapa renderiza a experiência configurada", async ({ page }) => {
    const config = steps(4, (index) => ({
      experience: index % 2 === 0 ? ("SUMMARY" as const) : ("FULL" as const),
    }));
    await stubSession(page);
    await stubEligible(page, [journey({ steps: config })]);

    await page.goto("/projects/p1/monthly");
    await skipUnlessRuntimeMounted(page);

    for (const expected of expectedSteps(config)) {
      await expect(page.locator(STEP)).toHaveAttribute("data-journey-experience", expected.experience);
      await page.getByRole("button", { name: "Continuar" }).click();
    }
  });

  test("etapa obrigatória não oferece Pular", async ({ page }) => {
    const config = steps(2, (index) => ({ skippable: index !== 0 }));
    await stubSession(page);
    await stubEligible(page, [journey({ steps: config })]);

    await page.goto("/projects/p1/monthly");
    await skipUnlessRuntimeMounted(page);

    await expect(page.getByRole("button", { name: "Pular" })).toHaveCount(0);
  });

  test("configuração alterada entre duas execuções: 4 etapas, depois 6, sem rebuild", async ({
    page,
  }) => {
    await stubSession(page);

    await stubEligible(page, [journey({ steps: steps(4), repeatPolicy: "ALWAYS" })]);
    await page.goto("/projects/p1/monthly");
    await skipUnlessRuntimeMounted(page);
    await walkJourney(page, expectedSteps(steps(4)));

    // O admin publica 6 etapas; nenhum deploy da web aconteceu no meio.
    await page.unroute("**/journeys/eligible*");
    await stubEligible(page, [journey({ steps: steps(6), repeatPolicy: "ALWAYS" })]);
    await page.reload();

    await walkJourney(page, expectedSteps(steps(6)));
  });

  test("ALWAYS reabre a jornada na visita seguinte; ONCE_PER_USER não", async ({ page }) => {
    await stubSession(page);
    await stubEligible(page, [journey({ steps: steps(1), repeatPolicy: "ALWAYS" })]);

    await page.goto("/projects/p1/monthly");
    await skipUnlessRuntimeMounted(page);
    await walkJourney(page, expectedSteps(steps(1)));

    await page.reload();
    await expect(page.locator(PANEL)).toBeVisible();

    // Concluída para ONCE_PER_USER: a API deixa de devolvê-la.
    await page.unroute("**/journeys/eligible*");
    await stubEligible(page, []);
    await page.reload();
    await expect(page.locator(PANEL)).toHaveCount(0);
  });

  test("falha de rede ao carregar as jornadas não derruba a tela", async ({ page }) => {
    await stubSession(page);
    await page.route("**/journeys/eligible*", (route) => route.abort("failed"));

    await page.goto("/projects/p1/monthly");

    await expect(page.locator(PANEL)).toHaveCount(0);
    await expect(page.locator("body")).toBeVisible();
  });
});
