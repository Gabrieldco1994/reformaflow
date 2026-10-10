import type { IncomingHttpHeaders } from "node:http";

/**
 * B2a RED (V71): the PURE framing rule, imported from the real module the design fixes
 * (`vault/vault-framing.ts`). Node rejects most malformed Content-Length values before any
 * application code, so an HTTP test cannot reach this grammar: only a unit call can. The module is
 * loaded lazily and its absence is an assertion failure (RED), never a compile error.
 *
 * Deliberately NOT asserted: which code wins when the Content-Type AND the Content-Length are both
 * wrong (the design's closed map does not order them).
 */
type Verdict =
  | { ok: true }
  | { ok: false; code: "INVALID_INPUT" | "UNSUPPORTED_DOCUMENT" };
type Validate = (headers: IncomingHttpHeaders) => Verdict;

function load(): { validateImportUploadFraming?: Validate } | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("./vault-framing");
  } catch (error) {
    const e = error as NodeJS.ErrnoException;
    if (e.code === "MODULE_NOT_FOUND" && /vault-framing/.test(e.message)) {
      return undefined;
    }
    throw error;
  }
}
const validate = (headers: IncomingHttpHeaders): Verdict => {
  const fn = load()?.validateImportUploadFraming;
  expect(typeof fn).toBe("function"); // RED while the module/export does not exist
  return fn!(headers);
};

const good: IncomingHttpHeaders = {
  "content-type": "application/octet-stream",
  "content-length": "1000",
};
const invalid: Verdict = { ok: false, code: "INVALID_INPUT" };
const unsupported: Verdict = { ok: false, code: "UNSUPPORTED_DOCUMENT" };
const without = (name: string): IncomingHttpHeaders => {
  const { [name]: _dropped, ...rest } = good;
  return rest;
};

describe("B2a slice 1 — validateImportUploadFraming (pure, V71)", () => {
  it("exports the function from vault/vault-framing.ts", () => {
    expect(typeof load()?.validateImportUploadFraming).toBe("function");
  });

  it.each([
    ["a small length", "1"],
    ["the declared size of a normal file", "1000"],
    ["exactly the 10 MiB limit", "10485760"],
  ])("accepts %s", (_name, length) => {
    expect(validate({ ...good, "content-length": length })).toEqual({
      ok: true,
    });
  });

  it("accepts Content-Encoding identity (anything else is refused below)", () => {
    expect(validate({ ...good, "content-encoding": "identity" })).toEqual({
      ok: true,
    });
  });

  it.each<[string, string | string[] | undefined]>([
    ["a signed length", "+5"],
    ["exponent notation", "1e3"],
    ["hexadecimal", "0x10"],
    ["a joined duplicate", "5, 5"],
    ["a duplicated header as an array", ["5", "5"]],
    ["a single-element array (a string is required)", ["1000"]],
    ["an empty value", ""],
    ["a negative value", "-1"],
    ["zero", "0"],
    ["above 2^53 (not a safe integer)", "9007199254740993"],
    ["a huge digit string", "99999999999999999999"],
    ["one byte over the 10 MiB limit", "10485761"],
    ["a decimal point", "1000.0"],
    ["absent", undefined],
  ])("Content-Length %s => INVALID_INPUT", (_name, value) => {
    const headers: IncomingHttpHeaders = { ...good };
    if (value === undefined) delete headers["content-length"];
    else headers["content-length"] = value as string;
    expect(validate(headers)).toEqual(invalid);
  });

  it.each([
    [
      "chunked with a Content-Length",
      { ...good, "transfer-encoding": "chunked" },
    ],
    [
      "chunked without a Content-Length",
      { ...without("content-length"), "transfer-encoding": "chunked" },
    ],
    [
      "any Transfer-Encoding value",
      { ...good, "transfer-encoding": "identity" },
    ],
    ["Content-Encoding gzip", { ...good, "content-encoding": "gzip" }],
    ["Content-Encoding br", { ...good, "content-encoding": "br" }],
  ])("%s => INVALID_INPUT", (_name, headers) => {
    expect(validate(headers as IncomingHttpHeaders)).toEqual(invalid);
  });

  it.each([
    ["absent", undefined],
    ["application/json", "application/json"],
    ["multipart/form-data", "multipart/form-data; boundary=x"],
    [
      "octet-stream with a parameter (the match is exact)",
      "application/octet-stream; charset=x",
    ],
    ["text/plain", "text/plain"],
  ])("Content-Type %s => UNSUPPORTED_DOCUMENT", (_name, value) => {
    const headers: IncomingHttpHeaders = { ...good };
    if (value === undefined) delete headers["content-type"];
    else headers["content-type"] = value;
    expect(validate(headers)).toEqual(unsupported);
  });

  it("is pure: it does not mutate its input and gives the same verdict twice", () => {
    const headers: IncomingHttpHeaders = Object.freeze({
      ...good,
      "content-length": "+5",
    });
    expect(validate(headers)).toEqual(invalid);
    expect(validate(headers)).toEqual(invalid);
    expect(headers).toEqual({ ...good, "content-length": "+5" });
  });
});
