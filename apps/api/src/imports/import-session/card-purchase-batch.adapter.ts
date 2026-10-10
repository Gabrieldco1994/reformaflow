import { createHash } from "node:crypto";
import type {
  CashFlowEntry,
  Expense,
  ImportArtifact,
  ImportObservation,
  Prisma,
  Project,
  RateioAllocation,
} from "@prisma/client";
import {
  addMonthsToMonthKey,
  buildInstallments,
  caixaDateForCardPurchase,
  ExpenseType,
  ExpenseStatus,
  IMPORT_SESSION_KIND,
  IMPORT_SESSION_LIMITS as LIMITS,
  IMPORT_SESSION_PROTOCOL_VERSION,
  ImportSessionAmountMeaning,
  ImportSessionErrorCode,
  PaymentForm,
  ProjectType,
  getExpenseTypesForProject,
  hasFeature,
  resolveInstallmentIndex,
  type ImportSessionDraftLineV1,
  type ImportSessionDraftQuestionV1,
  type ImportSessionNoWriteRowV1,
  type ImportSessionReceiptV1,
} from "@reformaflow/domain";
import {
  CREDIT_CARD_MODULE,
  EXPENSE_MODULE,
  RECEIPT_MODULE,
  userCanAccessProject,
  userCanAccessProjectModule,
} from "../../common/access-rules";
import { canonical } from "../../common/canonical";
import type { ConciliacaoService } from "../../conciliacao/conciliacao.service";
import {
  checkCardImportKeep,
  inspectCardImportInTx,
  type CardImportFacts,
  type PurchaseIdentity,
} from "../../credit-card/card-purchase-identity";
import { createRateioTargets } from "../../expense/create-rateio-targets";
import {
  parseStoredExpenseSchedule,
  toPublicExpenseSchedule,
} from "../../expense/documented-schedule";
import type { ExpenseService } from "../../expense/expense.service";
import {
  EVIDENCE_KIND,
  type ScheduleEvidenceInput,
} from "../../expense/documented-schedule.types";
import {
  importObservationDedupeKeys,
  resolveImportDeclarations,
} from "./import-session.declarations";
import {
  enumerateDedupeMatches,
  type DedupeKeys,
} from "../../import-dedupe/cross-origin-dedupe";
import { INCLUDE_SOFT_DELETED } from "../../prisma/prisma.service";
import type {
  CardPurchaseBatchPort,
  CardPurchasePreparation,
  CardPurchasePreparationPurpose,
  ImportCandidateRef,
  SearchStage,
  StoredImportSearchV1,
} from "./card-purchase-batch.port";
import { CardPurchasePreparationPurpose as PreparationPurpose } from "./card-purchase-batch.port";
import { reauthorize, type ImportActor } from "./import-session.auth";
import type { ImportSessionClock } from "./import-session.capability";
import {
  assertLockedImportSession,
  consumePreparedCardBatch,
  mintPreparedCardBatch,
  type AuthenticatedImportContext,
  type LockedImportSession,
  type PreparedCardBatch,
} from "./import-session.contract";
import {
  ImportSessionCorruptStateError,
  ImportSessionError,
} from "./import-session.errors";
import {
  parseStoredImportObservationEvidence,
  projectImportObservation,
} from "./import-session.observation";
import {
  buildImportPreparationPlan,
  type ProposalBody,
} from "./import-session.preparation";
import {
  deriveImportSessionEffects,
  validateStoredDraft,
} from "./import-session.validation";
import {
  checkImportObservationCycle,
  createImportObservationCycleReader,
  hasIncompleteCreateOccurrence,
  isWholePurchaseObservation,
  readStoredImportExtraction,
} from "./import-session.extraction";
import {
  buildGuidedReviewAuthority,
  selectServerReadyLines,
} from "./import-guided-review";
import { financialPreparationBindingOf } from "./import-financial-preparation-binding";

const CHUNK = 300;
const RECALCULATED_QUESTION_ID_SCOPE = "GUIDED_RECALCULATION";
const STAGES: readonly SearchStage[] = [
  "DOCUMENT_IDENTITY",
  "CROSS_ORIGIN",
  "CARD_IDENTITY",
];
const hash = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");
const notFound = (): never => {
  throw new ImportSessionError(ImportSessionErrorCode.NOT_FOUND);
};
const cursor = (after: string | null) =>
  after === null ? {} : { id: { gt: after } };
function chunks<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += CHUNK)
    result.push(values.slice(offset, offset + CHUNK));
  return result;
}
function unionRows<T extends { id: string }>(
  before: readonly T[],
  added: readonly T[],
): T[] {
  return [
    ...new Map([...before, ...added].map((row) => [row.id, row])).values(),
  ];
}

/** A single balance, including repeated reads and the overflow witness. */
class SearchBudget {
  visited = 0;
  get remaining(): number {
    return LIMITS.matchingRowsVisitedPerPreparation - this.visited;
  }
  spend(rows: number): void {
    this.visited += rows;
    if (this.remaining < 0)
      throw new ImportSessionError(ImportSessionErrorCode.SEARCH_TOO_BROAD);
  }
  async pages<T extends { id: string }>(
    query: (after: string | null, take: number) => Promise<T[]>,
  ): Promise<T[]> {
    const result: T[] = [];
    let after: string | null = null;
    for (;;) {
      const take = Math.min(CHUNK, this.remaining + 1);
      const page = await query(after, take);
      this.spend(page.length);
      result.push(...page);
      if (page.length < take) return result;
      after = page[page.length - 1]!.id;
    }
  }
}

type ReceiptItem = ImportSessionReceiptV1["items"][number];
interface PreparedExecution {
  ownerProjectId: string;
  cardId: string;
  actor: ImportActor;
  evidence: Map<
    string,
    {
      documentSha256: string;
      reference: string;
    } & (
      | { kind: "DOCUMENT" }
      | {
          kind: "HUMAN_SUPPORTED";
          supportDigest: string;
          attestedByUserId: string;
          confirmedAt: Date | null;
        }
    )
  >;
  kept: Map<string, ReceiptItem>;
}

/** Inactive in-process adapter. The caller owns the writer, confirmation and all session effects. */
export class CardPurchaseBatchAdapter implements CardPurchaseBatchPort {
  private readonly executions = new WeakMap<
    PreparedCardBatch,
    PreparedExecution
  >();

  constructor(
    private readonly expenses: ExpenseService,
    private readonly conciliacao: ConciliacaoService,
    private readonly clock: ImportSessionClock,
  ) {}

  async prepareInTx(
    tx: Prisma.TransactionClient,
    auth: AuthenticatedImportContext,
    session: LockedImportSession,
    purpose: CardPurchasePreparationPurpose = PreparationPurpose.SEAL_CURRENT_LOT,
  ): Promise<CardPurchasePreparation> {
    assertLockedImportSession(tx, auth, session);
    const budget = new SearchBudget();
    const actor = await reauthorize(tx, auth, this.clock.now());
    // Successful reauthorization materializes both the user and its mandatory tenant.
    budget.spend(2);
    const draft = structuredClone(validateStoredDraft(session.draft));
    const selected = draft.selectedLineIds.map((id) => {
      const line = draft.lines.find((item) => item.id === id);
      if (!line) throw new ImportSessionCorruptStateError("draft_json");
      if (
        line.decision.kind === "CREATE" &&
        line.amountCents !== null &&
        line.amountCents <= 0
      )
        throw new ImportSessionError(ImportSessionErrorCode.INVALID_INPUT);
      return line;
    });
    const selectedLineIds = new Set(draft.selectedLineIds);
    const persistedSelectedQuestions = draft.questions.flatMap((question) =>
      "subject" in question
        ? []
        : question.lineIds
            .filter((lineId) => selectedLineIds.has(lineId))
            .map((lineId) => ({ lineId, field: question.field })),
    );
    const persistedSelectedDocumentaryQuestions = draft.questions.filter(
      (question) =>
        "subject" in question &&
        question.lineIds.some((lineId) => selectedLineIds.has(lineId)),
    );
    if (purpose === PreparationPurpose.SEAL_CURRENT_LOT)
      draft.questions = draft.questions.flatMap((question) => {
        const retainedLineIds = question.lineIds.filter(
          (lineId) => !selectedLineIds.has(lineId),
        );
        if (retainedLineIds.length === question.lineIds.length)
          return [question];
        if (retainedLineIds.length === 0 || "subject" in question) return [];
        return [{ ...question, lineIds: retainedLineIds }];
      });
    const ask = (
      line: ImportSessionDraftLineV1,
      field: ImportSessionDraftQuestionV1["field"],
    ): void => {
      if (
        draft.questions.some(
          (q) => q.field === field && q.lineIds.includes(line.id),
        )
      )
        return;
      const ordinaryId = hash({ lineId: line.id, field });
      const questionId = draft.questions.some(
        (question) => question.id === ordinaryId,
      )
        ? hash({
            scope: RECALCULATED_QUESTION_ID_SCOPE,
            lineId: line.id,
            field,
          })
        : ordinaryId;
      if (draft.questions.some((question) => question.id === questionId))
        throw new ImportSessionCorruptStateError("draft_json");
      draft.questions.push({
        id: questionId,
        lineIds: [line.id],
        field,
        text: `Confirme o campo ${field} desta compra antes de continuar.`,
      });
    };
    const hasFieldProvenance = (
      line: ImportSessionDraftLineV1,
      field: ImportSessionDraftQuestionV1["field"],
    ): boolean =>
      draft.fieldProvenance?.some(
        (item) => item.lineId === line.id && item.field === field,
      ) ?? false;
    for (const pending of persistedSelectedQuestions) {
      const line = selected.find(
        (candidate) => candidate.id === pending.lineId,
      );
      if (!line) throw new ImportSessionCorruptStateError("draft_json");
      ask(line, pending.field);
    }
    const projects = new Map<string, Project>();
    const guidedRooms = new Map<
      string,
      { id: string; projectId: string; name: string }
    >();
    const guidedCandidates = new Map<
      string,
      {
        id: string;
        projectId: string;
        titulo: string | null;
        fornecedor: string | null;
        valorTotal: number;
        dataCompra: Date | null;
      }
    >();
    const projectAccess = async (
      id: string,
      module: string,
    ): Promise<Project> => {
      let project = projects.get(id);
      if (!project) {
        const rows = await budget.pages((after, take) =>
          tx.project.findMany({
            where: {
              tenantId: actor.tenantId,
              deletedAt: null,
              AND: [{ id }, cursor(after)],
            },
            orderBy: { id: "asc" },
            take,
          }),
        );
        project = rows[0];
        if (!project) return notFound();
        projects.set(id, project);
      }
      if (
        !userCanAccessProject(actor.role, actor.allowedProjects, id) ||
        !userCanAccessProjectModule(
          actor.role,
          actor.allowedProjectTypes,
          actor.allowedModules,
          project.type,
          module,
        )
      )
        return notFound();
      return project;
    };
    const cards = await budget.pages((after, take) =>
      tx.creditCard.findMany({
        where: {
          tenantId: actor.tenantId,
          projectId: session.ownerProjectId,
          deletedAt: null,
          AND: [{ id: session.cardId }, cursor(after)],
        },
        orderBy: { id: "asc" },
        take,
      }),
    );
    const card = cards[0];
    if (!card) return notFound();
    const sourceProject = await projectAccess(
      session.ownerProjectId,
      CREDIT_CARD_MODULE,
    );
    if (sourceProject.type !== ProjectType.PESSOAL) return notFound();
    await projectAccess(session.ownerProjectId, EXPENSE_MODULE);
    for (const line of selected) {
      for (const target of line.targets ?? []) {
        const project = await projectAccess(target.projectId, EXPENSE_MODULE);
        if (
          project.type !== ProjectType.REFORMA ||
          !hasFeature(ProjectType.REFORMA, "expenses")
        )
          ask(line, "targets");
        if (target.roomId) {
          const rooms = await budget.pages((after, take) =>
            tx.room.findMany({
              where: {
                projectId: project.id,
                deletedAt: null,
                AND: [{ id: target.roomId! }, cursor(after)],
              },
              orderBy: { id: "asc" },
              take,
            }),
          );
          if (rooms.length !== 1) return notFound();
          for (const room of rooms)
            guidedRooms.set(room.id, {
              id: room.id,
              projectId: room.projectId,
              name: room.name,
            });
        }
      }
    }
    const refs = await budget.pages((after, take) =>
      tx.importSessionArtifact.findMany({
        where: {
          tenantId: actor.tenantId,
          ownerProjectId: session.ownerProjectId,
          sessionId: session.id,
          ...cursor(after),
        },
        orderBy: { id: "asc" },
        take,
      }),
    );
    const artifactIds = [
      ...new Set(
        refs.flatMap((ref) => (ref.artifactId ? [ref.artifactId] : [])),
      ),
    ];
    const artifacts: ImportArtifact[] = [];
    for (const ids of chunks(artifactIds))
      artifacts.push(
        ...(await budget.pages((after, take) =>
          tx.importArtifact.findMany({
            where: {
              tenantId: actor.tenantId,
              ownerProjectId: session.ownerProjectId,
              AND: [{ id: { in: ids } }, cursor(after)],
            },
            orderBy: { id: "asc" },
            take,
          }),
        )),
      );
    const observations: ImportObservation[] = [];
    for (const ids of chunks(draft.scope.observationIds))
      observations.push(
        ...(await budget.pages((after, take) =>
          tx.importObservation.findMany({
            where: {
              tenantId: actor.tenantId,
              ownerProjectId: session.ownerProjectId,
              AND: [{ id: { in: ids } }, cursor(after)],
            },
            orderBy: { id: "asc" },
            take,
          }),
        )),
      );
    if (observations.length !== draft.scope.observationIds.length)
      return notFound();
    const documents = new Map(
      observations.map((row) => {
        const ref = refs.find((item) => item.artifactId === row.artifactId);
        const artifact = artifacts.find((item) => item.id === row.artifactId);
        if (!ref || !artifact) return notFound();
        const view = projectImportObservation(session, draft.scope, row, ref);
        const evidence = parseStoredImportObservationEvidence(row.evidenceJson);
        return [row.id, { row, view, evidence, artifact }] as const;
      }),
    );
    const declarations = resolveImportDeclarations(session, draft, {
      observations,
      references: refs.map((ref) => ({
        ref,
        artifact:
          artifacts.find((artifact) => artifact.id === ref.artifactId) ?? null,
      })),
    });
    for (const persisted of persistedSelectedDocumentaryQuestions) {
      const question = declarations.questions.find(
        (candidate) => candidate.id === persisted.id,
      );
      if (!question || !selectedLineIds.has(question.lineIds[0])) continue;
      const existing = draft.questions.find(
        (candidate) => candidate.id === question.id,
      );
      if (existing && canonical(existing) !== canonical(question))
        throw new ImportSessionCorruptStateError("draft_json");
      if (!existing) draft.questions.push(question);
    }
    const identities = selected.flatMap((line) =>
      line.observationIds.map((id) => {
        const document = documents.get(id);
        if (!document) return notFound();
        return {
          id,
          artifactId: document.row.artifactId,
          documentSha256: document.artifact.documentSha256,
          reference: document.row.reference,
          claimVersion: document.row.claimVersion,
        };
      }),
    );
    const selectedIds = new Set(identities.map((identity) => identity.id));
    const cycleReaders = new Map(
      artifacts
        .filter((artifact) =>
          observations.some(
            (observation) =>
              selectedIds.has(observation.id) &&
              observation.artifactId === artifact.id,
          ),
        )
        .map((artifact) => [
          artifact.id,
          createImportObservationCycleReader(
            artifact,
            readStoredImportExtraction(artifact),
          ),
        ]),
    );
    const cycles = new Map(
      [...documents]
        .filter(([id]) => selectedIds.has(id))
        .map(([id, doc]) => {
          const readCycle = cycleReaders.get(doc.artifact.id);
          if (!readCycle)
            throw new ImportSessionCorruptStateError("extraction_json");
          return [id, readCycle(doc.row)] as const;
        }),
    );
    const cycleContext = identities.map(({ id }) => ({
      id,
      cycle: cycles.get(id),
    }));
    const blockers = declarations.reviewBlockers.filter(
      (blocker) =>
        draft.selectedLineIds.includes(blocker.lineId) &&
        blocker.resolution !== "RESOLVED_BY_USER",
    );
    const search: StoredImportSearchV1 = {
      version: IMPORT_SESSION_PROTOCOL_VERSION,
      revision: session.confirmedRevision ?? session.revision + 1,
      complete: false,
      candidates: [],
      coverage: {
        recipe: "CARD_PURCHASE_V1",
        inputHash: hash({
          tenantId: session.tenantId,
          ownerProjectId: session.ownerProjectId,
          cardId: session.cardId,
          selectedLineIds: draft.selectedLineIds,
          lines: selected,
          scope: draft.scope,
          cycles: cycleContext,
          observations: identities.map(
            ({ claimVersion: _, ...identity }) => identity,
          ),
        }),
        steps: selected.flatMap((line) =>
          STAGES.map((stage) => ({
            lineId: line.id,
            stage,
            status: "NOT_RUN" as const,
            predicateHash: null,
            visitedRows: 0 as const,
            endCursor: null,
          })),
        ),
      },
    };
    const certify = (
      lineId: string,
      stage: SearchStage,
      args: unknown,
      visitedRows: number,
    ): void => {
      const index = search.coverage.steps.findIndex(
        (step) => step.lineId === lineId && step.stage === stage,
      );
      search.coverage.steps[index] = {
        lineId,
        stage,
        status: "EXHAUSTED",
        visitedRows,
        endCursor: null,
        predicateHash: hash({
          recipe: search.coverage.recipe,
          lineId,
          stage,
          arguments: args,
        }),
      };
    };
    const candidate = (ref: ImportCandidateRef): void => {
      if (
        !search.candidates.some(
          (item) =>
            item.lineId === ref.lineId &&
            item.kind === ref.kind &&
            item.id === ref.id,
        )
      )
        search.candidates.push(ref);
    };
    const execution: PreparedExecution = {
      actor,
      ownerProjectId: session.ownerProjectId,
      cardId: session.cardId,
      evidence: new Map(),
      kept: new Map(),
    };
    const body: ProposalBody &
      Required<Pick<ProposalBody, "noWriteRows" | "effects">> = {
      version: IMPORT_SESSION_PROTOCOL_VERSION,
      kind: IMPORT_SESSION_KIND,
      sessionId: session.id,
      revision: search.revision,
      lines: [],
      noWriteRows: draft.lines.flatMap<ImportSessionNoWriteRowV1>((line) => {
        switch (line.decision.kind) {
          case "DEFER":
            return [
              {
                lineId: line.id,
                outcome: "DEFERRED" as const,
                reason: "USER_DEFERRED" as const,
                title: line.titulo,
                amountCents: line.amountCents,
              },
            ];
          case "EXCLUDE":
            return [
              {
                lineId: line.id,
                outcome: "EXCLUDED" as const,
                reason: "USER_EXCLUDED" as const,
                title: line.titulo,
                amountCents: line.amountCents,
              },
            ];
          case "IGNORED_POLICY":
            if (line.observationIds.length !== 1)
              throw new ImportSessionCorruptStateError("preparation");
            const document = documents.get(line.observationIds[0]!);
            if (!document)
              throw new ImportSessionCorruptStateError("preparation");
            return [
              {
                lineId: line.id,
                outcome: "IGNORED" as const,
                reason: line.decision.reason,
                title: line.titulo,
                amountCents: document.evidence.amountCents,
              },
            ];
          default:
            return [];
        }
      }),
      effects: {
        personalSourceCreates: 0,
        reformaTargetCreates: 0,
        expenseCreates: 0,
        cashFlowEntryCreates: 0,
        rateioAllocationCreates: 0,
        keptExistingCount: 0,
        deferredCount: 0,
        excludedCount: 0,
        ignoredCount: 0,
      },
      createdEconomicTotalCents: 0,
      bankCashDeltaCents: 0,
      invoiceDeltas: [],
    };
    const linePreflight = new Map(
      selected.map((line) => [line.id, [] as unknown[]]),
    );
    const canonicalIndexes = new Map<string, number | null>();
    const commonVisits = budget.visited;

    // Resolve connected allocations using their canonical participants, never linkedExpenseId.
    const graph = async (ids: readonly string[]) => {
      const seen = new Set<string>();
      const expenses = new Map<string, Expense>();
      const allocations = new Map<string, RateioAllocation>();
      let pending = [...new Set(ids)];
      while (pending.length) {
        for (const part of chunks(pending)) {
          const rows = await budget.pages((after, take) =>
            tx.expense.findMany({
              where: {
                tenantId: actor.tenantId,
                deletedAt: INCLUDE_SOFT_DELETED,
                AND: [{ id: { in: part } }, cursor(after)],
              },
              orderBy: { id: "asc" },
              take,
            }),
          );
          if (rows.length !== part.length) return notFound();
          for (const row of rows) {
            await projectAccess(row.projectId, EXPENSE_MODULE);
            expenses.set(row.id, row);
            if (row.deletedAt === null)
              guidedCandidates.set(row.id, {
                id: row.id,
                projectId: row.projectId,
                titulo: row.titulo,
                fornecedor: row.fornecedor,
                valorTotal: row.valorTotal,
                dataCompra: row.dataCompra,
              });
            seen.add(row.id);
          }
          const edges = await budget.pages((after, take) =>
            tx.rateioAllocation.findMany({
              where: {
                tenantId: actor.tenantId,
                OR: [
                  { sourceExpenseId: { in: part } },
                  { targetExpenseId: { in: part } },
                ],
                ...cursor(after),
              },
              orderBy: { id: "asc" },
              take,
            }),
          );
          for (const edge of edges) allocations.set(edge.id, edge);
        }
        pending = [
          ...new Set(
            [...allocations.values()].flatMap((edge) => [
              edge.sourceExpenseId,
              edge.targetExpenseId,
            ]),
          ),
        ].filter((id) => !seen.has(id));
      }
      return {
        expenses: [...expenses.values()],
        allocations: [...allocations.values()],
      };
    };

    for (const [lineIndex, line] of selected.entries()) {
      const preflight = linePreflight.get(line.id);
      if (!preflight) throw new ImportSessionCorruptStateError("preparation");
      const docs = line.observationIds.map((id) => {
        const document = documents.get(id);
        const resolved = declarations.byLine.get(line.id)?.get(id);
        if (!document || !resolved) return notFound();
        const facts = resolved.effective;
        return {
          ...document,
          resolved,
          facts,
          validAnswers: resolved.validAnswers,
          view: {
            ...document.view,
            amountMeaning: facts.amountMeaning,
            amountCents: facts.amountCents,
            installmentCount: facts.installmentCount,
            installmentIndex: facts.installmentIndex,
            dataCompra: facts.dataCompra,
          },
        };
      });
      let start = budget.visited;
      const claimedExpenseIds = docs.flatMap(({ row }) =>
        row.canonicalExpenseId ? [row.canonicalExpenseId] : [],
      );
      const claimed = await graph(claimedExpenseIds);
      for (const root of claimed.expenses)
        if (!root.deletedAt)
          candidate({
            lineId: line.id,
            kind: "EXPENSE",
            id: root.id,
            reason: "STRONG_IDENTITY",
          });
      for (const { row } of docs) {
        if (row.canonicalReceiptId) {
          const receipts = await budget.pages((after, take) =>
            tx.receipt.findMany({
              where: {
                tenantId: actor.tenantId,
                deletedAt: INCLUDE_SOFT_DELETED,
                AND: [{ id: row.canonicalReceiptId! }, cursor(after)],
              },
              orderBy: { id: "asc" },
              take,
            }),
          );
          const receipt = receipts[0];
          if (!receipt) return notFound();
          await projectAccess(receipt.projectId, RECEIPT_MODULE);
          if (!receipt.deletedAt)
            candidate({
              lineId: line.id,
              kind: "RECEIPT",
              id: receipt.id,
              reason: "STRONG_IDENTITY",
            });
        }
      }
      certify(
        line.id,
        "DOCUMENT_IDENTITY",
        {
          tenantId: actor.tenantId,
          ownerProjectId: session.ownerProjectId,
          sessionId: session.id,
          userId: actor.userId,
          cardId: session.cardId,
          artifactIds,
          targetProjectIds: selected.flatMap((item) =>
            (item.targets ?? []).map((target) => target.projectId),
          ),
          roomIds: selected.flatMap((item) =>
            (item.targets ?? []).flatMap((target) =>
              target.roomId ? [target.roomId] : [],
            ),
          ),
          scope: draft.scope,
          observations: docs.map(({ row, artifact }) => ({
            id: row.id,
            artifactId: row.artifactId,
            documentSha256: artifact.documentSha256,
            reference: row.reference,
          })),
        },
        budget.visited - start + (lineIndex === 0 ? commonVisits : 0),
      );
      preflight.push(
        docs.map(({ row, evidence }) => ({ row, evidence })),
        claimed,
      );
      const keys: DedupeKeys[] = [];
      for (const { resolved } of docs) {
        const key = importObservationDedupeKeys(session, resolved);
        if (key !== null) keys.push(key);
      }
      start = budget.visited;
      let crossRows: Awaited<ReturnType<typeof enumerateDedupeMatches>> | null =
        null;
      if (keys.length === docs.length) {
        crossRows = await enumerateDedupeMatches(
          tx,
          actor.tenantId,
          session.ownerProjectId,
          keys,
          budget.remaining,
        );
        budget.spend(crossRows.visitedRows);
        if (crossRows.kind !== "EXHAUSTED")
          throw new ImportSessionError(ImportSessionErrorCode.SEARCH_TOO_BROAD);
        await graph(
          crossRows.rows
            .filter((row) => row.kind === "EXPENSE")
            .map((row) => row.id),
        );
        for (const row of crossRows.rows) {
          await projectAccess(
            row.projectId,
            row.kind === "EXPENSE" ? EXPENSE_MODULE : RECEIPT_MODULE,
          );
          if (!row.deletedAt)
            candidate({
              lineId: line.id,
              kind: row.kind,
              id: row.id,
              reason: keys.some(
                (key) =>
                  row.externalId === key.externalId ||
                  (!!key.strong && row.dedupeKeyStrong === key.strong),
              )
                ? "STRONG_IDENTITY"
                : "NATURAL_MATCH",
            });
        }
        preflight.push(crossRows.rows);
        certify(
          line.id,
          "CROSS_ORIGIN",
          { tenantId: actor.tenantId, projectId: session.ownerProjectId, keys },
          budget.visited - start,
        );
      }

      start = budget.visited;
      const facts: CardImportFacts = {
        companions: [],
        receipts: [],
        imports: [],
        cards: [],
      };
      const purchases: PurchaseIdentity[] = [];
      let admissionBlocked = false;
      let admissionReview = false;
      if (line.installmentCount !== null && keys.length === docs.length) {
        for (const [index, { facts: effective }] of docs.entries()) {
          const purchase: PurchaseIdentity = {
            cardId: session.cardId,
            projectId: session.ownerProjectId,
            merchant: effective.merchant!,
            total: line.installmentCount,
            seriesKey: null,
            externalId: keys[index]!.externalId,
            dedupeKeyStrong: keys[index]!.strong,
          };
          purchases.push(purchase);
          const result = await inspectCardImportInTx(
            tx,
            actor.tenantId,
            purchase,
            budget.remaining,
          );
          budget.spend(result.visitedRows);
          if (result.kind !== "EXHAUSTED")
            throw new ImportSessionError(
              ImportSessionErrorCode.SEARCH_TOO_BROAD,
            );
          admissionBlocked ||= result.admission.kind === "BLOCKED";
          admissionReview ||= result.admission.kind === "REVIEW";
          facts.companions = unionRows(
            facts.companions,
            result.inspection.companions,
          );
          facts.receipts = unionRows(
            facts.receipts,
            result.inspection.receipts,
          );
          facts.imports = unionRows(facts.imports, result.inspection.imports);
          facts.cards = unionRows(facts.cards, result.inspection.cards);
        }
        const participants = await graph(facts.companions.map((row) => row.id));
        const deletedParticipant = participants.expenses.some(
          (row) => row.deletedAt !== null,
        );
        if (deletedParticipant) ask(line, "decision");
        for (const root of facts.companions)
          if (!root.deletedAt)
            candidate({
              lineId: line.id,
              kind: "EXPENSE",
              id: root.id,
              reason: "INSTALLMENT_MATCH",
            });
        for (const receipt of facts.receipts) {
          await projectAccess(receipt.projectId, RECEIPT_MODULE);
          if (!receipt.deletedAt)
            candidate({
              lineId: line.id,
              kind: "RECEIPT",
              id: receipt.id,
              reason: "STRONG_IDENTITY",
            });
        }
        preflight.push(facts, participants);
        certify(
          line.id,
          "CARD_IDENTITY",
          { tenantId: actor.tenantId, purchases },
          budget.visited - start,
        );
        if (line.decision.kind === "KEEP_EXISTING") {
          if (!hasFieldProvenance(line, "decision")) ask(line, "decision");
          const rootId = line.decision.expenseId;
          const root = facts.companions.find((row) => row.id === rootId);
          const compatibility = purchases.map((purchase) =>
            checkCardImportKeep(
              actor.tenantId,
              purchase,
              facts,
              rootId,
              line,
              docs.map((doc) =>
                doc.row.canonicalExpenseId === rootId &&
                doc.view.installmentIndex === null &&
                isWholePurchaseObservation(doc.facts)
                  ? { ...doc.view, installmentIndex: 1 }
                  : doc.view,
              ),
            ),
          );
          const compatible = compatibility.every(
            (result) => result.kind === "COMPATIBLE",
          );
          if (
            hasFieldProvenance(line, "decision") &&
            compatible &&
            !deletedParticipant &&
            root &&
            line.targets?.length === 0 &&
            !docs.some(
              ({ row }) =>
                row.canonicalReceiptId !== null ||
                (row.canonicalExpenseId !== null &&
                  row.canonicalExpenseId !== rootId),
            )
          ) {
            const stored = parseStoredExpenseSchedule(root.documentedSchedule);
            if (!stored)
              throw new ImportSessionCorruptStateError("preparation");
            const schedule = toPublicExpenseSchedule(stored);
            if (!schedule)
              throw new ImportSessionCorruptStateError("preparation");
            let cycleBlocked = false;
            for (const result of compatibility) {
              if (result.kind !== "COMPATIBLE")
                throw new ImportSessionCorruptStateError("preparation");
              for (const binding of result.bindings) {
                const document = documents.get(binding.observationId);
                if (
                  !document ||
                  !line.observationIds.includes(binding.observationId)
                )
                  throw new ImportSessionCorruptStateError("preparation");
                const effective = declarations.byLine
                  .get(line.id)
                  ?.get(binding.observationId)?.effective;
                if (!effective)
                  throw new ImportSessionCorruptStateError(
                    "declaration_material",
                  );
                const canonicalIndex = isWholePurchaseObservation(effective)
                  ? null
                  : binding.canonicalIndex;
                if (
                  canonicalIndexes.has(binding.observationId) &&
                  canonicalIndexes.get(binding.observationId) !== canonicalIndex
                )
                  throw new ImportSessionCorruptStateError("preparation");
                canonicalIndexes.set(binding.observationId, canonicalIndex);
                const cycle = cycles.get(binding.observationId);
                if (cycle === undefined)
                  throw new ImportSessionCorruptStateError("extraction_cycle");
                if (
                  checkImportObservationCycle(cycle, schedule, canonicalIndex)
                    .kind === "NEEDS_INPUT"
                )
                  cycleBlocked = true;
              }
            }
            if (cycleBlocked) {
              ask(line, "decision");
              continue;
            }
            const allocations = participants.allocations.filter(
              (row) => row.sourceExpenseId === rootId,
            );
            const targets = allocations.map((row) => row.targetExpenseId);
            const cashFlowEntries: CashFlowEntry[] = [];
            for (const ids of chunks([rootId, ...targets])) {
              const cfes = await budget.pages((after, take) =>
                tx.cashFlowEntry.findMany({
                  where: {
                    tenantId: actor.tenantId,
                    deletedAt: null,
                    expenseId: { in: ids },
                    ...cursor(after),
                  },
                  orderBy: { id: "asc" },
                  take,
                }),
              );
              cashFlowEntries.push(...cfes);
            }
            preflight.push({ lineId: line.id, cashFlowEntries });
            certify(
              line.id,
              "CARD_IDENTITY",
              { tenantId: actor.tenantId, purchases },
              budget.visited - start,
            );
            body.lines.push({
              kind: "KEEP_EXISTING",
              lineId: line.id,
              sourceExpenseId: root.id,
              totalCents: root.valorTotal,
              schedule,
            });
            draft.questions = draft.questions.filter(
              (question) => !question.lineIds.includes(line.id),
            );
            execution.kept.set(line.id, {
              lineId: line.id,
              outcome: "KEPT_EXISTING",
              sourceExpenseId: root.id,
              targetExpenseIds: targets,
              allocationIds: allocations.map((row) => row.id),
              cashFlowEntryIds: cashFlowEntries.map((row) => row.id),
            });
          } else if (!blockers.some((blocker) => blocker.lineId === line.id))
            ask(line, "decision");
          continue;
        }
      }
      if (
        line.decision.kind === "UNRESOLVED" ||
        (line.decision.kind !== "CREATE" &&
          !blockers.some((blocker) => blocker.lineId === line.id))
      )
        ask(line, "decision");
      if (line.amountMeaning !== ImportSessionAmountMeaning.TOTAL_PURCHASE)
        ask(line, "amountMeaning");
      if (line.amountCents === null || line.amountCents <= 0)
        ask(line, "amountCents");
      if (line.installmentCount === null) ask(line, "installmentCount");
      if (line.dataCompra === null) ask(line, "dataCompra");
      if (
        line.firstDueDate === null ||
        card.closingDay === null ||
        card.dueDay === null
      )
        ask(line, "firstDueDate");
      if (
        line.decision.kind === "CREATE" &&
        !hasFieldProvenance(line, "decision")
      )
        ask(line, "decision");
      if (
        line.decision.kind === "CREATE" &&
        !hasFieldProvenance(line, "targets")
      )
        ask(line, "targets");
      const effectiveProjectType =
        line.targets?.length === 0
          ? ProjectType.PESSOAL
          : line.targets?.length === 1
            ? ProjectType.REFORMA
            : null;
      if (
        line.tipoDespesa === null ||
        (effectiveProjectType !== null &&
          !getExpenseTypesForProject(effectiveProjectType).includes(
            line.tipoDespesa,
          ))
      )
        ask(line, "tipoDespesa");
      if (
        line.decision.kind === "CREATE" &&
        !hasFieldProvenance(line, "tipoDespesa")
      )
        ask(line, "tipoDespesa");
      if (
        line.tipoDespesa === ExpenseType.MAO_DE_OBRA &&
        line.categoriaMaoDeObra === null
      )
        ask(line, "categoriaMaoDeObra");
      if (
        line.decision.kind === "CREATE" &&
        line.tipoDespesa === ExpenseType.MAO_DE_OBRA &&
        !hasFieldProvenance(line, "categoriaMaoDeObra")
      )
        ask(line, "categoriaMaoDeObra");
      if (
        line.targets === null ||
        line.targets.length > 1 ||
        line.targets.some((target) => target.amountCents !== line.amountCents)
      )
        ask(line, "targets");
      const strongMatch =
        crossRows?.kind === "EXHAUSTED" &&
        crossRows.rows.some(
          (row) =>
            row.deletedAt !== null ||
            keys.some(
              (key) =>
                row.externalId === key.externalId ||
                (!!key.strong && key.strong === row.dedupeKeyStrong),
            ),
        );
      if (
        docs.some(
          ({ row }) =>
            row.canonicalExpenseId !== null || row.canonicalReceiptId !== null,
        ) ||
        strongMatch ||
        admissionBlocked ||
        (line.decision.kind === "CREATE" &&
          !line.decision.acceptNaturalDuplicate &&
          (admissionReview ||
            (crossRows?.kind === "EXHAUSTED" && crossRows.rows.length > 0)))
      )
        ask(line, "decision");
      if (
        line.dataCompra &&
        line.firstDueDate &&
        card.closingDay !== null &&
        card.dueDay !== null &&
        (line.firstDueDate < line.dataCompra ||
          caixaDateForCardPurchase(
            line.dataCompra,
            card.closingDay,
            card.dueDay,
            line.firstDueDate.slice(0, 7),
          )
            .toISOString()
            .slice(0, 10) !== line.firstDueDate)
      )
        ask(line, "firstDueDate");
      if (
        draft.questions.some((q) => q.lineIds.includes(line.id)) ||
        line.amountCents === null ||
        line.installmentCount === null ||
        line.firstDueDate === null ||
        line.dataCompra === null ||
        line.tipoDespesa === null ||
        line.targets === null
      )
        continue;
      const occurrences = buildInstallments({
        valorTotal: line.amountCents,
        formaPagamento: PaymentForm.PARCELADO,
        quantidadeParcela: line.installmentCount,
        dataInicioParcela: new Date(`${line.firstDueDate}T00:00:00.000Z`),
      }).map((item) => {
        const invoiceDueMonth = addMonthsToMonthKey(
          line.firstDueDate!.slice(0, 7),
          item.index,
        );
        return {
          ...item,
          data: caixaDateForCardPurchase(
            line.dataCompra!,
            card.closingDay,
            card.dueDay,
            invoiceDueMonth,
          )
            .toISOString()
            .slice(0, 10),
          invoiceDueMonth,
        };
      });
      const schedule = { version: 1 as const, occurrences };
      const proposedInstallments = buildInstallments({
        valorTotal: line.amountCents,
        formaPagamento: PaymentForm.PARCELADO,
        quantidadeParcela: line.installmentCount,
        schedule,
      });
      for (const { row, facts } of docs) {
        if (isWholePurchaseObservation(facts)) {
          const cycle = cycles.get(row.id);
          if (cycle === undefined)
            throw new ImportSessionCorruptStateError("extraction_cycle");
          const checked = checkImportObservationCycle(cycle, schedule, null);
          if (checked.kind === "NEEDS_INPUT") {
            ask(
              line,
              checked.reason === "MISMATCH" ? "firstDueDate" : "decision",
            );
            continue;
          }
          canonicalIndexes.set(row.id, null);
          continue;
        }
        if (hasIncompleteCreateOccurrence(facts)) continue;
        if (facts.installmentCount !== line.installmentCount) {
          ask(line, "decision");
          continue;
        }
        let index: number;
        try {
          index = resolveInstallmentIndex(
            proposedInstallments,
            facts.installmentIndex === null
              ? null
              : `${facts.installmentIndex}/${facts.installmentCount}`,
          );
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
          ask(line, "decision");
          continue;
        }
        const occurrence = schedule.occurrences.find(
          (item) => item.index === index,
        );
        if (
          !occurrence ||
          facts.amountCents !==
            (facts.amountMeaning === ImportSessionAmountMeaning.TOTAL_PURCHASE
              ? line.amountCents
              : occurrence.valor)
        ) {
          ask(line, "decision");
          continue;
        }
        canonicalIndexes.set(row.id, index);
        const cycle = cycles.get(row.id);
        if (cycle === undefined)
          throw new ImportSessionCorruptStateError("extraction_cycle");
        const checked = checkImportObservationCycle(cycle, schedule, index);
        if (checked.kind === "NEEDS_INPUT")
          ask(
            line,
            checked.reason === "MISMATCH" ? "firstDueDate" : "decision",
          );
      }
      if (
        blockers.some((blocker) => blocker.lineId === line.id) ||
        draft.questions.some((question) => question.lineIds.includes(line.id))
      )
        continue;
      body.lines.push({
        kind: "CREATE",
        lineId: line.id,
        titulo: line.titulo,
        fornecedor: line.fornecedor,
        tipoDespesa: line.tipoDespesa,
        categoriaMaoDeObra: line.categoriaMaoDeObra,
        dataCompra: line.dataCompra,
        totalCents: line.amountCents,
        schedule,
        targets: line.targets.map((target) => ({ ...target, schedule })),
      });
      body.createdEconomicTotalCents += line.amountCents;
      for (const occurrence of occurrences) {
        const delta = body.invoiceDeltas.find(
          (item) => item.invoiceDueMonth === occurrence.invoiceDueMonth,
        );
        if (delta) delta.amountCents += occurrence.valor;
        else
          body.invoiceDeltas.push({
            invoiceDueMonth: occurrence.invoiceDueMonth,
            amountCents: occurrence.valor,
          });
      }
      const ordered = [...docs].sort((a, b) =>
        a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0,
      );
      const support = ordered.flatMap((doc) =>
        doc.validAnswers.filter(
          (answer) =>
            !isWholePurchaseObservation(doc.facts) ||
            (answer.field !== "installmentCount" &&
              answer.field !== "installmentIndex"),
        ),
      );
      const reference = {
        documentSha256: ordered[0]!.artifact.documentSha256,
        reference: ordered[0]!.row.reference,
      };
      execution.evidence.set(
        line.id,
        support.length === 0
          ? { ...reference, kind: "DOCUMENT" }
          : {
              ...reference,
              kind: "HUMAN_SUPPORTED",
              attestedByUserId: session.ownerUserId,
              confirmedAt: session.confirmedAt,
              supportDigest: hash({
                originals: ordered.map((doc) => ({
                  observationId: doc.row.id,
                  documentSha256: doc.artifact.documentSha256,
                  reference: doc.row.reference,
                  evidence: doc.evidence,
                })),
                declarations: support,
              }),
            },
      );
    }
    const readiness = selectServerReadyLines(
      draft,
      body.lines.map((line) => line.lineId),
    );
    search.complete =
      (selected.length > 0 &&
        search.coverage.steps.every((step) => step.status === "EXHAUSTED")) ||
      (selected.length === 0 &&
        body.noWriteRows.length === draft.lines.length &&
        body.noWriteRows.length > 0);
    if (purpose === PreparationPurpose.ANSWER_PENDING)
      return { kind: "NEEDS_INPUT", draft, search };
    if (readiness.readyLineIds.length === 0)
      return { kind: "NEEDS_INPUT", draft, search };
    const readyLineIds = new Set(readiness.readyLineIds);
    draft.selectedLineIds = readiness.readyLineIds;
    search.coverage.steps = search.coverage.steps.filter((step) =>
      readyLineIds.has(step.lineId),
    );
    search.candidates = search.candidates.filter((candidate) =>
      readyLineIds.has(candidate.lineId),
    );
    search.complete =
      search.coverage.steps.length === readyLineIds.size * STAGES.length &&
      search.coverage.steps.every((step) => step.status === "EXHAUSTED");
    if (
      !search.complete ||
      body.lines.length !== readyLineIds.size ||
      draft.questions.some((q) => q.lineIds.some((id) => readyLineIds.has(id)))
    )
      return { kind: "NEEDS_INPUT", draft, search };
    body.noWriteRows = body.noWriteRows.filter(
      (row) => row.outcome !== "DEFERRED",
    );
    const guidedAuthority = await buildGuidedReviewAuthority(
      tx,
      actor,
      session.ownerProjectId,
      draft,
      search,
      search.revision,
      true,
      {
        projects: [...projects.values()].map((project) => ({
          id: project.id,
          type: project.type,
          name: project.name,
        })),
        rooms: [...guidedRooms.values()],
        duplicateCandidates: search.candidates.map((candidate) => ({
          id: candidate.id,
          kind: candidate.kind,
        })),
        candidates: [...guidedCandidates.values()],
      },
    );
    for (const lineId of readiness.readyLineIds)
      guidedAuthority.assertReadyLine(lineId);
    body.invoiceDeltas.sort((a, b) =>
      a.invoiceDueMonth.localeCompare(b.invoiceDueMonth),
    );
    body.effects = deriveImportSessionEffects(body.lines, body.noWriteRows);
    const plan = buildImportPreparationPlan({
      session,
      draft,
      proposalBody: body,
      observations,
      references: refs.map((ref) => ({
        ref,
        artifact: artifacts.find((item) => item.id === ref.artifactId) ?? null,
      })),
    });
    const selectedObservations = identities.flatMap((identity) => {
      const line = selected.find(
        (item) =>
          readyLineIds.has(item.id) &&
          item.observationIds.includes(identity.id),
      );
      if (!line) return [];
      const canonicalIndex = canonicalIndexes.get(identity.id);
      if (canonicalIndex === undefined)
        throw new ImportSessionCorruptStateError("preparation");
      return [{ ...identity, lineId: line.id, canonicalIndex }];
    });
    const readyObservationIds = new Set(
      selected
        .filter((line) => readyLineIds.has(line.id))
        .flatMap((line) => line.observationIds),
    );
    const preflight: unknown[] = [
      card,
      identities.filter((identity) => readyObservationIds.has(identity.id)),
      actor,
      { financialPreparation: financialPreparationBindingOf(draft, refs) },
      ...draft.selectedLineIds.flatMap(
        (lineId) => linePreflight.get(lineId) ?? [],
      ),
    ];
    preflight.push(
      cycleContext.filter(({ id }) => readyObservationIds.has(id)),
      selectedObservations
        .map(({ id, lineId, canonicalIndex, claimVersion }) => ({
          id,
          lineId,
          canonicalIndex,
          claimVersion,
        }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    );
    const batch = mintPreparedCardBatch(tx, auth, session, {
      proposal: plan.proposal,
      preflightHash: hash(preflight),
      observations: selectedObservations,
      expandedCounts: plan.expandedCounts,
    });
    this.executions.set(batch, execution);
    return {
      kind: "READY",
      draft,
      search: { ...search, complete: true },
      batch,
    };
  }

  async applyInTx(
    tx: Prisma.TransactionClient,
    auth: AuthenticatedImportContext,
    batch: PreparedCardBatch,
  ): Promise<ImportSessionReceiptV1["items"]> {
    consumePreparedCardBatch(tx, auth, batch);
    const execution = this.executions.get(batch);
    if (!execution) throw new Error("Invalid import execution handle");
    this.executions.delete(batch);
    const requester = { ...execution.actor, id: execution.actor.userId };
    const items: ImportSessionReceiptV1["items"] = [];
    for (const line of batch.proposal.lines) {
      if (line.kind === "KEEP_EXISTING") {
        const item = execution.kept.get(line.lineId);
        if (!item) throw new Error("Invalid import execution handle");
        items.push(structuredClone(item));
        continue;
      }
      const evidence = execution.evidence.get(line.lineId);
      if (!evidence) throw new Error("Invalid import execution handle");
      const reference = {
        documentSha256: evidence.documentSha256,
        reference: evidence.reference,
      };
      let scheduleEvidence: ScheduleEvidenceInput = reference;
      if (evidence.kind === "HUMAN_SUPPORTED") {
        if (
          evidence.confirmedAt === null ||
          execution.actor.userId !== evidence.attestedByUserId
        )
          throw new ImportSessionCorruptStateError("confirmation");
        scheduleEvidence = {
          ...reference,
          evidenceKind: EVIDENCE_KIND.USER_ATTESTATION,
          attestedByUserId: evidence.attestedByUserId,
          attestedAt: evidence.confirmedAt.toISOString(),
        };
      }
      const source = await this.expenses.createPlannedCardPurchaseInTx(
        tx,
        auth.tenantId,
        execution.ownerProjectId,
        {
          titulo: line.titulo,
          fornecedor: line.fornecedor,
          tipoDespesa: line.tipoDespesa,
          categoriaMaoDeObra: line.categoriaMaoDeObra,
          dataCompra: line.dataCompra,
          totalCents: line.totalCents,
          schedule: line.schedule,
          cardId: execution.cardId,
          evidence: scheduleEvidence,
          reason:
            evidence.kind === "DOCUMENT"
              ? "Compra documentada confirmada na importacao assistida."
              : `Compra com suporte documental e informacoes humanas confirmadas na importacao assistida. SHA-256 ${evidence.supportDigest}`,
        },
        auth.userId,
        requester,
      );
      const targetExpenseIds =
        line.targets.length === 0
          ? []
          : (
              await createRateioTargets(
                tx,
                this.conciliacao,
                auth.tenantId,
                source,
                {
                  existing: [],
                  newTargets: line.targets.map((target) => ({
                    targetProjectId: target.projectId,
                    roomId: target.roomId ?? undefined,
                    tipoDespesa: line.tipoDespesa,
                    categoriaMaoDeObra: line.categoriaMaoDeObra ?? undefined,
                    titulo: line.titulo,
                    fornecedor: line.fornecedor ?? undefined,
                    valor: target.amountCents / 100,
                    quantidade: 1,
                    allocation: target.amountCents,
                    status: ExpenseStatus.PLANEJADO,
                  })),
                },
                auth.userId,
                requester,
              )
            ).createdTargetIds;
      const allocations = await tx.rateioAllocation.findMany({
        where: { tenantId: auth.tenantId, sourceExpenseId: source.id },
        select: { id: true },
        orderBy: { id: "asc" },
        take: LIMITS.targetsPerPurchase,
      });
      const cfes = await tx.cashFlowEntry.findMany({
        where: {
          tenantId: auth.tenantId,
          expenseId: { in: [source.id, ...targetExpenseIds] },
          deletedAt: null,
        },
        select: { id: true },
        orderBy: { id: "asc" },
        take: LIMITS.expandedCFEsPerBatch + 1,
      });
      if (
        cfes.length !==
          line.schedule.occurrences.length * (1 + targetExpenseIds.length) ||
        allocations.length !== targetExpenseIds.length
      )
        throw new Error(
          "Native card purchase effects do not match the prepared batch",
        );
      items.push({
        lineId: line.lineId,
        outcome: "CREATED",
        sourceExpenseId: source.id,
        targetExpenseIds,
        allocationIds: allocations.map((row) => row.id),
        cashFlowEntryIds: cfes.map((row) => row.id),
      });
    }
    return items;
  }
}
