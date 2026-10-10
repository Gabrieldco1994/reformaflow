import { rawTestDependencies } from "../../test-utils/import-session-raw-harness";
require("../../../../../scripts/test-db-env.cjs");
import { ImportVaultGate } from "./vault/vault-state";

import { existsSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient, type Prisma } from "@prisma/client";
import type {
  ImportSessionProposalV1,
  ImportSessionViewV1,
} from "@reformaflow/domain";
import { PrismaService } from "../../prisma/prisma.service";
import {
  authFor,
  cleanupImportWorld,
  MutableClock,
  seedImportWorld,
  seedSession,
  type ImportWorld,
} from "../../test-utils/import-session-harness";
import {
  validationDraft,
  validationProposal,
} from "../../test-utils/import-session-validation-fixtures";
import type {
  CardPurchaseBatchPort,
  CardPurchasePreparation,
} from "./card-purchase-batch.port";
import type {
  ImportSessionCapability,
  ImportSessionClock,
} from "./import-session.capability";
import {
  assertLockedImportSession,
  type AuthenticatedImportContext,
  type LockedImportSession,
  type UiImportFinancialActionVerifier,
} from "./import-session.contract";
import { ImportSessionCorruptStateError } from "./import-session.errors";
import { parseProposal, parseStoredDraft } from "./import-session.projection";
import { RuntimeUiGrantVerifier } from "./import-session-ui-grant";

interface Workflow {
  edit(
    auth: AuthenticatedImportContext,
    id: string,
    body: unknown,
  ): Promise<ImportSessionViewV1>;
  prepare(
    auth: AuthenticatedImportContext,
    id: string,
    body: unknown,
  ): Promise<ImportSessionViewV1>;
}
type WorkflowConstructor = new (
  prisma: PrismaService,
  clock: ImportSessionClock,
  capability: ImportSessionCapability,
  verifier: UiImportFinancialActionVerifier,
  batches: CardPurchaseBatchPort,
  gate: ImportVaultGate, raw: ReturnType<typeof rawTestDependencies>[1],
) => Workflow;

function workflowConstructor(): WorkflowConstructor {
  const path = join(__dirname, "import-session-workflow.service.ts");
  expect({ path, exists: existsSync(path) }).toEqual({ path, exists: true });
  const exports: {
    ImportSessionWorkflowService: WorkflowConstructor;
  } = require("./import-session-workflow.service");
  expect(typeof exports.ImportSessionWorkflowService).toBe("function");
  return exports.ImportSessionWorkflowService;
}

const NOW = new Date("2026-10-06T15:00:00.000Z");
const DEADLINE = new Date("2026-10-13T15:00:00.000Z");

describe("W prepare RED: real transactions, test-only incomplete port, no financial proof", () => {
  const prefix = "w636-prepare";
  const setup = new PrismaClient();
  const prisma = new PrismaService();
  const clock = new MutableClock(NOW);
  let world: ImportWorld;
  let enabled = true;
  let failure: Error | null = null;
  let busyAttempts = 0;
  const handles: Array<{
    tx: Prisma.TransactionClient;
    auth: AuthenticatedImportContext;
    session: LockedImportSession;
  }> = [];
  const port: CardPurchaseBatchPort = {
    prepareInTx: jest.fn(
      async (tx, auth, session): Promise<CardPurchasePreparation> => {
        assertLockedImportSession(tx, auth, session);
        handles.push({ tx, auth, session });
        if (failure) throw failure;
        if (busyAttempts-- > 0) throw new Error("SQLITE_BUSY");
        return {
          kind: "NEEDS_INPUT",
          draft: structuredClone(session.draft),
          search: {
            version: 1,
            revision: session.revision + 1,
            complete: false,
            candidates: [],
            coverage: {
              recipe: "CARD_PURCHASE_V1",
              inputHash: "a".repeat(64),
              steps: [],
            },
          },
        };
      },
    ),
    applyInTx: jest.fn(async () => {
      throw new Error("Preparation must not apply finances");
    }),
  };
  const auth = () => authFor(world.users.owner, { expiresAt: DEADLINE });
  const workflow = () => {
    const Constructor = workflowConstructor();
    return new Constructor(
      prisma,
      clock,
      { writesEnabled: () => enabled, newImportFormats: () => [] },
      new RuntimeUiGrantVerifier(),
      port,
      ...rawTestDependencies(new ImportVaultGate(prisma, clock, {}, process.cwd()), clock, { writesEnabled: () => enabled, newImportFormats: () => [] }),
    );
  };
  const seed = () =>
    seedSession(setup, world, {
      revision: 7,
      lastUserEditAt: NOW,
      expiresAt: DEADLINE,
    });

  beforeAll(async () => {
    await setup.$connect();
    await prisma.onModuleInit();
    world = await seedImportWorld(setup, prefix);
  });
  beforeEach(() => {
    handles.length = 0;
    failure = null;
    busyAttempts = 0;
    enabled = true;
    clock.current = NOW;
    jest.clearAllMocks();
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await cleanupImportWorld(setup, prefix);
    await setup.$disconnect();
    await prisma.onModuleDestroy();
  });

  it("exports the actual coordinator with edit and prepare", () => {
    const instance = workflow();
    expect(typeof instance.edit).toBe("function");
    expect(typeof instance.prepare).toBe("function");
  });

  it("publishes incomplete 7 -> 8 once, without proposal/challenge/financial effects or renewed retention", async () => {
    const instance = workflow();
    const row = await seed();
    clock.current = new Date(NOW.getTime() + 60_000);
    const result = await instance.prepare(auth(), row.id, {
      expectedRevision: 7,
    });
    expect(result).toMatchObject({
      state: "NEEDS_INPUT",
      revision: 8,
      searchComplete: false,
      proposal: null,
      confirmation: null,
      receipt: null,
      expiresAt: DEADLINE.toISOString(),
    });
    expect(result.actions).not.toContain("CONFIRM");
    expect(result.actions).not.toContain("EXECUTE");
    const saved = await setup.importSession.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(saved).toMatchObject({
      revision: 8,
      lastUserEditAt: NOW,
      expiresAt: DEADLINE,
      proposalJson: null,
      proposalHash: null,
      challengeJson: null,
      financialRequestId: null,
    });
    expect(JSON.parse(saved.searchJson!)).toMatchObject({
      revision: 8,
      complete: false,
    });
    expect(port.applyInTx).not.toHaveBeenCalled();
    expect(
      await setup.expense.count({ where: { tenantId: world.tenantId } }),
    ).toBe(0);
  });

  it("two preparations with revision 7 cannot both publish revision 8", async () => {
    const instance = workflow();
    const row = await seed();
    const results = await Promise.allSettled([
      instance.prepare(auth(), row.id, { expectedRevision: 7 }),
      instance.prepare(auth(), row.id, { expectedRevision: 7 }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "REVISION_CONFLICT" },
    });
    expect(
      await setup.importSession.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({
      revision: 8,
      expiresAt: DEADLINE,
    });
  });

  it("no-op edit does not renew seven days or advance revision", async () => {
    const instance = workflow();
    const row = await seed();
    clock.current = new Date(NOW.getTime() + 86_400_000);
    await instance.edit(auth(), row.id, {
      expectedRevision: 7,
      questionId: null,
      replaceLines: [],
      selectedLineIds: [],
    });
    expect(
      await setup.importSession.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({
      revision: 7,
      lastUserEditAt: NOW,
      expiresAt: DEADLINE,
    });
  });

  it.each([
    { scope: { observationIds: [], pendingAttachmentIds: [] } },
    { ownerProjectId: "other" },
    { questionId: "not-a-question" },
    { selectedLineIds: ["not-a-line"] },
  ])("rejects invalid edit envelope %j without a write", async (patch) => {
    const instance = workflow();
    const row = await seed();
    const before = await setup.importSession.findUniqueOrThrow({
      where: { id: row.id },
    });
    await expect(
      instance.edit(auth(), row.id, {
        expectedRevision: 7,
        questionId: null,
        replaceLines: [],
        selectedLineIds: [],
        ...patch,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(
      await setup.importSession.findUniqueOrThrow({ where: { id: row.id } }),
    ).toEqual(before);
  });

  it("releases the transaction-bound handle after successful incomplete preparation", async () => {
    const instance = workflow();
    const row = await seed();
    await instance.prepare(auth(), row.id, { expectedRevision: 7 });
    expect(handles).toHaveLength(1);
    const captured = handles[0];
    expect(() =>
      assertLockedImportSession(captured.tx, captured.auth, captured.session),
    ).toThrow("Invalid import execution handle");
  });

  it("releases the handle on a non-retryable failure and rolls back publication", async () => {
    const instance = workflow();
    const row = await seed();
    const before = await setup.importSession.findUniqueOrThrow({
      where: { id: row.id },
    });
    failure = new Error("test-only preflight failure");
    await expect(
      instance.prepare(auth(), row.id, { expectedRevision: 7 }),
    ).rejects.toBe(failure);
    expect(handles).toHaveLength(1);
    for (const captured of handles) {
      expect(() =>
        assertLockedImportSession(captured.tx, captured.auth, captured.session),
      ).toThrow("Invalid import execution handle");
    }
    expect(
      await setup.importSession.findUniqueOrThrow({ where: { id: row.id } }),
    ).toEqual(before);
  });

  it("retries busy twice with fresh handles and exactly three writer transactions", async () => {
    const instance = workflow();
    const row = await seed();
    busyAttempts = 2;
    const transactions = jest.spyOn(prisma, "$transaction");
    await expect(
      instance.prepare(auth(), row.id, { expectedRevision: 7 }),
    ).resolves.toMatchObject({ revision: 8 });
    expect(handles).toHaveLength(3);
    expect(new Set(handles.map((item) => item.tx)).size).toBe(3);
    expect(new Set(handles.map((item) => item.session)).size).toBe(3);
    expect(transactions).toHaveBeenCalledTimes(3);
    for (const call of transactions.mock.calls) {
      expect(call[1]).toEqual({ maxWait: 5000, timeout: 20000 });
    }
    for (const captured of handles) {
      expect(() =>
        assertLockedImportSession(captured.tx, captured.auth, captured.session),
      ).toThrow("Invalid import execution handle");
    }
  });

  it("exhausted busy attempts leave revision and retention unchanged", async () => {
    const instance = workflow();
    const row = await seed();
    busyAttempts = 3;
    await expect(
      instance.prepare(auth(), row.id, { expectedRevision: 7 }),
    ).rejects.toMatchObject({
      code: "RETRYABLE_WRITE_CONFLICT",
      retryable: true,
    });
    expect(handles).toHaveLength(3);
    expect(
      await setup.importSession.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({
      revision: 7,
      state: "DRAFT",
      searchJson: null,
      expiresAt: DEADLINE,
    });
  });

  it("OFF refuses first prepare without invoking the financial port", async () => {
    const instance = workflow();
    const row = await seed();
    enabled = false;
    await expect(
      instance.prepare(auth(), row.id, { expectedRevision: 7 }),
    ).rejects.toMatchObject({ code: "CAPABILITY_DISABLED" });
    expect(port.prepareInTx).not.toHaveBeenCalled();
  });
});

function resolvedProposal(): ImportSessionProposalV1 {
  const proposal = validationProposal("cycle-session", "cycle-target");
  proposal.lines = [proposal.lines[0]];
  const line = proposal.lines[0];
  if (line.kind !== "CREATE")
    throw new Error("Expected literal CREATE fixture");
  line.schedule = structuredClone(line.schedule);
  line.schedule.occurrences[1].invoiceDueMonth = "2026-11";
  line.targets[0].schedule = structuredClone(line.schedule);
  proposal.deferredObservationIds = [];
  proposal.deferredAttachmentIds = [];
  proposal.retainUntil = null;
  proposal.invoiceDeltas = [
    { invoiceDueMonth: "2026-10", amountCents: 50 },
    { invoiceDueMonth: "2026-11", amountCents: 51 },
  ];
  proposal.effects!.keptExistingCount = 0;
  return proposal;
}

describe("W live proposal-reader RED: CREATE cycles must be resolved, including historical proposals", () => {
  it("CONTROL: accepts the fully resolved public CREATE and preserves its amounts", () => {
    const proposal = resolvedProposal();
    expect(
      parseProposal(
        JSON.stringify(proposal),
        proposal.sessionId,
        proposal.proposalHash,
      ),
    ).toEqual(proposal);
  });

  it.each(["source", "target"] as const)(
    "rejects unknown %s CREATE cycle even with feasible aggregate totals",
    (where) => {
      const proposal = resolvedProposal();
      const line = proposal.lines[0];
      if (line.kind !== "CREATE") throw new Error("Expected CREATE");
      const schedule =
        where === "source" ? line.schedule : line.targets[0].schedule;
      schedule.occurrences[1].invoiceDueMonth = null;
      expect(() =>
        parseProposal(
          JSON.stringify(proposal),
          proposal.sessionId,
          proposal.proposalHash,
        ),
      ).toThrow(ImportSessionCorruptStateError);
    },
  );

  it("rejects an unknown source cycle with contradictory monthly aggregates too", () => {
    const proposal = resolvedProposal();
    proposal.lines[0].schedule.occurrences[1].invoiceDueMonth = null;
    proposal.invoiceDeltas = [{ invoiceDueMonth: "2026-10", amountCents: 999 }];
    expect(() =>
      parseProposal(
        JSON.stringify(proposal),
        proposal.sessionId,
        proposal.proposalHash,
      ),
    ).toThrow(ImportSessionCorruptStateError);
  });

  it("CONTROL: KEEP and draft unknowns remain legal without financial defaults", () => {
    const proposal = resolvedProposal();
    const schedule = structuredClone(proposal.lines[0].schedule);
    schedule.occurrences[1].invoiceDueMonth = null;
    proposal.lines = [
      {
        kind: "KEEP_EXISTING",
        lineId: "line-keep",
        sourceExpenseId: "existing",
        totalCents: 101,
        schedule,
      },
    ];
    proposal.createdEconomicTotalCents = 0;
    proposal.invoiceDeltas = [];
    proposal.effects = {
      personalSourceCreates: 0,
      reformaTargetCreates: 0,
      expenseCreates: 0,
      cashFlowEntryCreates: 0,
      rateioAllocationCreates: 0,
      keptExistingCount: 1,
      deferredCount: 0,
      excludedCount: 0,
      ignoredCount: 0,
    };
    expect(
      parseProposal(
        JSON.stringify(proposal),
        proposal.sessionId,
        proposal.proposalHash,
      ),
    ).toEqual(proposal);
    const input = validationDraft("cycle-target");
    expect(parseStoredDraft(JSON.stringify(input))).toEqual(input);
    expect(input.lines[2]).toMatchObject({
      amountCents: null,
      firstDueDate: null,
      decision: { kind: "UNRESOLVED" },
    });
  });
});
