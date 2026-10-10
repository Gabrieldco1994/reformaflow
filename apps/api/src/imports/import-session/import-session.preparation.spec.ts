require("../../../../../scripts/test-db-env.cjs");

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  ImportArtifact,
  ImportSession,
  ImportSessionArtifact,
} from "@prisma/client";
import {
  ExpenseType,
  type ImportSessionProposalV1,
  type ImportSessionStoredDraftV1,
} from "@reformaflow/domain";
import { canonical } from "../../common/canonical";
import type { PreparedCardBatch } from "./import-session.contract";
import { ImportSessionCorruptStateError } from "./import-session.errors";
import { validateStoredDraft } from "./import-session.validation";

type Session = Pick<
  ImportSession,
  | "id"
  | "tenantId"
  | "ownerProjectId"
  | "cardId"
  | "revision"
  | "confirmedRevision"
  | "expiresAt"
>;
type Observation = {
  id: string;
  tenantId: string;
  ownerProjectId: string;
  artifactId: string;
  claimVersion: number;
};
type Reference = {
  ref: Pick<
    ImportSessionArtifact,
    | "id"
    | "tenantId"
    | "ownerProjectId"
    | "sessionId"
    | "artifactId"
    | "position"
    | "state"
    | "uploadGeneration"
  >;
  artifact: Pick<
    ImportArtifact,
    "id" | "tenantId" | "ownerProjectId" | "documentSha256" | "state"
  > | null;
};
type Body = Omit<
  ImportSessionProposalV1,
  | "proposalHash"
  | "deferredObservationIds"
  | "deferredAttachmentIds"
  | "retainUntil"
>;
interface Input {
  session: Session;
  draft: ImportSessionStoredDraftV1;
  proposalBody: Body;
  observations: Observation[];
  references: Reference[];
}
interface Plan {
  proposal: ImportSessionProposalV1;
  continuation: {
    deferredObservations: readonly { id: string; claimVersion: number }[];
    refs: readonly {
      refId: string;
      refState: "ATTACHED" | "FAILED";
      uploadGeneration: number;
      artifactId: string | null;
      artifactSha256: string | null;
      phase: "NOT_EXTRACTED" | "EXTRACTED" | "FAILED" | "UNAVAILABLE";
    }[];
    writeCostUpperBound: number;
  };
  transferRefIds: readonly string[];
  leaseCleanupArtifactIds: readonly string[];
  continuationDraft: ImportSessionStoredDraftV1 | null;
  expandedCounts: PreparedCardBatch["expandedCounts"];
}
type Build = (input: Input) => Plan;

function builder(): Build {
  const path = join(__dirname, "import-session.preparation.ts");
  expect({ path, exists: existsSync(path) }).toEqual({ path, exists: true });
  const module: typeof import("./import-session.preparation") = require("./import-session.preparation");
  expect(typeof module.buildImportPreparationPlan).toBe("function");
  return module.buildImportPreparationPlan;
}

function reference(
  id = "ref-main",
  artifactId = "artifact-main",
  position = 0,
): Reference {
  return {
    ref: {
      id,
      tenantId: "tenant",
      ownerProjectId: "pessoal",
      sessionId: "session",
      artifactId,
      position,
      state: "ATTACHED",
      uploadGeneration: 2,
    },
    artifact: {
      id: artifactId,
      tenantId: "tenant",
      ownerProjectId: "pessoal",
      documentSha256: "a".repeat(64),
      state: "EXTRACTED",
    },
  };
}

function fixture(lines = 2, installments = 10, claims = lines): Input {
  const observations: Observation[] = Array.from(
    { length: claims },
    (_, index) => ({
      id: `obs-${String(index).padStart(3, "0")}`,
      tenantId: "tenant",
      ownerProjectId: "pessoal",
      artifactId: "artifact-main",
      claimVersion: 0,
    }),
  );
  const schedule = {
    version: 1 as const,
    occurrences: Array.from({ length: installments }, (_, index) => {
      const data = new Date(Date.UTC(2026, 10 + index, 10))
        .toISOString()
        .slice(0, 10);
      return {
        index,
        parcela: `${index + 1}/${installments}`,
        valor: 6984,
        data,
        invoiceDueMonth: data.slice(0, 7),
      };
    }),
  };
  const totalCents = 6984 * installments;
  const draft: ImportSessionStoredDraftV1 = {
    version: 1,
    lines: Array.from({ length: lines }, (_, index) => ({
      id: `line-${index}`,
      observationIds: observations
        .filter((_, n) => n % lines === index)
        .map((row) => row.id),
      titulo: "Approved purchase",
      fornecedor: null,
      tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
      categoriaMaoDeObra: null,
      amountMeaning: "TOTAL_PURCHASE",
      amountCents: totalCents,
      installmentCount: installments,
      dataCompra: "2026-10-05",
      firstDueDate: "2026-11-10",
      targets: [
        { projectId: "reforma", roomId: null, amountCents: totalCents },
      ],
      decision: { kind: "CREATE", acceptNaturalDuplicate: false },
    })),
    selectedLineIds: Array.from(
      { length: lines },
      (_, index) => `line-${index}`,
    ),
    questions: [],
    scope: {
      observationIds: observations.map((row) => row.id),
      pendingAttachmentIds: [],
    },
  };
  const proposalBody: Body = {
    version: 1,
    kind: "CREATE_CARD_PURCHASES",
    sessionId: "session",
    revision: 8,
    lines: draft.lines.map((line) => ({
      kind: "CREATE",
      lineId: line.id,
      titulo: line.titulo,
      fornecedor: null,
      tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
      categoriaMaoDeObra: null,
      dataCompra: "2026-10-05",
      totalCents,
      schedule: structuredClone(schedule),
      targets: [
        {
          projectId: "reforma",
          roomId: null,
          amountCents: totalCents,
          schedule: structuredClone(schedule),
        },
      ],
    })),
    noWriteRows: [],
    effects: {
      personalSourceCreates: lines,
      reformaTargetCreates: lines,
      expenseCreates: lines * 2,
      cashFlowEntryCreates: lines * installments * 2,
      rateioAllocationCreates: lines,
      keptExistingCount: 0,
      deferredCount: 0,
      excludedCount: 0,
      ignoredCount: 0,
    },
    createdEconomicTotalCents: totalCents * lines,
    bankCashDeltaCents: 0,
    invoiceDeltas: schedule.occurrences.map((item) => ({
      invoiceDueMonth: item.invoiceDueMonth,
      amountCents: item.valor * lines,
    })),
  };
  return {
    session: {
      id: "session",
      tenantId: "tenant",
      ownerProjectId: "pessoal",
      cardId: "card",
      revision: 7,
      confirmedRevision: null,
      expiresAt: new Date("2026-10-13T15:00:00.000Z"),
    },
    draft,
    proposalBody,
    observations,
    references: [reference()],
  };
}

function addPending(input: Input, state = "RAW_READY"): void {
  const ref = reference("ref-pending", "artifact-pending", 1);
  if (!ref.artifact) throw new Error("Expected artifact fixture");
  ref.artifact.state = state;
  input.references.push(ref);
  input.draft.scope.pendingAttachmentIds.push(ref.ref.id);
}

describe("shared pure AC18 preparation contract", () => {
  it("CONTROL: the literal boundary fixture is a valid draft with at most 20 observations per line", () => {
    const input = fixture(10, 12, 188);
    expect(validateStoredDraft(input.draft)).toEqual(input.draft);
    expect(input.draft.lines.map((line) => line.observationIds.length)).toEqual(
      [19, 19, 19, 19, 19, 19, 19, 19, 18, 18],
    );
  });

  it("exports the actual shared pure builder", () => {
    builder();
  });

  it("rejects the old flat reference shape instead of accepting two input contracts", () => {
    const build = builder();
    const input = fixture();
    expect(build(input).expandedCounts.financialAndCoordinationWrites).toBe(62);
    const { ref, artifact } = input.references[0];
    Object.assign(input, { references: [{ ...ref, artifact }] });
    expect(() => build(input)).toThrow(ImportSessionCorruptStateError);
  });

  it("rejects invalid or imitated dates without calling a supplied date formatter", () => {
    const build = builder();
    const input = fixture();
    const toISOString = jest.fn(() => "2026-10-13T15:00:00.000Z");
    for (const expiresAt of [
      new Date(NaN),
      null,
      "2026-10-13T15:00:00.000Z",
      { toISOString },
    ]) {
      Object.assign(input.session, { expiresAt });
      expect(() => build(input)).toThrow(ImportSessionCorruptStateError);
    }
    expect(toISOString).not.toHaveBeenCalled();
  });

  it("pins the twins at 62 and hashes the exact AC18 preimage, not operational lists", () => {
    const build = builder();
    const input = fixture();
    const plan = build(input);
    const continuation = {
      deferredObservations: [],
      refs: [],
      writeCostUpperBound: 62,
    };
    const proposal = {
      ...input.proposalBody,
      deferredObservationIds: [],
      deferredAttachmentIds: [],
      retainUntil: null,
    };
    const hash = createHash("sha256")
      .update(canonical({ proposal, continuation }))
      .digest("hex");
    expect(plan.proposal).toEqual({ ...proposal, proposalHash: hash });
    expect(plan.continuation).toEqual(continuation);
    expect(plan.expandedCounts).toEqual({
      cashFlowEntries: 40,
      financialAndCoordinationWrites: 62,
    });
    expect(plan.transferRefIds).toEqual([]);
    expect(plan.leaseCleanupArtifactIds).toEqual(["artifact-main"]);
    expect(plan.continuationDraft).toBeNull();
  });

  it("pins the pending-attachment example at 65, preserves the exact inherited deadline", () => {
    const build = builder();
    const input = fixture();
    addPending(input);
    const plan = build(input);
    expect(plan.expandedCounts).toEqual({
      cashFlowEntries: 40,
      financialAndCoordinationWrites: 65,
    });
    expect(plan.proposal.deferredAttachmentIds).toEqual(["ref-pending"]);
    expect(plan.proposal.retainUntil).toBe("2026-10-13T15:00:00.000Z");
    expect(plan.transferRefIds).toEqual(["ref-pending"]);
    expect(plan.leaseCleanupArtifactIds).toEqual([
      "artifact-main",
      "artifact-pending",
    ]);
    expect(plan.continuationDraft).toEqual({
      version: 1,
      lines: [],
      selectedLineIds: [],
      questions: [],
      scope: { observationIds: [], pendingAttachmentIds: ["ref-pending"] },
    });
  });

  it.each([
    [188, 512],
    [189, 513],
    [200, 524],
  ])("derives the real C=%i boundary (%i writes)", (claims, expected) => {
    const build = builder();
    const input = fixture(10, 12, claims);
    if (expected === 512) {
      expect(build(input).expandedCounts).toEqual({
        cashFlowEntries: 240,
        financialAndCoordinationWrites: 512,
      });
    } else {
      expect(() => build(input)).toThrow(
        expect.objectContaining({
          code: "LIMIT_EXCEEDED",
          reason: "WRITE_BUDGET_EXCEEDED",
        }),
      );
    }
  });

  it("counts target occurrences too: 240 passes and 241 fails before the write-budget ceiling", () => {
    const build = builder();
    const input = fixture(10, 12, 10);
    expect(build(input).expandedCounts).toEqual({
      cashFlowEntries: 240,
      financialAndCoordinationWrites: 334,
    });
    const line = input.proposalBody.lines[0];
    if (line.kind !== "CREATE") throw new Error("Expected CREATE fixture");
    line.targets[0].schedule.occurrences.push({
      index: 12,
      parcela: null,
      valor: 0,
      data: "2027-11-10",
      invoiceDueMonth: "2027-11",
    });
    expect(() => build(input)).toThrow(
      expect.objectContaining({ code: "LIMIT_EXCEEDED", reason: null }),
    );
  });

  it("accounts for no-target sources and KEEP without inventing financial writes", () => {
    const build = builder();
    const input = fixture();
    for (const line of input.proposalBody.lines)
      if (line.kind === "CREATE") line.targets = [];
    for (const line of input.draft.lines) line.targets = [];
    expect(build(input).expandedCounts).toEqual({
      cashFlowEntries: 20,
      financialAndCoordinationWrites: 30,
    });
    input.proposalBody.lines = input.proposalBody.lines.map((line) => ({
      kind: "KEEP_EXISTING",
      lineId: line.lineId,
      sourceExpenseId: `existing-${line.lineId}`,
      totalCents: line.totalCents,
      schedule: line.schedule,
    }));
    for (const line of input.draft.lines)
      line.decision = {
        kind: "KEEP_EXISTING",
        expenseId: `existing-${line.id}`,
      };
    input.proposalBody.createdEconomicTotalCents = 0;
    input.proposalBody.invoiceDeltas = [];
    expect(build(input).expandedCounts).toEqual({
      cashFlowEntries: 0,
      financialAndCoordinationWrites: 6,
    });
  });

  it("preserves deferred observations without editable lines and binds their claim versions", () => {
    const build = builder();
    const input = fixture();
    input.observations.push({
      ...input.observations[0],
      id: "obs-deferred",
      claimVersion: 7,
    });
    input.draft.scope.observationIds.push("obs-deferred");
    const plan = build(input);
    expect(plan.continuation.deferredObservations).toEqual([
      { id: "obs-deferred", claimVersion: 7 },
    ]);
    expect(plan.transferRefIds).toEqual(["ref-main"]);
    expect(plan.continuationDraft?.scope.observationIds).toEqual([
      "obs-deferred",
    ]);
    expect(plan.continuationDraft?.lines).toEqual([]);
    input.observations[2].claimVersion = 8;
    expect(build(input).proposal.proposalHash).not.toBe(
      plan.proposal.proposalHash,
    );
  });

  it("copies only whole remaining lines and whole questions, never shrinks a prompt's scope", () => {
    const build = builder();
    const input = fixture();
    input.observations.push({ ...input.observations[0], id: "obs-deferred" });
    input.draft.scope.observationIds.push("obs-deferred");
    input.draft.lines.push(
      {
        ...structuredClone(input.draft.lines[0]),
        id: "remaining",
        observationIds: ["obs-deferred"],
      },
      {
        ...structuredClone(input.draft.lines[0]),
        id: "overlapping",
        observationIds: ["obs-000", "obs-deferred"],
      },
    );
    input.draft.questions = [
      {
        id: "keep-question",
        lineIds: ["remaining"],
        field: "targets",
        text: "Keep exactly this scope?",
      },
      {
        id: "mixed-question",
        lineIds: ["line-0", "remaining"],
        field: "targets",
        text: "Do not rewrite me",
      },
      {
        id: "overlap-question",
        lineIds: ["overlapping"],
        field: "targets",
        text: "Also do not rewrite",
      },
    ];
    input.draft.declarations = {
      version: 1,
      items: [
        {
          lineId: "remaining",
          observationId: "obs-deferred",
          field: "installmentCount",
          value: 10,
          meaningContext: null,
          originalFingerprint: "b".repeat(64),
          claimVersion: 0,
          originSessionId: "session",
          recordedRevision: 7,
          questionId: "keep-question",
          turnId: "11111111-1111-4111-8111-111111111111",
          attestedByUserId: "owner",
          attestedAt: "2026-10-06T15:00:00.000Z",
          literalHash: "c".repeat(64),
        },
        {
          lineId: "line-0",
          observationId: "obs-000",
          field: "installmentCount",
          value: 10,
          meaningContext: null,
          originalFingerprint: "d".repeat(64),
          claimVersion: 0,
          originSessionId: "session",
          recordedRevision: 7,
          questionId: "completed-question",
          turnId: "22222222-2222-4222-8222-222222222222",
          attestedByUserId: "owner",
          attestedAt: "2026-10-06T15:00:00.000Z",
          literalHash: "e".repeat(64),
        },
      ],
    };
    input.draft.fieldProvenance = [
      {
        origin: "FILE",
        lineId: "remaining",
        field: "decision",
        recordedRevision: 7,
      },
      {
        origin: "FILE",
        lineId: "line-0",
        field: "decision",
        recordedRevision: 7,
      },
    ];
    const plan = build(input);
    expect(plan.continuationDraft?.lines.map((line) => line.id)).toEqual([
      "remaining",
    ]);
    expect(plan.continuationDraft?.questions).toEqual([
      input.draft.questions[0],
    ]);
    expect(plan.continuationDraft?.selectedLineIds).toEqual(["remaining"]);
    expect(plan.continuationDraft?.declarations?.items).toEqual([
      input.draft.declarations.items[0],
    ]);
    expect(plan.continuationDraft?.fieldProvenance).toEqual([
      input.draft.fieldProvenance[0],
    ]);
    expect(plan.continuationDraft?.lines[0]).toEqual(input.draft.lines[2]);
    expect(() =>
      validateStoredDraft(structuredClone(plan.continuationDraft)),
    ).not.toThrow();
  });

  it("server-selects remaining resumable lines in draft order up to the lot limit", () => {
    const build = builder();
    const input = fixture();
    for (let index = 0; index < 12; index += 1) {
      const observation = {
        ...input.observations[0],
        id: `obs-remaining-${String(index).padStart(2, "0")}`,
      };
      input.observations.push(observation);
      input.draft.scope.observationIds.push(observation.id);
      input.draft.lines.push({
        ...structuredClone(input.draft.lines[0]),
        id: `remaining-${String(index).padStart(2, "0")}`,
        observationIds: [observation.id],
        decision: { kind: "UNRESOLVED" },
        targets: null,
      });
    }

    const continuation = build(input).continuationDraft;
    expect(continuation?.lines.map((line) => line.id)).toEqual(
      Array.from(
        { length: 12 },
        (_, index) => `remaining-${String(index).padStart(2, "0")}`,
      ),
    );
    expect(continuation?.selectedLineIds).toEqual(
      Array.from(
        { length: 10 },
        (_, index) => `remaining-${String(index).padStart(2, "0")}`,
      ),
    );
    expect(() =>
      validateStoredDraft(structuredClone(continuation)),
    ).not.toThrow();
  });

  it("preserves a pending FAILED ref with no artifact without manufacturing an artifact identity", () => {
    const build = builder();
    const input = fixture();
    const failed = reference("ref-failed", "unused", 1);
    failed.ref.state = "FAILED";
    failed.ref.artifactId = null;
    failed.artifact = null;
    input.references.push(failed);
    input.draft.scope.pendingAttachmentIds.push(failed.ref.id);
    const plan = build(input);
    expect(plan.transferRefIds).toEqual(["ref-failed"]);
    expect(plan.continuation.refs).toContainEqual({
      refId: "ref-failed",
      refState: "FAILED",
      uploadGeneration: 2,
      artifactId: null,
      artifactSha256: null,
      phase: "FAILED",
    });
    expect(plan.leaseCleanupArtifactIds).toEqual(["artifact-main"]);
  });

  it("reserves cleanup for every distinct mother artifact, not just the transferred refs", () => {
    const build = builder();
    const input = fixture();
    input.references.push(reference("ref-unused", "artifact-unused", 1));
    const plan = build(input);
    expect(plan.transferRefIds).toEqual([]);
    expect(plan.leaseCleanupArtifactIds).toEqual([
      "artifact-main",
      "artifact-unused",
    ]);
    expect(plan.continuation.writeCostUpperBound).toBe(63);
  });

  it("A and W use the same revision 8/H8 regardless of current revision 7 versus 9", () => {
    const build = builder();
    const input = fixture();
    const prepared = build(input);
    input.session.revision = 9;
    input.session.confirmedRevision = 8;
    expect(build(input)).toEqual(prepared);
    input.proposalBody.revision = 9;
    expect(() => build(input)).toThrow();
  });

  it("sorts input rows, ignores technical lease clocks, and preserves semantic line order", () => {
    const build = builder();
    const input = fixture();
    addPending(input);
    const expected = build(input);
    input.references.reverse();
    input.observations.reverse();
    for (const leaseSessionId of [null, "session", "foreign"]) {
      for (const ref of input.references)
        Object.assign(ref.artifact!, {
          leaseSessionId,
          leaseExpiresAt: new Date(),
          parseGeneration: 55,
          updatedAt: new Date(),
        });
      Object.assign(input.session, {
        updatedAt: new Date(),
        challengeJson: "technical-only",
      });
      expect(build(input)).toEqual(expected);
    }
    input.proposalBody.lines.reverse();
    expect(build(input).proposal.proposalHash).not.toBe(
      expected.proposal.proposalHash,
    );
  });

  it("maps semantic phases and distinguishes material drift from RAW_READY/ANALYZING", () => {
    const build = builder();
    const input = fixture();
    addPending(input);
    const raw = build(input);
    const artifact = input.references[1].artifact!;
    artifact.state = "ANALYZING";
    expect(build(input)).toEqual(raw);
    for (const [state, phase] of [
      ["EXTRACTED", "EXTRACTED"],
      ["FAILED", "FAILED"],
      ["PURGING", "UNAVAILABLE"],
      ["PURGED", "UNAVAILABLE"],
    ]) {
      artifact.state = state;
      const changed = build(input);
      expect(
        changed.continuation.refs.find((ref) => ref.refId === "ref-pending")
          ?.phase,
      ).toBe(phase);
      expect(changed.proposal.proposalHash).not.toBe(raw.proposal.proposalHash);
    }
  });

  it.each(["RESERVED", "UPLOADED"])(
    "rejects %s refs explicitly rather than omitting them",
    (state) => {
      const build = builder();
      const input = fixture();
      addPending(input);
      input.references[1].ref.state = state;
      expect(() => build(input)).toThrow(
        expect.objectContaining({
          code: "LEASE_CONFLICT",
          reason: "ATTACHMENT_IN_FLIGHT",
        }),
      );
    },
  );

  const invalid: Array<[string, (input: Input) => void]> = [
    [
      "empty selected scope",
      (input) => {
        input.draft.selectedLineIds = [];
      },
    ],
    [
      "missing observation",
      (input) => {
        input.observations.pop();
      },
    ],
    [
      "extra observation outside scope",
      (input) => {
        input.observations.push({ ...input.observations[0], id: "unmatched" });
      },
    ],
    [
      "duplicate observation",
      (input) => {
        input.observations.push(input.observations[0]);
      },
    ],
    [
      "foreign observation tenant",
      (input) => {
        input.observations[0].tenantId = "foreign";
      },
    ],
    [
      "foreign observation anchor",
      (input) => {
        input.observations[0].ownerProjectId = "foreign";
      },
    ],
    [
      "unmatched observation artifact",
      (input) => {
        input.observations[0].artifactId = "missing";
      },
    ],
    [
      "negative claim generation",
      (input) => {
        input.observations[0].claimVersion = -1;
      },
    ],
    [
      "missing reference",
      (input) => {
        input.references = [];
      },
    ],
    [
      "foreign reference session",
      (input) => {
        input.references[0].ref.sessionId = "other";
      },
    ],
    [
      "foreign reference tenant",
      (input) => {
        input.references[0].ref.tenantId = "other";
      },
    ],
    [
      "foreign reference anchor",
      (input) => {
        input.references[0].ref.ownerProjectId = "other";
      },
    ],
    [
      "mismatched artifact identity",
      (input) => {
        input.references[0].artifact!.id = "other";
      },
    ],
    [
      "foreign artifact tenant",
      (input) => {
        input.references[0].artifact!.tenantId = "other";
      },
    ],
    [
      "missing artifact object",
      (input) => {
        input.references[0].artifact = null;
      },
    ],
    [
      "duplicate reference",
      (input) => {
        input.references.push(input.references[0]);
      },
    ],
    [
      "unknown artifact phase",
      (input) => {
        input.references[0].artifact!.state = "UNKNOWN";
      },
    ],
    [
      "missing pending reference",
      (input) => {
        input.draft.scope.pendingAttachmentIds = ["missing"];
      },
    ],
    [
      "wrong proposal session",
      (input) => {
        input.proposalBody.sessionId = "other";
      },
    ],
    [
      "missing selected proposal line",
      (input) => {
        input.proposalBody.lines.pop();
      },
    ],
    [
      "revision overflow",
      (input) => {
        input.session.revision = 2147483647;
        input.proposalBody.revision = 2147483647;
      },
    ],
    [
      "injected caller cost",
      (input) => {
        Object.assign(input.proposalBody, { writeCostUpperBound: 1 });
      },
    ],
  ];
  it.each(invalid)("rejects %s without scope repair", (_label, mutate) => {
    const build = builder();
    const input = fixture();
    mutate(input);
    expect(() => build(input)).toThrow();
  });

  it("rejects CREATE unknown cycles, while unknown KEEP schedules remain legal", () => {
    const build = builder();
    const input = fixture();
    input.proposalBody.lines[0].schedule.occurrences[0].invoiceDueMonth = null;
    expect(() => build(input)).toThrow(ImportSessionCorruptStateError);
    const line = input.proposalBody.lines[0];
    input.proposalBody.lines[0] = {
      kind: "KEEP_EXISTING",
      lineId: line.lineId,
      sourceExpenseId: "existing",
      totalCents: line.totalCents,
      schedule: line.schedule,
    };
    input.draft.lines[0].decision = {
      kind: "KEEP_EXISTING",
      expenseId: "existing",
    };
    input.draft.lines[0].targets = [];
    input.proposalBody.createdEconomicTotalCents = 69840;
    input.proposalBody.invoiceDeltas = input.proposalBody.invoiceDeltas.map(
      (delta) => ({ ...delta, amountCents: 6984 }),
    );
    expect(
      build(input).proposal.lines[0].schedule.occurrences[0].invoiceDueMonth,
    ).toBeNull();
  });

  it("returns deep immutable copies with no aliases to caller rows, draft, proposal or dates", () => {
    const build = builder();
    const input = fixture();
    addPending(input);
    const plan = build(input);
    const before = structuredClone(plan);
    const frozen = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      expect(Object.isFrozen(value)).toBe(true);
      Object.values(value).forEach(frozen);
    };
    frozen(plan);
    input.session.expiresAt.setTime(0);
    input.draft.scope.pendingAttachmentIds.length = 0;
    input.proposalBody.lines[0].schedule.occurrences[0].valor = 1;
    input.references[0].artifact!.documentSha256 = "b".repeat(64);
    expect(plan).toEqual(before);
  });
});
