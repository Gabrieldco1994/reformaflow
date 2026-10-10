/**
 * B2a slice 2 RED (design v2.2 §1/§5 LK4): `headroomSatisfied`, the pure headroom predicate that
 * lives in the pure half of `vault-root.ts`.
 *
 * `available` is a BigInt (bavail * bsize from `statfs`, which can exceed 2^53) and `headroom` is
 * the config's positive safe integer; the contract is `available >= BigInt(headroom)`, inclusive.
 * Only that comparison is pinned here. The root-facts classification (RT1) is a separate table
 * that waits for its approved shape and is NOT in this file yet.
 *
 * `./vault-root` does not exist yet. It is loaded lazily and asserted, so the RED is an assertion
 * about a missing function and not a compile error; a missing TRANSITIVE dependency still throws.
 */
export {}; // keeps this spec a module so its local helpers do not collide with sibling specs
type Headroom = (available: bigint, headroom: number) => boolean;

function load(): Headroom {
  let loaded: { headroomSatisfied?: unknown } = {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loaded = require("./vault-root");
  } catch (error) {
    const missingSelf =
      (error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND" &&
      /^Cannot find module '\.\/vault-root'/.test((error as Error).message);
    if (!missingSelf) throw error;
  }
  expect(typeof loaded.headroomSatisfied).toBe("function");
  return loaded.headroomSatisfied as Headroom;
}

describe("headroomSatisfied (LK4)", () => {
  it("is exported as a synchronous function", () => {
    const satisfied = load();
    expect(satisfied(1024n, 1024)).not.toHaveProperty("then");
  });

  it.each<[string, bigint, number, boolean]>([
    ["equal is enough (inclusive)", 1024n, 1024, true],
    ["one byte short", 1024n, 1025, false],
    ["one byte over", 1025n, 1024, true],
    [
      "available far above 2^53 vs the largest safe headroom",
      2n ** 63n,
      Number.MAX_SAFE_INTEGER,
      true,
    ],
    [
      "available exactly the largest safe headroom",
      BigInt(Number.MAX_SAFE_INTEGER),
      Number.MAX_SAFE_INTEGER,
      true,
    ],
    [
      "one byte under the largest safe headroom",
      BigInt(Number.MAX_SAFE_INTEGER) - 1n,
      Number.MAX_SAFE_INTEGER,
      false,
    ],
    ["zero available, zero headroom", 0n, 0, true],
    ["zero available, one byte required", 0n, 1, false],
    ["negative available never satisfies zero headroom", -1n, 0, false],
    ["one byte with one required", 1n, 1, true],
  ])("%s", (_name, available, headroom, expected) => {
    const satisfied = load();
    expect(satisfied(available, headroom)).toBe(expected);
  });

  it("returns a real boolean, never a truthy bigint or number", () => {
    const satisfied = load();
    expect(satisfied(1025n, 1024)).toBe(true);
    expect(satisfied(1023n, 1024)).toBe(false);
  });

  it("is monotonic around the boundary and stateless across calls", () => {
    const satisfied = load();
    const results = [1022n, 1023n, 1024n, 1025n, 1026n].map((a) =>
      satisfied(a, 1024),
    );
    expect(results).toEqual([false, false, true, true, true]);
    expect(satisfied(1023n, 1024)).toBe(false);
  });
});
