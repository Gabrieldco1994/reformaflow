import { Inject, Injectable } from "@nestjs/common";
import {
  EXPENSE_TAXONOMY,
  ExpenseType,
  LaborCategory,
  ProjectType,
  IMPORT_SESSION_LIMITS as LIMITS,
  ImportSessionErrorCode as Code,
  type ImportChatOutcomeV1,
  type ImportSessionViewV1,
  isPendingImportQuestion,
  parseImportDeclarationLiteral,
  type ImportDeclarationContextV1,
  type ImportSessionQuestionV1,
  type ImportEntryActionV1,
} from "@reformaflow/domain";
import {
  ImportChatContractError,
  projectImportModelRead,
  parseImportToolArguments,
  type ImportChatRead,
  type ImportModelRead,
} from "../../agent/import-chat.contract";
import { canonical } from "../../common/canonical";
import {
  resolveAccessibleProjectScope,
  EXPENSE_MODULE,
} from "../../common/access-rules";
import { PrismaService } from "../../prisma/prisma.service";
import {
  activateImportChat,
  importChatAuth,
  importChatState,
  markImportChatStarted,
  releaseImportChat,
  rememberImportChatView,
  reserveImportChatOperation,
  type ImportChatAdmission,
} from "./import-chat.admission";
import {
  resolveImportAnswer,
  type ImportAnswerReferences,
} from "./import-chat-answer";
import { reauthorize } from "./import-session.auth";
import {
  IMPORT_SESSION_CLOCK,
  type ImportSessionClock,
  IMPORT_SESSION_CAPABILITY,
  type ImportSessionCapability,
  csvIntakeEnabled,
} from "./import-session.capability";
import { IMPORT_VAULT_GATE, type ImportVaultGate } from "./vault/vault-state";
import { ImportSessionService } from "./import-session.service";
import { ImportSessionWorkflowService } from "./import-session-workflow.service";
import { ImportSessionError } from "./import-session.errors";
import { ImportDeclarationLiteralError } from "./import-session.declarations";

type Pages = Map<string, Map<number, string | null>>;
const pages = new WeakMap<ImportChatAdmission, Pages>();
const fail = (code: Code, view?: ImportSessionViewV1) =>
  new ImportSessionError(
    code,
    view ? { sessionId: view.id, currentRevision: view.revision } : {},
  );
const sameIds = (a: readonly string[], b: readonly string[]) =>
  canonical([...a].sort()) === canonical([...b].sort());

/** The only exported operational facade. No financial grant or documentary caller is exposed. */
@Injectable()
export class ImportChatBridge {
  constructor(
    private readonly sessions: ImportSessionService,
    private readonly workflow: ImportSessionWorkflowService,
    private readonly prisma: PrismaService,
    @Inject(IMPORT_SESSION_CLOCK) private readonly clock: ImportSessionClock,
    @Inject(IMPORT_SESSION_CAPABILITY)
    private readonly capability: ImportSessionCapability,
    @Inject(IMPORT_VAULT_GATE) private readonly gate: ImportVaultGate,
  ) {}

  /** Availability only: card selection/ACL and file consent belong to the UI intake APIs. */
  entryAction(): ImportEntryActionV1 {
    if (
      !csvIntakeEnabled(this.capability) ||
      this.gate.boot.stopped.aborted ||
      !this.gate.boot.runtime()
    )
      return { version: 1, kind: "IMPORT_UNAVAILABLE" };
    return {
      version: 1,
      kind: "START_CARD_INVOICE_IMPORT",
      formats: ["CSV"],
      suggestedCardId: null,
    };
  }

  contextForRequest(request: object): ImportChatAdmission | null {
    return activateImportChat(request, this.clock.now());
  }
  release(admission: ImportChatAdmission): void {
    releaseImportChat(admission);
    pages.delete(admission);
  }
  private async current(
    admission: ImportChatAdmission,
    revision = admission.turn.expectedRevision,
  ) {
    const auth = importChatAuth(admission, this.clock.now());
    const view = await this.sessions.getSession(auth, admission.turn.sessionId);
    importChatAuth(admission, this.clock.now());
    rememberImportChatView(admission, view, this.clock.now());
    if (view.revision !== revision) throw fail(Code.REVISION_CONFLICT, view);
    return view;
  }
  private focus(
    admission: ImportChatAdmission,
    view: ImportSessionViewV1,
  ): ImportSessionQuestionV1 | null {
    const focus = admission.turn.focus;
    if (!focus) return null;
    const question = view.questions.find((q) => q.id === focus.id);
    if (
      !question ||
      question.field !== focus.field ||
      !sameIds(question.lineIds, focus.lineIds)
    )
      throw fail(Code.REVISION_CONFLICT, view);
    return question;
  }
  private async affected(
    admission: ImportChatAdmission,
    view: ImportSessionViewV1,
  ): Promise<string[]> {
    const question = this.focus(admission, view);
    const scope = admission.turn.scope;
    if (!question || !scope) return [];
    if (scope.kind === "LINES") {
      if (scope.lineIds.some((id) => !question.lineIds.includes(id)))
        throw fail(Code.INVALID_INPUT);
      return [...scope.lineIds];
    }
    const auth = importChatAuth(admission, this.clock.now());
    const ref = await this.prisma.importSessionArtifact.findFirst({
      where: {
        id: scope.attachmentId,
        sessionId: view.id,
        tenantId: auth.tenantId,
        ownerProjectId: view.ownerProjectId,
        state: "ATTACHED",
        artifact: {
          tenantId: auth.tenantId,
          ownerProjectId: view.ownerProjectId,
          state: "EXTRACTED",
        },
      },
      select: { artifactId: true },
    });
    if (!ref?.artifactId) return [];
    const observations = await this.prisma.importObservation.findMany({
      where: {
        artifactId: ref.artifactId,
        tenantId: auth.tenantId,
        ownerProjectId: view.ownerProjectId,
      },
      select: { id: true },
      take: LIMITS.parsedRowsPerSession + 1,
    });
    if (observations.length > LIMITS.parsedRowsPerSession)
      throw fail(Code.LIMIT_EXCEEDED, view);
    if (
      !observations.length ||
      observations.some(
        (obs) =>
          !view.lines.some((line) => line.observationIds.includes(obs.id)),
      )
    )
      return [];
    const obsIds = new Set(observations.map((obs) => obs.id));
    const ids = view.lines
      .filter((line) => line.observationIds.some((id) => obsIds.has(id)))
      .map((line) => line.id);
    await this.current(admission);
    if (
      admission.turn.intent === "APPROVE_ATTACHMENT_SCOPE" &&
      !sameIds(ids, admission.turn.scope.approvedLineIds)
    )
      throw fail(Code.REVISION_CONFLICT, view);
    return ids;
  }
  async read(
    admission: ImportChatAdmission,
    query: ImportChatRead,
  ): Promise<ImportModelRead> {
    const view = await this.current(admission);
    const focus = this.focus(admission, view);
    const ids = await this.affected(admission, view);
    const auth = importChatAuth(admission, this.clock.now());
    const version = 1;
    if (query.kind === "SESSION")
      return projectImportModelRead({
        version,
        kind: "SESSION",
        state: view.state,
        revision: view.revision,
        focus,
        lines: view.lines.filter((line) => ids.includes(line.id)),
      });
    if (!focus || !view.actions.includes("RESOLVE"))
      throw fail(Code.CAPABILITY_DISABLED, view);
    let input: ImportModelRead;
    if (query.kind === "PAYMENT_METHODS") {
      const card = await this.prisma.creditCard.findFirst({
        where: {
          id: view.cardId,
          tenantId: auth.tenantId,
          projectId: view.ownerProjectId,
          deletedAt: null,
        },
        select: { id: true, nickname: true, institution: true, last4: true },
      });
      if (!card) throw fail(Code.NOT_FOUND);
      input = { version, kind: "PAYMENT_METHODS", card };
    } else if (query.kind === "TAXONOMY") {
      if (focus.field !== "tipoDespesa" && focus.field !== "categoriaMaoDeObra")
        throw new ImportChatContractError("TOOL_NOT_ALLOWED");
      input = {
        version,
        kind: "TAXONOMY",
        expenseTypes: EXPENSE_TAXONOMY.map((node) => {
          const value = Object.values(ExpenseType).find(
            (value) => value === node.type,
          );
          if (!value) throw fail(Code.INVALID_INPUT);
          return { value, label: node.label, synonyms: node.synonyms };
        }),
        laborCategories: Object.values(LaborCategory),
      };
    } else {
      const key =
        query.kind === "CANDIDATES"
          ? `${query.kind}:${query.lineId}`
          : query.kind;
      if (!pages.has(admission)) pages.set(admission, new Map());
      const all = pages.get(admission)!;
      if (!all.has(key)) all.set(key, new Map([[0, null]]));
      const cursors = all.get(key)!;
      if (
        !Number.isInteger(query.pageIndex) ||
        query.pageIndex < 0 ||
        !cursors.has(query.pageIndex)
      )
        throw fail(Code.INVALID_INPUT);
      const cursor = cursors.get(query.pageIndex);
      if (query.kind === "PROJECTS") {
        if (focus.field !== "targets")
          throw new ImportChatContractError("TOOL_NOT_ALLOWED");
        const actor = await reauthorize(this.prisma, auth, this.clock.now());
        const scope = await resolveAccessibleProjectScope(
          this.prisma,
          actor.tenantId,
          actor.role,
          actor.allowedProjects,
          actor.allowedProjectTypes,
          actor.allowedModules,
          EXPENSE_MODULE,
        );
        const found = await this.prisma.project.findMany({
          where: {
            tenantId: auth.tenantId,
            deletedAt: null,
            ...(scope === null ? {} : { id: { in: scope } }),
          },
          orderBy: { id: "asc" },
          take: LIMITS.pageSize + 1,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
          select: { id: true, name: true, type: true },
        });
        const hasMore = found.length > LIMITS.pageSize;
        const items = found.slice(0, LIMITS.pageSize).map((item) => {
          const type = Object.values(ProjectType).find(
            (type) => type === item.type,
          );
          if (!type) throw fail(Code.INVALID_INPUT);
          return { ...item, type };
        });
        if (hasMore)
          cursors.set(query.pageIndex + 1, items[items.length - 1].id);
        input = {
          version,
          kind: "PROJECTS",
          pageIndex: query.pageIndex,
          items,
          hasMore,
        };
      } else if (query.kind === "OBSERVATIONS") {
        const result = await this.sessions.getObservations(
          auth,
          view.id,
          cursor ? { cursor } : {},
        );
        const items = result.items.flatMap((item) =>
          view.lines
            .filter(
              (line) =>
                ids.includes(line.id) && line.observationIds.includes(item.id),
            )
            .map((line) => ({ ...item, lineId: line.id })),
        );
        if (result.nextCursor)
          cursors.set(query.pageIndex + 1, result.nextCursor);
        input = {
          version,
          kind: "OBSERVATIONS",
          pageIndex: query.pageIndex,
          items,
          hasMore: result.nextCursor !== null,
        };
      } else {
        if (focus.field !== "decision" || !ids.includes(query.lineId))
          throw new ImportChatContractError("TOOL_NOT_ALLOWED");
        const result = await this.sessions.getCandidates(auth, view.id, {
          lineId: query.lineId,
          ...(cursor ? { cursor } : {}),
        });
        if (result.nextCursor)
          cursors.set(query.pageIndex + 1, result.nextCursor);
        input = {
          version,
          kind: "CANDIDATES",
          pageIndex: query.pageIndex,
          items: result.items,
          hasMore: result.nextCursor !== null,
          searchComplete: view.searchComplete,
        };
      }
    }
    await this.current(admission);
    return projectImportModelRead(input);
  }
  async editAnswer(
    admission: ImportChatAdmission,
    interpretation: unknown,
  ): Promise<ImportChatOutcomeV1> {
    const view = await this.current(admission);
    const focus = this.focus(admission, view);
    if (!focus || !view.actions.includes("RESOLVE"))
      throw fail(Code.CAPABILITY_DISABLED, view);
    if (
      "subject" in focus &&
      (admission.turn.intent !== "ANSWER" ||
        admission.turn.scope.kind !== "LINES" ||
        !sameIds(admission.turn.scope.lineIds, focus.lineIds))
    )
      throw fail(Code.INVALID_INPUT, view);
    const lineIds = await this.affected(admission, view);
    const base = {
      version: 1 as const,
      turnId: admission.turn.turnId,
      ref: { sessionId: view.id, revision: view.revision },
    };
    if (!lineIds.length)
      return {
        ...base,
        kind: "CLARIFY",
        acknowledgment: "NONE",
        reason: "INCOMPLETE_SCOPE",
        scopeReview: null,
      };
    if (
      admission.turn.intent === "ANSWER" &&
      admission.turn.scope.kind === "ATTACHMENT" &&
      lineIds.some((id) => !focus.lineIds.includes(id))
    )
      return {
        ...base,
        kind: "CLARIFY",
        acknowledgment: "NONE",
        reason: "SCOPE_REVIEW",
        scopeReview: {
          focus: admission.turn.focus,
          attachmentId: admission.turn.scope.attachmentId,
          lineIds,
        },
      };
    reserveImportChatOperation(admission, "EDIT", this.clock.now());
    const parsed = parseImportToolArguments("import_edit_answer", {
      interpretation,
    });
    if (parsed.name !== "import_edit_answer")
      throw new ImportChatContractError("MODEL_OUTPUT_INVALID");
    const answer = parsed.arguments.interpretation;
    if ("subject" in focus) {
      const clarify: ImportChatOutcomeV1 = {
        ...base,
        kind: "CLARIFY",
        acknowledgment: "NONE",
        reason: "INVALID_VALUE",
        scopeReview: null,
      };
      const context: ImportDeclarationContextV1 =
        focus.field === "amountCents"
          ? {
              field: focus.field,
              meaningContext: focus.subject.meaningContext,
              effectiveInstallmentCount: null,
            }
          : {
              field: focus.field,
              meaningContext: null,
              effectiveInstallmentCount: null,
            };
      if (
        parseImportDeclarationLiteral(context, admission.turn.literalAnswer)
          .kind === "CLARIFY"
      )
        return clarify;
      const auth = importChatAuth(admission, this.clock.now());
      markImportChatStarted(admission, this.clock.now());
      let edited: ImportSessionViewV1;
      try {
        edited = await this.workflow.editConversationAnswer(
          auth,
          view.id,
          { kind: "DECLARE_OBSERVATION" },
          admission,
        );
      } catch (error) {
        if (!(error instanceof ImportDeclarationLiteralError)) throw error;
        return clarify;
      }
      await this.current(admission, edited.revision);
      return {
        ...base,
        ref: { sessionId: view.id, revision: edited.revision },
        kind: "REVISED_SESSION",
        acknowledgment:
          edited.revision === view.revision ? "NO_CHANGE" : "EDITED",
      };
    }
    let references: ImportAnswerReferences | undefined;
    if (
      answer.kind === "VALUE" &&
      answer.field === focus.field &&
      ((answer.field === "targets" && answer.value?.kind === "TARGETS") ||
        (answer.field === "decision" && answer.value.kind === "KEEP_EXISTING"))
    ) {
      const auth = importChatAuth(admission, this.clock.now());
      const actor = await reauthorize(this.prisma, auth, this.clock.now());
      references = { projects: [], candidates: [] };
      if (answer.field === "targets") {
        const scope = await resolveAccessibleProjectScope(
          this.prisma,
          actor.tenantId,
          actor.role,
          actor.allowedProjects,
          actor.allowedProjectTypes,
          actor.allowedModules,
          EXPENSE_MODULE,
        );
        references.projects = await this.prisma.project.findMany({
          where: {
            tenantId: auth.tenantId,
            deletedAt: null,
            ...(scope === null ? {} : { id: { in: scope } }),
          },
          select: {
            id: true,
            name: true,
            rooms: {
              where: { deletedAt: null },
              select: { id: true, name: true },
            },
          },
        });
      } else {
        const candidates = [];
        for (const lineId of lineIds) {
          let cursor: string | null = null;
          do {
            const page = await this.sessions.getCandidates(auth, view.id, {
              lineId,
              ...(cursor ? { cursor } : {}),
            });
            candidates.push(...page.items);
            cursor = page.nextCursor;
          } while (cursor !== null);
        }
        references.candidates = candidates;
      }
      await this.current(admission);
    }
    const command = resolveImportAnswer(
      admission.turn.literalAnswer,
      focus.field,
      interpretation,
      view.lines.filter((line) => lineIds.includes(line.id)),
      references,
    );
    if (command.kind === "CLARIFY")
      return {
        ...base,
        kind: "CLARIFY",
        acknowledgment: "NONE",
        reason: command.reason,
        scopeReview: null,
      };
    const auth = importChatAuth(admission, this.clock.now());
    markImportChatStarted(admission, this.clock.now());
    const edited = await this.workflow.editConversationAnswer(
      auth,
      view.id,
      command,
      admission,
    );
    await this.current(admission, edited.revision);
    return {
      ...base,
      ref: { sessionId: view.id, revision: edited.revision },
      kind: "REVISED_SESSION",
      acknowledgment:
        edited.revision === view.revision ? "NO_CHANGE" : "EDITED",
    };
  }
  async prepare(admission: ImportChatAdmission): Promise<ImportChatOutcomeV1> {
    const view = await this.current(admission);
    if (admission.turn.intent !== "OPEN_REVIEW")
      throw new ImportChatContractError("TOOL_NOT_ALLOWED");
    if (!view.actions.includes("PREPARE"))
      throw fail(Code.CAPABILITY_DISABLED, view);
    reserveImportChatOperation(admission, "PREPARE", this.clock.now());
    const auth = importChatAuth(admission, this.clock.now());
    markImportChatStarted(admission, this.clock.now());
    const result = await this.workflow.prepareConversation(
      auth,
      view.id,
      { expectedRevision: view.revision },
      admission,
    );
    const current = await this.current(admission, result.revision);
    const base = {
      version: 1 as const,
      turnId: admission.turn.turnId,
      ref: { sessionId: current.id, revision: current.revision },
      acknowledgment: "PREPARED" as const,
    };
    const question = current.questions.find(
      (q) =>
        isPendingImportQuestion(q) &&
        q.lineIds.some((id) => current.selectedLineIds.includes(id)),
    );
    if (question) return { ...base, kind: "QUESTION", questionId: question.id };
    if (
      current.actions.includes("CONFIRM") ||
      current.actions.includes("EXECUTE")
    )
      return { ...base, kind: "OPEN_REVIEW" };
    return { ...base, kind: "REVISED_SESSION" };
  }
}
