import { expect, test, type Locator } from "@playwright/test";

async function touchTarget(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  const box = await control.evaluate((element) => {
    const r = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      r.x + r.width / 2,
      r.y + r.height / 2,
    );
    return {
      width: r.width,
      height: r.height,
      hit: hit === element || element.contains(hit),
    };
  });
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.hit).toBe(true);
}

for (const width of [375, 390, 1280]) {
  test(`existing bank debit: reload and source-specific undo at ${width}px`, async ({
    page,
    baseURL,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "This spec controls its viewports",
    );
    await page.setViewportSize({ width, height: 844 });
    await page.clock.setFixedTime(new Date("2026-09-23T12:00:00Z"));
    await page
      .context()
      .addCookies([
        { name: "rf_token", value: "synthetic-702", url: baseURL! },
      ]);
    const writes: Array<{ method: string; path: string; body: unknown }> = [];
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let paid = 0;
    const otherPaid = 40_000;
    const contracted = width === 375 ? 12_345_678 : 80_000;
    const json = (body: unknown) => ({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
    await page.route("http://localhost:3001/**", async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      if (req.method() === "OPTIONS")
        return route.fulfill({
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Allow-Methods": "*",
          },
        });
      if (path === "/merchant-categories/suggest")
        return route.fulfill(json({ categoria: null }));
      if (req.method() === "POST" || req.method() === "DELETE") {
        writes.push({ method: req.method(), path, body: req.postDataJSON() });
        if (path.includes("/conciliar-parcela")) {
          paid = req.method() === "POST" ? 40_000 : 0;
          return route.fulfill(
            json({
              ok: true,
              settlementId: "funding-a",
              state: paid ? "ACTIVE" : "REVERSED",
              replayed: false,
              sourceId: "source",
              targetId: "target",
              parcelaIndex: 0,
              amountCents: 40_000,
              contractedCents: contracted,
              paidCents: paid + otherPaid,
              remainingCents: contracted - paid - otherPaid,
              sourceAvailableCents: 40_000 - paid,
              settlementStatus:
                paid + otherPaid === contracted ? "PAID" : "PARTIAL",
            }),
          );
        }
        throw new Error(`Unexpected write: ${req.method()} ${path}`);
      }
      if (path === "/auth/me")
        return route.fulfill(
          json({
            id: "user-702",
            username: "synthetic",
            name: "Synthetic",
            role: "ADMIN",
            tenantId: "test-702",
            allowedModules: [
              "monthlyOverview",
              "expenses",
              "bankAccounts",
              "creditCards",
            ],
            allowedProjects: ["pessoal", "obra"],
            allowedProjectTypes: ["PESSOAL", "REFORMA"],
          }),
        );
      if (path === "/projects/pessoal")
        return route.fulfill(
          json({
            id: "pessoal",
            name: "Pessoal",
            type: "PESSOAL",
            onboardedAt: "2026-01-01",
            rooms: [],
          }),
        );
      if (path === "/projects/pessoal/expenses/source")
        return route.fulfill(
          json({
            id: "source",
            tipoDespesa: "OUTROS",
            titulo: "Débito existente",
            valor: 40_000,
            quantidade: 1,
            valorTotal: 40_000,
            formaPagamento: "PIX",
            status: "PAGO",
            dataPagamento: "2026-09-10T00:00:00.000Z",
            bankLast4: "1234",
            sourceAvailableCents: 40_000 - paid,
          }),
        );
      if (path.endsWith("/expenses/cross-project"))
        return route.fulfill(
          json([
            {
              id: "target",
              projectId: "obra",
              project: { id: "obra", name: "Obra", type: "REFORMA" },
              tipoDespesa: "OUTROS",
              titulo: "Contrato",
              valor: contracted,
              quantidade: 1,
              valorTotal: contracted,
              formaPagamento: "PARCELADO",
              quantidadeParcela: 1,
              dataInicioParcela: "2026-10-10",
              status: paid + otherPaid === contracted ? "PAGO" : "PLANEJADO",
              installmentSettlements: [
                {
                  parcelaIndex: 0,
                  dueDate: "2026-10-10T00:00:00.000Z",
                  contractedCents: contracted,
                  paidCents: paid + otherPaid,
                  remainingCents: contracted - paid - otherPaid,
                  settlementStatus:
                    paid + otherPaid === contracted ? "PAID" : "PARTIAL",
                  contributions: [
                    ...(paid
                      ? [
                          {
                            settlementId: "funding-a",
                            sourceId: "source",
                            amountCents: 40_000,
                            paymentDate: "2026-09-10T00:00:00.000Z",
                          },
                        ]
                      : []),
                    {
                      settlementId: "funding-other",
                      sourceId: "other-source",
                      amountCents: otherPaid,
                      paymentDate: "2026-09-10T00:00:00.000Z",
                    },
                  ],
                },
              ],
            },
          ]),
        );
      if (path.endsWith("/rateio"))
        return route.fulfill(json({ rateado: false }));
      if (path.endsWith("/monthly-overview/account-view"))
        return route.fulfill(
          json({
            mesSelecionado: "2026-09",
            caixaHoje: -40_000,
            carteiraHoje: 0,
            entrouMes: 0,
            saiuMes: 40_000,
            faltaPagarMes: 0,
            recebimentosPrevistosMes: 0,
            sobraPrevista: -40_000,
            devoCartaoTotal: 0,
            cartoes: [],
            contas: [{ accountId: "account", last4: "1234", nome: "Conta" }],
            entradas: [],
            comprasCartao: [],
            saidas: [
              {
                id: "source",
                kind: "saida",
                descricao: "Débito existente",
                data: "2026-09-10",
                forma: "pix",
                valor: 40_000,
                realizado: true,
                status: "PAGO",
                cardLast4: null,
                bankLast4: "1234",
                tipoDespesa: "OUTROS",
                isInvoice: false,
                editavel: true,
                dueMonth: null,
                projetoOrigem: {
                  id: "pessoal",
                  name: "Pessoal",
                  type: "PESSOAL",
                },
              },
            ],
            ticketMedio: {
              valor: 40_000,
              nCompras: 1,
              totalCompras: 40_000,
              serie6m: [],
              media6m: 0,
              deltaVsMediaPct: null,
            },
          }),
        );
      if (path.endsWith("/monthly-overview/dre-overview"))
        return route.fulfill(json({ anual: { saldoAcumuladoSerie: [] } }));
      return route.fulfill(json([]));
    });
    await page.goto("/projects/pessoal/conta?mes=2026-09");
    await page.getByText("Débito existente", { exact: true }).click();
    const section = page.getByRole("region", {
      name: "Aplicar débito existente",
    });
    await expect(section).toBeVisible();
    const select = section.getByLabel("Parcela a pagar");
    await select.selectOption("target#0");
    const input = section.getByLabel("Valor a aplicar (R$)");
    const confirm = section.getByRole("button", {
      name: "Confirmar pagamento parcial",
    });
    await expect(input).toHaveValue("400");
    await touchTarget(select);
    await touchTarget(input);
    await touchTarget(confirm);
    await confirm.click();
    await expect(section.getByRole("status")).toHaveText(
      width === 375 ? "Parcialmente pago" : "Pago",
    );
    await page.reload();
    await page.getByText("Débito existente", { exact: true }).click();
    await select.selectOption("target#0");
    await expect(confirm).toBeDisabled();
    await expect(
      section
        .locator("dl > div")
        .filter({ hasText: "Contratado" })
        .locator("dd"),
    ).toHaveText(width === 375 ? "R$ 123.456,78" : "R$ 800,00");
    const undo = section.getByRole("button", {
      name: "Desfazer esta contribuição",
    });
    await expect(undo).toHaveCount(1);
    await expect(
      section.getByRole("group", { name: "Obra · Contrato · parcela 1" }),
    ).toBeVisible();
    await touchTarget(undo);
    expect(
      await section.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    const money = section.locator("dl dd").filter({ hasText: /^R\$/ });
    await expect(money).toHaveCount(3);
    const moneyWraps = await money.evaluateAll((nodes) =>
      nodes.some((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return (
          new Set(
            Array.from(range.getClientRects()).map((r) => Math.round(r.top)),
          ).size > 1
        );
      }),
    );
    expect(moneyWraps).toBe(false);
    await undo.click();
    await expect(section.getByRole("status")).toHaveText(
      "Contribuição desfeita",
    );
    await page.reload();
    await page.getByText("Débito existente", { exact: true }).click();
    await select.selectOption("target#0");
    await expect(undo).toHaveCount(0);
    await expect(
      section
        .locator("dl > div")
        .filter({ has: page.getByText("Pago", { exact: true }) })
        .locator("dd"),
    ).toHaveText("R$ 400,00");
    expect(writes).toEqual([
      {
        method: "POST",
        path: "/projects/pessoal/expenses/source/conciliar-parcela",
        body: {
          mode: "ADDITIVE",
          targetExpenseId: "target",
          parcelaIndex: 0,
          amountCents: 40_000,
          requestId: expect.any(String),
        },
      },
      {
        method: "DELETE",
        path: "/projects/pessoal/expenses/source/conciliar-parcela/funding-a",
        body: null,
      },
    ]);
    expect(errors).toEqual([]);
  });
}
