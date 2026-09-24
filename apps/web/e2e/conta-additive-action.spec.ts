import { expect, test, type Locator } from "@playwright/test";
import type {
  AccountViewResponse,
  AccountViewSaida,
} from "../src/app/projects/[projectId]/conta/_types";

async function expectTouchable(button: Locator) {
  await button.scrollIntoViewIfNeeded();
  const box = await button.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
  expect(
    await button.evaluate((element) => {
      const box = element.getBoundingClientRect();
      // Rounded corners are clipped; the four edge midpoints must still receive taps.
      return [
        [box.left + 2, box.top + box.height / 2],
        [box.right - 2, box.top + box.height / 2],
        [box.left + box.width / 2, box.top + 2],
        [box.left + box.width / 2, box.bottom - 2],
      ].every(([x, y]) => element.contains(document.elementFromPoint(x, y)));
    }),
  ).toBe(true);
  console.log(
    `#706 ${await button.innerText()}: ${box?.width}x${box?.height}px`,
  );
}

for (const width of [375, 390, 1280]) {
  test(`#706 Conta denies active additive payment without writes and preserves its eligible sister at ${width}px`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.clock.setFixedTime(new Date("2026-09-15T12:00:00.000Z"));
    await page
      .context()
      .addCookies([
        { name: "rf_token", value: "synthetic-706", url: baseURL! },
      ]);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const writes: Array<{ method: string; path: string; body: unknown }> = [];
    const project = {
      id: "personal",
      name: "Pessoal sintético",
      type: "PESSOAL",
      rooms: [],
      onboardedAt: "2026-01-01",
    };
    const partial: AccountViewSaida = {
      id: "target#0",
      kind: "saida",
      descricao: "Parcela com aporte",
      data: "2026-09-10",
      valor: 40_000,
      forma: "pix",
      realizado: false,
      status: "PLANEJADO",
      isInvoice: false,
      editavel: true,
      cardLast4: null,
      bankLast4: null,
      dueMonth: null,
      tipoDespesa: "MATERIAL",
      foreignExpenseId: "target",
      parcelaIndex: 0,
      projetoOrigem: { id: "obra", name: "Obra sintética", type: "REFORMA" },
      canExecuteAction: false,
      installmentSettlement: {
        contractedCents: 80_000,
        paidCents: 40_000,
        remainingCents: 40_000,
        settlementStatus: "PARTIAL",
      },
    };
    const sister: AccountViewSaida = {
      ...partial,
      id: "target#1",
      descricao: "Parcela irmã elegível",
      parcelaIndex: 1,
      valor: 80_000,
      installmentSettlement: undefined,
      canExecuteAction: undefined,
    };
    const data: AccountViewResponse = {
      mesSelecionado: "2026-09",
      caixaHoje: 200_000,
      entrouMes: 200_000,
      saiuMes: 0,
      faltaPagarMes: 120_000,
      recebimentosPrevistosMes: 0,
      sobraPrevista: 80_000,
      devoCartaoTotal: 0,
      cartoes: [],
      contas: [{ last4: "5678", nome: "Conta sintética" }],
      saidas: [partial, sister],
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
    const json = (body: unknown) => ({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
    await page.route("http://localhost:3001/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === "OPTIONS")
        return route.fulfill({
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Allow-Methods": "*",
          },
        });
      if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method())) {
        writes.push({
          method: request.method(),
          path,
          body: request.postDataJSON(),
        });
        if (
          request.method() === "POST" &&
          path === "/projects/personal/expenses"
        )
          return route.fulfill({ ...json({ id: "mirror" }), status: 201 });
        if (
          request.method() === "POST" &&
          path === "/projects/personal/expenses/mirror/conciliar-parcela"
        )
          return route.fulfill(json({ ok: true }));
        return route.fulfill({
          ...json({ message: "Unexpected write" }),
          status: 400,
        });
      }
      if (path === "/auth/me")
        return route.fulfill(
          json({
            id: "synthetic-user",
            username: "synthetic",
            name: "Synthetic",
            role: "ADMIN",
            tenantId: "synthetic-706",
            allowedProjects: ["personal"],
            allowedModules: [],
            allowedProjectTypes: ["PESSOAL"],
          }),
        );
      if (path === "/projects") return route.fulfill(json([project]));
      if (path === "/projects/personal") return route.fulfill(json(project));
      if (path.endsWith("/monthly-overview/account-view"))
        return route.fulfill(json(data));
      if (path.endsWith("/monthly-overview/dre-overview"))
        return route.fulfill(json({ anual: { saldoAcumuladoSerie: [] } }));
      if (path === "/tenant/bank-accounts")
        return route.fulfill(
          json([
            {
              id: "bank",
              nickname: "Conta sintética",
              institution: "Banco sintético",
              last4: "5678",
            },
          ]),
        );
      return route.fulfill(json([]));
    });
    await page.goto("/projects/personal/conta?month=2026-09");
    const denied = page
      .getByTestId("movimentacao-row")
      .filter({ hasText: "Parcela com aporte" });
    await expect(
      denied.getByText("Indisponível", { exact: true }),
    ).toBeVisible();
    await expect(
      denied.getByRole("button", { name: "Quitar", exact: true }),
    ).toHaveCount(0);
    await expect(denied.getByText(/R\$\s*400,00/)).toBeVisible();
    await denied.getByText("Indisponível", { exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Quitar parcela" }),
    ).toHaveCount(0);
    expect(writes).toEqual([]);

    const eligible = page
      .getByTestId("movimentacao-row")
      .filter({ hasText: "Parcela irmã elegível" });
    const quitar = eligible.getByRole("button", {
      name: "Quitar",
      exact: true,
    });
    await expectTouchable(quitar);
    await quitar.click();
    await expect(
      page.getByRole("heading", { name: "Quitar parcela" }),
    ).toBeVisible();
    await page
      .getByRole("combobox")
      .filter({ has: page.getByRole("option", { name: /Conta sintética/ }) })
      .selectOption("bank:bank");
    const confirm = page.getByRole("button", {
      name: "Confirmar",
      exact: true,
    });
    await expectTouchable(confirm);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await confirm.click();
    await expect(
      page.getByRole("heading", { name: "Quitar parcela" }),
    ).toHaveCount(0);
    expect(writes).toEqual([
      {
        method: "POST",
        path: "/projects/personal/expenses",
        body: expect.objectContaining({ valor: 800, bankAccountId: "bank" }),
      },
      {
        method: "POST",
        path: "/projects/personal/expenses/mirror/conciliar-parcela",
        body: { targetExpenseId: "target", parcelaIndex: 1, realValor: 80_000 },
      },
    ]);
    const money = denied.getByText(/R\$\s*400,00/);
    expect(
      await money.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return new Set(
          Array.from(range.getClientRects()).map((rect) =>
            Math.round(rect.top),
          ),
        ).size;
      }),
    ).toBe(1);
    expect(errors).toEqual([]);
  });
}
