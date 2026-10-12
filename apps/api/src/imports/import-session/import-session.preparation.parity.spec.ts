import {
  ExpenseType,
  IMPORT_SESSION_KIND,
  IMPORT_SESSION_LIMITS,
  IMPORT_SESSION_PRIMITIVES,
  IMPORT_SESSION_PROTOCOL_VERSION,
  ImportSessionAmountMeaning,
  type ImportSessionDraftLineV1,
  type ImportSessionStoredDraftV1,
} from "@reformaflow/domain";
import {
  buildImportPreparationPlan,
  type PreparationObservation,
  type PreparationReference,
  type ProposalBody,
} from "./import-session.preparation";
import { ImportSessionCorruptStateError } from "./import-session.errors";
import { validateProposal } from "./import-session.validation";
import { parseStoredDraft } from "./import-session.projection";

const expiresAt = new Date("2026-10-13T15:00:00.000Z");
const session = {
  id: "session",
  tenantId: "tenant",
  ownerProjectId: "owner",
  cardId: "card",
  revision: 1,
  confirmedRevision: null,
  expiresAt,
};
const schedule = {
  version: 1 as const,
  occurrences: [
    {
      index: 0,
      data: "2026-10-10",
      valor: 12345,
      parcela: null,
      invoiceDueMonth: "2026-10",
    },
  ],
};

function evidence(
  sourceDescription: string,
  amountCents: number | null,
): string {
  return JSON.stringify({
    version: 1,
    sourceDescription,
    reference: sourceDescription,
    text: sourceDescription,
    amountMeaning: ImportSessionAmountMeaning.TOTAL_PURCHASE,
    amountCents,
    installmentCount: 1,
    installmentIndex: 1,
    dataCompra: "2026-10-10",
    identity: {
      merchant: sourceDescription,
      externalId: null,
      fitId: null,
      ordinal: 0,
      fileContentHash: null,
    },
  });
}

function observation(
  id: string,
  sourceDescription = id,
  amountCents: number | null = 12345,
): PreparationObservation {
  return {
    id,
    tenantId: "tenant",
    ownerProjectId: "owner",
    artifactId: "artifact",
    claimVersion: 0,
    evidenceJson: evidence(sourceDescription, amountCents),
  };
}

function line(id: string, observationId: string): ImportSessionDraftLineV1 {
  return {
    id,
    observationIds: [observationId],
    titulo: id,
    fornecedor: id,
    tipoDespesa: ExpenseType.OUTROS,
    categoriaMaoDeObra: null,
    amountMeaning: ImportSessionAmountMeaning.TOTAL_PURCHASE,
    amountCents: 12345,
    installmentCount: 1,
    dataCompra: "2026-10-10",
    firstDueDate: "2026-10-10",
    targets: [],
    decision: { kind: "CREATE", acceptNaturalDuplicate: false },
  };
}

function reference(): PreparationReference {
  return {
    ref: {
      id: "attachment",
      tenantId: "tenant",
      ownerProjectId: "owner",
      sessionId: "session",
      artifactId: "artifact",
      position: 0,
      state: "ATTACHED",
      uploadGeneration: 1,
    },
    artifact: {
      id: "artifact",
      tenantId: "tenant",
      ownerProjectId: "owner",
      documentSha256: "a".repeat(64),
      state: "EXTRACTED",
    },
  };
}

function proposalBody(): ProposalBody {
  return {
    version: IMPORT_SESSION_PROTOCOL_VERSION,
    kind: IMPORT_SESSION_KIND,
    sessionId: session.id,
    revision: 2,
    lines: [
      {
        kind: "CREATE",
        lineId: "line-selected",
        titulo: "Selected",
        fornecedor: "Selected",
        tipoDespesa: ExpenseType.OUTROS,
        categoriaMaoDeObra: null,
        dataCompra: "2026-10-10",
        totalCents: 12345,
        schedule,
        targets: [],
      },
    ],
    createdEconomicTotalCents: 12345,
    bankCashDeltaCents: 0,
    invoiceDeltas: [{ invoiceDueMonth: "2026-10", amountCents: 12345 }],
  };
}

function historicalTargetAmounts(count: number): number[] {
  const base = Math.floor(12345 / count);
  return Array.from({ length: count }, (_, index) =>
    index === count - 1 ? 12345 - base * (count - 1) : base,
  );
}

function targetSchedule(amountCents: number) {
  return {
    version: 1 as const,
    occurrences: [
      {
        index: 0,
        data: "2026-10-10",
        valor: amountCents,
        parcela: null,
        invoiceDueMonth: "2026-10",
      },
    ],
  };
}

describe("import preparation parity", () => {
  it.each([2, 4])(
    "keeps historical v1 drafts and proposals with %s destinations readable",
    (targetCount) => {
      const targets = historicalTargetAmounts(targetCount).map(
        (amountCents, index) => ({
          projectId: `historical-project-${index}`,
          roomId: null,
          amountCents,
        }),
      );
      const draft: ImportSessionStoredDraftV1 = {
        version: 1,
        lines: [
          {
            ...line("line-selected", "obs-selected"),
            targets,
          },
        ],
        selectedLineIds: ["line-selected"],
        questions: [],
        scope: {
          observationIds: ["obs-selected"],
          pendingAttachmentIds: [],
        },
      };
      expect(parseStoredDraft(JSON.stringify(draft)).lines[0].targets).toEqual(
        targets,
      );

      const historicalProposal = {
        ...proposalBody(),
        proposalHash: "a".repeat(64),
        lines: [
          {
            ...proposalBody().lines[0],
            targets: targets.map((target) => ({
              ...target,
              schedule: targetSchedule(target.amountCents),
            })),
          },
        ],
        deferredObservationIds: [],
        deferredAttachmentIds: [],
        retainUntil: null,
      };
      expect(
        validateProposal(historicalProposal, session.id, null).lines[0],
      ).toMatchObject({ targets });
    },
  );

  it("rejects a new multi-destination preparation while preserving historical parsing", () => {
    const targets = historicalTargetAmounts(2).map((amountCents, index) => ({
      projectId: `new-project-${index}`,
      roomId: null,
      amountCents,
    }));
    const draft: ImportSessionStoredDraftV1 = {
      version: 1,
      lines: [
        {
          ...line("line-selected", "obs-selected"),
          targets,
        },
      ],
      selectedLineIds: ["line-selected"],
      questions: [],
      scope: {
        observationIds: ["obs-selected"],
        pendingAttachmentIds: [],
      },
    };
    const plannedLine = proposalBody().lines[0];
    if (!plannedLine || plannedLine.kind !== "CREATE")
      throw new Error("Invalid proposal fixture");
    const body: ProposalBody = {
      ...proposalBody(),
      lines: [
        {
          ...plannedLine,
          targets: targets.map((target) => ({
            ...target,
            schedule: targetSchedule(target.amountCents),
          })),
        },
      ],
    };

    expect(() =>
      buildImportPreparationPlan({
        session,
        draft,
        proposalBody: body,
        observations: [observation("obs-selected")],
        references: [reference()],
      }),
    ).toThrow(ImportSessionCorruptStateError);
  });

  it("keeps terminal invoice payments out of continuation and preselects remaining mapped rows deterministically", () => {
    const draft: ImportSessionStoredDraftV1 = {
      version: 1,
      lines: [
        line("line-selected", "obs-selected"),
        line("line-z", "obs-z"),
        line("line-a", "obs-a"),
      ],
      selectedLineIds: ["line-selected"],
      questions: [],
      scope: {
        observationIds: [
          "obs-selected",
          "obs-z",
          "obs-a",
          "obs-review",
          "obs-payment",
        ],
        pendingAttachmentIds: [],
      },
    };

    const plan = buildImportPreparationPlan({
      session,
      draft,
      proposalBody: proposalBody(),
      observations: [
        observation("obs-selected"),
        observation("obs-z"),
        observation("obs-a"),
        observation("obs-review"),
        observation("obs-payment", "Pagamento de fatura", -12000),
      ],
      references: [reference()],
    });

    expect(plan.proposal.createdEconomicTotalCents).toBe(12345);
    expect(plan.proposal.invoiceDeltas).toEqual([
      { invoiceDueMonth: "2026-10", amountCents: 12345 },
    ]);
    expect(plan.proposal.auditItems).toEqual([
      {
        observationId: "obs-payment",
        outcome: "IGNORED",
        reason: "INVOICE_PAYMENT",
        title: "Pagamento de fatura",
        amountCents: -12000,
      },
    ]);
    expect(plan.proposal.deferredObservationIds).toEqual([
      "obs-a",
      "obs-review",
      "obs-z",
    ]);
    expect(plan.continuationDraft?.scope.observationIds).toEqual([
      "obs-a",
      "obs-review",
      "obs-z",
    ]);
    expect(plan.continuationDraft?.lines.map(({ id }) => id)).toEqual([
      "line-z",
      "line-a",
    ]);
    expect(plan.continuationDraft?.selectedLineIds).toEqual([
      "line-z",
      "line-a",
    ]);
    expect(plan.transferRefIds).toEqual(["attachment"]);
    expect(plan.continuation.deferredObservations).toHaveLength(3);
    expect(plan.expandedCounts.financialAndCoordinationWrites).toBe(10);
  });

  it("maps each deferred documentary amount to its successor line without changing financial or audit output", () => {
    const deferredLines = [
      {
        ...line("line-25000", "obs-25000"),
        amountMeaning: ImportSessionAmountMeaning.UNKNOWN,
        amountCents: null,
        installmentCount: 5,
        targets: null,
        decision: { kind: "UNRESOLVED" as const },
      },
      {
        ...line("line-4500", "obs-4500"),
        amountCents: null,
      },
      {
        ...line("line-1890", "obs-1890"),
        amountCents: null,
      },
    ];
    const questions = [
      {
        id: "question-deferred",
        lineIds: deferredLines.map(({ id }) => id),
        field: "dataCompra" as const,
        text: "Confirm deferred dates",
      },
    ];
    const declarations = {
      version: 1 as const,
      items: [
        {
          field: "merchant" as const,
          value: "Documented merchant",
          meaningContext: null,
          lineId: "line-4500",
          observationId: "obs-4500",
          originalFingerprint: "b".repeat(64),
          claimVersion: 0,
          originSessionId: session.id,
          recordedRevision: 1,
          questionId: "question-merchant",
          turnId: "123e4567-e89b-42d3-a456-426614174000",
          attestedByUserId: "user",
          attestedAt: "2026-10-10T15:00:00.000Z",
          literalHash: "c".repeat(64),
        },
      ],
    };
    const draft: ImportSessionStoredDraftV1 = {
      version: 1,
      lines: [
        line("line-selected", "obs-selected"),
        ...deferredLines,
        {
          ...line("line-payment", "obs-payment"),
          amountCents: null,
          decision: { kind: "UNRESOLVED" },
        },
      ],
      selectedLineIds: ["line-selected"],
      questions,
      declarations,
      scope: {
        observationIds: [
          "obs-selected",
          "obs-25000",
          "obs-4500",
          "obs-1890",
          "obs-payment",
        ],
        pendingAttachmentIds: [],
      },
    };
    const observations = [
      observation("obs-1890", "Purchase 18.90", 1890),
      observation("obs-payment", "Pagamento de fatura", -12000),
      observation("obs-selected"),
      observation("obs-4500", "Purchase 45.00", 4500),
      observation("obs-25000", "Purchase 250.00", 25000),
    ];
    const body = proposalBody();
    const references = [reference()];
    const originalInput = structuredClone({
      draft,
      proposalBody: body,
      observations,
      references,
    });

    const plan = buildImportPreparationPlan({
      session,
      draft,
      proposalBody: body,
      observations,
      references,
    });

    expect(plan.continuationDraft?.lines).toEqual(
      deferredLines.map((deferredLine) => ({
        ...deferredLine,
        amountCents: {
          "line-4500": 4500,
          "line-1890": 1890,
          "line-25000": 25000,
        }[deferredLine.id],
      })),
    );
    expect(plan.continuationDraft?.questions).toEqual(questions);
    expect(plan.continuationDraft?.declarations).toEqual(declarations);
    expect(plan.proposal.createdEconomicTotalCents).toBe(12345);
    expect(plan.proposal.invoiceDeltas).toEqual([
      { invoiceDueMonth: "2026-10", amountCents: 12345 },
    ]);
    expect(plan.proposal.auditItems).toEqual([
      {
        observationId: "obs-payment",
        outcome: "IGNORED",
        reason: "INVOICE_PAYMENT",
        title: "Pagamento de fatura",
        amountCents: -12000,
      },
    ]);
    expect(
      plan.continuationDraft?.lines.some(({ id }) => id === "line-payment"),
    ).toBe(false);
    expect(draft.lines.at(-1)?.amountCents).toBeNull();
    expect({ draft, proposalBody: body, observations, references }).toEqual(
      originalInput,
    );
  });

  it.each([
    {
      case: "minimum positive evidence",
      evidenceAmount: IMPORT_SESSION_PRIMITIVES.minPurchaseCents,
      existingAmount: null,
      grouped: false,
      expectedAmount: IMPORT_SESSION_PRIMITIVES.minPurchaseCents,
    },
    {
      case: "zero evidence below the purchase minimum",
      evidenceAmount: 0,
      existingAmount: null,
      grouped: false,
      expectedAmount: null,
    },
    {
      case: "negative evidence",
      evidenceAmount: -1,
      existingAmount: null,
      grouped: false,
      expectedAmount: null,
    },
    {
      case: "missing evidence amount",
      evidenceAmount: null,
      existingAmount: null,
      grouped: false,
      expectedAmount: null,
    },
    {
      case: "existing draft amount wins",
      evidenceAmount: 4500,
      existingAmount: 777,
      grouped: false,
      expectedAmount: 777,
    },
    {
      case: "grouped observations",
      evidenceAmount: 4500,
      existingAmount: null,
      grouped: true,
      expectedAmount: null,
    },
  ])(
    "enriches only an eligible single-observation deferred line: $case",
    ({ evidenceAmount, existingAmount, grouped, expectedAmount }) => {
      const observationIds = [
        "obs-deferred",
        ...(grouped ? ["obs-grouped"] : []),
      ];
      const deferredLine = {
        ...line("line-deferred", "obs-deferred"),
        observationIds,
        amountCents: existingAmount,
      };
      const draft: ImportSessionStoredDraftV1 = {
        version: 1,
        lines: [line("line-selected", "obs-selected"), deferredLine],
        selectedLineIds: ["line-selected"],
        questions: [],
        scope: {
          observationIds: ["obs-selected", ...observationIds],
          pendingAttachmentIds: [],
        },
      };

      const plan = buildImportPreparationPlan({
        session,
        draft,
        proposalBody: proposalBody(),
        observations: [
          observation("obs-selected"),
          observation("obs-deferred", "Deferred", evidenceAmount),
          ...(grouped ? [observation("obs-grouped", "Grouped", 2500)] : []),
        ],
        references: [reference()],
      });

      expect(plan.continuationDraft?.lines).toEqual([
        { ...deferredLine, amountCents: expectedAmount },
      ]);
    },
  );

  it("fails closed on an unsafe documentary amount without mutating the unresolved line", () => {
    const deferredLine = {
      ...line("line-deferred", "obs-deferred"),
      amountCents: null,
    };
    const draft: ImportSessionStoredDraftV1 = {
      version: 1,
      lines: [line("line-selected", "obs-selected"), deferredLine],
      selectedLineIds: ["line-selected"],
      questions: [],
      scope: {
        observationIds: ["obs-selected", "obs-deferred"],
        pendingAttachmentIds: [],
      },
    };
    const unsafeObservation = {
      ...observation("obs-deferred", "Deferred"),
      evidenceJson: evidence("Deferred", Number.MAX_SAFE_INTEGER + 1),
    };

    expect(() =>
      buildImportPreparationPlan({
        session,
        draft,
        proposalBody: proposalBody(),
        observations: [observation("obs-selected"), unsafeObservation],
        references: [reference()],
      }),
    ).toThrow(ImportSessionCorruptStateError);
    expect(deferredLine.amountCents).toBeNull();
  });

  it.each([
    { ready: 0, pendingAttachment: true, expectedSelected: 0 },
    { ready: 1, pendingAttachment: false, expectedSelected: 1 },
    {
      ready: IMPORT_SESSION_LIMITS.selectedLines,
      pendingAttachment: false,
      expectedSelected: IMPORT_SESSION_LIMITS.selectedLines,
    },
    {
      ready: IMPORT_SESSION_LIMITS.selectedLines + 1,
      pendingAttachment: false,
      expectedSelected: IMPORT_SESSION_LIMITS.selectedLines,
    },
  ])(
    "caps deterministic continuation selection at the protocol limit: %#",
    ({ ready, pendingAttachment, expectedSelected }) => {
      const remaining = Array.from({ length: ready }, (_, index) => ({
        lineId: `line-${String(index).padStart(2, "0")}`,
        observationId: `obs-${String(index).padStart(2, "0")}`,
      }));
      const draft: ImportSessionStoredDraftV1 = {
        version: 1,
        lines: [
          line("line-selected", "obs-selected"),
          ...remaining.map(({ lineId, observationId }) =>
            line(lineId, observationId),
          ),
        ],
        selectedLineIds: ["line-selected"],
        questions: [],
        scope: {
          observationIds: [
            "obs-selected",
            ...remaining.map(({ observationId }) => observationId),
          ],
          pendingAttachmentIds: pendingAttachment ? ["pending"] : [],
        },
      };
      const references = [reference()];
      if (pendingAttachment) {
        references.push({
          ref: {
            id: "pending",
            tenantId: "tenant",
            ownerProjectId: "owner",
            sessionId: "session",
            artifactId: "pending-artifact",
            position: 1,
            state: "ATTACHED",
            uploadGeneration: 1,
          },
          artifact: {
            id: "pending-artifact",
            tenantId: "tenant",
            ownerProjectId: "owner",
            documentSha256: "b".repeat(64),
            state: "RAW_READY",
          },
        });
      }

      const plan = buildImportPreparationPlan({
        session,
        draft,
        proposalBody: proposalBody(),
        observations: [
          observation("obs-selected"),
          ...remaining.map(({ observationId }) => observation(observationId)),
        ],
        references,
      });

      expect(plan.continuationDraft?.lines.map(({ id }) => id)).toEqual(
        remaining.map(({ lineId }) => lineId),
      );
      expect(plan.continuationDraft?.selectedLineIds).toEqual(
        remaining.slice(0, expectedSelected).map(({ lineId }) => lineId),
      );
    },
  );

  it("keeps Maria audit order and does not create a continuation when only terminal ignored evidence remains", () => {
    const ignored = [
      ["obs-payment-1", "PAGAMENTO EFETUADO", -101],
      ["obs-payment-2", "Pagamento PIX", -202],
      ["obs-payment-3", "PAGAMENTO DE FATURA", -303],
      ["obs-payment-4", "PGTO FAT", -404],
      ["obs-payment-5", "FATURA PAGA", -505],
    ] as const;
    const draft: ImportSessionStoredDraftV1 = {
      version: 1,
      lines: [line("line-selected", "obs-selected")],
      selectedLineIds: ["line-selected"],
      questions: [],
      scope: {
        observationIds: [
          "obs-selected",
          ...ignored.map(([observationId]) => observationId),
        ],
        pendingAttachmentIds: [],
      },
    };

    const plan = buildImportPreparationPlan({
      session,
      draft,
      proposalBody: proposalBody(),
      observations: [
        observation("obs-selected"),
        ...ignored.map(([id, title, amount]) => observation(id, title, amount)),
      ],
      references: [reference()],
    });

    expect(plan.proposal.auditItems).toEqual(
      ignored.map(([observationId, title, amountCents]) => ({
        observationId,
        outcome: "IGNORED",
        reason: "INVOICE_PAYMENT",
        title,
        amountCents,
      })),
    );
    expect(plan.proposal.deferredObservationIds).toEqual([]);
    expect(plan.continuationDraft).toBeNull();
    expect(plan.transferRefIds).toEqual([]);
  });

  it("parses historical proposal audit as empty and fails closed for malformed audit", () => {
    const draft: ImportSessionStoredDraftV1 = {
      version: 1,
      lines: [line("line-selected", "obs-selected")],
      selectedLineIds: ["line-selected"],
      questions: [],
      scope: {
        observationIds: ["obs-selected", "obs-payment"],
        pendingAttachmentIds: [],
      },
    };
    const proposal = buildImportPreparationPlan({
      session,
      draft,
      proposalBody: proposalBody(),
      observations: [
        observation("obs-selected"),
        observation("obs-payment", "Pagamento de fatura", -12000),
      ],
      references: [reference()],
    }).proposal;
    const historical = structuredClone(proposal) as unknown as Record<
      string,
      unknown
    >;
    delete historical.auditItems;
    expect(validateProposal(historical, session.id, null).auditItems).toEqual(
      [],
    );

    const item = proposal.auditItems[0];
    expect(item).toBeDefined();
    for (const auditItems of [
      [{ ...item!, outcome: "SKIPPED" }],
      [{ ...item!, reason: "OTHER" }],
      [{ ...item!, amountCents: 1 }],
      [{ ...item!, amountCents: Number.MAX_SAFE_INTEGER + 1 }],
      [{ ...item!, extra: true }],
      [item!, item!],
    ]) {
      expect(() =>
        validateProposal(
          { ...structuredClone(proposal), auditItems },
          session.id,
          null,
        ),
      ).toThrow(ImportSessionCorruptStateError);
    }
  });

  it("rejects aggregate cent overflow before an executable plan exists", () => {
    const max = IMPORT_SESSION_PRIMITIVES.maxCents;
    const maxSchedule = {
      version: 1 as const,
      occurrences: [
        {
          index: 0,
          data: "2026-10-10",
          valor: max,
          parcela: null,
          invoiceDueMonth: "2026-10",
        },
      ],
    };
    const maxLine = (
      lineId: string,
      observationId: string,
    ): ImportSessionDraftLineV1 => ({
      ...line(lineId, observationId),
      amountCents: max,
    });
    const draft: ImportSessionStoredDraftV1 = {
      version: 1,
      lines: [
        maxLine("line-selected", "obs-selected"),
        maxLine("line-second", "obs-second"),
      ],
      selectedLineIds: ["line-selected", "line-second"],
      questions: [],
      scope: {
        observationIds: ["obs-selected", "obs-second"],
        pendingAttachmentIds: [],
      },
    };
    const body: ProposalBody = {
      ...proposalBody(),
      lines: ["line-selected", "line-second"].map((lineId) => ({
        kind: "CREATE" as const,
        lineId,
        titulo: lineId,
        fornecedor: lineId,
        tipoDespesa: ExpenseType.OUTROS,
        categoriaMaoDeObra: null,
        dataCompra: "2026-10-10",
        totalCents: max,
        schedule: maxSchedule,
        targets: [],
      })),
      createdEconomicTotalCents: max * 2,
      invoiceDeltas: [{ invoiceDueMonth: "2026-10", amountCents: max * 2 }],
    };

    expect(() =>
      buildImportPreparationPlan({
        session,
        draft,
        proposalBody: body,
        observations: [
          observation("obs-selected", "selected", max),
          observation("obs-second", "second", max),
        ],
        references: [reference()],
      }),
    ).toThrow(ImportSessionCorruptStateError);
  });
});
