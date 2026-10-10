import {
  ExpenseType,
  type ExpenseScheduleV1,
  type ImportSessionProposalV1,
  type ImportSessionStoredDraftV1,
} from "@reformaflow/domain";

export function validationDraft(projectId: string): ImportSessionStoredDraftV1 {
  return {
    version: 1,
    lines: [
      {
        id: "line-create",
        observationIds: ["observation-create"],
        titulo: "Compra",
        fornecedor: null,
        tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
        categoriaMaoDeObra: null,
        amountMeaning: "TOTAL_PURCHASE",
        amountCents: 101,
        installmentCount: 2,
        dataCompra: "2026-09-28",
        firstDueDate: "2026-10-05",
        targets: [{ projectId, roomId: null, amountCents: 101 }],
        decision: { kind: "CREATE", acceptNaturalDuplicate: false },
      },
      {
        id: "line-keep",
        observationIds: ["observation-keep"],
        titulo: "Compra existente",
        fornecedor: "",
        tipoDespesa: null,
        categoriaMaoDeObra: null,
        amountMeaning: "INSTALLMENT_CHARGE",
        amountCents: 50,
        installmentCount: null,
        dataCompra: null,
        firstDueDate: null,
        targets: [],
        decision: { kind: "KEEP_EXISTING", expenseId: "existing-expense" },
      },
      {
        id: "line-unknown",
        observationIds: ["observation-unknown"],
        titulo: "Desconhecido",
        fornecedor: null,
        tipoDespesa: null,
        categoriaMaoDeObra: null,
        amountMeaning: "UNKNOWN",
        amountCents: null,
        installmentCount: null,
        dataCompra: null,
        firstDueDate: null,
        targets: null,
        decision: { kind: "UNRESOLVED" },
      },
    ],
    selectedLineIds: ["line-create", "line-keep"],
    questions: [
      {
        id: "question-amount",
        lineIds: ["line-unknown"],
        field: "amountCents",
        text: "Qual o total?",
      },
    ],
    scope: {
      observationIds: [
        "observation-create",
        "observation-keep",
        "observation-unknown",
      ],
      pendingAttachmentIds: ["attachment-pending"],
    },
  };
}

export function validationProposal(
  sessionId: string,
  projectId: string,
): ImportSessionProposalV1 {
  const schedule: ExpenseScheduleV1 = {
    version: 1,
    occurrences: [
      {
        index: 0,
        parcela: "9/10",
        valor: 50,
        data: "2026-10-05",
        invoiceDueMonth: "2026-10",
      },
      {
        index: 1,
        parcela: "10/10",
        valor: 51,
        data: "2026-11-05",
        invoiceDueMonth: "2026-11",
      },
    ],
  };
  const keepSchedule = structuredClone(schedule);
  keepSchedule.occurrences[1]!.invoiceDueMonth = null;
  return {
    version: 1,
    kind: "CREATE_CARD_PURCHASES",
    sessionId,
    revision: 2,
    proposalHash: "c".repeat(64),
    lines: [
      {
        kind: "CREATE",
        lineId: "line-create",
        titulo: "Compra",
        fornecedor: null,
        tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
        categoriaMaoDeObra: null,
        dataCompra: "2026-09-28",
        totalCents: 101,
        schedule,
        targets: [{ projectId, roomId: null, amountCents: 101, schedule }],
      },
      {
        kind: "KEEP_EXISTING",
        lineId: "line-keep",
        sourceExpenseId: "existing-expense",
        totalCents: 101,
        schedule: keepSchedule,
      },
    ],
    noWriteRows: [],
    effects: {
      personalSourceCreates: 1,
      reformaTargetCreates: 1,
      expenseCreates: 2,
      cashFlowEntryCreates: 4,
      rateioAllocationCreates: 1,
      keptExistingCount: 1,
      deferredCount: 0,
      excludedCount: 0,
      ignoredCount: 0,
    },
    deferredObservationIds: ["observation-unknown"],
    deferredAttachmentIds: ["attachment-pending"],
    retainUntil: "2026-10-05T15:00:00.000Z",
    createdEconomicTotalCents: 101,
    bankCashDeltaCents: 0,
    invoiceDeltas: [
      { invoiceDueMonth: "2026-10", amountCents: 50 },
      { invoiceDueMonth: "2026-11", amountCents: 51 },
    ],
  };
}
