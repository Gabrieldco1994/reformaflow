require("../../../../../scripts/test-db-env.cjs");

import type {
  ExpenseScheduleV1,
  ImportSessionDraftLineV1,
} from "@reformaflow/domain";
import type { StoredImportObservationEvidenceV1 as Evidence } from "./import-session.observation";
import type { DocumentaryCycle } from "../../expense/documented-schedule.types";
import { fileContentHash } from "../../credit-card/parsers/dedupe-key";
import { createHash } from "node:crypto";
import type { ImportObservation } from "@prisma/client";
import { extractCardStatementDocument } from "../../credit-card/parsers/statement-document";
import type {
  ImportMaterializationInput,
  ImportMaterializationPlan,
} from "./import-session.extraction";

interface Helpers {
  buildImportMaterialization(
    input: ImportMaterializationInput,
  ): ImportMaterializationPlan;
  readImportObservationCycle(
    artifact: ImportMaterializationInput["artifact"],
    observation: ImportObservation,
    extraction: ImportMaterializationInput["extraction"],
  ): DocumentaryCycle | null;
  createImportObservationCycleReader(
    artifact: ImportMaterializationInput["artifact"],
    extraction: ImportMaterializationInput["extraction"],
  ): (observation: ImportObservation) => DocumentaryCycle | null;
  hasIncompleteOriginalIdentity(value: Evidence): boolean;
  isWholePurchaseObservation(value: Evidence): boolean;
  hasIncompleteCreateOccurrence(value: Evidence): boolean;
  hasIncompleteKeepOccurrence(value: Evidence): boolean;
  importReviewBlockers(
    lines: readonly ImportSessionDraftLineV1[],
    evidence: ReadonlyMap<string, Evidence>,
  ): Array<{ lineId: string; code: string }>;
  importFileContentHash(sha: string): string;
  checkImportObservationCycle(
    cycle: DocumentaryCycle | null,
    schedule: ExpenseScheduleV1,
    boundIndex: number | null,
  ): { kind: string; reason?: string; occurrenceIndex?: number };
}
const subject = () =>
  jest.requireActual<Helpers>("./import-session.extraction");
const original = (extra: Partial<Evidence> = {}): Evidence => ({
  version: 1,
  reference: "csv:record:2",
  text: "Compra",
  amountMeaning: "INSTALLMENT_CHARGE",
  amountCents: 10000,
  installmentCount: 3,
  installmentIndex: 2,
  dataCompra: "2026-06-22",
  identity: {
    merchant: "Loja",
    ordinal: 0,
    fitId: "fitid",
    externalId: null,
    fileContentHash: "a".repeat(32),
  },
  ...extra,
});

function materializationInput(count = 2): ImportMaterializationInput {
  const bytes = Buffer.from(
    "date,title,amount\n" +
      Array.from({ length: count }, () => "2026-06-22,LOJA,100.00\n").join(""),
  );
  const extraction = extractCardStatementDocument({
    version: 1,
    context: "CARD_INVOICE",
    format: "CSV",
    profile: "CSV_NUBANK",
    bytes,
  });
  const now = new Date("2026-10-01T12:00:00.000Z");
  const scope = { tenantId: "tenant", ownerProjectId: "project" };
  return {
    session: { id: "session", revision: 1, ...scope },
    artifact: {
      id: "artifact",
      ...scope,
      documentSha256: createHash("sha256").update(bytes).digest("hex"),
      verifiedBytes: bytes.length,
      detectedFormat: "CSV",
      state: "EXTRACTED",
      storageKey: null,
      parserVersion: extraction.parserVersion,
      extractionJson: JSON.stringify(extraction),
      parseGeneration: 1,
      leaseSessionId: "session",
      leaseSessionVersion: 0,
      leaseTokenExpiresAt: now,
      leaseExpiresAt: now,
      createdAt: now,
      updatedAt: now,
    },
    attachment: {
      id: "attachment",
      ...scope,
      sessionId: "session",
      artifactId: "artifact",
      position: 0,
      fileName: "synthetic.csv",
      declaredMime: "text/csv",
      declaredBytes: bytes.length,
      state: "ATTACHED",
      temporaryStorageKey: null,
      reservedBytes: 0,
      uploadGeneration: 1,
      uploadSessionVersion: null,
      uploadTokenExpiresAt: null,
      uploadLeaseExpiresAt: null,
      verifiedAt: now,
      releasedAt: null,
      temporaryPurgePending: false,
      createdAt: now,
      updatedAt: now,
    },
    extraction,
    draft: {
      version: 1,
      lines: [],
      selectedLineIds: [],
      questions: [],
      scope: {
        observationIds: [],
        pendingAttachmentIds: ["attachment", "other-attachment"],
      },
    },
    observations: [],
    newIds: new Map(
      extraction.occurrences.map((o, index) => [
        o.reference,
        { observationId: `observation-${index}`, lineId: `line-${index}` },
      ]),
    ),
  };
}
function storedObservations(
  plan: ImportMaterializationPlan,
): ImportObservation[] {
  return plan.observations.map((row) => ({
    ...row,
    claimVersion: 0,
    canonicalProjectId: null,
    canonicalExpenseId: null,
    canonicalReceiptId: null,
    canonicalIndex: null,
    claimSessionId: null,
    claimReceiptJson: null,
    claimedAt: null,
    createdAt: new Date("2026-10-01T12:00:00.000Z"),
  }));
}

describe("X3 pure materialization is atomic planning, not financial execution", () => {
  it("selects each genuinely new purchase once in document order", () => {
    const plan = subject().buildImportMaterialization(materializationInput());

    expect(plan.draft.lines.map((line) => line.id)).toEqual([
      "line-0",
      "line-1",
    ]);
    expect(plan.draft.selectedLineIds).toEqual(["line-0", "line-1"]);
    expect(new Set(plan.draft.selectedLineIds).size).toBe(2);
    expect(
      new Set(plan.draft.lines.flatMap((line) => line.observationIds)).size,
    ).toBe(2);
  });

  it("never selects an invoice payment ignored by policy", () => {
    const input = materializationInput(1);
    input.extraction = {
      ...input.extraction,
      occurrences: input.extraction.occurrences.map((occurrence) => ({
        ...occurrence,
        raw: { ...occurrence.raw, description: "PAGAMENTO EFETUADO" },
      })),
    };
    const plan = subject().buildImportMaterialization(input);

    expect(plan.draft.lines[0]).toMatchObject({
      decision: {
        kind: "IGNORED_POLICY",
        reason: "INVOICE_PAYMENT",
      },
    });
    expect(plan.draft.selectedLineIds).toEqual([]);
  });

  it.each([0, 1, 2])(
    "%i already-claimed rows remain claimed and never rehydrate",
    (claimed) => {
      const input = materializationInput();
      input.observations = storedObservations(
        subject().buildImportMaterialization(input),
      ).map((row, index) =>
        index >= claimed
          ? row
          : {
              ...row,
              claimVersion: 1,
              canonicalProjectId: "project",
              canonicalExpenseId: "canonical",
              claimSessionId: "previous",
              claimReceiptJson: "{}",
              claimedAt: new Date("2026-10-01"),
            },
      );
      const before = structuredClone({ ...input, newIds: [...input.newIds] });
      const plan = subject().buildImportMaterialization(input);
      expect(plan.observations).toEqual([]);
      expect(plan.draft.lines).toHaveLength(2 - claimed);
      expect(plan.draft.selectedLineIds).toEqual(
        ["line-0", "line-1"].slice(claimed),
      );
      expect(plan.draft.scope.observationIds).toEqual(
        ["observation-0", "observation-1"].slice(claimed),
      );
      expect(plan.draft.scope.pendingAttachmentIds).toEqual([
        "other-attachment",
      ]);
      expect({ ...input, newIds: [...input.newIds] }).toEqual(before);
    },
  );

  it("converges shared evidence without overwriting presentation or human edits", () => {
    const input = materializationInput();
    const first = subject().buildImportMaterialization(input);
    input.observations = storedObservations(first);
    input.draft = first.draft;
    input.draft.scope.pendingAttachmentIds.push("attachment");
    input.draft.lines[0]!.titulo = "Human edit";
    input.draft.selectedLineIds = ["line-0"];
    const before = structuredClone({ ...input, newIds: [...input.newIds] });
    const plan = subject().buildImportMaterialization(input);
    expect(plan.observations).toEqual([]);
    expect(plan.draft.lines).toEqual(before.draft.lines);
    expect(plan.draft.selectedLineIds).toEqual(["line-0"]);
    expect(plan.draft.questions).toEqual(before.draft.questions);
    expect({ ...input, newIds: [...input.newIds] }).toEqual(before);
  });

  it("does not resurrect a human-removed selection on replay", () => {
    const input = materializationInput();
    const first = subject().buildImportMaterialization(input);
    input.observations = storedObservations(first);
    input.draft = first.draft;
    input.draft.selectedLineIds = [];
    input.draft.scope.pendingAttachmentIds.push("attachment");

    const replay = subject().buildImportMaterialization(input);

    expect(replay.observations).toEqual([]);
    expect(replay.draft.lines).toEqual(first.draft.lines);
    expect(replay.draft.selectedLineIds).toEqual([]);
  });

  it("factual conflict never overwrites existing observations or returns a partial plan", () => {
    const input = materializationInput();
    const rows = storedObservations(
      subject().buildImportMaterialization(input),
    );
    rows[0]!.evidenceJson = rows[0]!.evidenceJson.replace(
      '"amountCents":10000',
      '"amountCents":10001',
    );
    input.observations = rows;
    expect(() => subject().buildImportMaterialization(input)).toThrow(
      expect.objectContaining({ code: "REVIEW_REQUIRED" }),
    );
  });

  it.each([1999, 2000])(
    "honors the 2000-observation scope boundary from %i existing rows",
    (existing) => {
      const input = materializationInput(1);
      input.draft.scope.observationIds = Array.from(
        { length: existing },
        (_, i) => `existing-${i}`,
      );
      if (existing === 1999) {
        expect(
          subject().buildImportMaterialization(input).draft.scope
            .observationIds,
        ).toHaveLength(2000);
      } else {
        expect(() => subject().buildImportMaterialization(input)).toThrow(
          expect.objectContaining({ code: "LIMIT_EXCEEDED" }),
        );
      }
    },
  );

  it("enforces the 1 MiB resulting-draft budget without altering the valid input", () => {
    const input = materializationInput(1);
    const existingLine = {
      ...line(decisions[2]!),
      id: "existing",
      observationIds: ["existing-observation"],
    };
    input.draft.lines = [existingLine];
    input.draft.scope.observationIds = ["existing-observation"];
    const question = {
      id: "question-0000",
      lineIds: ["existing"],
      field: "decision" as const,
      text: "x".repeat(500),
    };
    const baseBytes = Buffer.byteLength(JSON.stringify(input.draft));
    const unitBytes = Buffer.byteLength(JSON.stringify(question)) + 1;
    const count = Math.floor((1_048_576 - baseBytes) / unitBytes);
    input.draft.questions = Array.from({ length: count }, (_, index) => ({
      ...question,
      id: `question-${String(index).padStart(4, "0")}`,
    }));
    const before = JSON.stringify(input.draft);
    expect(Buffer.byteLength(before)).toBeLessThanOrEqual(1_048_576);
    expect(1_048_576 - Buffer.byteLength(before)).toBeLessThan(unitBytes);
    expect(() => subject().buildImportMaterialization(input)).toThrow(
      expect.objectContaining({ code: "LIMIT_EXCEEDED" }),
    );
    expect(JSON.stringify(input.draft)).toBe(before);
  });

  it("an indexed cycle reader retains distinct references and checks scope on every lookup", () => {
    const input = materializationInput(2);
    const observations = storedObservations(
      subject().buildImportMaterialization(input),
    );
    const read = subject().createImportObservationCycleReader(input.artifact, {
      ...input.extraction,
      occurrences: input.extraction.occurrences.map((occurrence, index) => ({
        ...occurrence,
        cycle:
          index === 0
            ? { invoiceDueMonth: "2026-11", reference: "csv:record:2" }
            : null,
      })),
    });
    expect(read(observations[0]!)).toEqual({
      invoiceDueMonth: "2026-11",
      evidence: {
        documentSha256: input.artifact.documentSha256,
        reference: "csv:record:2",
      },
    });
    expect(read(observations[1]!)).toBeNull();
    for (const field of [
      "tenantId",
      "ownerProjectId",
      "artifactId",
      "reference",
    ] as const)
      expect(() => read({ ...observations[0]!, [field]: "other" })).toThrow();
  });

  it("cycle read requires the exact authorized artifact/reference, never a missing-ref null", () => {
    const input = materializationInput(1);
    const observation = storedObservations(
      subject().buildImportMaterialization(input),
    )[0]!;
    expect(
      subject().readImportObservationCycle(
        input.artifact,
        observation,
        input.extraction,
      ),
    ).toBeNull();
    expect(() =>
      subject().readImportObservationCycle(
        input.artifact,
        { ...observation, tenantId: "other" },
        input.extraction,
      ),
    ).toThrow();
    expect(() =>
      subject().readImportObservationCycle(
        input.artifact,
        { ...observation, reference: "csv:record:999" },
        input.extraction,
      ),
    ).toThrow();
    expect(() =>
      subject().readImportObservationCycle(input.artifact, observation, {
        ...input.extraction,
        occurrences: [
          input.extraction.occurrences[0]!,
          input.extraction.occurrences[0]!,
        ],
      }),
    ).toThrow();
  });
});
const line = (
  decision: ImportSessionDraftLineV1["decision"],
): ImportSessionDraftLineV1 => ({
  id: "line",
  observationIds: ["o"],
  titulo: "Informado",
  fornecedor: "Informado",
  tipoDespesa: null,
  categoriaMaoDeObra: null,
  amountMeaning: "TOTAL_PURCHASE",
  amountCents: 30000,
  installmentCount: 3,
  dataCompra: "2026-06-22",
  firstDueDate: "2026-10-10",
  targets: null,
  decision,
});
const decisions: ImportSessionDraftLineV1["decision"][] = [
  { kind: "CREATE", acceptNaturalDuplicate: false },
  { kind: "KEEP_EXISTING", expenseId: "expense" },
  { kind: "UNRESOLVED" },
];

describe("X3 documentary predicates, never financial compatibility", () => {
  it.each([
    [
      "whole unknown count",
      original({
        amountMeaning: "TOTAL_PURCHASE",
        installmentCount: null,
        installmentIndex: null,
      }),
      [false, true, false],
    ],
    [
      "whole count 3",
      original({ amountMeaning: "TOTAL_PURCHASE", installmentIndex: null }),
      [false, true, false],
    ],
    [
      "single charge",
      original({ installmentCount: 1, installmentIndex: null }),
      [false, false, false],
    ],
    [
      "unbound charge",
      original({ installmentIndex: null }),
      [true, true, true],
    ],
    [
      "unknown meaning",
      original({ amountMeaning: "UNKNOWN" }),
      [true, true, true],
    ],
    ["unknown charge", original({ amountCents: null }), [true, true, true]],
    ["known facts", original(), [false, false, false]],
  ] as const)(
    "%s uses the mediated decision table",
    (_name, evidence, expected) => {
      expect(
        decisions.map((decision) =>
          subject()
            .importReviewBlockers([line(decision)], new Map([["o", evidence]]))
            .some(
              (blocker) => blocker.code === "ORIGINAL_OCCURRENCE_INCOMPLETE",
            ),
        ),
      ).toEqual(expected);
    },
  );

  it.each(["date", "amount", "merchant", "ordinal"] as const)(
    "%s missing remains original identity missing despite draft/FITID",
    (field) => {
      const evidence = original();
      if (field === "date") evidence.dataCompra = null;
      if (field === "amount") evidence.amountCents = null;
      if (field === "merchant") evidence.identity.merchant = null;
      if (field === "ordinal") evidence.identity.ordinal = null;
      for (const decision of decisions) {
        expect(
          subject().importReviewBlockers(
            [line(decision)],
            new Map([["o", evidence]]),
          ),
        ).toContainEqual({
          lineId: "line",
          code: "ORIGINAL_IDENTITY_INCOMPLETE",
        });
      }
    },
  );

  it("whole CREATE exemption never erases independent missing identity", () => {
    const evidence = original({
      amountMeaning: "TOTAL_PURCHASE",
      amountCents: null,
      installmentIndex: null,
    });
    expect(
      subject().importReviewBlockers(
        [line(decisions[0]!)],
        new Map([["o", evidence]]),
      ),
    ).toEqual([{ lineId: "line", code: "ORIGINAL_IDENTITY_INCOMPLETE" }]);
  });

  it("aggregates across every observation and emits each code only once", () => {
    const current = { ...line(decisions[2]!), observationIds: ["o", "p", "q"] };
    const evidence = original({
      amountMeaning: "TOTAL_PURCHASE",
      installmentIndex: null,
    });
    const unknown = original({ installmentCount: null, amountCents: null });
    expect(
      subject().importReviewBlockers(
        [current],
        new Map([
          ["o", evidence],
          ["p", unknown],
          ["q", unknown],
        ]),
      ),
    ).toEqual([
      { lineId: "line", code: "ORIGINAL_IDENTITY_INCOMPLETE" },
      { lineId: "line", code: "ORIGINAL_OCCURRENCE_INCOMPLETE" },
    ]);
  });

  it("known but incompatible facts are not missing facts", () => {
    expect(
      subject().importReviewBlockers(
        [line(decisions[1]!)],
        new Map([["o", original({ installmentCount: 99, amountCents: -10 })]]),
      ),
    ).toEqual([]);
  });

  it("single-file legacy hash hashes the textual SHA again", () => {
    const bytes = Buffer.from("synthetic twins");
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(subject().importFileContentHash(sha)).toBe(fileContentHash([bytes]));
    expect(subject().importFileContentHash(sha)).not.toBe(sha.slice(0, 32));
  });
});

describe("X3 B2 documentary cycle", () => {
  const cycle: DocumentaryCycle = {
    invoiceDueMonth: "2026-11",
    evidence: {
      documentSha256: "a".repeat(64),
      reference: "pdf:page:1:line:1",
    },
  };
  const schedule: ExpenseScheduleV1 = {
    version: 1,
    occurrences: [
      {
        index: 0,
        parcela: "2/3",
        valor: 10000,
        data: "2026-11-10",
        invoiceDueMonth: "2026-11",
      },
      {
        index: 1,
        parcela: "3/3",
        valor: 10000,
        data: "2026-12-10",
        invoiceDueMonth: "2026-12",
      },
    ],
  };
  it("compares canonical zero for printed 2/3 without rewriting the schedule", () => {
    const before = structuredClone(schedule);
    expect(subject().checkImportObservationCycle(cycle, schedule, 0)).toEqual({
      kind: "MATCH",
      occurrenceIndex: 0,
    });
    expect(subject().checkImportObservationCycle(cycle, schedule, 1)).toEqual({
      kind: "NEEDS_INPUT",
      reason: "MISMATCH",
    });
    expect(schedule).toEqual(before);
  });
  it("unknown stays unknown, and whole multi-occurrence never chooses first", () => {
    expect(subject().checkImportObservationCycle(null, schedule, null)).toEqual(
      { kind: "NOT_DOCUMENTED" },
    );
    expect(
      subject().checkImportObservationCycle(cycle, schedule, null),
    ).toEqual({ kind: "NEEDS_INPUT", reason: "UNBOUND" });
    expect(
      subject().checkImportObservationCycle(
        cycle,
        { version: 1, occurrences: [schedule.occurrences[0]!] },
        null,
      ),
    ).toEqual({ kind: "MATCH", occurrenceIndex: 0 });
    expect(
      subject().checkImportObservationCycle(
        cycle,
        {
          version: 1,
          occurrences: [{ ...schedule.occurrences[0]!, invoiceDueMonth: null }],
        },
        0,
      ),
    ).toEqual({ kind: "NEEDS_INPUT", reason: "MISSING_SCHEDULE_CYCLE" });
  });
});
