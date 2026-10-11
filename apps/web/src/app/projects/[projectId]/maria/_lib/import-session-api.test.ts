import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerImportDocumentaryQuestion,
  answerImportFocusedDraftQuestion,
  getImportResult,
  prepareImportSession,
  uploadImportSessionAttachment,
} from "./import-session-api";
import {
  assertWorkflowReceipt,
  ImportWorkflowResponseError,
  readImportWorkflowReceipt,
  readImportWorkflowView,
} from "./import-session-workflow-read";

const api = vi.hoisted(() => ({
  putBytes: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  get: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  api: {
    putBytes: api.putBytes,
    post: api.post,
    patch: api.patch,
    get: api.get,
  },
  ApiResponseError: class ApiResponseError extends Error {},
}));

const sourceAttachment = {
  id: "source",
  fileName: "original.csv",
  declaredBytes: 3,
  state: "ATTACHED",
  materializedInSession: true,
  canAnalyze: false,
};
const view = {
  version: 1,
  id: "session",
  ownerProjectId: "project",
  cardId: "card",
  state: "DRAFT",
  revision: 2,
  expiresAt: "2026-10-16T21:00:00.000Z",
  attachments: [sourceAttachment],
  lines: [],
  selectedLineIds: [],
  questions: [],
  declaredFacts: [],
  reviewBlockers: [],
  searchComplete: false,
  proposal: null,
  confirmation: null,
  receipt: null,
  actions: ["UPLOAD", "CANCEL"],
};

const appliedReceipt = {
  version: 1,
  sessionId: "session",
  financialRequestId: "12345678-1234-4123-8123-123456789abc",
  confirmedRevision: 2,
  proposalHash: "a".repeat(64),
  appliedAt: "2026-10-16T21:00:00.000Z",
  continuationSessionId: null,
  items: [
    {
      lineId: "line",
      outcome: "CREATED",
      sourceExpenseId: "expense",
      targetExpenseIds: [],
      allocationIds: [],
      cashFlowEntryIds: ["cash-flow"],
    },
  ],
  snapshot: {
    lines: [
      {
        lineId: "line",
        titulo: "Compra documental",
        dataCompra: "2026-10-10",
        totalCents: 12345,
        schedule: {
          version: 1,
          occurrences: [
            {
              index: 0,
              parcela: null,
              valor: 12345,
              data: "2026-11-10",
              invoiceDueMonth: "2026-11",
            },
          ],
        },
        sourceProjectId: "project",
        targets: [],
      },
    ],
    participantProjectIds: ["project"],
    createdEconomicTotalCents: 12345,
    bankCashDeltaCents: 0,
    invoiceDeltas: [{ invoiceDueMonth: "2026-11", amountCents: 12345 }],
  },
};
const auditItem = {
  observationId: "observation-payment",
  outcome: "IGNORED" as const,
  reason: "INVOICE_PAYMENT" as const,
  title: "Pagamento de fatura",
  amountCents: -12000,
};
const readyLine = {
  id: "line",
  observationIds: ["observation-purchase"],
  titulo: "Compra documental",
  fornecedor: null,
  tipoDespesa: "OUTROS",
  categoriaMaoDeObra: null,
  amountMeaning: "TOTAL_PURCHASE",
  amountCents: 12345,
  installmentCount: 1,
  dataCompra: "2026-10-10",
  firstDueDate: "2026-11-10",
  targets: [],
  decision: { kind: "CREATE", acceptNaturalDuplicate: false },
};
const readyProposal = {
  version: 1,
  kind: "CREATE_CARD_PURCHASES",
  sessionId: "session",
  revision: 2,
  proposalHash: "a".repeat(64),
  lines: [
    {
      kind: "CREATE",
      lineId: "line",
      titulo: "Compra documental",
      fornecedor: null,
      tipoDespesa: "OUTROS",
      categoriaMaoDeObra: null,
      dataCompra: "2026-10-10",
      totalCents: 12345,
      schedule: appliedReceipt.snapshot.lines[0].schedule,
      targets: [],
    },
  ],
  auditItems: [auditItem],
  deferredObservationIds: [],
  deferredAttachmentIds: [],
  retainUntil: null,
  createdEconomicTotalCents: 12345,
  bankCashDeltaCents: 0,
  invoiceDeltas: appliedReceipt.snapshot.invoiceDeltas,
};

describe("answerImportFocusedDraftQuestion", () => {
  const request = {
    version: 1 as const,
    answerRequestId: "12345678-1234-4123-8123-123456789abc",
    expectedRevision: 2,
    questionId: "question",
    channel: "VOICE" as const,
    answer: {
      field: "firstDueDate" as const,
      literal: "2025-10-10",
      value: "2025-10-10",
    },
  };
  beforeEach(() => api.patch.mockReset());
  it.each([
    {
      field: "decision" as const,
      value: {
        kind: "CREATE" as const,
        acceptNaturalDuplicate: false as const,
      },
    },
    {
      field: "targets" as const,
      value: { kind: "NO_TARGETS" as const },
    },
  ])(
    "PATCHes the exact native $field payload without adding replacement lines or waiver",
    async (answer) => {
      api.patch.mockResolvedValue(view);
      const signal = new AbortController().signal;
      const payload = { ...request, answer };
      await answerImportFocusedDraftQuestion("session", payload, signal);
      expect(api.patch).toHaveBeenCalledWith(
        "/import-sessions/session/draft",
        payload,
        {
          headers: { "x-rf-import-ui": "1" },
          signal,
        },
      );
      expect(Object.keys(api.patch.mock.calls[0][1]).sort()).toEqual([
        "answer",
        "answerRequestId",
        "channel",
        "expectedRevision",
        "questionId",
        "version",
      ]);
    },
  );
  it("PATCHes the exact focused variant with UI headers and signal", async () => {
    api.patch.mockResolvedValue(view);
    const signal = new AbortController().signal;
    expect(
      await answerImportFocusedDraftQuestion("session", request, signal),
    ).toEqual(view);
    expect(api.patch).toHaveBeenCalledWith(
      "/import-sessions/session/draft",
      request,
      {
        headers: { "x-rf-import-ui": "1" },
        signal,
      },
    );
  });
  it.each([
    { ...view, id: "foreign" },
    { ...view, extra: true },
  ])("rejects foreign or malformed views", async (response) => {
    api.patch.mockResolvedValue(response);
    await expect(
      answerImportFocusedDraftQuestion("session", request),
    ).rejects.toThrow();
  });
});

describe("answerImportDocumentaryQuestion", () => {
  const request = {
    version: 1 as const,
    answerRequestId: "12345678-1234-4123-8123-123456789abc",
    expectedRevision: 2,
    questionId: "question",
    channel: "TEXT" as const,
    input: { kind: "VALUE" as const, text: "  LOJA FICTICIA NORTE  " },
    answer: {
      field: "merchant" as const,
      value: "LOJA FICTICIA NORTE",
      meaningContext: null,
    },
  };
  beforeEach(() => api.post.mockReset());

  it("posts the exact preview contract with authenticated UI headers and signal", async () => {
    const signal = new AbortController().signal;
    api.post.mockResolvedValue(view);
    expect(
      await answerImportDocumentaryQuestion("session", request, signal),
    ).toEqual(view);
    expect(api.post).toHaveBeenCalledWith(
      "/import-sessions/session/documentary-answer",
      request,
      { headers: { "x-rf-import-ui": "1" }, signal },
    );
  });

  it.each([
    { ...view, id: "other" },
    { ...view, unexpected: true },
    { ...view, revision: null },
  ])("rejects foreign or malformed session views", async (response) => {
    api.post.mockResolvedValue(response);
    await expect(
      answerImportDocumentaryQuestion("session", request),
    ).rejects.toThrow();
  });
});

describe("direct review and result endpoints", () => {
  beforeEach(() => {
    api.post.mockReset();
    api.get.mockReset();
  });

  it("prepares the exact admitted revision and preserves the abort signal", async () => {
    const signal = new AbortController().signal;
    api.post.mockResolvedValue(view);
    await expect(
      prepareImportSession("session", { expectedRevision: 2 }, signal),
    ).resolves.toEqual(view);
    expect(api.post).toHaveBeenCalledWith(
      "/import-sessions/session/prepare",
      { expectedRevision: 2 },
      {
        headers: { "x-rf-import-ui": "1" },
        signal,
      },
    );
  });

  it("reads the result endpoint without routing through chat", async () => {
    const signal = new AbortController().signal;
    const result = { state: "READY", receipt: null };
    api.get.mockResolvedValue(result);
    await expect(getImportResult("session", signal)).resolves.toEqual(result);
    expect(api.get).toHaveBeenCalledWith("/import-sessions/session/result", {
      signal,
    });
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe("readImportWorkflowView analysisOutcome contract", () => {
  it("accepts historical views without adding analysisOutcome", () => {
    const result = readImportWorkflowView(view);

    expect(result).toEqual(view);
    expect(Object.hasOwn(result, "analysisOutcome")).toBe(false);
  });

  describe("readImportWorkflowReceipt audit contract", () => {
    it("accepts and retains an APPLIED receipt with terminal invoice-payment audit", () => {
      const receipt = {
        ...appliedReceipt,
        auditItems: [auditItem],
      };
      const parsed = readImportWorkflowView({
        ...view,
        state: "APPLIED",
        expiresAt: null,
        searchComplete: true,
        confirmation: {
          financialRequestId: appliedReceipt.financialRequestId,
          confirmedRevision: appliedReceipt.confirmedRevision,
          proposalHash: appliedReceipt.proposalHash,
        },
        receipt,
        actions: ["READ_RESULT"],
      });

      expect(parsed.receipt).toMatchObject({ auditItems: [auditItem] });
    });

    it("normalizes a historical audit-less receipt and accepts an empty audit list", () => {
      expect(
        readImportWorkflowReceipt(appliedReceipt, "project"),
      ).toMatchObject({ auditItems: [] });
      expect(
        readImportWorkflowReceipt(
          { ...appliedReceipt, auditItems: [] },
          "project",
        ),
      ).toMatchObject({ auditItems: [] });
      expect(
        readImportWorkflowReceipt(
          {
            ...appliedReceipt,
            auditItems: [{ ...auditItem, amountCents: null }],
          },
          "project",
        ),
      ).toMatchObject({
        auditItems: [{ ...auditItem, amountCents: null }],
      });
    });

    it.each([
      { ...auditItem, outcome: "CREATED" },
      { ...auditItem, reason: "UNKNOWN" },
      { ...auditItem, amountCents: 0 },
      { ...auditItem, amountCents: 12000 },
      { ...auditItem, amountCents: Number.MAX_SAFE_INTEGER },
      { ...auditItem, unexpected: true },
    ])("rejects malformed audit item %#", (malformed) => {
      expect(() =>
        readImportWorkflowReceipt(
          { ...appliedReceipt, auditItems: [malformed] },
          "project",
        ),
      ).toThrow(ImportWorkflowResponseError);
    });

    it("rejects duplicate audit observation identities and unknown receipt keys", () => {
      expect(() =>
        readImportWorkflowReceipt(
          { ...appliedReceipt, auditItems: [auditItem, { ...auditItem }] },
          "project",
        ),
      ).toThrow(ImportWorkflowResponseError);
      expect(() =>
        readImportWorkflowReceipt(
          {
            ...appliedReceipt,
            auditItems: [auditItem],
            unexpected: true,
          },
          "project",
        ),
      ).toThrow(ImportWorkflowResponseError);
    });
  });

  describe("readImportWorkflowView proposal audit contract", () => {
    const readyResponse = {
      ...view,
      state: "READY",
      lines: [readyLine],
      selectedLineIds: [readyLine.id],
      searchComplete: true,
      proposal: readyProposal,
      actions: ["CONFIRM", "CANCEL"],
    };

    it("accepts a financial proposal combined with terminal invoice-payment audit", () => {
      const parsed = readImportWorkflowView(readyResponse);

      expect(parsed.proposal).toMatchObject({
        lines: readyProposal.lines,
        auditItems: [auditItem],
      });
    });

    it("accepts matching proposal and receipt audit in the confirmed execution contract", () => {
      const confirmed = readImportWorkflowView({
        ...readyResponse,
        state: "CONFIRMED",
        confirmation: {
          financialRequestId: appliedReceipt.financialRequestId,
          confirmedRevision: appliedReceipt.confirmedRevision,
          proposalHash: appliedReceipt.proposalHash,
        },
        actions: ["EXECUTE"],
      });
      const receipt = readImportWorkflowReceipt(
        { ...appliedReceipt, auditItems: [auditItem] },
        "project",
      );

      expect(() => assertWorkflowReceipt(receipt, confirmed)).not.toThrow();
      expect(() =>
        assertWorkflowReceipt(
          {
            ...receipt,
            auditItems: [{ ...auditItem, observationId: "other-observation" }],
          },
          confirmed,
        ),
      ).toThrow(ImportWorkflowResponseError);
    });

    it("normalizes a historical proposal without auditItems", () => {
      const { auditItems: _auditItems, ...historicalProposal } = readyProposal;

      expect(
        readImportWorkflowView({
          ...readyResponse,
          proposal: historicalProposal,
        }).proposal,
      ).toMatchObject({ auditItems: [] });
    });

    it("rejects unknown proposal keys even with valid auditItems", () => {
      expect(() =>
        readImportWorkflowView({
          ...readyResponse,
          proposal: { ...readyProposal, unexpected: true },
        }),
      ).toThrow(ImportWorkflowResponseError);
    });

    it.each([
      { auditItems: [{ ...auditItem, outcome: "CREATED" }] },
      { auditItems: [{ ...auditItem, reason: "UNKNOWN" }] },
      { auditItems: [{ ...auditItem, unexpected: true }] },
      { auditItems: [auditItem, { ...auditItem }] },
    ])(
      "rejects malformed or duplicate proposal audit items %#",
      ({ auditItems }) => {
        expect(() =>
          readImportWorkflowView({
            ...readyResponse,
            proposal: { ...readyProposal, auditItems },
          }),
        ).toThrow(ImportWorkflowResponseError);
      },
    );
  });

  it.each([null, "NO_ELIGIBLE_PURCHASES"])(
    "accepts and preserves analysisOutcome %s",
    (analysisOutcome) => {
      const response = { ...view, analysisOutcome };

      expect(readImportWorkflowView(response)).toEqual(response);
    },
  );

  it.each([
    undefined,
    "",
    "UNKNOWN",
    "no_eligible_purchases",
    0,
    false,
    [],
    {},
    { kind: "NO_ELIGIBLE_PURCHASES" },
  ])("rejects invalid analysisOutcome %j", (analysisOutcome) => {
    expect(() => readImportWorkflowView({ ...view, analysisOutcome })).toThrow(
      ImportWorkflowResponseError,
    );
  });

  it("still rejects unknown keys with a valid analysisOutcome", () => {
    expect(() =>
      readImportWorkflowView({
        ...view,
        analysisOutcome: "NO_ELIGIBLE_PURCHASES",
        unexpected: true,
      }),
    ).toThrow(ImportWorkflowResponseError);
  });

  it("still validates required fields with a valid analysisOutcome", () => {
    expect(() =>
      readImportWorkflowView({
        ...view,
        analysisOutcome: null,
        searchComplete: null,
      }),
    ).toThrow(ImportWorkflowResponseError);
  });
});

describe("readImportWorkflowView declared fact channel contract", () => {
  const question = {
    id: "question-documentary",
    lineIds: [readyLine.id],
    field: "merchant",
    text: "Qual foi o estabelecimento?",
    subject: {
      kind: "OBSERVATION",
      observationId: "observation-purchase",
      meaningContext: null,
    },
    answerState: "DECLARED",
  };
  const declaredFact = {
    lineId: readyLine.id,
    observationId: question.subject.observationId,
    questionId: question.id,
    field: question.field,
    value: "LOJA FICTICIA NORTE",
    meaningContext: null,
    origin: "USER_ATTESTATION",
    status: "CURRENT",
  };
  const response = {
    ...view,
    lines: [readyLine],
    questions: [question],
    declaredFacts: [declaredFact],
  };

  it.each(["TEXT", "VOICE"])(
    "accepts and preserves canonical %s provenance",
    (channel) => {
      const candidate = {
        ...response,
        declaredFacts: [{ ...declaredFact, channel }],
      };

      expect(readImportWorkflowView(candidate)).toEqual(candidate);
    },
  );

  it("continues accepting historical facts without channel provenance", () => {
    expect(readImportWorkflowView(response)).toEqual(response);
  });

  it.each([
    ["an invalid channel", { ...declaredFact, channel: "EMAIL" }],
    ["an unknown extra key", { ...declaredFact, unexpected: true }],
  ])("rejects %s", (_case, malformedFact) => {
    expect(() =>
      readImportWorkflowView({
        ...response,
        declaredFacts: [malformedFact],
      }),
    ).toThrow(ImportWorkflowResponseError);
  });
});

describe("uploadImportSessionAttachment response validation", () => {
  beforeEach(() => api.putBytes.mockReset());

  it("accepts a normal attached upload view", async () => {
    api.putBytes.mockResolvedValue({
      ...view,
      attachments: [
        sourceAttachment,
        {
          id: "requested",
          fileName: "renamed.csv",
          declaredBytes: 3,
          state: "ATTACHED",
          materializedInSession: false,
          canAnalyze: false,
        },
      ],
    });

    await expect(
      uploadImportSessionAttachment("session", "requested", new Blob(["csv"])),
    ).resolves.toEqual({
      ...view,
      attachments: [
        sourceAttachment,
        {
          id: "requested",
          fileName: "renamed.csv",
          declaredBytes: 3,
          state: "ATTACHED",
          materializedInSession: false,
          canAnalyze: false,
        },
      ],
    });
  });

  it("accepts explicit deduplication for the requested attachment and returns its view", async () => {
    api.putBytes.mockResolvedValue({
      kind: "DEDUPLICATED",
      attachmentId: "requested",
      view,
    });

    await expect(
      uploadImportSessionAttachment("session", "requested", new Blob(["csv"])),
    ).resolves.toEqual({
      kind: "DEDUPLICATED",
      attachmentId: "requested",
      view,
    });
  });

  it.each([
    [
      "a different attachment ID",
      { kind: "DEDUPLICATED", attachmentId: "other", view },
    ],
    [
      "a response view for another session",
      {
        kind: "DEDUPLICATED",
        attachmentId: "requested",
        view: { ...view, id: "other-session" },
      },
    ],
    ["a missing view", { kind: "DEDUPLICATED", attachmentId: "requested" }],
    [
      "a malformed projected view",
      {
        kind: "DEDUPLICATED",
        attachmentId: "requested",
        view: { ...view, unexpected: true },
      },
    ],
    [
      "an unrecognized response shape",
      { kind: "DEDUPLICATED", attachmentId: "requested", view, extra: true },
    ],
  ])("rejects %s", async (_description, response) => {
    api.putBytes.mockResolvedValue(response);

    await expect(
      uploadImportSessionAttachment("session", "requested", new Blob(["csv"])),
    ).rejects.toThrow();
  });
});
