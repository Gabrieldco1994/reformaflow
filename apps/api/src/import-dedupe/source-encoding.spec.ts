import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("reviewable cross-origin dedupe source", () => {
  it("contains no literal NUL bytes while preserving the empty-list sentinel", () => {
    const source = readFileSync(join(__dirname, "cross-origin-dedupe.ts"));
    expect(source.includes(0)).toBe(false);
    expect(source.toString("utf8")).toContain("\\u0000__dedupe_none__");
  });
});
