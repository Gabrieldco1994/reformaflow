import { expect, test } from "@playwright/test";

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

test("CTA to fresh session and explicitly named first project", async ({
  page,
}) => {
  const registerBodies: unknown[] = [];
  const projectBodies: unknown[] = [];

  await page.route("**/auth/config", (route) =>
    route.fulfill({ json: { registerEnabled: true, guestEnabled: false } }),
  );
  await page.route("**/auth/register", async (route) => {
    registerBodies.push(route.request().postDataJSON());
    await page
      .context()
      .addCookies([
        {
          name: "rf_token",
          value: "test-session",
          url: "http://localhost:3013",
        },
      ]);
    await route.fulfill({ status: 201, json: { user: apiUser } });
  });
  await page.route("**/auth/me", (route) => route.fulfill({ json: apiUser }));
  await page.route("**/auth/objectives", (route) =>
    route.fulfill({ json: { projectTypes: ["PESSOAL"], allowedProjectTypes: ["PESSOAL"], allowedModules: [] } }),
  );
  await page.route("**/projects", async (route) => {
    if (route.request().method() === "POST") {
      projectBodies.push(route.request().postDataJSON());
      await route.fulfill({
        status: 201,
        json: { id: "casa-1", name: "Minha Casa", type: "CASA" },
      });
      return;
    }
    await route.fulfill({ json: [] });
  });
  await page.route("**/projects/casa-1", (route) =>
    route.fulfill({
      json: { id: "casa-1", name: "Minha Casa", type: "CASA" },
    }),
  );

  await page.goto("/login");
  await page.getByRole("link", { name: /criar minha conta/i }).click();
  await expect(page).toHaveURL(/\/register$/);

  await page.getByLabel(/^seu nome$/i).fill("Maria");
  await page.getByLabel(/email/i).fill("maria@example.com");
  await page.getByLabel(/^senha$/i).fill("segredo123");
  await page.getByRole("button", { name: /criar minha conta/i }).click();

  // Cadastro não escolhe mais a jornada — cai na escolha de objetivos primeiro.
  await expect(page).toHaveURL(/\/onboarding\/objetivos$/);
  expect(registerBodies).toEqual([
    {
      ownerName: "Maria",
      email: "maria@example.com",
      password: "segredo123",
    },
  ]);
  expect(projectBodies).toEqual([]);

  await page.getByRole("checkbox", { name: /organizar minha vida financeira/i }).check();
  await page.getByRole("button", { name: /continuar/i }).click();

  await expect(page).toHaveURL(/\/onboarding\/setup\?type=PESSOAL$/);

  await page.getByLabel(/nome do projeto/i).fill("Minha Vida Financeira");
  await page.getByRole("button", { name: /criar e continuar/i }).click();
  expect(projectBodies).toEqual([{ name: "Minha Vida Financeira", type: "PESSOAL" }]);
});

test("escolhe CARRO sozinho -> chega no passo Veículo, sem passos de conta/cartão", async ({
  page,
}) => {
  await page.route("**/auth/config", (route) =>
    route.fulfill({ json: { registerEnabled: true, guestEnabled: false } }),
  );
  await page.route("**/auth/register", async (route) => {
    await page
      .context()
      .addCookies([
        { name: "rf_token", value: "test-session", url: "http://localhost:3013" },
      ]);
    await route.fulfill({ status: 201, json: { user: apiUser } });
  });
  await page.route("**/auth/me", (route) => route.fulfill({ json: apiUser }));
  await page.route("**/auth/objectives", (route) =>
    route.fulfill({ json: { projectTypes: ["CARRO"], allowedProjectTypes: ["CARRO"], allowedModules: [] } }),
  );
  await page.route("**/projects", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 201,
        json: { id: "carro-1", name: "Meu Carro", type: "CARRO" },
      });
      return;
    }
    await route.fulfill({ json: [] });
  });

  await page.goto("/register");
  await page.getByLabel(/^seu nome$/i).fill("Maria");
  await page.getByLabel(/email/i).fill("maria@example.com");
  await page.getByLabel(/^senha$/i).fill("segredo123");
  await page.getByRole("button", { name: /criar minha conta/i }).click();

  await expect(page).toHaveURL(/\/onboarding\/objetivos$/);
  await page.getByRole("checkbox", { name: /cuidar do carro/i }).check();
  await page.getByRole("button", { name: /continuar/i }).click();

  await expect(page).toHaveURL(/\/onboarding\/setup\?type=CARRO$/);
  await page.getByLabel(/nome do projeto/i).fill("Meu Carro");
  await page.getByRole("button", { name: /criar e continuar/i }).click();

  await expect(page.getByText(/dados do seu carro/i)).toBeVisible();
  await expect(page.getByText(/passo 1 de 2/i)).toBeVisible();
  await expect(page.getByText(/sem o saldo, o caixa/i)).not.toBeVisible();
  await expect(page.getByText(/pular — cadastro depois/i)).not.toBeVisible();
});

test("escolhe CASA + CARRO -> vai para a jornada PESSOAL, primeiro passo é Conta", async ({
  page,
}) => {
  await page.route("**/auth/config", (route) =>
    route.fulfill({ json: { registerEnabled: true, guestEnabled: false } }),
  );
  const objectivesBodies: unknown[] = [];
  await page.route("**/auth/register", async (route) => {
    await page
      .context()
      .addCookies([
        { name: "rf_token", value: "test-session", url: "http://localhost:3013" },
      ]);
    await route.fulfill({ status: 201, json: { user: apiUser } });
  });
  await page.route("**/auth/me", (route) => route.fulfill({ json: apiUser }));
  await page.route("**/auth/objectives", async (route) => {
    objectivesBodies.push(route.request().postDataJSON());
    await route.fulfill({
      json: { projectTypes: ["CASA", "CARRO"], allowedProjectTypes: ["CASA", "CARRO"], allowedModules: [] },
    });
  });
  await page.route("**/projects", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({
        status: 201,
        json: { id: "pessoal-1", name: "Minha Vida Financeira", type: "PESSOAL" },
      });
      return;
    }
    await route.fulfill({ json: [] });
  });

  await page.goto("/register");
  await page.getByLabel(/^seu nome$/i).fill("Maria");
  await page.getByLabel(/email/i).fill("maria@example.com");
  await page.getByLabel(/^senha$/i).fill("segredo123");
  await page.getByRole("button", { name: /criar minha conta/i }).click();

  await expect(page).toHaveURL(/\/onboarding\/objetivos$/);
  await page.getByRole("checkbox", { name: /cuidar da casa/i }).check();
  await page.getByRole("checkbox", { name: /cuidar do carro/i }).check();
  await page.getByRole("button", { name: /continuar/i }).click();

  // 2+ objetivos sempre caem na jornada PESSOAL — os dois marcados são
  // persistidos mesmo assim (ninguém perde acesso ao que marcou).
  await expect(page).toHaveURL(/\/onboarding\/setup\?type=PESSOAL$/);
  expect(objectivesBodies).toEqual([{ projectTypes: ["CASA", "CARRO"] }]);

  await page.getByLabel(/nome do projeto/i).fill("Minha Vida Financeira");
  await page.getByRole("button", { name: /criar e continuar/i }).click();

  await expect(page.getByText(/sem o saldo, o caixa/i)).toBeVisible();
  await expect(page.getByText(/passo 1 de 6/i)).toBeVisible();
});
