import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { assertTouchable } from "../e2e-qa/helpers/evidence";

// Actual components and native controls, with local output capture only.
// No API mocking or live-import/financial-execution claim.
const root = path.resolve(__dirname, "..");
const component = path.join(
  root,
  "src/app/projects/[projectId]/maria/_components/ImportFocusedQuestion.tsx",
);
let script: string;
let css: string;
test.beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { ImportFocusedQuestion } from ${JSON.stringify(component)};
        import { ProjectProvider } from ${JSON.stringify(path.join(root, "src/contexts/project-context.tsx"))};
        const props = {
          lines: [{ id: "line", titulo: "Compra documental", amountCents: 20696 }],
          inputLabel: "Sua resposta", inputHint: "Confira",
          candidates: [{ lineId: "line", kind: "EXPENSE", id: "candidate-current", projectId: "project", description: "Compra já existente", amountCents: 20696, date: "2026-10-10", reason: "NATURAL_MATCH", canKeepExisting: true }],
          targetProjects: [{ id: "project-reforma", name: "Reforma autorizada", projectType: "REFORMA", eligible: true, active: true, deletedAt: null, rooms: [{ id: "room-reforma", name: "Cozinha" }] }],
          onAnswer: answer => {
            document.getElementById("output").textContent = JSON.stringify(answer);
          }
        };
        createRoot(document.getElementById("root")).render(
          <ProjectProvider value={{projectId: "project", projectType: "REFORMA", projectName: "Reforma"}}>
            <main className="mx-auto w-full max-w-2xl min-w-0 space-y-4 p-4">
              <ImportFocusedQuestion {...props} question={{id: "q-meaning", field: "amountMeaning", lineIds: ["line"], text: "Significado"}} />
              <ImportFocusedQuestion {...props} question={{id: "q-amount", field: "amountCents", lineIds: ["line"], text: "Valor"}} />
              <ImportFocusedQuestion {...props} question={{id: "q-count", field: "installmentCount", lineIds: ["line"], text: "Parcelas"}} />
              <ImportFocusedQuestion {...props} question={{id: "q-purchase-date", field: "dataCompra", lineIds: ["line"], text: "Data da compra"}} />
              <ImportFocusedQuestion {...props} question={{id: "q-date", field: "firstDueDate", lineIds: ["line"], text: "Primeiro vencimento"}} />
              <ImportFocusedQuestion {...props} question={{id: "q-type", field: "tipoDespesa", lineIds: ["line"], text: "Tipo de despesa"}} />
              <ImportFocusedQuestion {...props} question={{id: "q-labor", field: "categoriaMaoDeObra", lineIds: ["line"], text: "Categoria de mão de obra"}} />
              <ImportFocusedQuestion {...props} question={{id: "q-create", field: "decision", lineIds: ["line"], text: "Criar compra"}} />
              <ImportFocusedQuestion {...props} question={{id: "q-targets", field: "targets", lineIds: ["line"], text: "Rateio"}} />
            </main>
          </ProjectProvider>
        );
      `,
      resolveDir: root,
      loader: "tsx",
    },
    bundle: true,
    write: false,
    outfile: "focused-controls.js",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    alias: {
      "@": path.join(root, "src"),
      "@reformaflow/domain": path.resolve(
        root,
        "../../packages/domain/src/index.ts",
      ),
    },
    loader: { ".module.css": "local-css" },
  });
  script = bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  const moduleCss = bundle.outputFiles.find((file) =>
    file.path.endsWith(".css"),
  )!.text;
  const content = await Promise.all(
    [
      component,
      path.join(path.dirname(component), "ImportFocusedDraftQuestion.tsx"),
    ].map(async (file) => ({
      raw: await readFile(file, "utf8"),
      extension: "tsx",
    })),
  );
  content.push({
    raw: "mx-auto w-full max-w-2xl min-w-0 space-y-4 p-4",
    extension: "tsx",
  });
  const compiled = await postcss([
    tailwindcss({
      ...require("../tailwind.config.js"),
      content,
    }),
  ]).process("@tailwind base; @tailwind components; @tailwind utilities;", {
    from: undefined,
  });
  css = compiled.css + moduleCss;
});
for (const width of [375, 390, 1280]) {
  test(`native focused controls at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    // Match the real App Router layout; mobile otherwise uses a 980px layout viewport.
    await page.setContent(
      `<meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><div id="root"></div><output id="output"></output>`,
    );
    expect(
      await page.evaluate(() => document.documentElement.clientWidth),
    ).toBe(width);
    await page.evaluate(() => {
      const viewport = new EventTarget() as VisualViewport;
      let viewportHeight = innerHeight;
      Object.defineProperties(viewport, {
        width: { get: () => innerWidth },
        height: {
          get: () => viewportHeight,
          set: (next: number) => {
            viewportHeight = next;
            viewport.dispatchEvent(new Event("resize"));
          },
        },
        offsetLeft: { value: 0 },
        offsetTop: { value: 0 },
        pageLeft: { get: () => scrollX },
        pageTop: { get: () => scrollY },
        scale: { value: 1 },
      });
      Object.defineProperty(window, "visualViewport", {
        configurable: true,
        value: viewport,
      });
    });
    await page.addScriptTag({ content: script });
    await expect(page.getByRole("form")).toHaveCount(9);
    await expect(
      page.getByRole("button", { name: "Responder à pergunta" }),
    ).toHaveCount(0);
    const waiverRadio = page.getByRole("radio", {
      name: "Criar outra compra — são compras distintas",
      exact: true,
    });
    const waiverLabel = waiverRadio.locator("xpath=ancestor::label");
    await assertTouchable(waiverLabel);
    await expect(waiverRadio).not.toBeChecked();
    await waiverLabel.click({ position: { x: 22, y: 22 } });
    await expect(waiverRadio).toBeChecked();
    const date = page.getByRole("textbox", {
      name: "Primeiro vencimento",
      exact: true,
    });
    await date.fill("2025-10-10");
    await expect(page.locator("#output")).toBeEmpty();
    const dateForm = page.locator("form").filter({ has: date });
    await dateForm.getByRole("button", { name: "Conferir informação" }).click();
    await expect(page.locator("#output")).toBeEmpty();
    await dateForm.getByRole("button", { name: "Guardar informação" }).click();
    await expect(page.locator("#output")).toHaveText(
      JSON.stringify({
        id: "q-date",
        text: "2025-10-10",
        draftAnswer: { field: "firstDueDate", value: "2025-10-10" },
      }),
    );
    const type = page.getByRole("combobox", {
      name: "Tipo de despesa",
      exact: true,
    });
    await type.selectOption("MAO_DE_OBRA");
    const typeForm = page.locator("form").filter({ has: type });
    await typeForm.getByRole("button", { name: "Conferir informação" }).click();
    await typeForm.getByRole("button", { name: "Guardar informação" }).click();
    await expect(page.locator("#output")).toHaveText(
      JSON.stringify({
        id: "q-type",
        text: "MAO_DE_OBRA",
        draftAnswer: { field: "tipoDespesa", value: "MAO_DE_OBRA" },
      }),
    );
    const waiverForm = page.locator("form").filter({ has: waiverRadio });
    await waiverForm
      .getByRole("button", { name: "Conferir informação" })
      .click();
    await waiverForm
      .getByRole("button", { name: "Guardar informação" })
      .click();
    await expect(page.locator("#output")).toHaveText(
      JSON.stringify({
        id: "q-create",
        text: "CREATE_ACCEPT_NATURAL_DUPLICATE",
        draftAnswer: {
          field: "decision",
          value: { kind: "CREATE", acceptNaturalDuplicate: true },
        },
      }),
    );
    for (const choice of [
      {
        label: "Sem rateio — manter no projeto proprietário",
        id: "q-targets",
        text: "NO_TARGETS",
        answer: { field: "targets", value: [] },
      },
    ]) {
      const radio = page.getByRole("radio", {
        name: choice.label,
        exact: true,
      });
      await expect(radio).not.toBeChecked();
      const form = page.locator("form").filter({ has: radio });
      await expect(
        form.getByRole("button", { name: "Guardar informação" }),
      ).toBeDisabled();
      await radio.check();
      await expect(
        form.getByRole("button", { name: "Guardar informação" }),
      ).toBeDisabled();
      await form.getByRole("button", { name: "Conferir informação" }).click();
      await expect(
        form.getByRole("list", { name: "Compras desta pergunta" }),
      ).toContainText("Compra documental");
      await form.getByRole("button", { name: "Guardar informação" }).click();
      await expect(page.locator("#output")).toHaveText(
        JSON.stringify({
          id: choice.id,
          text: choice.text,
          draftAnswer: choice.answer,
        }),
      );
    }
    for (const control of await page
      .locator("form button, form input, form select")
      .all()) {
      if (await control.isDisabled()) continue;
      if ((await control.getAttribute("type")) === "radio") {
        await assertTouchable(control.locator("xpath=ancestor::label"));
        continue;
      }
      await assertTouchable(control);
      await control.focus();
      await expect(control).toBeFocused();
    }
    if (width <= 390) {
      const amount = page.getByRole("textbox", {
        name: "Valor da compra",
        exact: true,
      });
      const amountForm = page.locator("form").filter({ has: amount });
      await amountForm.evaluate((element) =>
        element.scrollIntoView({ block: "start" }),
      );
      await amount.focus();
      const viewportMutation = await page.evaluate(() => {
        const viewport = window.visualViewport!;
        (viewport as unknown as { height: number }).height = 240;
        return {
          height: window.visualViewport!.height,
          sameObject: window.visualViewport === viewport,
        };
      });
      expect(viewportMutation).toEqual({ height: 240, sameObject: true });
      await expect(amount).toBeFocused();
      for (const name of ["Conferir informação", "Guardar informação"]) {
        const action = amountForm.getByRole("button", { name, exact: true });
        const measurement = await action.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return {
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
            visualViewportHeight: window.visualViewport!.height,
          };
        });
        expect(
          measurement.top,
          `${name} above keyboard`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          measurement.bottom,
          `${name} inside visual viewport`,
        ).toBeLessThanOrEqual(measurement.visualViewportHeight);
        expect(measurement.width, `${name} touch width`).toBeGreaterThanOrEqual(
          44,
        );
        expect(
          measurement.height,
          `${name} touch height`,
        ).toBeGreaterThanOrEqual(44);
      }
      await expect(amount).toBeFocused();
    } else {
      const amount = page.getByRole("textbox", {
        name: "Valor da compra",
        exact: true,
      });
      const amountForm = page.locator("form").filter({ has: amount });
      await amountForm.evaluate((element) =>
        element.scrollIntoView({ block: "center" }),
      );
      const scrollBeforeFocus = await page.evaluate(() => scrollY);
      await amount.focus();
      await expect(amount).toBeFocused();
      expect(await page.evaluate(() => scrollY)).toBe(scrollBeforeFocus);
      for (const name of ["Conferir informação", "Guardar informação"]) {
        const action = amountForm.getByRole("button", { name, exact: true });
        const box = await action.boundingBox();
        expect(box, `${name} has a desktop layout box`).not.toBeNull();
        expect(
          box!.width,
          `${name} desktop touch width`,
        ).toBeGreaterThanOrEqual(44);
        expect(
          box!.height,
          `${name} desktop touch height`,
        ).toBeGreaterThanOrEqual(44);
      }
      expect(await page.evaluate(() => window.visualViewport!.height)).toBe(
        900,
      );
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  });
}
