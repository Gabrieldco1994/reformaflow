import { describe, expect, it } from "vitest";
import { meetsMinimumTouchTarget } from "../../../../../../e2e-qa/helpers/evidence";

describe("meetsMinimumTouchTarget", () => {
  it.each([
    { width: 44, height: 44, expected: true },
    { width: 43.99, height: 100, expected: false },
    { width: 100, height: 43.99, expected: false },
  ])("requires both dimensions for %#", ({ width, height, expected }) => {
    expect(meetsMinimumTouchTarget({ width, height })).toBe(expected);
  });
});
