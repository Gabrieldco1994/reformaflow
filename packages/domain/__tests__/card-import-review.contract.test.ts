import { describe, expect, it } from "vitest";
import {
  CARD_IMPORT_INVALID_DECISION,
  CARD_IMPORT_INVALID_SELECTION,
  CARD_IMPORT_LINE_OUTCOME,
  CARD_IMPORT_SELECTED_ROWS_CHANGED,
  CARD_IMPORT_REVIEW_REASON,
  isCardImportReviewFingerprint,
} from "../src";

// Literal pins: the expected sets are written out, never derived from the
// constants they protect.
describe("card import REVIEW contract (P01)", () => {
  it("pins the reason vocabulary and the 400 code", () => {
    expect(Object.values(CARD_IMPORT_REVIEW_REASON).sort()).toEqual([
      "BLOCKED_IDENTITY",
      "REVIEW_REQUIRED",
      "REVIEW_STALE",
    ]);
    expect(CARD_IMPORT_INVALID_DECISION).toBe("INVALID_DECISION");
  });

  it("pins the selection codes and the per-line outcome vocabulary", () => {
    expect(CARD_IMPORT_INVALID_SELECTION).toBe("INVALID_SELECTION");
    expect(CARD_IMPORT_SELECTED_ROWS_CHANGED).toBe("SELECTED_ROWS_CHANGED");
    expect(Object.values(CARD_IMPORT_LINE_OUTCOME).sort()).toEqual([
      "BLOCKED",
      "CREATED",
      "DUPLICATED",
      "ERROR",
      "NOT_SELECTED",
      "POSSIBLE_DUPLICATE",
      "REUSED",
      "REVIEW_REQUIRED",
      "SKIPPED",
    ]);
  });

  it("accepts only a lowercase 64-hex digest as a fingerprint", () => {
    expect(isCardImportReviewFingerprint("a".repeat(64))).toBe(true);
    expect(isCardImportReviewFingerprint("0123456789abcdef".repeat(4))).toBe(
      true,
    );
    for (const bad of [
      null,
      undefined,
      "",
      "a".repeat(63),
      "a".repeat(65),
      "A".repeat(64),
      "g".repeat(64),
      ` ${"a".repeat(63)}`,
      12345,
      {},
    ])
      expect(isCardImportReviewFingerprint(bad)).toBe(false);
  });
});
