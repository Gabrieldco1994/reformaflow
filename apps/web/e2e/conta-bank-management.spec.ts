import { expect, test, type Locator, type Page } from "@playwright/test";

const PROJECT_ID = "conta-bank-pessoal";
const FROZEN_NOW = new Date("2026-08-21T12:00:00.000Z");

const ACCOUNTS = [
  {
    id: "acc-a",
    institution: "ITAU",
    nickname: "Conta A",
    last4: "1111",
    agency: "0001",
    accountNumber: "123456789-0",
    openingBalanceCents: 100,
    openingBalanceDate: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "acc-b",
    institution: "NUBANK",
    nickname: "Conta B",
    last4: "2222",
    agency: null,
    accountNumber: null,
    openingBalanceCents: 200,
    openingBalanceDate: "2026-02-01T00:00:00.000Z",
  },
];

const ACCOUNT_VIEW = {
  mesSelecionado: "2026-08",
  caixaHoje: 0,
  carteiraHoje: 0,
  entrouMes: 0,
  saiuMes: 0,
  faltaPagarMes: 0,
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
};

function json(body: unknown) {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  };
}

async function mockApi(page: Page, baseURL: string) {
  const patchedPaths: string[] = [];
  await page.clock.setFixedTime(FROZEN_NOW);
  await page
    .context()
    .addCookies([{ name: "rf_token", value: "conta-bank-test", url: baseURL }]);
  await page.route("http://localhost:3001/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (
      route.request().method() === "PATCH" &&
      path.startsWith(`/projects/${PROJECT_ID}/bank-accounts/`)
    ) {
      patchedPaths.push(path);
      return route.fulfill(json({}));
    }
    if (path === "/auth/me") {
      return route.fulfill(
        json({
          id: "conta-bank-user",
          username: "conta-bank",
          name: "Conta Bank",
          role: "ADMIN",
          isGuest: false,
          tenantId: "tenant-1",
          allowedModules: [
            "monthlyOverview",
            "bankAccounts",
            "expenses",
            "creditCards",
          ],
          allowedProjects: [PROJECT_ID],
          allowedProjectTypes: ["PESSOAL"],
        }),
      );
    }
    if (path === `/projects/${PROJECT_ID}`) {
      return route.fulfill(
        json({
          id: PROJECT_ID,
          name: "Pessoal",
          type: "PESSOAL",
          onboardedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
    }
    if (path === `/projects/${PROJECT_ID}/bank-accounts`) {
      return route.fulfill(json(ACCOUNTS));
    }
    if (path === `/projects/${PROJECT_ID}/monthly-overview/account-view`) {
      return route.fulfill(json(ACCOUNT_VIEW));
    }
    if (path === `/projects/${PROJECT_ID}/monthly-overview/dre-overview`) {
      return route.fulfill(json({ anual: { saldoAcumuladoSerie: [] } }));
    }
    return route.fulfill(json([]));
  });
  return { patchedPaths };
}

async function expectCenterHitsControl(control: Locator) {
  const hit = await control.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const target = document.elementFromPoint(
      bounds.left + bounds.width / 2,
      bounds.top + bounds.height / 2,
    );
    return {
      hitsControl:
        target === element || (target ? element.contains(target) : false),
      tagName: target?.tagName ?? null,
      width: bounds.width,
      height: bounds.height,
    };
  });

  expect(hit.tagName).not.toBe("NAV");
  expect(hit.hitsControl).toBe(true);
  return hit;
}

test("375/390/desktop: conta exata, modal no viewport, sem overflow e alvos de 44px", async ({
  page,
  baseURL,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "a spec controla as próprias larguras",
  );
  const { patchedPaths } = await mockApi(page, baseURL!);

  for (const viewport of [
    { width: 375, height: 844 },
    { width: 390, height: 844 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(
      `/projects/${PROJECT_ID}/conta?mes=2026-08&focus=openingBalance&accountId=acc-b&tag=a&tag=b`,
    );

    await expect(
      page.getByRole("heading", { name: "Editar conta" }),
    ).toBeVisible();
    await expect(page.getByPlaceholder("1234").first()).toHaveValue("2222");

    const modal = page.getByRole("dialog");
    const rect = await modal.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
      };
    });
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(viewport.width);
    expect(rect.top).toBeGreaterThanOrEqual(0);
    expect(rect.bottom).toBeLessThanOrEqual(viewport.height);

    const widths = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);

    if (viewport.width === 375) {
      await page.getByRole("button", { name: "Salvar" }).click();
      await expect
        .poll(() => patchedPaths)
        .toEqual([`/projects/${PROJECT_ID}/bank-accounts/acc-b`]);
    } else {
      await page.getByRole("button", { name: "Cancelar" }).click();
    }
    await expect(page).toHaveURL(
      `/projects/${PROJECT_ID}/conta?mes=2026-08&tag=a&tag=b`,
    );

    const actionSizes = await page
      .locator("[data-bank-account-action]")
      .evaluateAll((elements) =>
        elements.map((element) => {
          const bounds = element.getBoundingClientRect();
          return { width: bounds.width, height: bounds.height };
        }),
      );
    expect(actionSizes.length).toBeGreaterThan(0);
    for (const size of actionSizes) {
      expect(size.width).toBeGreaterThanOrEqual(44);
      expect(size.height).toBeGreaterThanOrEqual(44);
    }
  }
});

test("375/390: seletor e dock mantêm os alvos clicáveis acima da faixa decorativa", async ({
  page,
  baseURL,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "a spec controla as próprias larguras",
  );
  await mockApi(page, baseURL!);

  for (const viewport of [
    { width: 375, height: 812 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(
      `/projects/${PROJECT_ID}/conta?mes=2026-08&focus=openingBalance`,
    );
    await expect(
      page.getByText("Escolha a conta que deseja editar"),
    ).toBeVisible();

    const lowerEditButton = page.getByRole("button", {
      name: "Editar Conta B, final 2222",
    });
    const lowerEditBox = await lowerEditButton.boundingBox();
    expect(lowerEditBox).not.toBeNull();
    expect(lowerEditBox!.width).toBeGreaterThanOrEqual(44);
    expect(lowerEditBox!.height).toBeGreaterThanOrEqual(44);
    await expectCenterHitsControl(lowerEditButton);

    for (const control of [
      page.getByRole("link", { name: "Cockpit", exact: true }),
      page.getByRole("link", { name: "Conta", exact: true }),
      page.getByRole("link", { name: "Maria", exact: true }),
      page.getByRole("button", { name: "Lançar", exact: true }),
    ]) {
      await expectCenterHitsControl(control);
    }

    for (const account of [
      { name: "Conta A", last4: "1111" },
      { name: "Conta B", last4: "2222" },
    ]) {
      await page.goto(
        `/projects/${PROJECT_ID}/conta?mes=2026-08&focus=openingBalance`,
      );
      await page
        .getByRole("button", {
          name: `Selecionar ${account.name}, final ${account.last4}`,
        })
        .click();
      await expect(
        page.getByRole("heading", { name: "Editar conta" }),
      ).toBeVisible();
      await expect(page.getByPlaceholder("1234").first()).toHaveValue(
        account.last4,
      );
      await page.getByRole("button", { name: "Cancelar" }).click();
    }
  }
});

test("#552 375/390: CTAs de recebimento têm 44px, hit-test e nenhum overflow", async ({
  page,
  baseURL,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "a spec controla as próprias larguras",
  );
  await mockApi(page, baseURL!);

  for (const viewport of [
    { width: 375, height: 812 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(`/projects/${PROJECT_ID}/conta?mes=2026-08`);

    await page.getByRole("button", { name: "Lançar", exact: true }).click();
    const launchMenu = page.locator('[data-mobile-sheet="launch-mode"]');
    await launchMenu.getByRole("button", { name: /^Recebimento\b/ }).click();

    const heading = page.getByRole("heading", { name: "Nova Receita" });
    await expect(heading).toBeVisible();
    const modal = page.locator('[data-mobile-sheet="modal"]').filter({
      has: heading,
    });
    await expect
      .poll(async () =>
        modal.evaluate((element) =>
          Math.max(
            0,
            Math.ceil(
              element.getBoundingClientRect().bottom - window.innerHeight,
            ),
          ),
        ),
      )
      .toBe(0);

    const ctas = modal.getByRole("button", { name: /^(Cancelar|Criar)$/ });
    const census = await ctas.all();
    expect(census.length).toBeGreaterThan(0);
    expect(await ctas.allTextContents()).toEqual(["Cancelar", "Criar"]);
    for (const target of census) {
      const name = (await target.textContent())?.trim() ?? "CTA";
      const bounds = await expectCenterHitsControl(target);
      expect(bounds.width, name).toBeGreaterThanOrEqual(44);
      expect(bounds.height, name).toBeGreaterThanOrEqual(44);
    }

    const widths = await modal.evaluate((element) => ({
      pageClient: document.documentElement.clientWidth,
      pageScroll: document.documentElement.scrollWidth,
      modalClient: element.clientWidth,
      modalScroll: element.scrollWidth,
    }));
    expect(widths.pageScroll).toBeLessThanOrEqual(widths.pageClient + 1);
    expect(widths.modalScroll).toBeLessThanOrEqual(widths.modalClient + 1);
  }
});
