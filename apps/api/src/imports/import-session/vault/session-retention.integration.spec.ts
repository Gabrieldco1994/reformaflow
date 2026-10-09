import { randomUUID } from "node:crypto";
import {
  IMPORT_SESSION_CONSENT_POLICY_VERSION,
  IMPORT_SESSION_LIMITS,
  ProjectType,
} from "@reformaflow/domain";
import { PrismaService } from "../../../prisma/prisma.service";
import { ImportSessionService } from "../import-session.service";
import { ImportSessionWorkflowService } from "../import-session-workflow.service";
import { DefaultImportSessionCapability } from "../import-session.capability";
import { mintImportAuthContext } from "../import-session.auth";
import { EMPTY_DRAFT_JSON } from "../import-session.projection";
import { VaultReaper } from "./vault-reaper";

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
});
