import { test, expect, type Locator } from "@playwright/test";
import {
  workflowFixture,
  workflowCatalog,
} from "../../src/app/projects/[projectId]/maria/_lib/import-workflow-fixtures";

async function reachable(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  const box = await control.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.x + rect.width / 2,
      rect.y + rect.height / 2,
    );
    return {
      width: rect.width,
      height: rect.height,
      reachable: hit === element || (hit !== null && element.contains(hit)),
    };
  });
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.reachable).toBe(true);
  return box;
}

for (const viewport of [
  { width: 375, narrow: false },
  { width: 390, narrow: false },
  { width: 1280, narrow: false },
  { width: 1280, narrow: true },
]) {
  test(`X3 actual units, document facts and persistent warning ${viewport.width} narrow=${viewport.narrow}`, async ({
    page,
    baseURL,
  }, info) => {
    if (!baseURL) throw new Error("Missing loopback Playwright baseURL");
    const harnessUrl = new URL(baseURL);
    expect({
      protocol: harnessUrl.protocol,
      hostname: harnessUrl.hostname,
      username: harnessUrl.username,
      password: harnessUrl.password,
    }).toEqual({
      protocol: "http:",
      hostname: "127.0.0.1",
      username: "",
      password: "",
    });
    expect(Number(harnessUrl.port)).toBeGreaterThan(0);
    await page.setViewportSize({ width: viewport.width, height: 900 });
    await page.clock.setFixedTime(new Date("2026-10-08T03:00:00Z"));
    let current = workflowFixture();
    current.state = "NEEDS_INPUT";
    current.proposal = null;
    current.actions = ["RESOLVE", "CANCEL"];
    current.reviewBlockers = [
      {
        lineId: "first",
        code: "ORIGINAL_IDENTITY_INCOMPLETE",
        resolution: "SEARCH_IDENTITY_UNAVAILABLE",
      },
      {
        lineId: "first",
        code: "ORIGINAL_OCCURRENCE_INCOMPLETE",
        resolution: "NEEDS_DECLARATION",
      },
    ];
    current.attachments = ["attachment-a", "attachment-b"].map((id) => ({
      id,
      fileName: `documento-de-compra-com-nome-extenso-${id}.pdf`,
      declaredBytes: 1024,
      state: "ATTACHED",
      materializedInSession: false,
      canAnalyze: false,
    }));
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    const errors: string[] = [];
    const egress: string[] = [];
    let loseB = true;
    let releaseEdit!: () => void;
    const edit = new Promise<void>((resolve) => {
      releaseEdit = resolve;
    });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.context().route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (
        url.origin === harnessUrl.origin &&
        route.request().method() === "GET"
      )
        return route.continue();
      egress.push(`${route.request().method()} ${url.origin}`);
      await route.abort("blockedbyclient");
    });
    await page.route("http://localhost:3001/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();
      const body =
        method === "POST" || method === "PATCH" ? request.postDataJSON() : null;
      requests.push({ path, method, body });
      let result: unknown;
      if (path === "/projects") result = workflowCatalog.projects;
      else if (path === "/tenant/credit-cards") result = workflowCatalog.cards;
      else if (path.endsWith("/analyze")) {
        expect(request.headers()["x-rf-import-ui"]).toBe("1");
        expect(body).toEqual({ expectedRevision: current.revision });
        const attachment = current.attachments.find(
          (a) => a.id === path.split("/")[4],
        );
        if (!attachment || !attachment.canAnalyze)
          throw new Error("Unexpected analysis in offline fixture");
        if (attachment.id === "attachment-b" && loseB) {
          loseB = false;
          result = { untrusted: "not a materialization result" };
        } else {
          attachment.materializedInSession = true;
          attachment.canAnalyze = false;
          current.revision++;
          current.actions = current.attachments.some((a) => a.canAnalyze)
            ? ["ANALYZE", "RESOLVE", "CANCEL"]
            : ["RESOLVE", "CANCEL"];
          result = current;
        }
      } else if (path.endsWith("/draft") && method === "PATCH") {
        expect(body).toEqual({
          expectedRevision: current.revision,
          questionId: null,
          replaceLines: [],
          selectedLineIds: ["twin"],
        });
        await edit;
        current.revision++;
        current.selectedLineIds = ["twin"];
        current.actions = ["RESOLVE", "PREPARE", "CANCEL"];
        result = current;
      } else if (path === "/agent/chat") {
        expect(body.importTurn.intent).toBe("OPEN_REVIEW");
        const proposal = workflowFixture().proposal;
        if (!proposal) throw new Error("Missing synthetic proposal");
        current.revision++;
        current.state = "READY";
        current.actions = ["CONFIRM", "CANCEL"];
        current.lines[1].decision = {
          kind: "KEEP_EXISTING",
          expenseId: "existing",
        };
        current.proposal = {
          ...proposal,
          revision: current.revision,
          lines: [
            {
              kind: "KEEP_EXISTING",
              lineId: "twin",
              sourceExpenseId: "existing",
              totalCents: -12345678,
              schedule: {
                version: 1,
                occurrences: [
                  {
                    index: 0,
                    parcela: null,
                    valor: -12345678,
                    data: "2026-10-06",
                    invoiceDueMonth: null,
                  },
                ],
              },
            },
          ],
          createdEconomicTotalCents: 0,
          invoiceDeltas: [],
          deferredObservationIds: ["observation-first"],
          retainUntil: current.expiresAt,
        };
        result = {
          importOutcome: {
            version: 1,
            turnId: body.importTurn.turnId,
            ref: { sessionId: current.id, revision: current.revision },
            acknowledgment: "PREPARED",
            kind: "OPEN_REVIEW",
          },
        };
      } else if (path === "/import-sessions/session-a" && method === "GET")
        result = current;
      else throw new Error(`Unexpected offline request ${method} ${path}`);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(result),
      });
    });

    const query = viewport.narrow ? "&narrow" : "";
    await page.goto(`/?conversation${query}`);
    const warning = page.getByRole("heading", {
      name: "Verificação documental pendente",
    });
    await expect(warning).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Consultar pergunta atual" }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Analisar/ })).toHaveCount(0);
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
    expect(requests.every((r) => r.method === "GET")).toBe(true);
    current.attachments.forEach((a) => {
      a.canAnalyze = true;
    });
    current.actions = ["ANALYZE", "RESOLVE", "CANCEL"];
    await page.reload();
    const analyze = page.getByRole("button", {
      name: "Analisar documentos disponíveis",
    });
    await expect(analyze).toBeEnabled();
    const geometry: Record<string, unknown> = {
      analyze: await reachable(analyze),
    };
    await analyze.focus();
    await page.keyboard.press("Enter");
    const recover = page.getByRole("button", {
      name: "Consultar estado dos documentos",
    });
    await expect(recover).toBeVisible();
    await expect(
      page.getByText(/Análise documental guardada nesta importação/),
    ).toHaveCount(1);
    expect(
      requests.filter((r) => r.path.endsWith("/analyze")).map((r) => r.body),
    ).toEqual([{ expectedRevision: 7 }, { expectedRevision: 8 }]);
    geometry.recover = await reachable(recover);
    await recover.click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(requests.filter((r) => r.path.endsWith("/analyze"))).toHaveLength(2);
    const retry = page.getByRole("button", {
      name: "Analisar documento: documento-de-compra-com-nome-extenso-attachment-b.pdf",
    });
    geometry.retry = await reachable(retry);
    await retry.click();
    await expect(
      page.getByText(/Análise documental guardada nesta importação/),
    ).toHaveCount(2);
    await expect(warning).toHaveCount(1);
    await page.reload();
    await expect(warning).toHaveCount(1);
    expect(requests.filter((r) => r.path.endsWith("/analyze"))).toHaveLength(3);
    await expect(
      page.getByText(/Faltam dados originais necessários à identificação/),
    ).toHaveCount(1);
    await expect(
      page.getByText(/Faltam dados originais necessários à correspondência/),
    ).toHaveCount(1);

    const remove = page.getByRole("button", {
      name: "Retirar compra first da seleção",
    });
    geometry.remove = await reachable(remove);
    await remove.focus();
    await page.keyboard.press("Enter");
    await expect
      .poll(() => requests.filter((r) => r.method === "PATCH").length)
      .toBe(1);
    await expect(
      page.getByText(/Esta seleção contém uma compra com verificação pendente/),
    ).toBeVisible();
    await expect(
      page.getByText("Fora deste lote · verificação pendente"),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Abrir revisão do lote" }),
    ).toHaveCount(0);
    releaseEdit();
    await expect(
      page.getByText("Fora deste lote · verificação pendente"),
    ).toBeVisible();
    await expect(warning).toBeFocused();
    const review = page.getByRole("button", { name: "Abrir revisão do lote" });
    geometry.review = await reachable(review);
    await review.click();
    const card = page.getByRole("region", { name: "Revisão do lote" });
    const confirm = card.getByRole("button", { name: "Confirmar lote" });
    await expect(confirm).toBeEnabled();
    await expect(warning).toHaveCount(1);
    await expect(
      card.getByText("Fora deste lote · verificação pendente"),
    ).toBeVisible();
    geometry.confirm = await reachable(confirm);
    await page.evaluate(() => document.fonts.ready);
    const money = await card
      .locator("[data-workflow-money]")
      .evaluateAll((elements) =>
        elements.map((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const box = element.getBoundingClientRect();
          return {
            text: element.textContent,
            width: box.width,
            lines: range.getClientRects().length,
            nowrap: getComputedStyle(element).whiteSpace,
          };
        }),
      );
    expect(
      money.some((m) => m.text?.includes("123.456,78") && m.text.includes("-")),
    ).toBe(true);
    expect(
      money.every((m) => m.width > 0 && m.lines === 1 && m.nowrap === "nowrap"),
    ).toBe(true);
    expect(
      await card.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await info.attach("review-render", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });

    current.proposal = null;
    current.attachments[0].materializedInSession = false;
    current.attachments[0].canAnalyze = true;
    current.actions = ["ANALYZE", "RESOLVE", "CANCEL"];
    const beforeRecovery = requests.length;
    await page.goto(`/?recovery${query}`);
    await expect(warning).toHaveCount(1);
    await expect(page.getByRole("button")).toHaveCount(0);
    await expect(
      page.getByText("Fora deste lote · verificação pendente"),
    ).toBeVisible();
    await expect(page.getByText("R$ 999.999,99", { exact: true })).toHaveCount(
      2,
    );
    expect(
      requests.slice(beforeRecovery).every((r) => r.method === "GET"),
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      requests.some((r) =>
        /\/(confirm|execute|confirmation-challenge)$/.test(r.path),
      ),
    ).toBe(false);
    expect(errors).toEqual([]);
    expect(egress).toEqual([]);
    await info.attach("recovery-render", {
      body: await page.screenshot({ fullPage: true }),
      contentType: "image/png",
    });
    await info.attach("geometry-and-requests", {
      body: JSON.stringify(
        { viewport, geometry, money, requests, errors, egress },
        null,
        2,
      ),
      contentType: "application/json",
    });
  });
}
