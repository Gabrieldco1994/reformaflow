import { test, expect, type Locator, type Page } from "@playwright/test";

const filename =
  "compra-documental-sintetica-com-nome-extenso-sem-agrupamento-de-compras-iguais.png";
const file = {
  name: filename,
  mimeType: "image/png",
  buffer: Buffer.from("fixture de seleção local, não é OCR"),
};

async function measurableAndReachable(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  const box = await control.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(44);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  const reachable = await control.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.x + rect.width / 2,
      rect.y + rect.height / 2,
    );
    return hit !== null && (element === hit || element.contains(hit));
  });
  expect(reachable).toBe(true);
  await test.info().attach("control-box", {
    body: JSON.stringify({
      name:
        (await control.getAttribute("aria-label")) ??
        (await control.textContent()),
      box,
      reachable,
    }),
    contentType: "application/json",
  });
}

async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

for (const width of [375, 390, 1280]) {
  test.describe(`${width}px — real components, no API`, () => {
    test.use({ viewport: { width, height: 900 } });
    test.beforeEach(async ({ page }) => {
      await page.goto("/");
      await expect(
        page.getByRole("heading", { name: "Harness local M1 — sem API" }),
      ).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      expect(
        await page.evaluate(() => document.fonts.check('16px "Geist"')),
      ).toBe(true);
      expect(
        await page
          .locator("body")
          .evaluate((element) => getComputedStyle(element).fontFamily),
      ).toContain("Geist");
    });

    test("local selection, remove/cancel focus, explicit consent and actual touch boxes", async ({
      page,
    }, testInfo) => {
      const requests: string[] = [];
      page.on("request", (request) => {
        if (["fetch", "xhr"].includes(request.resourceType()))
          requests.push(request.url());
      });
      const form = page.getByRole("form", { name: "Documentos para análise" });
      const picker = page.getByLabel("Selecionar arquivos", { exact: true });
      const consent = form.getByRole("button", {
        name: "Analisar e guardar rascunho",
      });
      const cancel = form.getByRole("button", { name: "Cancelar seleção" });
      await picker.setInputFiles([file, file]);
      await expect(form.getByRole("status")).toHaveText(
        "Arquivo selecionado. Nada foi enviado.",
      );
      await expect(page.getByLabel("Eventos locais")).toHaveText("[]");
      for (const control of [
        picker,
        consent,
        cancel,
        ...(await form.getByRole("button", { name: /^Remover arquivo/ }).all()),
      ]) {
        await measurableAndReachable(control);
      }
      await noOverflow(page);
      await picker.focus();
      await expect(picker).toBeFocused();
      await page.screenshot({
        path: testInfo.outputPath(`documents-${width}.png`),
        fullPage: true,
      });
      const remove = form.getByRole("button", {
        name: `Remover arquivo 1: ${filename}`,
        exact: true,
      });
      await remove.focus();
      await page.keyboard.press("Enter");
      await expect(form.getByRole("listitem")).toHaveCount(1);
      await expect(
        form.getByRole("button", {
          name: `Remover arquivo 1: ${filename}`,
          exact: true,
        }),
      ).toBeFocused();
      await cancel.click();
      await expect(picker).toBeFocused();
      await expect(form.getByRole("listitem")).toHaveCount(0);
      await expect(page.getByLabel("Eventos locais")).toHaveText("[]");
      await picker.setInputFiles(file);
      await consent.focus();
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      await expect(consent).toBeDisabled();
      await expect(page.getByLabel("Eventos locais")).toHaveText(
        JSON.stringify([{ kind: "consent", names: [filename] }]),
      );
      expect(requests).toEqual([]);
    });

    test("focused question, keyboard input, literal targeted event and no overlap", async ({
      page,
    }, testInfo) => {
      await page.getByRole("button", { name: "Abrir pergunta" }).click();
      const input = page.getByRole("textbox", {
        name: "Sua resposta sobre esta compra",
      });
      const answer = page.getByRole("button", { name: "Responder à pergunta" });
      await expect(input).toBeFocused();
      await expect(input).toHaveAccessibleDescription(
        "Responda com suas palavras, sem converter o valor.",
      );
      await expect(
        page.getByText("— Compra purchase-second", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByText("purchase-first", { exact: false }),
      ).toHaveCount(0);
      const text = "  R$ -123.456,78? É parcela, não total!  ";
      await input.fill(text);
      await measurableAndReachable(input);
      await measurableAndReachable(answer);
      await noOverflow(page);
      await input.focus();
      await page.screenshot({
        path: testInfo.outputPath(`question-${width}.png`),
        fullPage: true,
      });
      await page.keyboard.press("Tab");
      await expect(answer).toBeFocused();
      expect(
        await answer.evaluate(
          (element) => getComputedStyle(element).outlineStyle,
        ),
      ).not.toBe("none");
      await page.keyboard.press("Enter");
      await expect(page.getByLabel("Eventos locais")).toHaveText(
        JSON.stringify([{ kind: "answer", id: "question-second", text }]),
      );
      await expect(input).toBeEnabled();
      await expect(answer).toBeEnabled();
      await expect(input).toHaveValue(text);
      const correction = " Corrigindo: é o total.";
      await input.focus();
      await page.keyboard.press("End");
      await page.keyboard.type(correction);
      const correctedText = `${text}${correction}`;
      await expect(input).toBeFocused();
      await expect(input).toHaveValue(correctedText);
      await expect(page.getByLabel("Eventos locais")).toHaveText(
        JSON.stringify([{ kind: "answer", id: "question-second", text }]),
      );
      await page.keyboard.press("Enter");
      await expect(page.getByLabel("Eventos locais")).toHaveText(
        JSON.stringify([
          { kind: "answer", id: "question-second", text },
          { kind: "answer", id: "question-second", text: correctedText },
        ]),
      );
    });

    test("unavailable callbacks and pending deny actions without success", async ({
      page,
    }) => {
      const picker = page.getByLabel("Selecionar arquivos", { exact: true });
      const consent = page.getByRole("button", {
        name: "Analisar e guardar rascunho",
      });
      await picker.setInputFiles(file);
      await page.getByLabel("Callbacks locais disponíveis").uncheck();
      await expect(consent).toBeDisabled();
      await page.getByRole("button", { name: "Abrir pergunta" }).click();
      const input = page.getByRole("textbox", {
        name: "Sua resposta sobre esta compra",
      });
      await input.fill("parcela");
      const answer = page.getByRole("button", { name: "Responder à pergunta" });
      await expect(answer).toBeDisabled();
      await page.getByLabel("Etapa pendente").check();
      await page.getByLabel("Callbacks locais disponíveis").check();
      await expect(picker).toBeDisabled();
      await expect(input).toBeDisabled();
      await expect(consent).toBeDisabled();
      await expect(answer).toBeDisabled();
      await expect(page.getByLabel("Eventos locais")).toHaveText("[]");
    });
  });
}
