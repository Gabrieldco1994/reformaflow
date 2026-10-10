import { describe, expect, it } from "vitest";
import { currentLotFixture } from "../_lib/import-workflow-fixtures";
import { readImportCurrentLot } from "../_lib/import-guided-read";

const CONFIRMATION_HASH = "c".repeat(64);

function publicCurrentLotFixture() {
  const fixture = currentLotFixture();
  return {
    version: fixture.version,
    state: fixture.state,
    revision: fixture.revision,
    confirmationHash: CONFIRMATION_HASH,
    purchases: fixture.purchases,
    createdEconomicTotalCents: fixture.createdEconomicTotalCents,
    bankCashDeltaCents: fixture.bankCashDeltaCents,
    invoiceDeltas: fixture.invoiceDeltas,
    hasRemainingWork: fixture.hasRemainingWork,
    actions: fixture.actions,
  };
}

describe("ready-only current-lot wire coherence", () => {
  it("accepts semantically identical JSON with different object member order", () => {
    const lot = publicCurrentLotFixture();
    const { version, state, ...rest } = lot;
    const reordered = { ...rest, state, version };
    expect(readImportCurrentLot(reordered)).toEqual(lot);
  });

  it("accepts a ready partial lot with pending work and a confirm action", () => {
    const lot = publicCurrentLotFixture();
    lot.state = "READY_WITH_PENDING";
    expect(readImportCurrentLot(lot)).toEqual(lot);
  });

  it.each([
    ["READY with remaining work", "READY", true, ["CONFIRM"]],
    [
      "READY_WITH_PENDING without remaining work",
      "READY_WITH_PENDING",
      false,
      ["CONFIRM"],
    ],
    [
      "READY_WITH_PENDING with execute",
      "READY_WITH_PENDING",
      true,
      ["EXECUTE"],
    ],
    ["CONFIRMED with confirm", "CONFIRMED", true, ["CONFIRM"]],
  ] as const)(
    "rejects incoherent state: %s",
    (_name, state, hasRemainingWork, actions) => {
      const lot = publicCurrentLotFixture();
      lot.state = state;
      lot.hasRemainingWork = hasRemainingWork;
      lot.actions = [...actions];
      expect(() => readImportCurrentLot(lot)).toThrow(
        "Unexpected current lot response",
      );
    },
  );

  it.each([
    [
      "source total",
      (lot: ReturnType<typeof publicCurrentLotFixture>) => {
        lot.purchases[0].schedule.occurrences[0].valor -= 1;
      },
    ],
    [
      "target total",
      (lot: ReturnType<typeof publicCurrentLotFixture>) => {
        lot.purchases[0].targets[0].schedule.occurrences[0].valor -= 1;
      },
    ],
    [
      "invalid invoice month",
      (lot: ReturnType<typeof publicCurrentLotFixture>) => {
        lot.invoiceDeltas[0].invoiceDueMonth = "2026-13";
      },
    ],
  ] as const)("rejects an incoherent %s", (_name, mutate) => {
    const lot = publicCurrentLotFixture();
    mutate(lot);
    expect(() => readImportCurrentLot(lot)).toThrow(
      "Unexpected current lot response",
    );
  });

  it.each([
    [
      "confirmation hash",
      (lot: ReturnType<typeof publicCurrentLotFixture>) => {
        lot.confirmationHash = "not-a-hash";
      },
    ],
    [
      "duplicate actions",
      (lot: ReturnType<typeof publicCurrentLotFixture>) => {
        lot.actions = ["CONFIRM", "CONFIRM"];
      },
    ],
    [
      "unknown action",
      (lot: ReturnType<typeof publicCurrentLotFixture>) => {
        lot.actions = ["DELETE"] as never;
      },
    ],
  ] as const)("fails closed for an invalid %s", (_name, mutate) => {
    const lot = publicCurrentLotFixture();
    mutate(lot);
    expect(() => readImportCurrentLot(lot)).toThrow(
      "Unexpected current lot response",
    );
  });

  it("rejects the private proposalHash key even beside a valid public hash", () => {
    expect(() =>
      readImportCurrentLot({
        ...publicCurrentLotFixture(),
        proposalHash: "a".repeat(64),
      }),
    ).toThrow("Unexpected current lot response");
  });
});
