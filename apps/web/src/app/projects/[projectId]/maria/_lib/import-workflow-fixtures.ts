import {
  ExpenseType,
  IMPORT_SESSION_KIND,
  type ImportCurrentLotV1,
  type ImportSessionReceiptV1,
  type ImportSessionViewV1,
  type ImportObservationQuestionV1,
  type ImportDeclaredFactViewV1,
} from "@reformaflow/domain";

export function currentLotFixture(
  actions: ImportCurrentLotV1["actions"] = ["CONFIRM"],
): ImportCurrentLotV1 {
  return {
    version: 1,
    state: actions.includes("EXECUTE") ? "CONFIRMED" : "READY_WITH_PENDING",
    revision: 7,
    confirmationHash: "a".repeat(64),
    purchases: [
      {
        title: "Compra documental com descrição extensa",
        merchant: "Fornecedor",
        purchaseDate: "2026-10-06",
        totalCents: 99999999,
        installmentIndex: 9,
        installmentCount: 10,
        schedule: {
          version: 1,
          occurrences: [
            {
              index: 0,
              parcela: "9/10",
              valor: 50000000,
              data: "2026-11-20",
              invoiceDueMonth: "2026-12",
            },
            {
              index: 1,
              parcela: "10/10",
              valor: 49999999,
              data: "2026-12-20",
              invoiceDueMonth: "2027-01",
            },
          ],
        },
        targets: [
          {
            projectLabel: "Reforma da casa",
            roomLabel: null,
            amountCents: 99999999,
            schedule: {
              version: 1,
              occurrences: [
                {
                  index: 0,
                  parcela: "9/10",
                  valor: 50000000,
                  data: "2026-11-20",
                  invoiceDueMonth: "2026-12",
                },
                {
                  index: 1,
                  parcela: "10/10",
                  valor: 49999999,
                  data: "2026-12-20",
                  invoiceDueMonth: "2027-01",
                },
              ],
            },
          },
        ],
        disposition: "CREATE",
      },
    ],
    createdEconomicTotalCents: 99999999,
    bankCashDeltaCents: 0,
    invoiceDeltas: [
      { invoiceDueMonth: "2026-12", amountCents: 50000000 },
      { invoiceDueMonth: "2027-01", amountCents: 49999999 },
    ],
    hasRemainingWork: true,
    actions,
  };
}

/** Synthetic wire data for offline contract/layout tests, never a server substitute. */
export function workflowFixture(): ImportSessionViewV1 {
  const schedule = {
    version: 1 as const,
    occurrences: [
      {
        index: 0,
        parcela: "9/10",
        valor: 50000000,
        data: "2026-11-20",
        invoiceDueMonth: "2026-12",
      },
      {
        index: 1,
        parcela: "10/10",
        valor: 49999999,
        data: "2026-12-20",
        invoiceDueMonth: "2027-01",
      },
    ],
  };
  return {
    version: 1,
    id: "session-a",
    ownerProjectId: "personal",
    cardId: "card-a",
    state: "READY",
    revision: 7,
    expiresAt: "2026-10-14T03:00:00.000Z",
    attachments: [
      {
        id: "attachment-a",
        fileName: "compras.png",
        declaredBytes: 1024,
        state: "ATTACHED",
        materializedInSession: true,
        canAnalyze: false,
      },
    ],
    lines: ["first", "twin"].map((id) => ({
      id,
      observationIds: [`observation-${id}`],
      titulo: "Compra documental com descrição extensa",
      fornecedor: "Fornecedor",
      tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
      categoriaMaoDeObra: null,
      amountMeaning: "TOTAL_PURCHASE",
      amountCents: 99999999,
      installmentCount: 2,
      dataCompra: "2026-10-06",
      firstDueDate: "2026-11-20",
      targets: [
        { projectId: "renovation", roomId: null, amountCents: 99999999 },
      ],
      decision: { kind: "CREATE", acceptNaturalDuplicate: true },
    })),
    selectedLineIds: ["first", "twin"],
    questions: [],
    declaredFacts: [],
    reviewBlockers: [],
    searchComplete: true,
    proposal: {
      version: 1,
      kind: IMPORT_SESSION_KIND,
      sessionId: "session-a",
      revision: 7,
      lines: ["first", "twin"].map((lineId) => ({
        kind: "CREATE",
        lineId,
        titulo: "Compra documental com descrição extensa",
        fornecedor: "Fornecedor",
        tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
        categoriaMaoDeObra: null,
        dataCompra: "2026-10-06",
        totalCents: 99999999,
        schedule: structuredClone(schedule),
        targets: [
          {
            projectId: "renovation",
            roomId: null,
            amountCents: 99999999,
            schedule: structuredClone(schedule),
          },
        ],
      })),
      deferredObservationIds: [],
      deferredAttachmentIds: [],
      retainUntil: null,
      createdEconomicTotalCents: 199999998,
      bankCashDeltaCents: 0,
      invoiceDeltas: [
        { invoiceDueMonth: "2026-12", amountCents: 100000000 },
        { invoiceDueMonth: "2027-01", amountCents: 99999998 },
      ],
    },
    confirmation: null,
    receipt: null,
    actions: ["CONFIRM", "CANCEL"],
  };
}

export const WORKFLOW_REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";

// Turn 9 wire fixtures, not a normalizer or a substitute for the server producer.
export function declarationQuestionFixture(
  lineId = "first",
  answerState: "UNANSWERED" | "DECLARED" | "UNKNOWN" = "UNANSWERED",
): Extract<ImportObservationQuestionV1, { field: "amountCents" }> {
  return {
    id: `oq_${lineId}_amount`,
    lineIds: [lineId],
    field: "amountCents" as const,
    text: `Qual é o total da compra ${lineId}?`,
    subject: {
      kind: "OBSERVATION" as const,
      observationId: `observation-${lineId}`,
      meaningContext: "TOTAL_PURCHASE" as const,
    },
    answerState,
  };
}

export function declaredFactFixture(
  lineId = "first",
  status: "CURRENT" | "UNKNOWN" | "CONTEXT_CHANGED" = "CURRENT",
): Extract<ImportDeclaredFactViewV1, { field: "amountCents" }> {
  const base = {
    lineId,
    observationId: `observation-${lineId}`,
    questionId: `oq_${lineId}_amount`,
    field: "amountCents" as const,
    meaningContext:
      status === "CONTEXT_CHANGED"
        ? ("INSTALLMENT_CHARGE" as const)
        : ("TOTAL_PURCHASE" as const),
    origin: "USER_ATTESTATION" as const,
  };
  if (status === "UNKNOWN") return { ...base, status, value: null };
  return { ...base, status, value: 10000 };
}

export function declarationViewFixture() {
  const actions: ImportSessionViewV1["actions"] = ["RESOLVE", "CANCEL"];
  const declaredFacts: ReturnType<typeof declaredFactFixture>[] = [];
  return {
    ...workflowFixture(),
    state: "NEEDS_INPUT" as const,
    proposal: null,
    searchComplete: false,
    actions,
    questions: [
      declarationQuestionFixture(),
      declarationQuestionFixture("twin"),
    ],
    declaredFacts,
    reviewBlockers: [
      {
        lineId: "first",
        code: "ORIGINAL_IDENTITY_INCOMPLETE" as const,
        resolution: "NEEDS_DECLARATION" as const,
      },
      {
        lineId: "twin",
        code: "ORIGINAL_IDENTITY_INCOMPLETE" as const,
        resolution: "NEEDS_DECLARATION" as const,
      },
    ],
  };
}

export function confirmedFixture(
  financialRequestId = WORKFLOW_REQUEST_ID,
): ImportSessionViewV1 {
  const view = workflowFixture();
  view.state = "CONFIRMED";
  view.revision = 8;
  view.actions = ["EXECUTE", "READ_RESULT"];
  view.confirmation = {
    financialRequestId,
    confirmedRevision: 7,
    bindingVersion: 1,
    confirmationHash: "a".repeat(64),
  };
  return view;
}

export function appliedFixture(
  financialRequestId = WORKFLOW_REQUEST_ID,
): ImportSessionViewV1 {
  const view = confirmedFixture(financialRequestId);
  if (!view.proposal || !view.confirmation)
    throw new Error("Invalid synthetic fixture");
  const receipt: ImportSessionReceiptV1 = {
    ...view.confirmation,
    version: 1,
    sessionId: view.id,
    appliedAt: "2026-10-07T03:00:00.000Z",
    continuationSessionId: null,
    items: view.proposal.lines.map((line) => ({
      lineId: line.lineId,
      outcome: "CREATED",
      sourceExpenseId: `expense-${line.lineId}`,
      targetExpenseIds: [`target-${line.lineId}`],
      allocationIds: [`allocation-${line.lineId}`],
      cashFlowEntryIds: [
        `source-cfe-${line.lineId}-0`,
        `source-cfe-${line.lineId}-1`,
        `target-cfe-${line.lineId}-0`,
        `target-cfe-${line.lineId}-1`,
      ],
    })),
    snapshot: {
      lines: view.proposal.lines.map((line) => ({
        lineId: line.lineId,
        titulo: line.kind === "CREATE" ? line.titulo : null,
        dataCompra: line.kind === "CREATE" ? line.dataCompra : null,
        totalCents: line.totalCents,
        schedule: structuredClone(line.schedule),
        sourceProjectId: "personal",
        targets: [{ projectId: "renovation", amountCents: line.totalCents }],
      })),
      participantProjectIds: ["personal", "renovation"],
      createdEconomicTotalCents: view.proposal.createdEconomicTotalCents,
      bankCashDeltaCents: 0,
      invoiceDeltas: structuredClone(view.proposal.invoiceDeltas),
    },
  };
  return {
    ...view,
    state: "APPLIED",
    revision: 9,
    expiresAt: null,
    actions: ["READ_RESULT"],
    receipt,
  };
}

export const workflowCatalog = {
  projects: [
    { id: "personal", name: "Meu pessoal" },
    { id: "renovation", name: "Reforma da casa" },
  ],
  cards: [
    {
      id: "card-a",
      nickname: "Cartão da família",
      last4: "1234",
      project: { id: "personal", name: "Meu pessoal" },
    },
  ],
};
