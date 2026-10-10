import { createHash, randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  Prisma,
  type ImportSession,
  type ImportObservation,
  type ImportSessionArtifact,
} from "@prisma/client";
import {
  IMPORT_SESSION_CONSENT_POLICY_VERSION,
  IMPORT_SESSION_KIND,
  IMPORT_SESSION_LIMITS,
  IMPORT_SESSION_PRIMITIVES,
  IMPORT_SESSION_PROTOCOL_VERSION,
  ImportSessionDocumentFormat,
  ImportSessionErrorCode,
  ImportSessionState,
  type ImportSessionCandidateV1,
  type ImportSessionObservationViewV1,
  type ImportSessionStoredDraftV1,
  type ImportSessionDraftLineV1,
  type ImportSessionCreateRequestV1,
  type ImportSessionEntryV1,
  type ImportSessionListV1,
  type ImportSessionPageV1,
  type ImportSessionResultV1,
  type ImportSessionRevisionRequestV1,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import {
  PrismaService,
  INCLUDE_SOFT_DELETED,
} from "../../prisma/prisma.service";
import {
  EXPENSE_MODULE,
  RECEIPT_MODULE,
  resolveAccessibleProjectScope,
} from "../../common/access-rules";
import {
  checkCardImportKeep,
  type CardImportFacts,
} from "../../credit-card/card-purchase-identity";
import { parseStoredExpenseSchedule } from "../../expense/documented-schedule";
import { projectImportObservation } from "./import-session.observation";
import { parseStoredImportSearch } from "./import-session.search";
import type { ImportCandidateRef } from "./card-purchase-batch.port";
import {
  assertCardAccess,
  assertMintedImportContext,
  assertReceiptParticipantAccess,
  listScopeParams,
  reauthorize,
  type ImportActor,
} from "./import-session.auth";
import {
  IMPORT_SESSION_CAPABILITY,
  IMPORT_SESSION_CLOCK,
  IMPORT_SESSION_GRANT_VERIFIER,
  type ImportSessionCapability,
  importIntakeEnabled,
  importSessionWritesEnabled,
  type ImportSessionClock,
} from "./import-session.capability";
import type {
  AuthenticatedImportContext,
  UiImportPersistenceGrantVerifier,
} from "./import-session.contract";
import {
  deriveCursorKey,
  signListCursor,
  verifyListCursor,
  signPageCursor,
  verifyPageCursor,
  type ImportPageCursorBinding,
  type ImportPagePosition,
  type ImportListFilter,
} from "./import-session.cursor";
import { assertImportSessionOperationAvailable } from "./import-session.disabled";
import {
  ImportSessionError,
  ImportSessionCorruptStateError,
} from "./import-session.errors";
import {
  importObservationDedupeKeys,
  resolveImportDeclarations,
} from "./import-session.declarations";
import {
  IMPORT_LIST_PAGE_SIZE,
  queryVisibleSessions,
} from "./import-session.list";
import {
  CANCELLABLE_STATE_LIST,
  EMPTY_DRAFT_JSON,
  draftProposalParticipantEnvelope,
  effectiveState,
  projectSession,
  projectSummary,
  parseStoredDraft,
  parseSessionDocuments,
  parseReceipt,
  receiptParticipantEnvelope,
  rethrowImportSessionProjectionError,
  type ProjectionOptions,
} from "./import-session.projection";
import {
  isRetryableWriteFailure,
  runImportSessionWrite,
} from "./import-session.writer";
import { IMPORT_VAULT_GATE, type ImportVaultGate } from "./vault/vault-state";
import {
  ImportRawExecutions,
  type ImportRawClaim,
} from "./import-session.raw-executions";
import { supportsImportExtraction } from "./import-session.extraction";

type Tx = Prisma.TransactionClient;
type Db = PrismaService | Tx;

const ID = new RegExp(IMPORT_SESSION_PRIMITIVES.idPattern);
const REQUEST_ID = new RegExp(IMPORT_SESSION_PRIMITIVES.requestIdPattern);
const ENTRY_FORMATS: ReadonlySet<string> = new Set([
  ImportSessionDocumentFormat.CSV,
  ImportSessionDocumentFormat.OFX,
  ImportSessionDocumentFormat.PDF,
  ImportSessionDocumentFormat.XLS,
  ImportSessionDocumentFormat.XLSX,
]);
const TERMINAL_STATES = [
  ImportSessionState.APPLIED,
  ImportSessionState.CANCELLED,
  ImportSessionState.EXPIRED,
];
const CREATE_KEYS = [
  "version",
  "createRequestId",
  "cardId",
  "consentPolicyVersion",
  "consentAnalyze",
].sort();
const invalid = () =>
  new ImportSessionError(ImportSessionErrorCode.INVALID_INPUT);
const notFound = () => new ImportSessionError(ImportSessionErrorCode.NOT_FOUND);
const READ_CHUNK = 300;
const compareId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const pageOrder = (a: ImportPagePosition, b: ImportPagePosition) =>
  compareId(a.kind, b.kind) || compareId(a.id, b.id);
function chunks<T>(items: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += READ_CHUNK)
    result.push(items.slice(i, i + READ_CHUNK));
  return result;
}
function parsePageQuery(
  query: unknown,
  candidates: boolean,
): { cursor: string | null; lineId: string | null } {
  if (
    !isPlainRecord(query) ||
    Object.keys(query).some(
      (key) => key !== "cursor" && !(candidates && key === "lineId"),
    )
  )
    throw invalid();
  if (
    query.cursor !== undefined &&
    (typeof query.cursor !== "string" || !query.cursor)
  )
    throw invalid();
  if (
    candidates &&
    (typeof query.lineId !== "string" || !ID.test(query.lineId))
  )
    throw invalid();
  return {
    cursor: typeof query.cursor === "string" ? query.cursor : null,
    lineId: typeof query.lineId === "string" ? query.lineId : null,
  };
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Exactly the documented keys: an extra (`ownerProjectId`, `projectId`, `__proto__`) is an error, never ignored. */
function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(value).sort();
  return (
    own.length === keys.length && own.every((key, index) => key === keys[index])
  );
}

export function parseCreateRequest(
  body: unknown,
): ImportSessionCreateRequestV1 {
  if (
    !isPlainRecord(body) ||
    !hasExactKeys(body, CREATE_KEYS) ||
    body["version"] !== IMPORT_SESSION_PROTOCOL_VERSION ||
    typeof body["createRequestId"] !== "string" ||
    !REQUEST_ID.test(body["createRequestId"]) ||
    typeof body["cardId"] !== "string" ||
    !ID.test(body["cardId"]) ||
    body["consentPolicyVersion"] !== IMPORT_SESSION_CONSENT_POLICY_VERSION ||
    body["consentAnalyze"] !== true
  ) {
    throw invalid();
  }
  return {
    version: IMPORT_SESSION_PROTOCOL_VERSION,
    createRequestId: body["createRequestId"],
    cardId: body["cardId"],
    consentPolicyVersion: IMPORT_SESSION_CONSENT_POLICY_VERSION,
    consentAnalyze: true,
  };
}

export function parseRevisionRequest(
  body: unknown,
): ImportSessionRevisionRequestV1 {
  if (
    !isPlainRecord(body) ||
    !hasExactKeys(body, ["expectedRevision"]) ||
    !Number.isInteger(body["expectedRevision"]) ||
    (body["expectedRevision"] as number) <
      IMPORT_SESSION_PRIMITIVES.minRevision ||
    (body["expectedRevision"] as number) > IMPORT_SESSION_PRIMITIVES.maxRevision
  ) {
    throw invalid();
  }
  return { expectedRevision: body["expectedRevision"] as number };
}

export function assertSessionId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !ID.test(id)) throw invalid();
}

export interface ImportListQuery {
  readonly filter: ImportListFilter;
  readonly cursor: string | null;
}

/**
 * The list accepts exactly `state` (`active` default | `applied`) and `cursor`. Any other key
 * (tenant, owner, limit...), a repeated key or array/object value (`?state[]=`), an empty or
 * unknown value is INVALID_INPUT: scope is never a query parameter.
 */
export function parseListQuery(query: unknown): ImportListQuery {
  if (!isPlainRecord(query)) throw invalid();
  const keys = Object.keys(query);
  if (keys.some((key) => key !== "state" && key !== "cursor")) throw invalid();
  const state = query["state"];
  const cursor = query["cursor"];
  if (state !== undefined && state !== "active" && state !== "applied")
    throw invalid();
  if (cursor !== undefined && (typeof cursor !== "string" || cursor === ""))
    throw invalid();
  return {
    filter: (state as ImportListFilter | undefined) ?? "active",
    cursor: (cursor as string | undefined) ?? null,
  };
}

const createPayloadHash = (request: ImportSessionCreateRequestV1): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        request.version,
        request.cardId,
        request.consentPolicyVersion,
        request.consentAnalyze,
      ]),
    )
    .digest("hex");

/**
 * Intake service: create / recovery / scoped read pages / cancel of a private session. It never
 * trusts the HTTP layer: every operation re-verifies the presented JWT claims against the
 * database, the card ACL and (for mutations) a runtime UI grant, and answers only with the
 * closed error shape. Candidate pages hydrate a stored search; they do not certify a new
 * search or authorize execution. No upload, extraction, confirmation or financial write lives here.
 */
@Injectable()
export class ImportSessionService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(IMPORT_SESSION_CLOCK) private readonly clock: ImportSessionClock,
    @Inject(IMPORT_SESSION_CAPABILITY)
    private readonly capability: ImportSessionCapability,
    @Inject(IMPORT_SESSION_GRANT_VERIFIER)
    private readonly verifier: UiImportPersistenceGrantVerifier,
    @Inject(IMPORT_VAULT_GATE) private readonly gate: ImportVaultGate,
    private readonly raw: ImportRawExecutions,
  ) {}

  assertCreateAvailable(): void {
    assertImportSessionOperationAvailable(
      "CREATE",
      this.capability.writesEnabled() ||
        (importIntakeEnabled(this.capability) &&
          !this.gate.boot.stopped.aborted &&
          this.gate.boot.runtime() !== null),
    );
  }

  async create(
    auth: AuthenticatedImportContext,
    body: unknown,
    grant: unknown,
  ): Promise<{ view: ImportSessionViewV1; created: boolean }> {
    this.assertCreateAvailable();
    assertMintedImportContext(auth);
    const request = parseCreateRequest(body);
    // A grant is single-use: verified once per call even if the writer retries the transaction.
    let grantSpent = false;
    const outcome = await this.write(auth, async (tx, now) => {
      const actor = await reauthorize(tx, auth, now);
      if (!grantSpent) {
        this.verifier.verify(
          grant,
          auth,
          {
            operation: "CREATE_SESSION",
            cardId: request.cardId,
            createRequestId: request.createRequestId,
            consentPolicyVersion: request.consentPolicyVersion,
          },
          now,
        );
        grantSpent = true;
      }
      const card = await assertCardAccess(tx, actor, request.cardId);
      const hash = createPayloadHash(request);

      const existing = await tx.importSession.findUnique({
        where: {
          tenantId_ownerUserId_createRequestId: {
            tenantId: actor.tenantId,
            ownerUserId: actor.userId,
            createRequestId: request.createRequestId,
          },
        },
      });
      if (existing) {
        if (existing.createPayloadHash !== hash) {
          throw new ImportSessionError(
            ImportSessionErrorCode.IDEMPOTENCY_CONFLICT,
          );
        }
        return { row: existing, created: false, actor };
      }

      const live = {
        tenantId: actor.tenantId,
        state: { notIn: TERMINAL_STATES },
        expiresAt: { gt: now },
      };
      const [perUser, perTenant] = await Promise.all([
        tx.importSession.count({
          where: { ...live, ownerUserId: actor.userId },
        }),
        tx.importSession.count({ where: live }),
      ]);
      if (
        perUser >= IMPORT_SESSION_LIMITS.activeSessionsPerUser ||
        perTenant >= IMPORT_SESSION_LIMITS.activeSessionsPerTenant
      ) {
        throw new ImportSessionError(ImportSessionErrorCode.LIMIT_EXCEEDED);
      }

      const row = await tx.importSession.create({
        data: {
          id: randomUUID(),
          tenantId: actor.tenantId,
          ownerUserId: actor.userId,
          ownerProjectId: card.projectId,
          cardId: card.cardId,
          kind: IMPORT_SESSION_KIND,
          state: ImportSessionState.DRAFT,
          revision: 1,
          createRequestId: request.createRequestId,
          createPayloadHash: hash,
          consentPolicyVersion: request.consentPolicyVersion,
          consentedAt: now,
          lastUserEditAt: now,
          expiresAt: new Date(
            now.getTime() + IMPORT_SESSION_LIMITS.draftRetentionSeconds * 1000,
          ),
          draftJson: EMPTY_DRAFT_JSON,
        },
      });
      return { row, created: true, actor };
    });
    // A replay may return an APPLIED session: its receipt still passes the participant gate.
    const rendered = await this.readTransaction((tx, readAt) =>
      this.renderForActor(tx, outcome.actor, outcome.row, readAt),
    );
    return { view: rendered.view, created: outcome.created };
  }

  /**
   * Recovery list (read). Not blocked by the writes kill switch: the switch only closes new
   * sessions/uploads. One read transaction covers reauth, grants and the page; only the signing
   * key gate (CAPABILITY_DISABLED in production without a safe secret) can close it.
   */
  async list(
    auth: AuthenticatedImportContext,
    query: unknown,
  ): Promise<ImportSessionListV1> {
    assertImportSessionOperationAvailable(
      "READ_SESSION",
      this.capability.writesEnabled(),
    );
    assertMintedImportContext(auth);
    const request = parseListQuery(query);
    return this.readTransaction(async (tx, now) => {
      // Identity first (401), in the same snapshot; only a valid actor can meet the key gate (503).
      const actor = await reauthorize(tx, auth, now);
      const key = deriveCursorKey();
      const binding = {
        tenantId: actor.tenantId,
        userId: actor.userId,
        filter: request.filter,
      };
      const after =
        request.cursor === null
          ? null
          : verifyListCursor(key, binding, request.cursor, now);
      const rows = await queryVisibleSessions(tx, {
        tenantId: actor.tenantId,
        userId: actor.userId,
        filter: request.filter,
        now,
        grants: await listScopeParams(tx, actor),
        after,
      });
      const page = rows.slice(0, IMPORT_LIST_PAGE_SIZE);
      const counts = await tx.importSessionArtifact.groupBy({
        by: ["sessionId", "ownerProjectId"],
        where: {
          tenantId: actor.tenantId,
          sessionId: { in: page.map((row) => row.columns.id) },
          state: { not: "RELEASED" },
        },
        _count: { _all: true },
      });
      const attachments = new Map(
        counts.map((row) => [
          `${row.sessionId}|${row.ownerProjectId}`,
          row._count._all,
        ]),
      );
      const items = page.map((row) =>
        projectSummary(
          row.columns,
          attachments.get(`${row.columns.id}|${row.columns.ownerProjectId}`) ??
            0,
        ),
      );
      const last = page[page.length - 1];
      const nextCursor =
        rows.length > IMPORT_LIST_PAGE_SIZE && last
          ? signListCursor(key, binding, last.position, now)
          : null;
      return { items, nextCursor, entry: this.projectEntry() };
    });
  }

  private projectEntry(): ImportSessionEntryV1 {
    const formats = this.capability.newImportFormats();
    if (!Array.isArray(formats) || new Set(formats).size !== formats.length)
      throw new TypeError("Invalid import entry formats");
    // Iteration visits sparse slots, unlike Array.every/some.
    for (const format of formats) {
      if (!ENTRY_FORMATS.has(format))
        throw new TypeError("Invalid import entry formats");
    }
    if (
      !importIntakeEnabled(this.capability) ||
      this.gate.boot.stopped.aborted ||
      this.gate.boot.runtime() === null ||
      formats.length === 0
    )
      return { kind: "UNAVAILABLE" };
    return {
      kind: "CARD_INVOICE",
      formats: [...formats],
    };
  }

  async getSession(
    auth: AuthenticatedImportContext,
    id: string,
  ): Promise<ImportSessionViewV1> {
    return (await this.read(auth, id)).view;
  }

  async getResult(
    auth: AuthenticatedImportContext,
    id: string,
  ): Promise<ImportSessionResultV1> {
    const { view } = await this.read(auth, id);
    return { state: view.state, receipt: view.receipt };
  }

  async getObservations(
    auth: AuthenticatedImportContext,
    id: string,
    query: unknown = {},
  ): Promise<ImportSessionPageV1<ImportSessionObservationViewV1>> {
    const request = parsePageQuery(query, false);
    return this.readCollection(
      auth,
      id,
      "OBSERVATIONS",
      request,
      async (tx, actor, row, draft) => {
        const { references, observations } = await this.scopedObservations(
          tx,
          row,
          draft,
        );
        const byArtifact = new Map(
          references.map((ref) => [ref.artifactId, ref]),
        );
        return observations.map((observation) => {
          const ref = byArtifact.get(observation.artifactId);
          if (!ref) throw notFound();
          return {
            kind: "OBSERVATION" as const,
            value: projectImportObservation(row, draft.scope, observation, ref),
          };
        });
      },
    );
  }

  async getCandidates(
    auth: AuthenticatedImportContext,
    id: string,
    query: unknown,
  ): Promise<ImportSessionPageV1<ImportSessionCandidateV1>> {
    const request = parsePageQuery(query, true);
    return this.readCollection(
      auth,
      id,
      "CANDIDATES",
      request,
      async (tx, actor, row, draft) => {
        const search = parseStoredImportSearch(
          row.searchJson,
          row.confirmedRevision ?? row.revision,
          draft,
        );
        if (search.kind === "EMPTY_SEARCH") return [];
        const refs = search.value.candidates.filter(
          (candidate) => candidate.lineId === request.lineId,
        );
        const line = draft.lines.find((item) => item.id === request.lineId);
        if (!line) throw invalid();
        return (
          await this.projectCandidates(tx, actor, row, draft, line, refs)
        ).map((value) => ({ kind: value.kind, value }));
      },
    );
  }

  async cancel(
    auth: AuthenticatedImportContext,
    id: string,
    body: unknown,
    grant: unknown,
  ): Promise<ImportSessionViewV1> {
    assertImportSessionOperationAvailable(
      "CANCEL",
      this.capability.writesEnabled(),
    );
    assertMintedImportContext(auth);
    assertSessionId(id);
    const request = parseRevisionRequest(body);
    let grantSpent = false;
    const outcome = await this.write(auth, async (tx, now) => {
      const actor = await reauthorize(tx, auth, now);
      if (!grantSpent) {
        this.verifier.verify(
          grant,
          auth,
          {
            operation: "CANCEL_SESSION",
            sessionId: id,
            expectedRevision: request.expectedRevision,
          },
          now,
        );
        grantSpent = true;
      }
      const session = await this.loadOwned(tx, actor, id);
      // D3: cancel re-runs the full ACL; a revoked actor sees the same opaque NOT_FOUND.
      await assertCardAccess(tx, actor, session.cardId);

      const state = session.state;
      if (state === ImportSessionState.APPLIED)
        throw this.alreadyApplied(session);
      if (
        state === ImportSessionState.CANCELLED ||
        state === ImportSessionState.EXPIRED ||
        effectiveState(session, now) === ImportSessionState.EXPIRED
      ) {
        return { row: session, invalidatedClaims: [] }; // idempotent no-op
      }
      if (session.revision !== request.expectedRevision) {
        throw new ImportSessionError(ImportSessionErrorCode.REVISION_CONFLICT, {
          sessionId: session.id,
          currentRevision: session.revision,
        });
      }

      const closed = await tx.importSession.updateMany({
        where: {
          id: session.id,
          tenantId: actor.tenantId,
          ownerUserId: actor.userId,
          revision: request.expectedRevision,
          state: { in: CANCELLABLE_STATE_LIST },
          financialRequestId: session.financialRequestId,
        },
        data: {
          state: ImportSessionState.CANCELLED,
          revision: Math.min(
            session.revision + 1,
            IMPORT_SESSION_PRIMITIVES.maxRevision,
          ),
          draftJson: EMPTY_DRAFT_JSON,
          searchJson: null,
          proposalJson: null,
          // The SQL tuple check requires the hash while a confirmation tuple exists.
          proposalHash:
            session.financialRequestId === null ? null : session.proposalHash,
          preflightHash: null,
          challengeJson: null,
          prepareLeaseJson: null,
          prepareGeneration: { increment: 1 },
          closedAt: now,
        },
      });
      if (closed.count === 0) {
        const latest = await this.loadOwned(tx, actor, id);
        if (latest.state === ImportSessionState.APPLIED)
          throw this.alreadyApplied(latest);
        if (
          latest.state === ImportSessionState.CANCELLED ||
          latest.state === ImportSessionState.EXPIRED
        ) {
          return { row: latest, invalidatedClaims: [] };
        }
        throw new ImportSessionError(ImportSessionErrorCode.REVISION_CONFLICT, {
          sessionId: latest.id,
          currentRevision: latest.revision,
        });
      }

      // Invalidate shared-parse leases of THIS session only (never another session's).
      const invalidatedClaims: ImportRawClaim[] = [];
      const leases = await tx.importArtifact.findMany({
        where: {
          tenantId: actor.tenantId,
          ownerProjectId: session.ownerProjectId,
          leaseSessionId: session.id,
        },
        select: { id: true, parseGeneration: true, state: true },
      });
      for (const lease of leases) {
        const claim = {
          tenantId: actor.tenantId,
          ownerProjectId: session.ownerProjectId,
          sessionId: session.id,
          artifactId: lease.id,
          parseGeneration: lease.parseGeneration,
        };
        const changed = await tx.importArtifact.updateMany({
          where: {
            id: claim.artifactId,
            tenantId: claim.tenantId,
            ownerProjectId: claim.ownerProjectId,
            leaseSessionId: claim.sessionId,
            parseGeneration: claim.parseGeneration,
          },
          data: {
            leaseSessionId: null,
            leaseSessionVersion: null,
            leaseTokenExpiresAt: null,
            leaseExpiresAt: null,
            parseGeneration: { increment: 1 },
            ...(lease.state === "ANALYZING" ? { state: "RAW_READY" } : {}),
          },
        });
        if (changed.count === 1) invalidatedClaims.push(claim);
      }
      // Release the session's references for the (later) reaper. Reserved bytes and storage
      // keys stay: quota is only given back after a physical purge, never by this write.
      const live = {
        tenantId: actor.tenantId,
        sessionId: session.id,
        state: { not: "RELEASED" },
      };
      await tx.importSessionArtifact.updateMany({
        where: { ...live, temporaryStorageKey: { not: null } },
        data: { temporaryPurgePending: true },
      });
      await tx.importSessionArtifact.updateMany({
        where: live,
        data: releasedAttachmentData(now),
      });
      await purgeCompletedSessionObservationEvidence(tx, {
        tenantId: session.tenantId,
        ownerProjectId: session.ownerProjectId,
        sessionId: session.id,
      });
      return { row: await this.loadOwned(tx, actor, id), invalidatedClaims };
    });
    this.raw.abortOwned(outcome.invalidatedClaims, "CANCEL");
    // Read the persisted result back through the same projection (no authority needed for the
    // view of what this very actor just closed).
    return (
      await this.render(this.prisma, outcome.row, this.clock.now(), {
        includeReceipt: false,
      })
    ).view;
  }

  // -- internals ------------------------------------------------------------------------

  private async readCollection<T extends { id: string }>(
    auth: AuthenticatedImportContext,
    id: string,
    collection: ImportPageCursorBinding["collection"],
    request: { cursor: string | null; lineId: string | null },
    load: (
      tx: Tx,
      actor: ImportActor,
      row: ImportSession,
      draft: ImportSessionStoredDraftV1,
    ) => Promise<Array<{ kind: ImportPagePosition["kind"]; value: T }>>,
  ): Promise<ImportSessionPageV1<T>> {
    assertMintedImportContext(auth);
    assertSessionId(id);
    return this.readTransaction(async (tx, now) => {
      const actor = await reauthorize(tx, auth, now);
      const row = await this.loadOwned(tx, actor, id);
      await assertImportSessionAccess(tx, actor, row, now);
      const state = effectiveState(row, now);
      if (
        state === ImportSessionState.CANCELLED ||
        state === ImportSessionState.EXPIRED ||
        state === ImportSessionState.APPLIED
      )
        return { items: [], nextCursor: null };
      try {
        const { stored: draft } = parseSessionDocuments(row);
        if (
          collection === "CANDIDATES" &&
          !draft.selectedLineIds.includes(request.lineId ?? "")
        )
          throw invalid();
        const key = deriveCursorKey();
        const binding: ImportPageCursorBinding = {
          tenantId: actor.tenantId,
          userId: actor.userId,
          sessionId: row.id,
          revision: row.revision,
          collection,
          lineId: request.lineId,
          queryHash: createHash("sha256")
            .update(
              collection === "CANDIDATES"
                ? (row.searchJson ?? "null")
                : JSON.stringify(draft.scope),
            )
            .digest("hex"),
        };
        const after =
          request.cursor === null
            ? null
            : verifyPageCursor(key, binding, request.cursor, now);
        const items = (await load(tx, actor, row, draft))
          .map((item) => ({ ...item, id: item.value.id }))
          .sort(pageOrder)
          .filter((item) => after === null || pageOrder(item, after) > 0);
        const page = items.slice(0, IMPORT_SESSION_LIMITS.pageSize);
        return {
          items: page.map((item) => item.value),
          nextCursor:
            items.length > page.length
              ? signPageCursor(key, binding, page[page.length - 1], now)
              : null,
        };
      } catch (error) {
        if (error instanceof ImportSessionCorruptStateError)
          error.sessionId = row.id;
        throw error;
      }
    });
  }

  private async scopedObservations(
    tx: Tx,
    row: ImportSession,
    draft: ImportSessionStoredDraftV1,
  ): Promise<{
    references: ImportSessionArtifact[];
    observations: ImportObservation[];
  }> {
    const references = await tx.importSessionArtifact.findMany({
      where: {
        sessionId: row.id,
        tenantId: row.tenantId,
        ownerProjectId: row.ownerProjectId,
        state: "ATTACHED",
        artifact: {
          tenantId: row.tenantId,
          ownerProjectId: row.ownerProjectId,
        },
      },
      take: IMPORT_SESSION_LIMITS.filesPerSession + 1,
    });
    if (references.length > IMPORT_SESSION_LIMITS.filesPerSession)
      throw new ImportSessionCorruptStateError("attachments");
    const artifactIds = references.flatMap((ref) =>
      ref.artifactId === null ? [] : [ref.artifactId],
    );
    const observations: ImportObservation[] = [];
    if (artifactIds.length)
      for (const ids of chunks(draft.scope.observationIds)) {
        observations.push(
          ...(await tx.importObservation.findMany({
            where: {
              tenantId: row.tenantId,
              ownerProjectId: row.ownerProjectId,
              id: { in: ids },
              artifactId: { in: artifactIds },
            },
            orderBy: { id: "asc" },
          })),
        );
      }
    return { references, observations };
  }

  private async projectCandidates(
    tx: Tx,
    actor: ImportActor,
    row: ImportSession,
    draft: ImportSessionStoredDraftV1,
    line: ImportSessionDraftLineV1,
    refs: ImportCandidateRef[],
  ): Promise<ImportSessionCandidateV1[]> {
    const [visible, visibleReceipts] = await Promise.all(
      [EXPENSE_MODULE, RECEIPT_MODULE].map(async (requiredModule) => {
        const scope = await resolveAccessibleProjectScope(
          tx,
          actor.tenantId,
          actor.role,
          actor.allowedProjects,
          actor.allowedProjectTypes,
          actor.allowedModules,
          requiredModule,
        );
        const activeProjects = await tx.project.findMany({
          where: {
            tenantId: actor.tenantId,
            deletedAt: null,
            ...(scope === null ? {} : { id: { in: scope } }),
          },
          select: { id: true },
        });
        return new Set(activeProjects.map((project) => project.id));
      }),
    );
    const facts: CardImportFacts = {
      companions: [],
      receipts: [],
      imports: [],
      cards: [],
    };
    // Hydrate the complete stored catalogue, not a fresh matching recipe or a page-sized negative proof.
    let materialized = 0;
    const count = <T>(rows: T[]): T[] => {
      materialized += rows.length;
      if (
        materialized > IMPORT_SESSION_LIMITS.matchingRowsVisitedPerPreparation
      )
        throw new ImportSessionError(ImportSessionErrorCode.SEARCH_TOO_BROAD);
      return rows;
    };
    const take = () =>
      IMPORT_SESSION_LIMITS.matchingRowsVisitedPerPreparation -
      materialized +
      1;
    for (const ids of chunks(
      refs.filter((ref) => ref.kind === "EXPENSE").map((ref) => ref.id),
    )) {
      const roots = count(
        await tx.expense.findMany({
          where: {
            tenantId: actor.tenantId,
            id: { in: ids },
            deletedAt: INCLUDE_SOFT_DELETED,
          },
          include: {
            _count: {
              select: {
                cashFlow: { where: { tenantId: { not: actor.tenantId } } },
              },
            },
          },
          take: take(),
        }),
      );
      const cash = count(
        await tx.cashFlowEntry.findMany({
          where: {
            tenantId: actor.tenantId,
            expenseId: { in: roots.map((root) => root.id) },
            deletedAt: null,
          },
          take: take(),
        }),
      );
      facts.companions.push(
        ...roots.map((root) => ({
          ...root,
          cashFlow: cash.filter((item) => item.expenseId === root.id),
        })),
      );
    }
    for (const ids of chunks(
      refs.filter((ref) => ref.kind === "RECEIPT").map((ref) => ref.id),
    )) {
      facts.receipts.push(
        ...count(
          await tx.receipt.findMany({
            where: {
              tenantId: actor.tenantId,
              id: { in: ids },
              deletedAt: INCLUDE_SOFT_DELETED,
            },
            take: take(),
          }),
        ),
      );
    }
    const importIds = [
      ...new Set(
        facts.companions.flatMap((root) =>
          root.importId ? [root.importId] : [],
        ),
      ),
    ];
    const imports: CardImportFacts["imports"][number][] = [];
    for (const ids of chunks(importIds))
      imports.push(
        ...count(
          await tx.creditCardStatementImport.findMany({
            where: {
              tenantId: actor.tenantId,
              id: { in: ids },
              deletedAt: INCLUDE_SOFT_DELETED,
            },
            select: { id: true, tenantId: true, cardId: true, deletedAt: true },
            take: take(),
          }),
        ),
      );
    facts.imports = imports;
    facts.cards = count(
      await tx.creditCard.findMany({
        where: {
          id: row.cardId,
          tenantId: actor.tenantId,
          deletedAt: INCLUDE_SOFT_DELETED,
        },
        select: {
          id: true,
          tenantId: true,
          projectId: true,
          last4: true,
          deletedAt: true,
        },
        take: take(),
      }),
    );
    type Participant = Pick<
      CardImportFacts["companions"][number],
      | "id"
      | "tenantId"
      | "projectId"
      | "deletedAt"
      | "linkedExpenseId"
      | "documentedSchedule"
    >;
    const participants = new Map<string, Participant>(
      facts.companions.map((root) => [root.id, root]),
    );
    const neighbours = new Map<string, Set<string>>();
    const extraProjects = new Map<string, Set<string>>();
    const connect = (left: string, right: string) => {
      for (const [a, b] of [
        [left, right],
        [right, left],
      ]) {
        const set = neighbours.get(a) ?? new Set<string>();
        set.add(b);
        neighbours.set(a, set);
      }
    };
    const visited = new Set<string>();
    let frontier = [...participants.keys()];
    while (frontier.length) {
      for (const ids of chunks(frontier)) {
        for (const id of ids) {
          visited.add(id);
          const entity = participants.get(id);
          if (!entity) continue;
          if (entity.linkedExpenseId) connect(id, entity.linkedExpenseId);
          if (entity.documentedSchedule === null) continue;
          let envelope: unknown;
          try {
            envelope = JSON.parse(entity.documentedSchedule);
          } catch (error) {
            if (error instanceof SyntaxError) continue; // Strict native parser runs after participant ACL.
            throw error;
          }
          if (!isPlainRecord(envelope)) continue;
          const projects = new Set<string>();
          for (const key of ["sourceProjectId", "targetProjectId"]) {
            const project = envelope[key];
            if (typeof project === "string" && ID.test(project))
              projects.add(project);
          }
          extraProjects.set(id, projects);
          const sourceId = envelope.sourceExpenseId;
          if (typeof sourceId === "string" && ID.test(sourceId))
            connect(id, sourceId);
          if (Array.isArray(envelope.projections))
            for (const target of envelope.projections) {
              if (
                isPlainRecord(target) &&
                typeof target.targetExpenseId === "string" &&
                ID.test(target.targetExpenseId)
              )
                connect(id, target.targetExpenseId);
            }
        }
        const allocations = count(
          await tx.rateioAllocation.findMany({
            where: {
              tenantId: actor.tenantId,
              OR: [
                { sourceExpenseId: { in: ids } },
                { targetExpenseId: { in: ids } },
              ],
            },
            select: { sourceExpenseId: true, targetExpenseId: true },
            take: take(),
          }),
        );
        for (const allocation of allocations)
          connect(allocation.sourceExpenseId, allocation.targetExpenseId);
        const related = count(
          await tx.expense.findMany({
            where: {
              tenantId: actor.tenantId,
              linkedExpenseId: { in: ids },
              deletedAt: INCLUDE_SOFT_DELETED,
            },
            select: {
              id: true,
              tenantId: true,
              projectId: true,
              deletedAt: true,
              linkedExpenseId: true,
              documentedSchedule: true,
            },
            take: take(),
          }),
        );
        for (const entity of related) {
          participants.set(entity.id, entity);
          if (entity.linkedExpenseId)
            connect(entity.id, entity.linkedExpenseId);
        }
      }
      const missing = [...neighbours.keys()].filter(
        (id) => !participants.has(id) && !visited.has(id),
      );
      for (const ids of chunks(missing)) {
        const found = count(
          await tx.expense.findMany({
            where: {
              tenantId: actor.tenantId,
              id: { in: ids },
              deletedAt: INCLUDE_SOFT_DELETED,
            },
            select: {
              id: true,
              tenantId: true,
              projectId: true,
              deletedAt: true,
              linkedExpenseId: true,
              documentedSchedule: true,
            },
            take: take(),
          }),
        );
        for (const entity of found) participants.set(entity.id, entity);
        for (const id of ids) if (!participants.has(id)) visited.add(id);
      }
      frontier = [...participants.keys()].filter((id) => !visited.has(id));
    }
    const allParticipantsVisible = (rootId: string): boolean => {
      const checked = new Set<string>();
      const pending = [rootId];
      while (pending.length) {
        const id = pending.pop()!;
        if (checked.has(id)) continue;
        checked.add(id);
        const entity = participants.get(id);
        if (
          !entity ||
          entity.tenantId !== actor.tenantId ||
          entity.deletedAt ||
          !visible.has(entity.projectId) ||
          [...(extraProjects.get(id) ?? [])].some(
            (projectId) => !visible.has(projectId),
          )
        )
          return false;
        pending.push(...(neighbours.get(id) ?? []));
      }
      return true;
    };
    const scoped = await this.scopedObservations(tx, row, draft);
    const selected = scoped.observations.filter((observation) =>
      line.observationIds.includes(observation.id),
    );
    if (!selected.length || selected.length !== line.observationIds.length)
      throw notFound();
    const artifactIds = [
      ...new Set(
        scoped.observations.map((observation) => observation.artifactId),
      ),
    ];
    const artifacts = count(
      await tx.importArtifact.findMany({
        where: {
          tenantId: actor.tenantId,
          ownerProjectId: row.ownerProjectId,
          id: { in: artifactIds },
        },
        select: {
          id: true,
          tenantId: true,
          ownerProjectId: true,
          documentSha256: true,
        },
        take: Math.min(take(), IMPORT_SESSION_LIMITS.filesPerSession + 1),
      }),
    );
    if (artifacts.length !== artifactIds.length) throw notFound();
    const declarations = resolveImportDeclarations(row, draft, {
      observations: scoped.observations,
      references: scoped.references.map((ref) => ({
        ref,
        artifact:
          artifacts.find((artifact) => artifact.id === ref.artifactId) ?? null,
      })),
    });
    const evidence = selected.map((observation) => {
      const ref = scoped.references.find(
        (item) => item.artifactId === observation.artifactId,
      );
      const resolved = declarations.byLine.get(line.id)?.get(observation.id);
      if (!ref || !resolved) throw notFound();
      const effective = resolved.effective;
      return {
        resolved,
        view: {
          ...projectImportObservation(row, draft.scope, observation, ref),
          dataCompra: effective.dataCompra,
          amountMeaning: effective.amountMeaning,
          amountCents: effective.amountCents,
          installmentCount: effective.installmentCount,
          installmentIndex: effective.installmentIndex,
        },
      };
    });
    const canKeep = (id: string): boolean =>
      evidence.every(({ resolved }) => {
        const { effective } = resolved;
        const keys = importObservationDedupeKeys(row, resolved);
        if (
          keys === null ||
          effective.merchant === null ||
          effective.installmentCount === null
        )
          return false;
        const compatibility = checkCardImportKeep(
          actor.tenantId,
          {
            cardId: row.cardId,
            projectId: row.ownerProjectId,
            merchant: effective.merchant,
            total: effective.installmentCount,
            seriesKey: null,
            externalId: keys.externalId,
            dedupeKeyStrong: keys.strong,
          },
          facts,
          id,
          line,
          evidence.map((item) => item.view),
        );
        return compatibility.kind === "COMPATIBLE";
      });
    const result: ImportSessionCandidateV1[] = [];
    for (const ref of refs) {
      const entity =
        ref.kind === "EXPENSE"
          ? facts.companions.find((item) => item.id === ref.id)
          : facts.receipts.find((item) => item.id === ref.id);
      const resourceProjects =
        ref.kind === "RECEIPT" ? visibleReceipts : visible;
      if (
        !entity ||
        entity.deletedAt ||
        !resourceProjects.has(entity.projectId)
      )
        continue;
      if ("documentedSchedule" in entity) {
        if (!allParticipantsVisible(entity.id)) continue;
        try {
          parseStoredExpenseSchedule(entity.documentedSchedule);
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === "Invalid documented expense schedule"
          )
            throw new ImportSessionCorruptStateError("candidate");
          throw error;
        }
        const date =
          entity.dataCompra ?? entity.dataPagamento ?? entity.dataInicioParcela;
        if (!date) throw new ImportSessionCorruptStateError("candidate");
        result.push({
          ...ref,
          projectId: entity.projectId,
          description: entity.titulo ?? entity.fornecedor ?? "",
          amountCents: entity.valorTotal,
          date: date.toISOString().slice(0, 10),
          canKeepExisting: canKeep(entity.id),
        });
      } else {
        result.push({
          ...ref,
          projectId: entity.projectId,
          description: entity.descricao ?? "",
          amountCents: entity.valor,
          date: entity.data.toISOString().slice(0, 10),
          canKeepExisting: false,
        });
      }
    }
    return result;
  }

  private async read(auth: AuthenticatedImportContext, id: string) {
    assertMintedImportContext(auth);
    assertSessionId(id);
    // ONE read transaction: reauth, ownership, card, participant ACL and projection see the
    // same snapshot. No explicit tenant-row mutation; SQLite may still reserve the writer.
    return this.readTransaction(async (tx, now) => {
      const actor = await reauthorize(tx, auth, now);
      const row = await this.loadOwned(tx, actor, id);
      await assertImportSessionAccess(tx, actor, row, now);
      const canMutate = await canMutateImportSession(
        tx,
        actor,
        row.ownerProjectId,
      );
      return this.render(tx, row, now, {
        includeReceipt: true,
        workflow: {
          writesEnabled: await importSessionWritesEnabled(
            tx,
            row,
            this.capability,
          ),
          canMutate,
          presentedSessionVersion: auth.presentedSessionVersion,
        },
      });
    });
  }

  private async renderForActor(
    db: Tx,
    actor: ImportActor,
    row: ImportSession,
    now: Date,
  ) {
    await assertImportSessionAccess(db, actor, row, now);
    return this.render(db, row, now, { includeReceipt: true });
  }

  private async readTransaction<T>(
    work: (tx: Tx, now: Date) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.prisma.$transaction(
          (tx) => work(tx, this.clock.now()),
          {
            maxWait: IMPORT_SESSION_LIMITS.transactionMaxWaitMs,
            timeout: IMPORT_SESSION_LIMITS.transactionTimeoutMs,
          },
        );
      } catch (error) {
        if (!isRetryableWriteFailure(error)) throw error;
        if (attempt >= IMPORT_SESSION_LIMITS.writeAttempts) {
          throw new ImportSessionError(
            ImportSessionErrorCode.RETRYABLE_WRITE_CONFLICT,
          );
        }
      }
    }
  }

  /** Owner-only, tenant-only lookup; every miss is the same opaque NOT_FOUND. */
  private async loadOwned(
    db: Db,
    actor: ImportActor,
    id: string,
  ): Promise<ImportSession> {
    return loadOwnedImportSession(db, actor, id);
  }

  private async render(
    db: Db,
    row: ImportSession,
    now: Date,
    options: ProjectionOptions,
  ) {
    return renderImportSession(db, row, now, {
      ...options,
      qualifiedAnalysisFormats: this.capability.newImportFormats(),
      analysisEnabled:
        importIntakeEnabled(this.capability) &&
        !this.gate.boot.stopped.aborted &&
        this.gate.boot.runtime() !== null,
    });
  }

  private alreadyApplied(session: ImportSession): ImportSessionError {
    return new ImportSessionError(ImportSessionErrorCode.ALREADY_APPLIED, {
      sessionId: session.id,
      currentRevision: session.revision,
    });
  }

  private async write<T>(
    auth: AuthenticatedImportContext,
    work: (tx: Tx, now: Date) => Promise<T>,
  ): Promise<T> {
    return runImportSessionWrite(this.prisma, this.clock, auth, work);
  }
}

/** Shared owner/tenant lookup; the workflow calls it inside the existing writer. */
export async function loadOwnedImportSession(
  db: Db,
  actor: ImportActor,
  id: string,
): Promise<ImportSession> {
  const row = await db.importSession.findFirst({
    where: { id, tenantId: actor.tenantId, ownerUserId: actor.userId },
  });
  if (!row) throw notFound();
  return row;
}

export async function assertImportSessionAccess(
  db: Tx,
  actor: ImportActor,
  row: ImportSession,
  now: Date,
): Promise<void> {
  await assertCardAccess(db, actor, row.cardId, row.ownerProjectId);
  if (row.state === ImportSessionState.APPLIED && row.receiptJson !== null) {
    const participants = receiptParticipantEnvelope(row.receiptJson);
    if (participants !== null)
      await assertReceiptParticipantAccess(db, actor, participants);
  }
  const targets = draftProposalParticipantEnvelope(row, now);
  if (targets.length > 0)
    await assertReceiptParticipantAccess(db, actor, targets);
}

export async function canMutateImportSession(
  db: Tx,
  actor: ImportActor,
  ownerProjectId: string,
): Promise<boolean> {
  const scope = await resolveAccessibleProjectScope(
    db,
    actor.tenantId,
    actor.role,
    actor.allowedProjects,
    actor.allowedProjectTypes,
    actor.allowedModules,
    EXPENSE_MODULE,
  );
  return scope === null || scope.includes(ownerProjectId);
}

export async function renderImportSession(
  db: Db,
  row: ImportSession,
  now: Date,
  options: ProjectionOptions,
) {
  try {
    return await renderImportSessionUnchecked(db, row, now, options);
  } catch (error) {
    rethrowImportSessionProjectionError(error, row.id);
  }
}

async function renderImportSessionUnchecked(
  db: Db,
  row: ImportSession,
  now: Date,
  options: ProjectionOptions,
) {
  const attachments = await db.importSessionArtifact.findMany({
    where: {
      sessionId: row.id,
      tenantId: row.tenantId,
      ownerProjectId: row.ownerProjectId,
    },
  });
  const state = effectiveState(row, now);
  if (["APPLIED", "CANCELLED", "EXPIRED"].includes(state))
    return projectSession(row, attachments, now, options);
  const draft = parseStoredDraft(row.draftJson);
  const wanted = [
    ...new Set(draft.lines.flatMap((line) => line.observationIds)),
  ];
  const observations =
    wanted.length === 0
      ? []
      : await db.importObservation.findMany({
          where: {
            tenantId: row.tenantId,
            ownerProjectId: row.ownerProjectId,
            id: { in: wanted },
          },
          take: IMPORT_SESSION_LIMITS.parsedRowsPerSession + 1,
        });
  if (observations.length !== wanted.length)
    throw new ImportSessionCorruptStateError("evidence_json");
  const materialIds = [
    ...new Set(observations.map((observation) => observation.artifactId)),
  ];
  const metadata =
    materialIds.length === 0
      ? []
      : await db.importArtifact.findMany({
          where: {
            tenantId: row.tenantId,
            ownerProjectId: row.ownerProjectId,
            id: { in: materialIds },
          },
          select: {
            id: true,
            tenantId: true,
            ownerProjectId: true,
            documentSha256: true,
          },
          take: IMPORT_SESSION_LIMITS.filesPerSession + 1,
        });
  if (metadata.length !== materialIds.length)
    throw new ImportSessionCorruptStateError("declaration_material");
  const declarations = resolveImportDeclarations(row, draft, {
    observations,
    references: attachments.map((ref) => ({
      ref,
      artifact:
        metadata.find((artifact) => artifact.id === ref.artifactId) ?? null,
    })),
  });
  const eligible =
    options.analysisEnabled === true &&
    row.closedAt === null &&
    row.financialRequestId === null &&
    row.consentPolicyVersion === IMPORT_SESSION_CONSENT_POLICY_VERSION &&
    ["DRAFT", "NEEDS_INPUT", "READY", "REVIEW_REQUIRED"].includes(state);
  const artifactIds = eligible
    ? attachments
        .filter(
          (ref) =>
            ref.state === "ATTACHED" &&
            draft.scope.pendingAttachmentIds.includes(ref.id),
        )
        .flatMap((ref) => (ref.artifactId === null ? [] : [ref.artifactId]))
    : [];
  const artifacts =
    artifactIds.length === 0
      ? []
      : await db.importArtifact.findMany({
          where: {
            tenantId: row.tenantId,
            ownerProjectId: row.ownerProjectId,
            id: { in: artifactIds },
            AND: [
              {
                OR: [
                  { leaseExpiresAt: null },
                  { leaseExpiresAt: { lte: now } },
                ],
              },
              {
                OR: [
                  { state: "EXTRACTED", extractionJson: { not: null } },
                  ...(options.analysisEnabled === true
                    ? [
                        {
                          state: "RAW_READY",
                          detectedFormat: {
                            in: [
                              ...(options.qualifiedAnalysisFormats ?? ["CSV"]),
                            ],
                          },
                        },
                      ]
                    : []),
                ],
              },
            ],
          },
          select: {
            id: true,
            detectedFormat: true,
            parserVersion: true,
            state: true,
            storageKey: true,
            verifiedBytes: true,
          },
        });
  return projectSession(row, attachments, now, {
    ...options,
    documentary: {
      questions: declarations.questions,
      declaredFacts: declarations.declaredFacts,
      reviewBlockers: declarations.reviewBlockers,
      executableAttachmentIds: attachments
        .filter((ref) =>
          artifacts.some(
            (artifact) =>
              artifact.id === ref.artifactId &&
              (options.qualifiedAnalysisFormats
                ? options.qualifiedAnalysisFormats.includes(
                    artifact.detectedFormat ?? "",
                  )
                : options.csvOnlyAnalysis !== true ||
                  artifact.detectedFormat === "CSV") &&
              (supportsImportExtraction(artifact) ||
                (options.analysisEnabled === true &&
                  (artifact.detectedFormat === "CSV" ||
                    artifact.detectedFormat === "PDF") &&
                  artifact.state === "RAW_READY" &&
                  artifact.storageKey !== null &&
                  artifact.verifiedBytes > 0)),
          ),
        )
        .map((ref) => ref.id),
    },
  });
}
import {
  releasedAttachmentData,
  purgeCompletedSessionObservationEvidence,
} from "./vault/completed-retention";
