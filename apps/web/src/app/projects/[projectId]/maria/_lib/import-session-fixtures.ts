import type {
  ImportSessionReceiptV1,
  ImportSessionSummaryV1,
  ImportSessionViewV1,
} from "@reformaflow/domain";

/**
 * Read-only fixtures for the recovery UI. They mirror the wire v1 types and exist so
 * future states (DRAFT, NEEDS_INPUT, REVIEW_REQUIRED, …) can be rendered and tested
 * before the server can produce them. They are never sent anywhere.
 */
export const FIXTURE_INSTANT = "2026-09-28T15:30:00.000Z";

export function summaryFixture(
  overrides: Partial<ImportSessionSummaryV1> = {},
): ImportSessionSummaryV1 {
  return {
    id: "sess-1",
    state: "DRAFT",
    revision: 3,
    cardId: "card-1",
    ownerProjectId: "proj-1",
    createdAt: "2026-09-27T12:00:00.000Z",
    expiresAt: "2026-10-04T12:00:00.000Z",
    appliedAt: null,
    attachmentCount: 1,
    hasConfirmation: false,
    continuationSessionId: null,
    actions: ["CANCEL"],
    ...overrides,
  };
}

export function viewFixture(
  overrides: Partial<ImportSessionViewV1> = {},
): ImportSessionViewV1 {
  return {
    version: 1,
    id: "sess-1",
    ownerProjectId: "proj-1",
    cardId: "card-1",
    state: "DRAFT",
    revision: 3,
    expiresAt: "2026-10-04T12:00:00.000Z",
    attachments: [
      {
        id: "att-1",
        fileName: "fatura-setembro.pdf",
        declaredBytes: 120000,
        state: "ATTACHED",
        materializedInSession: false,
        canAnalyze: false,
      },
    ],
    searchComplete: true,
    proposal: null,
    confirmation: null,
    receipt: null,
    lines: [],
    selectedLineIds: [],
    questions: [],
    declaredFacts: [],
    reviewBlockers: [],
    actions: ["CANCEL"],
    ...overrides,
  };
}

export function receiptFixture(
  overrides: Partial<ImportSessionReceiptV1> = {},
): ImportSessionReceiptV1 {
  return {
    version: 1,
    sessionId: "sess-9",
    financialRequestId: "11111111-1111-4111-8111-111111111111",
    confirmedRevision: 5,
    bindingVersion: 1,
    confirmationHash: "a".repeat(64),
    appliedAt: "2026-09-20T02:30:00.000Z",
    continuationSessionId: null,
    items: [
      {
        lineId: "line-1",
        outcome: "CREATED",
        sourceExpenseId: "exp-1",
        targetExpenseIds: ["exp-2"],
        allocationIds: ["alloc-1"],
        cashFlowEntryIds: [],
      },
      {
        lineId: "line-2",
        outcome: "KEPT_EXISTING",
        sourceExpenseId: "exp-3",
        targetExpenseIds: [],
        allocationIds: [],
        cashFlowEntryIds: [],
      },
    ],
    snapshot: {
      lines: [
        {
          lineId: "line-1",
          titulo: "Geladeira Frost Free",
          dataCompra: "2026-09-20",
          totalCents: 12_345_678,
          schedule: {
            version: 1,
            occurrences: [
              {
                index: 0,
                parcela: "1/2",
                valor: 6_172_839,
                data: "2026-10-10",
                invoiceDueMonth: "2026-10",
              },
              {
                index: 1,
                parcela: "2/2",
                valor: 6_172_839,
                data: "2026-11-10",
                invoiceDueMonth: "2026-11",
              },
            ],
          },
          sourceProjectId: "proj-pessoal",
          targets: [
            { projectId: "proj-reforma", amountCents: 10_000_000 },
            { projectId: "proj-oculto", amountCents: 2_345_678 },
          ],
        },
        {
          lineId: "line-2",
          titulo: null,
          dataCompra: null,
          totalCents: 4_990,
          schedule: {
            version: 1,
            occurrences: [
              {
                index: 0,
                parcela: null,
                valor: 4_990,
                data: "2026-10-10",
                invoiceDueMonth: "2026-10",
              },
            ],
          },
          sourceProjectId: "proj-pessoal",
          targets: [],
        },
      ],
      participantProjectIds: ["proj-oculto", "proj-pessoal", "proj-reforma"],
      createdEconomicTotalCents: 12_345_678,
      bankCashDeltaCents: 0,
      invoiceDeltas: [
        { invoiceDueMonth: "2026-10", amountCents: 6_177_829 },
        { invoiceDueMonth: "2026-11", amountCents: -6_172_839 },
      ],
    },
    ...overrides,
  };
}
