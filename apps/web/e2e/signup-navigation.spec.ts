import { expect, test } from "@playwright/test";

// Actual Next routes/providers/shell; controlled API eligibility, not a live
// signup/backend proof. No route forcing after the human submits registration.
for (const width of [375, 390, 1280]) {
  test(`signup FULL journey commits Conta URL AND project shell at ${width}px`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    let registered = false;
    let release!: () => void;
    const eligibility = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queries: string[] = [];
    const user = {
      id: "signup-user",
      username: "maria",
      name: "Maria",
      role: "USER",
      tenantId: "signup-tenant",
      allowedProjectTypes: ["PESSOAL"],
      allowedModules: [
        "monthlyOverview",
        "dashboard",
        "expenses",
        "receipts",
        "creditCards",
        "bankAccounts",
      ],
      allowedProjects: [],
    };
    const project = {
      id: "signup-project",
      type: "PESSOAL",
      name: "Minha vida financeira",
    };
    await page.route("http://localhost:3001/**", async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      if (path === "/auth/config")
        return route.fulfill({
          json: { registerEnabled: true, guestEnabled: false },
        });
      if (path === "/auth/me")
        return route.fulfill({ json: registered ? user : null });
      if (path === "/auth/register") {
        registered = true;
        await page
          .context()
          .addCookies([
            { name: "rf_token", value: "signup-test", url: baseURL! },
          ]);
        return route.fulfill({ status: 201, json: { user } });
      }
      if (path === "/projects")
        return route.fulfill({
          status: route.request().method() === "POST" ? 201 : 200,
          json: route.request().method() === "POST" ? project : [project],
        });
      if (path === `/projects/${project.id}`)
        return route.fulfill({ json: project });
      if (path === "/journeys/eligible") {
        queries.push(url.search);
        if (url.searchParams.get("triggerType") !== "PROJECT_CREATED")
          return route.fulfill({ json: [] });
        await eligibility;
        return route.fulfill({
          json: [
            {
              journeyId: "signup-journey",
              key: "onboarding:pessoal",
              name: "Primeiros passos",
              triggerId: "created",
              repeatPolicy: "ONCE_PER_PROJECT",
              dismissPolicy: "DISMISS_UNTIL_LOGIN",
              crossProject: false,
              steps: [
                {
                  stepKey: "conta",
                  enabled: true,
                  order: 0,
                  experience: "FULL",
                  label: "Conta",
                  subtitle: null,
                  skippable: false,
                  slug: "conta",
                },
              ],
            },
          ],
        });
      }
      if (path.endsWith("/monthly-overview/account-view"))
        return route.fulfill({
          json: {
            mesSelecionado: url.searchParams.get("month"),
            caixaHoje: 0,
            carteiraHoje: 0,
            entrouMes: 0,
            saiuMes: 0,
            faltaPagarMes: 0,
            saidaTotal: 0,
            recebimentosPrevistosMes: 0,
            sobraPrevista: 0,
            devoCartaoTotal: 0,
            cartoes: [],
            contas: [],
            saidas: [],
            comprasCartao: [],
            entradas: [],
            ticketMedio: {
              valor: 0,
              nCompras: 0,
              totalCompras: 0,
              serie6m: [],
              media6m: 0,
              deltaVsMediaPct: null,
            },
          },
        });
      if (path.endsWith("/monthly-overview/dre-overview"))
        return route.fulfill({ json: { anual: { saldoAcumuladoSerie: [] } } });
      return route.fulfill({ json: [] });
    });
    await page.goto("/register");
    await page.getByLabel(/^seu nome$/i).fill("Maria");
    await page.getByLabel(/^email$/i).fill("maria@example.com");
    await page.getByLabel(/^senha$/i).fill("segredo123");
    await page
      .getByRole("checkbox", { name: /organizar minha vida financeira/i })
      .check();
    await page.getByRole("button", { name: /criar minha conta/i }).click();
    await expect
      .poll(() => queries.some((query) => query.includes("PROJECT_CREATED")))
      .toBe(true);
    // A delayed handler must not expose the competing hub render first.
    await expect(page).toHaveURL(/\/register$/);
    release();
    await expect(page).toHaveURL(/\/projects\/signup-project\/conta$/);
    await expect(page.locator("body")).toHaveAttribute(
      "data-rf-shell",
      "project",
    );
    await expect(page.locator('[data-journey-step="conta"]')).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Meus Projetos", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Conta", exact: true }),
    ).toBeVisible();
    if (width < 768)
      await expect(
        page.getByRole("link", { name: "Maria", exact: true }),
      ).toBeVisible();
    else
      await expect(
        page.getByRole("button", { name: "Abrir Copiloto Financeiro" }),
      ).toBeVisible();
    expect(
      queries.filter((query) => query.includes("PROJECT_CREATED")),
    ).toHaveLength(1);
    expect(queries.some((query) => query.includes("SIGNUP_COMPLETED"))).toBe(
      true,
    );
  });
}
