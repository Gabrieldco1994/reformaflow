require("../../../../../scripts/test-db-env.cjs");

import {
  ExpenseType,
  LaborCategory,
  ProjectType,
  type ImportSessionStoredDraftV1,
} from "@reformaflow/domain";
import type { Prisma } from "@prisma/client";
import type { ImportActor } from "./import-session.auth";
import type { StoredImportSearchV1 } from "./card-purchase-batch.port";
import {
  buildGuidedReviewAuthority,
  recordDraftFieldProvenance,
  selectServerReadyLines,
} from "./import-guided-review";
import { validateStoredDraft } from "./import-session.validation";

const actor: ImportActor = {
  tenantId: "tenant-a",
  userId: "user-a",
  role: "USER",
  allowedModules: ["expenses"],
  allowedProjects: ["personal", "reforma-a"],
  allowedProjectTypes: [ProjectType.PESSOAL, ProjectType.REFORMA],
};

function draft(): ImportSessionStoredDraftV1 {
  return {
    version: 1,
    lines: [
      {
        id: "line-a",
        observationIds: ["obs-a"],
        titulo: "Loja sem id no rótulo",
        fornecedor: "Loja A",
        tipoDespesa: null,
        categoriaMaoDeObra: null,
        amountMeaning: "TOTAL_PURCHASE",
        amountCents: 10_001,
        installmentCount: 1,
        dataCompra: "2026-10-01",
        firstDueDate: "2026-11-10",
        targets: null,
        decision: { kind: "UNRESOLVED" },
      },
      {
        id: "line-b",
        observationIds: ["obs-b"],
        titulo: "Segunda compra",
        fornecedor: "Loja B",
        tipoDespesa: null,
        categoriaMaoDeObra: null,
        amountMeaning: "TOTAL_PURCHASE",
        amountCents: 20_002,
        installmentCount: 1,
        dataCompra: "2026-10-02",
        firstDueDate: "2026-11-10",
        targets: null,
        decision: { kind: "UNRESOLVED" },
      },
    ],
    selectedLineIds: ["line-a", "line-b"],
    questions: [
      {
        id: "q-b-target",
        lineIds: ["line-b"],
        field: "targets",
        text: "Destino B?",
      },
      {
        id: "q-a-type",
        lineIds: ["line-a"],
        field: "tipoDespesa",
        text: "Tipo A?",
      },
      {
        id: "q-a-target",
        lineIds: ["line-a"],
        field: "targets",
        text: "Destino A?",
      },
      {
        id: "q-a-decision",
        lineIds: ["line-a"],
        field: "decision",
        text: "Criar A?",
      },
    ],
    scope: {
      observationIds: ["obs-a", "obs-b"],
      pendingAttachmentIds: [],
    },
  };
}

const search: StoredImportSearchV1 = {
  version: 1,
  revision: 7,
  complete: true,
  candidates: [
    {
      lineId: "line-a",
      kind: "EXPENSE",
      id: "expense-visible",
      reason: "NATURAL_MATCH",
    },
    {
      lineId: "line-a",
      kind: "EXPENSE",
      id: "expense-cross-tenant",
      reason: "NATURAL_MATCH",
    },
  ],
  coverage: {
    recipe: "CARD_PURCHASE_V1",
    inputHash: "a".repeat(64),
    steps: [],
  },
};

function transaction() {
  return {
    project: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: "personal",
          tenantId: actor.tenantId,
          type: ProjectType.PESSOAL,
          name: "Minhas finanças",
          deletedAt: null,
        },
        {
          id: "reforma-a",
          tenantId: actor.tenantId,
          type: ProjectType.REFORMA,
          name: "Cozinha nova",
          deletedAt: null,
        },
      ]),
    },
    room: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: "room-a",
          projectId: "reforma-a",
          name: "Cozinha",
          deletedAt: null,
        },
      ]),
    },
    expense: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: "expense-visible",
          tenantId: actor.tenantId,
          projectId: "personal",
          titulo: "Compra já lançada",
          fornecedor: "Loja A",
          valorTotal: 10_001,
          dataCompra: new Date("2026-10-01T00:00:00.000Z"),
          deletedAt: null,
        },
      ]),
    },
  } as unknown as Prisma.TransactionClient;
}

describe("server-owned guided review authority", () => {
  it("orders line-first decision -> targets -> expense type and emits only authorized human labels", async () => {
    const authority = await buildGuidedReviewAuthority(
      transaction(),
      actor,
      "personal",
      draft(),
      search,
      7,
      false,
    );

    expect(authority.review.progress).toBe("ANSWERING");
    expect(authority.review.focus).toMatchObject({
      questionId: "q-a-decision",
      lineId: "line-a",
      control: "DECISION",
      prompt: "Criar A?",
      purchaseOrdinal: 1,
      purchaseTotal: 2,
      questionOrdinal: 1,
      questionTotal: 3,
    });
    expect(Object.keys(authority.review.focus ?? {}).sort()).toEqual(
      [
        "questionId",
        "lineId",
        "control",
        "prompt",
        "purchaseOrdinal",
        "purchaseTotal",
        "questionOrdinal",
        "questionTotal",
        "context",
        "options",
      ].sort(),
    );
    expect(authority.review.actions).toEqual(["CONTINUE_ANSWERING"]);
    expect(authority.review.focus?.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Criar mesmo assim",
          answer: {
            kind: "DECISION",
            value: { kind: "CREATE", acceptNaturalDuplicate: true },
          },
        }),
        expect.objectContaining({
          label: expect.stringContaining("Compra já lançada"),
          answer: {
            kind: "DECISION",
            value: {
              kind: "KEEP_EXISTING",
              expenseId: "expense-visible",
            },
          },
        }),
        expect.objectContaining({
          label: "Não importar esta compra",
          answer: { kind: "DECISION", value: { kind: "EXCLUDE" } },
        }),
      ]),
    );
    expect(
      authority.review.focus?.options.filter(
        (option) =>
          option.answer.kind === "DECISION" &&
          option.answer.value.kind === "CREATE",
      ),
    ).toHaveLength(1);
    const wire = JSON.stringify(authority.review);
    expect(wire).not.toContain("expense-cross-tenant");
    expect(wire).not.toContain("fieldProvenance");
    expect(wire).not.toContain("provenance");
    expect(wire).not.toContain("projectLabel");
    expect(wire).not.toContain("roomLabel");
    expect(authority.review).not.toHaveProperty("version");
    expect(authority.review.focus).not.toHaveProperty("question");
    expect(authority.review.focus).not.toHaveProperty("line");
    for (const option of authority.review.focus?.options ?? [])
      expect(option.label).not.toContain("expense-visible");

    const keepVisible = draft();
    keepVisible.lines[0]!.decision = {
      kind: "KEEP_EXISTING",
      expenseId: "expense-visible",
    };
    const visibleAuthority = await buildGuidedReviewAuthority(
      transaction(),
      actor,
      "personal",
      keepVisible,
      search,
      7,
      false,
    );
    expect(() => visibleAuthority.assertReadyLine("line-a")).not.toThrow();

    const keepHidden = draft();
    keepHidden.lines[0]!.decision = {
      kind: "KEEP_EXISTING",
      expenseId: "expense-cross-tenant",
    };
    const hiddenAuthority = await buildGuidedReviewAuthority(
      transaction(),
      actor,
      "personal",
      keepHidden,
      search,
      7,
      false,
    );
    expect(() => hiddenAuthority.assertReadyLine("line-a")).toThrow();
  });

  it("authorizes only [] or one integral active REFORMA target and current room", async () => {
    const authority = await buildGuidedReviewAuthority(
      transaction(),
      actor,
      "personal",
      draft(),
      search,
      7,
      false,
    );

    await expect(
      authority.assertAnswer("q-a-target", {
        kind: "TARGETS",
        value: [],
      }),
    ).resolves.toBeUndefined();
    const targetInput = draft();
    targetInput.questions = targetInput.questions.filter(
      (question) => question.id === "q-a-target",
    );
    const targets = await buildGuidedReviewAuthority(
      transaction(),
      actor,
      "personal",
      targetInput,
      search,
      7,
      false,
    );
    expect(targets.review.focus?.options).toEqual(
      expect.arrayContaining([
        {
          label: "Somente em Minhas finanças",
          answer: { kind: "TARGETS", value: [] },
        },
        {
          label: "Cozinha nova",
          answer: {
            kind: "TARGETS",
            value: [
              {
                projectId: "reforma-a",
                roomId: null,
                amountCents: 10_001,
              },
            ],
          },
        },
        {
          label: "Cozinha nova · Cozinha",
          answer: {
            kind: "TARGETS",
            value: [
              {
                projectId: "reforma-a",
                roomId: "room-a",
                amountCents: 10_001,
              },
            ],
          },
        },
      ]),
    );
    await expect(
      authority.assertAnswer("q-a-target", {
        kind: "TARGETS",
        value: [
          {
            projectId: "reforma-a",
            roomId: null,
            amountCents: 10_001,
            projectLabel: "browser-owned",
          },
        ],
      } as never),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      authority.assertAnswer("q-a-target", {
        kind: "TARGETS",
        value: [
          {
            projectId: "reforma-a",
            roomId: "room-a",
            amountCents: 10_001,
          },
        ],
      }),
    ).resolves.toBeUndefined();
    for (const value of [
      [
        {
          projectId: "reforma-a",
          roomId: null,
          amountCents: 0,
        },
      ],
      [
        {
          projectId: "reforma-a",
          roomId: null,
          amountCents: -1,
        },
      ],
      [
        {
          projectId: "reforma-a",
          roomId: null,
          amountCents: 10_000,
        },
      ],
      [
        {
          projectId: "reforma-a",
          roomId: null,
          amountCents: 10_000.5,
        },
      ],
      [
        {
          projectId: "personal",
          roomId: null,
          amountCents: 10_001,
        },
      ],
      [
        {
          projectId: "reforma-revoked",
          roomId: null,
          amountCents: 10_001,
        },
      ],
      [
        {
          projectId: "reforma-a",
          roomId: "room-from-another-project",
          amountCents: 10_001,
        },
      ],
      [
        {
          projectId: "reforma-a",
          roomId: null,
          amountCents: 10_001,
        },
        {
          projectId: "reforma-a",
          roomId: null,
          amountCents: 10_001,
        },
      ],
    ]) {
      await expect(
        authority.assertAnswer("q-a-target", {
          kind: "TARGETS",
          value,
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
  });

  it("uses canonical target taxonomy and asks labor category only for labor", async () => {
    const input = draft();
    input.lines[0]!.decision = {
      kind: "CREATE",
      acceptNaturalDuplicate: false,
    };
    input.lines[0]!.targets = [
      {
        projectId: "reforma-a",
        roomId: null,
        amountCents: 10_001,
      },
    ];
    input.questions = [
      {
        id: "q-a-type",
        lineIds: ["line-a"],
        field: "tipoDespesa",
        text: "Tipo A?",
      },
    ];
    const authority = await buildGuidedReviewAuthority(
      transaction(),
      actor,
      "personal",
      input,
      search,
      7,
      false,
    );
    expect(authority.review.focus?.control).toBe("EXPENSE_TYPE");
    expect(authority.review.focus?.options).toContainEqual({
      label: "Mão de Obra",
      answer: { kind: "EXPENSE_TYPE", value: ExpenseType.MAO_DE_OBRA },
    });
    expect(authority.review.focus?.options).not.toContainEqual(
      expect.objectContaining({
        answer: { kind: "EXPENSE_TYPE", value: ExpenseType.ALIMENTACAO },
      }),
    );
    await expect(
      authority.assertAnswer("q-a-type", {
        kind: "EXPENSE_TYPE",
        value: ExpenseType.ALIMENTACAO,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    input.lines[0]!.tipoDespesa = ExpenseType.MAO_DE_OBRA;
    input.questions = [
      {
        id: "q-a-labor",
        lineIds: ["line-a"],
        field: "categoriaMaoDeObra",
        text: "Categoria?",
      },
    ];
    const labor = await buildGuidedReviewAuthority(
      transaction(),
      actor,
      "personal",
      input,
      search,
      8,
      false,
    );
    expect(labor.review.focus?.control).toBe("LABOR_CATEGORY");
    expect(labor.review.focus?.options).toContainEqual({
      label: "Eletricista",
      answer: {
        kind: "LABOR_CATEGORY",
        value: LaborCategory.ELETRICISTA,
      },
    });
    await expect(
      labor.assertAnswer("q-a-labor", {
        kind: "LABOR_CATEGORY",
        value: null,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      labor.assertAnswer("q-a-labor", {
        kind: "EXPENSE_TYPE",
        value: ExpenseType.MAO_DE_OBRA,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    input.lines[0]!.tipoDespesa = ExpenseType.MATERIAL_CONSTRUCAO;
    const notLabor = await buildGuidedReviewAuthority(
      transaction(),
      actor,
      "personal",
      input,
      search,
      9,
      false,
    );
    expect(notLabor.review.focus).toBeNull();
  });

  it("persists exact provenance and clears it on reset/remove", () => {
    const input = draft();
    const recorded = recordDraftFieldProvenance(
      input,
      ["line-a"],
      "targets",
      "USER",
      8,
    );
    expect(recorded.fieldProvenance).toEqual([
      {
        origin: "USER",
        lineId: "line-a",
        field: "targets",
        recordedRevision: 8,
      },
    ]);
    const reloaded = validateStoredDraft(
      JSON.parse(JSON.stringify(recorded)) as unknown,
    );
    expect(reloaded.fieldProvenance).toEqual(recorded.fieldProvenance);
    expect(
      recordDraftFieldProvenance(reloaded, ["line-a"], "targets", null, 9)
        .fieldProvenance,
    ).toEqual([]);
  });

  it("computes question position from persisted questions and provenance", async () => {
    const input = draft();
    input.questions = input.questions.filter(
      (question) => question.id !== "q-a-decision",
    );
    input.fieldProvenance = [
      {
        origin: "USER",
        lineId: "line-a",
        field: "decision",
        recordedRevision: 7,
      },
    ];

    const authority = await buildGuidedReviewAuthority(
      transaction(),
      actor,
      "personal",
      input,
      search,
      7,
      false,
    );

    expect(authority.review.focus).toMatchObject({
      questionId: "q-a-target",
      purchaseOrdinal: 1,
      purchaseTotal: 2,
      questionOrdinal: 2,
      questionTotal: 3,
    });
    expect(JSON.stringify(authority.review)).not.toContain("fieldProvenance");
    expect(JSON.stringify(authority.review)).not.toContain("USER");
  });

  it("numbers only physical purchases while retaining ignored invoice evidence", async () => {
    const input = draft();
    const firstPurchase = {
      ...input.lines[0]!,
      id: "line-purchase-a",
      observationIds: ["obs-purchase-a"],
    };
    const ignoredInvoicePayment = {
      ...input.lines[0]!,
      id: "line-invoice-payment",
      observationIds: ["obs-invoice-payment"],
      targets: [],
      decision: {
        kind: "IGNORED_POLICY" as const,
        reason: "INVOICE_PAYMENT" as const,
        policyVersion: 1 as const,
      },
    };
    const secondPurchase = {
      ...input.lines[1]!,
      id: "line-purchase-b",
      observationIds: ["obs-purchase-b"],
    };
    const thirdPurchase = {
      ...input.lines[1]!,
      id: "line-purchase-c",
      observationIds: ["obs-purchase-c"],
    };
    input.lines = [
      ignoredInvoicePayment,
      firstPurchase,
      secondPurchase,
      thirdPurchase,
    ];
    input.selectedLineIds = [
      firstPurchase.id,
      secondPurchase.id,
      thirdPurchase.id,
    ];
    input.questions = [firstPurchase, secondPurchase, thirdPurchase].map(
      (line) => ({
        id: `q-${line.id}-decision`,
        lineIds: [line.id],
        field: "decision" as const,
        text: `Criar ${line.id}?`,
      }),
    );
    input.scope.observationIds = input.lines.flatMap(
      (line) => line.observationIds,
    );

    for (const [index, line] of [
      firstPurchase,
      secondPurchase,
      thirdPurchase,
    ].entries()) {
      input.selectedLineIds = [line.id];
      const authority = await buildGuidedReviewAuthority(
        transaction(),
        actor,
        "personal",
        input,
        { ...search, candidates: [] },
        7,
        false,
      );

      expect(authority.review.focus).toMatchObject({
        lineId: line.id,
        purchaseOrdinal: index + 1,
        purchaseTotal: 3,
      });
    }

    expect(
      input.lines.find((line) => line.id === ignoredInvoicePayment.id),
    ).toEqual(ignoredInvoicePayment);
    expect(input.scope.observationIds).toContain("obs-invoice-payment");
  });

  it("expands the applicable question total when labor becomes applicable", async () => {
    const input = draft();
    input.lines = [input.lines[0]!];
    input.selectedLineIds = ["line-a"];
    input.scope.observationIds = ["obs-a"];
    input.questions = [
      {
        id: "q-a-decision",
        lineIds: ["line-a"],
        field: "decision",
        text: "Criar A?",
      },
      {
        id: "q-a-target",
        lineIds: ["line-a"],
        field: "targets",
        text: "Destino A?",
      },
      {
        id: "q-a-type",
        lineIds: ["line-a"],
        field: "tipoDespesa",
        text: "Tipo A?",
      },
      {
        id: "q-a-labor",
        lineIds: ["line-a"],
        field: "categoriaMaoDeObra",
        text: "Categoria A?",
      },
    ];

    const initial = await buildGuidedReviewAuthority(
      transaction(),
      actor,
      "personal",
      input,
      { ...search, candidates: [] },
      7,
      false,
    );
    expect(initial.review.focus).toMatchObject({
      questionId: "q-a-decision",
      questionOrdinal: 1,
      questionTotal: 3,
    });

    input.lines[0]!.decision = {
      kind: "CREATE",
      acceptNaturalDuplicate: false,
    };
    input.lines[0]!.targets = [];
    input.lines[0]!.tipoDespesa = ExpenseType.MAO_DE_OBRA;
    input.questions = input.questions.filter(
      (question) => question.id === "q-a-labor",
    );
    input.fieldProvenance = [
      {
        origin: "USER",
        lineId: "line-a",
        field: "decision",
        recordedRevision: 8,
      },
      {
        origin: "USER",
        lineId: "line-a",
        field: "targets",
        recordedRevision: 8,
      },
      {
        origin: "USER",
        lineId: "line-a",
        field: "tipoDespesa",
        recordedRevision: 8,
      },
    ];

    const labor = await buildGuidedReviewAuthority(
      transaction(),
      actor,
      "personal",
      input,
      null,
      8,
      false,
    );
    expect(labor.review.focus).toMatchObject({
      questionId: "q-a-labor",
      questionOrdinal: 4,
      questionTotal: 4,
    });
  });

  it("keeps natural-duplicate CREATE overrides scoped to the matching twin", async () => {
    const input = draft();
    input.lines[1] = {
      ...input.lines[0]!,
      id: "line-b",
      observationIds: ["obs-b"],
    };
    input.questions = [
      {
        id: "q-a-decision",
        lineIds: ["line-a"],
        field: "decision",
        text: "Criar A?",
      },
      {
        id: "q-b-decision",
        lineIds: ["line-b"],
        field: "decision",
        text: "Criar B?",
      },
    ];
    const twinSearch: StoredImportSearchV1 = {
      ...search,
      candidates: [
        {
          lineId: "line-b",
          kind: "EXPENSE",
          id: "expense-visible",
          reason: "NATURAL_MATCH",
        },
      ],
    };

    input.selectedLineIds = ["line-a"];
    const first = await buildGuidedReviewAuthority(
      transaction(),
      actor,
      "personal",
      input,
      twinSearch,
      7,
      false,
    );
    const createFirst = first.review.focus?.options.find(
      (option) =>
        option.answer.kind === "DECISION" &&
        option.answer.value.kind === "CREATE",
    );
    expect(createFirst?.answer).toEqual({
      kind: "DECISION",
      value: { kind: "CREATE", acceptNaturalDuplicate: false },
    });
    await expect(
      first.assertAnswer("q-a-decision", {
        kind: "DECISION",
        value: { kind: "CREATE", acceptNaturalDuplicate: true },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });

    input.selectedLineIds = ["line-b"];
    const second = await buildGuidedReviewAuthority(
      transaction(),
      actor,
      "personal",
      input,
      twinSearch,
      7,
      false,
    );
    const createSecond = second.review.focus?.options.find(
      (option) =>
        option.answer.kind === "DECISION" &&
        option.answer.value.kind === "CREATE",
    );
    expect(createSecond?.answer).toEqual({
      kind: "DECISION",
      value: { kind: "CREATE", acceptNaturalDuplicate: true },
    });
    await expect(
      second.assertAnswer("q-b-decision", {
        kind: "DECISION",
        value: { kind: "CREATE", acceptNaturalDuplicate: false },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      second.assertAnswer("q-b-decision", {
        kind: "DECISION",
        value: { kind: "CREATE", acceptNaturalDuplicate: true },
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["missing", null],
    ["incomplete", { ...search, complete: false }],
  ] as const)(
    "withholds DECISION authority while stored search is %s",
    async (_scenario, storedSearch) => {
      const input = draft();
      input.selectedLineIds = ["line-a"];
      input.questions = [
        {
          id: "q-a-decision",
          lineIds: ["line-a"],
          field: "decision",
          text: "Criar A?",
        },
      ];

      for (const proposalReady of [false, true]) {
        const authority = await buildGuidedReviewAuthority(
          transaction(),
          actor,
          "personal",
          input,
          storedSearch,
          7,
          proposalReady,
        );

        expect(authority.review).toEqual({
          progress: "ANSWERING",
          focus: null,
          actions: ["CONTINUE_ANSWERING"],
        });
        for (const value of [
          { kind: "CREATE", acceptNaturalDuplicate: false },
          { kind: "CREATE", acceptNaturalDuplicate: true },
          { kind: "EXCLUDE" },
        ] as const) {
          await expect(
            authority.assertAnswer("q-a-decision", {
              kind: "DECISION",
              value,
            }),
          ).rejects.toMatchObject({ code: "INVALID_INPUT" });
        }
      }
    },
  );

  it("uses only a complete line-scoped persisted natural match for the duplicate flag", async () => {
    const input = draft();
    input.lines[1] = {
      ...input.lines[0]!,
      id: "line-b",
      observationIds: ["obs-b"],
    };
    input.selectedLineIds = ["line-a"];
    input.questions = [
      {
        id: "q-a-decision",
        lineIds: ["line-a"],
        field: "decision",
        text: "Criar A?",
      },
    ];

    const authority = await buildGuidedReviewAuthority(
      transaction(),
      actor,
      "personal",
      input,
      { ...search, candidates: [] },
      7,
      false,
    );

    expect(
      authority.review.focus?.options.find(
        (option) =>
          option.answer.kind === "DECISION" &&
          option.answer.value.kind === "CREATE",
      )?.answer,
    ).toEqual({
      kind: "DECISION",
      value: { kind: "CREATE", acceptNaturalDuplicate: false },
    });
  });

  it("allows null focus except that READY always requires it", async () => {
    const input = draft();
    input.questions = [];

    const answering = await buildGuidedReviewAuthority(
      transaction(),
      actor,
      "personal",
      input,
      search,
      7,
      false,
    );
    expect(answering.review).toMatchObject({
      progress: "ANSWERING",
      focus: null,
      actions: ["CONTINUE_ANSWERING"],
    });

    const pending = await buildGuidedReviewAuthority(
      transaction(),
      actor,
      "personal",
      input,
      search,
      7,
      true,
      undefined,
      true,
    );
    expect(pending.review).toMatchObject({
      progress: "READY_WITH_PENDING",
      focus: null,
      actions: ["CONTINUE_ANSWERING", "REVIEW_READY"],
    });

    const readyInput = draft();
    readyInput.questions = [];
    readyInput.lines = [readyInput.lines[0]!];
    readyInput.selectedLineIds = ["line-a"];
    readyInput.scope.observationIds = ["obs-a"];
    const ready = await buildGuidedReviewAuthority(
      transaction(),
      actor,
      "personal",
      readyInput,
      search,
      7,
      true,
    );
    expect(ready.review).toEqual({
      progress: "READY",
      focus: null,
      actions: ["REVIEW_READY"],
    });
  });

  it("selects the ready subset on the server and distinguishes zero/partial readiness", () => {
    const input = draft();
    expect(selectServerReadyLines(input, [])).toMatchObject({
      readyLineIds: [],
      progress: "ANSWERING",
    });
    expect(selectServerReadyLines(input, ["line-a"])).toEqual({
      readyLineIds: ["line-a"],
      hasRemainingWork: true,
      progress: "READY_WITH_PENDING",
    });
    expect(selectServerReadyLines(input, ["line-a", "line-b"])).toEqual({
      readyLineIds: ["line-a", "line-b"],
      hasRemainingWork: false,
      progress: "READY",
    });
  });

  it("preserves a deferred question but focuses the next selected line", async () => {
    const input = draft();
    input.selectedLineIds = ["line-b"];
    input.lines[0]!.decision = { kind: "DEFER" };
    input.lines[0]!.targets = [];

    const authority = await buildGuidedReviewAuthority(
      transaction(),
      actor,
      "personal",
      input,
      search,
      7,
      false,
    );

    expect(
      input.questions.some((question) => question.id === "q-a-decision"),
    ).toBe(true);
    expect(authority.review.focus).toMatchObject({
      questionId: "q-b-target",
      lineId: "line-b",
    });
  });

  it("offers KEEP only for the owner PESSOAL source, never its REFORMA mirror", async () => {
    const input = draft();
    input.lines[0]!.decision = { kind: "UNRESOLVED" };
    input.questions = [
      {
        id: "q-a-decision",
        lineIds: ["line-a"],
        field: "decision",
        text: "Criar A?",
      },
    ];
    const duplicateSearch: StoredImportSearchV1 = {
      ...search,
      candidates: [
        {
          lineId: "line-a",
          kind: "EXPENSE",
          id: "source-personal",
          reason: "INSTALLMENT_MATCH",
        },
        {
          lineId: "line-a",
          kind: "EXPENSE",
          id: "mirror-reforma",
          reason: "INSTALLMENT_MATCH",
        },
      ],
    };
    const authority = await buildGuidedReviewAuthority(
      transaction(),
      actor,
      "personal",
      input,
      duplicateSearch,
      7,
      false,
      {
        projects: [
          { id: "personal", type: ProjectType.PESSOAL, name: "Pessoal" },
          {
            id: "reforma-a",
            type: ProjectType.REFORMA,
            name: "Reforma",
          },
        ],
        rooms: [],
        duplicateCandidates: [
          { id: "source-personal", kind: "EXPENSE" },
          { id: "mirror-reforma", kind: "EXPENSE" },
        ],
        candidates: [
          {
            id: "source-personal",
            projectId: "personal",
            titulo: "Compra",
            fornecedor: "Loja",
            valorTotal: 10_001,
            dataCompra: new Date("2026-10-01T00:00:00.000Z"),
          },
          {
            id: "mirror-reforma",
            projectId: "reforma-a",
            titulo: "Compra",
            fornecedor: "Loja",
            valorTotal: 10_001,
            dataCompra: new Date("2026-10-01T00:00:00.000Z"),
          },
        ],
      },
    );

    const keepIds = authority.review.focus?.options.flatMap((option) =>
      option.answer.kind === "DECISION" &&
      option.answer.value.kind === "KEEP_EXISTING"
        ? [option.answer.value.expenseId]
        : [],
    );
    expect(keepIds).toEqual(["source-personal"]);
    expect(() => authority.assertReadyLine("line-a")).toThrow();
  });

  it("disambiguates duplicate target and candidate labels without exposing ids", async () => {
    const input = draft();
    input.questions = input.questions.filter(
      (question) =>
        question.id === "q-a-target" || question.id === "q-a-decision",
    );
    const duplicateSearch: StoredImportSearchV1 = {
      ...search,
      candidates: [
        {
          lineId: "line-a",
          kind: "EXPENSE",
          id: "candidate-a",
          reason: "NATURAL_MATCH",
        },
        {
          lineId: "line-a",
          kind: "EXPENSE",
          id: "candidate-b",
          reason: "NATURAL_MATCH",
        },
      ],
    };
    const catalog = {
      projects: [
        { id: "personal", type: ProjectType.PESSOAL, name: "PESSOAL" },
        { id: "reforma-a", type: ProjectType.REFORMA, name: "OBRA" },
        { id: "reforma-b", type: ProjectType.REFORMA, name: "OBRA" },
      ],
      rooms: [
        { id: "room-a", projectId: "reforma-a", name: "SALA" },
        { id: "room-b", projectId: "reforma-b", name: "SALA" },
      ],
      duplicateCandidates: [
        { id: "candidate-a", kind: "EXPENSE" as const },
        { id: "candidate-b", kind: "EXPENSE" as const },
      ],
      candidates: [
        {
          id: "candidate-a",
          projectId: "personal",
          titulo: "COMPRA",
          fornecedor: "LOJA",
          valorTotal: 10_001,
          dataCompra: new Date("2026-10-01T00:00:00.000Z"),
        },
        {
          id: "candidate-b",
          projectId: "personal",
          titulo: "COMPRA",
          fornecedor: "LOJA",
          valorTotal: 10_001,
          dataCompra: new Date("2026-10-01T00:00:00.000Z"),
        },
      ],
    };
    const duplicateActor: ImportActor = {
      ...actor,
      allowedProjects: ["personal", "reforma-a", "reforma-b"],
    };
    const duplicateTransaction = {
      project: {
        findMany: jest.fn().mockResolvedValue(
          catalog.projects.map((project) => ({
            ...project,
            tenantId: actor.tenantId,
            deletedAt: null,
          })),
        ),
      },
      room: {
        findMany: jest
          .fn()
          .mockResolvedValue(
            catalog.rooms.map((room) => ({ ...room, deletedAt: null })),
          ),
      },
      expense: {
        findMany: jest.fn().mockResolvedValue(
          catalog.candidates.map((candidate) => ({
            ...candidate,
            tenantId: actor.tenantId,
            deletedAt: null,
          })),
        ),
      },
    } as unknown as Prisma.TransactionClient;
    const decision = await buildGuidedReviewAuthority(
      duplicateTransaction,
      duplicateActor,
      "personal",
      input,
      duplicateSearch,
      7,
      false,
      catalog,
    );
    const decisionLabels =
      decision.review.focus?.options.map((option) => option.label) ?? [];
    expect(new Set(decisionLabels).size).toBe(decisionLabels.length);
    expect(decisionLabels.join(" ")).not.toMatch(
      /candidate-a|candidate-b|reforma-a|reforma-b|room-a|room-b/,
    );

    input.questions = [
      {
        id: "q-a-target",
        lineIds: ["line-a"],
        field: "targets",
        text: "Destino A?",
      },
    ];
    const targets = await buildGuidedReviewAuthority(
      duplicateTransaction,
      duplicateActor,
      "personal",
      input,
      duplicateSearch,
      7,
      false,
      catalog,
    );
    const targetLabels =
      targets.review.focus?.options.map((option) => option.label) ?? [];
    expect(new Set(targetLabels).size).toBe(targetLabels.length);
    expect(targetLabels).toEqual(
      expect.arrayContaining([
        "OBRA (1)",
        "OBRA (1) · SALA",
        "OBRA (2)",
        "OBRA (2) · SALA",
      ]),
    );
    expect(targetLabels.join(" ")).not.toMatch(
      /reforma-a|reforma-b|room-a|room-b/,
    );
  });
});
