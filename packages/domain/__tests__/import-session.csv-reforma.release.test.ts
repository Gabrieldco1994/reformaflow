import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  IMPORT_SESSION_LIMITS,
  ImportSessionEntryUnavailableReason,
  type ImportSessionDecisionV1,
  type ImportSessionDraftLineV1,
  type ImportSessionEntryV1,
  type ImportSessionProposalV1,
  type ImportSessionReceiptV1,
  type ImportSessionTargetInputV1,
} from "../src";

const target = (amountCents: number): ImportSessionTargetInputV1 => ({
  projectId: "reforma-1",
  roomId: null,
  amountCents,
});

describe("Maria CSV release domain contract", () => {
  it("locks_the_public_entry_to_CSV_and_the_target_cardinality_to_zero_or_one", () => {
    const entry: ImportSessionEntryV1 = {
      kind: "CARD_INVOICE",
      version: 1,
      formats: ["CSV"],
    };
    expect(entry).toEqual({
      kind: "CARD_INVOICE",
      version: 1,
      formats: ["CSV"],
    });
    const unavailable: ImportSessionEntryV1 = {
      kind: "UNAVAILABLE",
      version: 1,
      reason: "NOT_ENABLED",
    };
    expect(unavailable).toEqual({
      kind: "UNAVAILABLE",
      version: 1,
      reason: "NOT_ENABLED",
    });
    expect(ImportSessionEntryUnavailableReason).toEqual({
      NOT_ENABLED: "NOT_ENABLED",
      RUNTIME_UNAVAILABLE: "RUNTIME_UNAVAILABLE",
      NO_QUALIFIED_FORMAT: "NO_QUALIFIED_FORMAT",
    });
    // @ts-expect-error Unavailability is actionable only with the bounded reason.
    const missingReason: ImportSessionEntryV1 = {
      kind: "UNAVAILABLE",
      version: 1,
    };
    // @ts-expect-error The positive entry is a versioned non-empty CSV tuple.
    const emptyFormats: ImportSessionEntryV1 = {
      kind: "CARD_INVOICE",
      version: 1,
      formats: [],
    };
    void [missingReason, emptyFormats];
    expect(IMPORT_SESSION_LIMITS.targetsPerPurchase).toBe(1);

    const noTarget: ImportSessionDraftLineV1["targets"] = [];
    const oneTarget: ImportSessionDraftLineV1["targets"] = [target(10_001)];
    expect(noTarget).toEqual([]);
    expect(oneTarget).toEqual([target(10_001)]);

    // The public line contract itself must reject a second target. This directive
    // is intentionally unused on the RED baseline where `targets` is an array.
    // @ts-expect-error R1 supports zero or one target, never a split/broadcast.
    const twoTargets: ImportSessionDraftLineV1["targets"] = [
      target(5_000),
      target(5_001),
    ];
    expect(twoTargets).toHaveLength(2);

    const lineAmountCents = 10_001;
    expect(oneTarget?.[0]?.amountCents).toBe(lineAmountCents);
  });

  it("defines_explicit_terminal_no_write_decisions_and_server_effects", () => {
    const publicContract = readFileSync(
      new URL("../src/import-session.ts", import.meta.url),
      "utf8",
    );
    for (const member of ["DEFER", "EXCLUDE", "IGNORED_POLICY"])
      expect(publicContract).toMatch(new RegExp(`["']${member}["']`));
    for (const member of ["noWriteRows", "effects", "auditItems"])
      expect(publicContract).toContain(member);

    const decisions: ImportSessionDecisionV1[] = [
      { kind: "DEFER" },
      { kind: "EXCLUDE" },
      {
        kind: "IGNORED_POLICY",
        reason: "INVOICE_PAYMENT",
        policyVersion: 1,
      },
    ];

    const proposal = {
      noWriteRows: [
        {
          lineId: "deferred-line",
          outcome: "DEFERRED",
          reason: "USER_DEFERRED",
          title: "Compra para revisar",
          amountCents: 10_001,
        },
        {
          lineId: "ignored-line",
          outcome: "IGNORED",
          reason: "INVOICE_PAYMENT",
          title: "PAGAMENTO EFETUADO",
          amountCents: 25_000,
        },
      ],
      effects: {
        personalSourceCreates: 0,
        reformaTargetCreates: 0,
        expenseCreates: 0,
        cashFlowEntryCreates: 0,
        rateioAllocationCreates: 0,
        keptExistingCount: 0,
        deferredCount: 1,
        excludedCount: 0,
        ignoredCount: 1,
      },
    } satisfies Pick<ImportSessionProposalV1, "noWriteRows" | "effects">;

    const receipt = {
      auditItems: proposal.noWriteRows,
    } satisfies Pick<ImportSessionReceiptV1, "auditItems">;

    expect(decisions.map((decision) => decision.kind)).toEqual([
      "DEFER",
      "EXCLUDE",
      "IGNORED_POLICY",
    ]);
    expect(proposal.effects).toMatchObject({
      expenseCreates: 0,
      deferredCount: 1,
      ignoredCount: 1,
    });
    expect(receipt.auditItems).toEqual(proposal.noWriteRows);
  });
});
