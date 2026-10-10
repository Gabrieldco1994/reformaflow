import {
  cardImportConfiguration,
  IMPORT_CARD_CYCLE_CONFIGURATION_REQUIRED,
} from "@reformaflow/domain";

describe("card import cycle configuration", () => {
  it.each([
    [null, 10],
    [5, null],
    [0, 10],
    [5, 32],
    [1.5, 10],
  ])("blocks missing/invalid cycle %s/%s", (closingDay, dueDay) => {
    expect(cardImportConfiguration({ closingDay, dueDay })).toEqual({
      configured: false,
      reason: IMPORT_CARD_CYCLE_CONFIGURATION_REQUIRED,
    });
  });
  it("reports configured without deriving or replacing documented occurrences", () => {
    expect(cardImportConfiguration({ closingDay: 31, dueDay: 1 })).toEqual({
      configured: true,
      reason: null,
    });
  });
});
