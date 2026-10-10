import { describe, expect, it } from "vitest";
import { readImportWorkflowView } from "./import-session-workflow-read";
import {
  appliedFixture,
  confirmedFixture,
  workflowFixture,
} from "./import-workflow-fixtures";

describe("independent QA regressions for frozen 36ae22 (#701)", () => {
  it("accepts current 9 / proposal 8 / confirmed 8 without promoting READY", () => {
    const view = confirmedFixture();
    if (!view.proposal || !view.confirmation)
      throw new Error("Missing fixture");
    view.revision = 9;
    view.proposal.revision = 8;
    view.confirmation.confirmedRevision = 8;
    expect(readImportWorkflowView(view)).toEqual(view);
  });

  it("rejects a CREATED receipt missing every source and target CFE", () => {
    const view = appliedFixture();
    if (!view.receipt) throw new Error("Missing receipt fixture");
    view.receipt.items[0].cashFlowEntryIds = [];
    expect(() => readImportWorkflowView(view)).toThrow();
  });

  it("rejects collapsed CREATED twins sharing one created source", () => {
    const view = appliedFixture();
    if (!view.receipt) throw new Error("Missing receipt fixture");
    view.receipt.items[1].sourceExpenseId =
      view.receipt.items[0].sourceExpenseId;
    expect(() => readImportWorkflowView(view)).toThrow();
  });

  it("rejects missing target/allocation IDs even without the optional proposal", () => {
    const view = appliedFixture();
    if (!view.receipt) throw new Error("Missing receipt fixture");
    view.proposal = null;
    view.receipt.items[0].targetExpenseIds = [];
    view.receipt.items[0].allocationIds = [];
    expect(view.receipt.snapshot.lines[0].targets).toHaveLength(1);
    expect(() => readImportWorkflowView(view)).toThrow();
  });

  it("accepts semantically equal receipt schedules regardless of JSON member order", () => {
    const view = appliedFixture();
    if (!view.receipt) throw new Error("Missing receipt fixture");
    const line = view.receipt.snapshot.lines[0];
    line.schedule = {
      occurrences: line.schedule.occurrences.map((o) => ({
        invoiceDueMonth: o.invoiceDueMonth,
        data: o.data,
        valor: o.valor,
        parcela: o.parcela,
        index: o.index,
      })),
      version: 1,
    };
    expect(readImportWorkflowView(view)).toEqual(view);
  });

  it("requires READY proposal revision to match current revision even with a confirmation reference", () => {
    const view = confirmedFixture();
    view.state = "READY";
    view.actions = ["CONFIRM"];
    expect(() => readImportWorkflowView(view)).toThrow();
  });

  it("rejects a READY source whose explicit invoice effects disagree with its schedule", () => {
    const view = workflowFixture();
    if (!view.proposal) throw new Error("Missing proposal fixture");
    view.proposal.invoiceDeltas = [
      { invoiceDueMonth: "2026-12", amountCents: 0 },
      { invoiceDueMonth: "2027-01", amountCents: 0 },
    ];
    expect(() => readImportWorkflowView(view)).toThrow();
  });
});
