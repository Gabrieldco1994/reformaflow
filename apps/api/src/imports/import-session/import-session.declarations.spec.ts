require("../../../../../scripts/test-db-env.cjs");
import { validationDraft } from "../../test-utils/import-session-validation-fixtures";
import { validateStoredDraft } from "./import-session.validation";
import {
  ExpenseType,
  type ImportHumanFactFieldV1,
  type ImportSessionStoredDraftV1,
} from "@reformaflow/domain";
import {
  recordImportDeclaration,
  importObservationDedupeKeys,
  resolveImportDeclarations,
  type ImportDeclarationMaterial,
} from "./import-session.declarations";
import type { StoredImportObservationEvidenceV1 } from "./import-session.observation";

const NOW = new Date("2026-10-08T12:30:00.000Z");
function subject(missingAmount = false, siblings = 1) {
  const session = {
    id: "session",
    tenantId: "tenant",
    ownerProjectId: "project",
    revision: 1,
  };
  const scope = {
    tenantId: session.tenantId,
    ownerProjectId: session.ownerProjectId,
  };
  const material: ImportDeclarationMaterial = {
    references: [
      {
        artifact: { ...scope, id: "artifact", documentSha256: "a".repeat(64) },
        ref: {
          ...scope,
          id: "ref",
          sessionId: session.id,
          artifactId: "artifact",
          position: 0,
          fileName: "synthetic.csv",
          declaredMime: "text/csv",
          declaredBytes: 1,
          state: "ATTACHED",
          temporaryStorageKey: null,
          reservedBytes: 0,
          uploadGeneration: 1,
          uploadSessionVersion: null,
          uploadTokenExpiresAt: null,
          uploadLeaseExpiresAt: null,
          verifiedAt: NOW,
          releasedAt: null,
          temporaryPurgePending: false,
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
    ],
    observations: Array.from({ length: siblings }, (_, index) => {
      const evidence: StoredImportObservationEvidenceV1 = {
        version: 1,
        reference: `row-${index}`,
        text: "Synthetic",
        dataCompra: "2026-06-22",
        amountMeaning: "UNKNOWN",
        amountCents: missingAmount ? null : 10000,
        installmentCount: null,
        installmentIndex: null,
        identity: {
          merchant: "Loja",
          ordinal: missingAmount ? null : index,
          fitId: "FITID",
          externalId: null,
          fileContentHash: "b".repeat(32),
        },
      };
      return {
        ...scope,
        id: `observation-${index}`,
        artifactId: "artifact",
        reference: evidence.reference,
        evidenceJson: JSON.stringify(evidence),
        claimVersion: 0,
        canonicalProjectId: null,
        canonicalExpenseId: null,
        canonicalReceiptId: null,
        canonicalIndex: null,
        claimSessionId: null,
        claimReceiptJson: null,
        claimedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      };
    }),
  };
  const draft: ImportSessionStoredDraftV1 = {
    version: 1,
    lines: [
      {
        id: "line",
        observationIds: material.observations.map((row) => row.id),
        titulo: "Loja",
        fornecedor: "Loja",
        tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
        categoriaMaoDeObra: null,
        amountMeaning: "TOTAL_PURCHASE",
        amountCents: 10000,
        installmentCount: 1,
        dataCompra: "2026-06-22",
        firstDueDate: "2026-07-05",
        targets: [],
        decision: { kind: "CREATE", acceptNaturalDuplicate: false },
      },
    ],
    selectedLineIds: ["line"],
    questions: [],
    scope: {
      observationIds: material.observations.map((row) => row.id),
      pendingAttachmentIds: [],
    },
  };
  return { session, material, draft };
}
const resolve = (state: ReturnType<typeof subject>) =>
  resolveImportDeclarations(state.session, state.draft, state.material);
function answer(
  state: ReturnType<typeof subject>,
  field: ImportHumanFactFieldV1,
  literal: string,
) {
  const question = resolve(state).questions.find(
    (question) =>
      question.field === field &&
      question.subject.observationId === "observation-0",
  );
  if (!question) throw new Error(`Missing actual question: ${field}`);
  const draft = recordImportDeclaration(
    state.session,
    state.draft,
    state.material,
    question.id,
    literal,
    {
      userId: "owner",
      turnId: "11111111-1111-4111-8111-111111111111",
      now: NOW,
    },
  );
  if (draft !== state.draft) state.session.revision++;
  state.draft = draft;
  return question;
}

const declaration = () => ({
  lineId: "line-unknown",
  observationId: "observation-unknown",
  field: "installmentCount" as const,
  value: 3,
  meaningContext: null,
  originalFingerprint: "a".repeat(64),
  claimVersion: 0,
  originSessionId: "session",
  recordedRevision: 2,
  questionId: "oq_test",
  turnId: "11111111-1111-4111-8111-111111111111",
  attestedByUserId: "owner",
  attestedAt: "2026-10-08T12:30:00.000Z",
  literalHash: "b".repeat(64),
});

describe("B3 authoritative observation declarations", () => {
  it("derives documentary questions from originals, not ordinary draft values", () => {
    const state = subject();
    expect(resolve(state).questions.map((question) => question.field)).toEqual([
      "amountMeaning",
      "installmentCount",
      "installmentIndex",
    ]);
    expect(resolve(state).declaredFacts).toEqual([]);
    expect(resolve(state).reviewBlockers).toEqual([
      {
        lineId: "line",
        code: "ORIGINAL_OCCURRENCE_INCOMPLETE",
        resolution: "NEEDS_DECLARATION",
      },
    ]);
  });
  it("ordinal zero plus actually missing meaning/count becomes effective without rewriting originals", () => {
    const state = subject();
    const original = JSON.stringify(state.material);
    const meaning = answer(state, "amountMeaning", "valor da parcela");
    answer(state, "installmentCount", "1");
    expect(resolve(state).reviewBlockers[0].resolution).toBe(
      "RESOLVED_BY_USER",
    );
    expect(
      resolve(state).questions.find((question) => question.id === meaning.id)
        ?.answerState,
    ).toBe("DECLARED");
    expect(
      resolve(state).questions.some(
        (question) => question.field === "installmentIndex",
      ),
    ).toBe(false);
    expect(JSON.stringify(state.material)).toBe(original);
    expect(
      resolve(state).byLine.get("line")?.get("observation-0")?.original.identity
        .ordinal,
    ).toBe(0);
  });
  it("does not extend one observation's answer to a sibling", () => {
    const state = subject(false, 2);
    answer(state, "amountMeaning", "total da compra");
    expect(resolve(state).reviewBlockers[0].resolution).toBe(
      "NEEDS_DECLARATION",
    );
    expect(
      resolve(state).questions.find(
        (question) =>
          question.field === "amountMeaning" &&
          question.subject.observationId === "observation-1",
      )?.answerState,
    ).toBe("UNANSWERED");
  });
  it("NO_CHANGE preserves the complete record and draft object despite another author/clock/literal spelling", () => {
    const state = subject();
    const question = answer(state, "amountMeaning", "valor da parcela");
    const before = JSON.stringify(state.draft);
    const next = recordImportDeclaration(
      state.session,
      state.draft,
      state.material,
      question.id,
      "VALOR DA PARCELA",
      {
        userId: "another-author",
        turnId: "22222222-2222-4222-8222-222222222222",
        now: new Date(NOW.getTime() + 60000),
      },
    );
    expect(next).toBe(state.draft);
    expect(JSON.stringify(next)).toBe(before);
  });
  it("asks meaning before money; PARCELA to TOTAL retains the old value as CONTEXT_CHANGED", () => {
    const state = subject(true);
    expect(
      resolve(state).questions.some(
        (question) => question.field === "amountCents",
      ),
    ).toBe(false);
    answer(state, "amountMeaning", "valor da parcela");
    answer(state, "amountCents", "100,00");
    const previous = state.draft.declarations!.items.find(
      (item) => item.field === "amountCents",
    );
    answer(state, "amountMeaning", "total da compra");
    expect(
      state.draft.declarations!.items.find(
        (item) => item.field === "amountCents",
      ),
    ).toEqual(previous);
    expect(
      resolve(state).declaredFacts.find((item) => item.field === "amountCents"),
    ).toMatchObject({
      status: "CONTEXT_CHANGED",
      value: 10000,
      meaningContext: "INSTALLMENT_CHARGE",
    });
    expect(
      resolve(state).byLine.get("line")?.get("observation-0")?.effective
        .amountCents,
    ).toBeNull();
    const question = resolve(state).questions.find(
      (question) => question.field === "amountCents",
    )!;
    expect(question.subject.meaningContext).toBe("TOTAL_PURCHASE");
    expect(question.answerState).toBe("UNANSWERED");
  });
  it("null original ordinal stays unavailable even with FITID and every required effective value", () => {
    const state = subject(true);
    answer(state, "amountMeaning", "total da compra");
    answer(state, "amountCents", "100,00");
    const observation = resolve(state).byLine.get("line")?.get("observation-0");
    if (!observation) throw new Error("Missing resolved test observation");
    expect(
      importObservationDedupeKeys(
        { ...state.session, cardId: "card" },
        observation,
      ),
    ).toBeNull();
    expect(
      resolve(state).reviewBlockers.find(
        (blocker) => blocker.code === "ORIGINAL_IDENTITY_INCOMPLETE",
      )?.resolution,
    ).toBe("SEARCH_IDENTITY_UNAVAILABLE");
    expect(
      resolve(state).byLine.get("line")?.get("observation-0")?.original.identity
        .ordinal,
    ).toBeNull();
  });
  it("an absence belongs to its monetary context, not to a new meaning", () => {
    const state = subject(true);
    answer(state, "amountMeaning", "valor da parcela");
    answer(state, "amountCents", "não sei informar");
    const previous = state.draft.declarations!.items.find(
      (item) => item.field === "amountCents",
    );
    answer(state, "amountMeaning", "total da compra");
    expect(
      resolve(state).questions.find(
        (question) => question.field === "amountCents",
      ),
    ).toMatchObject({
      answerState: "UNANSWERED",
      subject: { meaningContext: "TOTAL_PURCHASE" },
    });
    expect(
      resolve(state).declaredFacts.some((item) => item.field === "amountCents"),
    ).toBe(false);
    expect(
      state.draft.declarations!.items.find(
        (item) => item.field === "amountCents",
      ),
    ).toEqual(previous);
  });
  it("revoking meaning parks the old amount privately until a monetary question can be born again", () => {
    const state = subject(true);
    answer(state, "amountMeaning", "valor da parcela");
    answer(state, "amountCents", "100,00");
    const previous = state.draft.declarations!.items.find(
      (item) => item.field === "amountCents",
    );
    answer(state, "amountMeaning", "remover");
    expect(
      resolve(state).questions.some(
        (question) => question.field === "amountCents",
      ),
    ).toBe(false);
    expect(
      resolve(state).declaredFacts.some((item) => item.field === "amountCents"),
    ).toBe(false);
    expect(
      state.draft.declarations!.items.find(
        (item) => item.field === "amountCents",
      ),
    ).toEqual(previous);
    answer(state, "amountMeaning", "total da compra");
    expect(
      resolve(state).declaredFacts.find((item) => item.field === "amountCents"),
    ).toMatchObject({
      status: "CONTEXT_CHANGED",
      value: 10000,
      meaningContext: "INSTALLMENT_CHARGE",
    });
  });
  it("UNKNOWN is explicit and not an automatically repeated question", () => {
    const state = subject();
    answer(state, "amountMeaning", "não sei informar");
    expect(
      resolve(state).questions.find(
        (question) => question.field === "amountMeaning",
      )?.answerState,
    ).toBe("UNKNOWN");
    expect(resolve(state).declaredFacts[0]).toMatchObject({
      field: "amountMeaning",
      value: null,
      status: "UNKNOWN",
    });
    expect(resolve(state).reviewBlockers[0].resolution).toBe(
      "NEEDS_DECLARATION",
    );
  });
  it.each([
    "não é total da compra",
    "talvez valor da parcela",
    "total da compra ou valor da parcela",
  ])("rejects the entire ambiguous/negative literal: %s", (literal) => {
    const state = subject();
    expect(() => answer(state, "amountMeaning", literal)).toThrow();
    expect(state.draft).not.toHaveProperty("declarations");
  });
  it("rejects quantity corrections contradicting an effective printed index", () => {
    const state = subject();
    answer(state, "amountMeaning", "valor da parcela");
    answer(state, "installmentIndex", "2");
    expect(() => answer(state, "installmentCount", "1")).toThrow();
    expect(
      state.draft.declarations!.items.some(
        (item) => item.field === "installmentCount",
      ),
    ).toBe(false);
  });
  it("claim drift and original drift invalidate support instead of relabeling it", () => {
    const state = subject();
    answer(state, "amountMeaning", "valor da parcela");
    const row = state.material.observations[0];
    row.claimVersion++;
    expect(() => resolve(state)).toThrow();
    row.claimVersion--;
    row.evidenceJson = row.evidenceJson.replace("Loja", "Outra loja");
    expect(() => resolve(state)).toThrow();
  });
  it("successor IDs and revision zero do not reset attestation or authorize an old focus", () => {
    const state = subject();
    const previous = answer(state, "amountMeaning", "valor da parcela");
    const record = JSON.stringify(state.draft.declarations);
    state.session.id = "successor";
    state.session.revision = 0;
    state.material.references[0].ref.sessionId = "successor";
    const current = resolve(state).questions.find(
      (question) => question.field === "amountMeaning",
    )!;
    expect(current.id).not.toBe(previous.id);
    expect(current.answerState).toBe("DECLARED");
    expect(JSON.stringify(state.draft.declarations)).toBe(record);
    expect(() =>
      recordImportDeclaration(
        state.session,
        state.draft,
        state.material,
        previous.id,
        "total da compra",
        {
          userId: "owner",
          turnId: "11111111-1111-4111-8111-111111111111",
          now: NOW,
        },
      ),
    ).toThrow();
  });
});

describe("B3 private declarations, real stored-draft validator", () => {
  it("legacy_draft_round_trips_without_inferred_declarations", () => {
    const draft = validationDraft("project");
    expect(validateStoredDraft(draft)).toEqual(draft);
    expect(validateStoredDraft(draft)).not.toHaveProperty("declarations");
  });

  it("preserves the valid optional extension without treating an edit as attestation", () => {
    const draft = {
      ...validationDraft("project"),
      declarations: { version: 1, items: [declaration()] },
    };
    expect(validateStoredDraft(draft)).toEqual(draft);
  });

  it.each([
    null,
    { version: 2, items: [] },
    { version: 1, items: [declaration(), declaration()] },
    { version: 1, items: [{ ...declaration(), lineId: "outside" }] },
    {
      version: 1,
      items: [{ ...declaration(), observationId: "observation-create" }],
    },
    { version: 1, items: [{ ...declaration(), value: 25 }] },
    {
      version: 1,
      items: [{ ...declaration(), attestedAt: "2026-02-30T00:00:00.000Z" }],
    },
    { version: 1, items: [{ ...declaration(), origin: "USER_ATTESTATION" }] },
  ])(
    "fails closed for malformed or out-of-scope declarations: %j",
    (declarations) => {
      expect(() =>
        validateStoredDraft({ ...validationDraft("project"), declarations }),
      ).toThrow();
    },
  );
});
