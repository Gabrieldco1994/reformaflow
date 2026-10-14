import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const component = path.join(
  root,
  "src/app/projects/[projectId]/maria/_components/ImportOcrFoundation.tsx",
);
const privateTokens = [
  "session-private-final-719",
  "attachment-private-final-719",
  "request-private-final-719",
  "a".repeat(64),
];
let script: string;
let css: string;

test.beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import React, { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { ImportOcrFoundation } from ${JSON.stringify(component)};

        function Contract() {
          const [state, setState] = useState({ kind: "CONSENT_REQUIRED" });
          return (
            <main className="mx-auto min-h-screen w-full min-w-0 max-w-3xl p-3">
              <ImportOcrFoundation
                state={state}
                scope={{
                  key: ${JSON.stringify(privateTokens.join(":"))},
                  fileName: "fatura digitalizada.pdf",
                }}
                onConsent={() => setState({ kind: "OCR_ATTEMPT_UNKNOWN" })}
              />
            </main>
          );
        }

        createRoot(document.getElementById("root")).render(<Contract />);
      `,
      resolveDir: root,
      loader: "tsx",
    },
    bundle: true,
    write: false,
    outfile: "ocr-final-release-barrier.js",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    alias: { "@": path.join(root, "src") },
  });
  script = bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  const source = await readFile(component, "utf8");
  css = (
    await postcss([
      tailwindcss({
        ...require("../tailwind.config.js"),
        content: [{ raw: source, extension: "tsx" }],
      }),
    ]).process("@tailwind base; @tailwind components; @tailwind utilities;", {
      from: undefined,
    })
  ).css;
});

async function assertBoundedAndPrivate(page: import("@playwright/test").Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const body = await page.locator("body").innerText();
  for (const token of privateTokens) expect(body).not.toContain(token);
  await expect(
    page.locator(
      'a[href*="/uploads/"], a[href*="private"], img[src*="/uploads/"], img[src*="private"]',
    ),
  ).toHaveCount(0);
}

for (const width of [375, 390, 1280]) {
  test(`complete consent and terminal unknown state at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(
      `<meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><div id="root"></div>`,
    );
    await page.addScriptTag({ content: script });

    const consent = page.getByRole("checkbox", {
      name: /autorizo o envio do PDF original completo/i,
    });
    const submit = page.getByRole("button", {
      name: "Autorizar leitura externa",
    });
    await expect(consent).not.toBeChecked();
    await expect(submit).toBeDisabled();
    await expect(
      page.getByRole("region", { name: "Leitura externa do documento" }),
    ).toContainText(
      /PDF original completo.*metadados.*conteúdo potencialmente não visível ou incorporado/i,
    );
    await assertBoundedAndPrivate(page);

    for (const target of [consent.locator(".."), submit]) {
      const box = await target.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      expect(box!.width).toBeGreaterThanOrEqual(44);
    }

    await consent.check();
    await submit.click();
    const unknown = page.getByRole("alert");
    await expect(unknown).toContainText(/não foi possível confirmar/i);
    await expect(unknown).toContainText(/não pode ser repetida/i);
    await expect(
      page.getByRole("button", { name: /autorizar|tentar|retry/i }),
    ).toHaveCount(0);
    await expect(page.getByText(/Entrada manual:/i)).toBeVisible();
    await expect(page.getByText(/Substituir o arquivo:/i)).toBeVisible();
    await expect(page.getByText(/Cancelar:/i)).toBeVisible();
    await assertBoundedAndPrivate(page);
    await expect(unknown).toContainText(
      /pode ter sido enviado.*Google Cloud Vertex AI/i,
    );
  });
}
