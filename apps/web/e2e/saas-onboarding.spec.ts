import { expect, test, type Page } from "@playwright/test";

const apiUser = {
  id: "u1",
  username: "maria",
  name: "Maria",
  role: "USER",
  tenantId: "t1",
  allowedProjectTypes: ["CASA"],
  allowedModules: [
    "dashboard",
    "recurringBills",
    "maintenance",
    "reminders",
    "expenses",
  ],
  allowedProjects: [],
};

/**
 * O cadastro deixou de ser um funil de 3 telas (register -> objetivos ->
 * setup). Agora `/register` já coleta os objetivos, cria um projeto por
 * objetivo marcado e cai em `/projects`. Desde a Fase B (#339), o onboarding
 * do projeto em si não é mais uma rota dedicada (`/onboarding/setup`) — é a
 * jornada disparada por `PROJECT_CREATED`/`SCREEN_VISIT`, renderizada como
 * painel sobre o dashboard (ver `journeys-dynamic.spec.ts`).
 */

/** Sessão fake + rotas de auth que todo teste de cadastro precisa. */
async function stubAuth(page: Page, registerBodies?: unknown[]) {
  await page.route("**/auth/config", (route) =>
    route.fulfill({ json: { registerEnabled: true, guestEnabled: false } }),
  );
  await page.route("**/auth/register", async (route) => {
    registerBodies?.push(route.request().postDataJSON());
    await page
      .context()
      .addCookies([
        { name: "rf_token", value: "test-session", url: "http://localhost:3013" },
      ]);
    await route.fulfill({ status: 201, json: { user: apiUser } });
  });
  await page.route("**/auth/me", (route) => route.fulfill({ json: apiUser }));
}

async function fillCredentials(page: Page) {
  await page.getByLabel(/^seu nome$/i).fill("Maria");
  await page.getByLabel(/email/i).fill("maria@example.com");
  await page.getByLabel(/^senha$/i).fill("segredo123");
}

test("CTA do login leva ao cadastro, que cria a sessão e o projeto do objetivo marcado", async ({
  page,
}) => {
  const registerBodies: unknown[] = [];
  const projectBodies: unknown[] = [];

  await stubAuth(page, registerBodies);
  await page.route("**/projects", async (route) => {
    if (route.request().method() === "POST") {
      projectBodies.push(route.request().postDataJSON());
      await route.fulfill({
        status: 201,
        json: { id: "pessoal-1", name: "Minha vida financeira", type: "PESSOAL" },
      });
      return;
    }
    await route.fulfill({ json: [] });
  });

  await page.goto("/login");
  await page.getByRole("link", { name: /criar minha conta/i }).click();
  await expect(page).toHaveURL(/\/register$/);

  await fillCredentials(page);
  await page
    .getByRole("checkbox", { name: /organizar minha vida financeira/i })
    .check();
  await page.getByRole("button", { name: /criar minha conta/i }).click();

  // Uma tela só: os objetivos vão no mesmo POST do cadastro.
  await expect(page).toHaveURL(/\/projects$/);
  expect(registerBodies).toEqual([
    {
      ownerName: "Maria",
      email: "maria@example.com",
      password: "segredo123",
      projectTypes: ["PESSOAL"],
    },
  ]);
  expect(projectBodies).toEqual([
    { name: "Minha vida financeira", type: "PESSOAL" },
  ]);
});

test("um projeto por objetivo marcado, na ordem em que aparecem", async ({
  page,
}) => {
  const registerBodies: unknown[] = [];
  const projectBodies: unknown[] = [];

  await stubAuth(page, registerBodies);
  await page.route("**/projects", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON();
      projectBodies.push(body);
      await route.fulfill({
        status: 201,
        json: { id: `${String(body.type).toLowerCase()}-1`, ...body },
      });
      return;
    }
    await route.fulfill({ json: [] });
  });

  await page.goto("/register");
  await fillCredentials(page);
  await page.getByRole("checkbox", { name: /cuidar da casa/i }).check();
  await page.getByRole("checkbox", { name: /cuidar do carro/i }).check();
  await page.getByRole("button", { name: /criar minha conta/i }).click();

  await expect(page).toHaveURL(/\/projects$/);
  // Marcar 2 objetivos não colapsa mais numa jornada PESSOAL única:
  // cada objetivo vira o seu próprio projeto.
  expect(registerBodies).toEqual([
    {
      ownerName: "Maria",
      email: "maria@example.com",
      password: "segredo123",
      projectTypes: ["CASA", "CARRO"],
    },
  ]);
  expect(projectBodies).toEqual([
    { name: "Minha casa", type: "CASA" },
    { name: "Meu carro", type: "CARRO" },
  ]);
});

test("cadastro sem objetivo não cria conta e explica o que falta", async ({
  page,
}) => {
  const registerBodies: unknown[] = [];
  await stubAuth(page, registerBodies);

  await page.goto("/register");
  await fillCredentials(page);
  await page.getByRole("button", { name: /criar minha conta/i }).click();

  await expect(page.getByText(/escolha ao menos um objetivo/i)).toBeVisible();
  await expect(page).toHaveURL(/\/register$/);
  expect(registerBodies).toEqual([]);
});

/**
 * O wizard dedicado morreu com a Fase B: o onboarding de um projeto novo
 * agora é a jornada (`/journeys/eligible`) disparada por `PROJECT_CREATED`/
 * `SCREEN_VISIT` e renderizada como painel sobre o dashboard (ver
 * `journeys-dynamic.spec.ts`). O passo "Dados do seu carro" continua
 * existindo — é `CarInfoStep`, registrado em `operational-summaries/registry`
 * sob a chave `car` — só mudou de casa. Este teste passou a exercitar o
 * painel novo em vez da rota removida.
 */
test("jornada de CARRO abre no passo carro, sem passo de conta/cartão", async ({
  page,
}) => {
  await stubAuth(page);
  // `apiUser` (topo do arquivo) só libera CASA; este teste precisa de CARRO.
  await page.route("**/auth/me", (route) =>
    route.fulfill({
      json: { ...apiUser, allowedProjectTypes: ["CASA", "CARRO"] },
    }),
  );
  await page.context().addCookies([
    { name: "rf_token", value: "test-session", url: "http://localhost:3013" },
  ]);
  await page.route("**/projects", (route) =>
    route.fulfill({
      json: [{ id: "carro-1", name: "Meu carro", type: "CARRO" }],
    }),
  );
  await page.route("**/projects/carro-1", (route) =>
    route.fulfill({
      json: { id: "carro-1", name: "Meu carro", type: "CARRO" },
    }),
  );
  await page.route("**/journeys/eligible*", (route) =>
    route.fulfill({
      json: [
        {
          key: "onboarding:carro",
          name: "Onboarding CARRO",
          active: true,
          targetScope: "PROJECT_TYPE",
          targetProjectType: "CARRO",
          targetProjectId: null,
          repeatPolicy: "ONCE_PER_PROJECT",
          allowCrossProjectNavigation: false,
          steps: [
            {
              stepKey: "car",
              order: 0,
              enabled: true,
              skippable: true,
              experience: "SUMMARY",
              label: "car",
              subtitle: null,
              conditionKey: null,
              conditionUnmetBehavior: "SKIP",
              targetProjectType: null,
            },
          ],
          triggers: [
            {
              triggerType: "SCREEN_VISIT",
              screenKey: "dashboard",
              actionKey: null,
              device: "any",
              active: true,
            },
          ],
        },
      ],
    }),
  );
  await page.route("**/journeys/*/complete", (route) =>
    route.fulfill({ status: 204, body: "" }),
  );

  await page.goto("/projects/carro-1/dashboard");

  await expect(page.locator('[data-journey-step="car"]')).toBeVisible();
  await expect(page.getByText(/dados do seu carro/i)).toBeVisible();
  await expect(page.getByText(/sem o saldo, o caixa/i)).not.toBeVisible();
});
