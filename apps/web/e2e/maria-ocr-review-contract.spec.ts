import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Browser contract for the inert #719 UI foundation. It bundles the real
 * component with local candidates; it does not mock or claim a provider/API
 * journey. Production remains disabled until the backend contract lands.
 */
const root = path.resolve(__dirname, "..");
const component = path.join(
  root,
  "src/app/projects/[projectId]/maria/_components/ImportOcrFoundation.tsx",
);
let script: string;
let css: string;

test.beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { ImportOcrFoundation } from ${JSON.stringify(component)};
        const candidates = [{
          ref: "private-candidate-never-visible",
          status: "UNVERIFIED",
          fields: [
            { key: "merchant", label: "Estabelecimento", value: "Mercado Central" },
            { key: "amountCents", label: "Valor", value: "R$ 123,45" },
          ],
        }];
        const root = createRoot(document.getElementById("root"));
        const render = availability => root.render(
          <main className="mx-auto min-h-screen w-full min-w-0 max-w-3xl p-3">
            <button id="before" className="min-h-11">Antes</button>
            <ImportOcrFoundation
              triggerCode="OCR_REQUIRED"
              scope={{
                key: "private-account:private-project:private-session:private-artifact",
                fileName: "fatura digitalizada.pdf",
              }}
              availability={availability}
              loadCandidates={availability.state === "READY" ? async () => candidates : undefined}
              onPrepare={() => {}}
            />
          </main>
        );
        render({ state: "DISABLED", reason: "FEATURE_OFF" });
        window.showReadyOcrContract = () => render({ state: "READY" });
      `,
      resolveDir: root,
      loader: "tsx",
    },
    bundle: true,
    write: false,
    outfile: "ocr-review-contract.js",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    alias: { "@": path.join(root, "src") },
  });
  script = bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  const sources = await Promise.all(
    [
      component,
      path.join(path.dirname(component), "OcrCandidateReview.tsx"),
      path.join(root, "src/components/ui/modal.tsx"),
      path.join(root, "src/components/ui/use-focus-trap.ts"),
      path.join(root, "src/components/ui/use-overlay-lock.ts"),
    ].map(async (file) => ({
      raw: await readFile(file, "utf8"),
      extension: file.endsWith(".tsx") ? "tsx" : "ts",
    })),
  );
  const compiled = await postcss([
    tailwindcss({
      ...require("../tailwind.config.js"),
      content: sources,
    }),
  ]).process("@tailwind base; @tailwind components; @tailwind utilities;", {
    from: undefined,
  });
  css = compiled.css;
});

async function assertNoHorizontalOverflow(
  page: import("@playwright/test").Page,
) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}

for (const width of [375, 390, 1280]) {
  test(`disabled and UNVERIFIED OCR contracts fit and stay explicit at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(
      `<meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><div id="root"></div>`,
    );
    await page.addScriptTag({ content: script });

    const consent = page.getByRole("checkbox", {
      name: /autorizo o processamento externo/i,
    });
    await expect(consent).toBeDisabled();
    await expect(consent).not.toBeChecked();
    await expect(page.getByText(/OCR está desativado/i)).toBeVisible();
    await expect(
      page.getByRole("button", { name: /tentar|retry/i }),
    ).toHaveCount(0);
    await assertNoHorizontalOverflow(page);

    await page.evaluate(() =>
      (
        window as unknown as { showReadyOcrContract: () => void }
      ).showReadyOcrContract(),
    );
    await consent.check();
    await page
      .getByRole("button", { name: "Solicitar leitura por OCR" })
      .click();

    const dialog = page.getByRole("dialog", {
      name: "Revisar candidatos de OCR",
    });
    await expect(
      dialog.getByText("NÃO VERIFICADO", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByRole("checkbox", { name: /selecionar candidato 1/i }),
    ).not.toBeChecked();
    await expect(dialog).not.toContainText("private-candidate");
    await expect(page.locator("body")).not.toContainText("private-session");
    await assertNoHorizontalOverflow(page);

    const controls = dialog.locator(
      'button, input[type="text"], label:has(input[type="checkbox"])',
    );
    const count = await controls.count();
    for (let index = 0; index < count; index++) {
      const control = controls.nth(index);
      if (!(await control.isVisible())) continue;
      const box = await control.boundingBox();
      expect(box, `control ${index} has a box`).not.toBeNull();
      expect(
        Math.max(box!.height, box!.width),
        `control ${index} has a 44px touch dimension`,
      ).toBeGreaterThanOrEqual(44);
    }
  });
}
