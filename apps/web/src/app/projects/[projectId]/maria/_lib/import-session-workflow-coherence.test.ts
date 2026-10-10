import { describe, expect, it } from "vitest";
import {
  readImportWorkflowReceipt,
  readImportWorkflowView,
  sameImportProposal,
} from "./import-session-workflow-read";
import {
  appliedFixture,
  confirmedFixture,
  workflowFixture,
} from "./import-workflow-fixtures";

describe("workflow semantic coherence after QA34", () => {
  it.each([true, false])(
    "checks created identities with optional proposal=%s",
    (withProposal) => {
      for (const field of [
        "cashFlowEntryIds",
        "targetExpenseIds",
        "allocationIds",
      ] as const) {
        const view = appliedFixture();
        if (!view.receipt) throw new Error("Missing test receipt");
        if (!withProposal) view.proposal = null;
        view.receipt.items[0][field] = [];
        expect(() => readImportWorkflowView(view), field).toThrow();
      }
    },
  );

  it("does not infer an exact created CFE count from a snapshot without target schedules", () => {
    const view = appliedFixture();
    if (!view.receipt) throw new Error("Missing test receipt");
    view.proposal = null;
    view.receipt.items[0].cashFlowEntryIds = ["created-cfe"];
    expect(readImportWorkflowView(view)).toEqual(view);
  });

  it("does not require distinct KEEP source IDs or newly created CFEs", () => {
    const view = appliedFixture();
    if (!view.receipt) throw new Error("Missing test receipt");
    view.proposal = null;
    for (const item of view.receipt.items) {
      item.outcome = "KEPT_EXISTING";
      item.sourceExpenseId = "same-existing-source";
      item.cashFlowEntryIds = [];
      item.targetExpenseIds = [];
      item.allocationIds = [];
    }
    for (const line of view.receipt.snapshot.lines) {
      line.titulo = null;
      line.dataCompra = null;
      line.targets = [];
      line.schedule.occurrences[0].invoiceDueMonth = null;
    }
    view.receipt.snapshot.participantProjectIds = ["personal"];
    view.receipt.snapshot.createdEconomicTotalCents = 0;
    view.receipt.snapshot.invoiceDeltas = [];
    expect(readImportWorkflowView(view)).toEqual(view);
  });

  it.each(["origin", "target total", "negative target"] as const)(
    "checks immutable created %s without a proposal",
    (kind) => {
      const view = appliedFixture();
      if (!view.receipt) throw new Error("Missing test receipt");
      view.proposal = null;
      const line = view.receipt.snapshot.lines[0];
      if (kind === "origin") line.sourceProjectId = "renovation";
      else
        line.targets[0].amountCents =
          kind === "negative target" ? -99999999 : 1;
      expect(() => readImportWorkflowView(view)).toThrow();
    },
  );

  it("keeps arrays and field values significant while comparing proposal objects", () => {
    const view = workflowFixture();
    if (!view.proposal) throw new Error("Missing test proposal");
    const reordered = structuredClone(view.proposal);
    reordered.lines.reverse();
    expect(sameImportProposal(reordered, view.proposal)).toBe(false);
    const changed = structuredClone(view.proposal);
    const line = changed.lines[0];
    if (line.kind !== "CREATE") throw new Error("Missing test create");
    line.targets[0].roomId = "another-room";
    expect(sameImportProposal(changed, view.proposal)).toBe(false);
    expect(sameImportProposal(null, view.proposal)).toBe(false);
  });

  it("compares nested target and invoice objects semantically, but not array reordering", () => {
    const view = appliedFixture();
    if (!view.receipt) throw new Error("Missing test receipt");
    const snapshot = view.receipt.snapshot;
    snapshot.lines[0].targets = snapshot.lines[0].targets.map((t) => ({
      amountCents: t.amountCents,
      projectId: t.projectId,
    }));
    snapshot.invoiceDeltas = snapshot.invoiceDeltas.map((d) => ({
      amountCents: d.amountCents,
      invoiceDueMonth: d.invoiceDueMonth,
    }));
    expect(readImportWorkflowView(view)).toEqual(view);
    snapshot.invoiceDeltas.reverse();
    expect(() => readImportWorkflowView(view)).toThrow();
  });

  it("checks explicit months, not only the invoice total", () => {
    const view = workflowFixture();
    if (!view.proposal) throw new Error("Missing test proposal");
    view.proposal.invoiceDeltas[0].invoiceDueMonth = "2028-01";
    expect(() => readImportWorkflowView(view)).toThrow();
  });

  it("checks the immutable receipt invoice effects even without the proposal", () => {
    const view = appliedFixture();
    if (!view.receipt) throw new Error("Missing test receipt");
    view.proposal = null;
    view.receipt.snapshot.invoiceDeltas[0].invoiceDueMonth = "2028-01";
    expect(() => readImportWorkflowView(view)).toThrow();
    expect(() =>
      readImportWorkflowReceipt(view.receipt, view.ownerProjectId),
    ).toThrow();
  });

  it.each(["contradictory", "arithmetic-feasible"] as const)(
    "rejects an unknown CREATE source cycle even with %s invoice effects",
    (effects) => {
      const view = workflowFixture();
      if (!view.proposal) throw new Error("Missing test proposal");
      view.proposal.lines[0].schedule.occurrences[0].invoiceDueMonth = null;
      if (effects === "contradictory") {
        view.proposal.invoiceDeltas = [
          { invoiceDueMonth: "2026-12", amountCents: 0 },
          { invoiceDueMonth: "2027-01", amountCents: 199999998 },
        ];
      }
      expect(() => readImportWorkflowView(view)).toThrow();
    },
  );

  it("rejects an unknown CREATED snapshot cycle without the optional proposal", () => {
    const view = appliedFixture();
    if (!view.receipt) throw new Error("Missing test receipt");
    view.proposal = null;
    view.receipt.snapshot.lines[0].schedule.occurrences[0].invoiceDueMonth =
      null;
    expect(() => readImportWorkflowView(view)).toThrow();
    expect(() =>
      readImportWorkflowReceipt(view.receipt, view.ownerProjectId),
    ).toThrow();
  });

  it("rejects an unknown proposed target cycle while all source cycles are known", () => {
    const view = workflowFixture();
    const line = view.proposal?.lines[0];
    if (line?.kind !== "CREATE") throw new Error("Missing test create");
    line.targets[0].schedule.occurrences[0].invoiceDueMonth = null;
    expect(() => readImportWorkflowView(view)).toThrow();
  });

  it.each(["READY", "CONFIRMED", "REVIEW_REQUIRED"] as const)(
    "rejects an unknown CREATE in a %s proposal even with no actions",
    (state) => {
      const view = state === "READY" ? workflowFixture() : confirmedFixture();
      if (!view.proposal) throw new Error("Missing test proposal");
      view.state = state;
      view.actions = [];
      view.proposal.lines[0].schedule.occurrences[0].invoiceDueMonth = null;
      expect(() => readImportWorkflowView(view)).toThrow();
    },
  );

  it("preserves unknown KEEP cycles beside a resolved CREATE proposal", () => {
    const view = workflowFixture();
    if (!view.proposal) throw new Error("Missing test proposal");
    const kept = view.proposal.lines[0];
    kept.schedule.occurrences[0].invoiceDueMonth = null;
    view.lines[0].decision = { kind: "KEEP_EXISTING", expenseId: "existing" };
    view.proposal.lines[0] = {
      kind: "KEEP_EXISTING",
      lineId: kept.lineId,
      sourceExpenseId: "existing",
      totalCents: kept.totalCents,
      schedule: kept.schedule,
    };
    view.proposal.createdEconomicTotalCents = 99999999;
    view.proposal.invoiceDeltas = [
      { invoiceDueMonth: "2026-12", amountCents: 50000000 },
      { invoiceDueMonth: "2027-01", amountCents: 49999999 },
    ];
    expect(readImportWorkflowView(view)).toEqual(view);
  });

  it("preserves unknown KEEP cycles beside a CREATED snapshot by correlated outcome", () => {
    const view = appliedFixture();
    if (!view.receipt) throw new Error("Missing test receipt");
    view.proposal = null;
    const item = view.receipt.items[0];
    item.outcome = "KEPT_EXISTING";
    item.sourceExpenseId = "existing";
    item.targetExpenseIds = [];
    item.allocationIds = [];
    item.cashFlowEntryIds = [];
    const snapshot = view.receipt.snapshot;
    snapshot.lines[0].titulo = null;
    snapshot.lines[0].dataCompra = null;
    snapshot.lines[0].targets = [];
    snapshot.lines[0].schedule.occurrences[0].invoiceDueMonth = null;
    snapshot.createdEconomicTotalCents = 99999999;
    snapshot.invoiceDeltas = [
      { invoiceDueMonth: "2026-12", amountCents: 50000000 },
      { invoiceDueMonth: "2027-01", amountCents: 49999999 },
    ];
    expect(readImportWorkflowView(view)).toEqual(view);
  });

  it("preserves unresolved draft dates and questions without a proposal", () => {
    const view = workflowFixture();
    view.state = "NEEDS_INPUT";
    view.proposal = null;
    view.selectedLineIds = [];
    view.searchComplete = false;
    view.actions = ["RESOLVE"];
    view.lines[0].firstDueDate = null;
    view.lines[0].dataCompra = null;
    view.lines[0].decision = { kind: "UNRESOLVED" };
    view.questions = [
      {
        id: "question-date",
        lineIds: ["first"],
        field: "firstDueDate",
        text: "Qual a data informada no documento?",
      },
    ];
    expect(readImportWorkflowView(view)).toEqual(view);
  });

  it("preserves an unresolved deferred line beside the valid selected proposal", () => {
    const view = workflowFixture();
    if (!view.proposal) throw new Error("Missing test proposal");
    view.lines.push({
      ...view.lines[0],
      id: "deferred",
      observationIds: ["observation-deferred"],
      firstDueDate: null,
      dataCompra: null,
      amountCents: null,
      decision: { kind: "UNRESOLVED" },
    });
    view.proposal.deferredObservationIds = ["observation-deferred"];
    view.proposal.retainUntil = view.expiresAt;
    expect(readImportWorkflowView(view)).toEqual(view);
  });

  it.each(["DRAFT", "ANALYZING", "NEEDS_INPUT", "READY"] as const)(
    "does not attach a confirmed tuple to %s",
    (state) => {
      const view = confirmedFixture();
      view.state = state;
      expect(() => readImportWorkflowView(view)).toThrow();
    },
  );

  it("preserves the old approved tuple while awaiting a post-confirmation review", () => {
    const view = confirmedFixture();
    view.state = "REVIEW_REQUIRED";
    view.actions = [];
    expect(readImportWorkflowView(view)).toEqual(view);
  });
});
