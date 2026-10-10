import { parseReceipt } from "./import-session.projection";
import { ImportSessionCorruptStateError } from "./import-session.errors";

const validReceipt = {
  version: 1,
  sessionId: "session",
  financialRequestId: "11111111-1111-4111-8111-111111111111",
  confirmedRevision: 2,
  proposalHash: "a".repeat(64),
  appliedAt: "2026-10-10T15:00:00.000Z",
  continuationSessionId: null,
  items: [
    {
      lineId: "line",
      outcome: "CREATED",
      sourceExpenseId: "expense",
      targetExpenseIds: [],
      allocationIds: [],
      cashFlowEntryIds: ["flow"],
    },
  ],
  snapshot: {
    lines: [
      {
        lineId: "line",
        titulo: "Compra",
        dataCompra: "2026-10-10",
        totalCents: 12345,
        schedule: {
          version: 1,
          occurrences: [
            {
              index: 0,
              data: "2026-10-10",
              valor: 12345,
              parcela: null,
              invoiceDueMonth: "2026-10",
            },
          ],
        },
        sourceProjectId: "owner",
        targets: [],
      },
    ],
    participantProjectIds: ["owner"],
    createdEconomicTotalCents: 12345,
    bankCashDeltaCents: 0,
    invoiceDeltas: [{ invoiceDueMonth: "2026-10", amountCents: 12345 }],
  },
};
const auditItem = {
  observationId: "observation-payment",
  outcome: "IGNORED",
  reason: "INVOICE_PAYMENT",
  title: "Pagamento de fatura",
  amountCents: -12000,
};

describe("immutable import receipt audit", () => {
  it.each([2, 4])(
    "keeps historical APPLIED receipts with %s destinations readable",
    (targetCount) => {
      const targets = Array.from({ length: targetCount }, (_, index) => ({
        projectId: `project-${index}`,
        amountCents: index === targetCount - 1 ? 12345 - 1000 * index : 1000,
      }));
      const targetExpenseIds = targets.map(
        (_, index) => `target-expense-${index}`,
      );
      const receipt = {
        ...validReceipt,
        items: [
          {
            ...validReceipt.items[0],
            targetExpenseIds,
            allocationIds: targets.map((_, index) => `allocation-${index}`),
          },
        ],
        snapshot: {
          ...validReceipt.snapshot,
          lines: [
            {
              ...validReceipt.snapshot.lines[0],
              targets,
            },
          ],
          participantProjectIds: [
            "owner",
            ...targets.map(({ projectId }) => projectId),
          ].sort(),
        },
      };

      expect(
        parseReceipt(JSON.stringify(receipt), "session", "owner"),
      ).toMatchObject({
        auditItems: [],
        items: [{ targetExpenseIds }],
        snapshot: {
          lines: [{ targets }],
        },
      });
    },
  );

  it("accepts historical receipts without audit as an empty list", () => {
    expect(
      parseReceipt(JSON.stringify(validReceipt), "session", "owner").auditItems,
    ).toEqual([]);
  });

  it.each([{ auditItems: [] }, { auditItems: [auditItem] }])(
    "strictly retains valid audit items: %#",
    ({ auditItems }) => {
      expect(
        parseReceipt(
          JSON.stringify({ ...validReceipt, auditItems }),
          "session",
          "owner",
        ).auditItems,
      ).toEqual(auditItems);
    },
  );

  it.each([
    { auditItems: [{ ...auditItem, outcome: "SKIPPED" }] },
    { auditItems: [{ ...auditItem, reason: "OTHER" }] },
    { auditItems: [{ ...auditItem, amountCents: 1 }] },
    {
      auditItems: [{ ...auditItem, amountCents: Number.MAX_SAFE_INTEGER + 1 }],
    },
    { auditItems: [{ ...auditItem, extra: true }] },
    { auditItems: [auditItem, auditItem] },
  ])("fails closed for malformed audit items: %#", ({ auditItems }) => {
    expect(() =>
      parseReceipt(
        JSON.stringify({ ...validReceipt, auditItems }),
        "session",
        "owner",
      ),
    ).toThrow(ImportSessionCorruptStateError);
  });
});
