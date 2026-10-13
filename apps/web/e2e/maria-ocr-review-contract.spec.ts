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
const evidenceComponent = path.join(
  root,
  "src/app/projects/[projectId]/maria/_components/OcrCandidateEvidence.tsx",
);
let script: string;
let css: string;

test.beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import React, { useState } from "react";
        import { createRoot } from "react-dom/client";
        import { ImportOcrFoundation } from ${JSON.stringify(component)};
        import { OcrCandidateEvidence } from ${JSON.stringify(evidenceComponent)};

        function Contract() {
          const [attempted, setAttempted] = useState(false);
          return (
            <main className="mx-auto min-h-screen w-full min-w-0 max-w-3xl p-3">
              <button id="before" className="min-h-11">Antes</button>
              <ImportOcrFoundation
                state={attempted ? { kind: "OCR_ATTEMPT_UNKNOWN" } : { kind: "CONSENT_REQUIRED" }}
                scope={{
                  key: "private-session:private-attachment",
                  fileName: "fatura digitalizada.pdf",
                }}
                onConsent={() => setAttempted(true)}
              />
              {attempted && <OcrCandidateEvidence text="Mercado Central" />}
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
    outfile: "ocr-review-contract.js",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    alias: { "@": path.join(root, "src") },
  });
  script = bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  const sources = await Promise.all(
    [component, evidenceComponent].map((file) => readFile(file, "utf8")),
  );
  const compiled = await postcss([
    tailwindcss({
      ...require("../tailwind.config.js"),
      content: sources.map((raw) => ({ raw, extension: "tsx" })),
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
  test(`external consent is explicit, bounded, and terminal at ${width}px`, async ({
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
      page.getByText(/somente PDFs totalmente digitalizados/i),
    ).toBeVisible();
    await expect(
      page.getByText(/PDFs mistos ou pesquisáveis não são enviados/i),
    ).toBeVisible();
    await expect(
      page.getByText(
        /Google Cloud Vertex AI.*Gemini 2\.5 Flash.*southamerica-east1/i,
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        /Se você autorizar.*metadados.*conteúdo.*não visível ou incorporado/i,
      ),
    ).toBeVisible();
    await expect(page.locator("body")).not.toContainText("private-session");
    await assertNoHorizontalOverflow(page);

    for (const control of [consent.locator(".."), submit]) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(Math.max(box!.height, box!.width)).toBeGreaterThanOrEqual(44);
    }

    await consent.check();
    await submit.click();
    await expect(page.getByRole("alert")).toContainText(
      "Não foi possível confirmar o resultado do OCR",
    );
    await expect(
      page.getByRole("note", { name: "Evidência da extração externa" }),
    ).toContainText(
      "PDF original · Google Cloud Vertex AI · Gemini 2.5 Flash · southamerica-east1",
    );
    await expect(page.getByText(/Entrada manual:/i)).toBeVisible();
    await expect(page.getByText(/Substituir o arquivo:/i)).toBeVisible();
    await expect(page.getByText(/Cancelar:/i)).toBeVisible();
    await expect(
      page.getByRole("button", { name: /autorizar|tentar|retry/i }),
    ).toHaveCount(0);
    await assertNoHorizontalOverflow(page);
  });
}
