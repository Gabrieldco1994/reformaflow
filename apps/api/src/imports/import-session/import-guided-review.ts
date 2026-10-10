import type { Prisma } from "@prisma/client";
import {
  CARD_IMPORT_IGNORED_REASON,
  ExpenseType,
  ExpenseTypeLabels,
  LaborCategory,
  LaborCategoryLabels,
  ProjectType,
  getExpenseTypesForProject,
  IMPORT_SESSION_LIMITS,
  ImportSessionErrorCode,
  type ImportSessionDraftFieldOriginV1,
  type ImportSessionDraftFieldV1,
  type ImportSessionGuidedControlV1,
  type ImportSessionGuidedFocusV1,
  type ImportSessionGuidedOptionV1,
  type ImportSessionGuidedProgressV1,
  type ImportSessionGuidedReviewV1,
  type ImportSessionStoredDraftV1,
  type ImportTypedDraftAnswerV1,
} from "@reformaflow/domain";
import {
  EXPENSE_MODULE,
  userCanAccessProject,
  userCanAccessProjectModule,
} from "../../common/access-rules";
import { canonical } from "../../common/canonical";
import type { ImportActor } from "./import-session.auth";
import type { StoredImportSearchV1 } from "./card-purchase-batch.port";
import { ImportSessionError } from "./import-session.errors";

type Tx = Prisma.TransactionClient;
type GuidedAnswer = ImportSessionGuidedOptionV1["answer"];
type GuidedQuestion = {
  id: string;
  lineIds: string[];
  field: ImportSessionDraftFieldV1;
  text: string;
};

const CONTROL_BY_FIELD: Partial<
  Record<ImportSessionDraftFieldV1, ImportSessionGuidedControlV1>
> = {
  decision: "DECISION",
  targets: "TARGETS",
  tipoDespesa: "EXPENSE_TYPE",
  categoriaMaoDeObra: "LABOR_CATEGORY",
};
const CONTROL_ORDER: readonly ImportSessionGuidedControlV1[] = [
  "DECISION",
  "TARGETS",
  "EXPENSE_TYPE",
  "LABOR_CATEGORY",
];
const SOURCE_ONLY_LABEL_PREFIX = "Somente em";
const DRAFT_FIELDS = [
  "amountMeaning",
  "amountCents",
  "installmentCount",
  "dataCompra",
  "firstDueDate",
  "targets",
  "decision",
  "tipoDespesa",
  "categoriaMaoDeObra",
] as const satisfies readonly ImportSessionDraftFieldV1[];
const invalid = (): never => {
  throw new ImportSessionError(ImportSessionErrorCode.INVALID_INPUT);
};

function canUseProject(
  actor: ImportActor,
  project: { id: string; type: string },
): boolean {
  return (
    userCanAccessProject(actor.role, actor.allowedProjects, project.id) &&
    userCanAccessProjectModule(
      actor.role,
      actor.allowedProjectTypes,
      actor.allowedModules,
      project.type,
      EXPENSE_MODULE,
    )
  );
}

function controlFor(
  question: GuidedQuestion,
): ImportSessionGuidedControlV1 | null {
  return CONTROL_BY_FIELD[question.field] ?? null;
}

export function isGuidedReviewField(
  field: string,
): field is ImportSessionDraftFieldV1 {
  return Object.prototype.hasOwnProperty.call(CONTROL_BY_FIELD, field);
}

export function isDraftProvenanceField(
  field: string,
): field is ImportSessionDraftFieldV1 {
  return (DRAFT_FIELDS as readonly string[]).includes(field);
}

export function hasDraftFieldValue(
  line: ImportSessionStoredDraftV1["lines"][number],
  field: ImportSessionDraftFieldV1,
): boolean {
  if (field === "amountMeaning") return line.amountMeaning !== "UNKNOWN";
  if (field === "decision") return line.decision.kind !== "UNRESOLVED";
  return line[field] !== null;
}

function answerKey(answer: GuidedAnswer): string {
  return canonical(answer);
}

function expenseCandidateLabel(candidate: {
  titulo: string | null;
  fornecedor: string | null;
  valorTotal: number;
  dataCompra: Date | null;
}): string {
  const title =
    candidate.titulo?.trim() ||
    candidate.fornecedor?.trim() ||
    "Compra existente";
  const date =
    candidate.dataCompra?.toISOString().slice(0, 10) ?? "data não informada";
  const amount = (candidate.valorTotal / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
  return `${title} · ${date} · ${amount}`;
}

function disambiguatedLabels<T extends { id: string }>(
  values: readonly T[],
  base: (value: T) => string,
  scope: (value: T) => string = () => "",
): Map<string, string> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = canonical([scope(value), base(value)]);
    groups.set(key, [...(groups.get(key) ?? []), value]);
  }
  const labels = new Map<string, string>();
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    for (const [index, value] of ordered.entries())
      labels.set(
        value.id,
        ordered.length === 1 ? base(value) : `${base(value)} (${index + 1})`,
      );
  }
  return labels;
}

export interface GuidedReviewAuthority {
  readonly review: ImportSessionGuidedReviewV1;
  assertAnswer(
    questionId: string,
    answer: ImportTypedDraftAnswerV1,
  ): Promise<void>;
  assertReadyLine(lineId: string): void;
}

export interface GuidedReviewCatalog {
  projects: Array<{ id: string; type: string; name: string }>;
  rooms: Array<{ id: string; projectId: string; name: string }>;
  duplicateCandidates: Array<{ id: string; kind: "EXPENSE" | "RECEIPT" }>;
  candidates: Array<{
    id: string;
    projectId: string;
    titulo: string | null;
    fornecedor: string | null;
    valorTotal: number;
    dataCompra: Date | null;
  }>;
}

/**
 * Builds the public options and the write allowlist from the same transaction
 * snapshot. Callers must discard this object at the end of that transaction.
 */
export async function buildGuidedReviewAuthority(
  tx: Tx,
  actor: ImportActor,
  ownerProjectId: string,
  draft: ImportSessionStoredDraftV1,
  search: StoredImportSearchV1 | null,
  revision: number,
  proposalReady: boolean,
  catalog?: GuidedReviewCatalog,
  proposalHasRemaining = false,
): Promise<GuidedReviewAuthority> {
  const projects =
    catalog?.projects ??
    (await tx.project.findMany({
      where: {
        tenantId: actor.tenantId,
        deletedAt: null,
        OR: [
          { id: ownerProjectId, type: ProjectType.PESSOAL },
          { type: ProjectType.REFORMA },
        ],
      },
      select: { id: true, type: true, name: true },
      orderBy: { id: "asc" },
      take: IMPORT_SESSION_LIMITS.matchingRowsVisitedPerPreparation,
    }));
  const authorizedProjects = projects.filter((project) =>
    canUseProject(actor, project),
  );
  const owner = authorizedProjects.find(
    (project) =>
      project.id === ownerProjectId && project.type === ProjectType.PESSOAL,
  );
  if (!owner) return invalid();
  const reformaProjects = authorizedProjects.filter(
    (project) => project.type === ProjectType.REFORMA,
  );
  const rooms = catalog
    ? catalog.rooms
    : reformaProjects.length === 0
      ? []
      : await tx.room.findMany({
          where: {
            projectId: { in: reformaProjects.map((project) => project.id) },
            deletedAt: null,
          },
          select: { id: true, projectId: true, name: true },
          orderBy: [{ projectId: "asc" }, { id: "asc" }],
          take: IMPORT_SESSION_LIMITS.matchingRowsVisitedPerPreparation,
        });

  const hasCompleteSearch = search?.complete === true;
  const candidateRefs = hasCompleteSearch ? search.candidates : [];
  const expenseRefs = candidateRefs.filter(
    (candidate) => candidate.kind === "EXPENSE",
  );
  const candidates = catalog
    ? catalog.candidates
    : expenseRefs.length === 0
      ? []
      : await tx.expense.findMany({
          where: {
            id: { in: expenseRefs.map((candidate) => candidate.id) },
            tenantId: actor.tenantId,
            deletedAt: null,
          },
          select: {
            id: true,
            projectId: true,
            titulo: true,
            fornecedor: true,
            valorTotal: true,
            dataCompra: true,
          },
          orderBy: { id: "asc" },
          take: IMPORT_SESSION_LIMITS.matchingRowsVisitedPerPreparation,
        });
  const visibleCandidates = candidates.filter((candidate) =>
    authorizedProjects.some((project) => project.id === candidate.projectId),
  );
  const visibleSourceCandidates = visibleCandidates.filter(
    (candidate) => candidate.projectId === ownerProjectId,
  );
  const projectLabels = disambiguatedLabels(
    reformaProjects,
    (project) => project.name,
  );
  const roomLabels = disambiguatedLabels(
    rooms,
    (room) => room.name,
    (room) => room.projectId,
  );
  const candidateLabels = disambiguatedLabels(
    visibleSourceCandidates,
    expenseCandidateLabel,
  );
  const receiptRefs = candidateRefs.filter(
    (candidate) => candidate.kind === "RECEIPT",
  );
  const receipts = catalog
    ? []
    : receiptRefs.length === 0
      ? []
      : await tx.receipt.findMany({
          where: {
            id: { in: receiptRefs.map((candidate) => candidate.id) },
            tenantId: actor.tenantId,
            deletedAt: null,
          },
          select: { id: true, projectId: true },
          orderBy: { id: "asc" },
          take: IMPORT_SESSION_LIMITS.matchingRowsVisitedPerPreparation,
        });
  const visibleDuplicateCandidates = catalog?.duplicateCandidates ?? [
    ...visibleCandidates.map((candidate) => ({
      id: candidate.id,
      kind: "EXPENSE" as const,
    })),
    ...receipts
      .filter((receipt) =>
        authorizedProjects.some((project) => project.id === receipt.projectId),
      )
      .map((receipt) => ({
        id: receipt.id,
        kind: "RECEIPT" as const,
      })),
  ];
  const isVisibleRef = (candidate: (typeof candidateRefs)[number]): boolean =>
    visibleDuplicateCandidates.some(
      (visible) =>
        visible.id === candidate.id && visible.kind === candidate.kind,
    );
  const guidedPurchaseLines = draft.lines.filter(
    (line) =>
      line.decision.kind !== "IGNORED_POLICY" ||
      line.decision.reason !== CARD_IMPORT_IGNORED_REASON.INVOICE_PAYMENT,
  );
  const linePosition = new Map(
    guidedPurchaseLines.map((line, index) => [line.id, index]),
  );
  const selectedLineIds = new Set(draft.selectedLineIds);
  const hasPendingDocumentary = draft.questions.some(
    (question) =>
      "subject" in question &&
      question.answerState === "UNANSWERED" &&
      question.lineIds.some((lineId) => selectedLineIds.has(lineId)),
  );
  const guidedQuestions = draft.questions
    .flatMap((question) => {
      if ("subject" in question) return [];
      const selectedQuestion: GuidedQuestion = {
        ...question,
        lineIds: question.lineIds.filter((lineId) =>
          selectedLineIds.has(lineId),
        ),
      };
      const control = controlFor(question);
      if (
        selectedQuestion.lineIds.length === 0 ||
        control === null ||
        (control === "LABOR_CATEGORY" &&
          !selectedQuestion.lineIds.some(
            (lineId) =>
              draft.lines.find((line) => line.id === lineId)?.tipoDespesa ===
              ExpenseType.MAO_DE_OBRA,
          ))
      )
        return [];
      return [{ question: selectedQuestion, control }];
    })
    .sort((left, right) => {
      const leftLine = Math.min(
        ...left.question.lineIds.map(
          (lineId) => linePosition.get(lineId) ?? Number.MAX_SAFE_INTEGER,
        ),
      );
      const rightLine = Math.min(
        ...right.question.lineIds.map(
          (lineId) => linePosition.get(lineId) ?? Number.MAX_SAFE_INTEGER,
        ),
      );
      return (
        leftLine - rightLine ||
        CONTROL_ORDER.indexOf(left.control) -
          CONTROL_ORDER.indexOf(right.control) ||
        left.question.id.localeCompare(right.question.id)
      );
    });

  const optionsFor = (
    question: GuidedQuestion,
    control: ImportSessionGuidedControlV1,
  ): ImportSessionGuidedOptionV1[] => {
    const lineId = question.lineIds[0];
    const line = draft.lines.find((candidate) => candidate.id === lineId);
    if (!line || question.lineIds.length !== 1) return [];
    switch (control) {
      case "DECISION": {
        if (!hasCompleteSearch) return [];
        const lineRefs = candidateRefs.filter(
          (candidate) => candidate.lineId === line.id,
        );
        const acceptsNaturalDuplicate = lineRefs.some(
          (candidate) =>
            candidate.reason === "NATURAL_MATCH" && isVisibleRef(candidate),
        );
        const hasBlockingIdentity = lineRefs.some(
          (candidate) =>
            candidate.reason !== "NATURAL_MATCH" && isVisibleRef(candidate),
        );
        const options: ImportSessionGuidedOptionV1[] = hasBlockingIdentity
          ? []
          : [
              {
                label: acceptsNaturalDuplicate
                  ? "Criar mesmo assim"
                  : "Criar nova compra",
                answer: {
                  kind: "DECISION",
                  value: {
                    kind: "CREATE",
                    acceptNaturalDuplicate: acceptsNaturalDuplicate,
                  },
                },
              },
            ];
        for (const ref of lineRefs) {
          const expense = visibleSourceCandidates.find(
            (candidate) => candidate.id === ref.id,
          );
          if (!expense) continue;
          options.push({
            label: `Manter ${candidateLabels.get(expense.id)}`,
            answer: {
              kind: "DECISION",
              value: { kind: "KEEP_EXISTING", expenseId: expense.id },
            },
          });
        }
        options.push({
          label: "Não importar esta compra",
          answer: { kind: "DECISION", value: { kind: "EXCLUDE" } },
        });
        return options;
      }
      case "TARGETS": {
        const options: ImportSessionGuidedOptionV1[] = [
          {
            label: `${SOURCE_ONLY_LABEL_PREFIX} ${owner.name}`,
            answer: { kind: "TARGETS", value: [] },
          },
        ];
        if (
          line.amountCents === null ||
          !Number.isInteger(line.amountCents) ||
          line.amountCents <= 0
        )
          return options;
        for (const project of reformaProjects) {
          const projectLabel = projectLabels.get(project.id) ?? project.name;
          options.push({
            label: projectLabel,
            answer: {
              kind: "TARGETS",
              value: [
                {
                  projectId: project.id,
                  roomId: null,
                  amountCents: line.amountCents,
                },
              ],
            },
          });
          for (const room of rooms.filter(
            (candidate) => candidate.projectId === project.id,
          )) {
            options.push({
              label: `${projectLabel} · ${
                roomLabels.get(room.id) ?? room.name
              }`,
              answer: {
                kind: "TARGETS",
                value: [
                  {
                    projectId: project.id,
                    roomId: room.id,
                    amountCents: line.amountCents,
                  },
                ],
              },
            });
          }
        }
        return options;
      }
      case "EXPENSE_TYPE": {
        const projectType =
          line.targets?.length === 1
            ? ProjectType.REFORMA
            : ProjectType.PESSOAL;
        return getExpenseTypesForProject(projectType).map((type) => ({
          label: ExpenseTypeLabels[type],
          answer: { kind: "EXPENSE_TYPE", value: type },
        }));
      }
      case "LABOR_CATEGORY":
        if (line.tipoDespesa !== ExpenseType.MAO_DE_OBRA) return [];
        return Object.values(LaborCategory).map((category) => ({
          label: LaborCategoryLabels[category],
          answer: { kind: "LABOR_CATEGORY", value: category },
        }));
    }
  };

  const byQuestion = new Map(
    guidedQuestions.map(({ question, control }) => [
      question.id,
      optionsFor(question, control),
    ]),
  );
  const focused = hasPendingDocumentary ? undefined : guidedQuestions[0];
  const waitingForDecisionSearch =
    focused?.control === "DECISION" && !hasCompleteSearch;
  const hasPending =
    hasPendingDocumentary ||
    proposalHasRemaining ||
    guidedQuestions.length > 0 ||
    draft.scope.pendingAttachmentIds.length > 0 ||
    draft.lines.some(
      (line) =>
        !selectedLineIds.has(line.id) &&
        line.decision.kind !== "EXCLUDE" &&
        line.decision.kind !== "IGNORED_POLICY",
    );
  const progress: ImportSessionGuidedProgressV1 = waitingForDecisionSearch
    ? "ANSWERING"
    : proposalReady
      ? hasPending
        ? "READY_WITH_PENDING"
        : "READY"
      : "ANSWERING";
  const focusedLine = focused
    ? draft.lines.find((line) => line.id === focused.question.lineIds[0])
    : null;
  let focus: ImportSessionGuidedFocusV1 | null = null;
  if (
    focused &&
    focusedLine &&
    (focused.control !== "DECISION" || hasCompleteSearch)
  ) {
    const lineQuestions = guidedQuestions.filter(({ question }) =>
      question.lineIds.includes(focusedLine.id),
    );
    const pendingFields = new Set(
      lineQuestions.map(({ question }) => question.field),
    );
    const answeredQuestionCount = new Set(
      (draft.fieldProvenance ?? [])
        .filter(
          (item) =>
            item.lineId === focusedLine.id &&
            isGuidedReviewField(item.field) &&
            !pendingFields.has(item.field),
        )
        .map((item) => item.field),
    ).size;
    const pendingQuestionIndex = lineQuestions.findIndex(
      ({ question }) => question.id === focused.question.id,
    );
    const purchaseIndex = linePosition.get(focusedLine.id);
    if (purchaseIndex === undefined || pendingQuestionIndex < 0)
      return invalid();
    const base = {
      questionId: focused.question.id,
      lineId: focusedLine.id,
      prompt: focused.question.text,
      purchaseOrdinal: purchaseIndex + 1,
      purchaseTotal: guidedPurchaseLines.length,
      questionOrdinal: answeredQuestionCount + pendingQuestionIndex + 1,
      questionTotal: answeredQuestionCount + lineQuestions.length,
      context: {
        title: focusedLine.titulo,
        merchant: focusedLine.fornecedor,
        amountCents: focusedLine.amountCents,
        purchaseDate: focusedLine.dataCompra,
      },
    };
    const options = byQuestion.get(focused.question.id) ?? [];
    switch (focused.control) {
      case "DECISION":
        focus = {
          ...base,
          control: focused.control,
          options: options.filter(
            (option): option is ImportSessionGuidedOptionV1<"DECISION"> =>
              option.answer.kind === focused.control,
          ),
        };
        break;
      case "TARGETS":
        focus = {
          ...base,
          control: focused.control,
          options: options.filter(
            (option): option is ImportSessionGuidedOptionV1<"TARGETS"> =>
              option.answer.kind === focused.control,
          ),
        };
        break;
      case "EXPENSE_TYPE":
        focus = {
          ...base,
          control: focused.control,
          options: options.filter(
            (option): option is ImportSessionGuidedOptionV1<"EXPENSE_TYPE"> =>
              option.answer.kind === focused.control,
          ),
        };
        break;
      case "LABOR_CATEGORY":
        focus = {
          ...base,
          control: focused.control,
          options: options.filter(
            (option): option is ImportSessionGuidedOptionV1<"LABOR_CATEGORY"> =>
              option.answer.kind === focused.control,
          ),
        };
        break;
    }
  }
  const review: ImportSessionGuidedReviewV1 = {
    ...(progress === "ANSWERING"
      ? {
          progress,
          focus,
          actions: ["CONTINUE_ANSWERING"] as const,
        }
      : progress === "READY"
        ? {
            progress,
            focus: null,
            actions: ["REVIEW_READY"] as const,
          }
        : {
            progress,
            focus,
            actions: ["CONTINUE_ANSWERING", "REVIEW_READY"] as const,
          }),
  };

  return {
    review,
    async assertAnswer(questionId, answer): Promise<void> {
      const options = byQuestion.get(questionId);
      if (
        hasPendingDocumentary ||
        !options ||
        !options.some(
          (option) => answerKey(option.answer) === canonical(answer),
        )
      )
        invalid();
      // The rows used above are intentionally retained in this closure: projection
      // and validation therefore share one authoritative transaction snapshot.
      void revision;
    },
    assertReadyLine(lineId): void {
      const line = draft.lines.find((candidate) => candidate.id === lineId);
      if (!line) return invalid();
      const decision = line.decision;
      if (decision.kind !== "CREATE" && decision.kind !== "KEEP_EXISTING")
        return invalid();
      if (decision.kind === "KEEP_EXISTING") {
        if (
          !candidateRefs.some(
            (candidate) =>
              candidate.lineId === line.id &&
              candidate.kind === "EXPENSE" &&
              candidate.id === decision.expenseId,
          ) ||
          !visibleSourceCandidates.some(
            (candidate) => candidate.id === decision.expenseId,
          )
        )
          return invalid();
        return;
      }
      const lineCandidateRefs = candidateRefs.filter(
        (candidate) => candidate.lineId === line.id,
      );
      const visibleLineCandidate = (reason: string): boolean =>
        lineCandidateRefs.some(
          (candidate) => candidate.reason === reason && isVisibleRef(candidate),
        );
      const hasDecisionProvenance = draft.fieldProvenance?.some(
        (item) => item.lineId === line.id && item.field === "decision",
      );
      if (
        hasDecisionProvenance &&
        (visibleLineCandidate("STRONG_IDENTITY") ||
          visibleLineCandidate("INSTALLMENT_MATCH") ||
          decision.acceptNaturalDuplicate !==
            visibleLineCandidate("NATURAL_MATCH"))
      )
        return invalid();
      if (
        line.amountCents === null ||
        !Number.isInteger(line.amountCents) ||
        line.amountCents <= 0 ||
        line.targets === null ||
        line.targets.length > 1
      )
        return invalid();
      const targets = line.targets;
      if (targets.length === 1) {
        const target = targets[0]!;
        const project = reformaProjects.find(
          (candidate) => candidate.id === target.projectId,
        );
        if (
          !project ||
          !Number.isInteger(target.amountCents) ||
          target.amountCents !== line.amountCents ||
          (target.roomId !== null &&
            !rooms.some(
              (room) =>
                room.id === target.roomId &&
                room.projectId === target.projectId,
            ))
        )
          return invalid();
      }
      const projectType =
        targets.length === 1 ? ProjectType.REFORMA : ProjectType.PESSOAL;
      if (
        line.tipoDespesa === null ||
        !getExpenseTypesForProject(projectType).includes(line.tipoDespesa)
      )
        return invalid();
      if (
        (line.tipoDespesa === ExpenseType.MAO_DE_OBRA &&
          line.categoriaMaoDeObra === null) ||
        (line.tipoDespesa !== ExpenseType.MAO_DE_OBRA &&
          line.categoriaMaoDeObra !== null)
      )
        return invalid();
      if (draft.fieldProvenance !== undefined) {
        const required: ImportSessionDraftFieldV1[] = [
          "decision",
          "targets",
          "tipoDespesa",
          ...(line.tipoDespesa === ExpenseType.MAO_DE_OBRA
            ? (["categoriaMaoDeObra"] as const)
            : []),
        ];
        if (
          required.some(
            (field) =>
              !draft.fieldProvenance!.some(
                (item) => item.lineId === line.id && item.field === field,
              ),
          )
        )
          return invalid();
      }
    },
  };
}

export function recordDraftFieldProvenance(
  draft: ImportSessionStoredDraftV1,
  lineIds: readonly string[],
  field: ImportSessionDraftFieldV1,
  origin: ImportSessionDraftFieldOriginV1 | null,
  recordedRevision: number,
  interpretationRequestId?: string,
): ImportSessionStoredDraftV1 {
  const selected = new Set(lineIds);
  const retained = (draft.fieldProvenance ?? []).filter(
    (item) => !(selected.has(item.lineId) && item.field === field),
  );
  if (origin !== null) {
    for (const lineId of lineIds)
      retained.push({
        origin,
        lineId,
        field,
        recordedRevision,
        ...(interpretationRequestId === undefined
          ? {}
          : { interpretationRequestId }),
      });
  }
  return { ...draft, fieldProvenance: retained };
}

export function selectServerReadyLines(
  draft: ImportSessionStoredDraftV1,
  preparedLineIds: readonly string[],
): {
  readyLineIds: string[];
  hasRemainingWork: boolean;
  progress: ImportSessionGuidedProgressV1;
} {
  const selected = new Set(draft.selectedLineIds);
  const readyLineIds = draft.lines
    .map((line) => line.id)
    .filter(
      (lineId) => selected.has(lineId) && preparedLineIds.includes(lineId),
    );
  const hasRemainingWork = draft.lines.some(
    (line) => selected.has(line.id) && !readyLineIds.includes(line.id),
  );
  return {
    readyLineIds,
    hasRemainingWork,
    progress:
      readyLineIds.length === 0
        ? "ANSWERING"
        : hasRemainingWork
          ? "READY_WITH_PENDING"
          : "READY",
  };
}
