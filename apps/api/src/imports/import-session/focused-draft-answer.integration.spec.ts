import type { ExecutionContext } from "@nestjs/common";
import { GUARDS_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import type { Request } from "express";
import { createHash, randomUUID } from "node:crypto";
import {
  IMPORT_SESSION_CONSENT_POLICY_VERSION,
  ExpenseType,
  ExpenseStatus,
  LaborCategory,
  ImportSessionAmountMeaning,
  PaymentForm,
  ImportSessionErrorCode as Code,
  ProjectType,
  encodeImportDeclaration,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import { PrismaService } from "../../prisma/prisma.service";
import { ConciliacaoService } from "../../conciliacao/conciliacao.service";
import { ExpenseService } from "../../expense/expense.service";
import { extractCardStatementDocument } from "../../credit-card/parsers/statement-document";
import { dedupeKeyNatural } from "../../credit-card/parsers/dedupe-key";
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
  let tenantId: string;
  let userId: string;
  let projectId: string;
  let cardId: string;
  let sessionId: string;
  let artifactId: string;
  let view: ImportSessionViewV1;
  function moneyLiteral(cents: number): string {
    const reais = Math.floor(cents / 100);
    return `${reais},${String(cents % 100).padStart(2, "0")}`;
  }
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
    field:
      | "amountMeaning"
      | "amountCents"
      | "installmentCount"
      | "dataCompra"
      | "firstDueDate"
      | "tipoDespesa"
      | "categoriaMaoDeObra"
      | "decision"
      | "targets",
    value: unknown,
  ): Record<string, unknown> {
    const question = view.questions.find(
      (q) =>
        q.field === field &&
        !("subject" in q) &&
        q.lineIds.includes(view.selectedLineIds[0]),
    );
    if (!question) throw Error("Missing focused question");
    const answer =
      field === "amountMeaning" ||
      field === "amountCents" ||
      field === "installmentCount" ||
      field === "dataCompra" ||
      field === "firstDueDate"
        ? { field, literal: String(value), value }
        : field === "targets" && Array.isArray(value) && value.length === 0
          ? { field, value: { kind: "NO_TARGETS" } }
          : { field, value };
    return {
      version: 1,
      answerRequestId: randomUUID(),
      expectedRevision: view.revision,
      questionId: question.id,
      channel: "TEXT" as const,
      answer,
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
      prisma.expense.count({ where: { tenantId, deletedAt: null } }),
      prisma.cashFlowEntry.count({ where: { tenantId, deletedAt: null } }),
      prisma.receipt.count({ where: { tenantId, deletedAt: null } }),
      prisma.rateioAllocation.count({ where: { tenantId } }),
      prisma.crossProjectSettlement.count({ where: { tenantId } }),
      prisma.importedInvoiceLiquidation.count({ where: { tenantId } }),
    ]);
  async function installSingleLineQuestion(
    field:
      | "amountMeaning"
      | "amountCents"
      | "installmentCount"
      | "dataCompra"
      | "categoriaMaoDeObra"
      | "targets",
    currentValue: unknown,
  ): Promise<void> {
    const stored = await row();
    const draft = JSON.parse(stored.draftJson);
    const first = draft.lines[0];
    const observationIds = draft.lines.flatMap(
      (line: { observationIds: string[] }) => line.observationIds,
    );
    const question = {
      id: randomUUID(),
      lineIds: [first.id],
      field,
      text: `Fixture ${field}`,
    };
    draft.lines = [
      {
        ...first,
        observationIds,
        [field]: currentValue,
      },
    ];
    draft.selectedLineIds = [first.id];
    draft.questions = [question];
    await prisma.importSession.update({
      where: { id: sessionId },
      data: {
        state: "NEEDS_INPUT",
        draftJson: JSON.stringify(draft),
        searchJson: null,
        proposalJson: null,
        proposalHash: null,
        preflightHash: null,
        challengeJson: null,
      },
    });
    view = await service.getSession(authenticated().auth, sessionId);
    expect(view.questions).toContainEqual(expect.objectContaining(question));
  }
  beforeEach(async () => {
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
      data: {
        draftJson: JSON.stringify({
          ...material.draft,
          lines: readyLines,
          selectedLineIds: [readyLines[0].id],
        }),
      },
    });
    view = await workflow.edit(actor.auth, sessionId, {
      expectedRevision: view.revision,
      questionId: null,
      replaceLines: [],
      selectedLineIds: [readyLines[0].id],
    });
    view = await service.getSession(actor.auth, sessionId);
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
        channel: "TEXT" as const,
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
      await tx.importSessionArtifact.deleteMany({ where: { tenantId } });
      await tx.importObservation.deleteMany({ where: { tenantId } });
      await tx.importSession.deleteMany({ where: { tenantId } });
      await tx.importArtifact.deleteMany({ where: { tenantId } });
      await tx.cashFlowEntry.deleteMany({ where: { tenantId } });
      await tx.expense.deleteMany({ where: { tenantId } });
      await tx.receipt.deleteMany({ where: { tenantId } });
    });
  });
  afterEach(async () => {
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
  it("uses the existing UI-guarded PATCH draft route and direct prepare/result APIs", async () => {
    const edit = ImportSessionController.prototype.edit;
    expect(Reflect.getMetadata(PATH_METADATA, edit)).toBe(":id/draft");
    expect(Reflect.getMetadata(GUARDS_METADATA, edit)).toContain(ImportUiGuard);
    await pendingChoices();
    view = await submit(
      payload("decision", { kind: "CREATE", acceptNaturalDuplicate: false }),
    );
    view = await submit(payload("targets", []));
    view = await controller.prepare(authenticated().auth, sessionId, {
      expectedRevision: view.revision,
    });
    expect(view.state).toBe("READY");
    await expect(
      controller.getResult(authenticated().auth, sessionId),
    ).resolves.toEqual({ state: "READY", receipt: null });
  });
  it.each([
    "pending-question replacement",
    "questionId null nonempty replacement",
    "duplicate waiver",
    "owner-project target",
    "non-REFORMA target",
    "cross-project room target",
  ] as const)("rejects legacy PATCH %s without mutation", async (attack) => {
    const first = view.lines[0];
    const question = view.questions.find(
      (item) =>
        !("subject" in item) &&
        item.lineIds.includes(first.id) &&
        item.field === "firstDueDate",
    );
    if (!question) throw Error("Missing pending first-due-date question");
    const temporaryProjectIds: string[] = [];
    let targetProjectId: string = randomUUID();
    let targetRoomId: string | null = null;
    if (attack === "non-REFORMA target") {
      targetProjectId = (
        await prisma.project.create({
          data: {
            tenantId,
            name: "Ineligible car target",
            type: ProjectType.CARRO,
          },
        })
      ).id;
      temporaryProjectIds.push(targetProjectId);
    }
    if (attack === "cross-project room target") {
      const target = await prisma.project.create({
        data: {
          tenantId,
          name: "Eligible target",
          type: ProjectType.REFORMA,
        },
      });
      const roomOwner = await prisma.project.create({
        data: {
          tenantId,
          name: "Different room owner",
          type: ProjectType.REFORMA,
        },
      });
      targetProjectId = target.id;
      targetRoomId = (
        await prisma.room.create({
          data: { projectId: roomOwner.id, name: "Foreign room" },
        })
      ).id;
      temporaryProjectIds.push(target.id, roomOwner.id);
    }
    const questionId =
      attack === "pending-question replacement" ? question.id : null;
    const line =
      attack === "pending-question replacement"
        ? { ...first, firstDueDate: "2026-10-10" }
        : attack === "questionId null nonempty replacement"
          ? { ...first, titulo: "Caller-controlled title" }
          : attack === "duplicate waiver"
            ? {
                ...first,
                decision: {
                  kind: "CREATE" as const,
                  acceptNaturalDuplicate: true,
                },
              }
            : {
                ...first,
                targets: [
                  {
                    projectId:
                      attack === "owner-project target"
                        ? projectId
                        : targetProjectId,
                    roomId: targetRoomId,
                    amountCents: first.amountCents!,
                  },
                ],
              };
    const before = await row();
    try {
      await expect(
        workflow.edit(authenticated().auth, sessionId, {
          expectedRevision: before.revision,
          questionId,
          replaceLines: [line],
          selectedLineIds: view.selectedLineIds,
        }),
      ).rejects.toMatchObject({ code: Code.INVALID_INPUT });
      expect(await row()).toEqual(before);
      expect(await finance()).toEqual([0, 0, 0, 0, 0, 0]);
    } finally {
      if (targetRoomId)
        await prisma.$executeRaw`DELETE FROM rooms WHERE id = ${targetRoomId}`;
      for (const id of temporaryProjectIds)
        await prisma.$executeRaw`DELETE FROM projects WHERE id = ${id}`;
    }
  });
  it("keeps legacy PATCH selection-only with an empty replaceLines array", async () => {
    const second = view.lines[1];
    const beforeSelection = await row();
    const selected = await workflow.edit(authenticated().auth, sessionId, {
      expectedRevision: beforeSelection.revision,
      questionId: null,
      replaceLines: [],
      selectedLineIds: [second.id],
    });
    expect(selected.revision).toBe(beforeSelection.revision + 1);
    expect(selected.selectedLineIds).toEqual([second.id]);
    expect(selected.lines).toEqual(view.lines);
    expect(JSON.parse((await row()).draftJson).lines).toEqual(view.lines);
    expect(await finance()).toEqual([0, 0, 0, 0, 0, 0]);
  });
  it("reimports a mixed claimed/unclaimed artifact through the direct workflow only", async () => {
    const claimedLine = view.lines[0];
    const eligibleLine = view.lines[1];
    const canonicalExpense = await prisma.expense.create({
      data: {
        tenantId,
        projectId,
        tipoDespesa: ExpenseType.OUTROS,
        valor: claimedLine.amountCents!,
        valorTotal: claimedLine.amountCents!,
        quantidade: 1,
        titulo: "Already applied",
        fornecedor: claimedLine.fornecedor,
        formaPagamento: PaymentForm.A_VISTA,
        dataCompra: new Date(`${claimedLine.dataCompra}T00:00:00.000Z`),
        dataPagamento: new Date("2026-10-10T00:00:00.000Z"),
        status: ExpenseStatus.PLANEJADO,
      },
    });
    const claimed = await prisma.importObservation.update({
      where: { id: claimedLine.observationIds[0] },
      data: {
        evidenceJson: "{}",
        claimVersion: 1,
        canonicalProjectId: projectId,
        canonicalExpenseId: canonicalExpense.id,
        canonicalIndex: 0,
        claimSessionId: sessionId,
        claimReceiptJson: JSON.stringify({
          kind: "SESSION",
          sessionId,
          financialRequestId: randomUUID(),
        }),
        claimedAt: now,
      },
    });
    const actor = authenticated();
    ui.canActivate(context(actor.request));
    const createRequestId = randomUUID();
    const reimport = await service.create(
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
    );
    const reimportRow = await prisma.importSession.findUniqueOrThrow({
      where: { id: reimport.view.id },
    });
    const sourceArtifact = await prisma.importArtifact.findUniqueOrThrow({
      where: { id: artifactId },
    });
    const ref = await prisma.importSessionArtifact.create({
      data: {
        tenantId,
        ownerProjectId: projectId,
        sessionId: reimport.view.id,
        artifactId,
        position: 0,
        fileName: "mixed-reimport.csv",
        declaredMime: "text/csv",
        declaredBytes: sourceArtifact.verifiedBytes!,
        reservedBytes: 0,
        state: "ATTACHED",
        verifiedAt: now,
      },
    });
    const observations = await prisma.importObservation.findMany({
      where: { artifactId },
    });
    const extraction = JSON.parse(sourceArtifact.extractionJson!);
    const material = buildImportMaterialization({
      session: reimportRow,
      attachment: ref,
      artifact: sourceArtifact,
      extraction,
      observations,
      draft: {
        ...JSON.parse(EMPTY_DRAFT_JSON),
        scope: { observationIds: [], pendingAttachmentIds: [ref.id] },
      },
      newIds: new Map(
        extraction.occurrences.map((occurrence: { reference: string }) => [
          occurrence.reference,
          { observationId: randomUUID(), lineId: randomUUID() },
        ]),
      ),
    });
    expect(material.observations).toEqual([]);
    expect(material.draft.lines).toHaveLength(1);
    expect(material.draft.lines[0].observationIds).toEqual(
      eligibleLine.observationIds,
    );
    expect(JSON.stringify(material.draft)).not.toContain(claimed.id);
    await prisma.importSession.update({
      where: { id: reimport.view.id },
      data: { draftJson: JSON.stringify(material.draft) },
    });

    const directView = await service.getSession(actor.auth, reimport.view.id);
    const selected = await workflow.edit(actor.auth, reimport.view.id, {
      expectedRevision: directView.revision,
      questionId: null,
      replaceLines: [],
      selectedLineIds: [directView.lines[0].id],
    });
    expect(selected.lines).toEqual(directView.lines);
    expect(selected.selectedLineIds).toEqual([directView.lines[0].id]);
    const beforeAttack = await prisma.importSession.findUniqueOrThrow({
      where: { id: reimport.view.id },
    });
    await expect(
      workflow.edit(actor.auth, reimport.view.id, {
        expectedRevision: selected.revision,
        questionId: null,
        replaceLines: [
          {
            ...directView.lines[0],
            id: claimedLine.id,
            observationIds: [claimed.id],
          },
        ],
        selectedLineIds: [claimedLine.id],
      }),
    ).rejects.toMatchObject({ code: Code.INVALID_INPUT });
    expect(
      await prisma.importSession.findUniqueOrThrow({
        where: { id: reimport.view.id },
      }),
    ).toEqual(beforeAttack);
    expect(
      await prisma.importObservation.findUniqueOrThrow({
        where: { id: claimed.id },
      }),
    ).toEqual(claimed);
    expect(
      await prisma.expense.findUniqueOrThrow({
        where: { id: canonicalExpense.id },
      }),
    ).toEqual(canonicalExpense);
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
    { answer: { field: "targets", value: null } },
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
  it.each([
    {
      field: "amountMeaning",
      current: ImportSessionAmountMeaning.UNKNOWN,
      literal: "valor da parcela",
      value: ImportSessionAmountMeaning.INSTALLMENT_CHARGE,
    },
    {
      field: "amountCents",
      current: 1,
      literal: "o valor é R$ 206,96",
      value: 20696,
    },
    {
      field: "installmentCount",
      current: 2,
      literal: "foram 3 parcelas",
      value: 3,
    },
    {
      field: "dataCompra",
      current: "2026-09-09",
      literal: "a compra foi em 10/10/2026",
      value: "2026-10-10",
    },
  ] as const)(
    "reparses the whole $field literal inside the locked writer",
    async ({ field, current, literal, value }) => {
      await installSingleLineQuestion(field, current);
      const before = await row();
      const body = payload(field, value);
      (
        body.answer as {
          field: string;
          literal: string;
          value: unknown;
        }
      ).literal = literal;
      view = await submit(body);
      expect(view.lines[0][field]).toBe(value);
      expect((await row()).revision).toBe(before.revision + 1);
      expect(await finance()).toEqual([0, 0, 0, 0, 0, 0]);
    },
  );
  it("stores an exact labor enum and no other field", async () => {
    await installSingleLineQuestion("categoriaMaoDeObra", null);
    const before = await row();
    const draft = JSON.parse(before.draftJson);
    view = await submit(
      payload("categoriaMaoDeObra", LaborCategory.ELETRICISTA),
    );
    expect(view.lines[0]).toEqual({
      ...draft.lines[0],
      categoriaMaoDeObra: LaborCategory.ELETRICISTA,
    });
    expect((await row()).revision).toBe(before.revision + 1);
    expect(await finance()).toEqual([0, 0, 0, 0, 0, 0]);
  });
  it("accepts only one authorized integral REFORMA target and rechecks room state", async () => {
    const reforma = await prisma.project.create({
      data: { tenantId, name: "target", type: ProjectType.REFORMA },
    });
    const room = await prisma.room.create({
      data: { projectId: reforma.id, name: "cozinha" },
    });
    await installSingleLineQuestion("targets", null);
    const value = {
      kind: "TARGET" as const,
      projectId: reforma.id,
      roomId: room.id,
      amountCents: view.lines[0].amountCents!,
      literal: moneyLiteral(view.lines[0].amountCents!),
    };
    const body = payload("targets", value);
    const actor = authenticated();
    ui.canActivate(context(actor.request));
    const request = parseFocusedDraftAnswerRequest(body);
    const grant = issuer.issue(
      actor.request,
      actor.auth,
      focusedDraftAnswerScope(sessionId, request),
    );
    await prisma.room.update({
      where: { id: room.id },
      data: { deletedAt: now },
    });
    await expect(
      workflow.focusedDraftAnswer(actor.auth, sessionId, request, grant),
    ).rejects.toMatchObject({ code: Code.INVALID_INPUT });
    await prisma.room.update({
      where: { id: room.id },
      data: { deletedAt: null },
    });
    await prisma.project.update({
      where: { id: reforma.id },
      data: { deletedAt: now },
    });
    try {
      await expect(submit(body)).rejects.toMatchObject({
        code: Code.INVALID_INPUT,
      });
    } finally {
      await prisma.project.update({
        where: { id: reforma.id },
        data: { deletedAt: null },
      });
    }
    view = await submit(payload("targets", value));
    expect(view.lines[0].targets).toEqual([
      {
        projectId: reforma.id,
        roomId: room.id,
        amountCents: value.amountCents,
      },
    ]);
    await prisma.project.update({
      where: { id: reforma.id },
      data: { deletedAt: now },
    });
    try {
      await expect(
        workflow.prepare(actor.auth, sessionId, {
          expectedRevision: view.revision,
        }),
      ).rejects.toMatchObject({ code: Code.NOT_FOUND });
    } finally {
      await prisma.project.update({
        where: { id: reforma.id },
        data: { deletedAt: null },
      });
    }
    expect(await finance()).toEqual([0, 0, 0, 0, 0, 0]);
  });
  it("rejects a cross-tenant target and a room outside the locked target project", async () => {
    const target = await prisma.project.create({
      data: { tenantId, name: "locked target", type: ProjectType.REFORMA },
    });
    const otherProject = await prisma.project.create({
      data: { tenantId, name: "other room owner", type: ProjectType.REFORMA },
    });
    const otherRoom = await prisma.room.create({
      data: { projectId: otherProject.id, name: "foreign room" },
    });
    const foreignTenant = await prisma.tenant.create({
      data: { name: "foreign target tenant" },
    });
    const foreignProject = await prisma.project.create({
      data: {
        tenantId: foreignTenant.id,
        name: "foreign target",
        type: ProjectType.REFORMA,
      },
    });
    await installSingleLineQuestion("targets", null);
    const amountCents = view.lines[0].amountCents!;
    const before = await row();
    try {
      await expect(
        submit(
          payload("targets", {
            kind: "TARGET",
            projectId: target.id,
            roomId: otherRoom.id,
            amountCents,
            literal: moneyLiteral(amountCents),
          }),
        ),
      ).rejects.toMatchObject({ code: Code.INVALID_INPUT });
      await expect(
        submit(
          payload("targets", {
            kind: "TARGET",
            projectId: foreignProject.id,
            roomId: null,
            amountCents,
            literal: moneyLiteral(amountCents),
          }),
        ),
      ).rejects.toMatchObject({ code: Code.INVALID_INPUT });
      expect(await row()).toEqual(before);
    } finally {
      await prisma.room.deleteMany({ where: { id: otherRoom.id } });
      await prisma.project.deleteMany({
        where: { id: { in: [foreignProject.id] } },
      });
      await prisma.tenant.deleteMany({ where: { id: foreignTenant.id } });
    }
  });
  it("rejects the owner project as its own target even when it is a live REFORMA", async () => {
    await installSingleLineQuestion("targets", null);
    await prisma.project.update({
      where: { id: projectId },
      data: { type: ProjectType.REFORMA },
    });
    const amountCents = view.lines[0].amountCents!;
    const before = await row();
    try {
      await expect(
        submit(
          payload("targets", {
            kind: "TARGET",
            projectId,
            roomId: null,
            amountCents,
            literal: moneyLiteral(amountCents),
          }),
        ),
      ).rejects.toMatchObject({ code: Code.INVALID_INPUT });
      expect(await row()).toEqual(before);
    } finally {
      await prisma.project.update({
        where: { id: projectId },
        data: { type: ProjectType.PESSOAL },
      });
    }
  });
  it("rejects a non-REFORMA, partial or newly unauthorized target", async () => {
    const reforma = await prisma.project.create({
      data: { tenantId, name: "restricted target", type: ProjectType.REFORMA },
    });
    await installSingleLineQuestion("targets", null);
    const amountCents = view.lines[0].amountCents!;
    await expect(
      submit(
        payload("targets", {
          kind: "TARGET",
          projectId,
          roomId: null,
          amountCents,
          literal: moneyLiteral(amountCents),
        }),
      ),
    ).rejects.toMatchObject({ code: Code.INVALID_INPUT });
    await expect(
      submit(
        payload("targets", {
          kind: "TARGET",
          projectId: reforma.id,
          roomId: null,
          amountCents: amountCents - 1,
          literal: moneyLiteral(amountCents - 1),
        }),
      ),
    ).rejects.toMatchObject({ code: Code.INVALID_INPUT });
    await prisma.user.update({
      where: { id: userId },
      data: {
        role: "USER",
        allowedProjects: JSON.stringify([projectId]),
        allowedProjectTypes: "[]",
        allowedModules: JSON.stringify(["creditCards", "expenses"]),
      },
    });
    try {
      await expect(
        submit(
          payload("targets", {
            kind: "TARGET",
            projectId: reforma.id,
            roomId: null,
            amountCents,
            literal: moneyLiteral(amountCents),
          }),
        ),
      ).rejects.toMatchObject({ code: Code.NOT_FOUND });
    } finally {
      await prisma.user.update({
        where: { id: userId },
        data: {
          role: "ADMIN",
          allowedProjects: "[]",
          allowedProjectTypes: "[]",
          allowedModules: "[]",
        },
      });
    }
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
  });
  it.each([
    ["titulo", "Título adulterado"],
    ["fornecedor", "Fornecedor adulterado"],
    ["tipoDespesa", ExpenseType.OUTROS],
    ["categoriaMaoDeObra", LaborCategory.ELETRICISTA],
    ["amountMeaning", ImportSessionAmountMeaning.INSTALLMENT_CHARGE],
    ["amountCents", 19999],
    ["installmentCount", 2],
    ["dataCompra", "2026-09-15"],
    ["firstDueDate", "2026-10-15"],
    ["targets", []],
    ["decision", { kind: "CREATE", acceptNaturalDuplicate: false }],
  ] as const)(
    "rejects legacy generic PATCH mutation of %s before draft validation can bypass focused authority",
    async (field, value) => {
      const before = await row();
      const line = view.lines[0];
      await expect(
        workflow.edit(authenticated().auth, sessionId, {
          expectedRevision: view.revision,
          questionId: null,
          replaceLines: [{ ...line, [field]: value }],
          selectedLineIds: view.selectedLineIds,
        }),
      ).rejects.toMatchObject({ code: Code.INVALID_INPUT });
      expect(await row()).toEqual(before);
    },
  );
  it("rejects a question-bound legacy generic PATCH even without replacement lines", async () => {
    const before = await row();
    await expect(
      workflow.edit(authenticated().auth, sessionId, {
        expectedRevision: view.revision,
        questionId: view.questions.find((question) => !("subject" in question))!
          .id,
        replaceLines: [],
        selectedLineIds: view.selectedLineIds,
      }),
    ).rejects.toMatchObject({ code: Code.INVALID_INPUT });
    expect(await row()).toEqual(before);
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
        {
          ...body,
          answer: {
            field: "firstDueDate",
            literal: "2026-10-11",
            value: "2026-10-11",
          },
        },
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
  it("rejects expired grants and sessions, and rechecks card/ACL revocation after admission", async () => {
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
    const cardActor = authenticated();
    ui.canActivate(context(cardActor.request));
    const cardGrant = issuer.issue(
      cardActor.request,
      cardActor.auth,
      focusedDraftAnswerScope(sessionId, body),
    );
    await prisma.creditCard.update({
      where: { id: cardId },
      data: { deletedAt: now },
    });
    try {
      await expect(
        workflow.focusedDraftAnswer(cardActor.auth, sessionId, body, cardGrant),
      ).rejects.toMatchObject({ code: Code.NOT_FOUND });
    } finally {
      await prisma.creditCard.update({
        where: { id: cardId },
        data: { deletedAt: null },
      });
    }
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
  it("equal answer on a retained current question is a no-op", async () => {
    view = await submit(payload("firstDueDate", "2026-10-11"));
    view = await workflow.prepare(authenticated().auth, sessionId, {
      expectedRevision: view.revision,
    });
    const before = await row();
    now = new Date(now.getTime() + 5000);
    view = await submit(payload("firstDueDate", "2026-10-11"));
    expect(await row()).toEqual(before);
  });
  async function pendingChoices(): Promise<void> {
    // Fixture-only setup for tests whose subject is the focused decision/target port.
    // Production clients cannot write these fields through generic PATCH.
    const lineId = view.selectedLineIds[0];
    const stored = await row();
    const draft = JSON.parse(stored.draftJson);
    draft.lines = draft.lines.map((line: { id: string }) =>
      line.id === lineId
        ? {
            ...line,
            firstDueDate: "2026-10-10",
            tipoDespesa: ExpenseType.OUTROS,
            decision: { kind: "UNRESOLVED" },
            targets: null,
          }
        : line,
    );
    await prisma.importSession.update({
      where: { id: sessionId },
      data: {
        state: "NEEDS_INPUT",
        draftJson: JSON.stringify(draft),
        searchJson: null,
        proposalJson: null,
        proposalHash: null,
        preflightHash: null,
        challengeJson: null,
      },
    });
    view = await service.getSession(authenticated().auth, sessionId);
    view = await workflow.prepare(authenticated().auth, sessionId, {
      expectedRevision: view.revision,
    });
  }
  it("rejects the owner project as a focused target before prepare or confirmation", async () => {
    await pendingChoices();
    await prisma.project.update({
      where: { id: projectId },
      data: { type: ProjectType.REFORMA },
    });
    try {
      const before = await row();
      const beforeFinance = await finance();
      const targetQuestion = view.questions.find(
        (item) => !("subject" in item) && item.field === "targets",
      );
      if (!targetQuestion) throw Error("Missing target question");
      const amountCents = view.lines[0].amountCents!;
      await expect(
        submit({
          version: 1,
          answerRequestId: randomUUID(),
          expectedRevision: view.revision,
          questionId: targetQuestion.id,
          channel: "TEXT",
          answer: {
            field: "targets",
            value: {
              kind: "TARGET",
              projectId,
              roomId: null,
              amountCents,
              literal: moneyLiteral(amountCents),
            },
          },
        }),
      ).rejects.toMatchObject({ code: Code.INVALID_INPUT });
      expect(await row()).toEqual(before);
      expect(await finance()).toEqual(beforeFinance);
    } finally {
      await prisma.project.update({
        where: { id: projectId },
        data: { type: ProjectType.PESSOAL },
      });
    }
  });
  it.each(["decision", "targets"] as const)(
    "native %s changes only its exact field and never selects, prepares or confirms",
    async (field) => {
      await pendingChoices();
      const before = await row();
      const observations = await prisma.importObservation.findMany({
        where: { tenantId },
        orderBy: { id: "asc" },
      });
      const oldDraft = JSON.parse(before.draftJson);
      const value =
        field === "decision"
          ? { kind: "CREATE", acceptNaturalDuplicate: false }
          : [];
      view = await submit(payload(field, value));
      const after = await row();
      const draft = JSON.parse(after.draftJson);
      expect(view.revision).toBe(before.revision + 1);
      expect(view.lines[0]).toEqual({ ...oldDraft.lines[0], [field]: value });
      expect(view.lines[1]).toEqual(oldDraft.lines[1]);
      expect(draft.declarations).toEqual(oldDraft.declarations);
      expect(view.selectedLineIds).toEqual(oldDraft.selectedLineIds);
      expect(
        await prisma.importObservation.findMany({
          where: { tenantId },
          orderBy: { id: "asc" },
        }),
      ).toEqual(observations);
      expect(await finance()).toEqual([0, 0, 0, 0, 0, 0]);
      expect(after.proposalJson).toBeNull();
      expect(after.challengeJson).toBeNull();
      expect(after.financialRequestId).toBeNull();
      expect(after.receiptJson).toBeNull();
    },
  );
  it.each([
    { field: "decision", value: null },
    { field: "decision", value: { kind: "CREATE" } },
    {
      field: "decision",
      value: { kind: "CREATE", acceptNaturalDuplicate: false, extra: true },
    },
    { field: "decision", value: { kind: "UNRESOLVED" } },
    { field: "decision", value: { kind: "IGNORE" } },
    { field: "targets", value: null },
    {
      field: "targets",
      value: [{ projectId: "anything", roomId: null, amountCents: 20696 }],
    },
    { field: "targets", value: {} },
  ])(
    "rejects all unfrozen choice values %j before granting authority",
    async (answer) => {
      await pendingChoices();
      const before = await row();
      const issue = jest.spyOn(issuer, "issue");
      issue.mockClear();
      await expect(
        submit({
          ...payload("decision", {
            kind: "CREATE",
            acceptNaturalDuplicate: false,
          }),
          answer,
        }),
      ).rejects.toMatchObject({ code: Code.INVALID_INPUT });
      expect(issue).not.toHaveBeenCalled();
      issue.mockRestore();
      expect(await row()).toEqual(before);
    },
  );
  it.each(["decision", "targets"] as const)(
    "native %s obeys exact grant, ACL, revision and current question fences",
    async (field) => {
      await pendingChoices();
      const value =
        field === "decision"
          ? { kind: "CREATE", acceptNaturalDuplicate: false }
          : [];
      const body = payload(field, value);
      const before = await row();
      await expect(submit(body, authenticated(), false)).rejects.toMatchObject({
        code: Code.UI_ACTION_REQUIRED,
      });
      await expect(
        submit(body, authenticated(undefined, randomUUID())),
      ).rejects.toBeDefined();
      await expect(
        submit({ ...body, expectedRevision: view.revision + 1 }),
      ).rejects.toMatchObject({ code: Code.REVISION_CONFLICT });
      await expect(
        submit({ ...body, questionId: "unknown" }),
      ).rejects.toMatchObject({ code: Code.REVISION_CONFLICT });
      const actor = authenticated();
      ui.canActivate(context(actor.request));
      const validated = parseFocusedDraftAnswerRequest(body);
      const grant = issuer.issue(
        actor.request,
        actor.auth,
        focusedDraftAnswerScope(sessionId, validated),
      );
      const other =
        field === "decision"
          ? payload("targets", [])
          : payload("decision", {
              kind: "CREATE",
              acceptNaturalDuplicate: false,
            });
      await expect(
        workflow.focusedDraftAnswer(actor.auth, sessionId, other, grant),
      ).rejects.toMatchObject({ code: Code.UI_ACTION_REQUIRED });
      await expect(
        workflow.focusedDraftAnswer(actor.auth, sessionId, validated, {}),
      ).rejects.toMatchObject({ code: Code.UI_ACTION_REQUIRED });
      expect(await row()).toEqual(before);
      view = await workflow.focusedDraftAnswer(
        actor.auth,
        sessionId,
        validated,
        grant,
      );
    },
  );
  it.each(["decision", "targets"] as const)(
    "concurrent %s submissions yield at most one conditional update",
    async (field) => {
      await pendingChoices();
      const value =
        field === "decision"
          ? { kind: "CREATE", acceptNaturalDuplicate: false }
          : [];
      const body = payload(field, value);
      const before = await row();
      const outcomes = await Promise.allSettled([submit(body), submit(body)]);
      expect(
        outcomes.filter((outcome) => outcome.status === "fulfilled"),
      ).toHaveLength(1);
      expect((await row()).revision).toBe(before.revision + 1);
      expect(await finance()).toEqual([0, 0, 0, 0, 0, 0]);
      await expect(submit(body)).rejects.toMatchObject({
        code: Code.REVISION_CONFLICT,
      });
    },
  );
  it.each(["decision", "targets"] as const)(
    "equal %s on a retained pending task changes neither revision nor expiry",
    async (field) => {
      await pendingChoices();
      const value =
        field === "decision"
          ? { kind: "CREATE", acceptNaturalDuplicate: false }
          : [];
      const body = payload(field, value);
      // Legacy persisted snapshots may retain a question after the line already has this value.
      // This fixture tests the existing no-op tail, not a new production state transition.
      const draft = JSON.parse((await row()).draftJson);
      draft.lines.find(
        (line: { id: string }) => line.id === view.selectedLineIds[0],
      )[field] = value;
      await prisma.importSession.update({
        where: { id: sessionId },
        data: { draftJson: JSON.stringify(draft) },
      });
      const before = await row();
      now = new Date(now.getTime() + 5000);
      view = await submit(body);
      expect(await row()).toEqual(before);
      expect(view.revision).toBe(before.revision);
      expect(await finance()).toEqual([0, 0, 0, 0, 0, 0]);
    },
  );
  async function naturalDuplicateQuestion(): Promise<{
    existingId: string;
    lineId: string;
  }> {
    await pendingChoices();
    const line = view.lines.find(
      (line) => line.id === view.selectedLineIds[0],
    )!;
    const actor = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const existing = await new ExpenseService(prisma, conciliacao).create(
      tenantId,
      projectId,
      {
        tipoDespesa: ExpenseType.OUTROS,
        valor: line.amountCents! / 100,
        quantidade: 1,
        titulo: line.titulo,
        fornecedor: line.fornecedor ?? line.titulo,
        formaPagamento: PaymentForm.A_VISTA,
        dataCompra: line.dataCompra!,
        dataPagamento: "2026-10-10",
        status: ExpenseStatus.PLANEJADO,
        creditCardId: cardId,
      },
      userId,
      undefined,
      {
        id: userId,
        role: actor.role,
        allowedProjects: [],
        allowedModules: [],
        allowedProjectTypes: [],
      },
    );
    // Historical cross-origin import fixture: natural identity only, never a strong match.
    await prisma.expense.update({
      where: { id: existing.id },
      data: {
        dedupeKeyNatural: dedupeKeyNatural({
          tenantId,
          projectId,
          date: new Date(`${line.dataCompra}T00:00:00.000Z`),
          merchant: line.fornecedor ?? line.titulo,
          amountCents: line.amountCents!,
          ordinal: 0,
        }),
      },
    });
    view = await submit(
      payload("decision", { kind: "CREATE", acceptNaturalDuplicate: false }),
    );
    view = await submit(payload("targets", []));
    view = await workflow.prepare(authenticated().auth, sessionId, {
      expectedRevision: view.revision,
    });
    expect(view.state).not.toBe("READY");
    expect(JSON.parse((await row()).searchJson!).candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "NATURAL_MATCH", lineId: line.id }),
      ]),
    );
    expect(
      view.questions.some(
        (question) =>
          question.field === "decision" && question.lineIds.includes(line.id),
      ),
    ).toBe(true);
    return { existingId: existing.id, lineId: line.id };
  }
  async function replaceNaturalCandidate(
    lineId: string,
    kind: "EXPENSE" | "RECEIPT",
    id: string,
  ): Promise<void> {
    const stored = await row();
    const search = JSON.parse(stored.searchJson!);
    search.candidates = [
      {
        lineId,
        kind,
        id,
        reason: "NATURAL_MATCH",
      },
    ];
    await prisma.importSession.update({
      where: { id: sessionId },
      data: { searchJson: JSON.stringify(search) },
    });
  }

  async function naturalReceiptQuestion(): Promise<{
    existingId: string;
    lineId: string;
  }> {
    await pendingChoices();
    const line = view.lines.find(
      (item) => item.id === view.selectedLineIds[0],
    )!;
    const existing = await prisma.receipt.create({
      data: {
        tenantId,
        projectId,
        valor: line.amountCents!,
        data: new Date(`${line.dataCompra}T00:00:00.000Z`),
        tipo: "OUTROS",
        status: "PREVISTO",
        descricao: line.fornecedor ?? line.titulo,
        dedupeKeyNatural: dedupeKeyNatural({
          tenantId,
          projectId,
          date: new Date(`${line.dataCompra}T00:00:00.000Z`),
          merchant: line.fornecedor ?? line.titulo,
          amountCents: line.amountCents!,
          ordinal: 0,
        }),
      },
    });
    view = await submit(
      payload("decision", { kind: "CREATE", acceptNaturalDuplicate: false }),
    );
    view = await submit(payload("targets", []));
    view = await workflow.prepare(authenticated().auth, sessionId, {
      expectedRevision: view.revision,
    });
    expect(JSON.parse((await row()).searchJson!).candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "RECEIPT",
          id: existing.id,
          reason: "NATURAL_MATCH",
          lineId: line.id,
        }),
      ]),
    );
    expect(
      view.questions.some(
        (question) =>
          question.field === "decision" && question.lineIds.includes(line.id),
      ),
    ).toBe(true);
    return { existingId: existing.id, lineId: line.id };
  }
  it("explicit CREATE false never waives a real natural duplicate or enables confirmation", async () => {
    await naturalDuplicateQuestion();
    const before = await finance();
    const beforeRow = await row();
    view = await submit(
      payload("decision", { kind: "CREATE", acceptNaturalDuplicate: false }),
    );
    expect(await row()).toEqual(beforeRow);
    expect(await finance()).toEqual(before);
    expect(view.proposal).toBeNull();
    expect((await row()).financialRequestId).toBeNull();
    const challengeActor = authenticated();
    ui.canActivate(context(challengeActor.request));
    const proposalHash = createHash("sha256")
      .update("absent proposal")
      .digest("hex");
    await expect(
      workflow.challenge(
        challengeActor.auth,
        sessionId,
        {
          expectedRevision: view.revision,
          proposalHash,
        },
        issuer.issueFinancialAction(
          challengeActor.request,
          challengeActor.auth,
          {
            operation: "CHALLENGE",
            sessionId,
            expectedRevision: view.revision,
            proposalHash,
          },
        ),
      ),
    ).rejects.toBeDefined();
    expect(await row()).toEqual(beforeRow);
    expect(await finance()).toEqual(before);
  });
  it("admits an explicit duplicate waiver only for the current live natural candidate", async () => {
    const { existingId } = await naturalDuplicateQuestion();
    const before = await finance();
    const body = payload("decision", {
      kind: "CREATE",
      acceptNaturalDuplicate: true,
    });
    const actor = authenticated();
    ui.canActivate(context(actor.request));
    const request = parseFocusedDraftAnswerRequest(body);
    const grant = issuer.issue(
      actor.request,
      actor.auth,
      focusedDraftAnswerScope(sessionId, request),
    );
    await prisma.expense.update({
      where: { id: existingId },
      data: { deletedAt: now },
    });
    await expect(
      workflow.focusedDraftAnswer(actor.auth, sessionId, request, grant),
    ).rejects.toMatchObject({ code: Code.INVALID_INPUT });
    await prisma.expense.update({
      where: { id: existingId },
      data: { deletedAt: null },
    });
    view = await submit(body);
    expect(view.lines[0].decision).toEqual({
      kind: "CREATE",
      acceptNaturalDuplicate: true,
    });
    expect(await finance()).toEqual(before);
  });
  it("reauthorizes an EXPENSE natural candidate with the expense module", async () => {
    const { existingId, lineId } = await naturalDuplicateQuestion();
    await replaceNaturalCandidate(lineId, "EXPENSE", existingId);
    await prisma.user.update({
      where: { id: userId },
      data: {
        role: "USER",
        allowedProjects: JSON.stringify([projectId]),
        allowedProjectTypes: "[]",
        allowedModules: JSON.stringify(["creditCards", "expenses"]),
      },
    });
    try {
      view = await submit(
        payload("decision", {
          kind: "CREATE",
          acceptNaturalDuplicate: true,
        }),
      );
      expect(view.lines[0].decision).toEqual({
        kind: "CREATE",
        acceptNaturalDuplicate: true,
      });
    } finally {
      await prisma.user.update({
        where: { id: userId },
        data: {
          role: "ADMIN",
          allowedProjects: "[]",
          allowedProjectTypes: "[]",
          allowedModules: "[]",
        },
      });
    }
  });
  it("reauthorizes a RECEIPT natural candidate with the receipt module", async () => {
    const { lineId } = await naturalDuplicateQuestion();
    const receipt = await prisma.receipt.create({
      data: {
        tenantId,
        projectId,
        valor: view.lines[0].amountCents!,
        data: new Date(`${view.lines[0].dataCompra}T00:00:00.000Z`),
        tipo: "OUTROS",
        descricao: "natural receipt candidate",
      },
    });
    await replaceNaturalCandidate(lineId, "RECEIPT", receipt.id);
    await prisma.user.update({
      where: { id: userId },
      data: {
        role: "USER",
        allowedProjects: JSON.stringify([projectId]),
        allowedProjectTypes: "[]",
        allowedModules: JSON.stringify(["creditCards", "expenses"]),
      },
    });
    try {
      await expect(
        submit(
          payload("decision", {
            kind: "CREATE",
            acceptNaturalDuplicate: true,
          }),
        ),
      ).rejects.toMatchObject({ code: Code.NOT_FOUND });
      await prisma.user.update({
        where: { id: userId },
        data: {
          allowedModules: JSON.stringify([
            "creditCards",
            "expenses",
            "receipts",
          ]),
        },
      });
      view = await submit(
        payload("decision", {
          kind: "CREATE",
          acceptNaturalDuplicate: true,
        }),
      );
      expect(view.lines[0].decision).toEqual({
        kind: "CREATE",
        acceptNaturalDuplicate: true,
      });
    } finally {
      await prisma.user.update({
        where: { id: userId },
        data: {
          role: "ADMIN",
          allowedProjects: "[]",
          allowedProjectTypes: "[]",
          allowedModules: "[]",
        },
      });
    }
  });
  it("denies a natural candidate opaquely when its module is revoked after admission", async () => {
    const { existingId, lineId } = await naturalDuplicateQuestion();
    await replaceNaturalCandidate(lineId, "EXPENSE", existingId);
    await prisma.user.update({
      where: { id: userId },
      data: {
        role: "USER",
        allowedProjects: JSON.stringify([projectId]),
        allowedProjectTypes: "[]",
        allowedModules: JSON.stringify(["creditCards", "expenses"]),
      },
    });
    const body = payload("decision", {
      kind: "CREATE",
      acceptNaturalDuplicate: true,
    });
    const actor = authenticated();
    ui.canActivate(context(actor.request));
    const request = parseFocusedDraftAnswerRequest(body);
    const grant = issuer.issue(
      actor.request,
      actor.auth,
      focusedDraftAnswerScope(sessionId, request),
    );
    await prisma.user.update({
      where: { id: userId },
      data: { allowedModules: JSON.stringify(["creditCards"]) },
    });
    const before = await row();
    try {
      await expect(
        workflow.focusedDraftAnswer(actor.auth, sessionId, request, grant),
      ).rejects.toMatchObject({ code: Code.NOT_FOUND });
      expect(await row()).toEqual(before);
    } finally {
      await prisma.user.update({
        where: { id: userId },
        data: {
          role: "ADMIN",
          allowedProjects: "[]",
          allowedProjectTypes: "[]",
          allowedModules: "[]",
        },
      });
    }
  });

  it.each([
    {
      kind: "EXPENSE",
      allowedModules: ["creditCards", "receipts"],
    },
    {
      kind: "RECEIPT",
      allowedModules: ["creditCards", "expenses"],
    },
  ] as const)(
    "denies a live natural $kind candidate opaquely after its owning module is revoked",
    async ({ kind, allowedModules }) => {
      if (kind === "EXPENSE") await naturalDuplicateQuestion();
      else await naturalReceiptQuestion();
      const before = await row();
      const beforeFinance = await finance();
      await prisma.user.update({
        where: { id: userId },
        data: {
          role: "USER",
          allowedProjects: JSON.stringify([projectId]),
          allowedProjectTypes: "[]",
          allowedModules: JSON.stringify(allowedModules),
        },
      });
      try {
        await expect(
          submit(
            payload("decision", {
              kind: "CREATE",
              acceptNaturalDuplicate: true,
            }),
          ),
        ).rejects.toMatchObject({ code: Code.NOT_FOUND });
        expect(await row()).toEqual(before);
        expect(await finance()).toEqual(beforeFinance);
      } finally {
        await prisma.user.update({
          where: { id: userId },
          data: {
            role: "ADMIN",
            allowedProjects: "[]",
            allowedProjectTypes: "[]",
            allowedModules: "[]",
          },
        });
      }
    },
  );
  it.each(["EXPENSE", "RECEIPT"] as const)(
    "does not mutate when a forged $kind candidate id belongs to another tenant",
    async (kind) => {
      await pendingChoices();
      const question = view.questions.find(
        (item) => !("subject" in item) && item.field === "decision",
      );
      if (!question) throw Error("Missing decision question");
      const otherTenant = await prisma.tenant.create({
        data: { name: `foreign ${kind}` },
      });
      const otherProject = await prisma.project.create({
        data: {
          tenantId: otherTenant.id,
          name: "foreign",
          type: ProjectType.PESSOAL,
        },
      });
      const foreignId =
        kind === "EXPENSE"
          ? (
              await prisma.expense.create({
                data: {
                  tenantId: otherTenant.id,
                  projectId: otherProject.id,
                  tipoDespesa: ExpenseType.OUTROS,
                  valor: 20_696,
                  valorTotal: 20_696,
                  quantidade: 1,
                  titulo: "foreign",
                  formaPagamento: PaymentForm.A_VISTA,
                  dataCompra: new Date("2026-09-01T00:00:00.000Z"),
                  dataPagamento: new Date("2026-10-10T00:00:00.000Z"),
                  status: ExpenseStatus.PLANEJADO,
                },
              })
            ).id
          : (
              await prisma.receipt.create({
                data: {
                  tenantId: otherTenant.id,
                  projectId: otherProject.id,
                  valor: 20_696,
                  data: new Date("2026-09-01T00:00:00.000Z"),
                  tipo: "OUTROS",
                  descricao: "foreign",
                },
              })
            ).id;
      try {
        const stored = await row();
        const search = JSON.parse(stored.searchJson!);
        search.candidates.push({
          lineId: view.selectedLineIds[0],
          kind,
          id: foreignId,
          reason: "NATURAL_MATCH",
        });
        await prisma.importSession.update({
          where: { id: sessionId },
          data: { searchJson: JSON.stringify(search) },
        });
        const before = await row();
        const answer =
          kind === "EXPENSE"
            ? {
                kind: "KEEP_EXISTING" as const,
                expenseId: foreignId,
              }
            : {
                kind: "CREATE" as const,
                acceptNaturalDuplicate: true,
              };
        await expect(submit(payload("decision", answer))).rejects.toMatchObject(
          { code: Code.INVALID_INPUT },
        );
        expect(await row()).toEqual(before);
        expect(await finance()).toEqual([0, 0, 0, 0, 0, 0]);
      } finally {
        if (kind === "EXPENSE")
          await prisma.$executeRaw`DELETE FROM expenses WHERE id = ${foreignId}`;
        else
          await prisma.$executeRaw`DELETE FROM receipts WHERE id = ${foreignId}`;
        await prisma.$executeRaw`DELETE FROM projects WHERE id = ${otherProject.id}`;
        await prisma.$executeRaw`DELETE FROM tenants WHERE id = ${otherTenant.id}`;
        expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
      }
    },
  );
  it("accepts KEEP_EXISTING only for a current authorized expense candidate", async () => {
    const { existingId } = await naturalDuplicateQuestion();
    const before = await finance();
    view = await submit(
      payload("decision", { kind: "KEEP_EXISTING", expenseId: existingId }),
    );
    expect(view.lines[0].decision).toEqual({
      kind: "KEEP_EXISTING",
      expenseId: existingId,
    });
    expect(await finance()).toEqual(before);
  });
  it("separate explicit confirmation creates the source purchase, CFE and session receipt with no allocations", async () => {
    await pendingChoices();
    view = await submit(
      payload("decision", { kind: "CREATE", acceptNaturalDuplicate: false }),
    );
    view = await submit(payload("targets", []));
    expect(await finance()).toEqual([0, 0, 0, 0, 0, 0]);
    view = await workflow.prepare(authenticated().auth, sessionId, {
      expectedRevision: view.revision,
    });
    expect(view.state).toBe("READY");
    const ready = view;
    const proposalHash = ready.proposal!.proposalHash;
    await expect(
      workflow.confirm(
        authenticated().auth,
        sessionId,
        {
          expectedRevision: ready.revision,
          proposalHash,
          financialRequestId: randomUUID(),
          nonce: null,
        },
        {},
      ),
    ).rejects.toMatchObject({ code: Code.UI_ACTION_REQUIRED });
    const challengeActor = authenticated();
    ui.canActivate(context(challengeActor.request));
    const challenge = await workflow.challenge(
      challengeActor.auth,
      sessionId,
      { expectedRevision: ready.revision, proposalHash },
      issuer.issueFinancialAction(challengeActor.request, challengeActor.auth, {
        operation: "CHALLENGE",
        sessionId,
        expectedRevision: ready.revision,
        proposalHash,
      }),
    );
    const financialRequestId = randomUUID();
    const confirmActor = authenticated();
    ui.canActivate(context(confirmActor.request));
    await workflow.confirm(
      confirmActor.auth,
      sessionId,
      {
        expectedRevision: ready.revision,
        proposalHash,
        financialRequestId,
        nonce: challenge.nonce,
      },
      issuer.issueFinancialAction(confirmActor.request, confirmActor.auth, {
        operation: "CONFIRM",
        sessionId,
        expectedRevision: ready.revision,
        proposalHash,
        financialRequestId,
      }),
    );
    const executeActor = authenticated();
    ui.canActivate(context(executeActor.request));
    const receipt = await workflow.execute(
      executeActor.auth,
      sessionId,
      { financialRequestId },
      issuer.issueFinancialAction(executeActor.request, executeActor.auth, {
        operation: "EXECUTE",
        sessionId,
        financialRequestId,
      }),
    );
    expect(await finance()).toEqual([1, 1, 0, 0, 0, 0]);
    const expense = await prisma.expense.findFirstOrThrow({
      where: { tenantId },
    });
    expect(expense).toMatchObject({ projectId, valorTotal: 20696 });
    expect(
      await prisma.cashFlowEntry.findFirstOrThrow({ where: { tenantId } }),
    ).toMatchObject({
      projectId,
      expenseId: expense.id,
      valor: 20696,
      data: new Date("2026-10-10T00:00:00.000Z"),
    });
    expect(receipt.items[0]).toMatchObject({
      sourceExpenseId: expense.id,
      targetExpenseIds: [],
      allocationIds: [],
    });
    expect((await row()).receiptJson).not.toBeNull();
    expect(
      (await service.getSession(authenticated().auth, sessionId)).receipt,
    ).toEqual(receipt);
    expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
  });
});
