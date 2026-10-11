import type { ExecutionContext } from "@nestjs/common";
import type {
  Expense,
  ImportArtifact,
  ImportObservation,
} from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import {
  ExpenseType,
  IMPORT_SESSION_CONSENT_POLICY_VERSION,
  ImportSessionErrorCode as Code,
  ProjectType,
  type ImportChatTurnV1,
  type ImportSessionStoredDraftV1,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import { PrismaService } from "../../prisma/prisma.service";
import { ConciliacaoService } from "../../conciliacao/conciliacao.service";
import { ExpenseService } from "../../expense/expense.service";
import { extractCardStatementDocument } from "../../credit-card/parsers/statement-document";
import { CardPurchaseBatchAdapter } from "./card-purchase-batch.adapter";
import { ImportChatBridge } from "./import-chat.bridge";
import {
  activateImportChat,
  registerPendingImportChat,
  releaseImportChat,
  reserveImportChatOperation,
} from "./import-chat.admission";
import {
  ImportAuthGuard,
  readImportAuthForRequest,
} from "./import-session.auth";
import { DefaultImportSessionCapability } from "./import-session.capability";
import { buildImportMaterialization } from "./import-session.extraction";
import { EMPTY_DRAFT_JSON } from "./import-session.projection";
import { ImportSessionService } from "./import-session.service";
import { ImportSessionWorkflowService } from "./import-session-workflow.service";

describe("mixed claimed/unclaimed attachment reimport", () => {
  const prisma = new PrismaService();
  const now = new Date("2026-10-09T20:00:00.000Z");
  const clock = { now: (): Date => now };
  const capability = new DefaultImportSessionCapability();
  const runtime = {};
  const gate = {
    boot: {
      runtime: () => runtime,
      stopped: { aborted: false },
      recheckLock: async () => ({ ok: true, runtime }),
    },
  };
  const verifier = {
    verify: jest.fn().mockReturnValue({}),
    verifyFinancialAction: jest.fn(),
  };
  const raw = { abortOwned: jest.fn() };
  const sessions = new ImportSessionService(
    prisma,
    clock,
    capability,
    verifier as never,
    gate as never,
    raw as never,
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
    gate as never,
    raw as never,
  );
  const bridge = new ImportChatBridge(
    sessions,
    workflow,
    prisma,
    clock,
    capability,
    gate as never,
  );
  let tenantId: string;
  let userId: string;
  let projectId: string;
  let cardId: string;
  let artifact: ImportArtifact;
  let claimed: ImportObservation;
  let eligible: ImportObservation;
  let appliedPurchase: Expense;
  let view: ImportSessionViewV1;
  let attachmentId: string;
  let originalLineId: string;
  const testSessionIds: string[] = [];

  const requestAuth = (body: object = {}) => {
    const request = {
      body,
      user: {
        id: userId,
        tenantId,
        authClaims: {
          sessionVersion: 0,
          expiresAtEpochSeconds: now.getTime() / 1000 + 86400,
        },
      },
    };
    new ImportAuthGuard().canActivate({
      switchToHttp: () => ({ getRequest: () => request }),
    } as ExecutionContext);
    return { request, auth: readImportAuthForRequest(request) };
  };
  const create = async () => {
    const created = await sessions.create(
      requestAuth().auth,
      {
        version: 1,
        createRequestId: randomUUID(),
        cardId,
        consentPolicyVersion: IMPORT_SESSION_CONSENT_POLICY_VERSION,
        consentAnalyze: true,
      },
      {},
    );
    testSessionIds.push(created.view.id);
    return created;
  };

  // Only documentary fixtures are persisted directly. Canonical claims below
  // are produced by the real prepare/confirm/execute path.
  const attach = async (sessionId: string) => {
    const session = await prisma.importSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
    const ref = await prisma.importSessionArtifact.create({
      data: {
        tenantId,
        ownerProjectId: projectId,
        sessionId,
        artifactId: artifact.id,
        position: 0,
        fileName: "mixed.csv",
        declaredMime: "text/csv",
        declaredBytes: artifact.verifiedBytes!,
        reservedBytes: 0,
        state: "ATTACHED",
        verifiedAt: now,
      },
    });
    const observations = await prisma.importObservation.findMany({
      where: { artifactId: artifact.id },
    });
    const extraction = JSON.parse(artifact.extractionJson!);
    const material = buildImportMaterialization({
      session,
      attachment: ref,
      artifact,
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
    for (const observation of material.observations)
      await prisma.importObservation.create({ data: observation });
    await prisma.importSession.update({
      where: { id: sessionId },
      data: { draftJson: JSON.stringify(material.draft) },
    });
    return { ref, draft: material.draft };
  };

  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toMatch(/test(?:-worker-\d+)?\.db/);
    await prisma.$connect();
    tenantId = (
      await prisma.tenant.create({ data: { name: "mixed reimport" } })
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
    const bytes = Buffer.from(
      "date,title,amount\n2026-10-01,Applied purchase PARC 1/2,1.00\n2026-10-02,Remaining purchase PARC 1/2,2.00\n",
    );
    const extraction = extractCardStatementDocument({
      version: 1,
      context: "CARD_INVOICE",
      format: "CSV",
      profile: "CSV_NUBANK",
      bytes,
    });
    artifact = await prisma.importArtifact.create({
      data: {
        tenantId,
        ownerProjectId: projectId,
        documentSha256: createHash("sha256").update(bytes).digest("hex"),
        verifiedBytes: bytes.length,
        detectedFormat: "CSV",
        state: "EXTRACTED",
        parserVersion: extraction.parserVersion,
        extractionJson: JSON.stringify(extraction),
      },
    });
    const original = await create();
    const { draft } = await attach(original.view.id);
    originalLineId = draft.lines[0].id;
    const readyDraft: ImportSessionStoredDraftV1 = {
      ...draft,
      questions: [],
      selectedLineIds: [originalLineId],
      lines: draft.lines.map((line, index) => ({
        ...line,
        amountMeaning: "TOTAL_PURCHASE",
        amountCents: (index + 1) * 200,
        installmentCount: 2,
        firstDueDate: "2026-10-10",
        targets: [],
        tipoDespesa: ExpenseType.OUTROS,
        decision: { kind: "CREATE", acceptNaturalDuplicate: false },
      })),
    };
    await prisma.importSession.update({
      where: { id: original.view.id },
      data: { draftJson: JSON.stringify(readyDraft) },
    });
    const auth = requestAuth().auth;
    const ready = await workflow.prepare(auth, original.view.id, {
      expectedRevision: original.view.revision,
    });
    expect(ready).toMatchObject({
      state: "READY",
      questions: [],
      reviewBlockers: [],
    });
    const challenge = await workflow.challenge(
      auth,
      ready.id,
      {
        expectedRevision: ready.revision,
        proposalHash: ready.proposal!.proposalHash,
      },
      {},
    );
    const financialRequestId = randomUUID();
    await workflow.confirm(
      auth,
      ready.id,
      {
        expectedRevision: ready.revision,
        proposalHash: ready.proposal!.proposalHash,
        financialRequestId,
        nonce: challenge.nonce,
      },
      {},
    );
    await workflow.execute(auth, ready.id, { financialRequestId }, {});
    // Simulate already-redacted retained evidence without changing any canonical
    // identifier or prescribing when the retention policy should redact it.
    claimed = await prisma.importObservation.update({
      where: { id: draft.lines[0].observationIds[0] },
      data: { evidenceJson: "{}" },
    });
    eligible = await prisma.importObservation.findUniqueOrThrow({
      where: { id: draft.lines[1].observationIds[0] },
    });
    expect(claimed.evidenceJson).toBe("{}");
    expect(claimed.canonicalExpenseId).not.toBeNull();
    appliedPurchase = await prisma.expense.findUniqueOrThrow({
      where: { id: claimed.canonicalExpenseId! },
    });
    expect(eligible.canonicalExpenseId).toBeNull();
    testSessionIds.length = 0;
  });
  beforeEach(async () => {
    const reimport = await create();
    const { ref } = await attach(reimport.view.id);
    attachmentId = ref.id;
    view = await sessions.getSession(requestAuth().auth, reimport.view.id);
    expect(view.lines).toHaveLength(1);
    expect(view.lines[0].observationIds).toEqual([eligible.id]);
  });
  afterEach(async () => {
    if (!claimed) return;
    try {
      expect(
        await prisma.importObservation.findUnique({
          where: { id: claimed.id },
        }),
      ).toEqual(claimed);
      expect(await prisma.expense.count({ where: { tenantId } })).toBe(1);
      expect(
        await prisma.expense.findUnique({ where: { id: appliedPurchase.id } }),
      ).toEqual(appliedPurchase);
    } finally {
      for (const id of testSessionIds.splice(0)) {
        const auth = requestAuth().auth;
        const current = await sessions.getSession(auth, id);
        await sessions.cancel(
          auth,
          id,
          { expectedRevision: current.revision },
          {},
        );
      }
    }
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const admission = (
    scope: ImportChatTurnV1["scope"],
    intent: "ANSWER" | "APPROVE_ATTACHMENT_SCOPE" = "ANSWER",
    revision = view.revision,
  ) => {
    const question = view.questions.find((q) => q.field === "firstDueDate")!;
    const importTurn = {
      version: 1,
      turnId: randomUUID(),
      sessionId: view.id,
      expectedRevision: revision,
      channel: "TEXT",
      literalAnswer: "10/10/2026",
      intent,
      focus: {
        id: question.id,
        field: question.field,
        lineIds: question.lineIds,
      },
      scope,
    } as ImportChatTurnV1;
    const { request, auth } = requestAuth({ importTurn });
    registerPendingImportChat(request, auth, importTurn);
    return { auth, handle: activateImportChat(request, now)! };
  };
  const unchanged = async () => {
    const row = await prisma.importSession.findUniqueOrThrow({
      where: { id: view.id },
    });
    expect(row.revision).toBe(view.revision);
    expect(JSON.parse(row.draftJson).lines).toEqual(view.lines);
  };

  it("chat attachment read returns only the remaining editable line", async () => {
    const { handle } = admission({ kind: "ATTACHMENT", attachmentId });
    try {
      const result = await bridge.read(handle, { kind: "SESSION" });
      expect(result).toMatchObject({
        kind: "SESSION",
        lines: [{ id: view.lines[0].id }],
      });
      expect(JSON.stringify(result)).not.toContain(claimed.id);
    } finally {
      releaseImportChat(handle);
    }
  });

  it.each(["ANSWER", "APPROVE_ATTACHMENT_SCOPE"] as const)(
    "%s updates the remaining line without editing the retained claimed observation",
    async (intent) => {
      const { auth, handle } = admission(
        intent === "ANSWER"
          ? { kind: "ATTACHMENT", attachmentId }
          : {
              kind: "ATTACHMENT",
              attachmentId,
              approvedLineIds: [view.lines[0].id],
            },
        intent,
      );
      try {
        const outcome = await bridge.editAnswer(handle, {
          kind: "VALUE",
          answer: null,
        });
        expect(outcome).toMatchObject({
          kind: "REVISED_SESSION",
          acknowledgment: "EDITED",
          ref: { sessionId: view.id, revision: view.revision + 1 },
        });
        const edited = await sessions.getSession(auth, view.id);
        expect(edited.revision).toBe(view.revision + 1);
        expect(edited.lines[0]).toMatchObject({
          firstDueDate: "2026-10-10",
          observationIds: [eligible.id],
        });
      } finally {
        releaseImportChat(handle);
      }
    },
  );

  it.each(["replace-observation", "add-claimed-line"] as const)(
    "rejects malicious attachment answer: %s",
    async (attack) => {
      const { auth, handle } = admission({ kind: "ATTACHMENT", attachmentId });
      try {
        reserveImportChatOperation(handle, "EDIT", now);
        const replacement = { ...view.lines[0], firstDueDate: "2026-10-10" };
        const claimedLine = {
          ...replacement,
          id: originalLineId,
          observationIds: [claimed.id],
        };
        await expect(
          workflow.editConversationAnswer(
            auth,
            view.id,
            {
              kind: "VALUE",
              lines:
                attack === "replace-observation"
                  ? [{ ...replacement, observationIds: [claimed.id] }]
                  : [replacement, claimedLine],
            },
            handle,
          ),
        ).rejects.toMatchObject({ code: Code.INVALID_INPUT });
        await unchanged();
      } finally {
        releaseImportChat(handle);
      }
    },
  );

  it("generic edit cannot bind a retained claimed observation as a purchase", async () => {
    await expect(
      workflow.edit(requestAuth().auth, view.id, {
        expectedRevision: view.revision,
        questionId: null,
        replaceLines: [
          {
            ...view.lines[0],
            id: originalLineId,
            observationIds: [claimed.id],
            decision: { kind: "CREATE", acceptNaturalDuplicate: false },
          },
        ],
        selectedLineIds: [originalLineId],
      }),
    ).rejects.toMatchObject({ code: Code.INVALID_INPUT });
    await unchanged();
  });

  it("rejects a stale revision before editing", async () => {
    const { auth, handle } = admission(
      { kind: "ATTACHMENT", attachmentId },
      "ANSWER",
      view.revision + 1,
    );
    try {
      reserveImportChatOperation(handle, "EDIT", now);
      await expect(
        workflow.editConversationAnswer(
          auth,
          view.id,
          {
            kind: "VALUE",
            lines: [{ ...view.lines[0], firstDueDate: "2026-10-10" }],
          },
          handle,
        ),
      ).rejects.toMatchObject({ code: Code.REVISION_CONFLICT });
      await unchanged();
    } finally {
      releaseImportChat(handle);
    }
  });

  it("rejects an attachment owned by a different session", async () => {
    const other = await create();
    const { ref } = await attach(other.view.id);
    const { auth, handle } = admission({
      kind: "ATTACHMENT",
      attachmentId: ref.id,
    });
    try {
      expect(await bridge.read(handle, { kind: "SESSION" })).toMatchObject({
        lines: [],
      });
      reserveImportChatOperation(handle, "EDIT", now);
      await expect(
        workflow.editConversationAnswer(
          auth,
          view.id,
          {
            kind: "VALUE",
            lines: [{ ...view.lines[0], firstDueDate: "2026-10-10" }],
          },
          handle,
        ),
      ).rejects.toMatchObject({ code: Code.STALE_PREVIEW });
      await unchanged();
    } finally {
      releaseImportChat(handle);
    }
  });

  it("approval must name exactly the current editable attachment lines", async () => {
    const { auth, handle } = admission(
      {
        kind: "ATTACHMENT",
        attachmentId,
        approvedLineIds: [view.lines[0].id, originalLineId],
      },
      "APPROVE_ATTACHMENT_SCOPE",
    );
    try {
      await expect(
        bridge.read(handle, { kind: "SESSION" }),
      ).rejects.toMatchObject({ code: Code.REVISION_CONFLICT });
      reserveImportChatOperation(handle, "EDIT", now);
      await expect(
        workflow.editConversationAnswer(
          auth,
          view.id,
          {
            kind: "VALUE",
            lines: [{ ...view.lines[0], firstDueDate: "2026-10-10" }],
          },
          handle,
        ),
      ).rejects.toMatchObject({ code: Code.REVISION_CONFLICT });
      await unchanged();
    } finally {
      releaseImportChat(handle);
    }
  });
});
