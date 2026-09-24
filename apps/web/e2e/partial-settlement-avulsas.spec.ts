import { expect, test } from "@playwright/test";

for (const projectType of ["CASA", "CARRO"]) {
  for (const width of [375, 390, 1280]) {
    test(`${projectType}: canonical partial/mixed Avulsas and metadata-only edit at ${width}px`, async ({
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
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const writes: Array<{ method: string; path: string; body: unknown }> = [];
      let rejectMetadata = true;
      const expense = {
        id: "contract",
        titulo: "Contrato sintético",
        fornecedor: "Fornecedor sintético",
        tipoDespesa: "OUTROS",
        valor: 80_000,
        valorTotal: 80_000,
        quantidade: 1,
        formaPagamento: "PARCELADO",
        quantidadeParcela: 1,
        status: "PLANEJADO",
        dataInicioParcela: "2026-07-10T00:00:00.000Z",
        dataPagamento: null,
        installmentSettlements: [
          {
            parcelaIndex: 0,
            dueDate: "2026-07-10T00:00:00.000Z",
            contractedCents: 80_000,
            paidCents: 40_000,
            remainingCents: 40_000,
            settlementStatus: "PARTIAL",
          },
        ],
      };
      const large = {
        ...expense,
        id: "large",
        titulo: "Contrato extenso",
        valor: 12_345_678,
        valorTotal: 12_345_678,
        installmentSettlements: [
          {
            ...expense.installmentSettlements[0],
            contractedCents: 12_345_678,
            remainingCents: 12_305_678,
          },
        ],
      };
      const mixed = {
        ...expense,
        id: "mixed",
        titulo: "Contrato misto",
        valor: 160_000,
        valorTotal: 160_000,
        quantidadeParcela: 2,
        paidParcelas: "[0]",
        installmentSettlements: [
          {
            ...expense.installmentSettlements[0],
            parcelaIndex: 1,
            dueDate: "2026-08-10T00:00:00.000Z",
          },
        ],
      };
      const fullyPaid = {
        ...mixed,
        id: "mixed-paid",
        titulo: "Contrato misto quitado",
        status: "PAGO",
        paidParcelas: "[0,1]",
        installmentSettlements: [
          {
            ...mixed.installmentSettlements[0],
            paidCents: 80_000,
            remainingCents: 0,
            settlementStatus: "PAID",
          },
        ],
      };
      const project = {
        id: "asset",
        name: "Projeto sintético",
        type: projectType,
        rooms: [],
        onboardedAt: "2026-01-01",
      };
      const json = (body: unknown) => ({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
      await page.route("http://localhost:3001/**", async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (request.method() === "OPTIONS") {
          return route.fulfill({
            status: 204,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Headers": "*",
              "Access-Control-Allow-Methods": "*",
            },
          });
        }
        if (["POST", "PATCH", "DELETE", "PUT"].includes(request.method())) {
          writes.push({
            method: request.method(),
            path,
            body: request.postDataJSON(),
          });
          if (
            request.method() === "PATCH" &&
            path === "/projects/asset/expenses/contract"
          ) {
            if (rejectMetadata) {
              rejectMetadata = false;
              return route.fulfill({
                ...json({
                  message: "Metadados não aceitos; revise e tente novamente.",
                }),
                status: 422,
              });
            }
            return route.fulfill(json(expense));
          }
          throw new Error(`Unexpected write: ${request.method()} ${path}`);
        }
        if (path === "/auth/me")
          return route.fulfill(
            json({
              id: "synthetic-user",
              username: "synthetic",
              name: "Synthetic",
              role: "ADMIN",
              tenantId: "synthetic-702",
              allowedProjects: ["asset"],
              allowedModules: [],
              allowedProjectTypes: [projectType],
            }),
          );
        if (path === "/projects") return route.fulfill(json([project]));
        if (path === "/projects/asset") return route.fulfill(json(project));
        if (path === "/projects/asset/expenses") {
          return route.fulfill(
            json({
              items: [expense, large, mixed, fullyPaid],
              total: 4,
              page: 1,
              pageSize: 2000,
              totalPages: 1,
            }),
          );
        }
        return route.fulfill(json([]));
      });
      await page.goto("/projects/asset/expenses");
      await expect(page).toHaveURL(/\/projects\/asset\/bills\?tab=avulsas$/);
      const row =
        width < 768
          ? page.getByRole("article", { name: "Contrato sintético" })
          : page.getByRole("row", { name: /Contrato sintético/ });
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
      await expect(
        row.getByRole("button", { name: "Excluir", exact: true }),
      ).toBeDisabled();
      for (const expected of [
        {
          title: "Contrato misto",
          paid: "R$ 1.200,00",
          remaining: "R$ 400,00",
          status: "Parcial",
        },
        {
          title: "Contrato misto quitado",
          paid: "R$ 1.600,00",
          remaining: "R$ 0,00",
          status: "Pago",
        },
      ]) {
        const mixedRow =
          width < 768
            ? page.getByRole("article", { name: expected.title, exact: true })
            : page
                .getByRole("row")
                .filter({
                  has: page.getByRole("cell", {
                    name: expected.title,
                    exact: true,
                  }),
                });
        await expect(
          mixedRow.getByText(expected.status, { exact: true }),
        ).toBeVisible();
        await expect(
          mixedRow.getByText("Contratado: R$ 1.600,00", { exact: true }),
        ).toBeVisible();
        await expect(
          mixedRow.getByText(`Pago: ${expected.paid}`, { exact: true }),
        ).toBeVisible();
        await expect(
          mixedRow.getByText(`Restante: ${expected.remaining}`, {
            exact: true,
          }),
        ).toBeVisible();
      }
      const largeRow =
        width < 768
          ? page.getByRole("article", { name: "Contrato extenso" })
          : page.getByRole("row", { name: /Contrato extenso/ });
      await expect(
        largeRow.getByText("Restante: R$ 123.056,78", { exact: true }),
      ).toBeVisible();
      const money = largeRow.getByText(/^(Restante|Contratado|Pago): R\$/);
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
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const edit = row.getByRole("button", { name: "Editar", exact: true });
      const box = await edit.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      expect(box?.width).toBeGreaterThanOrEqual(44);
      await edit.click();
      const balance = page.getByRole("region", { name: "Saldo da despesa" });
      await expect(balance.getByText("Parcial", { exact: true })).toBeVisible();
      await expect(
        balance.getByText("Restante: R$ 400,00", { exact: true }),
      ).toBeVisible();
      for (const name of [
        "valor",
        "status",
        "formaPagamento",
        "quantidadeParcela",
        "dataInicioParcela",
      ]) {
        await expect(page.locator(`[name="${name}"]`)).toBeDisabled();
      }
      await page.locator('input[name="titulo"]').fill("Título corrigido");
      const save = page.getByRole("button", { name: "Salvar", exact: true });
      const saveBox = await save.boundingBox();
      expect(saveBox?.height).toBeGreaterThanOrEqual(44);
      expect(saveBox?.width).toBeGreaterThanOrEqual(44);
      await save.click();
      await expect(
        page.getByText("Metadados não aceitos; revise e tente novamente."),
      ).toBeVisible();
      await expect(page.locator('input[name="titulo"]')).toHaveValue(
        "Título corrigido",
      );
      await save.click();
      await expect(
        page.getByRole("heading", { name: "Editar despesa avulsa" }),
      ).toHaveCount(0);
      const metadataWrite = {
        method: "PATCH",
        path: "/projects/asset/expenses/contract",
        body: {
          titulo: "Título corrigido",
          fornecedor: "Fornecedor sintético",
          tipoDespesa: "OUTROS",
        },
      };
      expect(writes).toEqual([metadataWrite, metadataWrite]);
      expect(errors).toEqual([]);
    });
  }
}
