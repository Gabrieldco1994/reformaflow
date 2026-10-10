import type {
  ImportCurrentLotV1,
  ImportSessionNoWriteRowV1,
  ImportSessionProposalV1,
  ImportSessionStoredDraftV1,
} from "@reformaflow/domain";
import {
  hasResumableProposalWork,
  projectCurrentLot,
} from "./import-current-lot";
import { confirmationHashOf } from "./import-confirmation-binding";

const proposal = (
  hiddenTitle: string,
  hiddenAmount: number,
): ImportSessionProposalV1 => ({
  version: 1,
  kind: "CREATE_CARD_PURCHASES",
  sessionId: "session-1",
  revision: 4,
  proposalHash: "a".repeat(64),
  lines: [
    {
      kind: "CREATE",
      lineId: "ready-1",
      titulo: "Compra pronta",
      fornecedor: "Loja",
      tipoDespesa: "MATERIAL" as never,
      categoriaMaoDeObra: null,
      dataCompra: "2026-10-09",
      totalCents: 10001,
      schedule: {
        version: 1,
        occurrences: [
          {
            index: 0,
            parcela: null,
            valor: 10001,
            data: "2026-10-09",
            invoiceDueMonth: "2026-10",
          },
        ],
      },
      targets: [],
    },
  ],
  noWriteRows: [
    {
      lineId: "hidden-1",
      outcome: "DEFERRED",
      reason: "USER_DEFERRED",
      title: hiddenTitle,
      amountCents: hiddenAmount,
    },
  ],
  deferredObservationIds: ["observation-hidden"],
  deferredAttachmentIds: ["attachment-hidden"],
  retainUntil: "2026-10-16T14:32:30.988Z",
  createdEconomicTotalCents: 10001,
  bankCashDeltaCents: 0,
  invoiceDeltas: [{ invoiceDueMonth: "2026-10", amountCents: 10001 }],
});

const draft: ImportSessionStoredDraftV1 = {
  version: 1,
  lines: [],
  selectedLineIds: [],
  questions: [],
  scope: { observationIds: [], pendingAttachmentIds: [] },
};

describe("current lot projection", () => {
  it("contains ready financial data and only a generic remainder signal", () => {
    const result = projectCurrentLot(
      "READY",
      proposal("Segredo 250", 25000),
      draft,
      new Map(),
    );
    expect(result.purchases).toHaveLength(1);
    expect(result.createdEconomicTotalCents).toBe(10001);
    expect(result.hasRemainingWork).toBe(true);
    expect(result.state).toBe("READY_WITH_PENDING");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("Segredo 250");
    expect(serialized).not.toContain("25000");
    expect(serialized).not.toContain("observation-hidden");
    expect(serialized).not.toContain("attachment-hidden");
    expect(serialized).not.toContain("hidden-1");
    expect(result).not.toHaveProperty("noWriteRows");
    expect(result).not.toHaveProperty("proposalHash");
    expect(result.confirmationHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is differentially indistinguishable when hidden scope changes", () => {
    const first = projectCurrentLot(
      "READY",
      proposal("Segredo A", 25000),
      draft,
      new Map(),
    );
    const second = projectCurrentLot(
      "READY",
      proposal("Segredo B", 99999),
      {
        ...draft,
        scope: { observationIds: [], pendingAttachmentIds: ["other-hidden"] },
      },
      new Map(),
    );
    expect(first).toEqual(second);
    expect(first.confirmationHash).toBe(second.confirmationHash);
  });

  it("derives remaining work only from the sealed proposal continuation scope", () => {
    const sealed = proposal("Hidden", 100);
    sealed.noWriteRows = [];
    sealed.deferredObservationIds = [];
    sealed.deferredAttachmentIds = [];
    sealed.retainUntil = null;
    const mutableDraft = {
      ...draft,
      lines: [
        {
          id: "mutable-pending",
          observationIds: [],
          titulo: "Must not influence the sealed review",
          fornecedor: null,
          tipoDespesa: null,
          categoriaMaoDeObra: null,
          amountMeaning: "UNKNOWN" as const,
          amountCents: null,
          installmentCount: null,
          dataCompra: null,
          firstDueDate: null,
          targets: null,
          decision: { kind: "UNRESOLVED" as const },
        },
      ],
      questions: [
        {
          id: "mutable-question",
          lineIds: ["mutable-pending"],
          field: "decision" as const,
          text: "Mutable question",
        },
      ],
    };

    expect(projectCurrentLot("READY", sealed, mutableDraft)).toMatchObject({
      state: "READY",
      hasRemainingWork: false,
    });
  });

  it("changes the public confirmation hash for every displayed mutation", () => {
    const baseline = projectCurrentLot(
      "READY",
      proposal("Hidden", 100),
      draft,
      new Map(),
    );
    const changed = proposal("Hidden", 100);
    changed.lines[0]!.totalCents += 1;
    changed.lines[0]!.schedule.occurrences[0]!.valor += 1;
    expect(
      projectCurrentLot("READY", changed, draft, new Map()).confirmationHash,
    ).not.toBe(baseline.confirmationHash);
  });

  it.each([
    ["title", (lot: ImportCurrentLotV1) => (lot.purchases[0]!.title = "Outra")],
    [
      "merchant",
      (lot: ImportCurrentLotV1) => (lot.purchases[0]!.merchant = "Outro"),
    ],
    [
      "purchaseDate",
      (lot: ImportCurrentLotV1) =>
        (lot.purchases[0]!.purchaseDate = "2026-10-10"),
    ],
    [
      "totalCents",
      (lot: ImportCurrentLotV1) => (lot.purchases[0]!.totalCents += 1),
    ],
    [
      "installmentIndex",
      (lot: ImportCurrentLotV1) => (lot.purchases[0]!.installmentIndex = 1),
    ],
    [
      "installmentCount",
      (lot: ImportCurrentLotV1) => (lot.purchases[0]!.installmentCount = 2),
    ],
    [
      "purchase schedule",
      (lot: ImportCurrentLotV1) =>
        (lot.purchases[0]!.schedule.occurrences[0]!.valor += 1),
    ],
    [
      "project label",
      (lot: ImportCurrentLotV1) =>
        (lot.purchases[0]!.targets[0]!.projectLabel = "Projeto B"),
    ],
    [
      "room label",
      (lot: ImportCurrentLotV1) =>
        (lot.purchases[0]!.targets[0]!.roomLabel = "Quarto"),
    ],
    [
      "target amount",
      (lot: ImportCurrentLotV1) =>
        (lot.purchases[0]!.targets[0]!.amountCents += 1),
    ],
    [
      "target schedule",
      (lot: ImportCurrentLotV1) =>
        (lot.purchases[0]!.targets[0]!.schedule.occurrences[0]!.data =
          "2026-10-10"),
    ],
    [
      "disposition",
      (lot: ImportCurrentLotV1) =>
        (lot.purchases[0]!.disposition = "KEEP_EXISTING"),
    ],
    [
      "created total",
      (lot: ImportCurrentLotV1) => (lot.createdEconomicTotalCents += 1),
    ],
    [
      "invoice month",
      (lot: ImportCurrentLotV1) =>
        (lot.invoiceDeltas[0]!.invoiceDueMonth = "2026-11"),
    ],
    [
      "invoice amount",
      (lot: ImportCurrentLotV1) => (lot.invoiceDeltas[0]!.amountCents += 1),
    ],
  ])("binds the displayed %s", (_field, mutate) => {
    const baseline = projectCurrentLot(
      "READY",
      proposal("Hidden", 100),
      draft,
      new Map(),
    );
    baseline.purchases[0]!.targets.push({
      projectLabel: "Projeto A",
      roomLabel: null,
      amountCents: baseline.purchases[0]!.totalCents,
      schedule: structuredClone(baseline.purchases[0]!.schedule),
    });
    const changed = structuredClone(baseline);
    mutate(changed);
    expect(confirmationHashOf(changed)).not.toBe(confirmationHashOf(baseline));
  });

  it("does not bind operational current-lot metadata", () => {
    const baseline = projectCurrentLot(
      "READY",
      proposal("Hidden", 100),
      draft,
      new Map(),
    );
    const operationallyChanged = {
      ...baseline,
      state: "CONFIRMED" as const,
      revision: baseline.revision + 1,
      hasRemainingWork: !baseline.hasRemainingWork,
      actions: [] as [],
    };
    expect(confirmationHashOf(operationallyChanged)).toBe(
      confirmationHashOf(baseline),
    );
  });

  const ignored: ImportSessionNoWriteRowV1 = {
    lineId: "ignored",
    outcome: "IGNORED",
    reason: "INVOICE_PAYMENT",
    title: "Hidden ignored amount 98765",
    amountCents: 98765,
  };
  const excluded: ImportSessionNoWriteRowV1 = {
    lineId: "excluded",
    outcome: "EXCLUDED",
    reason: "USER_EXCLUDED",
    title: "Hidden excluded amount 87654",
    amountCents: 87654,
  };
  const deferred: ImportSessionNoWriteRowV1 = {
    lineId: "deferred",
    outcome: "DEFERRED",
    reason: "USER_DEFERRED",
    title: "Hidden deferred amount 76543",
    amountCents: 76543,
  };

  it.each([
    ["zero", [], false],
    ["ignored only", [ignored], false],
    ["excluded only", [excluded], false],
    ["deferred only", [deferred], true],
    ["completed mixture", [ignored, excluded], false],
    ["resumable mixture", [ignored, excluded, deferred], true],
  ] as const)(
    "projects %s no-write rows without leaking hidden scope",
    (_case, noWriteRows, expectedRemaining) => {
      const sealed = proposal("Unused", 1);
      sealed.noWriteRows = [...noWriteRows];
      sealed.deferredObservationIds = [];
      sealed.deferredAttachmentIds = [];
      sealed.retainUntil = null;

      expect(hasResumableProposalWork(sealed)).toBe(expectedRemaining);
      const result = projectCurrentLot("READY", sealed, draft, new Map());
      expect(result).toMatchObject({
        state: expectedRemaining ? "READY_WITH_PENDING" : "READY",
        hasRemainingWork: expectedRemaining,
      });
      const serialized = JSON.stringify(result);
      for (const hidden of noWriteRows) {
        expect(serialized).not.toContain(hidden.lineId);
        expect(serialized).not.toContain(hidden.title);
        expect(serialized).not.toContain(String(hidden.amountCents));
      }
      expect(result).not.toHaveProperty("noWriteRows");
      expect(result).not.toHaveProperty("remainingCount");
      expect(result).not.toHaveProperty("remainingAmountCents");
    },
  );
});
