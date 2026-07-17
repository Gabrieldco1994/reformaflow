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

  await page.getByLabel(/nome do seu espaço/i).fill("Acme");
  await page.getByLabel(/^seu nome$/i).fill("Maria");
  await page.getByLabel(/usuário/i).fill("Maria.Silva");
  await page.getByLabel(/^senha$/i).fill("segredo123");
  await page.getByLabel(/confirmar senha/i).fill("segredo123");
  await page.getByRole("checkbox", { name: /^Cuidar da casa/i }).check();
  await page.getByRole("button", { name: /criar conta/i }).click();

  await expect(page).toHaveURL(/\/projects\?onboarding=1$/);
  expect(registerBodies).toEqual([
    {
      tenantName: "Acme",
      ownerName: "Maria",
      username: "Maria.Silva",
      password: "segredo123",
      projectTypes: ["CASA"],
    },
  ]);
  expect(projectBodies).toEqual([]);

  await page.getByLabel("Nome", { exact: true }).fill("Minha Casa");
  await page.getByRole("button", { name: "Criar Projeto" }).first().click();
  expect(projectBodies).toEqual([
    { name: "Minha Casa", type: "CASA", description: "" },
  ]);
});
