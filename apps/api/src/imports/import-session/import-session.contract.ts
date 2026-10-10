import type { ImportSession, Prisma } from "@prisma/client";
import { IMPORT_SESSION_PRIMITIVES } from "@reformaflow/domain";
import type {
  ImportSessionStoredDraftV1,
  ImportSessionHash,
  ImportSessionId,
  ImportSessionInstant,
  ImportSessionProposalV1,
  ImportSessionRequestId,
  ImportSessionRevision,
} from "@reformaflow/domain";
import { assertMintedImportContext } from "./import-session.auth";

/**
 * Must originate in verified JWT sv/exp, never DTO/header or a refreshed DB version. The
 * structural type cannot prove that, so the service demands the RUNTIME brand minted by
 * `ImportAuthGuard` (see import-session.auth.ts), so a hand-built or spread copy is refused.
 */
export interface AuthenticatedImportContext {
  readonly tenantId: ImportSessionId;
  readonly userId: ImportSessionId;
  readonly presentedSessionVersion: number;
  readonly tokenExpiresAt: ImportSessionInstant;
}

declare const uiGrantBrand: unique symbol;
/** An in-process capability, not JSON, not a boolean and not financial consent. */
export interface UiImportPersistenceGrant {
  readonly [uiGrantBrand]: true;
}
export type UiImportGrantScope =
  | {
      operation: "CREATE_SESSION";
      cardId: ImportSessionId;
      createRequestId: ImportSessionRequestId;
      /** INT-2: the grant is bound to the consent text version the user saw. */
      consentPolicyVersion: number;
    }
  | {
      operation: "FOCUSED_DRAFT_ANSWER";
      sessionId: ImportSessionId;
      expectedRevision: ImportSessionRevision;
      questionId: ImportSessionId;
      requestHash: ImportSessionHash;
    }
  | {
      operation: "DOCUMENTARY_ANSWER";
      sessionId: ImportSessionId;
      expectedRevision: ImportSessionRevision;
      questionId: ImportSessionId;
      requestHash: ImportSessionHash;
    }
  | {
      operation: "CANCEL_SESSION";
      sessionId: ImportSessionId;
      expectedRevision: number;
    }
  | {
      operation: "RESERVE_ATTACHMENTS";
      sessionId: ImportSessionId;
      expectedRevision: number;
    }
  | {
      operation: "ANALYZE_ATTACHMENT";
      sessionId: ImportSessionId;
      attachmentId: ImportSessionId;
      expectedRevision: number;
    }
  | {
      operation: "UPLOAD_CONTENT" | "FINALIZE_UPLOAD";
      sessionId: ImportSessionId;
      attachmentId: ImportSessionId;
      uploadGeneration: number;
    };

/**
 * Future production services MUST invoke a runtime verifier, not merely cast to the brand.
 * It must bind verified UI origin/header, actor, operation, scope, expiry and consent.
 * There is deliberately no issuer or implementation in this closed bootstrap.
 * This grant cannot authorize a financial challenge/confirmation.
 */
export interface UiImportPersistenceGrantVerifier {
  verify(
    candidate: unknown,
    auth: AuthenticatedImportContext,
    scope: UiImportGrantScope,
    now: Date,
  ): UiImportPersistenceGrant;
}

export type UiImportFinancialActionScope =
  | {
      readonly operation: "CHALLENGE";
      readonly sessionId: ImportSessionId;
      readonly expectedRevision: ImportSessionRevision;
      readonly proposalHash: ImportSessionHash;
    }
  | {
      readonly operation: "CONFIRM";
      readonly sessionId: ImportSessionId;
      readonly expectedRevision: ImportSessionRevision;
      readonly proposalHash: ImportSessionHash;
      readonly financialRequestId: ImportSessionRequestId;
    }
  | {
      readonly operation: "EXECUTE";
      readonly sessionId: ImportSessionId;
      readonly financialRequestId: ImportSessionRequestId;
    };

/** Successful admission consumes once per invocation, not per writer attempt or confirmation. */
export interface UiImportFinancialActionVerifier {
  verifyFinancialAction(
    candidate: unknown,
    auth: AuthenticatedImportContext,
    scope: UiImportFinancialActionScope,
    now: Date,
  ): void;
}

const lockedSessionBrand = Symbol("LockedImportSession");
/**
 * In-process identity/lifetime only, not proof of a SQLite writer, confirmation or current
 * grants. The coordinator must acquire the writer and reauthorize before minting, then
 * release in its transaction callback's finally. No production consumer is active yet.
 */
export type LockedImportSession = Readonly<ImportSession> & {
  readonly [lockedSessionBrand]: true;
  /** Parsed private draft, including the server-owned `scope`. */
  readonly draft: ImportSessionStoredDraftV1;
};

export interface SelectedImportObservation {
  readonly id: ImportSessionId;
  readonly lineId: ImportSessionId;
  /** null = whole purchase; otherwise the canonical index in the SOURCE agenda. */
  readonly canonicalIndex: number | null;
  readonly artifactId: ImportSessionId;
  readonly documentSha256: ImportSessionHash;
  readonly reference: string;
  readonly claimVersion: number;
}
const preparedBatchBrand = Symbol("PreparedCardBatch");
export interface PreparedCardBatch {
  readonly [preparedBatchBrand]: true;
  readonly proposal: ImportSessionProposalV1;
  readonly preflightHash: ImportSessionHash;
  readonly observations: readonly SelectedImportObservation[];
  readonly expandedCounts: {
    readonly cashFlowEntries: number;
    /** Includes financial entities, claims, audits and the session receipt. */
    readonly financialAndCoordinationWrites: number;
  };
}

interface LockedSessionBinding {
  readonly tx: Prisma.TransactionClient;
  readonly auth: AuthenticatedImportContext;
  readonly sessionId: ImportSessionId;
  readonly revision: number;
  active: boolean;
}
interface PreparedBatchBinding {
  readonly session: LockedImportSession;
  consumed: boolean;
}
const lockedSessions = new WeakMap<object, LockedSessionBinding>();
const preparedBatches = new WeakMap<object, PreparedBatchBinding>();
const invalidHandle = (): Error => new Error("Invalid import execution handle");
const ID = new RegExp(IMPORT_SESSION_PRIMITIVES.idPattern);
const HASH = new RegExp(IMPORT_SESSION_PRIMITIVES.hashPattern);
const id = (value: unknown): value is ImportSessionId =>
  typeof value === "string" && ID.test(value);

/** Binding structure only; original-document semantics remain the adapter's responsibility. */
function assertObservationBindings(
  session: LockedImportSession,
  proposal: ImportSessionProposalV1,
  observations: readonly SelectedImportObservation[],
): void {
  const selected = new Set(session.draft.selectedLineIds);
  if (
    proposal.sessionId !== session.id ||
    selected.size === 0 ||
    selected.size !== session.draft.selectedLineIds.length ||
    !Array.isArray(proposal.lines) ||
    !Array.isArray(observations)
  ) {
    throw invalidHandle();
  }
  const proposalLines = new Map(
    proposal.lines.map((line) => [line.lineId, line]),
  );
  if (
    proposalLines.size !== selected.size ||
    proposalLines.size !== proposal.lines.length
  ) {
    throw invalidHandle();
  }
  const owners = new Map<ImportSessionId, ImportSessionId>();
  const scope = new Set(session.draft.scope.observationIds);
  const deferred = new Set(proposal.deferredObservationIds);
  for (const lineId of selected) {
    const lines = session.draft.lines.filter((line) => line.id === lineId);
    if (
      !proposalLines.has(lineId) ||
      lines.length !== 1 ||
      lines[0].observationIds.length === 0
    ) {
      throw invalidHandle();
    }
    for (const observationId of lines[0].observationIds) {
      if (
        owners.has(observationId) ||
        !scope.has(observationId) ||
        deferred.has(observationId)
      ) {
        throw invalidHandle();
      }
      owners.set(observationId, lineId);
    }
  }
  if (observations.length !== owners.size) throw invalidHandle();
  const seen = new Set<ImportSessionId>();
  for (const observation of observations) {
    if (
      observation === null ||
      typeof observation !== "object" ||
      Array.isArray(observation) ||
      !id(observation.id) ||
      !id(observation.lineId) ||
      !id(observation.artifactId) ||
      typeof observation.documentSha256 !== "string" ||
      !HASH.test(observation.documentSha256) ||
      typeof observation.reference !== "string" ||
      observation.reference.length === 0 ||
      observation.reference.length >
        IMPORT_SESSION_PRIMITIVES.maxReferenceLength ||
      observation.reference.normalize("NFC") !== observation.reference ||
      !Number.isSafeInteger(observation.claimVersion) ||
      observation.claimVersion < 0 ||
      seen.has(observation.id) ||
      owners.get(observation.id) !== observation.lineId
    ) {
      throw invalidHandle();
    }
    seen.add(observation.id);
    const line = proposalLines.get(observation.lineId);
    if (!line) throw invalidHandle();
    const index = observation.canonicalIndex;
    if (index !== null) {
      const occurrences = line.schedule?.occurrences;
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        !Array.isArray(occurrences) ||
        index >= occurrences.length ||
        occurrences[index]?.index !== index
      ) {
        throw invalidHandle();
      }
    }
  }
}

/** Only already-parsed JSON snapshots reach this helper; it does not interpret or validate them. */
function freezeSnapshot(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) freezeSnapshot(child);
  Object.freeze(value);
}

export function mintLockedImportSession(
  tx: Prisma.TransactionClient,
  auth: AuthenticatedImportContext,
  row: ImportSession,
  draft: ImportSessionStoredDraftV1,
): LockedImportSession {
  assertMintedImportContext(auth);
  if (row.tenantId !== auth.tenantId || row.ownerUserId !== auth.userId) {
    throw invalidHandle();
  }
  const draftSnapshot = structuredClone(draft);
  freezeSnapshot(draftSnapshot);
  const timestamps = {
    consentedAt: row.consentedAt.getTime(),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    lastUserEditAt: row.lastUserEditAt.getTime(),
    expiresAt: row.expiresAt.getTime(),
    confirmedAt: row.confirmedAt === null ? null : row.confirmedAt.getTime(),
    closedAt: row.closedAt === null ? null : row.closedAt.getTime(),
  };
  // Freezing a Date does not prevent setTime; no captured Date is exposed or retained.
  const session: LockedImportSession = {
    ...row,
    [lockedSessionBrand]: true,
    draft: draftSnapshot,
    get consentedAt() {
      return new Date(timestamps.consentedAt);
    },
    get createdAt() {
      return new Date(timestamps.createdAt);
    },
    get updatedAt() {
      return new Date(timestamps.updatedAt);
    },
    get lastUserEditAt() {
      return new Date(timestamps.lastUserEditAt);
    },
    get expiresAt() {
      return new Date(timestamps.expiresAt);
    },
    get confirmedAt() {
      return timestamps.confirmedAt === null
        ? null
        : new Date(timestamps.confirmedAt);
    },
    get closedAt() {
      return timestamps.closedAt === null
        ? null
        : new Date(timestamps.closedAt);
    },
  };
  Object.freeze(session);
  lockedSessions.set(session, {
    tx,
    auth,
    sessionId: session.id,
    revision: session.revision,
    active: true,
  });
  return session;
}

export function assertLockedImportSession(
  tx: Prisma.TransactionClient,
  auth: AuthenticatedImportContext,
  candidate: unknown,
): asserts candidate is LockedImportSession {
  assertMintedImportContext(auth);
  if (candidate === null || typeof candidate !== "object")
    throw invalidHandle();
  const binding = lockedSessions.get(candidate);
  if (
    !binding ||
    !binding.active ||
    binding.tx !== tx ||
    binding.auth !== auth ||
    !("id" in candidate) ||
    candidate.id !== binding.sessionId ||
    !("revision" in candidate) ||
    candidate.revision !== binding.revision
  ) {
    throw invalidHandle();
  }
}

/** Known release is idempotent cleanup. Every batch of this exact handle becomes unusable. */
export function releaseLockedImportSession(session: LockedImportSession): void {
  const binding = lockedSessions.get(session);
  if (!binding) throw invalidHandle();
  binding.active = false;
}

export function mintPreparedCardBatch(
  tx: Prisma.TransactionClient,
  auth: AuthenticatedImportContext,
  session: LockedImportSession,
  data: Pick<
    PreparedCardBatch,
    "proposal" | "preflightHash" | "observations" | "expandedCounts"
  >,
): PreparedCardBatch {
  assertLockedImportSession(tx, auth, session);
  const snapshot = structuredClone({
    proposal: data.proposal,
    preflightHash: data.preflightHash,
    observations: data.observations,
    expandedCounts: data.expandedCounts,
  });
  assertObservationBindings(session, snapshot.proposal, snapshot.observations);
  freezeSnapshot(snapshot);
  const batch: PreparedCardBatch = {
    ...snapshot,
    [preparedBatchBrand]: true,
  };
  Object.freeze(batch);
  preparedBatches.set(batch, { session, consumed: false });
  return batch;
}

export function assertPreparedCardBatch(
  tx: Prisma.TransactionClient,
  auth: AuthenticatedImportContext,
  candidate: unknown,
): asserts candidate is PreparedCardBatch {
  assertMintedImportContext(auth);
  if (candidate === null || typeof candidate !== "object")
    throw invalidHandle();
  const binding = preparedBatches.get(candidate);
  if (!binding || binding.consumed) throw invalidHandle();
  assertLockedImportSession(tx, auth, binding.session);
}

/**
 * The future apply entry must consume before effects. This rejects reuse of this instance,
 * not a separately minted logical duplicate: DB claims/CAS/receipt remain the coordinator's job.
 */
export function consumePreparedCardBatch(
  tx: Prisma.TransactionClient,
  auth: AuthenticatedImportContext,
  candidate: unknown,
): asserts candidate is PreparedCardBatch {
  assertPreparedCardBatch(tx, auth, candidate);
  const binding = preparedBatches.get(candidate);
  if (!binding) throw invalidHandle();
  binding.consumed = true;
}

export type ImportObservationClaimReceipt =
  | {
      kind: "SESSION";
      sessionId: ImportSessionId;
      financialRequestId: ImportSessionRequestId;
    }
  | {
      kind: "LEGACY_IMPORT";
      engine: "CARD" | "BANK" | "RECEIPT";
      importId: string | null;
      externalId: string;
    };

export interface ImportSessionChallenge {
  nonceHash: ImportSessionHash;
  revision: number;
  proposalHash: ImportSessionHash;
  sessionVersion: number;
  expiresAt: ImportSessionInstant;
}
export interface ImportSessionPrepareLease {
  generation: number;
  sessionVersion: number;
  tokenExpiresAt: ImportSessionInstant;
  expiresAt: ImportSessionInstant;
}
