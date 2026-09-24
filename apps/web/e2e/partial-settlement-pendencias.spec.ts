import { expect, test } from "@playwright/test";

for (const width of [375, 390, 1280]) {
  test(`monthly pending rows show partial remainder without payment CTA at ${width}px`, async ({
    page,
    baseURL,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "Explicit responsive viewports",
    );
    await page.setViewportSize({ width, height: 844 });
    await page.clock.setFixedTime(new Date("2026-07-15T12:00:00.000Z"));
    await page
      .context()
      .addCookies([
        { name: "rf_token", value: "synthetic-702", url: baseURL! },
      ]);
    const writes: string[] = [];
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const project = {
      id: "personal",
      name: "Pessoal sintético",
      type: "PESSOAL",
      onboardedAt: "2026-01-01",
      rooms: [],
    };
    const month = {
      mes: "2026-07",
      totalDespesas: 40_000,
      totalRecebimentos: 0,
      despesasRealizadas: 0,
      recebimentosRealizados: 0,
      saldoMes: -40_000,
      saldoMesRealizado: 0,
      porOrigem: {},
      porCategoria: [],
    };
    const item = {
      id: "partial",
      tipo: "PARCELA_FOREIGN_PENDENTE",
      label: "Quitar parcela",
      descricao: "Parcela sintética",
      valor: 40_000,
      data: "2026-07-10T00:00:00.000Z",
      foreignExpenseId: "target",
      parcelaIndex: 0,
      installmentSettlement: {
        contractedCents: 80_000,
        paidCents: 40_000,
        remainingCents: 40_000,
        settlementStatus: "PARTIAL",
      },
      canExecuteAction: false,
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
      if (["POST", "PATCH", "DELETE", "PUT"].includes(request.method())) {
        writes.push(`${request.method()} ${path}`);
        throw new Error(`Unexpected financial write: ${writes.at(-1)}`);
      }
      if (path === "/auth/me")
        return route.fulfill(
          json({
            id: "synthetic-user",
            username: "synthetic",
            name: "Synthetic",
            role: "ADMIN",
            tenantId: "synthetic-702",
            allowedProjects: ["personal"],
            allowedModules: [],
            allowedProjectTypes: ["PESSOAL"],
          }),
        );
      if (path === "/projects") return route.fulfill(json([project]));
      if (path === "/projects/personal") return route.fulfill(json(project));
      if (path.endsWith("/monthly-overview"))
        return route.fulfill(
          json({
            mesAtual: "2026-07",
            meses: [month],
            comparativo: {
              current: month,
              previous: null,
              deltaDespesas: 0,
              deltaDespesasPct: null,
              deltaRecebimentos: 0,
              deltaRecebimentosPct: null,
              deltaSaldo: 0,
            },
            entries: [],
            mesAtualEntries: [],
            projetos: [project],
          }),
        );
      if (path.endsWith("/monthly-overview/dre-overview")) {
        return route.fulfill(json({ anual: { saldoAcumuladoSerie: [] } }));
      }
      if (path.endsWith("/monthly-overview/account-view")) {
        return route.fulfill(
          json({ cartoes: [], contas: [], saidas: [], entradas: [] }),
        );
      }
      if (path.endsWith("/pendencias/financeiras"))
        return route.fulfill(
          json({
            total: 4,
            grupos: [
              {
                tipo: item.tipo,
                label: "Parcelas pendentes",
                count: 2,
                valorTotal: 12_345_678,
                itens: [
                  item,
                  {
                    ...item,
                    id: "large",
                    descricao: "Parcela extensa",
                    valor: 12_305_678,
                    installmentSettlement: {
                      ...item.installmentSettlement,
                      remainingCents: 12_305_678,
                      contractedCents: 12_345_678,
                    },
                  },
                ],
              },
              {
                tipo: "SEM_CONTA",
                label: "Sem conta",
                count: 2,
                valorTotal: 120_000,
                itens: [
                  {
                    ...item,
                    id: "unlinked",
                    tipo: "SEM_CONTA",
                    descricao: "Parcela sem conta",
                  },
                  {
                    ...item,
                    id: "unapproved",
                    tipo: "SEM_CONTA",
                    descricao: "Parcela sem autorização",
                    valor: 80_000,
                    installmentSettlement: {
                      ...item.installmentSettlement,
                      paidCents: 0,
                      remainingCents: 80_000,
                      settlementStatus: "UNPAID",
                    },
                    canExecuteAction: undefined,
                  },
                ],
              },
            ],
          }),
        );
      return route.fulfill(json([]));
    });
    await page.goto("/projects/personal/monthly?mes=2026-07");
    const resolver = page.getByRole("button", {
      name: "Resolver",
      exact: true,
    });
    await expect(resolver).toBeVisible();
    const resolverBox = await resolver.boundingBox();
    expect(resolverBox?.height).toBeGreaterThanOrEqual(44);
    expect(resolverBox?.width).toBeGreaterThanOrEqual(44);
    await resolver.click();
    for (const name of ["Parcela sintética", "Parcela sem conta"]) {
      const row = page.getByRole("group", { name, exact: true });
      await expect(row.getByText("Parcial", { exact: true })).toBeVisible();
      await expect(
        row.getByText("Restante: R$ 400,00", { exact: true }),
      ).toBeVisible();
      await expect(
        row.getByText("Contratado: R$ 800,00", { exact: true }),
      ).toBeVisible();
      await expect(
        row.getByText("Pago: R$ 400,00", { exact: true }),
      ).toBeVisible();
      await expect(row.getByRole("button")).toHaveCount(0);
    }
    const unapproved = page.getByRole("group", {
      name: "Parcela sem autorização",
      exact: true,
    });
    await expect(
      unapproved.getByText("Pendente", { exact: true }),
    ).toBeVisible();
    await expect(unapproved.getByText("Restante: R$ 800,00")).toBeVisible();
    await expect(unapproved.getByRole("button")).toHaveCount(0);
    const large = page.getByRole("group", {
      name: "Parcela extensa",
      exact: true,
    });
    await expect(
      large.getByText("Restante: R$ 123.056,78", { exact: true }),
    ).toBeVisible();
    expect(await large.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
    const money = large.getByText(/^(Restante|Contratado|Pago): R\$/);
    await expect(money).toHaveCount(3);
    expect(
      await money.evaluateAll((nodes) =>
        nodes.every((node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          return (
            new Set(
              Array.from(range.getClientRects()).map((rect) =>
                Math.round(rect.top),
              ),
            ).size <= 1
          );
        }),
      ),
    ).toBe(true);
    await expect(
      page.getByRole("button", {
        name: /Quitar parcela|Parcela parcialmente paga/,
      }),
    ).toHaveCount(0);
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
  });
}
