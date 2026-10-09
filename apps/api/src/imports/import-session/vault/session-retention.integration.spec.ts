import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  IMPORT_SESSION_CONSENT_POLICY_VERSION,
  IMPORT_SESSION_LIMITS,
  ProjectType,
  ExpenseType,
} from "@reformaflow/domain";
import { PrismaService } from "../../../prisma/prisma.service";
import { ImportSessionService } from "../import-session.service";
import { ImportSessionWorkflowService } from "../import-session-workflow.service";
import { DefaultImportSessionCapability } from "../import-session.capability";
import { mintImportAuthContext } from "../import-session.auth";
import { EMPTY_DRAFT_JSON } from "../import-session.projection";
import { VaultReaper } from "./vault-reaper";
import { ImportUploadService } from "./import-upload.service";
import { CardPurchaseBatchAdapter } from "../card-purchase-batch.adapter";
import { ConciliacaoService } from "../../../conciliacao/conciliacao.service";
import { ExpenseService } from "../../../expense/expense.service";
import { buildImportMaterialization } from "../import-session.extraction";
import { extractCardStatementDocument } from "../../../credit-card/parsers/statement-document";
import { RuntimeUiGrantVerifier } from "../import-session-ui-grant";

// Jest's mandatory setupFiles has already refused dev.db and selected the worker DB.
describe("guarded persisted session retention", () => {
  const prisma = new PrismaService();
  let current = new Date("2026-10-09T20:00:00.000Z");
  const clock = { now: () => current };
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
  const service = new ImportSessionService(
    prisma,
    clock,
    capability,
    verifier as never,
    gate as never,
    raw as never,
  );
  let tenantId: string;
  let userId: string;
  let projectId: string;
  let cardId: string;
  let auth: ReturnType<typeof mintImportAuthContext>;

  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toMatch(/test(?:-worker-\d+)?\.db/);
    expect(process.env.DATABASE_URL).not.toContain("dev.db");
    await prisma.$connect();
    const tenant = await prisma.tenant.create({
      data: { name: "retention fixture" },
    });
    tenantId = tenant.id;
    const user = await prisma.user.create({
      data: {
        tenantId,
        username: randomUUID(),
        name: "retention fixture",
        role: "ADMIN",
      },
    });
    userId = user.id;
    const project = await prisma.project.create({
      data: { tenantId, name: "retention fixture", type: ProjectType.PESSOAL },
    });
    projectId = project.id;
    const card = await prisma.creditCard.create({
      data: {
        tenantId,
        projectId,
        nickname: "fixture",
        institution: "fixture",
        last4: "1234",
        closingDay: 5,
        dueDay: 10,
      },
    });
    cardId = card.id;
    auth = mintImportAuthContext({
      tenantId,
      userId,
      presentedSessionVersion: 0,
      tokenExpiresAt: new Date(current.getTime() + 30 * 86400000).toISOString(),
    });
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const create = () =>
    service.create(
      auth,
      {
        version: 1,
        createRequestId: randomUUID(),
        cardId,
        consentPolicyVersion: IMPORT_SESSION_CONSENT_POLICY_VERSION,
        consentAnalyze: true,
      },
      {},
    );

  it("create/replay/reads write no finance and do not extend seven-day draft retention", async () => {
    const request = {
      version: 1,
      createRequestId: randomUUID(),
      cardId,
      consentPolicyVersion: IMPORT_SESSION_CONSENT_POLICY_VERSION,
      consentAnalyze: true,
    };
    const first = await service.create(auth, request, {});
    const expiry = await prisma.importSession.findUniqueOrThrow({
      where: { id: first.view.id },
    });
    expect(expiry.expiresAt.getTime() - expiry.lastUserEditAt.getTime()).toBe(
      IMPORT_SESSION_LIMITS.draftRetentionSeconds * 1000,
    );
    expect((await service.create(auth, request, {})).created).toBe(false);
    current = new Date(current.getTime() + 3600000);
    await service.getSession(auth, first.view.id);
    const after = await prisma.importSession.findUniqueOrThrow({
      where: { id: first.view.id },
    });
    expect(after.expiresAt).toEqual(expiry.expiresAt);
    expect(after.lastUserEditAt).toEqual(expiry.lastUserEditAt);
    expect(await prisma.expense.count({ where: { tenantId } })).toBe(0);
    expect(await prisma.cashFlowEntry.count({ where: { tenantId } })).toBe(0);
    expect(await prisma.receipt.count({ where: { tenantId } })).toBe(0);
  });

  it("cancellation uses the service and expiry uses the scoped runtime reaper", async () => {
    const cancelled = await create();
    await service.cancel(
      auth,
      cancelled.view.id,
      { expectedRevision: cancelled.view.revision },
      {},
    );
    expect((await service.getSession(auth, cancelled.view.id)).state).toBe(
      "CANCELLED",
    );
    const expired = await create();
    current = new Date(
      current.getTime() + IMPORT_SESSION_LIMITS.draftRetentionSeconds * 1000,
    );
    const reaper = new VaultReaper(prisma, clock, gate as never, raw as never);
    await reaper.runCycle({ tenantId, ownerProjectId: projectId, limit: 16 });
    expect(
      (
        await prisma.importSession.findUniqueOrThrow({
          where: { id: expired.view.id },
        })
      ).state,
    ).toBe("EXPIRED");
    expect(await prisma.expense.count({ where: { tenantId } })).toBe(0);
  });

  it("APPLIED recovery and execute replay depend on the immutable receipt, not retained draft/original", async () => {
    const created = await create();
    const financialRequestId = randomUUID();
    const receipt = {
      version: 1,
      sessionId: created.view.id,
      financialRequestId,
      confirmedRevision: 1,
      proposalHash: "a".repeat(64),
      appliedAt: current.toISOString(),
      continuationSessionId: null,
      items: [
        {
          lineId: "line-retention",
          outcome: "CREATED",
          sourceExpenseId: "purged-source-reference",
          targetExpenseIds: [],
          allocationIds: [],
          cashFlowEntryIds: ["removed-flow-reference"],
        },
      ],
      snapshot: {
        lines: [
          {
            lineId: "line-retention",
            titulo: "normalized purchase",
            dataCompra: "2026-10-01",
            totalCents: 100,
            sourceProjectId: projectId,
            targets: [],
            schedule: {
              version: 1,
              occurrences: [
                {
                  index: 0,
                  parcela: null,
                  valor: 100,
                  data: "2026-10-10",
                  invoiceDueMonth: "2026-10",
                },
              ],
            },
          },
        ],
        participantProjectIds: [projectId],
        createdEconomicTotalCents: 100,
        bankCashDeltaCents: 0,
        invoiceDeltas: [{ invoiceDueMonth: "2026-10", amountCents: 100 }],
      },
    };
    // A durable terminal fixture: source rows may subsequently have been removed.
    await prisma.importSession.update({
      where: { id: created.view.id },
      data: {
        state: "APPLIED",
        financialRequestId,
        confirmedRevision: 1,
        confirmedSessionVersion: 0,
        confirmedAt: current,
        proposalHash: receipt.proposalHash,
        closedAt: current,
        receiptJson: JSON.stringify(receipt),
        draftJson: EMPTY_DRAFT_JSON,
        proposalJson: null,
        searchJson: null,
      },
    });
    expect((await service.getResult(auth, created.view.id)).receipt).toEqual(
      receipt,
    );
    const batches = { applyInTx: jest.fn(), prepareInTx: jest.fn() };
    const workflow = new ImportSessionWorkflowService(
      prisma,
      clock,
      capability,
      verifier,
      batches as never,
      gate as never,
      raw as never,
    );
    expect(
      await workflow.execute(auth, created.view.id, { financialRequestId }, {}),
    ).toEqual(receipt);
    expect(batches.applyInTx).not.toHaveBeenCalled();
    expect(await prisma.expense.count({ where: { tenantId } })).toBe(0);
    expect(await prisma.cashFlowEntry.count({ where: { tenantId } })).toBe(0);
  });

  it("real prepare/consent/execute strips persisted drafts, releases refs and replays only the receipt", async () => {
    const created = await create();
    const session = await prisma.importSession.findUniqueOrThrow({
      where: { id: created.view.id },
    });
    const bytes = Buffer.from(
      "date,title,amount\n2026-10-01,Fixture PARC 1/2,1.00\n",
    );
    const extraction = extractCardStatementDocument({
      version: 1,
      context: "CARD_INVOICE",
      format: "CSV",
      profile: "CSV_NUBANK",
      bytes,
    });
    // Immutable extraction fixture, not a financial write: normalize through
    // the same parser/materializer as RAW analysis, then exercise the real workflow.
    const artifact = await prisma.importArtifact.create({
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
    const ref = await prisma.importSessionArtifact.create({
      data: {
        tenantId,
        ownerProjectId: projectId,
        sessionId: session.id,
        artifactId: artifact.id,
        position: 0,
        fileName: "fixture.csv",
        declaredMime: "text/csv",
        declaredBytes: bytes.length,
        reservedBytes: 0,
        state: "ATTACHED",
        verifiedAt: current,
      },
    });
    const material = buildImportMaterialization({
      session,
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
    const draft = {
      ...material.draft,
      questions: [],
      selectedLineIds: material.draft.lines.map((line) => line.id),
      lines: material.draft.lines.map((line) => ({
        ...line,
        amountMeaning: "TOTAL_PURCHASE" as const,
        amountCents: 200,
        installmentCount: 2,
        firstDueDate: "2026-10-10",
        targets: [],
        tipoDespesa: ExpenseType.OUTROS,
        decision: { kind: "CREATE" as const, acceptNaturalDuplicate: false },
      })),
    };
    await prisma.importSession.update({
      where: { id: session.id },
      data: { draftJson: JSON.stringify(draft) },
    });
    const conciliacao = new ConciliacaoService(prisma);
    const expenses = new ExpenseService(prisma, conciliacao);
    const batches = new CardPurchaseBatchAdapter(expenses, conciliacao, clock);
    const workflow = new ImportSessionWorkflowService(
      prisma,
      clock,
      capability,
      verifier,
      batches,
      gate as never,
      raw as never,
    );
    const ready = await workflow.prepare(auth, session.id, {
      expectedRevision: session.revision,
    });
    expect(ready.state).toBe("READY");
    expect(await prisma.expense.count({ where: { tenantId } })).toBe(0);
    expect(await prisma.cashFlowEntry.count({ where: { tenantId } })).toBe(0);
    const challenge = await workflow.challenge(
      auth,
      session.id,
      {
        expectedRevision: ready.revision,
        proposalHash: ready.proposal!.proposalHash,
      },
      {},
    );
    const financialRequestId = randomUUID();
    await workflow.confirm(
      auth,
      session.id,
      {
        expectedRevision: ready.revision,
        proposalHash: ready.proposal!.proposalHash,
        financialRequestId,
        nonce: challenge.nonce,
      },
      {},
    );
    expect(await prisma.expense.count({ where: { tenantId } })).toBe(0);
    const guardedWorkflow = new ImportSessionWorkflowService(
      prisma,
      clock,
      capability,
      new RuntimeUiGrantVerifier(),
      batches,
      gate as never,
      raw as never,
    );
    await expect(
      guardedWorkflow.execute(auth, session.id, { financialRequestId }, {}),
    ).rejects.toMatchObject({ code: "UI_ACTION_REQUIRED" });
    const [receipt, concurrentReceipt] = await Promise.all([
      workflow.execute(auth, session.id, { financialRequestId }, {}),
      workflow.execute(auth, session.id, { financialRequestId }, {}),
    ]);
    expect(concurrentReceipt).toEqual(receipt);
    const applied = await prisma.importSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(applied).toMatchObject({
      state: "APPLIED",
      draftJson: EMPTY_DRAFT_JSON,
      searchJson: null,
      proposalJson: null,
      challengeJson: null,
    });
    expect(JSON.parse(applied.receiptJson!)).toEqual(receipt);
    expect(
      await prisma.importSessionArtifact.findUniqueOrThrow({
        where: { id: ref.id },
      }),
    ).toMatchObject({
      state: "RELEASED",
      fileName: "document",
      releasedAt: current,
    });
    const count = await prisma.expense.count({ where: { tenantId } });
    expect(count).toBe(1);
    expect(
      await workflow.execute(auth, session.id, { financialRequestId }, {}),
    ).toEqual(receipt);
    expect(await prisma.expense.count({ where: { tenantId } })).toBe(count);
    await expect(
      workflow.execute(
        auth,
        session.id,
        { financialRequestId: randomUUID() },
        {},
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((await service.getResult(auth, session.id)).receipt).toEqual(
      receipt,
    );
    const upload = new ImportUploadService(
      prisma,
      clock,
      capability,
      verifier as never,
      gate as never,
    );
    await expect(
      upload.reserve(
        auth,
        session.id,
        {
          expectedRevision: applied.revision,
          files: [
            {
              id: randomUUID(),
              fileName: "later.csv",
              declaredBytes: 1,
              mime: "text/csv",
            },
          ],
        },
        {},
      ),
    ).rejects.toMatchObject({ code: "LEASE_CONFLICT" });
    const source = Readable.from([Buffer.from("x")]);
    await expect(
      upload.upload(auth, session.id, ref.id, 1, source, {}),
    ).rejects.toMatchObject({ code: "LEASE_CONFLICT" });
    expect(source.readableDidRead).toBe(false);
    const otherTenant = await prisma.tenant.create({
      data: { name: "Other receipt tenant" },
    });
    const otherUser = await prisma.user.create({
      data: {
        tenantId: otherTenant.id,
        username: randomUUID(),
        name: "Other actor",
        role: "ADMIN",
      },
    });
    const otherAuth = mintImportAuthContext({
      tenantId: otherTenant.id,
      userId: otherUser.id,
      presentedSessionVersion: 0,
      tokenExpiresAt: new Date(current.getTime() + 3600000).toISOString(),
    });
    await expect(
      service.getResult(otherAuth, session.id),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      await prisma.expense.count({ where: { tenantId: otherTenant.id } }),
    ).toBe(0);
  });
});
