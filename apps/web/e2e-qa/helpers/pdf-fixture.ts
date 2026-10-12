import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect } from "@playwright/test";
import type {
  ImportSessionQuestionV1,
  ImportSessionViewV1,
} from "@reformaflow/domain";
import expected from "../fixtures/pdf-expected.json";

export { expected as pdfExpected };

export async function generateLivePdf() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "maria-live-pdf-"));
  try {
    await promisify(execFile)(
      process.execPath,
      [
        "-r",
        require.resolve("ts-node/register/transpile-only"),
        path.join(__dirname, "generate-live-pdf.ts"),
        directory,
      ],
      {
        env: {
          ...process.env,
          TS_NODE_SKIP_PROJECT: "true",
          TS_NODE_COMPILER_OPTIONS: JSON.stringify({
            module: "CommonJS",
            moduleResolution: "node",
          }),
        },
        timeout: 30_000,
      },
    );
    return directory;
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

// Mapping read-only from CSV 8a51e2e8; documentary literals always come from the
// separate PDF manifest. count=1/no rateio/OUTROS are synthetic HUMAN declarations,
// not deductions from a merchant name or unsupported installment evidence.
export function pdfFixtureAnswer(
  question: ImportSessionQuestionV1,
  current: ImportSessionViewV1,
  selectedIds: readonly string[],
) {
  expect(question.lineIds.length).toBeGreaterThan(0);
  const purchases = question.lineIds.map((id) => {
    expect(selectedIds).toContain(id);
    const lines = current.lines.filter((line) => line.id === id);
    expect(lines).toHaveLength(1);
    const matches = expected.purchases.filter(
      (purchase) => purchase.title === lines[0].titulo,
    );
    expect(matches, `Exact PDF fixture identity for ${id}`).toHaveLength(1);
    return matches[0];
  });
  const dateLiteral = (date: string) => date.split("-").reverse().join("/");
  const perPurchase: Record<
    string,
    (purchase: (typeof purchases)[number]) => string
  > = {
    amountCents: (purchase) => {
      const cents = String(purchase.amountCents).padStart(3, "0");
      return `${cents.slice(0, -2)},${cents.slice(-2)}`;
    },
    dataCompra: (purchase) => dateLiteral(purchase.date),
    merchant: (purchase) => purchase.title,
  };
  const derive = perPurchase[question.field];
  if (derive) {
    const values = purchases.map(derive);
    expect(
      new Set(values).size,
      `Cannot combine different ${question.field} literals`,
    ).toBe(1);
    return values[0];
  }
  const fixed: Record<string, string> = {
    amountMeaning: "total da compra",
    installmentCount: String(expected.declarations.installmentCount),
    installmentIndex: String(expected.declarations.installmentCount),
    firstDueDate: dateLiteral(expected.declarations.firstDueDate),
    targets: "sem rateio",
    decision: "criar compra nova",
    tipoDespesa: "OUTROS",
  };
  expect(
    fixed[question.field],
    `Unmapped PDF question ${question.field}; never invent facts`,
  ).toBeTruthy();
  return fixed[question.field];
}
