import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caixaDateForCardPurchase, caixaMonthForCardPurchase } from "../src";

// The frozen #701 contract adds the optional documentary month. These are
// references to the real exports, not wrappers or mocks. The explicit signature
// also lets the three-argument baseline fail on values rather than on typing.
type DocumentaryCycleResolver<Result> = (
  purchaseDate: Date | string,
  closingDay: number | null | undefined,
  dueDay: number | null | undefined,
  invoiceDueMonth?: string | null,
) => Result;

const resolveMonth: DocumentaryCycleResolver<string> =
  caixaMonthForCardPurchase;
const resolveDate: DocumentaryCycleResolver<Date> = caixaDateForCardPurchase;

describe("Maria import P01 — documentary cycle contract (#701)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["2026-09-25", "before closing"],
    ["2026-09-27", "on closing"],
    ["2026-09-28", "after closing"],
    ["2026-11-05", "already normalized to the first due date"],
  ])(
    "keeps November and 05/11 for %s (%s), without shifting the documented cycle",
    (purchaseDate) => {
      expect({
        month: resolveMonth(purchaseDate, 27, 5, "2026-11"),
        date: resolveDate(purchaseDate, 27, 5, "2026-11"),
      }).toEqual({
        month: "2026-11",
        date: new Date("2026-11-05T00:00:00.000Z"),
      });
    },
  );

  it.each([
    ["2026-09-25", null, "2026-10", "2026-10-05T00:00:00.000Z"],
    ["2026-09-27", null, "2026-11", "2026-11-05T00:00:00.000Z"],
    ["2026-09-28", null, "2026-11", "2026-11-05T00:00:00.000Z"],
    ["2026-09-25", undefined, "2026-10", "2026-10-05T00:00:00.000Z"],
    ["2026-09-27", undefined, "2026-11", "2026-11-05T00:00:00.000Z"],
    ["2026-09-28", undefined, "2026-11", "2026-11-05T00:00:00.000Z"],
  ] as const)(
    "preserves the legacy closing boundary for %s when documentary month is %s",
    (purchaseDate, invoiceDueMonth, expectedMonth, expectedDate) => {
      expect({
        month: resolveMonth(purchaseDate, 27, 5, invoiceDueMonth),
        date: resolveDate(purchaseDate, 27, 5, invoiceDueMonth),
      }).toEqual({
        month: expectedMonth,
        date: new Date(expectedDate),
      });
    },
  );

  it.each([
    ["2027-02", "2027-02-28T00:00:00.000Z"],
    ["2028-02", "2028-02-29T00:00:00.000Z"],
  ])(
    "clamps due day 31 within documented %s, not within the purchase cycle",
    (invoiceDueMonth, expectedDate) => {
      expect({
        month: resolveMonth("2026-09-25", 27, 31, invoiceDueMonth),
        date: resolveDate("2026-09-25", 27, 31, invoiceDueMonth),
      }).toEqual({
        month: invoiceDueMonth,
        date: new Date(expectedDate),
      });
    },
  );

  it.each(["2026-00", "2026-13"])(
    "rejects invalid documentary month %s instead of silently deriving a cycle",
    (invoiceDueMonth) => {
      expect
        .soft(() => resolveMonth("2026-09-25", 27, 5, invoiceDueMonth))
        .toThrow(RangeError);
      expect
        .soft(() => resolveDate("2026-09-25", 27, 5, invoiceDueMonth))
        .toThrow(RangeError);
    },
  );
});
