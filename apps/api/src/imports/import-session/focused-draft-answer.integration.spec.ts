import type { ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import { createHash, randomUUID } from "node:crypto";
import {
  IMPORT_SESSION_CONSENT_POLICY_VERSION,
  ExpenseType,
  ImportSessionErrorCode as Code,
  ProjectType,
  encodeImportDeclaration,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import { PrismaService } from "../../prisma/prisma.service";
import { ConciliacaoService } from "../../conciliacao/conciliacao.service";
import { ExpenseService } from "../../expense/expense.service";
import { extractCardStatementDocument } from "../../credit-card/parsers/statement-document";
import { CardPurchaseBatchAdapter } from "./card-purchase-batch.adapter";
import {
  ImportAuthGuard,
  readImportAuthForRequest,
} from "./import-session.auth";
import type { AuthenticatedImportContext } from "./import-session.contract";
import { DefaultImportSessionCapability } from "./import-session.capability";
import { ImportSessionController } from "./import-session.controller";
import { buildImportMaterialization } from "./import-session.extraction";
import { EMPTY_DRAFT_JSON } from "./import-session.projection";
import { ImportSessionService } from "./import-session.service";
import { ImportSessionWorkflowService } from "./import-session-workflow.service";
import {
  ImportUiGrantIssuer,
  RuntimeUiGrantVerifier,
} from "./import-session-ui-grant";
import { ImportUiGuard } from "./import-session-ui.guard";
import { documentaryAnswerScope } from "./import-session.native-answer";
import {
  focusedDraftAnswerScope,
  parseFocusedDraftAnswerRequest,
} from "./import-session.focused-draft-answer";

describe("focused typed draft answers: real UI grants, locked writer and card preparation", () => {
  const prisma = new PrismaService();
  let now = new Date("2026-10-10T12:00:00.000Z");
  const clock = { now: (): Date => now };
  const capability = new DefaultImportSessionCapability();
  const issuer = new ImportUiGrantIssuer(clock);
  const verifier = new RuntimeUiGrantVerifier();
  const runtime = {};
  const gate = {
    boot: {
      runtime: () => runtime,
      stopped: { aborted: false },
      recheckLock: async () => ({ ok: true, runtime }),
    },
  } as never;
  const raw = { abortOwned: jest.fn() } as never;
  const service = new ImportSessionService(
    prisma,
    clock,
    capability,
    verifier,
    gate,
    raw,
  );
  const conciliacao = new ConciliacaoService(prisma);
  const batches = new CardPurchaseBatchAdapter(
    new ExpenseService(prisma, conciliacao),
    conciliacao,
    clock,
  );
  const workflow = new ImportSessionWorkflowService(
    prisma,
    clock,
    capability,
    verifier,
    batches,
    gate,
    raw,
  );
  const controller = new ImportSessionController(
    service,
    issuer,
    capability,
    workflow,
  );
  const ui = new ImportUiGuard(
    { allowed: () => ["http://localhost:3000"] },
    issuer,
  );
  const chat = jest.spyOn(workflow, "editConversationAnswer");
  let tenantId: string;
  let userId: string;
  let projectId: string;
  let cardId: string;
  let sessionId: string;
  let artifactId: string;
  let view: ImportSessionViewV1;
  const context = (request: object): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => request }),
    }) as ExecutionContext;
  function authenticated(
    headers: Record<string, string> = {
      origin: "http://localhost:3000",
      "x-rf-import-ui": "1",
    },
    actorId: string = userId,
    actorTenant: string = tenantId,
  ): { request: Request; auth: AuthenticatedImportContext } {
    const request = {
      headers,
      user: {
        id: actorId,
        tenantId: actorTenant,
        authClaims: {
          sessionVersion: 0,
          expiresAtEpochSeconds: now.getTime() / 1000 + 86400,
        },
      },
    };
    new ImportAuthGuard().canActivate(context(request));
    return {
      request: request as unknown as Request,
      auth: readImportAuthForRequest(request),
    };
  }
  function payload(
    field: "firstDueDate" | "tipoDespesa",
    value: unknown,
  ): Record<string, unknown> {
    const question = view.questions.find(
      (q) =>
        q.field === field &&
        !("subject" in q) &&
        q.lineIds.includes(view.selectedLineIds[0]),
    );
    if (!question) throw Error("Missing focused question");
    return {
      version: 1,
      answerRequestId: randomUUID(),
      expectedRevision: view.revision,
      questionId: question.id,
      answer: { field, value },
    };
  }
  async function submit(
    body: unknown,
    actor = authenticated(),
    guard = true,
  ): Promise<ImportSessionViewV1> {
    if (guard) ui.canActivate(context(actor.request));
    return controller.edit(actor.auth, sessionId, body, actor.request);
  }
  const row = () =>
    prisma.importSession.findUniqueOrThrow({ where: { id: sessionId } });
  const finance = async (): Promise<number[]> =>
    Promise.all([
      prisma.expense.count({ where: { tenantId } }),
      prisma.cashFlowEntry.count({ where: { tenantId } }),
      prisma.receipt.count({ where: { tenantId } }),
      prisma.rateioAllocation.count({ where: { tenantId } }),
      prisma.crossProjectSettlement.count({ where: { tenantId } }),
      prisma.importedInvoiceLiquidation.count({ where: { tenantId } }),
    ]);
  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toMatch(/test(?:-worker-\d+)?\.db/);
    await prisma.$connect();
    tenantId = (
      await prisma.tenant.create({ data: { name: "focused answer" } })
    ).id;
    userId = (
      await prisma.user.create({
        data: {
          tenantId,
          username: randomUUID(),
          name: "fixture",
          role: "ADMIN",
        },
      })
    ).id;
    projectId = (
      await prisma.project.create({
        data: { tenantId, name: "fixture", type: ProjectType.PESSOAL },
      })
    ).id;
    cardId = (
      await prisma.creditCard.create({
        data: {
          tenantId,
          projectId,
          nickname: "fixture",
          institution: "fixture",
          last4: "1234",
          closingDay: 5,
          dueDay: 10,
        },
      })
    ).id;
  });
  beforeEach(async () => {
    now = new Date("2026-10-10T12:00:00.000Z");
    const actor = authenticated();
    ui.canActivate(context(actor.request));
    const createRequestId = randomUUID();
    view = (
      await service.create(
        actor.auth,
        {
          version: 1,
          createRequestId,
          cardId,
          consentPolicyVersion: IMPORT_SESSION_CONSENT_POLICY_VERSION,
          consentAnalyze: true,
        },
        issuer.issue(actor.request, actor.auth, {
          operation: "CREATE_SESSION",
          cardId,
          createRequestId,
          consentPolicyVersion: IMPORT_SESSION_CONSENT_POLICY_VERSION,
        }),
      )
    ).view;
    sessionId = view.id;
    const bytes = Buffer.from(
      "date,title,amount\n2026-09-01,LOJA FICTICIA NORTE,206.96\n2026-09-02,CAFE TESTE,0.01\n",
    );
    const extraction = extractCardStatementDocument({
      version: 1,
      context: "CARD_INVOICE",
      format: "CSV",
      profile: "CSV_NUBANK",
      bytes,
    });
    const artifact = await prisma.importArtifact.create({
      data: {
        tenantId,
        ownerProjectId: projectId,
        documentSha256: createHash("sha256").update(bytes).digest("hex"),
        state: "EXTRACTED",
        detectedFormat: "CSV",
        verifiedBytes: bytes.length,
        parserVersion: extraction.parserVersion,
        extractionJson: JSON.stringify(extraction),
      },
    });
    artifactId = artifact.id;
    const ref = await prisma.importSessionArtifact.create({
      data: {
        tenantId,
        ownerProjectId: projectId,
        sessionId,
        artifactId,
        position: 0,
        fileName: "fixture.csv",
        declaredMime: "text/csv",
        declaredBytes: bytes.length,
        reservedBytes: 0,
        state: "ATTACHED",
        verifiedAt: now,
      },
    });
    const material = buildImportMaterialization({
      session: await row(),
      attachment: ref,
      artifact,
      extraction,
      observations: [],
      draft: {
        ...JSON.parse(EMPTY_DRAFT_JSON),
        scope: { observationIds: [], pendingAttachmentIds: [ref.id] },
      },
      newIds: new Map(
        extraction.occurrences.map((occurrence) => [
          occurrence.reference,
          { observationId: randomUUID(), lineId: randomUUID() },
        ]),
      ),
    });
    for (const observation of material.observations)
      await prisma.importObservation.create({ data: observation });
    // Fixture choices use the real legacy draft path; no financial rows are seeded.
    const readyLines = material.draft.lines.map((line, index) => ({
      ...line,
      amountMeaning: "TOTAL_PURCHASE" as const,
      amountCents: index === 0 ? 20696 : 1,
      installmentCount: 1,
      targets: [],
      decision: { kind: "CREATE" as const, acceptNaturalDuplicate: false },
    }));
    await prisma.importSession.update({
      where: { id: sessionId },
      data: { draftJson: JSON.stringify(material.draft) },
    });
    view = await workflow.edit(actor.auth, sessionId, {
      expectedRevision: view.revision,
      questionId: null,
      replaceLines: readyLines,
      selectedLineIds: [readyLines[0].id],
    });
    for (const [field, text] of [
      ["amountMeaning", "total da compra"],
    ] as const) {
      const question = view.questions.find(
        (q) =>
          q.field === field &&
          "subject" in q &&
          q.lineIds[0] === readyLines[0].id,
      );
      if (!question || !("subject" in question))
        throw Error("Missing documentary fixture question");
      const input = { kind: "VALUE" as const, text };
      const encoded = encodeImportDeclaration(
        { field, meaningContext: null, effectiveInstallmentCount: null },
        input,
      );
      if (encoded.kind !== "ENCODED") throw Error("Invalid fixture");
      const request = {
        version: 1 as const,
        answerRequestId: randomUUID(),
        expectedRevision: view.revision,
        questionId: question.id,
        input,
        answer: encoded.answer,
      };
      view = await workflow.documentaryAnswer(
        actor.auth,
        sessionId,
        request,
        issuer.issue(
          actor.request,
          actor.auth,
          documentaryAnswerScope(sessionId, request),
        ),
      );
    }
    // Preparation produces authoritative generic type/date questions, not fabricated IDs.
    view = await workflow.prepare(actor.auth, sessionId, {
      expectedRevision: view.revision,
    });
  });
  afterEach(async () => {
    await prisma.$transaction(async (tx) => {
      await tx.importSessionArtifact.deleteMany({ where: { sessionId } });
      await tx.importSession.deleteMany({ where: { id: sessionId } });
      await tx.importObservation.deleteMany({ where: { artifactId } });
      await tx.importArtifact.deleteMany({ where: { id: artifactId } });
    });
  });
  afterAll(async () => {
    await prisma.$transaction(async (tx) => {
      await tx.creditCard.deleteMany({ where: { tenantId } });
      await tx.project.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
    await prisma.$disconnect();
  });

  it("saves exact OUTROS and first due date without composing an LLM or altering other authority", async () => {
    const before = await row();
    const observations = await prisma.importObservation.findMany({
      where: { tenantId },
      orderBy: { id: "asc" },
    });
    const parsedBefore = JSON.parse(before.draftJson);
    view = await submit(payload("tipoDespesa", ExpenseType.OUTROS));
    view = await submit(payload("firstDueDate", "2026-10-10"));
    const stored = await row();
    const draft = JSON.parse(stored.draftJson);
    expect(chat).not.toHaveBeenCalled();
    expect(draft.selectedLineIds).toEqual(parsedBefore.selectedLineIds);
    expect(draft.declarations).toEqual(parsedBefore.declarations);
    expect(draft.lines[1]).toEqual(parsedBefore.lines[1]);
    expect(draft.lines[0]).toEqual({
      ...parsedBefore.lines[0],
      tipoDespesa: ExpenseType.OUTROS,
      firstDueDate: "2026-10-10",
    });
    expect(
      await prisma.importObservation.findMany({
        where: { tenantId },
        orderBy: { id: "asc" },
      }),
    ).toEqual(observations);
    expect(await finance()).toEqual([0, 0, 0, 0, 0, 0]);
    expect(stored.challengeJson).toBeNull();
    expect(stored.financialRequestId).toBeNull();
    expect(stored.receiptJson).toBeNull();
    view = await workflow.prepare(authenticated().auth, sessionId, {
      expectedRevision: view.revision,
    });
    expect(view.state).toBe("READY");
    expect(view.proposal?.lines[0].schedule.occurrences).toEqual([
      {
        index: 0,
        data: "2026-10-10",
        invoiceDueMonth: "2026-10",
        parcela: "1/1",
        valor: 20696,
      },
    ]);
    expect(view.lines[0].firstDueDate).toBe("2026-10-10");
    await expect(
      workflow.confirm(
        authenticated().auth,
        sessionId,
        {
          expectedRevision: view.revision,
          proposalHash: view.proposal!.proposalHash,
          financialRequestId: randomUUID(),
          nonce: null,
        },
        {},
      ),
    ).rejects.toMatchObject({ code: Code.UI_ACTION_REQUIRED });
  });
  it("preserves an explicitly entered bad cycle and lets preparation reject it without adjustment", async () => {
    view = await submit(payload("tipoDespesa", ExpenseType.OUTROS));
    view = await submit(payload("firstDueDate", "2026-10-11"));
    expect(view.lines[0].firstDueDate).toBe("2026-10-11");
    view = await workflow.prepare(authenticated().auth, sessionId, {
      expectedRevision: view.revision,
    });
    expect(view.state).not.toBe("READY");
    expect(view.lines[0].firstDueDate).toBe("2026-10-11");
    expect(view.questions.some((q) => q.field === "firstDueDate")).toBe(true);
    expect(await finance()).toEqual([0, 0, 0, 0, 0, 0]);
  });
  it.each([
    { version: 2 },
    { extra: true },
    { answerRequestId: "invalid" },
    { expectedRevision: 0 },
    { answer: { field: "firstDueDate", value: "2026-02-30" } },
    { answer: { field: "firstDueDate", value: "10/10/2026" } },
    { answer: { field: "tipoDespesa", value: "unknown" } },
    { answer: { field: "firstDueDate", value: "2026-10-10", extra: true } },
    { answer: { field: "targets", value: [] } },
    { answer: { field: "decision", value: { kind: "CREATE" } } },
    { answer: { field: "dataCompra", value: "2026-10-10" } },
    { input: { kind: "VALUE", text: "ignored" } },
  ])("rejects malformed or out-of-scope typed request %j", async (patch) => {
    const before = await row();
    const issue = jest.spyOn(issuer, "issue");
    issue.mockClear();
    await expect(
      submit({ ...payload("firstDueDate", "2026-10-10"), ...patch }),
    ).rejects.toMatchObject({ code: Code.INVALID_INPUT });
    expect(issue).not.toHaveBeenCalled();
    issue.mockRestore();
    expect(await row()).toEqual(before);
  });
  it("checks the locked question field and exact revision, not caller field claims", async () => {
    const before = await row();
    const date = payload("firstDueDate", "2026-10-10");
    await expect(
      submit({ ...date, expectedRevision: view.revision + 1 }),
    ).rejects.toMatchObject({ code: Code.REVISION_CONFLICT });
    await expect(
      submit({ ...date, questionId: "nonexistent" }),
    ).rejects.toBeDefined();
    await expect(
      submit({
        ...date,
        answer: { field: "tipoDespesa", value: ExpenseType.OUTROS },
      }),
    ).rejects.toMatchObject({ code: Code.INVALID_INPUT });
    expect(await row()).toEqual(before);
  });
  it("requires actual UI admission and current tenant/user/project access", async () => {
    const body = payload("tipoDespesa", ExpenseType.OUTROS);
    await expect(submit(body, authenticated({}))).rejects.toMatchObject({
      code: Code.UI_ACTION_REQUIRED,
    });
    await expect(submit(body, authenticated(), false)).rejects.toMatchObject({
      code: Code.UI_ACTION_REQUIRED,
    });
    await expect(
      submit(
        body,
        authenticated({
          origin: "https://evil.invalid",
          "x-rf-import-ui": "1",
        }),
      ),
    ).rejects.toMatchObject({ code: Code.UI_ACTION_REQUIRED });
    await expect(
      submit(body, authenticated(undefined, randomUUID())),
    ).rejects.toBeDefined();
    await expect(
      submit(body, authenticated(undefined, userId, randomUUID())),
    ).rejects.toBeDefined();
    await prisma.user.update({
      where: { id: userId },
      data: { role: "USER", allowedProjects: JSON.stringify([randomUUID()]) },
    });
    try {
      await expect(submit(body)).rejects.toMatchObject({
        code: Code.NOT_FOUND,
      });
    } finally {
      await prisma.user.update({
        where: { id: userId },
        data: { role: "ADMIN", allowedProjects: "[]" },
      });
    }
  });
  it("same-revision race has one edit winner and stale replay requires an authorized read", async () => {
    const body = payload("firstDueDate", "2026-10-10");
    const before = await row();
    const results = await Promise.allSettled([submit(body), submit(body)]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const recovered = await service.getSession(authenticated().auth, sessionId);
    expect(recovered.revision).toBe(before.revision + 1);
    expect(recovered.lines[0].firstDueDate).toBe("2026-10-10");
    await expect(submit(body)).rejects.toMatchObject({
      code: Code.REVISION_CONFLICT,
    });
  });
  it("null is explicit absence and does not remove an unresolved question or renew a no-op", async () => {
    const before = await row();
    now = new Date(now.getTime() + 5000);
    view = await submit(payload("firstDueDate", null));
    expect(await row()).toEqual(before);
    expect(view.questions.some((q) => q.field === "firstDueDate")).toBe(true);
    view = await submit(payload("tipoDespesa", null));
    expect(await row()).toEqual(before);
  });
  it("MAO_DE_OBRA never invents the required labor category", async () => {
    view = await submit(payload("tipoDespesa", ExpenseType.MAO_DE_OBRA));
    view = await submit(payload("firstDueDate", "2026-10-10"));
    view = await workflow.prepare(authenticated().auth, sessionId, {
      expectedRevision: view.revision,
    });
    expect(view.state).not.toBe("READY");
    expect(view.lines[0].categoriaMaoDeObra).toBeNull();
    expect(view.questions.some((q) => q.field === "categoriaMaoDeObra")).toBe(
      true,
    );
  });
  it("keeps legacy selection requests unchanged and provider-free", async () => {
    const actor = authenticated();
    ui.canActivate(context(actor.request));
    view = await controller.edit(actor.auth, sessionId, {
      expectedRevision: view.revision,
      questionId: null,
      replaceLines: [],
      selectedLineIds: [],
    });
    expect(view.selectedLineIds).toEqual([]);
    expect(chat).not.toHaveBeenCalled();
  });
  it("binds opaque grants to exact typed request, user, tenant, session, revision and question", async () => {
    const actor = authenticated();
    ui.canActivate(context(actor.request));
    const body = parseFocusedDraftAnswerRequest(
      payload("firstDueDate", "2026-10-10"),
    );
    const scope = focusedDraftAnswerScope(sessionId, body);
    const grant = issuer.issue(actor.request, actor.auth, scope);
    const before = await row();
    await expect(
      workflow.focusedDraftAnswer(actor.auth, sessionId, body, {}),
    ).rejects.toMatchObject({ code: Code.UI_ACTION_REQUIRED });
    await expect(
      workflow.focusedDraftAnswer(
        actor.auth,
        sessionId,
        { ...body, answer: { field: "firstDueDate", value: "2026-10-11" } },
        grant,
      ),
    ).rejects.toMatchObject({ code: Code.UI_ACTION_REQUIRED });
    await expect(
      workflow.focusedDraftAnswer(
        actor.auth,
        sessionId,
        { ...body, answerRequestId: randomUUID() },
        grant,
      ),
    ).rejects.toMatchObject({ code: Code.UI_ACTION_REQUIRED });
    await expect(
      workflow.focusedDraftAnswer(
        actor.auth,
        sessionId,
        { ...body, expectedRevision: body.expectedRevision + 1 },
        grant,
      ),
    ).rejects.toMatchObject({ code: Code.UI_ACTION_REQUIRED });
    await expect(
      workflow.focusedDraftAnswer(
        actor.auth,
        sessionId,
        { ...body, questionId: "other" },
        grant,
      ),
    ).rejects.toMatchObject({ code: Code.UI_ACTION_REQUIRED });
    await expect(
      workflow.focusedDraftAnswer(actor.auth, randomUUID(), body, grant),
    ).rejects.toMatchObject({ code: Code.UI_ACTION_REQUIRED });
    await expect(
      workflow.focusedDraftAnswer(
        authenticated(undefined, randomUUID()).auth,
        sessionId,
        body,
        grant,
      ),
    ).rejects.toMatchObject({ code: Code.UI_ACTION_REQUIRED });
    await expect(
      workflow.focusedDraftAnswer(
        authenticated(undefined, userId, randomUUID()).auth,
        sessionId,
        body,
        grant,
      ),
    ).rejects.toMatchObject({ code: Code.UI_ACTION_REQUIRED });
    expect(await row()).toEqual(before);
    view = await workflow.focusedDraftAnswer(
      actor.auth,
      sessionId,
      body,
      grant,
    );
    await expect(
      workflow.focusedDraftAnswer(actor.auth, sessionId, body, grant),
    ).rejects.toMatchObject({ code: Code.UI_ACTION_REQUIRED });
  });
  it("rejects expired grants and sessions, and rechecks revocation after admission", async () => {
    const actor = authenticated();
    ui.canActivate(context(actor.request));
    const body = parseFocusedDraftAnswerRequest(
      payload("tipoDespesa", ExpenseType.OUTROS),
    );
    const grant = issuer.issue(
      actor.request,
      actor.auth,
      focusedDraftAnswerScope(sessionId, body),
    );
    now = new Date(now.getTime() + 30001);
    await expect(
      workflow.focusedDraftAnswer(actor.auth, sessionId, body, grant),
    ).rejects.toMatchObject({ code: Code.UI_ACTION_REQUIRED });
    const admitted = authenticated();
    ui.canActivate(context(admitted.request));
    const freshGrant = issuer.issue(
      admitted.request,
      admitted.auth,
      focusedDraftAnswerScope(sessionId, body),
    );
    await prisma.user.update({
      where: { id: userId },
      data: { role: "USER", allowedProjects: JSON.stringify([randomUUID()]) },
    });
    try {
      await expect(
        workflow.focusedDraftAnswer(admitted.auth, sessionId, body, freshGrant),
      ).rejects.toMatchObject({ code: Code.NOT_FOUND });
    } finally {
      await prisma.user.update({
        where: { id: userId },
        data: { role: "ADMIN", allowedProjects: "[]" },
      });
    }
    await prisma.importSession.update({
      where: { id: sessionId },
      data: { expiresAt: now },
    });
    await expect(submit(body)).rejects.toMatchObject({
      code: Code.SESSION_EXPIRED,
    });
  });
  it("rejects an oq documentary subject or changed question without editing a draft field", async () => {
    const body = payload("firstDueDate", "2026-10-10");
    const otherQuestion = view.questions.find((q) => "subject" in q);
    if (!otherQuestion) throw Error("Missing fixture documentary question");
    await expect(
      submit({ ...body, questionId: otherQuestion.id }),
    ).rejects.toMatchObject({ code: Code.REVISION_CONFLICT });
    const draft = JSON.parse((await row()).draftJson);
    draft.questions = draft.questions.filter(
      (q: { id: string }) => q.id !== body.questionId,
    );
    await prisma.importSession.update({
      where: { id: sessionId },
      data: { draftJson: JSON.stringify(draft) },
    });
    const before = await row();
    await expect(submit(body)).rejects.toMatchObject({
      code: Code.REVISION_CONFLICT,
    });
    expect(await row()).toEqual(before);
  });
  it("equal non-null answer is a no-op and clearing a draft value keeps its question unresolved", async () => {
    view = await submit(payload("firstDueDate", "2026-10-11"));
    view = await workflow.prepare(authenticated().auth, sessionId, {
      expectedRevision: view.revision,
    });
    const before = await row();
    now = new Date(now.getTime() + 5000);
    view = await submit(payload("firstDueDate", "2026-10-11"));
    expect(await row()).toEqual(before);
    view = await submit(payload("firstDueDate", null));
    expect(view.lines[0].firstDueDate).toBeNull();
    expect(
      view.questions.some(
        (q) =>
          q.field === "firstDueDate" &&
          q.lineIds.includes(view.selectedLineIds[0]),
      ),
    ).toBe(true);
  });
});
