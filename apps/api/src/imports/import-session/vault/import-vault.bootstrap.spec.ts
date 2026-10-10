import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * B2a RED (V58/V68, static half): the behavioural half lives in
 * import-upload-framing.behavior.spec.ts against an app mounted in this same order. Here the real
 * `bootstrap()` (which needs a port, admin seeding and Swagger) is pinned by source: the shared
 * helper is registered exactly once, after NestFactory.create and enableCors and before listen,
 * with Nest's default body parser kept and the CORS options untouched.
 */
const source = readFileSync(join(__dirname, "../../../main.ts"), "utf8");
const CALL = "registerImportUploadFraming(app)";
const at = (needle: string) => source.indexOf(needle);

describe("B2a slice 1 — main.ts bootstrap wiring for the upload framing guard", () => {
  it("the anchors this spec orders against all exist in main.ts (a missing anchor must not weaken the order checks)", () => {
    for (const anchor of [
      "NestFactory.create(AppModule)",
      "app.enableCors(",
      "await app.listen(",
    ]) {
      expect([anchor, at(anchor) > -1]).toEqual([anchor, true]);
    }
  });

  it("registers the shared helper exactly once", () => {
    expect(source.split(CALL).length - 1).toBe(1);
  });

  it("orders NestFactory.create < enableCors < registerImportUploadFraming < listen", () => {
    const order = [
      at("NestFactory.create(AppModule)"),
      at("app.enableCors("),
      at(CALL),
      at("await app.listen("),
    ];
    expect(order.every((index) => index > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("keeps Nest's default body parser and the existing CORS options (no regression)", () => {
    expect(source).not.toMatch(/bodyParser\s*:\s*false/);
    expect(source).toContain("credentials: true");
    expect(source).toContain(
      "origin: corsOrigins.length === 1 ? corsOrigins[0] : corsOrigins,",
    );
  });
});
