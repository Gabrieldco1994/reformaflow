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
          lines: [{ id: "line", titulo: "Compra documental" }],
          inputLabel: "Sua resposta", inputHint: "Confira",
          onAnswer: answer => {
            document.getElementById("output").textContent = JSON.stringify(answer);
          }
        };
        createRoot(document.getElementById("root")).render(
          <ProjectProvider value={{projectId: "project", projectType: "REFORMA", projectName: "Reforma"}}>
            <main className="mx-auto w-full max-w-2xl min-w-0 space-y-4 p-4">
              <ImportFocusedQuestion {...props} question={{id: "q-date", field: "firstDueDate", lineIds: ["line"], text: "Primeiro vencimento"}} />
              <ImportFocusedQuestion {...props} question={{id: "q-type", field: "tipoDespesa", lineIds: ["line"], text: "Tipo de despesa"}} />
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
    await page.addScriptTag({ content: script });
    const date = page.locator('input[type="date"]');
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
    for (const choice of [
      {
        label: "Criar nova compra",
        id: "q-create",
        answer: {
          field: "decision",
          value: { kind: "CREATE", acceptNaturalDuplicate: false },
        },
      },
      {
        label: "Sem rateio — manter a compra no projeto proprietário",
        id: "q-targets",
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
        form.getByRole("list", { name: "Compras afetadas pela escolha" }),
      ).toContainText("Compra documental");
      await form.getByRole("button", { name: "Guardar informação" }).click();
      await expect(page.locator("#output")).toHaveText(
        JSON.stringify({
          id: choice.id,
          text: choice.label,
          draftAnswer: choice.answer,
        }),
      );
    }
    for (const control of await page
      .locator("form button, form input, form select")
      .all())
      await assertTouchable(control);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  });
}
