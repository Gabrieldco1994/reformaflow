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
import {
  DefaultImportSessionCapability,
  importSessionWritesEnabled,
} from "../import-session.capability";
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

  // Immutable extraction fixture, not a financial write: normalize through the
  // production parser/materializer, then exercise real lifecycle services.
  const attachCsv = async (
    sessionId: string,
    bytes: Buffer = Buffer.from(
      `date,title,amount\n2026-10-01,Private ${randomUUID()},1.00\n`,
    ),
  ) => {
    const session = await prisma.importSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
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
        sessionId,
        artifactId: artifact.id,
        position: 0,
        fileName: "private.csv",
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
    await prisma.importSession.update({
      where: { id: sessionId },
      data: { draftJson: JSON.stringify(material.draft) },
    });
    return { session, artifact, ref, material, extraction };
  };

  it("CANCELLED deletes unclaimed evidence only after the last live shared reference closes", async () => {
    const first = await create();
    const second = await create();
    const { artifact, ref, material } = await attachCsv(first.view.id);
    const shared = await prisma.importSessionArtifact.create({
      data: {
        tenantId,
        ownerProjectId: projectId,
        sessionId: second.view.id,
        artifactId: artifact.id,
        position: 0,
        fileName: ref.fileName,
        declaredMime: ref.declaredMime,
        declaredBytes: ref.declaredBytes,
        reservedBytes: 0,
        state: "ATTACHED",
        verifiedAt: current,
      },
    });
    await prisma.importSession.update({
      where: { id: second.view.id },
      data: { draftJson: JSON.stringify(material.draft) },
    });
    const before = await prisma.importObservation.findMany({
      where: { artifactId: artifact.id },
    });
    expect(before).toHaveLength(1);
    expect(JSON.parse(before[0].evidenceJson).sourceDescription).toContain(
      "Private",
    );
    await service.cancel(
      auth,
      first.view.id,
      {
        expectedRevision: first.view.revision,
      },
      {},
    );
    expect(await service.getObservations(auth, first.view.id)).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(
      await prisma.importObservation.findMany({
        where: { artifactId: artifact.id },
      }),
    ).toEqual(before);
    await new VaultReaper(prisma, clock, gate as never, raw as never).runCycle({
      tenantId,
      ownerProjectId: projectId,
      limit: 16,
    });
    expect(
      await prisma.importObservation.findMany({
        where: { artifactId: artifact.id },
      }),
    ).toEqual(before);
    expect(
      (await service.getObservations(auth, second.view.id)).items,
    ).toHaveLength(1);
    await service.cancel(
      auth,
      second.view.id,
      {
        expectedRevision: second.view.revision,
      },
      {},
    );
    expect(
      await prisma.importObservation.count({
        where: { artifactId: artifact.id },
      }),
    ).toBe(0);
    expect(await service.getObservations(auth, second.view.id)).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(
      await prisma.importSessionArtifact.findUnique({
        where: { id: shared.id },
      }),
    ).toBeNull();
    expect(
      await prisma.importArtifact.findUnique({
        where: { id: artifact.id },
      }),
    ).toBeNull();
    expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
  });

  it("EXPIRED reaper deletes unclaimed evidence at the existing seven-day expiry", async () => {
    const created = await create();
    const { artifact } = await attachCsv(created.view.id);
    const row = await prisma.importSession.findUniqueOrThrow({
      where: { id: created.view.id },
    });
    current = new Date(row.expiresAt.getTime() - 1);
    const reaper = new VaultReaper(prisma, clock, gate as never, raw as never);
    await reaper.runCycle({ tenantId, ownerProjectId: projectId, limit: 16 });
    expect(
      await prisma.importObservation.count({
        where: { artifactId: artifact.id },
      }),
    ).toBe(1);
    current = row.expiresAt;
    await reaper.runCycle({ tenantId, ownerProjectId: projectId, limit: 16 });
    expect(
      (
        await prisma.importSession.findUniqueOrThrow({
          where: { id: created.view.id },
        })
      ).state,
    ).toBe("EXPIRED");
    expect(
      await prisma.importObservation.count({
        where: { artifactId: artifact.id },
      }),
    ).toBe(0);
    expect(await service.getObservations(auth, created.view.id)).toEqual({
      items: [],
      nextCursor: null,
    });
    expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
  });

  it.each(["CANCELLED", "EXPIRED"] as const)(
    "reaper cleans historical %s evidence even after original/extraction purge",
    async (terminal) => {
      const created = await create();
      const { material } = await attachCsv(created.view.id);
      await service.cancel(
        auth,
        created.view.id,
        {
          expectedRevision: created.view.revision,
        },
        {},
      );
      // Legacy terminal fixture reproduces rows left by the previous cleanup.
      await prisma.importSession.update({
        where: { id: created.view.id },
        data: { state: terminal },
      });
      const legacyArtifact = await prisma.importArtifact.create({
        data: {
          tenantId,
          ownerProjectId: projectId,
          documentSha256: createHash("sha256")
            .update(randomUUID())
            .digest("hex"),
          verifiedBytes: 1,
          detectedFormat: "CSV",
          state: "PURGED",
        },
      });
      await prisma.importSessionArtifact.create({
        data: {
          tenantId,
          ownerProjectId: projectId,
          sessionId: created.view.id,
          artifactId: legacyArtifact.id,
          position: 0,
          fileName: "document",
          declaredMime: "text/csv",
          declaredBytes: 1,
          reservedBytes: 0,
          state: "RELEASED",
          releasedAt: current,
        },
      });
      for (const observation of material.observations)
        await prisma.importObservation.create({
          data: { ...observation, artifactId: legacyArtifact.id },
        });
      await new VaultReaper(
        prisma,
        clock,
        gate as never,
        raw as never,
      ).runCycle({ tenantId, ownerProjectId: projectId, limit: 16 });
      expect(
        await prisma.importObservation.count({
          where: { artifactId: legacyArtifact.id },
        }),
      ).toBe(0);
      expect(await service.getObservations(auth, created.view.id)).toEqual({
        items: [],
        nextCursor: null,
      });
      expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
    },
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

  it.each([false, true])(
    "real prepare/consent/execute strips persisted drafts, releases refs and replays only the receipt (continuation=%s)",
    async (deferred) => {
      const initialExpenses = await prisma.expense.count({
        where: { tenantId },
      });
      const initialFlows = await prisma.cashFlowEntry.count({
        where: { tenantId },
      });
      const created = await create();
      const bytes = Buffer.from(
        `date,title,amount\n2026-10-01,${deferred ? "Deferred Fixture" : "Fixture"} PARC 1/2,1.00\n${
          deferred ? "2026-10-02,PAGAMENTO EFETUADO private detail,-1.00\n" : ""
        }`,
      );
      const { session, artifact, ref, material, extraction } = await attachCsv(
        created.view.id,
        bytes,
      );
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
      const batches = new CardPurchaseBatchAdapter(
        expenses,
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
      const ready = await workflow.prepare(auth, session.id, {
        expectedRevision: session.revision,
      });
      expect(ready.state).toBe("READY");
      expect(await prisma.expense.count({ where: { tenantId } })).toBe(
        initialExpenses,
      );
      expect(await prisma.cashFlowEntry.count({ where: { tenantId } })).toBe(
        initialFlows,
      );
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
      expect(await prisma.expense.count({ where: { tenantId } })).toBe(
        initialExpenses,
      );
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
      let failCleanup = true;
      prisma.$use(async (params, next) => {
        if (
          failCleanup &&
          params.model === "ImportObservation" &&
          params.action === "updateMany" &&
          params.args.data.evidenceJson === "{}"
        )
          throw new Error("retention cleanup failure");
        return next(params);
      });
      try {
        await expect(
          workflow.execute(auth, session.id, { financialRequestId }, {}),
        ).rejects.toThrow("retention cleanup failure");
      } finally {
        failCleanup = false;
      }
      expect(await prisma.expense.count({ where: { tenantId } })).toBe(
        initialExpenses,
      );
      expect(
        (
          await prisma.importSession.findUniqueOrThrow({
            where: { id: session.id },
          })
        ).state,
      ).toBe("CONFIRMED");
      expect(
        await prisma.importObservation.findMany({
          where: { artifactId: artifact.id },
        }),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            claimVersion: 0,
            evidenceJson: material.observations[0].evidenceJson,
            canonicalExpenseId: null,
          }),
          ...(deferred
            ? [
                expect.objectContaining({
                  evidenceJson: material.observations[1].evidenceJson,
                }),
              ]
            : []),
        ]),
      );
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
      // Deferred observations create a live continuation. APPLIED must not erase
      // its evidence; the last terminal close owns cleanup of the shared artifact.
      if (deferred) {
        expect(receipt.continuationSessionId).not.toBeNull();
        const continuation = await service.getSession(
          auth,
          receipt.continuationSessionId!,
        );
        expect(
          await prisma.importObservation.count({
            where: { artifactId: artifact.id },
          }),
        ).toBe(2);
        expect(
          (await service.getObservations(auth, continuation.id)).items,
        ).toHaveLength(1);
        await service.cancel(
          auth,
          continuation.id,
          {
            expectedRevision: continuation.revision,
          },
          {},
        );
      } else {
        expect(receipt.continuationSessionId).toBeNull();
      }
      const claimed = await prisma.importObservation.findMany({
        where: { artifactId: artifact.id },
      });
      expect(claimed).toHaveLength(1);
      expect(claimed[0]).toMatchObject({
        id: material.observations[0].id,
        artifactId: artifact.id,
        reference: material.observations[0].reference,
        evidenceJson: "{}",
        claimVersion: 1,
        canonicalProjectId: projectId,
        canonicalExpenseId: receipt.items[0].sourceExpenseId,
        canonicalIndex: 0,
        claimSessionId: session.id,
        claimedAt: current,
      });
      expect(JSON.parse(claimed[0].claimReceiptJson!)).toEqual({
        kind: "SESSION",
        sessionId: session.id,
        financialRequestId,
      });
      expect(
        (
          await prisma.importArtifact.findUniqueOrThrow({
            where: { id: artifact.id },
          })
        ).documentSha256,
      ).toBe(artifact.documentSha256);
      expect(await service.getObservations(auth, session.id)).toEqual({
        items: [],
        nextCursor: null,
      });
      expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
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
      expect(count).toBe(initialExpenses + 1);
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
      ).rejects.toMatchObject({
        code: deferred ? "NOT_FOUND" : "LEASE_CONFLICT",
      });
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

      // Same-document reimport: the canonical row is skipped without parsing its
      // redacted evidence. Unclaimed ignored rows can be re-materialized from a
      // newly authorized extraction, without replacing the claim or its FKs.
      for (const terminal of ["CANCELLED", "EXPIRED"] as const) {
        const again = await create();
        const nextSession = await prisma.importSession.findUniqueOrThrow({
          where: { id: again.view.id },
        });
        const nextRef = await prisma.importSessionArtifact.create({
          data: {
            tenantId,
            ownerProjectId: projectId,
            sessionId: nextSession.id,
            artifactId: artifact.id,
            position: 0,
            fileName: "reimport.csv",
            declaredMime: "text/csv",
            declaredBytes: bytes.length,
            reservedBytes: 0,
            state: "ATTACHED",
            verifiedAt: current,
          },
        });
        const reimport = buildImportMaterialization({
          session: nextSession,
          attachment: nextRef,
          artifact,
          extraction,
          observations: claimed,
          draft: {
            ...JSON.parse(EMPTY_DRAFT_JSON),
            scope: { observationIds: [], pendingAttachmentIds: [nextRef.id] },
          },
          newIds: new Map(
            extraction.occurrences.map((occurrence) => [
              occurrence.reference,
              { observationId: randomUUID(), lineId: randomUUID() },
            ]),
          ),
        });
        expect(reimport.draft.lines).toEqual([]);
        expect(reimport.draft.scope.observationIds).not.toContain(
          claimed[0].id,
        );
        for (const observation of reimport.observations)
          await prisma.importObservation.create({ data: observation });
        await prisma.importSession.update({
          where: { id: nextSession.id },
          data: { draftJson: JSON.stringify(reimport.draft) },
        });
        expect(
          await prisma.$transaction((tx) =>
            importSessionWritesEnabled(tx, nextSession, capability),
          ),
        ).toBe(true);
        if (terminal === "CANCELLED") {
          await service.cancel(
            auth,
            nextSession.id,
            {
              expectedRevision: nextSession.revision,
            },
            {},
          );
        } else {
          current = nextSession.expiresAt;
          await new VaultReaper(
            prisma,
            clock,
            gate as never,
            raw as never,
          ).runCycle({ tenantId, ownerProjectId: projectId, limit: 16 });
        }
        expect(
          (
            await prisma.importSession.findUniqueOrThrow({
              where: { id: nextSession.id },
            })
          ).state,
        ).toBe(terminal);
        expect(
          await prisma.importObservation.findMany({
            where: { artifactId: artifact.id },
          }),
        ).toEqual(claimed);
        expect(await service.getObservations(auth, nextSession.id)).toEqual({
          items: [],
          nextCursor: null,
        });
        expect((await service.getResult(auth, session.id)).receipt).toEqual(
          receipt,
        );
        expect(
          await workflow.execute(auth, session.id, { financialRequestId }, {}),
        ).toEqual(receipt);
        expect(await prisma.expense.count({ where: { tenantId } })).toBe(count);
        expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
      }
      // Historical APPLIED claim left after an earlier original purge: repair
      // evidence only, retaining every claim/FK and the authorized result/replay.
      await prisma.importObservation.update({
        where: { id: claimed[0].id },
        data: { evidenceJson: material.observations[0].evidenceJson },
      });
      await prisma.importArtifact.update({
        where: { id: artifact.id },
        data: { state: "PURGED", extractionJson: null },
      });
      await new VaultReaper(
        prisma,
        clock,
        gate as never,
        raw as never,
      ).runCycle({ tenantId, ownerProjectId: projectId, limit: 16 });
      expect(
        await prisma.importObservation.findMany({
          where: { artifactId: artifact.id },
        }),
      ).toEqual(claimed);
      expect((await service.getResult(auth, session.id)).receipt).toEqual(
        receipt,
      );
      expect(
        await workflow.execute(auth, session.id, { financialRequestId }, {}),
      ).toEqual(receipt);
      expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
    },
  );
});
