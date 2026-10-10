import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ExpenseType,
  IMPORT_SESSION_KIND,
  ImportSessionAmountMeaning,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import type { ReceiptView } from "../src/app/projects/[projectId]/maria/_lib/import-receipt-view";
import {
  assertReadableMoney,
  assertTouchable,
} from "../e2e-qa/helpers/evidence";

// Browser-only layout fixtures over the actual components and project Tailwind.
// The execution hook is read-only fixture state: this does NOT prove a live import.
const root = path.resolve(__dirname, "..");
const components = path.join(
  root,
  "src/app/projects/[projectId]/maria/_components",
);
const schedule = {
  version: 1 as const,
  occurrences: [
    {
      index: 1,
      parcela: "1/1",
      data: "2025-09-01",
      invoiceDueMonth: "2025-10",
      valor: 123456789,
    },
  ],
};
const review: ImportSessionViewV1 = {
  version: 1,
  id: "layout-session",
  revision: 2,
  ownerProjectId: "source",
  cardId: "card",
  state: "READY",
  expiresAt: "2026-10-17T12:00:00.000Z",
  attachments: [],
  lines: [
    {
      id: "line",
      observationIds: ["observation"],
      titulo:
        "Compra documental com estabelecimento e finalidade de nomes longos",
      fornecedor: "LOJA FICTICIA NORTE",
      tipoDespesa: ExpenseType.OUTROS,
      categoriaMaoDeObra: null,
      amountMeaning: ImportSessionAmountMeaning.TOTAL_PURCHASE,
      amountCents: 123456789,
      installmentCount: 1,
      dataCompra: "2025-09-01",
      firstDueDate: "2025-10-01",
      targets: [{ projectId: "target", roomId: null, amountCents: 123456789 }],
      decision: { kind: "CREATE", acceptNaturalDuplicate: false },
    },
  ],
  selectedLineIds: ["line"],
  questions: [],
  declaredFacts: [
    {
      origin: "USER_ATTESTATION",
      lineId: "line",
      observationId: "observation",
      questionId: "question",
      field: "amountCents",
      meaningContext: "TOTAL_PURCHASE",
      status: "CURRENT",
      value: 123456789,
    },
  ],
  reviewBlockers: [],
  searchComplete: true,
  confirmation: null,
  receipt: null,
  actions: ["CONFIRM", "CANCEL"],
  proposal: {
    version: 1,
    kind: IMPORT_SESSION_KIND,
    sessionId: "layout-session",
    revision: 2,
    proposalHash: "a".repeat(64),
    createdEconomicTotalCents: 123456789,
    bankCashDeltaCents: 0,
    invoiceDeltas: [{ invoiceDueMonth: "2025-10", amountCents: 123456789 }],
    deferredObservationIds: [],
    deferredAttachmentIds: [],
    retainUntil: null,
    lines: [
      {
        kind: "CREATE",
        lineId: "line",
        titulo:
          "Compra documental com estabelecimento e finalidade de nomes longos",
        fornecedor: "LOJA FICTICIA NORTE",
        tipoDespesa: ExpenseType.OUTROS,
        categoriaMaoDeObra: null,
        dataCompra: "2025-09-01",
        totalCents: 123456789,
        schedule,
        targets: [
          {
            projectId: "target",
            roomId: null,
            amountCents: 123456789,
            schedule,
          },
        ],
      },
    ],
  },
};
const receipt: ReceiptView = {
  appliedAtLabel: "10/10/2026",
  createdTotalLabel: "R$ 1.234.567,89",
  bankCashDeltaLabel: "R$ 0,00",
  invoiceDeltas: [{ monthLabel: "out/2025", amountLabel: "R$ 1.234.567,89" }],
  continuationSessionId: "remaining",
  lines: [
    {
      lineId: "line",
      title:
        "Compra documental com estabelecimento e finalidade de nomes longos",
      outcomeLabel: "Criada",
      purchaseDate: "01/09/2025",
      totalLabel: "R$ 1.234.567,89",
      sourceName: "Origem documental",
      occurrences: [
        {
          index: 1,
          label: "Parcela 1/1",
          dateLabel: "01/09/2025",
          cycleLabel: "out/2025",
          valueLabel: "R$ 1.234.567,89",
        },
      ],
      targets: [
        {
          name: "Finalidade documental com nome longo",
          amountLabel: "R$ 1.234.567,89",
        },
      ],
    },
  ],
};
let script: string;
let css: string;
test.beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import React from "react";
        import { createRoot } from "react-dom/client";
        import { ImportProposalCard } from ${JSON.stringify(path.join(components, "ImportProposalCard.tsx"))};
        import { ImportReceipt } from ${JSON.stringify(path.join(components, "ImportReceipt.tsx"))};
        createRoot(document.getElementById("root")).render(
          <main className="mx-auto w-full max-w-2xl min-w-0 space-y-4 p-4">
            <ImportProposalCard sessionId="layout-session" />
            <section aria-label="Resultado" className="min-w-0 rounded-2xl border p-4">
              <ImportReceipt view={${JSON.stringify(receipt)}} onOpenContinuation={() => {}} />
            </section>
          </main>
        );
      `,
      resolveDir: root,
      loader: "tsx",
    },
    bundle: true,
    write: false,
    outfile: "import-layout.js",
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
    plugins: [
      {
        name: "read-only-execution-fixture",
        setup(builder) {
          builder.onResolve({ filter: /\/useImportExecution$/ }, () => ({
            path: "execution",
            namespace: "layout-fixture",
          }));
          builder.onLoad({ filter: /.*/, namespace: "layout-fixture" }, () => ({
            contents: `export function useImportExecution() {
            return {
              view: ${JSON.stringify(review)},
              catalog: { names: {
                project: () => "Finalidade documental com nome longo",
                card: () => "Cartão documental"
              }, rooms: new Map() },
              pending: false, error: null, notice: null, settled: false,
              financialAction: "CONFIRM", act: () => {}, retry: () => {}
            };
          }`,
          }));
        },
      },
    ],
  });
  script = bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text;
  const moduleCss = bundle.outputFiles.find((file) =>
    file.path.endsWith(".css"),
  )!.text;
  const files = [
    "ImportProposalCard.tsx",
    "ImportReceipt.tsx",
    "ReceiptLineRow.tsx",
    "ImportReviewBlockerNotice.tsx",
    "ImportFocusedQuestion.tsx",
  ];
  const content = await Promise.all(
    files.map(async (file) => ({
      raw: await readFile(path.join(components, file), "utf8"),
      extension: "tsx",
    })),
  );
  content.push({
    raw: "mx-auto w-full max-w-2xl min-w-0 space-y-4 p-4 rounded-2xl border",
    extension: "tsx",
  });
  const compiled = await postcss([
    tailwindcss({
      // Load the existing tokens rather than recreating a test-only design system.
      ...require("../tailwind.config.js"),
      content,
    }),
  ]).process("@tailwind base; @tailwind components; @tailwind utilities;", {
    from: undefined,
  });
  css = compiled.css + moduleCss;
});

for (const width of [375, 390, 1280]) {
  test(`review and receipt monetary layout at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    // Match the real App Router layout; mobile otherwise uses a 980px layout viewport.
    await page.setContent(
      `<meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style><div id="root"></div>`,
    );
    expect(
      await page.evaluate(() => document.documentElement.clientWidth),
    ).toBe(width);
    await page.addScriptTag({ content: script });
    const review = page.getByRole("region", { name: "Revisão do lote" });
    const receipt = page.getByTestId("import-receipt");
    await expect(review).toBeVisible();
    await expect(receipt).toBeVisible();
    // Existing live QA assertion, unchanged; also cover every schedule/target value.
    await assertReadableMoney(review);
    await assertReadableMoney(receipt);
    for (const scope of [review, receipt]) {
      const money = scope.locator(
        "[data-workflow-money], dd.whitespace-nowrap",
      );
      expect(await money.count()).toBeGreaterThanOrEqual(
        scope === review ? 7 : 6,
      );
      for (const amount of await money.all()) {
        const overlap = await amount.evaluate((element) => {
          const value = element.getBoundingClientRect();
          const label =
            element.previousElementSibling ??
            (element.parentElement?.tagName === "DD"
              ? element.parentElement.previousElementSibling
              : null);
          if (!label) return false;
          const box = label.getBoundingClientRect();
          return (
            box.right > value.left + 1 &&
            box.bottom > value.top &&
            box.top < value.bottom
          );
        });
        expect(overlap, "Monetary value must not overlap its label").toBe(
          false,
        );
      }
      const labels = scope.locator("dt, summary");
      for (const label of await labels.all()) {
        expect(
          await label.evaluate((element) =>
            parseFloat(getComputedStyle(element).fontSize),
          ),
        ).toBeGreaterThanOrEqual(11);
      }
      for (const control of await scope.locator("button, summary").all()) {
        if (await control.isVisible()) await assertTouchable(control);
      }
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
  });
}
