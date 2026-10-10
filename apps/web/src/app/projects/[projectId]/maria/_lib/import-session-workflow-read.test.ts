import { describe, expect, it } from "vitest";
import {
  readCsvReleaseProposal,
  readImportChallenge,
  readImportConfirmation,
  readImportWorkflowView,
} from "./import-session-workflow-read";
import {
  appliedFixture,
  confirmedFixture,
  workflowFixture,
  declarationViewFixture,
  declarationQuestionFixture,
  declaredFactFixture,
} from "./import-workflow-fixtures";
import { isResultRead, isViewRead } from "./import-session-read";

const CONFIRMATION_HASH = "c".repeat(64);

function publicWorkflowFixture() {
  return workflowFixture();
}

function publicBinding(bindingVersion: 0 | 1) {
  if (bindingVersion === 0)
    return { bindingVersion: 0 as const, confirmationHash: null };
  return {
    bindingVersion: 1 as const,
    confirmationHash: CONFIRMATION_HASH,
  };
}

function publicConfirmedFixture(bindingVersion: 0 | 1 = 1) {
  const view = confirmedFixture();
  if (!view.proposal || !view.confirmation)
    throw new Error("Fixture must carry proposal and confirmation");
  const binding = publicBinding(bindingVersion);
  return {
    ...view,
    confirmation: {
      financialRequestId: view.confirmation.financialRequestId,
      confirmedRevision: view.confirmation.confirmedRevision,
      ...binding,
    },
  };
}

function publicAppliedFixture(bindingVersion: 0 | 1 = 1) {
  const view = appliedFixture();
  if (!view.proposal || !view.confirmation || !view.receipt)
    throw new Error("Fixture must carry proposal, confirmation, and receipt");
  const binding = publicBinding(bindingVersion);
  return {
    ...view,
    confirmation: {
      financialRequestId: view.confirmation.financialRequestId,
      confirmedRevision: view.confirmation.confirmedRevision,
      ...binding,
    },
    receipt: {
      ...view.receipt,
      ...binding,
    },
  };
}

describe("public confirmation binding boundary", () => {
  it("accepts a display-only READY proposal without exposing either digest", () => {
    const wire = publicWorkflowFixture();
    if (!wire.proposal) throw new Error("Fixture must carry a proposal");

    expect(readImportWorkflowView(wire)).toStrictEqual(wire);
    expect(Object.hasOwn(wire.proposal, "proposalHash")).toBe(false);
    expect(Object.hasOwn(wire.proposal, "confirmationHash")).toBe(false);
  });

  it("accepts a fresh v1 CONFIRMED reference with a non-null public hash", () => {
    const wire = publicConfirmedFixture();

    const parsed = readImportWorkflowView(wire);

    expect(parsed.confirmation).toStrictEqual({
      financialRequestId: "123e4567-e89b-42d3-a456-426614174000",
      confirmedRevision: 7,
      bindingVersion: 1,
      confirmationHash: CONFIRMATION_HASH,
    });
    expect(Object.hasOwn(wire.confirmation, "proposalHash")).toBe(false);
  });

  it("accepts a legacy v0 CONFIRMED reference and retains replay identity", () => {
    const wire = publicConfirmedFixture(0);

    const parsed = readImportWorkflowView(wire);

    expect(parsed.confirmation).toStrictEqual({
      financialRequestId: "123e4567-e89b-42d3-a456-426614174000",
      confirmedRevision: 7,
      bindingVersion: 0,
      confirmationHash: null,
    });
    expect(parsed.actions).toStrictEqual(["EXECUTE", "READ_RESULT"]);
  });

  it.each([
    ["fresh", publicAppliedFixture()],
    ["legacy", publicAppliedFixture(0)],
  ])("accepts an exact %s APPLIED receipt binding", (_name, wire) => {
    const parsed = readImportWorkflowView(wire);

    expect(parsed.receipt).toStrictEqual(wire.receipt);
    expect(parsed.receipt?.financialRequestId).toBe(
      "123e4567-e89b-42d3-a456-426614174000",
    );
    expect(parsed.receipt?.bindingVersion).toBe(_name === "fresh" ? 1 : 0);
    expect(parsed.receipt?.confirmationHash).toBe(
      _name === "fresh" ? CONFIRMATION_HASH : null,
    );
    expect(Object.hasOwn(wire.receipt, "proposalHash")).toBe(false);
  });

  it.each([
    ["fresh", publicAppliedFixture()],
    ["legacy", publicAppliedFixture(0)],
  ])("accepts an exact %s result-read receipt", (_name, wire) => {
    expect(isResultRead({ state: "APPLIED", receipt: wire.receipt })).toBe(
      true,
    );
  });

  it("rejects proposalHash from the reduced result reader", () => {
    const wire = publicAppliedFixture();
    Object.assign(wire.receipt, { proposalHash: "a".repeat(64) });

    expect(isResultRead({ state: "APPLIED", receipt: wire.receipt })).toBe(
      false,
    );
  });

  it.each([
    [
      "proposal",
      () => {
        const wire = publicWorkflowFixture();
        if (!wire.proposal) throw new Error("Fixture must carry a proposal");
        Object.assign(wire.proposal, { proposalHash: "a".repeat(64) });
        return wire;
      },
    ],
    [
      "confirmation reference",
      () => {
        const wire = publicConfirmedFixture();
        Object.assign(wire.confirmation, { proposalHash: "a".repeat(64) });
        return wire;
      },
    ],
    [
      "receipt",
      () => {
        const wire = publicAppliedFixture();
        Object.assign(wire.receipt, { proposalHash: "a".repeat(64) });
        return wire;
      },
    ],
  ])("rejects proposalHash as an extra public %s key", (_name, build) => {
    expect(() => readImportWorkflowView(build())).toThrow();
  });

  it.each([
    [1, null],
    [0, CONFIRMATION_HASH],
  ] as const)(
    "rejects bindingVersion %i with confirmationHash %s",
    (bindingVersion, confirmationHash) => {
      const wire = publicConfirmedFixture();
      wire.confirmation.bindingVersion = bindingVersion;
      wire.confirmation.confirmationHash = confirmationHash;
      expect(() => readImportWorkflowView(wire)).toThrow();
    },
  );

  it("keeps challenge and confirm responses exact against private hash extras", () => {
    expect(() =>
      readImportChallenge({
        nonce: "nonce-a",
        expiresAt: "2026-10-09T15:05:00.000Z",
        proposalHash: "a".repeat(64),
      }),
    ).toThrow();
    expect(() =>
      readImportConfirmation({
        sessionId: "session-a",
        financialRequestId: "123e4567-e89b-42d3-a456-426614174000",
        state: "CONFIRMED",
        proposalHash: "a".repeat(64),
      }),
    ).toThrow();
  });
});

describe("CSV release effects boundary", () => {
  const effects = {
    personalSourceCreates: 1,
    reformaTargetCreates: 1,
    expenseCreates: 2,
    cashFlowEntryCreates: 2,
    rateioAllocationCreates: 1,
    keptExistingCount: 1,
    deferredCount: 1,
    excludedCount: 1,
    ignoredCount: 1,
  };

  it("returns a field-narrowed effects object", () => {
    expect(readCsvReleaseProposal({ noWriteRows: [], effects })).toStrictEqual({
      noWriteRows: [],
      effects,
    });
  });

  it("accepts a no-write row whose amount is not available", () => {
    const noWriteRows = [
      {
        lineId: "deferred-without-amount",
        outcome: "DEFERRED",
        reason: "USER_DEFERRED",
        title: "Compra sem valor confirmado",
        amountCents: null,
      },
    ];

    expect(readCsvReleaseProposal({ noWriteRows, effects })).toStrictEqual({
      noWriteRows,
      effects,
    });
  });

  it("keeps the full release proposal readable when a no-write amount is null", () => {
    const view = workflowFixture();
    if (!view.proposal) throw new Error("Fixture must carry a proposal");
    Object.assign(view.proposal, {
      noWriteRows: [
        {
          lineId: "deferred-without-amount",
          outcome: "DEFERRED",
          reason: "USER_DEFERRED",
          title: "Compra sem valor confirmado",
          amountCents: null,
        },
      ],
      effects,
    });

    expect(readImportWorkflowView(view)).toEqual(view);
  });

  it("fails closed for a non-null invalid no-write amount", () => {
    expect(
      readCsvReleaseProposal({
        noWriteRows: [
          {
            lineId: "deferred-with-invalid-amount",
            outcome: "DEFERRED",
            reason: "USER_DEFERRED",
            title: "Compra com valor inválido",
            amountCents: "100",
          },
        ],
        effects,
      }),
    ).toBeNull();
  });

  it.each([
    ["missing field", (({ ignoredCount: _, ...rest }) => rest)(effects)],
    ["invalid field type", { ...effects, deferredCount: "1" }],
  ])("fails closed for %s", (_name, malformedEffects) => {
    expect(
      readCsvReleaseProposal({
        noWriteRows: [],
        effects: malformedEffects,
      }),
    ).toBeNull();
  });
});

describe("CSV APPLIED audit receipt boundary", () => {
  const effects = {
    personalSourceCreates: 1,
    reformaTargetCreates: 1,
    expenseCreates: 2,
    cashFlowEntryCreates: 2,
    rateioAllocationCreates: 1,
    keptExistingCount: 0,
    deferredCount: 1,
    excludedCount: 0,
    ignoredCount: 0,
  };
  const auditItem = {
    lineId: "audit-deferred",
    outcome: "DEFERRED" as const,
    reason: "USER_DEFERRED" as const,
    title: "Compra deixada para depois",
    amountCents: -45002,
  };

  function releasedApplied() {
    const view = appliedFixture();
    if (!view.proposal || !view.receipt)
      throw new Error("Fixture must carry proposal and receipt");
    Object.assign(view.proposal, {
      noWriteRows: [structuredClone(auditItem)],
      effects,
    });
    view.receipt.auditItems = [structuredClone(auditItem)];
    return view;
  }

  it("accepts and preserves optional auditItems on an APPLIED receipt", () => {
    const view = releasedApplied();
    expect(readImportWorkflowView(view).receipt?.auditItems).toStrictEqual([
      auditItem,
    ]);
  });

  it("keeps a legacy APPLIED view readable when neither side has audit rows", () => {
    const view = appliedFixture();
    expect(Object.hasOwn(view.proposal ?? {}, "noWriteRows")).toBe(false);
    expect(Object.hasOwn(view.receipt ?? {}, "auditItems")).toBe(false);
    expect(readImportWorkflowView(view)).toEqual(view);
  });

  it.each([
    [
      "an extra audit key",
      (view: ReturnType<typeof releasedApplied>) => {
        Object.assign(view.receipt?.auditItems?.[0] ?? {}, { guessed: true });
      },
    ],
    [
      "a missing audit amount",
      (view: ReturnType<typeof releasedApplied>) => {
        if (view.receipt?.auditItems)
          delete (view.receipt.auditItems[0] as Partial<typeof auditItem>)
            .amountCents;
      },
    ],
    [
      "a duplicate audit lineId",
      (view: ReturnType<typeof releasedApplied>) => {
        view.proposal?.noWriteRows?.push(structuredClone(auditItem));
        view.receipt?.auditItems?.push(structuredClone(auditItem));
      },
    ],
    [
      "an audit lineId overlapping a financial item",
      (view: ReturnType<typeof releasedApplied>) => {
        const lineId = view.receipt?.items[0].lineId;
        if (!lineId || !view.proposal?.noWriteRows || !view.receipt?.auditItems)
          throw new Error("Missing test rows");
        view.proposal.noWriteRows[0].lineId = lineId;
        view.receipt.auditItems[0].lineId = lineId;
      },
    ],
    [
      "an audit reason diverging from the proposal",
      (view: ReturnType<typeof releasedApplied>) => {
        if (view.receipt?.auditItems)
          view.receipt.auditItems[0].reason = "USER_EXCLUDED";
      },
    ],
    [
      "an audit amount diverging from the proposal",
      (view: ReturnType<typeof releasedApplied>) => {
        if (view.receipt?.auditItems)
          view.receipt.auditItems[0].amountCents = -45001;
      },
    ],
    [
      "proposal noWriteRows omitted from the receipt",
      (view: ReturnType<typeof releasedApplied>) => {
        if (view.receipt) delete view.receipt.auditItems;
      },
    ],
  ])("rejects %s", (_name, corrupt) => {
    const view = releasedApplied();
    corrupt(view);
    expect(() => readImportWorkflowView(view)).toThrow();
  });
});

describe("B3 G3 separate draft and derived projection bounds", () => {
  function projection(lineCount: number, observations: number, long = false) {
    const base = declarationViewFixture();
    const fields = [
      "dataCompra",
      "merchant",
      "amountMeaning",
      "amountCents",
      "installmentCount",
      "installmentIndex",
    ] as const;
    const values = {
      dataCompra: "2026-10-08",
      merchant: "Loja Alfa",
      amountMeaning: "TOTAL_PURCHASE",
      amountCents: 10000,
      installmentCount: 3,
      installmentIndex: 2,
    };
    const identifier = (id: string) => (long ? id.padEnd(180, "_") : id);
    const lines = Array.from({ length: lineCount }, (_, index) => ({
      ...base.lines[0],
      id: identifier(`line_${index}`),
      observationIds: Array.from({ length: observations }, (_, observation) =>
        identifier(`observation_${index}_${observation}`),
      ),
    }));
    const questions = lines.flatMap((line, index) =>
      line.observationIds.flatMap((observationId, observation) =>
        fields.map((field) => ({
          id: identifier(`question_${index}_${observation}_${field}`),
          lineIds: [line.id],
          field,
          text: long ? "Q".repeat(500) : `Informe ${field}.`,
          subject: {
            kind: "OBSERVATION",
            observationId,
            meaningContext: field === "amountCents" ? "TOTAL_PURCHASE" : null,
          },
          answerState: "DECLARED",
        })),
      ),
    );
    const declaredFacts = questions.map((question) => ({
      lineId: question.lineIds[0],
      observationId: question.subject.observationId,
      questionId: question.id,
      field: question.field,
      value: values[question.field],
      meaningContext: question.subject.meaningContext,
      origin: "USER_ATTESTATION",
      status: "CURRENT",
    }));
    return {
      ...base,
      lines,
      selectedLineIds: [],
      reviewBlockers: [],
      questions,
      declaredFacts,
    };
  }

  it("accepts ten lines with twenty observations and six current fields each", () => {
    const wire = projection(10, 20);
    expect(wire.questions).toHaveLength(1200);
    expect(wire.declaredFacts).toHaveLength(1200);
    expect(readImportWorkflowView(wire)).toEqual(wire);
  });

  it("accepts exactly 12000 documentary questions with their matching facts", () => {
    const wire = projection(100, 20);
    expect(wire.questions).toHaveLength(12000);
    expect(wire.declaredFacts).toHaveLength(12000);
    expect(readImportWorkflowView(wire)).toEqual(wire);
  });

  it("rejects 12001 documentary questions with all previous 12000 bindings preserved", () => {
    const valid = projection(100, 20);
    expect(valid.questions).toHaveLength(12000);
    expect(valid.declaredFacts).toHaveLength(12000);
    const invalid = {
      ...valid,
      questions: [
        ...valid.questions,
        {
          ...valid.questions[0],
          id: "question_over_limit",
          answerState: "UNANSWERED",
        },
      ],
    };
    expect(invalid.questions).toHaveLength(12001);
    expect(new Set(invalid.questions.map((question) => question.id)).size).toBe(
      12001,
    );
    expect(invalid.questions.slice(0, 12000)).toEqual(valid.questions);
    expect(invalid.declaredFacts).toBe(valid.declaredFacts);
    expect(invalid.lines).toBe(valid.lines);
    expect(() => readImportWorkflowView(invalid)).toThrow();
  });

  it("accepts a derived projection over 1 MiB without charging it to the draft", () => {
    const wire = projection(10, 15, true);
    expect(wire.questions).toHaveLength(900);
    expect(
      new TextEncoder().encode(JSON.stringify(wire)).length,
    ).toBeGreaterThan(1048576);
    expect(
      new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          lines: wire.lines,
          selectedLineIds: [],
          questions: [],
        }),
      ).length,
    ).toBeLessThan(1048576);
    expect(readImportWorkflowView(wire)).toEqual(wire);
  });

  it("preserves the original 900 draft-question limit independently", () => {
    const base = declarationViewFixture();
    const draftQuestions = Array.from({ length: 900 }, (_, index) => ({
      id: `draft_${index}`,
      field: "amountCents",
      lineIds: ["first"],
      text: "Qual é o valor?",
    }));
    const valid = { ...base, questions: draftQuestions };
    expect(readImportWorkflowView(valid)).toEqual(valid);
    expect(() =>
      readImportWorkflowView({
        ...valid,
        questions: [
          ...draftQuestions,
          { ...draftQuestions[0], id: "draft_over" },
        ],
      }),
    ).toThrow();
  });

  it("still rejects public draft components above 1 MiB", () => {
    const base = projection(100, 20, true);
    const questions = Array.from({ length: 900 }, (_, index) => ({
      id: `draft_${index}`.padEnd(180, "_"),
      field: "amountCents",
      lineIds: [base.lines[index % 100].id],
      text: "Q".repeat(500),
    }));
    const wire = { ...base, questions, declaredFacts: [] };
    const draft = {
      version: 1,
      lines: wire.lines,
      selectedLineIds: [],
      questions,
    };
    expect(
      new TextEncoder().encode(JSON.stringify(draft)).length,
    ).toBeGreaterThan(1048576);
    expect(() => readImportWorkflowView(wire)).toThrow();
  });

  it.each(["facts", "membership", "duplicate", "value"])(
    "rejects derived %s overflow or malformed data after a small valid control",
    (defect) => {
      const valid = projection(1, 1);
      expect(readImportWorkflowView(valid)).toEqual(valid);
      const invalid = structuredClone(valid);
      if (defect === "facts")
        invalid.declaredFacts = Array.from({ length: 12001 }, () => ({
          ...valid.declaredFacts[0],
        }));
      if (defect === "membership")
        invalid.questions[0].subject.observationId = "other_observation";
      if (defect === "duplicate")
        invalid.questions[1].id = invalid.questions[0].id;
      if (defect === "value") invalid.declaredFacts[3].value = -1;
      expect(() => readImportWorkflowView(invalid)).toThrow();
    },
  );
});

describe("B3 full view requires the final declaration wire", () => {
  it.each(["twin question", "stale question", "unchanged meaning"])(
    "G4 binds CONTEXT_CHANGED to the current monetary question: %s",
    (defect) => {
      const valid = declarationViewFixture();
      valid.declaredFacts = [declaredFactFixture("first", "CONTEXT_CHANGED")];
      expect(readImportWorkflowView(valid)).toEqual(valid);
      const invalid = structuredClone(valid);
      if (defect === "twin question")
        invalid.declaredFacts[0].questionId = "oq_twin_amount";
      if (defect === "stale question")
        invalid.declaredFacts[0].questionId = "oq_first_previous_amount";
      if (defect === "unchanged meaning")
        invalid.declaredFacts[0].meaningContext = "TOTAL_PURCHASE";
      expect(() => readImportWorkflowView(invalid)).toThrow();
    },
  );

  it("accepts the real full shape before PREPARE, preserving distinct observations", () => {
    const wire = declarationViewFixture();
    expect(readImportWorkflowView(wire)).toEqual(wire);
  });

  it.each(["CURRENT", "UNKNOWN", "CONTEXT_CHANGED"] as const)(
    "preserves %s support without rewriting its meaning context",
    (status) => {
      const wire = declarationViewFixture();
      wire.questions[0] = declarationQuestionFixture(
        "first",
        status === "CURRENT"
          ? "DECLARED"
          : status === "UNKNOWN"
            ? "UNKNOWN"
            : "UNANSWERED",
      );
      wire.declaredFacts = [declaredFactFixture("first", status)];
      const read = readImportWorkflowView(wire);
      expect(read).toEqual(wire);
    },
  );

  it("does not supply missing declaredFacts with an empty success value", () => {
    const valid = declarationViewFixture();
    expect(readImportWorkflowView(valid)).toEqual(valid);
    const { declaredFacts: omitted, ...wire } = valid;
    expect(omitted).toEqual([]);
    expect(() => readImportWorkflowView(wire)).toThrow();
  });

  it("requires the collection even when no document has yet produced a declaration", () => {
    const legacy: Record<string, unknown> = { ...workflowFixture() };
    delete legacy.declaredFacts;
    expect(() => readImportWorkflowView(legacy)).toThrow();
  });

  it("requires blocker resolution independently of other B3 fields", () => {
    const wire = declarationViewFixture();
    const withoutResolution = {
      ...wire,
      reviewBlockers: [
        { lineId: "first", code: "ORIGINAL_IDENTITY_INCOMPLETE" },
      ],
    };
    expect(readImportWorkflowView(wire)).toEqual(wire);
    expect(() => readImportWorkflowView(withoutResolution)).toThrow();
  });

  it("recovery accepts resolved blockers without requiring full-view declarations", () => {
    const full = declarationViewFixture();
    const { declaredFacts: omitted, ...reduced } = {
      ...full,
      reviewBlockers: [
        {
          lineId: "first",
          code: "ORIGINAL_IDENTITY_INCOMPLETE",
          resolution: "RESOLVED_BY_USER",
        },
      ],
    };
    expect(omitted).toEqual([]);
    expect(isViewRead(reduced)).toBe(true);
  });

  it.each([
    "wrong observation",
    "wrong line",
    "wrong question",
    "private attestation metadata",
    "CURRENT null",
  ])("rejects %s only after the valid control is accepted", (defect) => {
    const wire = declarationViewFixture();
    wire.questions[0] = declarationQuestionFixture("first", "DECLARED");
    wire.declaredFacts = [declaredFactFixture()];
    expect(readImportWorkflowView(wire)).toEqual(wire);
    const fact = wire.declaredFacts[0];
    const malformed = {
      ...fact,
      ...(defect === "wrong observation"
        ? { observationId: "observation-twin" }
        : {}),
      ...(defect === "wrong line" ? { lineId: "twin" } : {}),
      ...(defect === "wrong question" ? { questionId: "oq_twin_amount" } : {}),
      ...(defect === "private attestation metadata"
        ? { attestedAt: "2026-10-08T12:30:00.000Z" }
        : {}),
      ...(defect === "CURRENT null" ? { value: null } : {}),
    };
    expect(() =>
      readImportWorkflowView({ ...wire, declaredFacts: [malformed] }),
    ).toThrow();
  });

  it("rejects an UNKNOWN non-null value with the UNKNOWN question and all other fields unchanged", () => {
    const valid = declarationViewFixture();
    valid.questions[0] = declarationQuestionFixture("first", "UNKNOWN");
    valid.declaredFacts = [declaredFactFixture("first", "UNKNOWN")];
    expect(readImportWorkflowView(valid)).toEqual(valid);
    expect(valid.declaredFacts[0]).toMatchObject({
      status: "UNKNOWN",
      value: null,
    });
    const invalid = {
      ...valid,
      declaredFacts: [{ ...valid.declaredFacts[0], value: 10000 }],
    };
    expect(invalid.questions).toEqual(valid.questions);
    expect({ ...invalid.declaredFacts[0], value: null }).toEqual(
      valid.declaredFacts[0],
    );
    expect(() => readImportWorkflowView(invalid)).toThrow();
  });

  it.each([
    "answer state",
    "observation binding",
    "multiple lines",
    "amount context",
    "text normalization",
  ])(
    "rejects malformed question %s after its matching valid control",
    (defect) => {
      const valid = declarationViewFixture();
      expect(readImportWorkflowView(valid)).toEqual(valid);
      const question = valid.questions[0];
      const invalid = {
        ...valid,
        questions: [
          {
            ...question,
            ...(defect === "text normalization" ? { text: "Cafe\u0301" } : {}),
            ...(defect === "answer state" ? { answerState: "ANSWERED" } : {}),
            ...(defect === "multiple lines"
              ? { lineIds: ["first", "twin"] }
              : {}),
            subject: {
              ...question.subject,
              ...(defect === "observation binding"
                ? { observationId: "observation-twin" }
                : {}),
              ...(defect === "amount context" ? { meaningContext: null } : {}),
            },
          },
          valid.questions[1],
        ],
      };
      expect(() => readImportWorkflowView(invalid)).toThrow();
    },
  );

  it("a merchant fact requires null meaningContext, with its own merchant positive control", () => {
    const base = declarationViewFixture();
    const question = {
      ...base.questions[0],
      id: "oq_first_merchant",
      field: "merchant",
      subject: {
        kind: "OBSERVATION",
        observationId: "observation-first",
        meaningContext: null,
      },
      answerState: "DECLARED",
    };
    const fact = {
      lineId: "first",
      observationId: "observation-first",
      questionId: "oq_first_merchant",
      field: "merchant",
      value: "Loja Alfa",
      meaningContext: null,
      origin: "USER_ATTESTATION",
      status: "CURRENT",
    };
    const valid = {
      ...base,
      questions: [question, base.questions[1]],
      declaredFacts: [fact],
    };
    expect(readImportWorkflowView(valid)).toEqual(valid);
    expect(() =>
      readImportWorkflowView({
        ...valid,
        declaredFacts: [{ ...fact, meaningContext: "TOTAL_PURCHASE" }],
      }),
    ).toThrow();
  });

  it("CONTEXT_CHANGED preserves the previous monetary meaning but cannot carry null", () => {
    const valid = declarationViewFixture();
    valid.declaredFacts = [declaredFactFixture("first", "CONTEXT_CHANGED")];
    expect(readImportWorkflowView(valid)).toEqual(valid);
    expect(valid.questions[0].subject.meaningContext).toBe("TOTAL_PURCHASE");
    expect(valid.declaredFacts[0]).toMatchObject({
      value: 10000,
      meaningContext: "INSTALLMENT_CHARGE",
      status: "CONTEXT_CHANGED",
    });
    expect(() =>
      readImportWorkflowView({
        ...valid,
        declaredFacts: [{ ...valid.declaredFacts[0], value: null }],
      }),
    ).toThrow();
  });
});

describe("full workflow boundary (not recovery)", () => {
  it("preserves the exact full view, legitimate twins and nulls", () => {
    const value = workflowFixture();
    expect(readImportWorkflowView(value)).toEqual(value);
    expect(readImportWorkflowView(value).proposal?.lines).toHaveLength(2);
  });

  it("does not promote the accepted reduced recovery projection", () => {
    const full = workflowFixture();
    const { id, ownerProjectId, cardId, state, revision, expiresAt, actions } =
      full;
    const reduced = {
      id,
      ownerProjectId,
      cardId,
      state,
      revision,
      expiresAt,
      actions,
      attachments: [],
      lines: [],
      questions: [],
      selectedLineIds: [],
      reviewBlockers: [],
    };
    expect(isViewRead(reduced)).toBe(true);
    expect(() => readImportWorkflowView(reduced)).toThrow();
  });

  describe("shared X3 documentary facts, including read-only recovery", () => {
    it.each([false, true])(
      "accepts explicit materialization=%s without inferring from lines",
      (materializedInSession) => {
        const view = workflowFixture();
        view.state = "DRAFT";
        view.lines = [];
        view.selectedLineIds = [];
        view.proposal = null;
        view.actions = ["CANCEL"];
        view.attachments[0].materializedInSession = materializedInSession;
        expect(readImportWorkflowView(view)).toEqual(view);
        expect(isViewRead(view)).toBe(true);
      },
    );
    it("accepts eligible pending EXTRACTED and combines typed blockers without changing selection", () => {
      const view = workflowFixture();
      view.proposal = null;
      view.actions = ["ANALYZE", "RESOLVE", "CANCEL"];
      view.attachments[0].materializedInSession = false;
      view.attachments[0].canAnalyze = true;
      view.reviewBlockers = [
        {
          lineId: "first",
          code: "ORIGINAL_IDENTITY_INCOMPLETE",
          resolution: "SEARCH_IDENTITY_UNAVAILABLE",
        },
        {
          lineId: "first",
          code: "ORIGINAL_OCCURRENCE_INCOMPLETE",
          resolution: "SEARCH_IDENTITY_UNAVAILABLE",
        },
      ];
      expect(readImportWorkflowView(view)).toEqual(view);
      expect(isViewRead(view)).toBe(true);
    });
    it("accepts queued analysis eligibility while the action is withheld", () => {
      const view = workflowFixture();
      view.actions = ["CANCEL"];
      view.attachments[0].materializedInSession = false;
      view.attachments[0].canAnalyze = true;
      expect(readImportWorkflowView(view)).toEqual(view);
      expect(isViewRead(view)).toBe(true);
    });
    it.each([
      [
        "old four-field wire",
        (v: ReturnType<typeof workflowFixture>) => ({
          ...v,
          attachments: [
            {
              id: "attachment-a",
              fileName: "a.png",
              state: "ATTACHED",
              declaredBytes: 12,
            },
          ],
        }),
      ],
      [
        "absent blockers",
        (v: ReturnType<typeof workflowFixture>) => ({
          ...v,
          reviewBlockers: undefined,
        }),
      ],
      [
        "null blockers",
        (v: ReturnType<typeof workflowFixture>) => ({
          ...v,
          reviewBlockers: null,
        }),
      ],
      [
        "unknown blocker code",
        (v: ReturnType<typeof workflowFixture>) => ({
          ...v,
          reviewBlockers: [{ lineId: "first", code: "OTHER" }],
        }),
      ],
      [
        "unknown blocker line",
        (v: ReturnType<typeof workflowFixture>) => ({
          ...v,
          reviewBlockers: [
            { lineId: "hidden", code: "ORIGINAL_IDENTITY_INCOMPLETE" },
          ],
        }),
      ],
      [
        "extra blocker property",
        (v: ReturnType<typeof workflowFixture>) => ({
          ...v,
          reviewBlockers: [
            {
              lineId: "first",
              code: "ORIGINAL_IDENTITY_INCOMPLETE",
              question: "Invented?",
            },
          ],
        }),
      ],
      [
        "truthy flag",
        (v: ReturnType<typeof workflowFixture>) => ({
          ...v,
          attachments: [{ ...v.attachments[0], canAnalyze: "false" }],
        }),
      ],
      [
        "eligible and complete",
        (v: ReturnType<typeof workflowFixture>) => ({
          ...v,
          attachments: [{ ...v.attachments[0], canAnalyze: true }],
          actions: ["ANALYZE"],
        }),
      ],
      [
        "action without eligibility",
        (v: ReturnType<typeof workflowFixture>) => ({
          ...v,
          actions: ["ANALYZE"],
        }),
      ],
      [
        "completed failed upload",
        (v: ReturnType<typeof workflowFixture>) => ({
          ...v,
          attachments: [{ ...v.attachments[0], state: "FAILED" }],
        }),
      ],
      [
        "invalid selection reference",
        (v: ReturnType<typeof workflowFixture>) => ({
          ...v,
          selectedLineIds: ["hidden"],
        }),
      ],
      [
        "terminal blockers",
        () => ({
          ...appliedFixture(),
          reviewBlockers: [
            { lineId: "first", code: "ORIGINAL_IDENTITY_INCOMPLETE" },
          ],
        }),
      ],
    ])("both readers reject %s instead of defaulting", (_name, change) => {
      const value = change(workflowFixture());
      expect(() => readImportWorkflowView(value)).toThrow();
      expect(isViewRead(value)).toBe(false);
    });
  });

  it("accepts a coherent older confirmed revision and immutable applied snapshot", () => {
    const confirmed = confirmedFixture();
    if (!confirmed.proposal || !confirmed.confirmation)
      throw new Error("Missing test confirmation");
    confirmed.revision = 9;
    confirmed.proposal.revision = 8;
    confirmed.confirmation.confirmedRevision = 8;
    expect(readImportWorkflowView(confirmed)).toEqual(confirmed);
    expect(readImportWorkflowView(appliedFixture())).toEqual(appliedFixture());
  });

  it.each([1, 2])("enforces the CSV release one-target limit: %i", (count) => {
    const view = workflowFixture();
    if (!view.proposal) throw new Error("Missing test proposal");
    for (const line of view.proposal.lines) {
      if (line.kind !== "CREATE") throw new Error("Missing test create");
      line.targets = Array.from({ length: count }, (_, index) => {
        const occurrences = line.schedule.occurrences.map((o) => ({
          ...o,
          valor:
            Math.floor(o.valor / count) +
            (index === count - 1 ? o.valor % count : 0),
        }));
        return {
          projectId: `target-project-${index}`,
          roomId: null,
          amountCents: occurrences.reduce((sum, o) => sum + o.valor, 0),
          schedule: { version: 1, occurrences },
        };
      });
      const draft = view.lines.find((d) => d.id === line.lineId);
      if (!draft) throw new Error("Missing test draft");
      draft.targets = line.targets.map(
        ({ projectId, roomId, amountCents }) => ({
          projectId,
          roomId,
          amountCents,
        }),
      );
    }
    if (count === 1) expect(readImportWorkflowView(view)).toEqual(view);
    else expect(() => readImportWorkflowView(view)).toThrow();
  });

  it.each(["CANCELLED", "EXPIRED"] as const)(
    "preserves terminal nulls: %s",
    (state) => {
      const value = {
        ...workflowFixture(),
        state,
        expiresAt: null,
        lines: [],
        selectedLineIds: [],
        questions: [],
        attachments: [],
        proposal: null,
        confirmation: null,
        receipt: null,
        actions: [],
      };
      expect(readImportWorkflowView(value)).toEqual(value);
    },
  );

  it("keeps READY with no actions readable, not implicitly actionable", () => {
    const value = { ...workflowFixture(), actions: [] };
    expect(readImportWorkflowView(value).actions).toEqual([]);
  });

  it("preserves a kept schedule including legitimate signed values and unknown cycles", () => {
    const view = workflowFixture();
    const schedule = {
      version: 1 as const,
      occurrences: [
        {
          index: 0,
          parcela: null,
          valor: -12345678,
          data: "2026-10-06",
          invoiceDueMonth: null,
        },
      ],
    };
    view.lines[1].decision = { kind: "KEEP_EXISTING", expenseId: "existing" };
    if (!view.proposal) throw new Error("Missing test proposal");
    view.proposal.lines[1] = {
      kind: "KEEP_EXISTING",
      lineId: "twin",
      sourceExpenseId: "existing",
      totalCents: -12345678,
      schedule,
    };
    view.proposal.createdEconomicTotalCents = 99999999;
    view.proposal.invoiceDeltas = [
      { invoiceDueMonth: "2026-12", amountCents: 50000000 },
      { invoiceDueMonth: "2027-01", amountCents: 49999999 },
    ];
    expect(readImportWorkflowView(view)).toEqual(view);
  });

  it("allows deferred observations not materialized as editable lines (no public private-scope invention)", () => {
    const view = workflowFixture();
    if (!view.proposal) throw new Error("Missing test proposal");
    view.proposal.deferredObservationIds = ["unselected-document-row"];
    view.proposal.retainUntil = view.expiresAt;
    expect(readImportWorkflowView(view)).toEqual(view);
  });

  const corruptions: Array<
    [string, (v: ReturnType<typeof workflowFixture>) => unknown]
  > = [
    ["unknown public scope", (v) => ({ ...v, scope: { observationIds: [] } })],
    [
      "missing searchComplete",
      (v) => {
        const { searchComplete: _, ...rest } = v;
        return rest;
      },
    ],
    ["unknown action", (v) => ({ ...v, actions: ["PAY"] })],
    [
      "invalid date",
      (v) => {
        v.lines[0].dataCompra = "2026-02-30";
        return v;
      },
    ],
    ["missing nested field", (v) => ({ ...v, lines: [{ id: "first" }] })],
    ["selection crossref", (v) => ({ ...v, selectedLineIds: ["missing"] })],
    [
      "question crossref",
      (v) => ({
        ...v,
        questions: [
          { id: "q", lineIds: ["missing"], field: "targets", text: "Qual?" },
        ],
      }),
    ],
    [
      "unknown question field",
      (v) => ({
        ...v,
        questions: [
          { id: "q", lineIds: ["first"], field: "tenantId", text: "Qual?" },
        ],
      }),
    ],
    [
      "duplicate observations selected",
      (v) => {
        v.lines[1].observationIds = v.lines[0].observationIds;
        return v;
      },
    ],
    [
      "proposal revision drift",
      (v) => ({ ...v, proposal: { ...v.proposal, revision: 6 } }),
    ],
    [
      "proposal session drift",
      (v) => ({ ...v, proposal: { ...v.proposal, sessionId: "other" } }),
    ],
    [
      "confirmation hash exposed on proposal",
      (v) => ({
        ...v,
        proposal: { ...v.proposal, confirmationHash: "a".repeat(64) },
      }),
    ],
    [
      "negative create",
      (v) => {
        if (v.proposal) v.proposal.lines[0].totalCents = -1;
        return v;
      },
    ],
    [
      "bad schedule total",
      (v) => {
        if (v.proposal) v.proposal.lines[0].schedule.occurrences[0].valor = 1;
        return v;
      },
    ],
    [
      "unknown schedule field",
      (v) => {
        if (v.proposal)
          Object.assign(v.proposal.lines[0].schedule, { guessed: true });
        return v;
      },
    ],
    [
      "invalid invoice cycle",
      (v) => {
        if (v.proposal)
          v.proposal.lines[0].schedule.occurrences[0].invoiceDueMonth =
            "2026-13";
        return v;
      },
    ],
    [
      "unresolved selected decision",
      (v) => {
        v.lines[0].decision = { kind: "UNRESOLVED" };
        return v;
      },
    ],
    [
      "deferred overlap",
      (v) => ({
        ...v,
        proposal: {
          ...v.proposal,
          deferredObservationIds: ["observation-first"],
          retainUntil: v.expiresAt,
        },
      }),
    ],
    [
      "deferred missing retention",
      (v) => ({
        ...v,
        proposal: { ...v.proposal, deferredAttachmentIds: ["attachment-a"] },
      }),
    ],
    [
      "too many selected",
      (v) => ({
        ...v,
        selectedLineIds: Array.from({ length: 11 }, (_, i) => `l-${i}`),
      }),
    ],
    [
      "confirmation hash malformed",
      () => {
        const v = confirmedFixture();
        if (v.confirmation) v.confirmation.confirmationHash = "bad";
        return v;
      },
    ],
    [
      "receipt reduced",
      () => {
        const v = appliedFixture();
        return {
          ...v,
          receipt: { appliedAt: v.receipt?.appliedAt, items: [], snapshot: {} },
        };
      },
    ],
    [
      "receipt items out of order",
      () => {
        const v = appliedFixture();
        v.receipt?.items.reverse();
        return v;
      },
    ],
    [
      "receipt participant missing",
      () => {
        const v = appliedFixture();
        if (v.receipt) v.receipt.snapshot.participantProjectIds = ["personal"];
        return v;
      },
    ],
    [
      "receipt snapshot drift",
      () => {
        const v = appliedFixture();
        if (v.receipt) v.receipt.snapshot.lines[0].titulo = "Different";
        return v;
      },
    ],
    [
      "receipt identity mismatch",
      () => {
        const v = appliedFixture();
        if (v.receipt)
          v.receipt.financialRequestId = "123e4567-e89b-42d3-a456-426614174111";
        return v;
      },
    ],
    [
      "oversized draft",
      (v) => {
        v.lines[0].titulo = "a".repeat(1048577);
        return v;
      },
    ],
  ];
  it.each(corruptions)("rejects %s explicitly", (_, mutate) => {
    expect(() => readImportWorkflowView(mutate(workflowFixture()))).toThrow();
  });
});
