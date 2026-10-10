import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  ImportArtifact,
  ImportObservation,
  ImportSession,
  ImportSessionArtifact,
} from "@prisma/client";
import {
  ExpenseType,
  type ExpenseScheduleV1,
  type ImportSessionDraftLineV1,
  type ImportSessionPlannedCreateV1,
  type ImportSessionProposalV1,
  type ImportSessionStoredDraftV1,
} from "@reformaflow/domain";
import { canonical } from "../../common/canonical";
import type { PreparedCardBatch } from "./import-session.contract";
import {
  ImportSessionCorruptStateError,
  ImportSessionError,
} from "./import-session.errors";
import {
  validateProposal,
  validateStoredDraft,
} from "./import-session.validation";
import { buildImportPreparationPlan } from "./import-session.preparation";

// Pin the approved signature independently so implementation drift is a type error.
type PreparationSession = Pick<
  ImportSession,
  | "id"
  | "tenantId"
  | "ownerProjectId"
  | "cardId"
  | "revision"
  | "confirmedRevision"
  | "expiresAt"
>;
type PreparationObservation = Pick<
  ImportObservation,
  "id" | "tenantId" | "ownerProjectId" | "artifactId" | "claimVersion"
>;
type PreparationReference = {
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
type ProposalBody = Omit<
  ImportSessionProposalV1,
  | "proposalHash"
  | "deferredObservationIds"
  | "deferredAttachmentIds"
  | "retainUntil"
>;
interface PreparationInput {
  session: PreparationSession;
  draft: ImportSessionStoredDraftV1;
  proposalBody: ProposalBody;
  observations: readonly PreparationObservation[];
  references: readonly PreparationReference[];
}
interface ImportPreparationPlanV1 {
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
type BuildPlan = (input: PreparationInput) => ImportPreparationPlanV1;

function loadBuildPlan(): BuildPlan {
  const path = join(__dirname, "import-session.preparation.ts");
  expect({ path, exists: existsSync(path) }).toEqual({ path, exists: true });
  expect(typeof buildImportPreparationPlan).toBe("function");
  return buildImportPreparationPlan;
}

const SESSION_ID = "qa-mother";
const TENANT_ID = "qa-tenant";
const PROJECT_ID = "qa-pessoal";
const EXPIRES_AT = "2026-10-08T05:00:00.000Z";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function reference(
  refId = "ref-source",
  artifactId = "artifact-source",
  state = "EXTRACTED",
  position = 0,
): PreparationReference {
  return {
    ref: {
      id: refId,
      tenantId: TENANT_ID,
      ownerProjectId: PROJECT_ID,
      sessionId: SESSION_ID,
      artifactId,
      position,
      state: "ATTACHED",
      uploadGeneration: 2,
    },
    artifact: {
      id: artifactId,
      tenantId: TENANT_ID,
      ownerProjectId: PROJECT_ID,
      documentSha256: position === 0 ? HASH_A : HASH_B,
      state,
    },
  };
}

function observation(
  id: string,
  artifactId = "artifact-source",
  claimVersion = 0,
): PreparationObservation {
  return {
    id,
    tenantId: TENANT_ID,
    ownerProjectId: PROJECT_ID,
    artifactId,
    claimVersion,
  };
}

function schedule(count: number): ExpenseScheduleV1 {
  return {
    version: 1,
    occurrences: Array.from({ length: count }, (_, index) => {
      const month = String(index + 1).padStart(2, "0");
      return {
        index,
        parcela: `${index + 1}/${count}`,
        valor: 100,
        data: `2027-${month}-10`,
        invoiceDueMonth: `2027-${month}`,
      };
    }),
  };
}

function fixture(
  claimsPerLine: readonly number[] = [1, 1],
  installments = 10,
): PreparationInput {
  const lines: ImportSessionDraftLineV1[] = claimsPerLine.map(
    (count, index) => ({
      id: `line-${index}`,
      observationIds: Array.from(
        { length: count },
        (_, ordinal) => `obs-${index}-${String(ordinal).padStart(2, "0")}`,
      ),
      titulo: `Purchase ${index}`,
      fornecedor: "Original Merchant",
      tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
      categoriaMaoDeObra: null,
      amountMeaning: "TOTAL_PURCHASE",
      amountCents: installments * 100,
      installmentCount: installments,
      dataCompra: "2026-10-01",
      firstDueDate: "2027-01-10",
      targets: [
        {
          projectId: "qa-casa",
          roomId: null,
          amountCents: installments * 100,
        },
      ],
      decision: { kind: "CREATE", acceptNaturalDuplicate: false },
    }),
  );
  const planned: ImportSessionPlannedCreateV1[] = lines.map((line) => ({
    kind: "CREATE",
    lineId: line.id,
    titulo: line.titulo,
    fornecedor: line.fornecedor,
    tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
    categoriaMaoDeObra: null,
    dataCompra: "2026-10-01",
    totalCents: installments * 100,
    schedule: schedule(installments),
    targets: [
      {
        projectId: "qa-casa",
        roomId: null,
        amountCents: installments * 100,
        schedule: schedule(installments),
      },
    ],
  }));
  const observations = lines.flatMap((line) =>
    line.observationIds.map((id) => observation(id)),
  );
  return {
    session: {
      id: SESSION_ID,
      tenantId: TENANT_ID,
      ownerProjectId: PROJECT_ID,
      cardId: "qa-card",
      revision: 7,
      confirmedRevision: null,
      expiresAt: new Date(EXPIRES_AT),
    },
    draft: {
      version: 1,
      lines,
      selectedLineIds: lines.map((line) => line.id),
      questions: [],
      scope: {
        observationIds: observations.map((row) => row.id),
        pendingAttachmentIds: [],
      },
    },
    proposalBody: {
      version: 1,
      kind: "CREATE_CARD_PURCHASES",
      sessionId: SESSION_ID,
      revision: 8,
      lines: planned,
      noWriteRows: [],
      effects: {
        personalSourceCreates: lines.length,
        reformaTargetCreates: lines.length,
        expenseCreates: lines.length * 2,
        cashFlowEntryCreates: lines.length * installments * 2,
        rateioAllocationCreates: lines.length,
        keptExistingCount: 0,
        deferredCount: 0,
        excludedCount: 0,
        ignoredCount: 0,
      },
      createdEconomicTotalCents: installments * 100 * lines.length,
      bankCashDeltaCents: 0,
      invoiceDeltas: schedule(installments).occurrences.map((entry) => ({
        invoiceDueMonth: entry.invoiceDueMonth!,
        amountCents: 100 * lines.length,
      })),
    },
    observations,
    references: [reference()],
  };
}

function withPending(input = fixture(), state = "RAW_READY"): PreparationInput {
  return {
    ...input,
    draft: {
      ...input.draft,
      scope: {
        ...input.draft.scope,
        pendingAttachmentIds: ["ref-pending"],
      },
    },
    references: [
      ...input.references,
      reference("ref-pending", "artifact-pending", state, 1),
    ],
  };
}

function withUneditedObservation(input = fixture()): PreparationInput {
  return {
    ...input,
    draft: {
      ...input.draft,
      scope: {
        ...input.draft.scope,
        observationIds: [...input.draft.scope.observationIds, "obs-deferred"],
      },
    },
    observations: [
      ...input.observations,
      observation("obs-deferred", "artifact-source", 4),
    ],
  };
}

function assertDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  Object.values(value).forEach(assertDeepFrozen);
}

function expectScopeFailure(action: () => unknown): void {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  expect(
    failure instanceof ImportSessionCorruptStateError ||
      failure instanceof ImportSessionError,
  ).toBe(true);
}

function expectReason(action: () => unknown, reason: string): void {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ImportSessionError);
  expect(failure).toMatchObject({ reason, retryable: false });
}

describe("independent turn-9 preparation contract (AC18)", () => {
  it("controls: real 188/189/200-claim fixtures meet existing draft/proposal shapes", () => {
    for (const lastCount of [8, 9, 20]) {
      const input = fixture([...Array<number>(9).fill(20), lastCount], 12);
      expect(validateStoredDraft(input.draft)).toEqual(input.draft);
      expect(input.observations).toHaveLength(180 + lastCount);
      expect(new Set(input.observations.map((row) => row.id)).size).toBe(
        180 + lastCount,
      );
      expect(input.draft.lines).toHaveLength(10);
      expect(
        input.draft.lines.every((line) => line.observationIds.length <= 20),
      ).toBe(true);
      const proposal = {
        ...input.proposalBody,
        proposalHash: HASH_A,
        deferredObservationIds: [],
        deferredAttachmentIds: [],
        retainUntil: null,
      };
      expect(validateProposal(proposal, SESSION_ID, HASH_A)).toEqual(proposal);
      expect(
        proposal.lines.reduce(
          (total, line) =>
            total +
            line.schedule.occurrences.length +
            (line.kind === "CREATE"
              ? line.targets.reduce(
                  (count, target) => count + target.schedule.occurrences.length,
                  0,
                )
              : 0),
          0,
        ),
      ).toBe(240);
    }
  });

  it("exports the actual pure preparation function", () => {
    expect(typeof loadBuildPlan()).toBe("function");
  });

  it("does not consult Date.now, randomUUID or Math.random when preparing", () => {
    const build = loadBuildPlan();
    const input = withPending(withUneditedObservation());
    const crypto: typeof import("node:crypto") = require("node:crypto");
    const clock = jest.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("Preparation must not read the clock");
    });
    const uuid = jest.spyOn(crypto, "randomUUID").mockImplementation(() => {
      throw new Error("Preparation must not mint IDs");
    });
    const random = jest.spyOn(Math, "random").mockImplementation(() => {
      throw new Error("Preparation must not depend on randomness");
    });
    try {
      const plan = build(input);
      expect(plan.proposal.retainUntil).toBe(EXPIRES_AT);
      expect(clock).not.toHaveBeenCalled();
      expect(uuid).not.toHaveBeenCalled();
      expect(random).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
      uuid.mockRestore();
      random.mockRestore();
    }
  });

  it("pins twins S2 T2 P2 N40 C2 K0 R0 L1 to 62, with no continuation", () => {
    const build = loadBuildPlan();
    const input = fixture();
    const plan = build(input);
    const expectedProposal = {
      ...input.proposalBody,
      deferredObservationIds: [],
      deferredAttachmentIds: [],
      retainUntil: null,
    };
    const continuation = {
      deferredObservations: [],
      refs: [],
      writeCostUpperBound: 62,
    };
    const expectedHash = createHash("sha256")
      .update(canonical({ proposal: expectedProposal, continuation }))
      .digest("hex");
    expect(plan).toEqual({
      proposal: { ...expectedProposal, proposalHash: expectedHash },
      continuation,
      transferRefIds: [],
      leaseCleanupArtifactIds: ["artifact-source"],
      continuationDraft: null,
      expandedCounts: {
        cashFlowEntries: 40,
        financialAndCoordinationWrites: 62,
      },
    });
  });

  it("pins pending-reference twins K1 R1 L2 to 65 and the exact H8 preimage", () => {
    const build = loadBuildPlan();
    const input = withPending();
    const plan = build(input);
    const proposal = {
      ...input.proposalBody,
      deferredObservationIds: [],
      deferredAttachmentIds: ["ref-pending"],
      retainUntil: EXPIRES_AT,
    };
    const continuation = {
      deferredObservations: [],
      refs: [
        {
          refId: "ref-pending",
          refState: "ATTACHED",
          uploadGeneration: 2,
          artifactId: "artifact-pending",
          artifactSha256: HASH_B,
          phase: "NOT_EXTRACTED",
        },
      ],
      writeCostUpperBound: 65,
    };
    expect(plan).toEqual({
      proposal: {
        ...proposal,
        proposalHash: createHash("sha256")
          .update(canonical({ proposal, continuation }))
          .digest("hex"),
      },
      continuation,
      transferRefIds: ["ref-pending"],
      leaseCleanupArtifactIds: ["artifact-pending", "artifact-source"],
      continuationDraft: {
        version: 1,
        lines: [],
        selectedLineIds: [],
        questions: [],
        scope: {
          observationIds: [],
          pendingAttachmentIds: ["ref-pending"],
        },
      },
      expandedCounts: {
        cashFlowEntries: 40,
        financialAndCoordinationWrites: 65,
      },
    });
  });

  it("accepts exactly 512: S10 T10 P10 N240 C188 K0 R0 L1", () => {
    const build = loadBuildPlan();
    const input = fixture([...Array<number>(9).fill(20), 8], 12);
    const plan = build(input);
    expect(plan.continuation.writeCostUpperBound).toBe(512);
    expect(plan.expandedCounts).toEqual({
      cashFlowEntries: 240,
      financialAndCoordinationWrites: 512,
    });
    expect(plan.proposal.lines.map((line) => line.lineId)).toEqual(
      input.draft.selectedLineIds,
    );
    expect(plan.proposal.deferredObservationIds).toEqual([]);
    expect(plan.continuationDraft).toBeNull();
  });

  it.each([
    [9, 513],
    [20, 524],
  ])(
    "rejects final claim group %i (literal cost %i), never splits/truncates",
    (last) => {
      const build = loadBuildPlan();
      const input = fixture([...Array<number>(9).fill(20), last], 12);
      const before = structuredClone(input);
      expectReason(() => build(input), "WRITE_BUDGET_EXCEEDED");
      expect(input).toEqual(before);
    },
  );

  it("counts source-only CREATE without charging target writes", () => {
    const build = loadBuildPlan();
    const input = fixture([1], 10);
    input.draft.lines[0].targets = [];
    const line = input.proposalBody.lines[0];
    if (line.kind !== "CREATE") throw new Error("Fixture must be CREATE");
    line.targets = [];
    const plan = build(input);
    expect(plan.expandedCounts).toEqual({
      cashFlowEntries: 10,
      financialAndCoordinationWrites: 17,
    });
  });

  it("KEEP claims do not become CREATE/target/CFE writes", () => {
    const build = loadBuildPlan();
    const input = fixture([1], 10);
    input.draft.lines[0].decision = {
      kind: "KEEP_EXISTING",
      expenseId: "qa-existing",
    };
    input.draft.lines[0].targets = [];
    input.proposalBody.lines = [
      {
        kind: "KEEP_EXISTING",
        lineId: "line-0",
        sourceExpenseId: "qa-existing",
        totalCents: 1000,
        schedule: schedule(10),
      },
    ];
    input.proposalBody.createdEconomicTotalCents = 0;
    input.proposalBody.invoiceDeltas = [];
    const plan = build(input);
    expect(plan.expandedCounts).toEqual({
      cashFlowEntries: 0,
      financialAndCoordinationWrites: 5,
    });
  });

  it("preserves deferred scope even without an editable line", () => {
    const build = loadBuildPlan();
    const plan = build(withUneditedObservation());
    expect(plan.proposal.deferredObservationIds).toEqual(["obs-deferred"]);
    expect(plan.proposal.retainUntil).toBe(EXPIRES_AT);
    expect(plan.continuation.deferredObservations).toEqual([
      { id: "obs-deferred", claimVersion: 4 },
    ]);
    expect(plan.transferRefIds).toEqual(["ref-source"]);
    expect(plan.continuation.refs).toEqual([
      {
        refId: "ref-source",
        refState: "ATTACHED",
        uploadGeneration: 2,
        artifactId: "artifact-source",
        artifactSha256: HASH_A,
        phase: "EXTRACTED",
      },
    ]);
    expect(plan.continuationDraft).toEqual({
      version: 1,
      lines: [],
      selectedLineIds: [],
      questions: [],
      scope: { observationIds: ["obs-deferred"], pendingAttachmentIds: [] },
    });
    expect(plan.continuation.writeCostUpperBound).toBe(64);
  });

  it("preserves all 1998 deferred facts in a 2000-observation scope with two editable lines", () => {
    const build = loadBuildPlan();
    const input = fixture();
    const deferred = Array.from({ length: 1998 }, (_, index) =>
      observation(
        `unmapped-${String(index).padStart(4, "0")}`,
        "artifact-source",
        index,
      ),
    );
    input.observations = [...input.observations, ...deferred].reverse();
    input.draft.scope.observationIds = input.observations.map((row) => row.id);
    const plan = build(input);
    const ids = deferred.map((row) => row.id);
    expect(plan.proposal.deferredObservationIds).toEqual(ids);
    expect(plan.continuation.deferredObservations).toEqual(
      deferred.map(({ id, claimVersion }) => ({ id, claimVersion })),
    );
    expect(plan.continuationDraft?.scope.observationIds).toEqual(ids);
    expect(plan.continuationDraft?.lines).toEqual([]);
    expect(plan.transferRefIds).toEqual(["ref-source"]);
    expect(plan.continuation.writeCostUpperBound).toBe(64);
  });

  it("rejects 21 observations on one editable line instead of counting a truncated prefix", () => {
    const build = loadBuildPlan();
    const input = fixture([21]);
    expectScopeFailure(() => build(input));
  });

  it("preserves remaining decisions/questions without retargeting a mixed question", () => {
    const build = loadBuildPlan();
    const input = withUneditedObservation();
    const remaining: ImportSessionDraftLineV1 = {
      ...structuredClone(input.draft.lines[0]),
      id: "line-remaining",
      observationIds: ["obs-deferred"],
      titulo: "Human correction",
      targets: null,
      decision: { kind: "UNRESOLVED" },
    };
    input.draft.lines.push(remaining);
    input.draft.questions = [
      {
        id: "q-remaining",
        lineIds: ["line-remaining"],
        field: "decision",
        text: "Keep or create?",
      },
      {
        id: "q-selected",
        lineIds: ["line-0"],
        field: "targets",
        text: "Selected only",
      },
      {
        id: "q-mixed",
        lineIds: ["line-0", "line-remaining"],
        field: "decision",
        text: "Do these describe the same purchase?",
      },
    ];
    const plan = build(input);
    expect(plan.continuationDraft).toEqual({
      version: 1,
      lines: [remaining],
      selectedLineIds: [remaining.id],
      questions: [input.draft.questions[0]],
      scope: { observationIds: ["obs-deferred"], pendingAttachmentIds: [] },
    });
  });

  it("retains inert FAILED pending refs without an artifact", () => {
    const build = loadBuildPlan();
    const input = withPending();
    const pending = input.references[1];
    pending.ref.state = "FAILED";
    pending.ref.artifactId = null;
    pending.artifact = null;
    const plan = build(input);
    expect(plan.proposal.deferredAttachmentIds).toEqual(["ref-pending"]);
    expect(plan.transferRefIds).toEqual(["ref-pending"]);
    expect(plan.continuation.refs).toEqual([
      {
        refId: "ref-pending",
        refState: "FAILED",
        uploadGeneration: 2,
        artifactId: null,
        artifactSha256: null,
        phase: "FAILED",
      },
    ]);
    expect(plan.leaseCleanupArtifactIds).toEqual(["artifact-source"]);
    expect(plan.continuation.writeCostUpperBound).toBe(64);
    expect(plan.proposal.retainUntil).toBe(EXPIRES_AT);
  });

  it.each(["RESERVED", "UPLOADED"])(
    "blocks %s before READY even outside pending scope",
    (state) => {
      const build = loadBuildPlan();
      const input = fixture();
      const pending = reference(
        "ref-flight",
        "artifact-flight",
        "RAW_READY",
        1,
      );
      pending.ref.state = state;
      pending.ref.artifactId = null;
      pending.artifact = null;
      input.references = [...input.references, pending];
      expectReason(() => build(input), "ATTACHMENT_IN_FLIGHT");
    },
  );

  it("READY8 and CONFIRMED9 reprepare8 produce the identical plan", () => {
    const build = loadBuildPlan();
    const input = withPending(withUneditedObservation());
    const ready = build(input);
    input.session.revision = 9;
    input.session.confirmedRevision = 8;
    expect(build(input)).toEqual(ready);
    expect(ready.proposal.revision).toBe(8);
  });

  it("sorts observation/ref inputs by identity without changing semantic line order", () => {
    const build = loadBuildPlan();
    const input = withPending(withUneditedObservation());
    const baseline = build(input);
    const reordered = structuredClone(input);
    reordered.observations = [...reordered.observations].reverse();
    reordered.references = [...reordered.references].reverse();
    reordered.draft.scope.observationIds.reverse();
    expect(build(reordered)).toEqual(baseline);
    expect(baseline.proposal.lines.map((line) => line.lineId)).toEqual([
      "line-0",
      "line-1",
    ]);
    const reversedLines = structuredClone(input);
    reversedLines.draft.lines.reverse();
    reversedLines.draft.selectedLineIds.reverse();
    reversedLines.proposalBody.lines.reverse();
    const reversedPlan = build(reversedLines);
    expect(reversedPlan.proposal.lines.map((line) => line.lineId)).toEqual([
      "line-1",
      "line-0",
    ]);
    expect(reversedPlan.proposal.proposalHash).not.toBe(
      baseline.proposal.proposalHash,
    );
  });

  it("RAW_READY/ANALYZING are the same H8, other semantic phases are distinct", () => {
    const build = loadBuildPlan();
    const plans = [
      "RAW_READY",
      "ANALYZING",
      "EXTRACTED",
      "FAILED",
      "PURGING",
      "PURGED",
    ].map((state) => build(withPending(fixture(), state)));
    expect(plans.map((plan) => plan.continuation.refs[0].phase)).toEqual([
      "NOT_EXTRACTED",
      "NOT_EXTRACTED",
      "EXTRACTED",
      "FAILED",
      "UNAVAILABLE",
      "UNAVAILABLE",
    ]);
    expect(plans[0].proposal.proposalHash).toBe(plans[1].proposal.proposalHash);
    expect(plans[4].proposal.proposalHash).toBe(plans[5].proposal.proposalHash);
    expect(
      new Set(
        [plans[0], plans[2], plans[3], plans[4]].map(
          (plan) => plan.proposal.proposalHash,
        ),
      ).size,
    ).toBe(4);
  });

  it.each(["absent", "own", "foreign"] as const)(
    "ignores %s lease, parse generation and timestamps in cost/H8",
    (lease) => {
      const build = loadBuildPlan();
      const input = withPending(withUneditedObservation());
      const baseline = build(input);
      const augmented = {
        ...input,
        references: input.references.map((item) => ({
          ref: {
            ...item.ref,
            updatedAt: new Date("2099-01-01T00:00:00.000Z"),
            uploadLeaseExpiresAt: new Date("2099-01-02T00:00:00.000Z"),
          },
          artifact: item.artifact && {
            ...item.artifact,
            leaseSessionId:
              lease === "absent"
                ? null
                : lease === "own"
                  ? SESSION_ID
                  : "other-session",
            leaseExpiresAt: new Date("2099-01-03T00:00:00.000Z"),
            leaseTokenExpiresAt: new Date("2099-01-04T00:00:00.000Z"),
            parseGeneration: 999,
            updatedAt: new Date("2099-01-05T00:00:00.000Z"),
          },
        })),
      };
      expect(build(augmented)).toEqual(baseline);
      expect(baseline.leaseCleanupArtifactIds).toEqual([
        "artifact-pending",
        "artifact-source",
      ]);
    },
  );

  it.each([
    "claimVersion",
    "uploadGeneration",
    "artifactSha256",
    "artifactId",
    "refId",
    "refState",
  ])("binds deferred %s to H8", (field) => {
    const build = loadBuildPlan();
    const input = withPending(withUneditedObservation());
    const baseline = build(input);
    const changed = structuredClone(input);
    const pending = changed.references[1];
    if (!pending.artifact) throw new Error("Fixture artifact required");
    if (field === "claimVersion") changed.observations[2].claimVersion++;
    if (field === "uploadGeneration") pending.ref.uploadGeneration++;
    if (field === "artifactSha256")
      pending.artifact.documentSha256 = "c".repeat(64);
    if (field === "artifactId") {
      pending.artifact.id = "artifact-replacement";
      pending.ref.artifactId = "artifact-replacement";
    }
    if (field === "refId") {
      pending.ref.id = "ref-replacement";
      changed.draft.scope.pendingAttachmentIds = ["ref-replacement"];
    }
    if (field === "refState") pending.ref.state = "FAILED";
    expect(build(changed).proposal.proposalHash).not.toBe(
      baseline.proposal.proposalHash,
    );
  });

  it("binds the complete public proposal, including descriptive edits and occurrence labels", () => {
    const build = loadBuildPlan();
    const input = fixture();
    const baseline = build(input);
    const changed = structuredClone(input);
    const line = changed.proposalBody.lines[0];
    if (line.kind !== "CREATE") throw new Error("Fixture must be CREATE");
    changed.draft.lines[0].titulo = line.titulo = "Corrected title";
    line.schedule.occurrences[0].parcela = "printed 2/11";
    expect(build(changed).proposal.proposalHash).not.toBe(
      baseline.proposal.proposalHash,
    );
  });

  it("snapshots/deep-freezes the complete result without freezing or changing input", () => {
    const build = loadBuildPlan();
    const input = withPending(withUneditedObservation());
    const before = structuredClone(input);
    const plan = build(input);
    const saved = structuredClone(plan);
    expect(input).toEqual(before);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.draft.lines[0])).toBe(false);
    assertDeepFrozen(plan);
    expect(plan.proposal.lines).not.toBe(input.proposalBody.lines);
    expect(() => plan.proposal.lines.reverse()).toThrow(TypeError);
    expect(() => {
      plan.proposal.lines[0].schedule.occurrences[0].valor = 999;
    }).toThrow(TypeError);
    input.proposalBody.lines[0].schedule.occurrences[0].valor = 900;
    input.draft.lines[0].titulo = "changed after prepare";
    input.observations[2].claimVersion = 500;
    input.session.expiresAt.setUTCFullYear(2099);
    expect(plan).toEqual(saved);
  });

  const invalidScopes: Array<[string, (input: PreparationInput) => void]> = [
    [
      "missing scoped observation",
      (input) => {
        input.observations = input.observations.slice(1);
      },
    ],
    [
      "duplicate observation row",
      (input) => {
        input.observations = [...input.observations, input.observations[0]];
      },
    ],
    [
      "foreign tenant observation",
      (input) => {
        input.observations[0].tenantId = "foreign-tenant";
      },
    ],
    [
      "foreign anchor observation",
      (input) => {
        input.observations[0].ownerProjectId = "foreign-anchor";
      },
    ],
    [
      "unreferenced observation artifact",
      (input) => {
        input.observations[0].artifactId = "missing-artifact";
      },
    ],
    [
      "duplicate scope observation",
      (input) => {
        input.draft.scope.observationIds.push(
          input.draft.scope.observationIds[0],
        );
      },
    ],
    [
      "line observation outside scope",
      (input) => {
        input.draft.lines[0].observationIds = ["outside-scope"];
      },
    ],
    [
      "one selected observation funds two CREATE lines",
      (input) => {
        input.draft.lines[1].observationIds = [
          ...input.draft.lines[0].observationIds,
        ];
      },
    ],
    [
      "duplicate reference row",
      (input) => {
        input.references = [...input.references, input.references[0]];
      },
    ],
    [
      "missing scoped pending reference",
      (input) => {
        input.draft.scope.pendingAttachmentIds = ["missing-ref"];
      },
    ],
    [
      "duplicate pending reference ID",
      (input) => {
        input.draft.scope.pendingAttachmentIds = ["ref-pending", "ref-pending"];
      },
    ],
    [
      "foreign reference tenant",
      (input) => {
        input.references[0].ref.tenantId = "foreign-tenant";
      },
    ],
    [
      "foreign reference anchor",
      (input) => {
        input.references[0].ref.ownerProjectId = "foreign-anchor";
      },
    ],
    [
      "foreign reference session",
      (input) => {
        input.references[0].ref.sessionId = "foreign-session";
      },
    ],
    [
      "ref/artifact mismatch",
      (input) => {
        input.references[0].ref.artifactId = "different-artifact";
      },
    ],
    [
      "missing ATTACHED artifact",
      (input) => {
        input.references[0].artifact = null;
      },
    ],
    [
      "foreign artifact tenant",
      (input) => {
        input.references[0].artifact!.tenantId = "foreign-tenant";
      },
    ],
    [
      "foreign artifact anchor",
      (input) => {
        input.references[0].artifact!.ownerProjectId = "foreign-anchor";
      },
    ],
    [
      "selected observation behind RELEASED ref",
      (input) => {
        input.references[0].ref.state = "RELEASED";
      },
    ],
    [
      "proposal for another session",
      (input) => {
        input.proposalBody.sessionId = "foreign-session";
      },
    ],
    [
      "proposal duplicates selected line",
      (input) => {
        input.proposalBody.lines[1].lineId = "line-0";
      },
    ],
    [
      "proposal omits selected line",
      (input) => {
        input.proposalBody.lines.pop();
        input.proposalBody.createdEconomicTotalCents = 1000;
      },
    ],
    [
      "observation listed twice within line",
      (input) => {
        input.draft.lines[0].observationIds.push(
          input.draft.lines[0].observationIds[0],
        );
      },
    ],
  ];

  it.each(invalidScopes)(
    "fails explicitly instead of repairing %s",
    (_name, mutate) => {
      const build = loadBuildPlan();
      const input = withPending();
      mutate(input);
      const before = structuredClone(input);
      expectScopeFailure(() => build(input));
      expect(input).toEqual(before);
    },
  );
});
