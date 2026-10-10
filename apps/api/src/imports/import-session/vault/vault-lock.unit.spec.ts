/**
 * B2a slice 2 RED (design v2.2 §4 / §5 LK1): `decodeLinuxDev`, the pure decoder of a Linux
 * `dev_t` carried by a uint64 `st_dev`.
 *
 * Every vector is a literal written down by hand from the glibc `gnu_dev_major`/`gnu_dev_minor`
 * layout (major = bits 8..19 + bits 44..63, minor = bits 0..7 + bits 20..43); none is computed by
 * the code under test. The layout is a PREMISE about the kernel/libuv ABI that a real Linux capture
 * must still confirm (LK5, gated elsewhere): these vectors pin the arithmetic, not the platform.
 *
 * `./vault-lock` does not exist yet. It is loaded lazily and asserted, so the RED is an assertion
 * about a missing function and not a compile error; a missing TRANSITIVE dependency still throws.
 */
export {}; // keeps this spec a module so its local helpers do not collide with sibling specs
type Dev = { major: number; minor: number };
type Decode = (dev: bigint) => Dev | null;

function load(): Decode {
  let loaded: { decodeLinuxDev?: unknown } = {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loaded = require("./vault-lock");
  } catch (error) {
    const missingSelf =
      (error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND" &&
      /^Cannot find module '\.\/vault-lock'/.test((error as Error).message);
    if (!missingSelf) throw error;
  }
  expect(typeof loaded.decodeLinuxDev).toBe("function");
  return loaded.decodeLinuxDev as Decode;
}

// Type checks come first: a bigint in a failed matcher cannot be serialized by the jest worker,
// which would turn a plain assertion failure into a suite error.
function expectDev(out: Dev | null, major: number, minor: number): void {
  expect(out).not.toBeNull();
  const dev = out as Dev;
  expect(typeof dev.major).toBe("number");
  expect(typeof dev.minor).toBe("number");
  expect([dev.major, dev.minor]).toEqual([major, minor]);
  expect(Object.keys(dev).sort()).toEqual(["major", "minor"]);
}

describe("decodeLinuxDev (LK1)", () => {
  it("is exported as a synchronous function", () => {
    const decode = load();
    const out = decode(0x0803n);
    expect(out).not.toHaveProperty("then");
  });

  describe("literal vectors (major, minor)", () => {
    const VECTORS: ReadonlyArray<readonly [string, bigint, number, number]> = [
      ["classic sda3", 0x0803n, 0x8, 0x3],
      ["major above 8 bits, in the low field", 0x10301n, 0x103, 0x1],
      ["minor above 8 bits", 0x1200834n, 0x8, 0x1234],
      ["major high field, lowest bit (bit 44)", 0x100000000000n, 0x1000, 0x0],
      [
        "minor high field, lowest bit (bit 20 of the 24-bit field)",
        0x100000n,
        0x0,
        0x100,
      ],
      ["minor bit 24 (bit 36)", 0x1000000000n, 0x0, 0x1000000],
      ["minor full high field", 0x00000ffffff00000n, 0x0, 0xffffff00],
      ["minor top bit (bit 43)", 0x80000000000n, 0x0, 0x80000000],
      ["major full high field", 0xfffff00000000000n, 0xfffff000, 0x0],
      ["major top bit (bit 63)", 0x8000000000000000n, 0x80000000, 0x0],
      ["major low field only", 0xfff00n, 0xfff, 0x0],
      ["minor low field only", 0xffn, 0x0, 0xff],
      ["low 20 bits set", 0xfffffn, 0xfff, 0xff],
      ["every bit set", 0xffffffffffffffffn, 0xffffffff, 0xffffffff],
      ["zero", 0x0n, 0, 0],
    ];

    it.each(VECTORS)("%s", (_name, dev, major, minor) => {
      const decode = load();
      expectDev(decode(dev), major, minor);
    });

    it("yields numbers, never bigints, and exactly two keys", () => {
      const decode = load();
      const out = decode(0xffffffffffffffffn);
      expect(out).not.toBeNull();
      expect(Object.keys(out as Dev).sort()).toEqual(["major", "minor"]);
      expect(typeof (out as Dev).major).toBe("number");
      expect(typeof (out as Dev).minor).toBe("number");
    });

    it("is deterministic and free of shared state across calls", () => {
      const decode = load();
      expectDev(decode(0x1200834n), 0x8, 0x1234);
      decode(0xffffffffffffffffn);
      expectDev(decode(0x1200834n), 0x8, 0x1234);
    });
  });

  describe("out of the uint64 domain", () => {
    it.each([
      ["2^64", 2n ** 64n],
      ["2^64 + 5", 2n ** 64n + 5n],
      ["2^70", 2n ** 70n],
      ["-1", -1n],
      ["-2^64", -(2n ** 64n)],
    ])("%s is null (not a partial decode)", (_name, dev) => {
      const decode = load();
      expect(decode(dev)).toBeNull();
    });

    it("keeps the last valid value distinct from the first invalid one", () => {
      const decode = load();
      expectDev(decode(2n ** 64n - 1n), 0xffffffff, 0xffffffff);
      expect(decode(2n ** 64n)).toBeNull();
      expectDev(decode(0n), 0, 0);
      expect(decode(-1n)).toBeNull();
    });
  });
});
