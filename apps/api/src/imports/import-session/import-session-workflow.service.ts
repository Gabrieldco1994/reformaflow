import {
  releaseCompletedSessionAttachments,
  purgeCompletedSessionObservationEvidence,
} from "./vault/completed-retention";
import { EMPTY_DRAFT_JSON } from "./import-session.projection";
import { cardImportConfiguration } from "@reformaflow/domain";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type {
  ImportArtifact,
  ImportObservation,
  ImportSession,
  ImportSessionArtifact,
  Prisma,
} from "@prisma/client";
import {
  IMPORT_SESSION_LIMITS as LIMITS,
  IMPORT_SESSION_PRIMITIVES as PRIMITIVES,
  IMPORT_SESSION_PROTOCOL_VERSION,
  ImportSessionArtifactState,
  ImportSessionAttachmentState,
  ImportSessionErrorCode as Code,
  ImportSessionState as State,
  type ImportSessionChallengeRequestV1,
  type ImportSessionChallengeResponseV1,
  type ImportSessionConfirmRequestV1,
  type ImportSessionConfirmResponseV1,
  type ImportSessionEditRequestV1,
  type ImportSessionDocumentaryAnswerRequestV1,
  type ImportSessionFocusedDraftAnswerRequestV1,
  type ImportSessionExecuteRequestV1,
  type ImportSessionProposalV1,
  type ImportSessionReceiptV1,
  type ImportSessionStoredDraftV1,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import { canonical } from "../../common/canonical";
import type { PrismaService } from "../../prisma/prisma.service";
import {
  assertMintedImportContext,
  assertReceiptParticipantAccess,
  reauthorize,
  type ImportActor,
} from "./import-session.auth";
import type { CardPurchaseBatchPort } from "./card-purchase-batch.port";
import type {
  ImportSessionCapability,
  ImportSessionClock,
} from "./import-session.capability";
import {
  importIntakeEnabled,
  importSessionWritesEnabled,
} from "./import-session.capability";
import {
  assertPreparedCardBatch,
  mintLockedImportSession,
  releaseLockedImportSession,
  type AuthenticatedImportContext,
  type PreparedCardBatch,
  type UiImportFinancialActionVerifier,
  type UiImportPersistenceGrantVerifier,
} from "./import-session.contract";
import { assertImportSessionOperationAvailable } from "./import-session.disabled";
import {
  ImportSessionCorruptStateError,
  ImportSessionError,
} from "./import-session.errors";
import {
  EMPTY_IMPORT_OBSERVATION_CLAIM as EMPTY_CLAIM,
  projectImportObservation,
} from "./import-session.observation";
import {
  buildImportPreparationPlan,
  type ImportPreparationPlanV1,
} from "./import-session.preparation";
import {
  effectiveState,
  parseStoredDraft,
  parseReceipt,
} from "./import-session.projection";
import { parseStoredImportSearch } from "./import-session.search";
import {
  assertSessionId,
  assertImportSessionAccess,
  loadOwnedImportSession,
  parseRevisionRequest,
  renderImportSession,
} from "./import-session.service";
import { validateStoredDraft } from "./import-session.validation";
import { runImportSessionWrite } from "./import-session.writer";
import type { ImportVaultGate } from "./vault/vault-state";
import {
  ImportRawExecutions,
  type ImportRawClaim,
} from "./import-session.raw-executions";
import {
  assertLiveImportConversationWrite,
  reservedImportChatWrite,
  freezeImportChatValue,
  type ImportChatAdmission,
  type ImportConversationWriteBinding,
} from "./import-chat.admission";
import type { ResolvedImportAnswerV1 } from "./import-chat-answer";
import {
  recordImportDeclaration,
  recordNativeImportDeclaration,
  reconcileImportDeclarationDraft,
  resolveImportDeclarations,
} from "./import-session.declarations";
import {
  documentaryAnswerScope,
  parseDocumentaryAnswerRequest,
} from "./import-session.native-answer";
import {
  focusedDraftAnswerScope,
  parseFocusedDraftAnswerRequest,
} from "./import-session.focused-draft-answer";

type ConversationAnswer =
  | Extract<ResolvedImportAnswerV1, { kind: "VALUE" }>
  | { kind: "DECLARE_OBSERVATION" };

type Tx = Prisma.TransactionClient;
type Material = {
  observations: ImportObservation[];
  references: { ref: ImportSessionArtifact; artifact: ImportArtifact | null }[];
};
const ID = new RegExp(PRIMITIVES.idPattern);
const HASH = new RegExp(PRIMITIVES.hashPattern);
const REQUEST_ID = new RegExp(PRIMITIVES.requestIdPattern);
const INSTANT = new RegExp(PRIMITIVES.instantPattern);
const READ_CHUNK = 300;
const AUDIT_ACTION = "importSessions.execute";
const CONTINUATION_PAYLOAD_KIND = "CONTINUATION_V1";
const editableStates: ReadonlySet<string> = new Set([
  State.DRAFT,
  State.ANALYZING,
  State.NEEDS_INPUT,
  State.READY,
  State.REVIEW_REQUIRED,
]);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is string =>
  typeof value === "string" && ID.test(value);
const hash = (value: unknown): value is string =>
  typeof value === "string" && HASH.test(value);
const same = (left: unknown, right: unknown): boolean =>
  canonical(left) === canonical(right);
const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const invalid = () => new ImportSessionError(Code.INVALID_INPUT);
const corrupt = (field: string) => new ImportSessionCorruptStateError(field);
const problem = (code: Code, row: ImportSession) =>
  new ImportSessionError(code, {
    sessionId: row.id,
    currentRevision: row.revision,
  });

function envelope(
  body: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !record(body) ||
    Object.keys(body).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(body, key))
  )
    throw invalid();
  return body;
}
export function parseChallengeRequest(
  body: unknown,
): ImportSessionChallengeRequestV1 {
  const value = envelope(body, ["expectedRevision", "proposalHash"]);
  if (!hash(value.proposalHash)) throw invalid();
  return {
    ...parseRevisionRequest({ expectedRevision: value.expectedRevision }),
    proposalHash: value.proposalHash,
  };
}
export function parseConfirmRequest(
  body: unknown,
): ImportSessionConfirmRequestV1 {
  const value = envelope(body, [
    "expectedRevision",
    "proposalHash",
    "financialRequestId",
    "nonce",
  ]);
  if (
    typeof value.financialRequestId !== "string" ||
    !REQUEST_ID.test(value.financialRequestId) ||
    !(value.nonce === null || typeof value.nonce === "string")
  )
    throw invalid();
  if (
    Buffer.byteLength(JSON.stringify(value), "utf8") >
    LIMITS.jsonBytesPerDraftOrProposal
  )
    throw invalid();
  return {
    ...parseChallengeRequest({
      expectedRevision: value.expectedRevision,
      proposalHash: value.proposalHash,
    }),
    financialRequestId: value.financialRequestId,
    nonce: value.nonce,
  };
}
export function parseExecuteRequest(
  body: unknown,
): ImportSessionExecuteRequestV1 {
  const value = envelope(body, ["financialRequestId"]);
  if (
    typeof value.financialRequestId !== "string" ||
    !REQUEST_ID.test(value.financialRequestId)
  )
    throw invalid();
  return { financialRequestId: value.financialRequestId };
}
function editRequest(body: unknown): ImportSessionEditRequestV1 {
  const value = envelope(body, [
    "expectedRevision",
    "questionId",
    "replaceLines",
    "selectedLineIds",
  ]);
  if (
    !(value.questionId === null || id(value.questionId)) ||
    !Array.isArray(value.replaceLines) ||
    !Array.isArray(value.selectedLineIds) ||
    !value.selectedLineIds.every(id) ||
    value.selectedLineIds.length > LIMITS.selectedLines ||
    new Set(value.selectedLineIds).size !== value.selectedLineIds.length
  )
    throw invalid();
  let replacements: ImportSessionStoredDraftV1;
  try {
    replacements = validateStoredDraft({
      version: IMPORT_SESSION_PROTOCOL_VERSION,
      lines: value.replaceLines,
      selectedLineIds: [],
      questions: [],
      scope: {
        observationIds: [
          ...new Set(
            value.replaceLines.flatMap((line: unknown) =>
              record(line) && Array.isArray(line.observationIds)
                ? line.observationIds
                : [],
            ),
          ),
        ],
        pendingAttachmentIds: [],
      },
    });
  } catch (error) {
    if (error instanceof ImportSessionCorruptStateError) throw invalid();
    throw error;
  }
  return {
    ...parseRevisionRequest({ expectedRevision: value.expectedRevision }),
    questionId: value.questionId,
    replaceLines: structuredClone(replacements.lines),
    selectedLineIds: [...value.selectedLineIds],
  };
}
function nextRevision(row: ImportSession): number {
  if (row.revision >= PRIMITIVES.maxRevision)
    throw problem(Code.LIMIT_EXCEEDED, row);
  return row.revision + 1;
}
function cas(row: ImportSession): Prisma.ImportSessionWhereInput {
  return {
    id: row.id,
    tenantId: row.tenantId,
    ownerUserId: row.ownerUserId,
    ownerProjectId: row.ownerProjectId,
    cardId: row.cardId,
    revision: row.revision,
    state: row.state,
    financialRequestId: row.financialRequestId,
    confirmedRevision: row.confirmedRevision,
    proposalHash: row.proposalHash,
    confirmedSessionVersion: row.confirmedSessionVersion,
    confirmedAt: row.confirmedAt,
    preflightHash: row.preflightHash,
    closedAt: row.closedAt,
    receiptJson: row.receiptJson,
  };
}
function unclaimed(row: ImportObservation): boolean {
  return Object.keys(EMPTY_CLAIM).every(
    (key) => Reflect.get(row, key) === null,
  );
}

/** Privately composed by ImportSessionModule; no grant issuer or native financial implementation. */
export class ImportSessionWorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: ImportSessionClock,
    private readonly capability: ImportSessionCapability,
    private readonly verifier: UiImportFinancialActionVerifier &
      Partial<UiImportPersistenceGrantVerifier>,
    private readonly batches: CardPurchaseBatchPort,
    private readonly gate: ImportVaultGate,
    private readonly raw: ImportRawExecutions,
  ) {}

  async edit(
    auth: AuthenticatedImportContext,
    sessionId: string,
    body: unknown,
  ): Promise<ImportSessionViewV1> {
    this.identity(auth, sessionId);
    const request = editRequest(body);
    return this.editCore(auth, sessionId, request);
  }

  async documentaryAnswer(
    auth: AuthenticatedImportContext,
    sessionId: string,
    body: unknown,
    grant: unknown,
  ): Promise<ImportSessionViewV1> {
    this.identity(auth, sessionId);
    const request = parseDocumentaryAnswerRequest(body);
    if (!this.verifier.verify)
      throw new ImportSessionError(Code.UI_ACTION_REQUIRED);
    // Spend once per invocation, not once per SQLite retry. Locked context below
    // reauthorizes the actor and stable owner ACL before every attempt's edit.
    this.verifier.verify(
      grant,
      auth,
      documentaryAnswerScope(sessionId, request),
      this.clock.now(),
    );
    return this.editCore(auth, sessionId, null, undefined, undefined, request);
  }

  async focusedDraftAnswer(
    auth: AuthenticatedImportContext,
    sessionId: string,
    body: unknown,
    grant: unknown,
  ): Promise<ImportSessionViewV1> {
    this.identity(auth, sessionId);
    const request = parseFocusedDraftAnswerRequest(body);
    if (!this.verifier.verify)
      throw new ImportSessionError(Code.UI_ACTION_REQUIRED);
    // Admission is spent once per invocation; locked context below reauthorizes
    // actor/owner/project and resolves the exact current generic task on every retry.
    this.verifier.verify(
      grant,
      auth,
      focusedDraftAnswerScope(sessionId, request),
      this.clock.now(),
    );
    return this.editCore(
      auth,
      sessionId,
      null,
      undefined,
      undefined,
      undefined,
      request,
    );
  }

  async editConversationAnswer(
    auth: AuthenticatedImportContext,
    sessionId: string,
    command: ConversationAnswer,
    admission: ImportChatAdmission,
  ): Promise<ImportSessionViewV1> {
    this.identity(auth, sessionId);
    const binding = reservedImportChatWrite(
      admission,
      "EDIT",
      this.clock.now(),
    );
    if (binding.auth !== auth || binding.sessionId !== sessionId)
      throw new ImportSessionError(Code.UI_ACTION_REQUIRED);
    return this.editCore(
      auth,
      sessionId,
      null,
      binding,
      freezeImportChatValue(structuredClone(command)),
    );
  }

  private async editCore(
    auth: AuthenticatedImportContext,
    sessionId: string,
    httpRequest: ImportSessionEditRequestV1 | null,
    binding?: ImportConversationWriteBinding,
    command?: ConversationAnswer,
    nativeRequest?: ImportSessionDocumentaryAnswerRequestV1,
    focusedRequest?: ImportSessionFocusedDraftAnswerRequestV1,
  ): Promise<ImportSessionViewV1> {
    const assertLive = binding
      ? (): undefined =>
          assertLiveImportConversationWrite(binding, auth, this.clock.now())
      : undefined;
    return runImportSessionWrite(
      this.prisma,
      this.clock,
      auth,
      async (tx, now) => {
        assertLive?.();
        const { actor, row, view } = await this.context(
          tx,
          auth,
          sessionId,
          now,
        );
        assertImportSessionOperationAvailable(
          "EDIT",
          await importSessionWritesEnabled(tx, row, this.capability),
        );
        const draft = parseStoredDraft(row.draftJson);
        const turn = binding?.admission.turn;
        if (binding && (!turn?.focus || !command)) throw invalid();
        let updated: ImportSessionStoredDraftV1;
        if (nativeRequest) {
          this.editable(row, now, nativeRequest.expectedRevision);
          updated = recordNativeImportDeclaration(
            row,
            draft,
            await this.material(tx, row, draft, true),
            nativeRequest,
            { userId: actor.userId, now },
          );
        } else if (command?.kind === "DECLARE_OBSERVATION") {
          if (
            !binding ||
            turn?.intent !== "ANSWER" ||
            turn.scope.kind !== "LINES"
          )
            throw invalid();
          this.editable(row, now, binding.expectedRevision);
          const question = view.questions.find(
            (question) => question.id === turn.focus.id,
          );
          if (
            !question ||
            !("subject" in question) ||
            question.field !== turn.focus.field ||
            !same(question.lineIds, turn.focus.lineIds) ||
            !same(question.lineIds, turn.scope.lineIds)
          )
            throw problem(Code.REVISION_CONFLICT, row);
          updated = recordImportDeclaration(
            row,
            draft,
            await this.material(tx, row, draft, true),
            question.id,
            turn.literalAnswer,
            { userId: actor.userId, turnId: turn.turnId, now },
          );
        } else {
          let focusedEdit: ImportSessionEditRequestV1 | undefined;
          if (focusedRequest) {
            this.editable(row, now, focusedRequest.expectedRevision);
            const question = view.questions.find(
              (q) => q.id === focusedRequest.questionId && !("subject" in q),
            );
            if (!question || !draft.questions.some((q) => q.id === question.id))
              throw problem(Code.REVISION_CONFLICT, row);
            if (question.field !== focusedRequest.answer.field) throw invalid();
            const lines = question.lineIds.map((lineId) => {
              const line = draft.lines.find((line) => line.id === lineId);
              if (!line) throw invalid();
              // Server-owned clones only. No DTO replacement lines or selection scope.
              return focusedRequest.answer.field === "firstDueDate"
                ? { ...line, firstDueDate: focusedRequest.answer.value }
                : { ...line, tipoDespesa: focusedRequest.answer.value };
            });
            focusedEdit = editRequest({
              expectedRevision: focusedRequest.expectedRevision,
              questionId: question.id,
              replaceLines: lines,
              selectedLineIds: draft.selectedLineIds,
            });
          }
          const request =
            focusedEdit ??
            httpRequest ??
            editRequest({
              expectedRevision: binding?.expectedRevision,
              questionId: turn?.focus?.id,
              replaceLines: command?.lines,
              selectedLineIds: draft.selectedLineIds,
            });
          this.editable(row, now, request.expectedRevision);
          const question =
            request.questionId === null
              ? null
              : draft.questions.find((q) => q.id === request.questionId);
          if (request.questionId !== null && !question) throw invalid();
          let allowedLineIds = question?.lineIds;
          if (binding && turn?.focus && question) {
            if (
              question.field !== turn.focus.field ||
              !same(question.lineIds, turn.focus.lineIds)
            )
              throw problem(Code.REVISION_CONFLICT, row);
            if (turn.scope?.kind === "LINES") {
              allowedLineIds = turn.scope.lineIds;
              if (allowedLineIds.some((id) => !question.lineIds.includes(id)))
                throw invalid();
            } else if (turn.scope?.kind === "ATTACHMENT") {
              const material = await this.material(tx, row, draft, true);
              const attachmentId = turn.scope.attachmentId;
              const ref = material.references.find(
                ({ ref }) => ref.id === attachmentId,
              );
              if (
                !ref ||
                ref.ref.state !== ImportSessionAttachmentState.ATTACHED ||
                ref.artifact?.state !== ImportSessionArtifactState.EXTRACTED ||
                draft.scope.pendingAttachmentIds.includes(ref.ref.id)
              )
                throw problem(Code.STALE_PREVIEW, row);
              const artifactId = ref.artifact.id;
              // material() resolves the server-owned scope and attachment
              // membership inside this locked revision. Retained claims (and
              // documentary rows without editable lines) grant no edit scope.
              const editableObservationIds = new Set(
                draft.lines.flatMap((line) => line.observationIds),
              );
              const observations = material.observations.filter(
                (obs) =>
                  obs.artifactId === artifactId &&
                  unclaimed(obs) &&
                  editableObservationIds.has(obs.id),
              );
              if (!observations.length) throw problem(Code.STALE_PREVIEW, row);
              const observationIds = new Set(observations.map((obs) => obs.id));
              allowedLineIds = draft.lines
                .filter((line) =>
                  line.observationIds.some((id) => observationIds.has(id)),
                )
                .map((line) => line.id);
              if (turn.intent === "APPROVE_ATTACHMENT_SCOPE") {
                if (
                  !same(
                    [...allowedLineIds].sort(),
                    [...turn.scope.approvedLineIds].sort(),
                  )
                )
                  throw problem(Code.REVISION_CONFLICT, row);
              } else if (
                allowedLineIds.some((id) => !question.lineIds.includes(id))
              ) {
                throw problem(Code.STALE_PREVIEW, row);
              }
            }
            if (
              !allowedLineIds?.length ||
              !same(
                [...request.replaceLines.map((line) => line.id)].sort(),
                [...allowedLineIds].sort(),
              )
            )
              throw invalid();
          }
          const existing = new Map(draft.lines.map((line) => [line.id, line]));
          const replacement = new Map(
            request.replaceLines.map((line) => [line.id, line]),
          );
          for (const line of request.replaceLines) {
            const original = existing.get(line.id);
            if (original && !same(line.observationIds, original.observationIds))
              throw invalid();
            if (
              question &&
              (!original ||
                !allowedLineIds?.includes(line.id) ||
                Object.keys(original).some(
                  (key) =>
                    key !== question.field &&
                    !same(Reflect.get(line, key), Reflect.get(original, key)),
                ))
            )
              throw invalid();
          }
          if (question && !same(request.selectedLineIds, draft.selectedLineIds))
            throw invalid();
          try {
            updated = validateStoredDraft({
              ...draft,
              lines: [
                ...draft.lines.map((line) => replacement.get(line.id) ?? line),
                ...request.replaceLines.filter(
                  (line) => !existing.has(line.id),
                ),
              ],
              selectedLineIds: request.selectedLineIds,
              questions: question
                ? draft.questions.flatMap((item) => {
                    if (item.id !== question.id) return [item];
                    if (focusedRequest?.answer.value === null) return [item];
                    const lineIds = item.lineIds.filter((id) => {
                      const line = replacement.get(id);
                      return !line || same(line, existing.get(id));
                    });
                    return lineIds.length ? [{ ...item, lineIds }] : [];
                  })
                : draft.questions,
            });
          } catch (error) {
            if (error instanceof ImportSessionCorruptStateError)
              throw invalid();
            throw error;
          }
        }
        await assertReceiptParticipantAccess(
          tx,
          actor,
          updated.lines.flatMap(
            (line) => line.targets?.map((target) => target.projectId) ?? [],
          ),
        );
        await this.material(tx, row, updated, true);
        if (same(draft, updated)) {
          assertLive?.();
          return view;
        }
        const json = canonical(updated);
        if (
          Buffer.byteLength(json, "utf8") > LIMITS.jsonBytesPerDraftOrProposal
        )
          throw problem(Code.LIMIT_EXCEEDED, row);
        assertLive?.();
        await this.update(tx, row, {
          state: State.DRAFT,
          revision: nextRevision(row),
          draftJson: json,
          searchJson: null,
          proposalJson: null,
          proposalHash: null,
          preflightHash: null,
          challengeJson: null,
          prepareLeaseJson: null,
          prepareGeneration: { increment: 1 },
          lastUserEditAt: now,
          expiresAt: new Date(
            now.getTime() + LIMITS.draftRetentionSeconds * 1000,
          ),
        });
        const rendered = (
          await renderImportSession(
            tx,
            await loadOwnedImportSession(tx, actor, row.id),
            now,
            {
              includeReceipt: false,
              qualifiedAnalysisFormats: this.capability.newImportFormats(),
              analysisEnabled: this.analysisEnabled(),
              workflow: {
                writesEnabled: await importSessionWritesEnabled(
                  tx,
                  row,
                  this.capability,
                ),
                canMutate: true,
                presentedSessionVersion: auth.presentedSessionVersion,
              },
            },
          )
        ).view;
        assertLive?.();
        return rendered;
      },
      assertLive,
    );
  }

  async prepare(
    auth: AuthenticatedImportContext,
    sessionId: string,
    body: unknown,
  ): Promise<ImportSessionViewV1> {
    this.identity(auth, sessionId);
    const request = parseRevisionRequest(body);
    return this.prepareCore(auth, sessionId, request);
  }

  async prepareConversation(
    auth: AuthenticatedImportContext,
    sessionId: string,
    request: { expectedRevision: number },
    admission: ImportChatAdmission,
  ): Promise<ImportSessionViewV1> {
    this.identity(auth, sessionId);
    const parsed = parseRevisionRequest(request);
    const binding = reservedImportChatWrite(
      admission,
      "PREPARE",
      this.clock.now(),
    );
    if (
      binding.auth !== auth ||
      binding.sessionId !== sessionId ||
      binding.expectedRevision !== parsed.expectedRevision
    )
      throw new ImportSessionError(Code.UI_ACTION_REQUIRED);
    return this.prepareCore(auth, sessionId, parsed, binding);
  }

  private async prepareCore(
    auth: AuthenticatedImportContext,
    sessionId: string,
    request: { expectedRevision: number },
    binding?: ImportConversationWriteBinding,
  ): Promise<ImportSessionViewV1> {
    const assertLive = binding
      ? (): undefined =>
          assertLiveImportConversationWrite(binding, auth, this.clock.now())
      : undefined;
    return runImportSessionWrite(
      this.prisma,
      this.clock,
      auth,
      async (tx, now) => {
        assertLive?.();
        const { actor, row } = await this.context(tx, auth, sessionId, now);
        assertImportSessionOperationAvailable(
          "PREPARE",
          await importSessionWritesEnabled(tx, row, this.capability),
        );
        this.editable(row, now, request.expectedRevision);
        const draft = parseStoredDraft(row.draftJson);
        const material = await this.material(tx, row, draft);
        await this.configuredCard(tx, row);
        this.noInFlight(row, material);
        const documentaryDraft = reconcileImportDeclarationDraft(
          draft,
          resolveImportDeclarations(row, draft, material),
        );
        const locked = mintLockedImportSession(tx, auth, row, documentaryDraft);
        let rendered: ImportSessionViewV1;
        try {
          const result = await this.batches.prepareInTx(tx, auth, locked);
          const preparedDraft = validateStoredDraft(result.draft);
          if (
            !same(draft.scope, preparedDraft.scope) ||
            !same(draft.selectedLineIds, preparedDraft.selectedLineIds)
          )
            throw corrupt("preparation");
          await assertReceiptParticipantAccess(
            tx,
            actor,
            preparedDraft.lines.flatMap(
              (line) => line.targets?.map((target) => target.projectId) ?? [],
            ),
          );
          const search = parseStoredImportSearch(
            canonical(result.search),
            nextRevision(row),
            preparedDraft,
          );
          if (search.kind !== "SEARCH") throw corrupt("search");
          let proposal: ImportSessionProposalV1 | null = null;
          let preflightHash: string | null = null;
          if (result.kind === "READY") {
            assertPreparedCardBatch(tx, auth, result.batch);
            if (!search.value.complete) throw corrupt("preparation");
            const plan = this.plan(row, preparedDraft, material, result.batch);
            this.claimBindings(row, material, result.batch);
            proposal = plan.proposal;
            preflightHash = result.batch.preflightHash;
          }
          assertLive?.();
          await this.update(tx, row, {
            state: result.kind,
            revision: nextRevision(row),
            draftJson: canonical(preparedDraft),
            searchJson: canonical(search.value),
            proposalJson: proposal === null ? null : canonical(proposal),
            proposalHash: proposal?.proposalHash ?? null,
            preflightHash,
            challengeJson: null,
            prepareLeaseJson: null,
            prepareGeneration: { increment: 1 },
          });
          rendered = (
            await renderImportSession(
              tx,
              await loadOwnedImportSession(tx, actor, row.id),
              now,
              {
                includeReceipt: false,
                qualifiedAnalysisFormats: this.capability.newImportFormats(),
                analysisEnabled: this.analysisEnabled(),
                workflow: {
                  writesEnabled: await importSessionWritesEnabled(
                    tx,
                    row,
                    this.capability,
                  ),
                  canMutate: true,
                  presentedSessionVersion: auth.presentedSessionVersion,
                },
              },
            )
          ).view;
        } finally {
          releaseLockedImportSession(locked);
        }
        assertLive?.();
        return rendered;
      },
      assertLive,
    );
  }

  async challenge(
    auth: AuthenticatedImportContext,
    sessionId: string,
    body: unknown,
    grant: unknown,
  ): Promise<ImportSessionChallengeResponseV1> {
    this.identity(auth, sessionId);
    const request = parseChallengeRequest(body);
    this.verifier.verifyFinancialAction(
      grant,
      auth,
      { operation: "CHALLENGE", sessionId, ...request },
      this.clock.now(),
    );
    return runImportSessionWrite(
      this.prisma,
      this.clock,
      auth,
      async (tx, now) => {
        const { row, view } = await this.context(tx, auth, sessionId, now);
        assertImportSessionOperationAvailable(
          "CHALLENGE",
          await importSessionWritesEnabled(tx, row, this.capability),
        );
        this.ready(row, view, now, request);
        this.noInFlight(
          row,
          await this.material(tx, row, parseStoredDraft(row.draftJson)),
        );
        const nonce = randomBytes(32).toString("base64url");
        const expiresAt = new Date(
          now.getTime() + LIMITS.confirmationNonceSeconds * 1000,
        ).toISOString();
        await this.update(tx, row, {
          challengeJson: JSON.stringify({
            nonceHash: digest(nonce),
            revision: request.expectedRevision,
            proposalHash: request.proposalHash,
            sessionVersion: auth.presentedSessionVersion,
            expiresAt,
          }),
        });
        return { nonce, expiresAt };
      },
    );
  }

  async confirm(
    auth: AuthenticatedImportContext,
    sessionId: string,
    body: unknown,
    grant: unknown,
  ): Promise<ImportSessionConfirmResponseV1> {
    this.identity(auth, sessionId);
    const request = parseConfirmRequest(body);
    this.verifier.verifyFinancialAction(
      grant,
      auth,
      {
        operation: "CONFIRM",
        sessionId,
        expectedRevision: request.expectedRevision,
        proposalHash: request.proposalHash,
        financialRequestId: request.financialRequestId,
      },
      this.clock.now(),
    );
    return runImportSessionWrite(
      this.prisma,
      this.clock,
      auth,
      async (tx, now) => {
        const { row, view } = await this.context(tx, auth, sessionId, now);
        if (row.state !== State.APPLIED) await this.configuredCard(tx, row);
        if (row.financialRequestId !== null) {
          if (
            row.financialRequestId !== request.financialRequestId ||
            row.confirmedRevision !== request.expectedRevision ||
            row.proposalHash !== request.proposalHash
          )
            throw problem(Code.IDEMPOTENCY_CONFLICT, row);
          return this.confirmation(row, now);
        }
        assertImportSessionOperationAvailable(
          "FIRST_CONFIRM",
          await importSessionWritesEnabled(tx, row, this.capability),
        );
        this.ready(row, view, now, request);
        this.noInFlight(
          row,
          await this.material(tx, row, parseStoredDraft(row.draftJson)),
        );
        this.nonce(row, auth, request, now);
        const other = await tx.importSession.findFirst({
          where: {
            tenantId: row.tenantId,
            ownerUserId: row.ownerUserId,
            financialRequestId: request.financialRequestId,
          },
          select: { id: true },
        });
        if (other) throw problem(Code.IDEMPOTENCY_CONFLICT, row);
        await this.update(tx, row, {
          state: State.CONFIRMED,
          revision: nextRevision(row),
          financialRequestId: request.financialRequestId,
          confirmedRevision: request.expectedRevision,
          confirmedSessionVersion: auth.presentedSessionVersion,
          confirmedAt: now,
          challengeJson: null,
          prepareLeaseJson: null,
          prepareGeneration: { increment: 1 },
        });
        return {
          sessionId,
          financialRequestId: request.financialRequestId,
          state: State.CONFIRMED,
        };
      },
    );
  }

  async execute(
    auth: AuthenticatedImportContext,
    sessionId: string,
    body: unknown,
    grant: unknown,
  ): Promise<ImportSessionReceiptV1> {
    this.identity(auth, sessionId);
    const request = parseExecuteRequest(body);
    this.verifier.verifyFinancialAction(
      grant,
      auth,
      { operation: "EXECUTE", sessionId, ...request },
      this.clock.now(),
    );
    const outcome = await runImportSessionWrite(
      this.prisma,
      this.clock,
      auth,
      async (
        tx,
        now,
      ): Promise<
        | {
            receipt: ImportSessionReceiptV1;
            invalidatedClaims: readonly ImportRawClaim[];
          }
        | { error: ImportSessionError }
      > => {
        const { actor, row, view } = await this.context(
          tx,
          auth,
          sessionId,
          now,
        );
        if (row.financialRequestId !== request.financialRequestId)
          throw problem(Code.IDEMPOTENCY_CONFLICT, row);
        if (row.state === State.APPLIED) {
          if (
            !view.receipt ||
            view.receipt.financialRequestId !== row.financialRequestId ||
            view.receipt.confirmedRevision !== row.confirmedRevision ||
            view.receipt.proposalHash !== row.proposalHash
          )
            throw corrupt("receipt");
          return { receipt: view.receipt, invalidatedClaims: [] };
        }
        await this.configuredCard(tx, row);
        assertImportSessionOperationAvailable(
          "EXECUTE_UNAPPLIED",
          await importSessionWritesEnabled(tx, row, this.capability),
        );
        if (effectiveState(row, now) === State.EXPIRED) {
          if (row.state === State.CONFIRMED)
            await this.update(tx, row, {
              state: State.EXPIRED,
              revision: nextRevision(row),
              closedAt: now,
              challengeJson: null,
              prepareLeaseJson: null,
              prepareGeneration: { increment: 1 },
            });
          return { error: problem(Code.SESSION_EXPIRED, row) };
        }
        if (
          row.state !== State.CONFIRMED ||
          row.closedAt !== null ||
          row.receiptJson !== null
        )
          throw problem(Code.STALE_PREVIEW, row);
        if (
          !view.proposal ||
          row.confirmedRevision === null ||
          !hash(row.preflightHash)
        )
          throw corrupt("confirmation");
        if (row.confirmedSessionVersion !== auth.presentedSessionVersion)
          return { error: await this.review(tx, row) };
        const draft = parseStoredDraft(row.draftJson);
        let material: Material;
        try {
          material = await this.material(tx, row, draft);
        } catch (error) {
          if (
            error instanceof ImportSessionError &&
            error.code === Code.LEASE_CONFLICT
          )
            return { error: await this.review(tx, row) };
          throw error;
        }
        const selectedIds = new Set(
          draft.lines
            .filter((line) => draft.selectedLineIds.includes(line.id))
            .flatMap((line) => line.observationIds),
        );
        if (
          material.observations.some(
            (observation) =>
              selectedIds.has(observation.id) && !unclaimed(observation),
          ) ||
          material.references.some(
            ({ ref }) =>
              ref.state === ImportSessionAttachmentState.RESERVED ||
              ref.state === ImportSessionAttachmentState.UPLOADED,
          )
        ) {
          return { error: await this.review(tx, row) };
        }
        const locked = mintLockedImportSession(tx, auth, row, draft);
        try {
          let batch: PreparedCardBatch;
          let plan: ImportPreparationPlanV1;
          try {
            const result = await this.batches.prepareInTx(tx, auth, locked);
            if (result.kind !== "READY")
              return { error: await this.review(tx, row) };
            assertPreparedCardBatch(tx, auth, result.batch);
            batch = result.batch;
            const search = parseStoredImportSearch(
              canonical(result.search),
              row.confirmedRevision,
              result.draft,
            );
            if (
              search.kind !== "SEARCH" ||
              !search.value.complete ||
              !same(result.draft, draft)
            )
              return { error: await this.review(tx, row) };
            plan = this.plan(row, draft, material, batch);
            this.claimBindings(row, material, batch);
            if (
              batch.preflightHash !== row.preflightHash ||
              !same(plan.proposal, view.proposal)
            )
              return { error: await this.review(tx, row) };
          } catch (error) {
            if (
              error instanceof ImportSessionError &&
              [
                Code.STALE_PREVIEW,
                Code.REVIEW_REQUIRED,
                Code.LEASE_CONFLICT,
                Code.LIMIT_EXCEEDED,
                Code.SEARCH_TOO_BROAD,
              ].some((code) => code === error.code)
            )
              return { error: await this.review(tx, row) };
            throw error;
          }
          // A consumes the genuine batch before effects. No commit-shaped errors below this point.
          const applied = await this.batches.applyInTx(tx, auth, batch);
          const items = this.receiptItems(batch, applied);
          const receipt = await this.receipt(
            tx,
            actor,
            row,
            plan.proposal,
            items,
            now,
          );
          for (const observation of batch.observations) {
            const item = items.find(
              (candidate) => candidate.lineId === observation.lineId,
            );
            if (!item) throw corrupt("receipt");
            const changed = await tx.importObservation.updateMany({
              where: {
                id: observation.id,
                tenantId: row.tenantId,
                ownerProjectId: row.ownerProjectId,
                artifactId: observation.artifactId,
                reference: observation.reference,
                claimVersion: observation.claimVersion,
                ...EMPTY_CLAIM,
              },
              data: {
                claimVersion: { increment: 1 },
                canonicalProjectId: row.ownerProjectId,
                canonicalExpenseId: item.sourceExpenseId,
                canonicalReceiptId: null,
                canonicalIndex: observation.canonicalIndex,
                claimSessionId: row.id,
                claimReceiptJson: JSON.stringify({
                  kind: "SESSION",
                  sessionId: row.id,
                  financialRequestId: request.financialRequestId,
                }),
                claimedAt: now,
              },
            });
            if (changed.count !== 1) throw problem(Code.REVISION_CONFLICT, row);
          }
          const continuation = await this.continuation(
            tx,
            row,
            plan,
            material,
            now,
          );
          await releaseCompletedSessionAttachments(
            tx,
            {
              tenantId: row.tenantId,
              ownerProjectId: row.ownerProjectId,
              sessionId: row.id,
            },
            now,
          );
          receipt.continuationSessionId = continuation.continuationSessionId;
          await tx.userActivityLog.create({
            data: {
              tenantId: row.tenantId,
              userId: row.ownerUserId,
              action: AUDIT_ACTION,
              createdAt: now,
            },
          });
          const checked = parseReceipt(
            JSON.stringify(receipt),
            row.id,
            row.ownerProjectId,
          );
          await this.update(tx, row, {
            state: State.APPLIED,
            revision: nextRevision(row),
            receiptJson: JSON.stringify(checked),
            draftJson: EMPTY_DRAFT_JSON,
            searchJson: null,
            proposalJson: null,
            closedAt: now,
            challengeJson: null,
            prepareLeaseJson: null,
            prepareGeneration: { increment: 1 },
          });
          await purgeCompletedSessionObservationEvidence(tx, {
            tenantId: row.tenantId,
            ownerProjectId: row.ownerProjectId,
            sessionId: row.id,
          });
          return {
            receipt: checked,
            invalidatedClaims: continuation.invalidatedClaims,
          };
        } finally {
          releaseLockedImportSession(locked);
        }
      },
    );
    if ("error" in outcome) throw outcome.error;
    this.raw.abortOwned(outcome.invalidatedClaims, "AC18");
    return outcome.receipt;
  }

  private async configuredCard(tx: Tx, row: ImportSession): Promise<void> {
    const card = await tx.creditCard.findFirst({
      where: {
        id: row.cardId,
        tenantId: row.tenantId,
        projectId: row.ownerProjectId,
        deletedAt: null,
      },
      select: { closingDay: true, dueDay: true },
    });
    if (!card) throw problem(Code.NOT_FOUND, row);
    const configuration = cardImportConfiguration(card);
    if (!configuration.configured)
      throw new ImportSessionError(Code.REVIEW_REQUIRED, {
        sessionId: row.id,
        currentRevision: row.revision,
        reason: configuration.reason,
      });
  }

  private identity(auth: AuthenticatedImportContext, sessionId: string): void {
    assertMintedImportContext(auth);
    assertSessionId(sessionId);
  }
  private analysisEnabled(): boolean {
    return (
      importIntakeEnabled(this.capability) &&
      !this.gate.boot.stopped.aborted &&
      this.gate.boot.runtime() !== null
    );
  }
  private async context(
    tx: Tx,
    auth: AuthenticatedImportContext,
    sessionId: string,
    now: Date,
  ) {
    const actor = await reauthorize(tx, auth, now);
    const row = await loadOwnedImportSession(tx, actor, sessionId);
    await assertImportSessionAccess(tx, actor, row, now);
    await assertReceiptParticipantAccess(tx, actor, [row.ownerProjectId]);
    const { view } = await renderImportSession(tx, row, now, {
      includeReceipt: true,
      qualifiedAnalysisFormats: this.capability.newImportFormats(),
      analysisEnabled: this.analysisEnabled(),
      workflow: {
        writesEnabled: await importSessionWritesEnabled(
          tx,
          row,
          this.capability,
        ),
        canMutate: true,
        presentedSessionVersion: auth.presentedSessionVersion,
      },
    });
    return { actor, row, view };
  }
  private editable(row: ImportSession, now: Date, revision: number): void {
    if (effectiveState(row, now) === State.EXPIRED)
      throw problem(Code.SESSION_EXPIRED, row);
    if (row.state === State.APPLIED) throw problem(Code.ALREADY_APPLIED, row);
    if (
      row.financialRequestId !== null ||
      !editableStates.has(row.state) ||
      row.closedAt !== null
    )
      throw problem(Code.STALE_PREVIEW, row);
    if (row.revision !== revision) throw problem(Code.REVISION_CONFLICT, row);
  }
  private ready(
    row: ImportSession,
    view: ImportSessionViewV1,
    now: Date,
    request: ImportSessionChallengeRequestV1,
  ): void {
    this.editable(row, now, request.expectedRevision);
    if (
      row.state !== State.READY ||
      !view.proposal ||
      !view.searchComplete ||
      row.proposalHash !== request.proposalHash ||
      view.proposal.revision !== row.revision ||
      !hash(row.preflightHash)
    )
      throw problem(Code.STALE_PREVIEW, row);
  }
  private async update(
    tx: Tx,
    row: ImportSession,
    data: Prisma.ImportSessionUpdateManyMutationInput,
  ): Promise<void> {
    const result = await tx.importSession.updateMany({ where: cas(row), data });
    if (result.count !== 1) throw problem(Code.REVISION_CONFLICT, row);
  }
  private async review(
    tx: Tx,
    row: ImportSession,
  ): Promise<ImportSessionError> {
    await this.update(tx, row, {
      state: State.REVIEW_REQUIRED,
      revision: nextRevision(row),
      challengeJson: null,
      prepareLeaseJson: null,
      prepareGeneration: { increment: 1 },
    });
    return problem(Code.STALE_PREVIEW, row);
  }
  private confirmation(
    row: ImportSession,
    now: Date,
  ): ImportSessionConfirmResponseV1 {
    const state = effectiveState(row, now);
    if (
      row.financialRequestId === null ||
      (state !== State.CONFIRMED &&
        state !== State.APPLIED &&
        state !== State.REVIEW_REQUIRED &&
        state !== State.CANCELLED &&
        state !== State.EXPIRED)
    )
      throw corrupt("confirmation");
    return {
      sessionId: row.id,
      financialRequestId: row.financialRequestId,
      state,
    };
  }
  private nonce(
    row: ImportSession,
    auth: AuthenticatedImportContext,
    request: ImportSessionConfirmRequestV1,
    now: Date,
  ): void {
    if (row.challengeJson === null || request.nonce === null)
      throw problem(Code.UI_ACTION_REQUIRED, row);
    if (
      Buffer.byteLength(row.challengeJson, "utf8") >
      LIMITS.jsonBytesPerDraftOrProposal
    )
      throw corrupt("challenge");
    let value: unknown;
    try {
      value = JSON.parse(row.challengeJson);
    } catch (error) {
      if (error instanceof SyntaxError) throw corrupt("challenge");
      throw error;
    }
    if (
      !record(value) ||
      Object.keys(value).length !== 5 ||
      !hash(value.nonceHash) ||
      !hash(value.proposalHash) ||
      typeof value.revision !== "number" ||
      !Number.isSafeInteger(value.revision) ||
      value.revision < PRIMITIVES.minRevision ||
      value.revision > PRIMITIVES.maxRevision ||
      typeof value.sessionVersion !== "number" ||
      !Number.isSafeInteger(value.sessionVersion) ||
      value.sessionVersion < 0 ||
      typeof value.expiresAt !== "string" ||
      !INSTANT.test(value.expiresAt) ||
      !Number.isFinite(Date.parse(value.expiresAt))
    )
      throw corrupt("challenge");
    if (
      value.revision !== request.expectedRevision ||
      value.proposalHash !== request.proposalHash ||
      value.sessionVersion !== auth.presentedSessionVersion ||
      now.getTime() >= Date.parse(value.expiresAt) ||
      !timingSafeEqual(
        Buffer.from(value.nonceHash, "hex"),
        Buffer.from(digest(request.nonce), "hex"),
      )
    )
      throw problem(Code.UI_ACTION_REQUIRED, row);
  }
  private async material(
    tx: Tx,
    row: ImportSession,
    draft: ImportSessionStoredDraftV1,
    forEdit = false,
  ): Promise<Material> {
    const references = await tx.importSessionArtifact.findMany({
      where: {
        tenantId: row.tenantId,
        ownerProjectId: row.ownerProjectId,
        sessionId: row.id,
      },
      include: { artifact: true },
      take: LIMITS.filesPerSession + 1,
    });
    if (references.length > LIMITS.filesPerSession)
      throw corrupt("attachments");
    const boundReferences = references
      .filter(({ state }) => state !== ImportSessionAttachmentState.RELEASED)
      .map(({ artifact, ...ref }) => ({ ref, artifact }));
    if (!forEdit)
      this.noInFlight(row, { references: boundReferences, observations: [] });
    const observations: ImportObservation[] = [];
    for (
      let start = 0;
      start < draft.scope.observationIds.length;
      start += READ_CHUNK
    ) {
      observations.push(
        ...(await tx.importObservation.findMany({
          where: {
            tenantId: row.tenantId,
            ownerProjectId: row.ownerProjectId,
            id: {
              in: draft.scope.observationIds.slice(start, start + READ_CHUNK),
            },
          },
        })),
      );
    }
    if (observations.length !== draft.scope.observationIds.length)
      throw corrupt("draft");
    for (const observation of observations) {
      const ref = references.find(
        (ref) => ref.artifactId === observation.artifactId,
      );
      if (
        !ref ||
        !ref.artifact ||
        ref.artifact.tenantId !== row.tenantId ||
        ref.artifact.ownerProjectId !== row.ownerProjectId
      )
        throw corrupt("draft");
      projectImportObservation(row, draft.scope, observation, ref);
    }
    if (
      draft.scope.pendingAttachmentIds.some(
        (id) => !references.some((ref) => ref.id === id),
      )
    )
      throw corrupt("draft");
    return { observations, references: boundReferences };
  }
  private noInFlight(row: ImportSession, material: Material): void {
    if (
      material.references.some(
        ({ ref }) =>
          ref.state === ImportSessionAttachmentState.RESERVED ||
          ref.state === ImportSessionAttachmentState.UPLOADED,
      )
    )
      throw new ImportSessionError(Code.LEASE_CONFLICT, {
        sessionId: row.id,
        currentRevision: row.revision,
        reason: "ATTACHMENT_IN_FLIGHT",
      });
  }
  private plan(
    row: ImportSession,
    draft: ImportSessionStoredDraftV1,
    material: Material,
    batch: PreparedCardBatch,
  ): ImportPreparationPlanV1 {
    const {
      proposalHash: _hash,
      deferredObservationIds: _observations,
      deferredAttachmentIds: _attachments,
      retainUntil: _retention,
      ...proposalBody
    } = batch.proposal;
    const plan = buildImportPreparationPlan({
      session: row,
      draft,
      proposalBody,
      ...material,
    });
    if (
      !hash(batch.preflightHash) ||
      !same(plan.proposal, batch.proposal) ||
      !same(plan.expandedCounts, batch.expandedCounts)
    )
      throw corrupt("preparation");
    return plan;
  }
  private claimBindings(
    row: ImportSession,
    material: Material,
    batch: PreparedCardBatch,
  ): void {
    for (const binding of batch.observations) {
      const observation = material.observations.find(
        (item) => item.id === binding.id,
      );
      const reference = material.references.find(
        (item) => item.ref.artifactId === binding.artifactId,
      );
      if (
        !observation ||
        !reference?.artifact ||
        observation.artifactId !== binding.artifactId ||
        observation.reference !== binding.reference ||
        reference.artifact.documentSha256 !== binding.documentSha256 ||
        observation.claimVersion !== binding.claimVersion ||
        !unclaimed(observation)
      )
        throw problem(Code.STALE_PREVIEW, row);
    }
  }
  private receiptItems(
    batch: PreparedCardBatch,
    items: ImportSessionReceiptV1["items"],
  ): ImportSessionReceiptV1["items"] {
    const snapshot = structuredClone(items);
    if (
      !Array.isArray(snapshot) ||
      snapshot.length !== batch.proposal.lines.length ||
      new Set(snapshot.map((item) => item?.lineId)).size !== snapshot.length
    )
      throw corrupt("receipt");
    return batch.proposal.lines.map((line) => {
      const item = snapshot.find((item) => item.lineId === line.lineId);
      if (
        !item ||
        item.outcome !==
          (line.kind === "CREATE" ? "CREATED" : "KEPT_EXISTING") ||
        !id(item.sourceExpenseId) ||
        (line.kind === "KEEP_EXISTING" &&
          item.sourceExpenseId !== line.sourceExpenseId) ||
        [item.targetExpenseIds, item.allocationIds, item.cashFlowEntryIds].some(
          (ids) =>
            !Array.isArray(ids) ||
            !ids.every(id) ||
            new Set(ids).size !== ids.length,
        )
      )
        throw corrupt("receipt");
      return item;
    });
  }
  private async receipt(
    tx: Tx,
    actor: ImportActor,
    row: ImportSession,
    proposal: ImportSessionProposalV1,
    items: ImportSessionReceiptV1["items"],
    now: Date,
  ): Promise<ImportSessionReceiptV1> {
    if (
      !row.financialRequestId ||
      row.confirmedRevision === null ||
      !row.proposalHash
    )
      throw corrupt("confirmation");
    const lines: ImportSessionReceiptV1["snapshot"]["lines"] = [];
    for (const line of proposal.lines) {
      const item = items.find((item) => item.lineId === line.lineId);
      if (!item) throw corrupt("receipt");
      let targets: ImportSessionReceiptV1["snapshot"]["lines"][number]["targets"];
      if (line.kind === "CREATE")
        targets = line.targets.map((target) => ({
          projectId: target.projectId,
          amountCents: target.amountCents,
        }));
      else {
        const existing = await tx.expense.findMany({
          where: {
            tenantId: row.tenantId,
            id: { in: item.targetExpenseIds },
            deletedAt: null,
          },
          select: { id: true, projectId: true, valorTotal: true },
        });
        if (existing.length !== item.targetExpenseIds.length)
          throw corrupt("receipt");
        await assertReceiptParticipantAccess(
          tx,
          actor,
          existing.map((target) => target.projectId),
        );
        targets = item.targetExpenseIds.map((id) => {
          const target = existing.find((target) => target.id === id);
          if (!target) throw corrupt("receipt");
          return {
            projectId: target.projectId,
            amountCents: target.valorTotal,
          };
        });
      }
      lines.push({
        lineId: line.lineId,
        titulo: line.kind === "CREATE" ? line.titulo : null,
        dataCompra: line.kind === "CREATE" ? line.dataCompra : null,
        totalCents: line.totalCents,
        schedule: structuredClone(line.schedule),
        sourceProjectId: row.ownerProjectId,
        targets,
      });
    }
    const participants = [
      ...new Set([
        row.ownerProjectId,
        ...lines.flatMap((line) =>
          line.targets.map((target) => target.projectId),
        ),
      ]),
    ].sort();
    await assertReceiptParticipantAccess(tx, actor, participants);
    return {
      version: IMPORT_SESSION_PROTOCOL_VERSION,
      sessionId: row.id,
      financialRequestId: row.financialRequestId,
      confirmedRevision: row.confirmedRevision,
      proposalHash: row.proposalHash,
      appliedAt: now.toISOString(),
      continuationSessionId: null,
      items,
      snapshot: {
        lines,
        participantProjectIds: participants,
        createdEconomicTotalCents: proposal.createdEconomicTotalCents,
        bankCashDeltaCents: proposal.bankCashDeltaCents,
        invoiceDeltas: structuredClone(proposal.invoiceDeltas),
      },
    };
  }
  private async continuation(
    tx: Tx,
    row: ImportSession,
    plan: ImportPreparationPlanV1,
    material: Material,
    now: Date,
  ): Promise<{
    continuationSessionId: string | null;
    invalidatedClaims: readonly ImportRawClaim[];
  }> {
    let continuationId: string | null = null;
    if (plan.continuationDraft !== null) {
      continuationId = randomUUID();
      await tx.importSession.create({
        data: {
          id: continuationId,
          tenantId: row.tenantId,
          ownerUserId: row.ownerUserId,
          ownerProjectId: row.ownerProjectId,
          cardId: row.cardId,
          protocolVersion: row.protocolVersion,
          kind: row.kind,
          state: State.DRAFT,
          revision: 1,
          createRequestId: randomUUID(),
          createPayloadHash: digest(
            canonical({
              kind: CONTINUATION_PAYLOAD_KIND,
              sourceSessionId: row.id,
              proposalHash: row.proposalHash,
            }),
          ),
          consentPolicyVersion: row.consentPolicyVersion,
          consentedAt: row.consentedAt,
          createdAt: now,
          lastUserEditAt: row.lastUserEditAt,
          expiresAt: row.expiresAt,
          draftJson: canonical(plan.continuationDraft),
        },
      });
      for (const refId of plan.transferRefIds) {
        const expected = material.references.find(
          (item) => item.ref.id === refId,
        )?.ref;
        if (!expected) throw corrupt("preparation");
        const result = await tx.importSessionArtifact.updateMany({
          where: {
            id: refId,
            tenantId: row.tenantId,
            ownerProjectId: row.ownerProjectId,
            sessionId: row.id,
            state: {
              in: [
                ImportSessionAttachmentState.ATTACHED,
                ImportSessionAttachmentState.FAILED,
              ],
            },
            artifactId: expected.artifactId,
            uploadGeneration: expected.uploadGeneration,
          },
          data: {
            sessionId: continuationId,
            uploadGeneration: { increment: 1 },
            uploadSessionVersion: null,
            uploadTokenExpiresAt: null,
            uploadLeaseExpiresAt: null,
          },
        });
        if (result.count !== 1) throw problem(Code.REVISION_CONFLICT, row);
      }
    }
    const invalidatedClaims: ImportRawClaim[] = [];
    for (const artifactId of plan.leaseCleanupArtifactIds) {
      const artifact = await tx.importArtifact.findFirst({
        where: {
          id: artifactId,
          tenantId: row.tenantId,
          ownerProjectId: row.ownerProjectId,
          leaseSessionId: row.id,
        },
        select: { parseGeneration: true, state: true },
      });
      if (!artifact) continue;
      const changed = await tx.importArtifact.updateMany({
        where: {
          id: artifactId,
          tenantId: row.tenantId,
          ownerProjectId: row.ownerProjectId,
          leaseSessionId: row.id,
          parseGeneration: artifact.parseGeneration,
        },
        data: {
          leaseSessionId: null,
          leaseSessionVersion: null,
          leaseTokenExpiresAt: null,
          leaseExpiresAt: null,
          parseGeneration: { increment: 1 },
          ...(artifact.state === ImportSessionArtifactState.ANALYZING
            ? { state: ImportSessionArtifactState.RAW_READY }
            : {}),
        },
      });
      if (changed.count === 1)
        invalidatedClaims.push({
          tenantId: row.tenantId,
          ownerProjectId: row.ownerProjectId,
          sessionId: row.id,
          artifactId,
          parseGeneration: artifact.parseGeneration,
        });
    }
    return { continuationSessionId: continuationId, invalidatedClaims };
  }
}
