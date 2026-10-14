import { existsSync } from "node:fs";
import { join } from "node:path";

describe("Band-3 has one causal OCR authority", () => {
  it.each([
    "boundary-observer.ts",
    "boundary-scenarios.ts",
    "baseline-candidate-report.ts",
  ])("[B3] removes the shallow parallel authority %s", (fileName) => {
    expect(existsSync(join(__dirname, fileName))).toBe(false);
  });
});
