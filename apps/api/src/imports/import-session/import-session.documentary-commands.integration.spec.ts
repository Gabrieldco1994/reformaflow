// The database guard must run before PrismaClient is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../../scripts/test-db-env.cjs");

import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  ExpenseType,
  ImportSessionAmountMeaning,
  type ImportLineDocumentaryCommandV1,
  type ImportSessionStoredDraftV1,
} from "@reformaflow/domain";
import { PrismaService } from "../../prisma/prisma.service";
import {
  authFor,
  cleanupImportWorld,
  FIXED_NOW,
  mintGrant,
  MutableClock,
  seedImportWorld,
  seedSession,
  type ImportWorld,
} from "../../test-utils/import-session-harness";
import type { CardPurchaseBatchPort } from "./card-purchase-batch.port";
import { documentaryPayloadHash } from "./import-session-documentary.commands";
import { ImportSessionWorkflowService } from "./import-session-workflow.service";
import {
  type ImportSessionCapability,
  type ImportSessionClock,
} from "./import-session.capability";
import type { UiImportGrantScope } from "./import-session.contract";
import type { ImportRawExecutions } from "./import-session.raw-executions";
import {
  ImportUiGrantIssuer,
  RuntimeUiGrantVerifier,
} from "./import-session-ui-grant";
import { terminalDraftJson } from "./import-session.projection";
import { validateStoredDraft } from "./import-session.validation";
import type { ImportVaultGate } from "./vault/vault-state";

const PREFIX = "imp-documentary-command";
const setup = new PrismaClient();
const prisma = new PrismaService();
const clock = new MutableClock(new Date(FIXED_NOW));
const capability: ImportSessionCapability = {
  writesEnabled: () => true,
  newImportFormats: () => [],
};
const issuer = new ImportUiGrantIssuer(clock);
const gate = {
  boot: {
    stopped: new AbortController().signal,
    runtime: () => null,
  },
} as ImportVaultGate;
const workflow = new ImportSessionWorkflowService(
  prisma,
  clock,
  capability,
  new RuntimeUiGrantVerifier(),
  {} as CardPurchaseBatchPort,
  gate,
  {} as ImportRawExecutions,
);

let world: ImportWorld;

const draft = (): ImportSessionStoredDraftV1 => ({
  version: 1,
  lines: [
    {
      id: "line-1",
      observationIds: ["observation-1"],
      titulo: "Compra sintética",
      fornecedor: "Loja sintética",
      tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
      categoriaMaoDeObra: null,
      amountMeaning: ImportSessionAmountMeaning.TOTAL_PURCHASE,
      amountCents: 10001,
      installmentCount: 1,
      dataCompra: "2026-10-09",
      firstDueDate: "2026-10-09",
      targets: [],
      decision: { kind: "CREATE", acceptNaturalDuplicate: false },
    },
  ],
  selectedLineIds: ["line-1"],
  questions: [],
  scope: { observationIds: ["observation-1"], pendingAttachmentIds: [] },
});

const unresolvedDraft = (): ImportSessionStoredDraftV1 => {
  const value = draft();
  return {
    ...value,
    lines: value.lines.map((line) => ({
      ...line,
      tipoDespesa: null,
      firstDueDate: null,
      targets: null,
      decision: { kind: "UNRESOLVED" },
    })),
  };
};

async function financialAndClaimSnapshot() {
  const where = { tenantId: world.tenantId };
  const [
    expenses,
    receipts,
    cashFlowEntries,
    allocations,
    settlements,
    funding,
    claims,
  ] = await Promise.all([
    setup.expense.count({ where }),
    setup.receipt.count({ where }),
    setup.cashFlowEntry.count({ where }),
    setup.rateioAllocation.count({ where }),
    setup.crossProjectSettlement.count({ where }),
    setup.invoiceFundingAllocation.count({ where }),
    setup.importObservation.findMany({
      where,
      orderBy: { id: "asc" },
      select: {
        id: true,
        claimVersion: true,
        canonicalProjectId: true,
        canonicalExpenseId: true,
        canonicalReceiptId: true,
        claimSessionId: true,
        claimReceiptJson: true,
        claimedAt: true,
      },
    }),
  ]);
  return {
    expenses,
    receipts,
    cashFlowEntries,
    allocations,
    settlements,
    funding,
    claims,
  };
}

function grant(
  auth: ReturnType<typeof authFor>,
  sessionId: string,
  operation: "DEFER" | "REACTIVATE",
  command: ImportLineDocumentaryCommandV1,
): unknown {
  const payloadHash = documentaryPayloadHash(sessionId, operation, command);
  const scope: UiImportGrantScope = {
    operation,
    sessionId,
    expectedRevision: command.expectedRevision,
    requestId: command.requestId,
    lineId: command.lineId,
    payloadHash,
  };
  return mintGrant(issuer, auth, scope);
}

describe("documentary command idempotency (real Prisma)", () => {
  beforeAll(async () => {
    await setup.$connect();
    await prisma.onModuleInit();
    world = await seedImportWorld(setup, PREFIX);
  });

  beforeEach(async () => {
    clock.current = new Date(FIXED_NOW);
    await setup.importSession.deleteMany({
      where: { tenantId: world.tenantId },
    });
    await setup.user.updateMany({
      where: { tenantId: world.tenantId },
      data: { sessionVersion: 0 },
    });
  });

  afterAll(async () => {
    await cleanupImportWorld(setup, PREFIX);
    await prisma.onModuleDestroy();
    await setup.$disconnect();
  });

  it("replays exactly, conflicts on a changed operation and records semantic no-change", async () => {
    const row = await seedSession(setup, world, {
      draftJson: JSON.stringify(draft()),
    });
    const auth = authFor(world.users.owner);
    const command = {
      version: 1,
      requestId: randomUUID(),
      expectedRevision: 1,
      lineId: "line-1",
    } satisfies ImportLineDocumentaryCommandV1;

    const applied = await workflow.defer(
      auth,
      row.id,
      command,
      grant(auth, row.id, "DEFER", command),
    );
    expect(applied).toEqual({
      version: 1,
      requestId: command.requestId,
      operation: "DEFER",
      outcome: "APPLIED",
      revision: 2,
    });
    const afterApplied = await setup.importSession.findUniqueOrThrow({
      where: { id: row.id },
    });

    await expect(
      workflow.defer(
        auth,
        row.id,
        command,
        grant(auth, row.id, "DEFER", command),
      ),
    ).resolves.toEqual(applied);
    expect(
      await setup.importSession.findUniqueOrThrow({ where: { id: row.id } }),
    ).toEqual(afterApplied);

    const conflict = {
      ...command,
      expectedRevision: 2,
    };
    await expect(
      workflow.reactivate(
        auth,
        row.id,
        conflict,
        grant(auth, row.id, "REACTIVATE", conflict),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const noChange = {
      ...command,
      requestId: randomUUID(),
      expectedRevision: 2,
    };
    const receipt = await workflow.defer(
      auth,
      row.id,
      noChange,
      grant(auth, row.id, "DEFER", noChange),
    );
    expect(receipt).toMatchObject({ outcome: "NO_CHANGE", revision: 2 });
    const afterNoChange = await setup.importSession.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(afterNoChange.revision).toBe(afterApplied.revision);
    expect(afterNoChange.lastUserEditAt).toEqual(afterApplied.lastUserEditAt);
    expect(afterNoChange.expiresAt).toEqual(afterApplied.expiresAt);
  });

  it("canonically defers and reactivates an unresolved producer line without side effects", async () => {
    const row = await seedSession(setup, world, {
      draftJson: JSON.stringify(unresolvedDraft()),
    });
    const auth = authFor(world.users.owner);
    const beforeEffects = await financialAndClaimSnapshot();
    const deferCommand = {
      version: 1,
      requestId: randomUUID(),
      expectedRevision: 1,
      lineId: "line-1",
    } satisfies ImportLineDocumentaryCommandV1;

    const deferredReceipt = await workflow.defer(
      auth,
      row.id,
      deferCommand,
      grant(auth, row.id, "DEFER", deferCommand),
    );
    expect(deferredReceipt).toEqual({
      version: 1,
      requestId: deferCommand.requestId,
      operation: "DEFER",
      outcome: "APPLIED",
      revision: 2,
    });
    const afterDeferred = await setup.importSession.findUniqueOrThrow({
      where: { id: row.id },
    });
    const deferred = validateStoredDraft(JSON.parse(afterDeferred.draftJson));
    expect(deferred.lines[0]).toMatchObject({
      decision: { kind: "DEFER" },
      targets: [],
    });
    expect(deferred.selectedLineIds).not.toContain("line-1");
    expect(deferred.commandLedger?.items).toHaveLength(1);

    await expect(
      workflow.defer(
        auth,
        row.id,
        deferCommand,
        grant(auth, row.id, "DEFER", deferCommand),
      ),
    ).resolves.toEqual(deferredReceipt);
    const afterReplay = await setup.importSession.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(afterReplay).toEqual(afterDeferred);
    expect(afterReplay.revision).toBe(2);
    expect(afterReplay.draftJson).toBe(afterDeferred.draftJson);
    expect(
      validateStoredDraft(JSON.parse(afterReplay.draftJson)).commandLedger
        ?.items,
    ).toHaveLength(1);

    const reactivateCommand = {
      ...deferCommand,
      requestId: randomUUID(),
      expectedRevision: 2,
    };
    await expect(
      workflow.reactivate(
        auth,
        row.id,
        reactivateCommand,
        grant(auth, row.id, "REACTIVATE", reactivateCommand),
      ),
    ).resolves.toMatchObject({
      operation: "REACTIVATE",
      outcome: "APPLIED",
      revision: 3,
    });
    const afterReactivated = await setup.importSession.findUniqueOrThrow({
      where: { id: row.id },
    });
    const reactivated = validateStoredDraft(
      JSON.parse(afterReactivated.draftJson),
    );
    expect(reactivated.lines[0]).toMatchObject({
      decision: { kind: "UNRESOLVED" },
      targets: null,
    });
    expect(reactivated.selectedLineIds).toContain("line-1");
    expect(reactivated.commandLedger?.items).toHaveLength(2);
    expect(await financialAndClaimSnapshot()).toEqual(beforeEffects);
  });

  it("preserves a historical receipt through terminal scrub without reopening", async () => {
    const row = await seedSession(setup, world, {
      draftJson: JSON.stringify(draft()),
    });
    const auth = authFor(world.users.owner);
    const command = {
      version: 1,
      requestId: randomUUID(),
      expectedRevision: 1,
      lineId: "line-1",
    } satisfies ImportLineDocumentaryCommandV1;
    const receipt = await workflow.defer(
      auth,
      row.id,
      command,
      grant(auth, row.id, "DEFER", command),
    );
    const current = await setup.importSession.findUniqueOrThrow({
      where: { id: row.id },
    });
    await setup.importSession.update({
      where: { id: row.id },
      data: {
        state: "CANCELLED",
        revision: current.revision + 1,
        closedAt: FIXED_NOW,
        draftJson: terminalDraftJson(current.draftJson),
      },
    });

    await expect(
      workflow.defer(
        auth,
        row.id,
        command,
        grant(auth, row.id, "DEFER", command),
      ),
    ).resolves.toEqual(receipt);
    const terminal = await setup.importSession.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(terminal.state).toBe("CANCELLED");
    expect(JSON.parse(terminal.draftJson)).toEqual({
      version: 1,
      lines: [],
      selectedLineIds: [],
      questions: [],
      scope: { observationIds: [], pendingAttachmentIds: [] },
      commandLedger: expect.any(Object),
    });
  });

  it("serializes a concurrent exact double-run into one semantic write", async () => {
    const row = await seedSession(setup, world, {
      draftJson: JSON.stringify(draft()),
    });
    const auth = authFor(world.users.owner);
    const command = {
      version: 1,
      requestId: randomUUID(),
      expectedRevision: 1,
      lineId: "line-1",
    } satisfies ImportLineDocumentaryCommandV1;

    const results = await Promise.all([
      workflow.defer(
        auth,
        row.id,
        command,
        grant(auth, row.id, "DEFER", command),
      ),
      workflow.defer(
        auth,
        row.id,
        command,
        grant(auth, row.id, "DEFER", command),
      ),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ outcome: "APPLIED", revision: 2 });

    const persisted = await setup.importSession.findUniqueOrThrow({
      where: { id: row.id },
    });
    const stored = JSON.parse(
      persisted.draftJson,
    ) as ImportSessionStoredDraftV1;
    expect(persisted.revision).toBe(2);
    expect(stored.commandLedger?.items).toHaveLength(1);
  });
});
