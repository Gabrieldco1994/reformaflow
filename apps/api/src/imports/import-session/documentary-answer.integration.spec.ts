import type { ExecutionContext } from "@nestjs/common";
import { GUARDS_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import type { Request } from "express";
import { createHash, randomUUID } from "node:crypto";
import {
  IMPORT_SESSION_CONSENT_POLICY_VERSION,
  ImportSessionErrorCode as Code,
  ProjectType,
  encodeImportDeclaration,
  type ImportDeclarationUiInputV1,
  type ImportHumanFactFieldV1,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import { PrismaService } from "../../prisma/prisma.service";
import { SERVICE_OWNED_PROJECT_ACCESS_KEY } from "../../common/decorators/service-owned-project-access.decorator";
import { extractCardStatementDocument } from "../../credit-card/parsers/statement-document";
import {
  ImportAuthGuard,
  readImportAuthForRequest,
} from "./import-session.auth";
import { DefaultImportSessionCapability } from "./import-session.capability";
import { ImportSessionController } from "./import-session.controller";
import { ImportSessionService } from "./import-session.service";
import { ImportSessionWorkflowService } from "./import-session-workflow.service";
import {
  ImportUiGrantIssuer,
  RuntimeUiGrantVerifier,
} from "./import-session-ui-grant";
import { ImportUiGuard } from "./import-session-ui.guard";
import type { AuthenticatedImportContext } from "./import-session.contract";
import {
  documentaryAnswerScope,
  parseDocumentaryAnswerRequest,
} from "./import-session.native-answer";

describe("native documentary answer (real guard, grant and locked writer)", () => {
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
  };
  const raw = { abortOwned: jest.fn() };
  const conversationalWrite = jest.spyOn(
    ImportSessionWorkflowService.prototype,
    "editConversationAnswer",
  );
  const batches = { prepare: jest.fn(), execute: jest.fn() };
  const service = new ImportSessionService(
    prisma,
    clock,
    capability,
    verifier,
    gate as never,
    raw as never,
  );
  const workflow = new ImportSessionWorkflowService(
    prisma,
    clock,
    capability,
    verifier,
    batches as never,
    gate as never,
    raw as never,
  );
  const controller = new ImportSessionController(
    service,
    issuer,
    capability,
    workflow,
  );
  const uiGuard = new ImportUiGuard(
    { allowed: () => ["http://localhost:3000"] },
    issuer,
  );
  let tenantId: string;
  let userId: string;
  let projectId: string;
  let cardId: string;
  let sessionId: string;
  let observationId: string;
  let artifactId: string;
  let view: ImportSessionViewV1;

  function context(request: object): ExecutionContext {
    return {
      switchToHttp: () => ({ getRequest: () => request }),
    } as ExecutionContext;
  }
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
  function body(
    field: ImportHumanFactFieldV1,
    input: ImportDeclarationUiInputV1,
  ): Record<string, unknown> {
    const question = view.questions.find(
      (q) => "subject" in q && q.field === field,
    );
    if (!question || !("subject" in question))
      throw new Error(`Missing ${field}`);
    const preview = encodeImportDeclaration(
      {
        field,
        meaningContext: question.subject.meaningContext,
        effectiveInstallmentCount: null,
      } as never,
      input,
    );
    if (preview.kind !== "ENCODED") throw new Error("Bad test preview");
    return {
      version: 1,
      answerRequestId: randomUUID(),
      expectedRevision: view.revision,
      questionId: question.id,
      input,
      answer: preview.answer,
    };
  }
  async function submit(
    payload: unknown,
    actor = authenticated(),
    guard = true,
  ): Promise<ImportSessionViewV1> {
    if (guard) uiGuard.canActivate(context(actor.request));
    return controller.documentaryAnswer(
      actor.request,
      actor.auth,
      sessionId,
      payload,
    );
  }
  const row = () =>
    prisma.importSession.findUniqueOrThrow({ where: { id: sessionId } });
  async function finance(): Promise<unknown> {
    return Promise.all([
      prisma.expense.count({ where: { tenantId } }),
      prisma.cashFlowEntry.count({ where: { tenantId } }),
      prisma.crossProjectSettlement.count({ where: { tenantId } }),
      prisma.rateioAllocation.count({ where: { tenantId } }),
      prisma.importObservation.findUniqueOrThrow({
        where: { id: observationId },
      }),
    ]);
  }

  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toMatch(/test(?:-worker-\d+)?\.db/);
    await prisma.$connect();
    tenantId = (
      await prisma.tenant.create({ data: { name: "native answer test" } })
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
    uiGuard.canActivate(context(actor.request));
    const create = {
      version: 1,
      createRequestId: randomUUID(),
      cardId,
      consentPolicyVersion: IMPORT_SESSION_CONSENT_POLICY_VERSION,
      consentAnalyze: true,
    };
    const grant = issuer.issue(actor.request, actor.auth, {
      operation: "CREATE_SESSION",
      cardId,
      createRequestId: create.createRequestId,
      consentPolicyVersion: create.consentPolicyVersion,
    });
    view = (await service.create(actor.auth, create, grant)).view;
    sessionId = view.id;
    const extraction = extractCardStatementDocument({
      version: 1,
      context: "CARD_INVOICE",
      format: "CSV",
      profile: "CSV_NUBANK",
      bytes: Buffer.from(
        "date,title,amount\n2026-10-01,original evidence,10.00\n",
      ),
    });
    const occurrence = extraction.occurrences[0];
    artifactId = (
      await prisma.importArtifact.create({
        data: {
          tenantId,
          ownerProjectId: projectId,
          documentSha256: createHash("sha256")
            .update(randomUUID())
            .digest("hex"),
          state: "EXTRACTED",
          detectedFormat: "CSV",
          verifiedBytes: 10,
          parserVersion: extraction.parserVersion,
          extractionJson: JSON.stringify(extraction),
        },
      })
    ).id;
    await prisma.importSessionArtifact.create({
      data: {
        tenantId,
        ownerProjectId: projectId,
        sessionId,
        artifactId,
        position: 0,
        fileName: "fixture.csv",
        declaredMime: "text/csv",
        declaredBytes: 10,
        reservedBytes: 0,
        state: "ATTACHED",
        verifiedAt: now,
      },
    });
    // Immutable incomplete parser evidence is the only direct documentary fixture.
    observationId = (
      await prisma.importObservation.create({
        data: {
          tenantId,
          ownerProjectId: projectId,
          artifactId,
          reference: occurrence.reference,
          evidenceJson: JSON.stringify({
            version: 1,
            reference: occurrence.reference,
            sourceDescription: occurrence.raw.description,
            text: "original evidence",
            amountMeaning: "UNKNOWN",
            amountCents: null,
            installmentCount: null,
            installmentIndex: null,
            dataCompra: null,
            identity: {
              merchant: null,
              externalId: null,
              fitId: null,
              ordinal: 1,
              fileContentHash: null,
            },
          }),
        },
      })
    ).id;
    await prisma.importSession.update({
      where: { id: sessionId },
      data: {
        draftJson: JSON.stringify({
          version: 1,
          lines: [
            {
              id: randomUUID(),
              observationIds: [observationId],
              titulo: "original evidence",
              fornecedor: null,
              tipoDespesa: null,
              categoriaMaoDeObra: null,
              amountMeaning: "UNKNOWN",
              amountCents: null,
              installmentCount: null,
              dataCompra: null,
              firstDueDate: null,
              targets: null,
              decision: { kind: "UNRESOLVED" },
            },
          ],
          selectedLineIds: [],
          questions: [],
          scope: { observationIds: [observationId], pendingAttachmentIds: [] },
        }),
      },
    });
    view = await service.getSession(actor.auth, sessionId);
  });
  afterEach(async () => {
    if (!sessionId) return;
    await prisma.$transaction(async (tx) => {
      await tx.importSessionArtifact.deleteMany({ where: { sessionId } });
      await tx.importSession.deleteMany({ where: { id: sessionId } });
      if (artifactId) {
        await tx.importObservation.deleteMany({ where: { artifactId } });
        await tx.importArtifact.deleteMany({ where: { id: artifactId } });
      }
    });
  });
  afterAll(async () => {
    await prisma.$transaction(async (tx) => {
      await tx.importSessionArtifact.deleteMany({ where: { tenantId } });
      await tx.importSession.deleteMany({ where: { tenantId } });
      await tx.importObservation.deleteMany({ where: { tenantId } });
      await tx.importArtifact.deleteMany({ where: { tenantId } });
      await tx.creditCard.deleteMany({ where: { tenantId } });
      await tx.project.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
    await prisma.$disconnect();
  });

  it("guided_answer_succeeds_with_llm_unavailable and changes only the focused declaration", async () => {
    const before = await row();
    const beforeFinance = await finance();
    const payload = body("merchant", {
      kind: "VALUE",
      text: "  LOJA FICTICIA NORTE  ",
    });
    view = await submit(payload);
    // No LLM/agent is composed at all; even chat admission must not be used.
    expect(conversationalWrite).not.toHaveBeenCalled();
    expect(batches.prepare).not.toHaveBeenCalled();
    expect(batches.execute).not.toHaveBeenCalled();
    expect(view.revision).toBe(before.revision + 1);
    expect(await finance()).toEqual(beforeFinance);
    const after = await row();
    const draft = JSON.parse(after.draftJson);
    const original = JSON.parse(before.draftJson);
    expect(draft.lines).toEqual(original.lines);
    expect(draft.selectedLineIds).toEqual(original.selectedLineIds);
    expect(draft.questions).toEqual(original.questions);
    expect(draft.declarations.items).toHaveLength(1);
    expect(draft.declarations.items[0]).toMatchObject({
      field: "merchant",
      value: "LOJA FICTICIA NORTE",
      turnId: payload.answerRequestId,
      attestedByUserId: userId,
      observationId,
      literalHash: createHash("sha256")
        .update("  LOJA FICTICIA NORTE  ")
        .digest("hex"),
    });
    expect(after.challengeJson).toBeNull();
    expect(after.financialRequestId).toBeNull();
    expect(after.receiptJson).toBeNull();
    expect(after.proposalJson).toBeNull();
    expect(after.draftJson).not.toContain("  LOJA FICTICIA NORTE  ");
  });
  it("exposes the native route only through the existing authenticated UI/service ACL boundary", () => {
    const handler = ImportSessionController.prototype.documentaryAnswer;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
      ":id/documentary-answer",
    );
    expect(
      Reflect.getMetadata(GUARDS_METADATA, ImportSessionController),
    ).toContain(ImportAuthGuard);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(
      ImportUiGuard,
    );
    expect(Reflect.getMetadata(SERVICE_OWNED_PROJECT_ACCESS_KEY, handler)).toBe(
      true,
    );
  });
  it.each(["", "0", "-1", "1,234.56", "não sei"])(
    "rejects invalid money literal %s",
    async (text) => {
      view = await submit(
        body("amountMeaning", { kind: "VALUE", text: "total da compra" }),
      );
      const payload = body("amountCents", { kind: "VALUE", text: "1.234,56" });
      payload.input = { kind: "VALUE", text };
      const before = await row();
      await expect(submit(payload)).rejects.toMatchObject({
        code: Code.INVALID_INPUT,
      });
      expect(await row()).toEqual(before);
    },
  );
  it("rejects non-NFC merchant without silently changing the accepted preview", async () => {
    const before = await row();
    await expect(
      submit(body("merchant", { kind: "VALUE", text: "LOJA CAFE\u0301" })),
    ).rejects.toMatchObject({ code: Code.INVALID_INPUT });
    expect(await row()).toEqual(before);
  });
  it("stores exact Brazilian money and date preview without guessing a year", async () => {
    view = await submit(
      body("amountMeaning", { kind: "VALUE", text: "total da compra" }),
    );
    view = await submit(
      body("amountCents", { kind: "VALUE", text: "1.234,56" }),
    );
    view = await submit(
      body("dataCompra", { kind: "VALUE", text: "2025-09-01" }),
    );
    const items = JSON.parse((await row()).draftJson).declarations.items;
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "amountCents",
          value: 123456,
          meaningContext: "TOTAL_PURCHASE",
        }),
        expect.objectContaining({ field: "dataCompra", value: "2025-09-01" }),
      ]),
    );
  });
  it("coalesces legacy questions with live documentary subjects and persists covered draft facts", async () => {
    const stored = await row();
    const draft = JSON.parse(stored.draftJson);
    const lineId = draft.lines[0].id;
    draft.questions = [
      "dataCompra",
      "amountMeaning",
      "amountCents",
      "installmentCount",
      "decision",
      "targets",
    ].map((field) => ({
      id: `legacy_${field}`,
      field,
      lineIds: [lineId],
      text: `Confirm ${field}`,
    }));
    await prisma.importSession.update({
      where: { id: sessionId },
      data: { draftJson: JSON.stringify(draft) },
    });
    view = await service.getSession(authenticated().auth, sessionId);
    expect(view.questions.find((q) => q.field === "dataCompra")).toHaveProperty(
      "subject",
    );
    expect(view.questions.filter((q) => q.field === "dataCompra")).toHaveLength(
      1,
    );
    view = await submit(
      body("dataCompra", { kind: "VALUE", text: "2025-09-01" }),
    );
    view = await submit(
      body("amountMeaning", { kind: "VALUE", text: "total da compra" }),
    );
    view = await submit(
      body("amountCents", { kind: "VALUE", text: "1.234,56" }),
    );
    view = await submit(body("installmentCount", { kind: "VALUE", text: "2" }));
    expect(view.lines[0]).toMatchObject({
      dataCompra: "2025-09-01",
      amountMeaning: "TOTAL_PURCHASE",
      amountCents: 123456,
      installmentCount: 2,
      decision: { kind: "UNRESOLVED" },
      targets: null,
    });
    expect(
      JSON.parse((await row()).draftJson).questions.map(
        (q: { field: string }) => q.field,
      ),
    ).toEqual(["decision", "targets"]);
    expect(
      view.questions.filter((q) => !("subject" in q)).map((q) => q.field),
    ).toEqual(["decision", "targets"]);
    const reload = await service.getSession(authenticated().auth, sessionId);
    expect(reload.questions).toEqual(view.questions);
  });
  it("does not coalesce an installment charge with a purchase-total draft question or overwrite a human draft value", async () => {
    const draft = JSON.parse((await row()).draftJson);
    const lineId = draft.lines[0].id;
    draft.lines[0].dataCompra = "2026-10-01";
    draft.questions = [
      {
        id: "legacy_amount",
        field: "amountCents",
        lineIds: [lineId],
        text: "Total",
      },
    ];
    await prisma.importSession.update({
      where: { id: sessionId },
      data: { draftJson: JSON.stringify(draft) },
    });
    view = await service.getSession(authenticated().auth, sessionId);
    view = await submit(
      body("dataCompra", { kind: "VALUE", text: "2025-09-01" }),
    );
    expect(view.lines[0].dataCompra).toBe("2026-10-01");
    view = await submit(
      body("amountMeaning", { kind: "VALUE", text: "valor da parcela" }),
    );
    view = await submit(body("amountCents", { kind: "VALUE", text: "10,01" }));
    expect(view.lines[0].amountCents).toBeNull();
    expect(view.questions.find((q) => q.id === "legacy_amount")).toBeDefined();
  });
  it("updates only an inherited draft fact on correction and keeps null declarations unresolved", async () => {
    const draft = JSON.parse((await row()).draftJson);
    draft.questions = [
      {
        id: "legacy_date",
        field: "dataCompra",
        lineIds: [draft.lines[0].id],
        text: "Date",
      },
    ];
    await prisma.importSession.update({
      where: { id: sessionId },
      data: { draftJson: JSON.stringify(draft) },
    });
    view = await service.getSession(authenticated().auth, sessionId);
    view = await submit(
      body("dataCompra", { kind: "VALUE", text: "2025-09-01" }),
    );
    view = await submit(
      body("dataCompra", { kind: "VALUE", text: "2025-09-02" }),
    );
    expect(view.lines[0].dataCompra).toBe("2025-09-02");
    view = await submit(body("dataCompra", { kind: "REMOVE" }));
    expect(view.lines[0].dataCompra).toBeNull();
    expect(view.questions.find((q) => q.field === "dataCompra")).toMatchObject({
      answerState: "UNKNOWN",
    });
    expect(
      view.declaredFacts.find((f) => f.field === "dataCompra"),
    ).toMatchObject({ value: null, status: "UNKNOWN" });
  });
  it("preserves unqualified grouped draft questions without changing their admitted scope", async () => {
    const draft = JSON.parse((await row()).draftJson);
    const otherLine = {
      ...draft.lines[0],
      id: randomUUID(),
      observationIds: [...draft.lines[0].observationIds],
    };
    // A question can span several lines, but this fixture must not reuse observation ownership.
    // Use two generic line IDs with only one materialized documentary match by retaining
    // the second as a legitimate existing line without an applicable date declaration.
    const observation = await prisma.importObservation.findUniqueOrThrow({
      where: { id: observationId },
    });
    const { id: _id, ...data } = observation;
    const other = await prisma.importObservation.create({
      data: {
        ...data,
        id: randomUUID(),
        reference: "other:1",
        evidenceJson: JSON.stringify({
          ...JSON.parse(observation.evidenceJson),
          reference: "other:1",
        }),
      },
    });
    otherLine.observationIds = [other.id];
    draft.lines.push(otherLine);
    draft.scope.observationIds.push(other.id);
    draft.questions = [
      {
        id: "group_date",
        field: "dataCompra",
        lineIds: draft.lines.map((l: { id: string }) => l.id),
        text: "Group date",
      },
    ];
    await prisma.importSession.update({
      where: { id: sessionId },
      data: { draftJson: JSON.stringify(draft) },
    });
    // Adding an unrelated parser observation to this qualified artifact invalidates its
    // scoped mutation capability, but authorized projection must preserve the exact group.
    view = await service.getSession(authenticated().auth, sessionId);
    expect(view.questions.find((q) => q.id === "group_date")).toMatchObject({
      lineIds: draft.questions[0].lineIds,
    });
  });
  it.each([
    { version: 2 },
    { extra: true },
    { answerRequestId: "not-a-uuid" },
    { input: { kind: "VALUE", text: "2025-02-30" } },
    { input: { kind: "VALUE", text: "2025-09-01", extra: true } },
    { input: { kind: "UNKNOWN", text: "ignored" } },
    { input: { kind: "bogus" } },
    {
      answer: {
        field: "dataCompra",
        value: "2025-09-02",
        meaningContext: null,
      },
    },
    {
      answer: {
        field: "dataCompra",
        value: "2025-09-01",
        meaningContext: null,
        extra: true,
      },
    },
    { answer: { field: "targets", value: [], meaningContext: null } },
  ])(
    "rejects preview mismatch or malformed envelope %j without mutation",
    async (patch) => {
      const before = await row();
      await expect(
        submit({
          ...body("dataCompra", { kind: "VALUE", text: "2025-09-01" }),
          ...patch,
        }),
      ).rejects.toMatchObject({ code: Code.INVALID_INPUT });
      expect(await row()).toEqual(before);
    },
  );
  it.each(["0", "-1", "9999999", "2.5"])(
    "rejects invalid installment count %s",
    async (text) => {
      const payload = body("installmentCount", { kind: "VALUE", text: "2" });
      payload.input = { kind: "VALUE", text };
      await expect(submit(payload)).rejects.toMatchObject({
        code: Code.INVALID_INPUT,
      });
    },
  );
  it("rejects one-cent mismatch and invalid meaning enum", async () => {
    view = await submit(
      body("amountMeaning", { kind: "VALUE", text: "total da compra" }),
    );
    const payload = body("amountCents", { kind: "VALUE", text: "1.234,56" });
    payload.answer = {
      field: "amountCents",
      value: 123457,
      meaningContext: "TOTAL_PURCHASE",
    };
    await expect(submit(payload)).rejects.toMatchObject({
      code: Code.INVALID_INPUT,
    });
    const meaning = body("amountMeaning", {
      kind: "VALUE",
      text: "total da compra",
    });
    meaning.answer = {
      field: "amountMeaning",
      value: "UNKNOWN",
      meaningContext: null,
    };
    await expect(submit(meaning)).rejects.toMatchObject({
      code: Code.INVALID_INPUT,
    });
  });
  it("rejects stale revision, question and original fingerprint", async () => {
    const payload = body("dataCompra", { kind: "VALUE", text: "2025-09-01" });
    await expect(
      submit({ ...payload, expectedRevision: view.revision + 1 }),
    ).rejects.toMatchObject({ code: Code.REVISION_CONFLICT });
    await expect(
      submit({ ...payload, questionId: "oq_" + "a".repeat(64) }),
    ).rejects.toMatchObject({ code: Code.REVISION_CONFLICT });
    await prisma.importArtifact.update({
      where: { id: artifactId },
      data: { documentSha256: "b".repeat(64) },
    });
    await expect(submit(payload)).rejects.toMatchObject({
      code: Code.REVISION_CONFLICT,
    });
  });
  it("rejects changed claim version and money meaning context", async () => {
    const payload = body("merchant", { kind: "VALUE", text: "LOJA" });
    await prisma.importObservation.update({
      where: { id: observationId },
      data: { claimVersion: { increment: 1 } },
    });
    await expect(submit(payload)).rejects.toMatchObject({
      code: Code.REVISION_CONFLICT,
    });
  });
  it("requires real UI origin/header and grant, never a body flag", async () => {
    const payload = body("dataCompra", { kind: "VALUE", text: "2025-09-01" });
    await expect(submit(payload, authenticated({}))).rejects.toMatchObject({
      code: Code.UI_ACTION_REQUIRED,
    });
    await expect(
      submit(
        payload,
        authenticated({
          origin: "https://evil.invalid",
          "x-rf-import-ui": "1",
        }),
      ),
    ).rejects.toMatchObject({ code: Code.UI_ACTION_REQUIRED });
    await expect(submit(payload, authenticated(), false)).rejects.toMatchObject(
      { code: Code.UI_ACTION_REQUIRED },
    );
  });
  it("reauthorizes cross-user, tenant and revoked project permissions", async () => {
    const payload = body("merchant", { kind: "VALUE", text: "LOJA" });
    const other = (
      await prisma.user.create({
        data: {
          tenantId,
          username: randomUUID(),
          name: "other",
          role: "ADMIN",
        },
      })
    ).id;
    await expect(
      submit(payload, authenticated(undefined, other)),
    ).rejects.toBeDefined();
    await expect(
      submit(payload, authenticated(undefined, userId, randomUUID())),
    ).rejects.toBeDefined();
    await prisma.user.update({
      where: { id: userId },
      data: { role: "USER", allowedProjects: JSON.stringify([randomUUID()]) },
    });
    try {
      await expect(submit(payload)).rejects.toMatchObject({
        code: Code.NOT_FOUND,
      });
    } finally {
      await prisma.user.update({
        where: { id: userId },
        data: { role: "ADMIN", allowedProjects: "[]" },
      });
    }
  });
  it("binds the opaque grant to exact input, session, revision, question, tenant and user", async () => {
    const actor = authenticated();
    uiGuard.canActivate(context(actor.request));
    const payload = parseDocumentaryAnswerRequest(
      body("merchant", { kind: "VALUE", text: "LOJA" }),
    );
    const scope = documentaryAnswerScope(sessionId, payload);
    const grant = issuer.issue(actor.request, actor.auth, scope);
    const before = await row();
    await expect(
      workflow.documentaryAnswer(actor.auth, sessionId, payload, {}),
    ).rejects.toMatchObject({ code: Code.UI_ACTION_REQUIRED });
    const changed = {
      ...payload,
      input: { kind: "VALUE" as const, text: " LOJA " },
    };
    await expect(
      workflow.documentaryAnswer(actor.auth, sessionId, changed, grant),
    ).rejects.toMatchObject({ code: Code.UI_ACTION_REQUIRED });
    await expect(
      workflow.documentaryAnswer(actor.auth, randomUUID(), payload, grant),
    ).rejects.toMatchObject({ code: Code.UI_ACTION_REQUIRED });
    await expect(
      workflow.documentaryAnswer(
        authenticated(undefined, randomUUID()).auth,
        sessionId,
        payload,
        grant,
      ),
    ).rejects.toMatchObject({ code: Code.UI_ACTION_REQUIRED });
    await expect(
      workflow.documentaryAnswer(
        authenticated(undefined, userId, randomUUID()).auth,
        sessionId,
        payload,
        grant,
      ),
    ).rejects.toMatchObject({ code: Code.UI_ACTION_REQUIRED });
    await expect(
      workflow.documentaryAnswer(
        actor.auth,
        sessionId,
        { ...payload, expectedRevision: payload.expectedRevision + 1 },
        grant,
      ),
    ).rejects.toMatchObject({ code: Code.UI_ACTION_REQUIRED });
    expect(await row()).toEqual(before);
    view = await workflow.documentaryAnswer(
      actor.auth,
      sessionId,
      payload,
      grant,
    );
    await expect(
      workflow.documentaryAnswer(actor.auth, sessionId, payload, grant),
    ).rejects.toMatchObject({ code: Code.UI_ACTION_REQUIRED });
  });
  it("strictly parses before minting a persistence grant", async () => {
    const issue = jest.spyOn(issuer, "issue");
    issue.mockClear();
    await expect(
      submit({
        ...body("merchant", { kind: "VALUE", text: "LOJA" }),
        extra: true,
      }),
    ).rejects.toMatchObject({ code: Code.INVALID_INPUT });
    expect(issue).not.toHaveBeenCalled();
    issue.mockRestore();
  });
  it("rejects expired grant and expired session", async () => {
    const actor = authenticated();
    uiGuard.canActivate(context(actor.request));
    const payload = parseDocumentaryAnswerRequest(
      body("merchant", { kind: "VALUE", text: "LOJA" }),
    );
    const grant = issuer.issue(
      actor.request,
      actor.auth,
      documentaryAnswerScope(sessionId, payload),
    );
    now = new Date(now.getTime() + 30001);
    await expect(
      workflow.documentaryAnswer(actor.auth, sessionId, payload, grant),
    ).rejects.toMatchObject({ code: Code.UI_ACTION_REQUIRED });
    await prisma.importSession.update({
      where: { id: sessionId },
      data: { expiresAt: now },
    });
    await expect(submit(payload)).rejects.toMatchObject({
      code: Code.SESSION_EXPIRED,
    });
  });
  it("validates installment index against the server's effective count", async () => {
    view = await submit(body("installmentCount", { kind: "VALUE", text: "2" }));
    await expect(
      submit(body("installmentIndex", { kind: "VALUE", text: "3" })),
    ).rejects.toMatchObject({ code: Code.INVALID_INPUT });
    view = await submit(body("installmentIndex", { kind: "VALUE", text: "2" }));
    expect(view.declaredFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "installmentIndex", value: 2 }),
      ]),
    );
  });
  it("rejects stale money meaning even when a caller uses the current revision", async () => {
    view = await submit(
      body("amountMeaning", { kind: "VALUE", text: "total da compra" }),
    );
    const payload = body("amountCents", { kind: "VALUE", text: "1.234,56" });
    view = await submit(
      body("amountMeaning", { kind: "VALUE", text: "valor da parcela" }),
    );
    await expect(
      submit({ ...payload, expectedRevision: view.revision }),
    ).rejects.toMatchObject({ code: Code.REVISION_CONFLICT });
  });
  it("concurrent answers from one revision have at most one winner; GET recovers a lost response", async () => {
    const payload = body("merchant", { kind: "VALUE", text: "LOJA" });
    const results = await Promise.allSettled([
      submit(payload),
      submit(payload),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(JSON.parse((await row()).draftJson).declarations.items).toHaveLength(
      1,
    );
    const recovered = await service.getSession(authenticated().auth, sessionId);
    expect(recovered.revision).toBe(view.revision + 1);
    await expect(submit(payload)).rejects.toMatchObject({
      code: Code.REVISION_CONFLICT,
    });
  });
  it("no-op keeps expiry, revision and audit unchanged", async () => {
    view = await submit(body("merchant", { kind: "VALUE", text: "LOJA" }));
    const before = await row();
    now = new Date(now.getTime() + 5000);
    view = await submit(body("merchant", { kind: "VALUE", text: "LOJA" }));
    expect(await row()).toEqual(before);
    expect(view.revision).toBe(before.revision);
  });
  it.each(["UNKNOWN", "REMOVE"] as const)(
    "explicit %s records null and keeps question unresolved",
    async (kind) => {
      view = await submit(body("merchant", { kind }));
      expect(
        JSON.parse((await row()).draftJson).declarations.items[0],
      ).toMatchObject({ field: "merchant", value: null });
      expect(
        view.questions.find((q) => q.field === "merchant" && "subject" in q),
      ).toMatchObject({ answerState: "UNKNOWN" });
    },
  );
});
