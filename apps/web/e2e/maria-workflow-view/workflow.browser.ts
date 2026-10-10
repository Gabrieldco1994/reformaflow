import { test, expect, type Locator } from "@playwright/test";
import {
  workflowFixture,
  confirmedFixture,
  appliedFixture,
  workflowCatalog,
} from "../../src/app/projects/[projectId]/maria/_lib/import-workflow-fixtures";

async function reachable(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  const measured = await control.evaluate((element) => {
    const r = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      r.x + r.width / 2,
      r.y + r.height / 2,
    );
    return {
      width: r.width,
      height: r.height,
      reachable: hit !== null && (hit === element || element.contains(hit)),
    };
  });
  expect(measured.width).toBeGreaterThanOrEqual(44);
  expect(measured.height).toBeGreaterThanOrEqual(44);
  expect(measured.reachable).toBe(true);
  await test.info().attach("control-geometry", {
    body: JSON.stringify({ name: await control.textContent(), ...measured }),
    contentType: "application/json",
  });
}

for (const viewport of [
  { width: 375, narrow: false },
  { width: 390, narrow: false },
  { width: 1280, narrow: false },
  { width: 1280, narrow: true },
]) {
  test(`full proposal and keyboard execution ${viewport.width}px narrow=${viewport.narrow}`, async ({
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
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.clock.setFixedTime(new Date("2026-10-07T03:00:00.000Z"));
    let current = workflowFixture();
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    const browserErrors: string[] = [];
    const blockedEgress: string[] = [];
    await page.context().route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === harnessUrl.origin && request.method() === "GET") {
        await route.continue();
        return;
      }
      blockedEgress.push(`${request.method()} ${url.origin}`);
      await route.abort("blockedbyclient");
    });
    page.on("pageerror", (error) => {
      browserErrors.push(error.message);
      void info.attach("pageerror", {
        body: error.message,
        contentType: "text/plain",
      });
    });
    page.on("console", (message) => {
      if (message.type() === "error") {
        browserErrors.push(message.text());
        void info.attach("console-error", {
          body: message.text(),
          contentType: "text/plain",
        });
      }
    });
    await page.route("http://localhost:3001/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const body = request.method() === "POST" ? request.postDataJSON() : null;
      // Never retain nonce values, even from the synthetic trusted request.
      requests.push({
        path,
        method: request.method(),
        body:
          body && "nonce" in body
            ? { ...body, nonce: "[ephemeral omitted]" }
            : body,
      });
      let result: unknown;
      if (path === "/projects") result = workflowCatalog.projects;
      else if (path === "/tenant/credit-cards") result = workflowCatalog.cards;
      else if (path.endsWith("/confirmation-challenge"))
        result = {
          nonce: "synthetic-memory-only",
          expiresAt: "2026-10-07T03:05:00.000Z",
        };
      else if (path.endsWith("/confirm")) {
        expect(request.headers()["x-rf-import-ui"]).toBe("1");
        current = confirmedFixture(body.financialRequestId);
        result = {
          sessionId: current.id,
          financialRequestId: body.financialRequestId,
          state: "CONFIRMED",
        };
      } else if (path.endsWith("/execute")) {
        expect(request.headers()["x-rf-import-ui"]).toBe("1");
        current = appliedFixture(body.financialRequestId);
        result = current.receipt;
      } else if (path === "/import-sessions/session-a") result = current;
      else throw new Error(`Unplanned harness request: ${path}`);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(result),
      });
    });
    await page.goto(viewport.narrow ? "/?narrow" : "/");
    const confirm = page.getByRole("button", {
      name: "Confirmar lote",
      exact: true,
    });
    await expect(confirm).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const card = page.getByRole("region", { name: "Revisão do lote" });
    await expect(
      card
        .getByRole("list", { name: "Compras do lote", exact: true })
        .locator(":scope > li"),
    ).toHaveCount(2);
    await expect(card.getByText("R$ 999.999,99", { exact: true })).toHaveCount(
      4,
    );
    await expect(
      card.getByText("R$ 1.999.999,98", { exact: true }),
    ).toHaveCount(1);
    await expect(
      card.getByText(/Primeiro: 20\/11\/2026 · Último: 20\/12\/2026/),
    ).toHaveCount(4);
    await expect(card.getByText(/Fatura 12\/2026/)).toHaveCount(4);
    await expect(card.getByText(/Fatura 01\/2027/)).toHaveCount(4);
    const buttons = await card.getByRole("button").allTextContents();
    expect(buttons).toEqual(["Confirmar lote"]);
    for (const control of [...(await card.locator("summary").all()), confirm])
      await reachable(control);
    const boxes = await card
      .locator("[data-workflow-money]")
      .evaluateAll((elements) =>
        elements.map((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const rect = element.getBoundingClientRect();
          return {
            text: element.textContent,
            lines: range.getClientRects().length,
            width: rect.width,
            nowrap: getComputedStyle(element).whiteSpace,
          };
        }),
      );
    expect(boxes.length).toBeGreaterThan(10);
    expect(boxes.every((b) => b.lines === 1 && b.nowrap === "nowrap")).toBe(
      true,
    );
    expect(await card.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(
      true,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (viewport.narrow)
      expect(
        await page
          .locator(".workflow-host")
          .evaluate((e) => e.getBoundingClientRect().width),
      ).toBe(320);
    await test.info().attach("money-boxes", {
      body: JSON.stringify(boxes),
      contentType: "application/json",
    });
    await test.info().attach("proposal-fixture", {
      body: JSON.stringify(current),
      contentType: "application/json",
    });
    await confirm.focus();
    await expect(confirm).toBeFocused();
    expect(
      await page.evaluate(
        () => matchMedia("(prefers-reduced-motion: reduce)").matches,
      ),
    ).toBe(true);
    expect(
      await confirm.evaluate((e) => getComputedStyle(e).outlineStyle),
    ).not.toBe("none");
    await info.attach("motion-style", {
      body: JSON.stringify(
        await confirm.evaluate((e) => ({
          media: matchMedia("(prefers-reduced-motion: reduce)").matches,
          classes: e.className,
          property: getComputedStyle(e).transitionProperty,
          duration: getComputedStyle(e).transitionDuration,
          font: getComputedStyle(e).fontFamily,
        })),
      ),
      contentType: "application/json",
    });
    expect(
      await confirm.evaluate((e) => {
        const style = getComputedStyle(e);
        return (
          style.transitionProperty === "none" ||
          style.transitionDuration === "0s"
        );
      }),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("proposal.png"),
      fullPage: true,
    });
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Comprovante da importação" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Revisão do lote", exact: true }),
    ).toBeFocused();
    await expect(confirm).toHaveCount(0);
    expect(
      requests.filter((r) => r.method === "POST").map((r) => r.path),
    ).toEqual([
      "/import-sessions/session-a/confirmation-challenge",
      "/import-sessions/session-a/confirm",
      "/import-sessions/session-a/execute",
    ]);
    const read = page.getByRole("button", {
      name: "Consultar estado guardado",
    });
    await reachable(read);
    await read.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Revisão do lote", exact: true }),
    ).toBeFocused();
    expect(requests.filter((r) => r.path.endsWith("/execute"))).toHaveLength(1);
    expect(browserErrors).toEqual([]);
    expect(blockedEgress).toEqual([]);
    await page.screenshot({
      path: info.outputPath("receipt.png"),
      fullPage: true,
    });
    await test.info().attach("transport-redacted", {
      body: JSON.stringify(requests),
      contentType: "application/json",
    });
    await test.info().attach("browser-errors", {
      body: JSON.stringify(browserErrors),
      contentType: "application/json",
    });
  });
}
