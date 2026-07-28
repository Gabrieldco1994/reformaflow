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
 * objetivo marcado e cai em `/projects`; quem leva ao wizard é o gate do
 * AppShell (`onboardedAt` nulo) via
 * `/onboarding/setup?projectId=<id>&type=<tipo>`.
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

test("wizard de CARRO abre no passo Veículo, sem passos de conta/cartão", async ({
  page,
}) => {
  await stubAuth(page);
  // Este teste entra direto no wizard (não passa pelo cadastro), então a
  // sessão precisa existir antes — senão o middleware manda pro /login.
  await page.context().addCookies([
    { name: "rf_token", value: "test-session", url: "http://localhost:3013" },
  ]);
  await page.route("**/projects/carro-1", (route) =>
    route.fulfill({
      json: { id: "carro-1", name: "Meu carro", type: "CARRO" },
    }),
  );

  // URL que o gate do AppShell monta quando o projeto ainda não foi
  // "onboardado" (projectId presente => o wizard não pede o nome de novo).
  await page.goto("/onboarding/setup?projectId=carro-1&type=CARRO");

  await expect(page.getByText(/dados do seu carro/i)).toBeVisible();
  await expect(page.getByText(/sem o saldo, o caixa/i)).not.toBeVisible();
});
