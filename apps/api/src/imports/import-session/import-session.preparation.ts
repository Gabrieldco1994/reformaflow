import { createHash } from "node:crypto";
import type {
  ImportArtifact,
  ImportObservation,
  ImportSession,
  ImportSessionArtifact,
} from "@prisma/client";
import {
  IMPORT_SESSION_LIMITS,
  IMPORT_SESSION_PRIMITIVES,
  IMPORT_SESSION_PROTOCOL_VERSION,
  ImportSessionArtifactState,
  ImportSessionAttachmentState,
  ImportSessionErrorCode,
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
  assertProposalDraftReferences,
  validateProposal,
  validateStoredDraft,
} from "./import-session.validation";

export type PreparationSession = Readonly<
  Pick<
    ImportSession,
    | "id"
    | "tenantId"
    | "ownerProjectId"
    | "cardId"
    | "revision"
    | "confirmedRevision"
    | "expiresAt"
  >
>;
export type PreparationObservation = Readonly<
  Pick<
    ImportObservation,
    "id" | "tenantId" | "ownerProjectId" | "artifactId" | "claimVersion"
  >
>;
export type PreparationReference = Readonly<{
  ref: Readonly<
    Pick<
      ImportSessionArtifact,
      | "id"
      | "tenantId"
      | "ownerProjectId"
      | "sessionId"
      | "artifactId"
      | "position"
      | "state"
      | "uploadGeneration"
    >
  >;
  artifact: Readonly<
    Pick<
      ImportArtifact,
      "id" | "tenantId" | "ownerProjectId" | "documentSha256" | "state"
    >
  > | null;
}>;
export type ProposalBody = Omit<
  ImportSessionProposalV1,
  | "proposalHash"
  | "deferredObservationIds"
  | "deferredAttachmentIds"
  | "retainUntil"
>;
export interface ImportPreparationPlanV1 {
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

const ID = new RegExp(IMPORT_SESSION_PRIMITIVES.idPattern);
const HASH = new RegExp(IMPORT_SESSION_PRIMITIVES.hashPattern);
const BODY_KEYS = [
  "version",
  "kind",
  "sessionId",
  "revision",
  "lines",
  "createdEconomicTotalCents",
  "bankCashDeltaCents",
  "invoiceDeltas",
];
// The shared shape validator requires a hash; this sentinel is never hashed or returned.
const VALIDATION_HASH = "0".repeat(64);
const COORDINATION_WRITES = 3;
const TARGET_ENTITY_WRITES = 4;
const corrupt = () => new ImportSessionCorruptStateError("preparation");
const id = (value: unknown): value is string =>
  typeof value === "string" && ID.test(value);
const natural = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const revision = (value: unknown): value is number =>
  natural(value) &&
  value >= IMPORT_SESSION_PRIMITIVES.minRevision &&
  value <= IMPORT_SESSION_PRIMITIVES.maxRevision;
const sorted = (values: Iterable<string>): string[] => [...values].sort();
const byId = (left: { id: string }, right: { id: string }): number =>
  left.id < right.id ? -1 : left.id > right.id ? 1 : 0;

function freeze(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  Object.values(value).forEach(freeze);
  Object.freeze(value);
}

function checkSize(value: unknown): void {
  if (
    Buffer.byteLength(JSON.stringify(value), "utf8") >
    IMPORT_SESSION_LIMITS.jsonBytesPerDraftOrProposal
  ) {
    throw new ImportSessionError(ImportSessionErrorCode.LIMIT_EXCEEDED);
  }
}

function retentionDate(value: Date): string {
  try {
    return Date.prototype.toISOString.call(value);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError)
      throw corrupt();
    throw error;
  }
}

function phase(
  artifact: PreparationReference["artifact"],
): ImportPreparationPlanV1["continuation"]["refs"][number]["phase"] {
  if (artifact === null) return "FAILED";
  switch (artifact.state) {
    case ImportSessionArtifactState.RAW_READY:
    case ImportSessionArtifactState.ANALYZING:
      return "NOT_EXTRACTED";
    case ImportSessionArtifactState.EXTRACTED:
      return "EXTRACTED";
    case ImportSessionArtifactState.FAILED:
      return "FAILED";
    case ImportSessionArtifactState.PURGING:
    case ImportSessionArtifactState.PURGED:
      return "UNAVAILABLE";
    default:
      throw corrupt();
  }
}

export function buildImportPreparationPlan(input: {
  session: PreparationSession;
  draft: ImportSessionStoredDraftV1;
  proposalBody: ProposalBody;
  observations: readonly PreparationObservation[];
  references: readonly PreparationReference[];
}): ImportPreparationPlanV1 {
  const { session, proposalBody } = input;
  if (
    !id(session.id) ||
    !id(session.tenantId) ||
    !id(session.ownerProjectId) ||
    !id(session.cardId) ||
    !revision(session.revision) ||
    !(
      session.confirmedRevision === null ||
      (revision(session.confirmedRevision) &&
        session.confirmedRevision < session.revision)
    )
  )
    throw corrupt();
  const expiresAt = retentionDate(session.expiresAt);
  const preparedRevision = session.confirmedRevision ?? session.revision + 1;
  if (
    !revision(preparedRevision) ||
    proposalBody === null ||
    typeof proposalBody !== "object" ||
    Object.keys(proposalBody).length !== BODY_KEYS.length ||
    !BODY_KEYS.every((key) =>
      Object.prototype.hasOwnProperty.call(proposalBody, key),
    ) ||
    proposalBody.revision !== preparedRevision ||
    proposalBody.sessionId !== session.id
  )
    throw corrupt();
  const draft: ImportSessionStoredDraftV1 = JSON.parse(
    canonical(validateStoredDraft(input.draft)),
  );
  checkSize(draft);
  if (draft.selectedLineIds.length === 0) throw corrupt();
  if (
    !Array.isArray(input.observations) ||
    !Array.isArray(input.references) ||
    input.references.length > IMPORT_SESSION_LIMITS.filesPerSession
  )
    throw corrupt();

  const referenceIds = new Set<string>();
  const positions = new Set<number>();
  const artifactIds = new Set<string>();
  const referencesByArtifact = new Map<string, PreparationReference>();
  const references = [...input.references];
  for (const reference of references) {
    if (!reference?.ref) throw corrupt();
    const { ref, artifact } = reference;
    if (
      !id(ref.id) ||
      referenceIds.has(ref.id) ||
      !natural(ref.position) ||
      positions.has(ref.position) ||
      !natural(ref.uploadGeneration) ||
      ref.tenantId !== session.tenantId ||
      ref.ownerProjectId !== session.ownerProjectId ||
      ref.sessionId !== session.id
    )
      throw corrupt();
    referenceIds.add(ref.id);
    positions.add(ref.position);
    if (
      ref.state === ImportSessionAttachmentState.RESERVED ||
      ref.state === ImportSessionAttachmentState.UPLOADED
    ) {
      throw new ImportSessionError(ImportSessionErrorCode.LEASE_CONFLICT, {
        reason: "ATTACHMENT_IN_FLIGHT",
      });
    }
    if (
      ref.state !== ImportSessionAttachmentState.ATTACHED &&
      ref.state !== ImportSessionAttachmentState.FAILED
    ) {
      throw corrupt();
    }
    if (ref.artifactId === null) {
      if (
        artifact !== null ||
        ref.state === ImportSessionAttachmentState.ATTACHED
      )
        throw corrupt();
    } else {
      if (
        !id(ref.artifactId) ||
        artifactIds.has(ref.artifactId) ||
        !artifact ||
        artifact.id !== ref.artifactId ||
        artifact.tenantId !== session.tenantId ||
        artifact.ownerProjectId !== session.ownerProjectId ||
        typeof artifact.documentSha256 !== "string" ||
        !HASH.test(artifact.documentSha256)
      )
        throw corrupt();
      phase(artifact);
      artifactIds.add(ref.artifactId);
      referencesByArtifact.set(ref.artifactId, reference);
    }
  }
  references.sort((left, right) => byId(left.ref, right.ref));
  if (
    draft.scope.pendingAttachmentIds.some((refId) => !referenceIds.has(refId))
  )
    throw corrupt();
  const scopeIds = new Set(draft.scope.observationIds);
  const observations = [...input.observations].sort(byId);
  const observationIds = new Set<string>();
  for (const observation of observations) {
    const ref = referencesByArtifact.get(observation.artifactId);
    if (
      !id(observation.id) ||
      observationIds.has(observation.id) ||
      !scopeIds.has(observation.id) ||
      observation.tenantId !== session.tenantId ||
      observation.ownerProjectId !== session.ownerProjectId ||
      !natural(observation.claimVersion) ||
      !ref ||
      ref.ref.state !== ImportSessionAttachmentState.ATTACHED
    )
      throw corrupt();
    observationIds.add(observation.id);
  }
  if (observationIds.size !== scopeIds.size) throw corrupt();
  const selectedLines = new Set(draft.selectedLineIds);
  const selectedObservations = new Set(
    draft.lines
      .filter((line) => selectedLines.has(line.id))
      .flatMap((line) => line.observationIds),
  );
  const deferred = observations.filter(
    (observation) => !selectedObservations.has(observation.id),
  );
  const deferredObservationIds = deferred.map((observation) => observation.id);
  const deferredAttachmentIds = sorted(draft.scope.pendingAttachmentIds);
  const hasContinuation =
    deferred.length > 0 || deferredAttachmentIds.length > 0;
  const proposal: ImportSessionProposalV1 = JSON.parse(
    canonical(
      validateProposal(
        {
          ...proposalBody,
          proposalHash: VALIDATION_HASH,
          deferredObservationIds,
          deferredAttachmentIds,
          retainUntil: hasContinuation ? expiresAt : null,
        },
        session.id,
        null,
      ),
    ),
  );
  assertProposalDraftReferences(proposal, draft);

  let sources = 0;
  let targets = 0;
  let linkedSources = 0;
  let occurrences = 0;
  const invoiceTotals = new Map<string, number>();
  for (const line of proposal.lines) {
    if (line.kind !== "CREATE") continue;
    sources++;
    targets += line.targets.length;
    if (line.targets.length > 0) linkedSources++;
    for (const schedule of [
      line.schedule,
      ...line.targets.map((target) => target.schedule),
    ]) {
      occurrences += schedule.occurrences.length;
      if (schedule.occurrences.some((item) => item.invoiceDueMonth === null))
        throw corrupt();
    }
    for (const item of line.schedule.occurrences) {
      if (item.invoiceDueMonth === null) throw corrupt();
      invoiceTotals.set(
        item.invoiceDueMonth,
        (invoiceTotals.get(item.invoiceDueMonth) ?? 0) + item.valor,
      );
    }
  }
  const months = new Set(
    proposal.invoiceDeltas.map((delta) => delta.invoiceDueMonth),
  );
  if (
    months.size !== proposal.invoiceDeltas.length ||
    invoiceTotals.size !== months.size ||
    proposal.invoiceDeltas.some(
      (delta) => invoiceTotals.get(delta.invoiceDueMonth) !== delta.amountCents,
    )
  )
    throw corrupt();
  if (occurrences > IMPORT_SESSION_LIMITS.expandedCFEsPerBatch) {
    throw new ImportSessionError(ImportSessionErrorCode.LIMIT_EXCEEDED);
  }
  const deferredArtifacts = new Set(
    deferred.map((observation) => observation.artifactId),
  );
  const pending = new Set(deferredAttachmentIds);
  const transferableReferences = references.filter(
    ({ ref }) =>
      pending.has(ref.id) ||
      (ref.artifactId !== null && deferredArtifacts.has(ref.artifactId)),
  );
  const transferRefIds = transferableReferences.map(({ ref }) => ref.id);
  const leaseCleanupArtifactIds = sorted(artifactIds);
  const writeCostUpperBound =
    sources +
    TARGET_ENTITY_WRITES * targets +
    linkedSources +
    occurrences +
    (sources + targets) +
    selectedObservations.size +
    Number(hasContinuation) +
    transferRefIds.length +
    leaseCleanupArtifactIds.length +
    COORDINATION_WRITES;
  if (
    writeCostUpperBound >
    IMPORT_SESSION_LIMITS.financialAndCoordinationWritesPerBatch
  ) {
    throw new ImportSessionError(ImportSessionErrorCode.LIMIT_EXCEEDED, {
      reason: "WRITE_BUDGET_EXCEEDED",
    });
  }
  const continuation: ImportPreparationPlanV1["continuation"] = {
    deferredObservations: deferred.map(({ id, claimVersion }) => ({
      id,
      claimVersion,
    })),
    refs: transferableReferences.map(({ ref, artifact }) => {
      if (
        ref.state !== ImportSessionAttachmentState.ATTACHED &&
        ref.state !== ImportSessionAttachmentState.FAILED
      )
        throw corrupt();
      return {
        refId: ref.id,
        refState: ref.state,
        uploadGeneration: ref.uploadGeneration,
        artifactId: ref.artifactId,
        artifactSha256: artifact?.documentSha256 ?? null,
        phase: phase(artifact),
      };
    }),
    writeCostUpperBound,
  };
  let continuationDraft: ImportSessionStoredDraftV1 | null = null;
  if (hasContinuation) {
    const remainingObservations = new Set(deferredObservationIds);
    const lines = draft.lines.filter(
      (line) =>
        !selectedLines.has(line.id) &&
        line.observationIds.every((observationId) =>
          remainingObservations.has(observationId),
        ),
    );
    const remainingLines = new Set(lines.map((line) => line.id));
    continuationDraft = validateStoredDraft({
      version: IMPORT_SESSION_PROTOCOL_VERSION,
      lines,
      selectedLineIds: [],
      questions: draft.questions.filter((question) =>
        question.lineIds.every((lineId) => remainingLines.has(lineId)),
      ),
      scope: {
        observationIds: deferredObservationIds,
        pendingAttachmentIds: deferredAttachmentIds,
      },
      ...(draft.declarations === undefined
        ? {}
        : {
            declarations: {
              version: 1,
              items: draft.declarations.items.filter(
                (item) =>
                  remainingLines.has(item.lineId) &&
                  remainingObservations.has(item.observationId),
              ),
            },
          }),
    });
    checkSize(continuationDraft);
  }
  const { proposalHash: _validationHash, ...hashBody } = proposal;
  proposal.proposalHash = createHash("sha256")
    .update(
      canonical({
        proposal: hashBody,
        continuation,
        ...(draft.declarations === undefined
          ? {}
          : { declarations: draft.declarations }),
      }),
    )
    .digest("hex");
  checkSize(proposal);
  const plan: ImportPreparationPlanV1 = {
    proposal,
    continuation,
    transferRefIds,
    leaseCleanupArtifactIds,
    continuationDraft,
    expandedCounts: {
      cashFlowEntries: occurrences,
      financialAndCoordinationWrites: writeCostUpperBound,
    },
  };
  freeze(plan);
  return plan;
}
