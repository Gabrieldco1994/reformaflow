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
  ExpenseType,
  ProjectType,
  getExpenseTypesForProject,
  type ImportSessionChallengeRequestV1,
  type ImportSessionChallengeResponseV1,
  type ImportSessionConfirmRequestV1,
  type ImportSessionConfirmResponseV1,
  type ContinueAnsweringCommandV1,
  type ImportSessionEditRequestV1,
  type ImportSessionExecuteRequestV1,
  type ImportSessionProposalV1,
  type ImportSessionReceiptV1,
  type ImportSessionStoredDraftV1,
  type ImportSessionViewV1,
  type ImportCurrentLotV1,
  type ImportDeclarationCommandV1,
  type ImportDocumentaryCommandReceiptV1,
  type ImportDocumentaryOperationV1,
  type ImportDraftResolutionCommandV1,
  type ImportLineDocumentaryCommandV1,
  type PrepareCurrentLotCommandV1,
  type ImportSessionDraftFieldV1,
  type ImportTypedDraftAnswerV1,
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
import { CardPurchasePreparationPurpose } from "./card-purchase-batch.port";
import type {
  ImportSessionCapability,
  ImportSessionClock,
} from "./import-session.capability";
import {
  assertPreparedCardBatch,
  mintLockedImportSession,
  releaseLockedImportSession,
  type AuthenticatedImportContext,
  type PreparedCardBatch,
  type UiImportFinancialActionVerifier,
  type UiImportPersistenceGrantVerifier,
  type UiImportGrantScope,
  type ImportSessionChallenge,
  type ImportSessionConfirmedBinding,
} from "./import-session.contract";
import { assertImportSessionOperationAvailable } from "./import-session.disabled";
import {
  ImportSessionCorruptStateError,
  ImportSessionError,
} from "./import-session.errors";
import { projectImportObservation } from "./import-session.observation";
import {
  buildImportPreparationPlan,
  type ImportPreparationPlanV1,
} from "./import-session.preparation";
import {
  effectiveState,
  parseSessionDocuments,
  parseStoredDraft,
  parseReceipt,
  receiptFullPlanDigest,
  terminalDraftJson,
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
  recordImportTypedDeclaration,
} from "./import-session.declarations";
import { documentaryPayloadHash } from "./import-session-documentary.commands";
import {
  projectCurrentLot,
  type CurrentLotDisplayContext,
} from "./import-current-lot";
import {
  buildGuidedReviewAuthority,
  hasDraftFieldValue,
  isDraftProvenanceField,
  isGuidedReviewField,
  recordDraftFieldProvenance,
} from "./import-guided-review";

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
const EMPTY_CLAIM = Object.freeze({
  canonicalProjectId: null,
  canonicalExpenseId: null,
  canonicalReceiptId: null,
  canonicalIndex: null,
  claimSessionId: null,
  claimReceiptJson: null,
  claimedAt: null,
});
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

function resolutionValue(
  field: ImportSessionDraftFieldV1,
  answer: ImportTypedDraftAnswerV1,
): unknown {
  if (answer.kind === "UNKNOWN" || answer.kind === "REMOVE") {
    if (field === "decision") throw invalid();
    return null;
  }
  const compatible =
    (field === "amountCents" && answer.kind === "CENTS") ||
    (field === "installmentCount" && answer.kind === "POSITIVE_INTEGER") ||
    ((field === "dataCompra" || field === "firstDueDate") &&
      answer.kind === "DATE") ||
    (field === "amountMeaning" && answer.kind === "AMOUNT_MEANING") ||
    (field === "targets" && answer.kind === "TARGETS") ||
    (field === "decision" && answer.kind === "DECISION") ||
    (field === "tipoDespesa" && answer.kind === "EXPENSE_TYPE") ||
    (field === "categoriaMaoDeObra" && answer.kind === "LABOR_CATEGORY");
  if (!compatible) throw invalid();
  return answer.value;
}

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
  const value = envelope(body, ["expectedRevision", "confirmationHash"]);
  if (!hash(value.confirmationHash)) throw invalid();
  return {
    ...parseRevisionRequest({ expectedRevision: value.expectedRevision }),
    confirmationHash: value.confirmationHash,
  };
}
export function parseConfirmRequest(
  body: unknown,
): ImportSessionConfirmRequestV1 {
  const value = envelope(body, [
    "expectedRevision",
    "confirmationHash",
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
      confirmationHash: value.confirmationHash,
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
      UiImportPersistenceGrantVerifier,
    private readonly batches: CardPurchaseBatchPort,
    private readonly gate: ImportVaultGate,
    private readonly raw: ImportRawExecutions,
  ) {}

  async declare(
    auth: AuthenticatedImportContext,
    sessionId: string,
    request: ImportDeclarationCommandV1,
    grant: unknown,
  ): Promise<ImportDocumentaryCommandReceiptV1> {
    this.identity(auth, sessionId);
    const payloadHash = documentaryPayloadHash(sessionId, "DECLARE", request);
    return this.documentaryMutation(
      auth,
      sessionId,
      "DECLARE",
      request,
      {
        operation: "DECLARE",
        sessionId,
        expectedRevision: request.expectedRevision,
        requestId: request.requestId,
        questionId: request.questionId,
        payloadHash,
      },
      payloadHash,
      grant,
      async (tx, actor, row, draft, now) =>
        recordImportTypedDeclaration(
          row,
          draft,
          await this.material(tx, row, draft, true),
          request.questionId,
          request.answer,
          { userId: actor.userId, turnId: request.requestId, now },
        ),
    );
  }

  async resolve(
    auth: AuthenticatedImportContext,
    sessionId: string,
    request: ImportDraftResolutionCommandV1,
    grant: unknown,
  ): Promise<ImportDocumentaryCommandReceiptV1> {
    this.identity(auth, sessionId);
    const payloadHash = documentaryPayloadHash(sessionId, "RESOLVE", request);
    return this.documentaryMutation(
      auth,
      sessionId,
      "RESOLVE",
      request,
      {
        operation: "RESOLVE",
        sessionId,
        expectedRevision: request.expectedRevision,
        requestId: request.requestId,
        questionId: request.questionId,
        payloadHash,
      },
      payloadHash,
      grant,
      async (tx, actor, row, draft) => {
        const question = draft.questions.find(
          (candidate) => candidate.id === request.questionId,
        );
        if (
          !question ||
          "subject" in question ||
          question.lineIds.some(
            (lineId) => !draft.selectedLineIds.includes(lineId),
          )
        )
          throw invalid();
        if (isGuidedReviewField(question.field)) {
          const storedSearch = parseStoredImportSearch(
            row.searchJson,
            row.revision,
            draft,
          );
          const authority = await buildGuidedReviewAuthority(
            tx,
            actor,
            row.ownerProjectId,
            draft,
            storedSearch.kind === "SEARCH" ? storedSearch.value : null,
            row.revision,
            false,
          );
          await authority.assertAnswer(request.questionId, request.answer);
        }
        const value = resolutionValue(question.field, request.answer);
        if (
          question.field === "decision" &&
          request.answer.kind === "DECISION" &&
          request.answer.value.kind === "KEEP_EXISTING"
        ) {
          const expenseId = request.answer.value.expenseId;
          const search = parseStoredImportSearch(
            row.searchJson,
            row.revision,
            draft,
          );
          if (
            search.kind !== "SEARCH" ||
            question.lineIds.some(
              (lineId) =>
                !search.value.candidates.some(
                  (candidate) =>
                    candidate.lineId === lineId &&
                    candidate.kind === "EXPENSE" &&
                    candidate.id === expenseId,
                ),
            )
          )
            throw invalid();
          const expense = await tx.expense.findFirst({
            where: {
              id: expenseId,
              tenantId: actor.tenantId,
              deletedAt: null,
            },
            select: { projectId: true },
          });
          if (!expense) throw invalid();
          await assertReceiptParticipantAccess(tx, actor, [expense.projectId]);
        }
        if (question.field === "targets" && request.answer.kind === "TARGETS") {
          for (const target of request.answer.value) {
            if (target.roomId === null) continue;
            const room = await tx.room.findFirst({
              where: {
                id: target.roomId,
                projectId: target.projectId,
                deletedAt: null,
              },
              select: { id: true },
            });
            if (!room) throw invalid();
          }
        }
        const lineIds = new Set(question.lineIds);
        let updated = validateStoredDraft({
          ...draft,
          lines: draft.lines.map((line) => {
            if (!lineIds.has(line.id)) return line;
            const next = structuredClone(line) as unknown as Record<
              string,
              unknown
            >;
            next[question.field] = structuredClone(value);
            if (
              question.field === "decision" &&
              request.answer.kind === "DECISION" &&
              request.answer.value.kind !== "CREATE"
            ) {
              next["targets"] = [];
              next["tipoDespesa"] = null;
              next["categoriaMaoDeObra"] = null;
            }
            if (question.field === "targets") {
              next["tipoDespesa"] = null;
              next["categoriaMaoDeObra"] = null;
            }
            if (
              question.field === "tipoDespesa" &&
              request.answer.kind === "EXPENSE_TYPE" &&
              request.answer.value !== ExpenseType.MAO_DE_OBRA
            )
              next["categoriaMaoDeObra"] = null;
            return next;
          }),
          questions: draft.questions.filter(
            (candidate) =>
              candidate.id !== question.id &&
              !(
                question.field === "decision" &&
                request.answer.kind === "DECISION" &&
                request.answer.value.kind !== "CREATE" &&
                candidate.lineIds.some((lineId) => lineIds.has(lineId))
              ) &&
              !(
                question.field === "tipoDespesa" &&
                request.answer.kind === "EXPENSE_TYPE" &&
                request.answer.value !== ExpenseType.MAO_DE_OBRA &&
                candidate.field === "categoriaMaoDeObra" &&
                candidate.lineIds.some((lineId) => lineIds.has(lineId))
              ),
          ),
          selectedLineIds:
            question.field === "decision" &&
            request.answer.kind === "DECISION" &&
            request.answer.value.kind === "EXCLUDE"
              ? draft.selectedLineIds.filter((lineId) => !lineIds.has(lineId))
              : draft.selectedLineIds,
        });
        updated = recordDraftFieldProvenance(
          updated,
          question.lineIds,
          question.field,
          request.answer.kind === "REMOVE" || request.answer.kind === "UNKNOWN"
            ? null
            : "USER",
          nextRevision(row),
        );
        if (
          question.field === "decision" &&
          request.answer.kind === "DECISION" &&
          request.answer.value.kind !== "CREATE"
        ) {
          updated = recordDraftFieldProvenance(
            recordDraftFieldProvenance(
              recordDraftFieldProvenance(
                updated,
                question.lineIds,
                "targets",
                null,
                nextRevision(row),
              ),
              question.lineIds,
              "tipoDespesa",
              null,
              nextRevision(row),
            ),
            question.lineIds,
            "categoriaMaoDeObra",
            null,
            nextRevision(row),
          );
        } else if (question.field === "targets") {
          updated = recordDraftFieldProvenance(
            recordDraftFieldProvenance(
              updated,
              question.lineIds,
              "tipoDespesa",
              null,
              nextRevision(row),
            ),
            question.lineIds,
            "categoriaMaoDeObra",
            null,
            nextRevision(row),
          );
        } else if (
          question.field === "tipoDespesa" &&
          request.answer.kind === "EXPENSE_TYPE" &&
          request.answer.value !== ExpenseType.MAO_DE_OBRA
        ) {
          updated = recordDraftFieldProvenance(
            updated,
            question.lineIds,
            "categoriaMaoDeObra",
            null,
            nextRevision(row),
          );
        }
        return validateStoredDraft(updated);
      },
    );
  }

  async defer(
    auth: AuthenticatedImportContext,
    sessionId: string,
    request: ImportLineDocumentaryCommandV1,
    grant: unknown,
  ): Promise<ImportDocumentaryCommandReceiptV1> {
    return this.changeLineSelection(auth, sessionId, "DEFER", request, grant);
  }

  async reactivate(
    auth: AuthenticatedImportContext,
    sessionId: string,
    request: ImportLineDocumentaryCommandV1,
    grant: unknown,
  ): Promise<ImportDocumentaryCommandReceiptV1> {
    return this.changeLineSelection(
      auth,
      sessionId,
      "REACTIVATE",
      request,
      grant,
    );
  }

  private async changeLineSelection(
    auth: AuthenticatedImportContext,
    sessionId: string,
    operation: "DEFER" | "REACTIVATE",
    request: ImportLineDocumentaryCommandV1,
    grant: unknown,
  ): Promise<ImportDocumentaryCommandReceiptV1> {
    this.identity(auth, sessionId);
    const payloadHash = documentaryPayloadHash(sessionId, operation, request);
    return this.documentaryMutation(
      auth,
      sessionId,
      operation,
      request,
      {
        operation,
        sessionId,
        expectedRevision: request.expectedRevision,
        requestId: request.requestId,
        lineId: request.lineId,
        payloadHash,
      },
      payloadHash,
      grant,
      async (_tx, _actor, _row, draft) => {
        const line = draft.lines.find(
          (candidate) => candidate.id === request.lineId,
        );
        if (!line) throw invalid();
        const selected = draft.selectedLineIds.includes(request.lineId);
        const deferred = line.decision.kind === "DEFER";
        if (
          (operation === "DEFER" && !selected && deferred) ||
          (operation === "REACTIVATE" && selected && !deferred)
        )
          return draft;
        if (
          operation === "DEFER" ? !selected || deferred : selected || !deferred
        )
          throw invalid();
        if (
          operation === "REACTIVATE" &&
          draft.selectedLineIds.length >= LIMITS.selectedLines
        )
          throw problem(Code.LIMIT_EXCEEDED, _row);
        return validateStoredDraft({
          ...draft,
          lines: draft.lines.map((candidate) =>
            candidate.id === request.lineId
              ? {
                  ...candidate,
                  decision:
                    operation === "DEFER"
                      ? { kind: "DEFER" as const }
                      : { kind: "UNRESOLVED" as const },
                  targets: operation === "DEFER" ? [] : null,
                }
              : candidate,
          ),
          selectedLineIds:
            operation === "DEFER"
              ? draft.selectedLineIds.filter((id) => id !== request.lineId)
              : [...draft.selectedLineIds, request.lineId],
        });
      },
    );
  }

  private async documentaryMutation(
    auth: AuthenticatedImportContext,
    sessionId: string,
    operation: Exclude<ImportDocumentaryOperationV1, "PREPARE_CURRENT_LOT">,
    request: {
      readonly requestId: string;
      readonly expectedRevision: number;
    },
    scope: UiImportGrantScope,
    payloadHash: string,
    grant: unknown,
    mutate: (
      tx: Tx,
      actor: ImportActor,
      row: ImportSession,
      draft: ImportSessionStoredDraftV1,
      now: Date,
    ) => Promise<ImportSessionStoredDraftV1>,
  ): Promise<ImportDocumentaryCommandReceiptV1> {
    let grantSpent = false;
    return runImportSessionWrite(
      this.prisma,
      this.clock,
      auth,
      async (tx, now) => {
        const { actor, row } = await this.authorizedRow(
          tx,
          auth,
          sessionId,
          now,
        );
        if (!grantSpent) {
          this.verifier.verify(grant, auth, scope, now);
          grantSpent = true;
        }
        const draft = parseStoredDraft(row.draftJson);
        await assertReceiptParticipantAccess(
          tx,
          actor,
          draft.lines.flatMap(
            (line) => line.targets?.map((target) => target.projectId) ?? [],
          ),
        );
        const replay = draft.commandLedger?.items.find(
          (item) => item.requestId === request.requestId,
        );
        if (replay) {
          if (
            replay.operation !== operation ||
            replay.payloadHash !== payloadHash ||
            replay.actorUserId !== actor.userId
          )
            throw problem(Code.IDEMPOTENCY_CONFLICT, row);
          return replay.result;
        }
        assertImportSessionOperationAvailable(
          "EDIT",
          this.capability.writesEnabled(),
        );
        this.editable(row, now, request.expectedRevision);
        const updated = await mutate(tx, actor, row, draft, now);
        await assertReceiptParticipantAccess(
          tx,
          actor,
          updated.lines.flatMap(
            (line) => line.targets?.map((target) => target.projectId) ?? [],
          ),
        );
        const changed = !same(draft, updated);
        const revision = changed ? nextRevision(row) : row.revision;
        const receipt: ImportDocumentaryCommandReceiptV1 = {
          version: 1,
          requestId: request.requestId,
          operation,
          outcome: changed ? "APPLIED" : "NO_CHANGE",
          revision,
        };
        const stored = this.appendCommandReceipt(
          updated,
          actor,
          request.expectedRevision,
          payloadHash,
          receipt,
          now,
        );
        const json = canonical(stored);
        if (
          Buffer.byteLength(json, "utf8") > LIMITS.jsonBytesPerDraftOrProposal
        )
          throw problem(Code.LIMIT_EXCEEDED, row);
        await this.update(
          tx,
          row,
          changed
            ? {
                state: State.DRAFT,
                revision,
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
              }
            : { draftJson: json },
        );
        return receipt;
      },
    );
  }

  private appendCommandReceipt(
    draft: ImportSessionStoredDraftV1,
    actor: ImportActor,
    expectedRevision: number,
    payloadHash: string,
    receipt: ImportDocumentaryCommandReceiptV1,
    now: Date,
  ): ImportSessionStoredDraftV1 {
    const previous = draft.commandLedger?.items ?? [];
    return validateStoredDraft({
      ...draft,
      commandLedger: {
        version: 1,
        items: [
          ...previous.slice(
            Math.max(
              0,
              previous.length - LIMITS.documentaryCommandReceipts + 1,
            ),
          ),
          {
            requestId: receipt.requestId,
            operation: receipt.operation,
            payloadHash,
            expectedRevision,
            result: receipt,
            actorUserId: actor.userId,
            recordedAt: now.toISOString(),
          },
        ],
      },
    });
  }

  async edit(
    auth: AuthenticatedImportContext,
    sessionId: string,
    body: unknown,
  ): Promise<ImportSessionViewV1> {
    this.identity(auth, sessionId);
    const request = editRequest(body);
    return this.editCore(auth, sessionId, request);
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
          this.capability.writesEnabled(),
        );
        const draft = parseStoredDraft(row.draftJson);
        const turn = binding?.admission.turn;
        if (binding && (!turn?.focus || !command)) throw invalid();
        let updated: ImportSessionStoredDraftV1;
        if (command?.kind === "DECLARE_OBSERVATION") {
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
          const request =
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
              const observations = await tx.importObservation.findMany({
                where: {
                  tenantId: row.tenantId,
                  ownerProjectId: row.ownerProjectId,
                  artifactId: ref.artifact.id,
                },
                select: { id: true },
                take: LIMITS.parsedRowsPerSession + 1,
              });
              if (
                !observations.length ||
                observations.length > LIMITS.parsedRowsPerSession ||
                observations.some(
                  (obs) => !draft.scope.observationIds.includes(obs.id),
                )
              )
                throw problem(Code.STALE_PREVIEW, row);
              const observationIds = new Set(observations.map((obs) => obs.id));
              allowedLineIds = draft.lines
                .filter((line) =>
                  line.observationIds.some((id) => observationIds.has(id)),
                )
                .map((line) => line.id);
              if (
                observations.some(
                  (obs) =>
                    !draft.lines.some((line) =>
                      line.observationIds.includes(obs.id),
                    ),
                )
              )
                throw problem(Code.STALE_PREVIEW, row);
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
          const newLineIds = new Set<string>();
          const changedDraftFields = new Map<string, Set<string>>();
          for (const line of request.replaceLines) {
            const original = existing.get(line.id);
            if (
              original?.decision.kind === "IGNORED_POLICY" &&
              !same(line, original)
            )
              throw invalid();
            if (original && !same(line.observationIds, original.observationIds))
              throw invalid();
            if (original) {
              const changed = new Set(
                Object.keys(original).filter((key) =>
                  same(Reflect.get(line, key), Reflect.get(original, key))
                    ? false
                    : true,
                ),
              );
              changedDraftFields.set(line.id, changed);
            } else {
              newLineIds.add(line.id);
              changedDraftFields.set(line.id, new Set(Object.keys(line)));
            }
            if (original) {
              for (const field of changedDraftFields.get(line.id) ?? []) {
                if (
                  isGuidedReviewField(field) &&
                  hasDraftFieldValue(line, field)
                )
                  throw invalid();
              }
              const changed = changedDraftFields.get(line.id);
              if (
                (changed?.has("decision") &&
                  (line.targets !== null ||
                    line.tipoDespesa !== null ||
                    line.categoriaMaoDeObra !== null)) ||
                (changed?.has("targets") &&
                  (line.tipoDespesa !== null ||
                    line.categoriaMaoDeObra !== null)) ||
                (changed?.has("tipoDespesa") &&
                  line.categoriaMaoDeObra !== null)
              )
                throw invalid();
            }
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
                    const lineIds = item.lineIds.filter((id) => {
                      const line = replacement.get(id);
                      return !line || same(line, existing.get(id));
                    });
                    return lineIds.length ? [{ ...item, lineIds }] : [];
                  })
                : draft.questions,
              ...(draft.fieldProvenance === undefined
                ? {}
                : {
                    fieldProvenance: draft.fieldProvenance.filter(
                      (item) =>
                        !changedDraftFields.get(item.lineId)?.has(item.field),
                    ),
                  }),
            });
            for (const [lineId, changed] of changedDraftFields) {
              const line = updated.lines.find((item) => item.id === lineId);
              if (!line) throw invalid();
              for (const field of changed) {
                if (
                  !isDraftProvenanceField(field) ||
                  (newLineIds.has(lineId) && isGuidedReviewField(field))
                )
                  continue;
                updated = recordDraftFieldProvenance(
                  updated,
                  [lineId],
                  field,
                  hasDraftFieldValue(line, field) ? "USER" : null,
                  nextRevision(row),
                );
              }
            }
            updated = validateStoredDraft(updated);
          } catch (error) {
            if (error instanceof ImportSessionCorruptStateError)
              throw invalid();
            throw error;
          }
        }
        const selectedLineIds = new Set(updated.selectedLineIds);
        if (
          updated.lines.some(
            (line) =>
              selectedLineIds.has(line.id) &&
              line.decision.kind === "IGNORED_POLICY",
          )
        )
          throw invalid();
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
              analysisEnabled: this.analysisEnabled(),
              workflow: {
                writesEnabled: this.capability.writesEnabled(),
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

  async prepareCurrentLot(
    auth: AuthenticatedImportContext,
    sessionId: string,
    request: PrepareCurrentLotCommandV1,
    grant: unknown,
  ): Promise<ImportDocumentaryCommandReceiptV1> {
    this.identity(auth, sessionId);
    const payloadHash = documentaryPayloadHash(
      sessionId,
      "PREPARE_CURRENT_LOT",
      request,
    );
    const scope: UiImportGrantScope = {
      operation: "PREPARE_CURRENT_LOT",
      sessionId,
      expectedRevision: request.expectedRevision,
      requestId: request.requestId,
      payloadHash,
    };
    let grantSpent = false;
    return runImportSessionWrite(
      this.prisma,
      this.clock,
      auth,
      async (tx, now) => {
        const { actor, row } = await this.authorizedRow(
          tx,
          auth,
          sessionId,
          now,
        );
        if (!grantSpent) {
          this.verifier.verify(grant, auth, scope, now);
          grantSpent = true;
        }
        const draft = parseStoredDraft(row.draftJson);
        await assertReceiptParticipantAccess(
          tx,
          actor,
          draft.lines.flatMap(
            (line) => line.targets?.map((target) => target.projectId) ?? [],
          ),
        );
        const replay = draft.commandLedger?.items.find(
          (item) => item.requestId === request.requestId,
        );
        if (replay) {
          if (
            replay.operation !== "PREPARE_CURRENT_LOT" ||
            replay.payloadHash !== payloadHash ||
            replay.actorUserId !== actor.userId
          )
            throw problem(Code.IDEMPOTENCY_CONFLICT, row);
          return replay.result;
        }
        assertImportSessionOperationAvailable(
          "PREPARE",
          this.capability.writesEnabled(),
        );
        this.editable(row, now, request.expectedRevision);
        if (row.state === State.READY) {
          const current = parseSessionDocuments(row);
          if (
            current.proposal !== null &&
            current.searchComplete &&
            current.proposal.revision === row.revision &&
            hash(row.proposalHash) &&
            hash(row.preflightHash) &&
            this.isProposalCanonical(current.stored, current.proposal)
          )
            throw problem(Code.STALE_PREVIEW, row);
        }
        const material = await this.material(tx, row, draft);
        this.noInFlight(row, material);
        const locked = mintLockedImportSession(tx, auth, row, draft);
        try {
          const result = await this.batches.prepareInTx(
            tx,
            auth,
            locked,
            CardPurchasePreparationPurpose.SEAL_CURRENT_LOT,
          );
          const preparedDraft = validateStoredDraft(result.draft);
          if (
            !same(draft.scope, preparedDraft.scope) ||
            preparedDraft.selectedLineIds.some(
              (lineId) => !draft.selectedLineIds.includes(lineId),
            ) ||
            !same(draft.commandLedger, preparedDraft.commandLedger) ||
            !same(
              draft.interpretationLedger,
              preparedDraft.interpretationLedger,
            )
          )
            throw corrupt("preparation");
          await assertReceiptParticipantAccess(
            tx,
            actor,
            preparedDraft.lines.flatMap(
              (line) => line.targets?.map((target) => target.projectId) ?? [],
            ),
          );
          const revision = nextRevision(row);
          const search = parseStoredImportSearch(
            canonical(result.search),
            revision,
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
          const receipt: ImportDocumentaryCommandReceiptV1 = {
            version: 1,
            requestId: request.requestId,
            operation: "PREPARE_CURRENT_LOT",
            outcome:
              result.kind === "READY" ? "CURRENT_LOT_READY" : "NEEDS_INPUT",
            revision,
          };
          const stored = this.appendCommandReceipt(
            preparedDraft,
            actor,
            request.expectedRevision,
            payloadHash,
            receipt,
            now,
          );
          await this.update(tx, row, {
            state: result.kind,
            revision,
            draftJson: canonical(stored),
            searchJson: canonical(search.value),
            proposalJson: proposal === null ? null : canonical(proposal),
            proposalHash: proposal?.proposalHash ?? null,
            preflightHash,
            challengeJson: null,
            prepareLeaseJson: null,
            prepareGeneration: { increment: 1 },
          });
          return receipt;
        } finally {
          releaseLockedImportSession(locked);
        }
      },
    );
  }

  async continueAnswering(
    auth: AuthenticatedImportContext,
    sessionId: string,
    request: ContinueAnsweringCommandV1,
    grant: unknown,
  ): Promise<ImportDocumentaryCommandReceiptV1> {
    this.identity(auth, sessionId);
    const payloadHash = documentaryPayloadHash(
      sessionId,
      "CONTINUE_ANSWERING",
      request,
    );
    const scope: UiImportGrantScope = {
      operation: "CONTINUE_ANSWERING",
      sessionId,
      expectedRevision: request.expectedRevision,
      requestId: request.requestId,
      payloadHash,
    };
    let grantSpent = false;
    return runImportSessionWrite(
      this.prisma,
      this.clock,
      auth,
      async (tx, now) => {
        const { actor, row } = await this.authorizedRow(
          tx,
          auth,
          sessionId,
          now,
        );
        if (!grantSpent) {
          this.verifier.verify(grant, auth, scope, now);
          grantSpent = true;
        }
        const draft = parseStoredDraft(row.draftJson);
        await assertReceiptParticipantAccess(
          tx,
          actor,
          draft.lines.flatMap(
            (line) => line.targets?.map((target) => target.projectId) ?? [],
          ),
        );
        const replay = draft.commandLedger?.items.find(
          (item) => item.requestId === request.requestId,
        );
        if (replay) {
          if (
            replay.operation !== "CONTINUE_ANSWERING" ||
            replay.payloadHash !== payloadHash ||
            replay.actorUserId !== actor.userId
          )
            throw problem(Code.IDEMPOTENCY_CONFLICT, row);
          return replay.result;
        }
        assertImportSessionOperationAvailable(
          "PREPARE",
          this.capability.writesEnabled(),
        );
        this.editable(row, now, request.expectedRevision);
        const documents = parseSessionDocuments(row);
        const proposal = documents.proposal;
        if (
          row.state !== State.READY ||
          proposal === null ||
          !documents.searchComplete ||
          proposal.revision !== row.revision ||
          !hash(row.proposalHash) ||
          !hash(row.preflightHash) ||
          !this.isProposalCanonical(documents.stored, proposal) ||
          (proposal.deferredObservationIds.length === 0 &&
            proposal.deferredAttachmentIds.length === 0)
        )
          throw problem(Code.STALE_PREVIEW, row);

        const deferredObservationIds = new Set(proposal.deferredObservationIds);
        const readyLineIds = new Set(proposal.lines.map((line) => line.lineId));
        const selectedLineIds = documents.stored.lines
          .filter(
            (line) =>
              readyLineIds.has(line.id) ||
              (line.decision.kind !== "EXCLUDE" &&
                line.decision.kind !== "IGNORED_POLICY" &&
                line.observationIds.length > 0 &&
                line.observationIds.every((observationId) =>
                  deferredObservationIds.has(observationId),
                )),
          )
          .map((line) => line.id);
        if (selectedLineIds.length > LIMITS.selectedLines)
          throw problem(Code.LIMIT_EXCEEDED, row);
        if (
          proposal.deferredObservationIds.length > 0 &&
          !selectedLineIds.some((lineId) => !readyLineIds.has(lineId))
        )
          throw problem(Code.STALE_PREVIEW, row);
        const restoredDraft = validateStoredDraft({
          ...documents.stored,
          selectedLineIds,
        });
        const material = await this.material(tx, row, restoredDraft);
        this.noInFlight(row, material);
        const locked = mintLockedImportSession(tx, auth, row, restoredDraft);
        try {
          const result = await this.batches.prepareInTx(
            tx,
            auth,
            locked,
            CardPurchasePreparationPurpose.ANSWER_PENDING,
          );
          if (result.kind !== "NEEDS_INPUT") throw corrupt("preparation");
          const preparedDraft = validateStoredDraft(result.draft);
          if (
            !same(restoredDraft.scope, preparedDraft.scope) ||
            !same(
              restoredDraft.selectedLineIds,
              preparedDraft.selectedLineIds,
            ) ||
            !same(restoredDraft.commandLedger, preparedDraft.commandLedger) ||
            !same(
              restoredDraft.interpretationLedger,
              preparedDraft.interpretationLedger,
            )
          )
            throw corrupt("preparation");
          await assertReceiptParticipantAccess(
            tx,
            actor,
            preparedDraft.lines.flatMap(
              (line) => line.targets?.map((target) => target.projectId) ?? [],
            ),
          );
          const revision = nextRevision(row);
          const search = parseStoredImportSearch(
            canonical(result.search),
            revision,
            preparedDraft,
          );
          if (search.kind !== "SEARCH") throw corrupt("search");
          const receipt: ImportDocumentaryCommandReceiptV1 = {
            version: IMPORT_SESSION_PROTOCOL_VERSION,
            requestId: request.requestId,
            operation: "CONTINUE_ANSWERING",
            outcome: "NEEDS_INPUT",
            revision,
          };
          const stored = this.appendCommandReceipt(
            preparedDraft,
            actor,
            request.expectedRevision,
            payloadHash,
            receipt,
            now,
          );
          await this.update(tx, row, {
            state: State.NEEDS_INPUT,
            revision,
            draftJson: canonical(stored),
            searchJson: canonical(search.value),
            proposalJson: null,
            proposalHash: null,
            preflightHash: null,
            challengeJson: null,
            prepareLeaseJson: null,
            prepareGeneration: { increment: 1 },
          });
          return receipt;
        } finally {
          releaseLockedImportSession(locked);
        }
      },
    );
  }

  async currentLot(
    auth: AuthenticatedImportContext,
    sessionId: string,
  ): Promise<ImportCurrentLotV1> {
    this.identity(auth, sessionId);
    return this.prisma.$transaction(async (tx) => {
      const now = this.clock.now();
      const actor = await reauthorize(tx, auth, now);
      const row = await loadOwnedImportSession(tx, actor, sessionId);
      await assertImportSessionAccess(tx, actor, row, now);
      await assertReceiptParticipantAccess(tx, actor, [row.ownerProjectId]);
      const state = effectiveState(row, now);
      if (
        (state !== State.READY && state !== State.CONFIRMED) ||
        row.proposalJson === null ||
        row.proposalHash === null
      )
        throw problem(Code.STALE_PREVIEW, row);
      const { stored, proposal } = parseSessionDocuments(row);
      if (
        proposal === null ||
        proposal.revision !== row.revision ||
        proposal.proposalHash !== row.proposalHash
      )
        throw corrupt("proposal");
      return this.projectCurrentLotInTx(
        tx,
        actor,
        row,
        state,
        proposal,
        stored,
      );
    });
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
          this.capability.writesEnabled(),
        );
        this.editable(row, now, request.expectedRevision);
        const draft = parseStoredDraft(row.draftJson);
        const material = await this.material(tx, row, draft);
        this.noInFlight(row, material);
        const locked = mintLockedImportSession(tx, auth, row, draft);
        let rendered: ImportSessionViewV1;
        try {
          const result = await this.batches.prepareInTx(
            tx,
            auth,
            locked,
            CardPurchasePreparationPurpose.SEAL_CURRENT_LOT,
          );
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
                analysisEnabled: this.analysisEnabled(),
                workflow: {
                  writesEnabled: this.capability.writesEnabled(),
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
        const { actor, row, view } = await this.context(
          tx,
          auth,
          sessionId,
          now,
        );
        assertImportSessionOperationAvailable(
          "CHALLENGE",
          this.capability.writesEnabled(),
        );
        this.ready(row, view, now, request);
        const { stored, proposal } = parseSessionDocuments(row);
        if (!proposal || !row.proposalHash) throw corrupt("proposal");
        const currentLot = await this.projectCurrentLotInTx(
          tx,
          actor,
          row,
          State.READY,
          proposal,
          stored,
        );
        if (currentLot.confirmationHash !== request.confirmationHash)
          throw problem(Code.STALE_PREVIEW, row);
        this.noInFlight(row, await this.material(tx, row, stored));
        const nonce = randomBytes(32).toString("base64url");
        const expiresAt = new Date(
          now.getTime() + LIMITS.confirmationNonceSeconds * 1000,
        ).toISOString();
        await this.update(tx, row, {
          challengeJson: JSON.stringify({
            bindingVersion: 1,
            kind: "PENDING_CONFIRMATION",
            nonceHash: digest(nonce),
            revision: request.expectedRevision,
            confirmationHash: request.confirmationHash,
            fullPlanDigest: row.proposalHash,
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
    const grantScope = {
      operation: "CONFIRM" as const,
      sessionId,
      expectedRevision: request.expectedRevision,
      confirmationHash: request.confirmationHash,
      financialRequestId: request.financialRequestId,
    };
    this.verifier.verifyFinancialAction(
      grant,
      auth,
      grantScope,
      this.clock.now(),
    );
    const outcome = await runImportSessionWrite(
      this.prisma,
      this.clock,
      auth,
      async (
        tx,
        now,
      ): Promise<ImportSessionConfirmResponseV1 | ImportSessionError> => {
        const { actor, row, view } = await this.context(
          tx,
          auth,
          sessionId,
          now,
        );
        if (row.financialRequestId !== null) {
          if (
            row.financialRequestId !== request.financialRequestId ||
            row.confirmedRevision !== request.expectedRevision
          )
            throw problem(Code.IDEMPOTENCY_CONFLICT, row);
          const binding = this.confirmedBinding(row);
          if (
            binding !== null &&
            (binding.confirmationHash !== request.confirmationHash ||
              binding.fullPlanDigest !== row.proposalHash)
          )
            throw problem(Code.IDEMPOTENCY_CONFLICT, row);
          if (binding === null && row.state === State.APPLIED) {
            if (row.receiptJson === null) throw corrupt("receipt");
            const receipt = parseReceipt(
              row.receiptJson,
              row.id,
              row.ownerProjectId,
            );
            if (
              receipt.bindingVersion === 1 &&
              (receipt.confirmationHash !== request.confirmationHash ||
                receiptFullPlanDigest(row.receiptJson) !== row.proposalHash)
            )
              throw problem(Code.IDEMPOTENCY_CONFLICT, row);
          }
          return this.confirmation(row, now);
        }
        assertImportSessionOperationAvailable(
          "FIRST_CONFIRM",
          this.capability.writesEnabled(),
        );
        this.ready(row, view, now, request);
        const { stored: draft, proposal } = parseSessionDocuments(row);
        if (!proposal) throw corrupt("proposal");
        if (!this.isProposalCanonical(draft, proposal))
          return this.review(tx, row);
        const currentLot = await this.projectCurrentLotInTx(
          tx,
          actor,
          row,
          State.READY,
          proposal,
          draft,
        );
        if (currentLot.confirmationHash !== request.confirmationHash)
          throw problem(Code.STALE_PREVIEW, row);
        this.noInFlight(row, await this.material(tx, row, draft));
        const challenge = this.nonce(row, auth, request, now);
        if (challenge.fullPlanDigest !== row.proposalHash)
          throw problem(Code.STALE_PREVIEW, row);
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
          challengeJson: canonical({
            bindingVersion: 1,
            kind: "CONFIRMED_BINDING",
            revision: request.expectedRevision,
            confirmationHash: request.confirmationHash,
            fullPlanDigest: row.proposalHash,
            sessionVersion: auth.presentedSessionVersion,
          } satisfies ImportSessionConfirmedBinding),
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
    if (outcome instanceof ImportSessionError) throw outcome;
    return outcome;
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
            row.receiptJson === null ||
            receiptFullPlanDigest(row.receiptJson) !== row.proposalHash
          )
            throw corrupt("receipt");
          await assertReceiptParticipantAccess(
            tx,
            actor,
            view.receipt.snapshot.participantProjectIds,
          );
          return { receipt: view.receipt, invalidatedClaims: [] };
        }
        assertImportSessionOperationAvailable(
          "EXECUTE_UNAPPLIED",
          this.capability.writesEnabled(),
        );
        if (effectiveState(row, now) === State.EXPIRED) {
          if (row.state === State.CONFIRMED)
            await this.update(tx, row, {
              state: State.EXPIRED,
              revision: nextRevision(row),
              draftJson: terminalDraftJson(row.draftJson),
              searchJson: null,
              proposalJson: null,
              preflightHash: null,
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
        const confirmedProposal = parseSessionDocuments(row).proposal;
        if (confirmedProposal === null) throw corrupt("confirmation");
        if (row.confirmedSessionVersion !== auth.presentedSessionVersion)
          return { error: await this.review(tx, row) };
        const confirmedBinding = this.confirmedBinding(row);
        if (
          confirmedBinding !== null &&
          confirmedBinding.fullPlanDigest !== row.proposalHash
        )
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
        const selectedClaims = new Map(
          draft.lines
            .filter((line) => draft.selectedLineIds.includes(line.id))
            .flatMap((line) =>
              line.observationIds.map(
                (observationId) => [observationId, line.decision] as const,
              ),
            ),
        );
        if (
          material.observations.some((observation) => {
            const decision = selectedClaims.get(observation.id);
            return (
              decision !== undefined &&
              !unclaimed(observation) &&
              !(
                decision.kind === "KEEP_EXISTING" &&
                observation.canonicalExpenseId === decision.expenseId &&
                observation.canonicalReceiptId === null
              )
            );
          }) ||
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
            const result = await this.batches.prepareInTx(
              tx,
              auth,
              locked,
              CardPurchasePreparationPurpose.SEAL_CURRENT_LOT,
            );
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
              !same(plan.proposal, confirmedProposal) ||
              (confirmedBinding !== null &&
                confirmedBinding.fullPlanDigest !== plan.proposal.proposalHash)
            )
              return { error: await this.review(tx, row) };
          } catch (error) {
            if (
              error instanceof ImportSessionError &&
              [
                Code.INVALID_INPUT,
                Code.NOT_FOUND,
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
            const proposalLine = plan.proposal.lines.find(
              (line) => line.lineId === observation.lineId,
            );
            if (!proposalLine) throw corrupt("proposal");
            const currentObservation = material.observations.find(
              (candidate) => candidate.id === observation.id,
            );
            if (!currentObservation) throw corrupt("preparation");
            // Exact replay of an already-bound KEEP must not rewrite provenance.
            // A newly observed installment still needs its durable documentary claim.
            if (
              proposalLine.kind === "KEEP_EXISTING" &&
              !unclaimed(currentObservation)
            )
              continue;
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
                canonicalExpenseId:
                  proposalLine.kind === "KEEP_EXISTING"
                    ? proposalLine.sourceExpenseId
                    : item.sourceExpenseId,
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
          receipt.continuationSessionId = continuation.continuationSessionId;
          await tx.userActivityLog.create({
            data: {
              tenantId: row.tenantId,
              userId: row.ownerUserId,
              action: AUDIT_ACTION,
              createdAt: now,
            },
          });
          let storedReceipt: Record<string, unknown>;
          if (receipt.bindingVersion === 1) {
            storedReceipt = { ...receipt, fullPlanDigest: row.proposalHash };
          } else {
            const {
              bindingVersion: _version,
              confirmationHash: _hash,
              ...legacyReceipt
            } = receipt;
            storedReceipt = {
              ...legacyReceipt,
              proposalHash: row.proposalHash,
            };
          }
          const checked = parseReceipt(
            JSON.stringify(storedReceipt),
            row.id,
            row.ownerProjectId,
          );
          await this.update(tx, row, {
            state: State.APPLIED,
            revision: nextRevision(row),
            draftJson: terminalDraftJson(row.draftJson),
            searchJson: null,
            proposalJson: null,
            preflightHash: null,
            receiptJson: JSON.stringify(storedReceipt),
            closedAt: now,
            challengeJson: null,
            prepareLeaseJson: null,
            prepareGeneration: { increment: 1 },
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

  private identity(auth: AuthenticatedImportContext, sessionId: string): void {
    assertMintedImportContext(auth);
    assertSessionId(sessionId);
  }
  private analysisEnabled(): boolean {
    return (
      this.capability.writesEnabled() &&
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
    const { actor, row } = await this.authorizedRow(tx, auth, sessionId, now);
    const { view } = await renderImportSession(tx, row, now, {
      includeReceipt: true,
      includeProposal: true,
      analysisEnabled: this.analysisEnabled(),
      workflow: {
        writesEnabled: this.capability.writesEnabled(),
        canMutate: true,
        presentedSessionVersion: auth.presentedSessionVersion,
      },
    });
    return { actor, row, view };
  }
  private async authorizedRow(
    tx: Tx,
    auth: AuthenticatedImportContext,
    sessionId: string,
    now: Date,
  ): Promise<{ actor: ImportActor; row: ImportSession }> {
    const actor = await reauthorize(tx, auth, now);
    const row = await loadOwnedImportSession(tx, actor, sessionId);
    await assertImportSessionAccess(tx, actor, row, now);
    await assertReceiptParticipantAccess(tx, actor, [row.ownerProjectId]);
    return { actor, row };
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
      !hash(row.proposalHash) ||
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
  private async projectCurrentLotInTx(
    tx: Tx,
    actor: ImportActor,
    row: ImportSession,
    state: "READY" | "CONFIRMED",
    proposal: ImportSessionProposalV1,
    stored: ImportSessionStoredDraftV1,
  ): Promise<ImportCurrentLotV1> {
    const { projects, rooms, expenses } =
      await this.resolveProposalParticipants(tx, actor, row, proposal);
    const lineContexts = new Map<string, CurrentLotDisplayContext>();
    for (const planned of proposal.lines) {
      if (planned.kind === "CREATE") continue;
      const expense = expenses.find(
        (candidate) => candidate.id === planned.sourceExpenseId,
      );
      if (!expense?.dataCompra) throw corrupt("current_lot");
      lineContexts.set(planned.lineId, {
        title: expense.titulo ?? expense.fornecedor ?? "Compra existente",
        merchant: expense.fornecedor,
        purchaseDate: expense.dataCompra.toISOString().slice(0, 10),
        installmentIndex: null,
        installmentCount: expense.quantidadeParcela,
      });
    }
    return projectCurrentLot(state, proposal, stored, {
      projects: new Map(projects.map((project) => [project.id, project.name])),
      rooms: new Map(rooms.map((room) => [room.id, room.name])),
      lines: lineContexts,
    });
  }
  private async resolveProposalParticipants(
    tx: Tx,
    actor: ImportActor,
    row: ImportSession,
    proposal: ImportSessionProposalV1,
  ): Promise<{
    projects: Array<{ id: string; name: string }>;
    rooms: Array<{ id: string; projectId: string; name: string }>;
    expenses: Array<{
      id: string;
      projectId: string;
      titulo: string | null;
      fornecedor: string | null;
      dataCompra: Date | null;
      quantidadeParcela: number | null;
    }>;
  }> {
    const targetProjectIds = [
      ...new Set(
        proposal.lines.flatMap((line) =>
          line.kind === "CREATE"
            ? line.targets.map((target) => target.projectId)
            : [],
        ),
      ),
    ];
    const roomIds = [
      ...new Set(
        proposal.lines.flatMap((line) =>
          line.kind === "CREATE"
            ? line.targets.flatMap((target) =>
                target.roomId === null ? [] : [target.roomId],
              )
            : [],
        ),
      ),
    ];
    const keepIds = proposal.lines.flatMap((line) =>
      line.kind === "KEEP_EXISTING" ? [line.sourceExpenseId] : [],
    );
    const [projects, rooms, expenses] = await Promise.all([
      targetProjectIds.length === 0
        ? []
        : tx.project.findMany({
            where: {
              tenantId: actor.tenantId,
              id: { in: targetProjectIds },
              type: ProjectType.REFORMA,
              deletedAt: null,
            },
            select: { id: true, name: true },
          }),
      roomIds.length === 0
        ? []
        : tx.room.findMany({
            where: { id: { in: roomIds }, deletedAt: null },
            select: { id: true, projectId: true, name: true },
          }),
      keepIds.length === 0
        ? []
        : tx.expense.findMany({
            where: {
              tenantId: actor.tenantId,
              projectId: row.ownerProjectId,
              id: { in: keepIds },
              deletedAt: null,
            },
            select: {
              id: true,
              projectId: true,
              titulo: true,
              fornecedor: true,
              dataCompra: true,
              quantidadeParcela: true,
            },
          }),
    ]);
    if (
      projects.length !== targetProjectIds.length ||
      rooms.length !== roomIds.length ||
      expenses.length !== keepIds.length ||
      proposal.lines.some(
        (line) =>
          line.kind === "CREATE" &&
          line.targets.some(
            (target) =>
              target.roomId !== null &&
              !rooms.some(
                (room) =>
                  room.id === target.roomId &&
                  room.projectId === target.projectId,
              ),
          ),
      )
    )
      throw problem(Code.NOT_FOUND, row);
    await assertReceiptParticipantAccess(tx, actor, [
      ...targetProjectIds,
      ...expenses.map((expense) => expense.projectId),
    ]);
    return { projects, rooms, expenses };
  }
  private isProposalCanonical(
    draft: ImportSessionStoredDraftV1,
    proposal: ImportSessionProposalV1,
  ): boolean {
    const actionableLineIds = draft.lines
      .filter(
        (line) =>
          draft.selectedLineIds.includes(line.id) &&
          (line.decision.kind === "CREATE" ||
            line.decision.kind === "KEEP_EXISTING"),
      )
      .map((line) => line.id);
    if (
      actionableLineIds.length !== proposal.lines.length ||
      actionableLineIds.some(
        (lineId) =>
          !proposal.lines.some((prepared) => prepared.lineId === lineId),
      )
    )
      return false;
    const provenance = (
      lineId: string,
      field: ImportSessionDraftFieldV1,
    ): boolean =>
      draft.fieldProvenance?.some(
        (item) => item.lineId === lineId && item.field === field,
      ) ?? false;
    return proposal.lines.every((prepared) => {
      const line = draft.lines.find(
        (candidate) => candidate.id === prepared.lineId,
      );
      if (!line || !provenance(line.id, "decision")) return false;
      if (prepared.kind === "KEEP_EXISTING")
        return (
          line.decision.kind === "KEEP_EXISTING" &&
          line.decision.expenseId === prepared.sourceExpenseId
        );
      const projectType =
        prepared.targets.length === 0
          ? ProjectType.PESSOAL
          : prepared.targets.length === 1
            ? ProjectType.REFORMA
            : null;
      return (
        projectType !== null &&
        line.decision.kind === "CREATE" &&
        line.titulo === prepared.titulo &&
        line.fornecedor === prepared.fornecedor &&
        line.dataCompra === prepared.dataCompra &&
        line.amountCents === prepared.totalCents &&
        line.installmentCount === prepared.schedule.occurrences.length &&
        line.tipoDespesa === prepared.tipoDespesa &&
        line.categoriaMaoDeObra === prepared.categoriaMaoDeObra &&
        line.targets !== null &&
        line.targets.length === prepared.targets.length &&
        line.targets.every((target, index) => {
          const preparedTarget = prepared.targets[index];
          return (
            preparedTarget !== undefined &&
            target.projectId === preparedTarget.projectId &&
            target.roomId === preparedTarget.roomId &&
            target.amountCents === preparedTarget.amountCents
          );
        }) &&
        provenance(line.id, "targets") &&
        provenance(line.id, "tipoDespesa") &&
        (prepared.tipoDespesa !== ExpenseType.MAO_DE_OBRA ||
          provenance(line.id, "categoriaMaoDeObra")) &&
        getExpenseTypesForProject(projectType).includes(prepared.tipoDespesa)
      );
    });
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
  private confirmedBinding(
    row: ImportSession,
  ): ImportSessionConfirmedBinding | null {
    if (row.challengeJson === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(row.challengeJson);
    } catch {
      throw corrupt("confirmation_binding");
    }
    if (
      !record(value) ||
      Object.keys(value).length !== 6 ||
      value.bindingVersion !== 1 ||
      value.kind !== "CONFIRMED_BINDING" ||
      typeof value.revision !== "number" ||
      !Number.isSafeInteger(value.revision) ||
      value.revision !== row.confirmedRevision ||
      !hash(value.confirmationHash) ||
      !hash(value.fullPlanDigest) ||
      typeof value.sessionVersion !== "number" ||
      !Number.isSafeInteger(value.sessionVersion) ||
      value.sessionVersion !== row.confirmedSessionVersion
    )
      throw corrupt("confirmation_binding");
    return value as unknown as ImportSessionConfirmedBinding;
  }
  private nonce(
    row: ImportSession,
    auth: AuthenticatedImportContext,
    request: ImportSessionConfirmRequestV1,
    now: Date,
  ): ImportSessionChallenge {
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
      record(value) &&
      Object.keys(value).length === 5 &&
      Object.prototype.hasOwnProperty.call(value, "proposalHash")
    )
      throw problem(Code.UI_ACTION_REQUIRED, row);
    if (
      !record(value) ||
      Object.keys(value).length !== 8 ||
      value.bindingVersion !== 1 ||
      value.kind !== "PENDING_CONFIRMATION" ||
      !hash(value.nonceHash) ||
      !hash(value.confirmationHash) ||
      !hash(value.fullPlanDigest) ||
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
      value.confirmationHash !== request.confirmationHash ||
      value.sessionVersion !== auth.presentedSessionVersion ||
      now.getTime() >= Date.parse(value.expiresAt) ||
      !timingSafeEqual(
        Buffer.from(value.nonceHash, "hex"),
        Buffer.from(digest(request.nonce), "hex"),
      )
    )
      throw problem(Code.UI_ACTION_REQUIRED, row);
    return value as unknown as ImportSessionChallenge;
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
    const boundReferences = references.map(({ artifact, ...ref }) => ({
      ref,
      artifact,
    }));
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
      const line = batch.proposal.lines.find(
        (candidate) => candidate.lineId === binding.lineId,
      );
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
        !(
          unclaimed(observation) ||
          (line?.kind === "KEEP_EXISTING" &&
            observation.canonicalExpenseId === line.sourceExpenseId &&
            observation.canonicalReceiptId === null)
        )
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
    const binding = this.confirmedBinding(row);
    return {
      version: IMPORT_SESSION_PROTOCOL_VERSION,
      sessionId: row.id,
      financialRequestId: row.financialRequestId,
      confirmedRevision: row.confirmedRevision,
      bindingVersion: binding === null ? 0 : 1,
      confirmationHash: binding?.confirmationHash ?? null,
      appliedAt: now.toISOString(),
      continuationSessionId: null,
      items,
      auditItems: structuredClone(proposal.noWriteRows ?? []),
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
