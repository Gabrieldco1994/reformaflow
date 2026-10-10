import { rawTestDependencies } from "../../test-utils/import-session-raw-harness";
require("../../../../../scripts/test-db-env.cjs");
import { ImportVaultGate } from "./vault/vault-state";

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ExecutionContextHost } from "@nestjs/core/helpers/execution-context-host";
import { PrismaClient } from "@prisma/client";
import {
  ExpenseType,
  ImportSessionErrorCode,
  type ImportSessionProposalV1,
  type ImportSessionStoredDraftV1,
  type ImportSessionConfirmResponseV1,
  type ImportSessionReceiptV1,
  type ImportSessionViewV1,
  type ImportSessionChallengeResponseV1,
  type ImportCurrentLotV1,
} from "@reformaflow/domain";
import { PrismaService } from "../../prisma/prisma.service";
import {
  cleanupImportWorld,
  mintGrant,
  MutableClock,
  seedImportWorld,
  seedSession,
  type ImportWorld,
} from "../../test-utils/import-session-harness";
import type {
  CardPurchaseBatchPort,
  CardPurchasePreparation,
} from "./card-purchase-batch.port";
import {
  assertMintedImportContext,
  ImportAuthGuard,
} from "./import-session.auth";
import type {
  ImportSessionCapability,
  ImportSessionClock,
} from "./import-session.capability";
import type {
  AuthenticatedImportContext,
  UiImportFinancialActionScope,
  UiImportFinancialActionVerifier,
} from "./import-session.contract";
import {
  ImportSessionCorruptStateError,
  ImportSessionError,
} from "./import-session.errors";
import { ImportSessionService } from "./import-session.service";
import {
  ImportUiGrantIssuer,
  RuntimeUiGrantVerifier,
} from "./import-session-ui-grant";
import { IMPORT_UI_HEADER, ImportUiGuard } from "./import-session-ui.guard";
import { canonical } from "../../common/canonical";
import {
  assertLockedImportSession,
  consumePreparedCardBatch,
  mintLockedImportSession,
  mintPreparedCardBatch,
  releaseLockedImportSession,
} from "./import-session.contract";
import { buildImportPreparationPlan } from "./import-session.preparation";
import { EMPTY_DRAFT_JSON } from "./import-session.projection";
import { runImportSessionWrite } from "./import-session.writer";

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
  currentLot(
    auth: AuthenticatedImportContext,
    id: string,
  ): Promise<ImportCurrentLotV1>;
  challenge(
    auth: AuthenticatedImportContext,
    id: string,
    body: unknown,
    grant: unknown,
  ): Promise<ImportSessionChallengeResponseV1>;
  confirm(
    auth: AuthenticatedImportContext,
    id: string,
    body: unknown,
    grant: unknown,
  ): Promise<ImportSessionConfirmResponseV1>;
  execute(
    auth: AuthenticatedImportContext,
    id: string,
    body: unknown,
    grant: unknown,
  ): Promise<ImportSessionReceiptV1>;
}
type WorkflowConstructor = new (
  prisma: PrismaService,
  clock: ImportSessionClock,
  capability: ImportSessionCapability,
  verifier: UiImportFinancialActionVerifier,
  batches: CardPurchaseBatchPort,
  gate: ImportVaultGate,
  raw: ReturnType<typeof rawTestDependencies>[1],
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
// Opaque, already-approved historical hash; this fixture does not derive an AC18 hash.
const H8 = "8".repeat(64);
const KEY = "123e4567-e89b-42d3-a456-426614174000";

function receiptFor(
  sessionId: string,
  projectId: string,
): ImportSessionReceiptV1 {
  return {
    version: 1,
    sessionId,
    financialRequestId: KEY,
    confirmedRevision: 8,
    bindingVersion: 0,
    confirmationHash: null,
    appliedAt: NOW.toISOString(),
    continuationSessionId: null,
    items: [
      {
        lineId: "line-created",
        outcome: "CREATED",
        sourceExpenseId: "historical-source",
        targetExpenseIds: [],
        allocationIds: [],
        cashFlowEntryIds: ["historical-cfe-1", "historical-cfe-2"],
      },
    ],
    auditItems: [],
    snapshot: {
      lines: [
        {
          lineId: "line-created",
          titulo: "Approved purchase",
          dataCompra: "2026-10-05",
          totalCents: 100,
          sourceProjectId: projectId,
          targets: [],
          schedule: {
            version: 1,
            occurrences: [
              {
                index: 0,
                parcela: "1/2",
                valor: 50,
                data: "2026-11-10",
                invoiceDueMonth: "2026-11",
              },
              {
                index: 1,
                parcela: "2/2",
                valor: 50,
                data: "2026-12-10",
                invoiceDueMonth: "2026-12",
              },
            ],
          },
        },
      ],
      participantProjectIds: [projectId],
      createdEconomicTotalCents: 100,
      bankCashDeltaCents: 0,
      invoiceDeltas: [
        { invoiceDueMonth: "2026-11", amountCents: 50 },
        { invoiceDueMonth: "2026-12", amountCents: 50 },
      ],
    },
  };
}

describe("W execution RED: historical tuple and immutable receipt replay, not real A effects", () => {
  const prefix = "w636-execution";
  const setup = new PrismaClient();
  const prisma = new PrismaService();
  const clock = new MutableClock(NOW);
  const verifier = new RuntimeUiGrantVerifier();
  const issuer = new ImportUiGrantIssuer(clock);
  const service = new ImportSessionService(
    prisma,
    clock,
    { writesEnabled: () => false, newImportFormats: () => [] },
    verifier,
    ...rawTestDependencies(
      new ImportVaultGate(prisma, clock, {}, process.cwd()),
      clock,
      { writesEnabled: () => false, newImportFormats: () => [] },
    ),
  );
  let world: ImportWorld;
  const port: CardPurchaseBatchPort = {
    prepareInTx: jest.fn(async () => {
      throw new Error("Replay must not prepare a financial batch");
    }),
    applyInTx: jest.fn(async () => {
      throw new Error("Replay must not apply a financial batch");
    }),
  };
  const workflow = () => {
    const Constructor = workflowConstructor();
    return new Constructor(
      prisma,
      clock,
      { writesEnabled: () => false, newImportFormats: () => [] },
      verifier,
      port,
      ...rawTestDependencies(
        new ImportVaultGate(prisma, clock, {}, process.cwd()),
        clock,
        { writesEnabled: () => false, newImportFormats: () => [] },
      ),
    );
  };

  function admission(scope: UiImportFinancialActionScope) {
    const request = {
      headers: { origin: "http://localhost:3000", [IMPORT_UI_HEADER]: "1" },
      user: {
        id: world.users.owner.id,
        tenantId: world.tenantId,
        authClaims: {
          sessionVersion: 0,
          expiresAtEpochSeconds: DEADLINE.getTime() / 1000,
        },
      },
    };
    const context = new ExecutionContextHost([request]);
    expect(new ImportAuthGuard().canActivate(context)).toBe(true);
    const key = Object.getOwnPropertySymbols(request).find(
      (symbol) => symbol.description === "IMPORT_AUTH_CONTEXT",
    );
    if (!key) throw new Error("Auth guard did not attach its context");
    const auth: unknown = Reflect.get(request, key);
    assertMintedImportContext(auth);
    expect(
      new ImportUiGuard(
        { allowed: () => ["http://localhost:3000"] },
        issuer,
      ).canActivate(context),
    ).toBe(true);
    return { auth, grant: issuer.issueFinancialAction(request, auth, scope) };
  }

  async function applied(snapshot?: (receipt: ImportSessionReceiptV1) => void) {
    const id = randomUUID();
    const receipt = receiptFor(id, world.projects.pessoal);
    snapshot?.(receipt);
    const {
      bindingVersion: _bindingVersion,
      confirmationHash: _confirmationHash,
      ...legacyReceipt
    } = receipt;
    const row = await seedSession(setup, world, {
      id,
      state: "APPLIED",
      revision: 10,
      proposalHash: H8,
      financialRequestId: KEY,
      confirmedRevision: 8,
      confirmedSessionVersion: 0,
      confirmedAt: NOW,
      receiptJson: JSON.stringify({ ...legacyReceipt, proposalHash: H8 }),
      closedAt: NOW,
      expiresAt: new Date(NOW.getTime() - 1),
    });

    return { row, receipt };
  }

  beforeAll(async () => {
    await setup.$connect();
    await prisma.onModuleInit();
  });
  beforeEach(async () => {
    clock.current = NOW;
    world = await seedImportWorld(setup, prefix);
    jest.clearAllMocks();
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await cleanupImportWorld(setup, prefix);
    await setup.$disconnect();
    await prisma.onModuleDestroy();
  });

  it("exports confirm and execute at the approved coordinator path", () => {
    const instance = workflow();
    expect(typeof instance.confirm).toBe("function");
    expect(typeof instance.execute).toBe("function");
  });

  it("CONTROL: recovery returns the persisted revision-8/H8 receipt from APPLIED revision 10 without live expenses", async () => {
    const { row, receipt } = await applied();
    const { auth } = admission({
      operation: "EXECUTE",
      sessionId: row.id,
      financialRequestId: KEY,
    });
    expect(
      await setup.expense.count({ where: { tenantId: world.tenantId } }),
    ).toBe(0);
    expect(await service.getResult(auth, row.id)).toEqual({
      state: "APPLIED",
      receipt,
    });
  });

  it("exact confirm replay classifies revision 8/H8/key before current revision 10, null nonce, expiry and OFF", async () => {
    const instance = workflow();
    const { row } = await applied();
    const body = {
      expectedRevision: 8,
      confirmationHash: H8,
      financialRequestId: KEY,
      nonce: null,
    };
    const action = admission({
      operation: "CONFIRM",
      sessionId: row.id,
      expectedRevision: 8,
      confirmationHash: H8,
      financialRequestId: KEY,
    });
    const before = await setup.importSession.findUniqueOrThrow({
      where: { id: row.id },
    });
    await expect(
      instance.confirm(action.auth, row.id, body, action.grant),
    ).resolves.toEqual({
      sessionId: row.id,
      financialRequestId: KEY,
      state: "APPLIED",
    });
    expect(
      await setup.importSession.findUniqueOrThrow({ where: { id: row.id } }),
    ).toEqual(before);
    expect(port.prepareInTx).not.toHaveBeenCalled();
    expect(port.applyInTx).not.toHaveBeenCalled();
  });

  it.each([
    { expectedRevision: 9 },
    { financialRequestId: "223e4567-e89b-42d3-a456-426614174000" },
  ])(
    "different persisted confirm tuple %j conflicts even while OFF",
    async (patch) => {
      const instance = workflow();
      const { row } = await applied();
      const body = {
        expectedRevision: 8,
        confirmationHash: H8,
        financialRequestId: KEY,
        nonce: null,
        ...patch,
      };
      const action = admission({
        operation: "CONFIRM",
        sessionId: row.id,
        expectedRevision: body.expectedRevision,
        confirmationHash: body.confirmationHash,
        financialRequestId: body.financialRequestId,
      });
      await expect(
        instance.confirm(action.auth, row.id, body, action.grant),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    },
  );

  it("lost confirm response is recoverable with a fresh invocation grant, not a new confirmation", async () => {
    const instance = workflow();
    const { row } = await applied();
    const scope = {
      operation: "CONFIRM" as const,
      sessionId: row.id,
      expectedRevision: 8,
      confirmationHash: H8,
      financialRequestId: KEY,
    };
    const first = admission(scope);
    const body = {
      expectedRevision: 8,
      confirmationHash: H8,
      financialRequestId: KEY,
      nonce: null,
    };
    const expected = await instance.confirm(
      first.auth,
      row.id,
      body,
      first.grant,
    );
    const second = admission(scope);
    expect(
      await instance.confirm(second.auth, row.id, body, second.grant),
    ).toEqual(expected);
    expect(
      (await service.getSession(second.auth, row.id)).confirmation,
    ).toEqual({
      financialRequestId: KEY,
      confirmedRevision: 8,
      bindingVersion: 0,
      confirmationHash: null,
    });
  });

  it("lost execute response repeats exactly the immutable receipt without prepare/apply or new audit", async () => {
    const instance = workflow();
    const { row, receipt } = await applied();
    const scope = {
      operation: "EXECUTE" as const,
      sessionId: row.id,
      financialRequestId: KEY,
    };
    const before = await setup.importSession.findUniqueOrThrow({
      where: { id: row.id },
    });
    for (let invocation = 0; invocation < 2; invocation++) {
      const action = admission(scope);
      expect(
        await instance.execute(
          action.auth,
          row.id,
          { financialRequestId: KEY },
          action.grant,
        ),
      ).toEqual(receipt);
    }
    expect(
      await setup.importSession.findUniqueOrThrow({ where: { id: row.id } }),
    ).toEqual(before);
    expect(port.prepareInTx).not.toHaveBeenCalled();
    expect(port.applyInTx).not.toHaveBeenCalled();
    expect(
      await setup.userActivityLog.count({
        where: { tenantId: world.tenantId },
      }),
    ).toBe(0);
  });

  it("APPLIED replay requires the same financialRequestId before OFF is considered", async () => {
    const instance = workflow();
    const { row } = await applied();
    const otherKey = "223e4567-e89b-42d3-a456-426614174000";
    const action = admission({
      operation: "EXECUTE",
      sessionId: row.id,
      financialRequestId: otherKey,
    });
    await expect(
      instance.execute(
        action.auth,
        row.id,
        { financialRequestId: otherKey },
        action.grant,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("CONTROL: cancel cannot change an APPLIED receipt", async () => {
    const { row, receipt } = await applied();
    const { auth } = admission({
      operation: "EXECUTE",
      sessionId: row.id,
      financialRequestId: KEY,
    });
    const grant = mintGrant(issuer, auth, {
      operation: "CANCEL_SESSION",
      sessionId: row.id,
      expectedRevision: 10,
    });
    await expect(
      service.cancel(auth, row.id, { expectedRevision: 10 }, grant),
    ).rejects.toMatchObject({ code: "ALREADY_APPLIED" });
    expect(await service.getResult(auth, row.id)).toEqual({
      state: "APPLIED",
      receipt,
    });
  });

  it("unknown CREATED snapshot cycle is corrupt even with proposal:null and a feasible aggregate", async () => {
    const { row } = await applied((receipt) => {
      receipt.snapshot.lines[0].schedule.occurrences[1].invoiceDueMonth = null;
    });
    const { auth } = admission({
      operation: "EXECUTE",
      sessionId: row.id,
      financialRequestId: KEY,
    });
    expect(row.proposalJson).toBeNull();
    await expect(service.getResult(auth, row.id)).rejects.toBeInstanceOf(
      ImportSessionCorruptStateError,
    );
  });

  it.each([false, true])(
    "historical APPLIED proposal is validated even without executable actions (unknown=%s)",
    async (unknown) => {
      const { row, receipt } = await applied();
      const schedule = structuredClone(receipt.snapshot.lines[0].schedule);
      if (unknown) schedule.occurrences[1].invoiceDueMonth = null;
      const draft: ImportSessionStoredDraftV1 = {
        version: 1,
        lines: [
          {
            id: "line-created",
            observationIds: ["historical-observation"],
            titulo: "Approved purchase",
            fornecedor: null,
            tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
            categoriaMaoDeObra: null,
            amountMeaning: "TOTAL_PURCHASE",
            amountCents: 100,
            installmentCount: 2,
            dataCompra: "2026-10-05",
            firstDueDate: "2026-11-10",
            targets: [],
            decision: { kind: "CREATE", acceptNaturalDuplicate: false },
          },
        ],
        selectedLineIds: ["line-created"],
        questions: [],
        scope: {
          observationIds: ["historical-observation"],
          pendingAttachmentIds: [],
        },
      };
      const proposal: ImportSessionProposalV1 = {
        version: 1,
        kind: "CREATE_CARD_PURCHASES",
        sessionId: row.id,
        revision: 8,
        proposalHash: H8,
        lines: [
          {
            kind: "CREATE",
            lineId: "line-created",
            titulo: "Approved purchase",
            fornecedor: null,
            tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
            categoriaMaoDeObra: null,
            dataCompra: "2026-10-05",
            totalCents: 100,
            schedule,
            targets: [],
          },
        ],
        noWriteRows: [],
        effects: {
          personalSourceCreates: 1,
          reformaTargetCreates: 0,
          expenseCreates: 1,
          cashFlowEntryCreates: 2,
          rateioAllocationCreates: 0,
          keptExistingCount: 0,
          deferredCount: 0,
          excludedCount: 0,
          ignoredCount: 0,
        },
        deferredObservationIds: [],
        deferredAttachmentIds: [],
        retainUntil: null,
        createdEconomicTotalCents: 100,
        bankCashDeltaCents: 0,
        invoiceDeltas: receipt.snapshot.invoiceDeltas,
      };
      await setup.importSession.update({
        where: { id: row.id },
        data: {
          draftJson: JSON.stringify(draft),
          proposalJson: JSON.stringify(proposal),
        },
      });
      const { auth } = admission({
        operation: "EXECUTE",
        sessionId: row.id,
        financialRequestId: KEY,
      });
      if (unknown) {
        await expect(service.getSession(auth, row.id)).rejects.toMatchObject({
          name: "ImportSessionCorruptStateError",
          field: "proposal",
        });
      } else {
        const view = await service.getSession(auth, row.id);
        const { proposalHash: _privateDigest, ...publicProposal } = proposal;
        expect(view.proposal).toEqual(publicProposal);
        expect(view.actions).toEqual(["READ_RESULT"]);
      }
    },
  );

  it("CONTROL: unknown KEEP snapshot cycles remain unchanged on recovery", async () => {
    const { row, receipt } = await applied((value) => {
      value.items[0].outcome = "KEPT_EXISTING";
      value.snapshot.lines[0].titulo = null;
      value.snapshot.lines[0].dataCompra = null;
      value.snapshot.lines[0].schedule.occurrences[1].invoiceDueMonth = null;
      value.snapshot.createdEconomicTotalCents = 0;
      value.snapshot.invoiceDeltas = [];
    });
    const { auth } = admission({
      operation: "EXECUTE",
      sessionId: row.id,
      financialRequestId: KEY,
    });
    expect(await service.getResult(auth, row.id)).toEqual({
      state: "APPLIED",
      receipt,
    });
  });
});

describe("W coordination with a controlled port: genuine handles and SQL rollback, NOT native financial proof", () => {
  const prefix = "w636-coordination";
  const setup = new PrismaClient();
  const prisma = new PrismaService();
  const clock = new MutableClock(NOW);
  const issuer = new ImportUiGrantIssuer(clock);
  const verifier = new RuntimeUiGrantVerifier();
  let world: ImportWorld;
  let enabled = true;
  let salt = "";
  let returned:
    | "valid"
    | "reverse"
    | "missing"
    | "extra"
    | "duplicate"
    | "outcome"
    | "source" = "valid";
  let finalZero = false;
  let claimZero = false;
  let prepareFailureCode: ImportSessionErrorCode | null = null;
  const events: string[] = [];
  const captured: Parameters<typeof assertLockedImportSession>[] = [];
  const port: CardPurchaseBatchPort = {
    prepareInTx: jest.fn(
      async (tx, auth, session): Promise<CardPurchasePreparation> => {
        assertLockedImportSession(tx, auth, session);
        captured.push([tx, auth, session]);
        events.push("prepare");
        if (prepareFailureCode !== null)
          throw new ImportSessionError(prepareFailureCode);
        const references = await tx.importSessionArtifact.findMany({
          where: { tenantId: session.tenantId, sessionId: session.id },
          include: { artifact: true },
        });
        const observations = await tx.importObservation.findMany({
          where: {
            tenantId: session.tenantId,
            id: { in: session.draft.scope.observationIds },
          },
        });
        const plan = buildImportPreparationPlan({
          session,
          draft: session.draft,
          observations,
          references: references.map(({ artifact, ...ref }) => ({
            ref,
            artifact,
          })),
          proposalBody: {
            version: 1,
            kind: "CREATE_CARD_PURCHASES",
            sessionId: session.id,
            revision: session.confirmedRevision ?? session.revision + 1,
            lines: session.draft.lines
              .filter((line) => session.draft.selectedLineIds.includes(line.id))
              .map((line) => {
                if (line.decision.kind === "CREATE") {
                  if (
                    line.amountCents === null ||
                    line.dataCompra === null ||
                    line.tipoDespesa === null ||
                    line.targets === null
                  )
                    throw new Error("Incomplete controlled CREATE fixture");
                  return {
                    kind: "CREATE" as const,
                    lineId: line.id,
                    titulo: line.titulo,
                    fornecedor: line.fornecedor,
                    tipoDespesa: line.tipoDespesa,
                    categoriaMaoDeObra: line.categoriaMaoDeObra,
                    dataCompra: line.dataCompra,
                    totalCents: line.amountCents,
                    schedule: {
                      version: 1 as const,
                      occurrences: [
                        {
                          index: 0,
                          parcela: "1/2",
                          valor: 50,
                          data: "2026-11-10",
                          invoiceDueMonth: "2026-11",
                        },
                        {
                          index: 1,
                          parcela: "2/2",
                          valor: 50,
                          data: "2026-12-10",
                          invoiceDueMonth: "2026-12",
                        },
                      ],
                    },
                    targets: line.targets.map((target) => ({
                      ...target,
                      schedule: {
                        version: 1 as const,
                        occurrences: [
                          {
                            index: 0,
                            parcela: "1/2",
                            valor: 50,
                            data: "2026-11-10",
                            invoiceDueMonth: "2026-11",
                          },
                          {
                            index: 1,
                            parcela: "2/2",
                            valor: 50,
                            data: "2026-12-10",
                            invoiceDueMonth: "2026-12",
                          },
                        ],
                      },
                    })),
                  };
                }
                if (line.decision.kind !== "KEEP_EXISTING")
                  throw new Error("Controlled fixture decision is unresolved");
                return {
                  kind: "KEEP_EXISTING" as const,
                  lineId: line.id,
                  sourceExpenseId: line.decision.expenseId,
                  totalCents: 100,
                  schedule: {
                    version: 1 as const,
                    occurrences: [
                      {
                        index: 0,
                        parcela: "1/2",
                        valor: 50,
                        data: "2026-11-10",
                        invoiceDueMonth: "2026-11",
                      },
                      {
                        index: 1,
                        parcela: "2/2",
                        valor: 50,
                        data: "2026-12-10",
                        invoiceDueMonth: "2026-12",
                      },
                    ],
                  },
                };
              }),
            noWriteRows: [],
            effects: {
              personalSourceCreates: session.draft.lines.filter(
                (line) => line.decision.kind === "CREATE",
              ).length,
              reformaTargetCreates: session.draft.lines.filter(
                (line) =>
                  line.decision.kind === "CREATE" &&
                  (line.targets?.length ?? 0) > 0,
              ).length,
              expenseCreates:
                session.draft.lines.filter(
                  (line) => line.decision.kind === "CREATE",
                ).length +
                session.draft.lines.filter(
                  (line) =>
                    line.decision.kind === "CREATE" &&
                    (line.targets?.length ?? 0) > 0,
                ).length,
              cashFlowEntryCreates:
                session.draft.lines.filter(
                  (line) => line.decision.kind === "CREATE",
                ).length * 2,
              rateioAllocationCreates: 0,
              keptExistingCount: session.draft.lines.filter(
                (line) => line.decision.kind === "KEEP_EXISTING",
              ).length,
              deferredCount: 0,
              excludedCount: 0,
              ignoredCount: 0,
            },
            createdEconomicTotalCents:
              session.draft.lines.filter(
                (line) => line.decision.kind === "CREATE",
              ).length * 100,
            bankCashDeltaCents: 0,
            invoiceDeltas: session.draft.lines.some(
              (line) => line.decision.kind === "CREATE",
            )
              ? [
                  { invoiceDueMonth: "2026-11", amountCents: 50 },
                  { invoiceDueMonth: "2026-12", amountCents: 50 },
                ]
              : [],
          },
        });
        const selected = session.draft.lines
          .filter((line) => session.draft.selectedLineIds.includes(line.id))
          .flatMap((line) =>
            line.observationIds.map((id) => {
              const observation = observations.find((item) => item.id === id);
              const artifact = references.find(
                (item) => item.artifactId === observation?.artifactId,
              )?.artifact;
              if (!observation || !artifact)
                throw new Error("Incomplete controlled fixture");
              return {
                id,
                lineId: line.id,
                canonicalIndex: line.id === "line-a" ? null : 0,
                artifactId: artifact.id,
                reference: observation.reference,
                documentSha256: artifact.documentSha256,
                claimVersion: observation.claimVersion,
              };
            }),
          );
        const batch = mintPreparedCardBatch(tx, auth, session, {
          proposal: plan.proposal,
          observations: selected,
          expandedCounts: plan.expandedCounts,
          preflightHash: createHash("sha256")
            .update(canonical({ selected, salt }))
            .digest("hex"),
        });
        return {
          kind: "READY",
          draft: structuredClone(session.draft),
          batch,
          search: {
            version: 1,
            revision: plan.proposal.revision,
            complete: true,
            candidates: plan.proposal.lines.flatMap((line) =>
              line.kind === "KEEP_EXISTING"
                ? [
                    {
                      lineId: line.lineId,
                      kind: "EXPENSE" as const,
                      id: line.sourceExpenseId,
                      reason: "INSTALLMENT_MATCH" as const,
                    },
                  ]
                : [],
            ),
            coverage: {
              recipe: "CARD_PURCHASE_V1",
              inputHash: batch.preflightHash,
              steps: plan.proposal.lines.flatMap((line) =>
                (
                  [
                    "DOCUMENT_IDENTITY",
                    "CROSS_ORIGIN",
                    "CARD_IDENTITY",
                  ] as const
                ).map((stage) => ({
                  lineId: line.lineId,
                  stage,
                  status: "EXHAUSTED" as const,
                  predicateHash: "a".repeat(64),
                  visitedRows: 0,
                  endCursor: null,
                })),
              ),
            },
          },
        };
      },
    ),
    applyInTx: jest.fn(async (tx, auth, batch) => {
      consumePreparedCardBatch(tx, auth, batch);
      events.push("apply");
      // A durable transaction probe, NOT a reference implementation of financial writes.
      await tx.userActivityLog.create({
        data: {
          tenantId: auth.tenantId,
          userId: auth.userId,
          action: "CONTROLLED_PORT_PROBE",
        },
      });
      const items: ImportSessionReceiptV1["items"] = batch.proposal.lines.map(
        (line) => {
          if (line.kind !== "KEEP_EXISTING")
            throw new Error("Controlled KEEP fixture only");
          return {
            lineId: line.lineId,
            outcome: "KEPT_EXISTING",
            sourceExpenseId: line.sourceExpenseId,
            targetExpenseIds: [],
            allocationIds: [],
            cashFlowEntryIds: [],
          };
        },
      );
      if (returned === "reverse") items.reverse();
      if (returned === "missing") items.pop();
      if (returned === "extra") items.push({ ...items[0], lineId: "extra" });
      if (returned === "duplicate") items[1] = structuredClone(items[0]);
      if (returned === "outcome") items[0].outcome = "CREATED";
      if (returned === "source")
        items[0].sourceExpenseId = items[1].sourceExpenseId;
      return items;
    }),
  };
  const workflow = () =>
    new (workflowConstructor())(
      prisma,
      clock,
      { writesEnabled: () => enabled, newImportFormats: () => [] },
      verifier,
      port,
      ...rawTestDependencies(
        new ImportVaultGate(prisma, clock, {}, process.cwd()),
        clock,
        { writesEnabled: () => enabled, newImportFormats: () => [] },
      ),
    );
  function admission(scope: UiImportFinancialActionScope, deadline = DEADLINE) {
    const request = {
      headers: { origin: "http://localhost:3000", [IMPORT_UI_HEADER]: "1" },
      user: {
        id: world.users.owner.id,
        tenantId: world.tenantId,
        authClaims: {
          sessionVersion: world.users.owner.sessionVersion,
          expiresAtEpochSeconds: deadline.getTime() / 1000,
        },
      },
    };
    const context = new ExecutionContextHost([request]);
    new ImportAuthGuard().canActivate(context);
    const key = Object.getOwnPropertySymbols(request).find(
      (symbol) => symbol.description === "IMPORT_AUTH_CONTEXT",
    );
    if (!key) throw new Error("Missing guard context");
    const auth: unknown = Reflect.get(request, key);
    assertMintedImportContext(auth);
    new ImportUiGuard(
      { allowed: () => ["http://localhost:3000"] },
      issuer,
    ).canActivate(context);
    return {
      auth,
      grant: issuer.issueFinancialAction(request, auth, scope),
    };
  }
  async function seed() {
    const lines: ImportSessionStoredDraftV1["lines"] = [];
    for (const key of ["a", "b"]) {
      const expense = await setup.expense.create({
        data: {
          tenantId: world.tenantId,
          projectId: world.projects.pessoal,
          tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
          titulo: `Fixture ${key}`,
          valor: 100,
          valorTotal: 100,
          formaPagamento: "PARCELADO",
          quantidadeParcela: 2,
          dataCompra: new Date("2026-10-05T12:00:00.000Z"),
        },
      });
      lines.push({
        id: `line-${key}`,
        observationIds: [`${prefix}-obs-${key}`],
        titulo: `Fixture ${key}`,
        fornecedor: null,
        tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
        categoriaMaoDeObra: null,
        amountMeaning: "TOTAL_PURCHASE",
        amountCents: 100,
        installmentCount: 2,
        dataCompra: "2026-10-05",
        firstDueDate: "2026-11-10",
        targets: [],
        decision: { kind: "KEEP_EXISTING", expenseId: expense.id },
      });
    }
    const draft: ImportSessionStoredDraftV1 = {
      version: 1,
      lines,
      selectedLineIds: ["line-a", "line-b"],
      questions: [],
      fieldProvenance: lines.map((line) => ({
        origin: "FILE",
        lineId: line.id,
        field: "decision",
        recordedRevision: 7,
      })),
      scope: {
        observationIds: ["a", "b", "deferred"].map(
          (key) => `${prefix}-obs-${key}`,
        ),
        pendingAttachmentIds: [],
      },
    };
    const row = await seedSession(setup, world, {
      revision: 7,
      draftJson: JSON.stringify(draft),
      lastUserEditAt: NOW,
      expiresAt: DEADLINE,
    });
    const artifact = await setup.importArtifact.create({
      data: {
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        documentSha256: "d".repeat(64),
        verifiedBytes: 10,
        detectedFormat: "PDF",
        state: "EXTRACTED",
        leaseSessionId: row.id,
        leaseSessionVersion: 0,
        leaseExpiresAt: DEADLINE,
        leaseTokenExpiresAt: DEADLINE,
      },
    });
    const ref = await setup.importSessionArtifact.create({
      data: {
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        sessionId: row.id,
        artifactId: artifact.id,
        position: 0,
        fileName: "fixture.pdf",
        declaredMime: "application/pdf",
        declaredBytes: 10,
        reservedBytes: 10,
        state: "ATTACHED",
        verifiedAt: NOW,
      },
    });
    for (const [ordinal, id] of draft.scope.observationIds.entries()) {
      await setup.importObservation.create({
        data: {
          id,
          tenantId: world.tenantId,
          ownerProjectId: world.projects.pessoal,
          artifactId: artifact.id,
          reference: `page:${ordinal + 1}`,
          evidenceJson: JSON.stringify({
            version: 1,
            reference: `page:${ordinal + 1}`,
            text: "Frozen fixture evidence",
            amountMeaning:
              ordinal === 1 ? "INSTALLMENT_CHARGE" : "TOTAL_PURCHASE",
            amountCents: ordinal === 1 ? 50 : 100,
            installmentCount: 2,
            installmentIndex: ordinal === 1 ? 1 : null,
            dataCompra: "2026-10-05",
            identity: {
              merchant: "Fixture",
              externalId: null,
              fitId: null,
              ordinal,
              fileContentHash: "a".repeat(32),
            },
          }),
        },
      });
    }
    return { row, draft, artifact, ref };
  }
  async function targetFirstLine(
    fixture: Awaited<ReturnType<typeof seed>>,
    roomId: string | null,
  ): Promise<void> {
    const line = fixture.draft.lines[0];
    line.decision = { kind: "CREATE", acceptNaturalDuplicate: false };
    line.targets = [
      {
        projectId: world.projects.casa,
        roomId,
        amountCents: 100,
      },
    ];
    fixture.draft.fieldProvenance?.push(
      {
        origin: "FILE",
        lineId: line.id,
        field: "targets",
        recordedRevision: 7,
      },
      {
        origin: "FILE",
        lineId: line.id,
        field: "tipoDespesa",
        recordedRevision: 7,
      },
    );
    await setup.importSession.update({
      where: { id: fixture.row.id },
      data: { draftJson: JSON.stringify(fixture.draft) },
    });
  }
  async function ready(
    change?: (fixture: Awaited<ReturnType<typeof seed>>) => Promise<void>,
  ) {
    const w = workflow();
    const fixture = await seed();
    await change?.(fixture);
    const action = admission({
      operation: "EXECUTE",
      sessionId: fixture.row.id,
      financialRequestId: KEY,
    });
    const view = await w.prepare(action.auth, fixture.row.id, {
      expectedRevision: 7,
    });
    if (!view.proposal) throw new Error("Expected READY proposal");
    const lot = await w.currentLot(action.auth, fixture.row.id);
    return { ...fixture, w, view, hash: lot.confirmationHash };
  }
  async function confirmReady(
    fixture: Awaited<ReturnType<typeof ready>>,
    beforeConfirm?: () => Promise<void>,
  ): Promise<ImportSessionConfirmResponseV1> {
    const { w, row, hash } = fixture;
    const challengeAction = admission({
      operation: "CHALLENGE",
      sessionId: row.id,
      expectedRevision: 8,
      confirmationHash: hash,
    });
    const challenge = await w.challenge(
      challengeAction.auth,
      row.id,
      { expectedRevision: 8, confirmationHash: hash },
      challengeAction.grant,
    );
    await beforeConfirm?.();
    const confirmAction = admission({
      operation: "CONFIRM",
      sessionId: row.id,
      expectedRevision: 8,
      confirmationHash: hash,
      financialRequestId: KEY,
    });
    return w.confirm(
      confirmAction.auth,
      row.id,
      {
        expectedRevision: 8,
        confirmationHash: hash,
        financialRequestId: KEY,
        nonce: challenge.nonce,
      },
      confirmAction.grant,
    );
  }
  async function confirmed(
    change?: (fixture: Awaited<ReturnType<typeof seed>>) => Promise<void>,
  ) {
    const fixture = await ready(change);
    await confirmReady(fixture);
    return fixture;
  }
  const execute = (w: Workflow, id: string, deadline = DEADLINE) => {
    const action = admission(
      { operation: "EXECUTE", sessionId: id, financialRequestId: KEY },
      deadline,
    );
    return w.execute(
      action.auth,
      id,
      { financialRequestId: KEY },
      action.grant,
    );
  };
  const saved = (id: string) =>
    setup.importSession.findUniqueOrThrow({ where: { id } });
  beforeAll(async () => {
    await setup.$connect();
    await prisma.onModuleInit();
    prisma.$use(async (params, next) => {
      if (
        params.model === "ImportObservation" &&
        params.action === "updateMany"
      ) {
        events.push("claim");
        if (claimZero && params.args.where.id === `${prefix}-obs-b`)
          params.args.where.id = "missing-claim";
      }
      if (
        params.model === "ImportSession" &&
        params.action === "updateMany" &&
        params.args.data.state === "APPLIED"
      ) {
        events.push("final");
        if (finalZero) params.args.where.revision = -1;
      }
      return next(params);
    });
  });
  beforeEach(async () => {
    world = await seedImportWorld(setup, prefix);
    await setup.project.update({
      where: { id: world.projects.casa },
      data: { type: "REFORMA" },
    });
    clock.current = NOW;
    salt = "";
    returned = "valid";
    finalZero = claimZero = false;
    prepareFailureCode = null;
    enabled = true;
    events.length = 0;
    captured.length = 0;
    jest.clearAllMocks();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await setup.room.deleteMany({
      where: { project: { tenantId: world.tenantId } },
    });
  });
  afterAll(async () => {
    await cleanupImportWorld(setup, prefix);
    await setup.$disconnect();
    await prisma.onModuleDestroy();
  });

  it("CONTROL: paired guards admit a real financial grant and fixture mints a genuine complete batch", async () => {
    const { row, draft } = await seed();
    const scope = {
      operation: "EXECUTE" as const,
      sessionId: row.id,
      financialRequestId: KEY,
    };
    const action = admission(scope);
    expect(() =>
      verifier.verifyFinancialAction(action.grant, action.auth, scope, NOW),
    ).not.toThrow();
    await runImportSessionWrite(prisma, clock, action.auth, async (tx) => {
      const locked = mintLockedImportSession(tx, action.auth, row, draft);
      try {
        const result = await port.prepareInTx(tx, action.auth, locked);
        expect(result.kind).toBe("READY");
        if (result.kind !== "READY") throw new Error("Expected READY fixture");
        expect(
          result.batch.observations.map((o) => [o.lineId, o.canonicalIndex]),
        ).toEqual([
          ["line-a", null],
          ["line-b", 0],
        ]);
      } finally {
        releaseLockedImportSession(locked);
      }
    });
  });
  it("7 -> READY8/H8 -> CONFIRMED9 freezes approval, hashes a 32-byte nonce and creates no finances", async () => {
    const { row, hash, view } = await confirmed();
    expect(view).toMatchObject({
      state: "READY",
      revision: 8,
      searchComplete: true,
      expiresAt: DEADLINE.toISOString(),
    });
    expect(await saved(row.id)).toMatchObject({
      state: "CONFIRMED",
      revision: 9,
      confirmedRevision: 8,
      proposalHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      challengeJson: expect.any(String),
      lastUserEditAt: NOW,
      expiresAt: DEADLINE,
    });
    const binding = JSON.parse((await saved(row.id)).challengeJson!);
    expect(binding).toEqual({
      bindingVersion: 1,
      kind: "CONFIRMED_BINDING",
      revision: 8,
      confirmationHash: hash,
      fullPlanDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      sessionVersion: 0,
    });
    expect(binding).not.toHaveProperty("nonceHash");
    expect(binding).not.toHaveProperty("expiresAt");
    expect(port.applyInTx).not.toHaveBeenCalled();
    expect(
      await setup.expense.count({ where: { tenantId: world.tenantId } }),
    ).toBe(2);
  });
  it("replays an exact v1 confirmation without a nonce and keeps the private digest hidden", async () => {
    const { w, row, hash, view } = await confirmed();
    const action = admission({
      operation: "CONFIRM",
      sessionId: row.id,
      expectedRevision: 8,
      confirmationHash: hash,
      financialRequestId: KEY,
    });
    await expect(
      w.confirm(
        action.auth,
        row.id,
        {
          expectedRevision: 8,
          confirmationHash: hash,
          financialRequestId: KEY,
          nonce: null,
        },
        action.grant,
      ),
    ).resolves.toEqual({
      sessionId: row.id,
      financialRequestId: KEY,
      state: "CONFIRMED",
    });
    expect(JSON.stringify(view)).not.toContain("proposalHash");
    expect(JSON.stringify(view)).not.toContain("fullPlanDigest");
  });
  it("rejects challenge private-digest drift as stale with zero financial writes", async () => {
    const fixture = await ready();
    const { w, row, hash } = fixture;
    const challengeAction = admission({
      operation: "CHALLENGE",
      sessionId: row.id,
      expectedRevision: 8,
      confirmationHash: hash,
    });
    const challenge = await w.challenge(
      challengeAction.auth,
      row.id,
      { expectedRevision: 8, confirmationHash: hash },
      challengeAction.grant,
    );
    const persisted = await saved(row.id);
    const split = JSON.parse(persisted.challengeJson!);
    split.fullPlanDigest = "f".repeat(64);
    await setup.importSession.update({
      where: { id: row.id },
      data: { challengeJson: JSON.stringify(split) },
    });
    const confirmAction = admission({
      operation: "CONFIRM",
      sessionId: row.id,
      expectedRevision: 8,
      confirmationHash: hash,
      financialRequestId: KEY,
    });
    await expect(
      w.confirm(
        confirmAction.auth,
        row.id,
        {
          expectedRevision: 8,
          confirmationHash: hash,
          financialRequestId: KEY,
          nonce: challenge.nonce,
        },
        confirmAction.grant,
      ),
    ).rejects.toMatchObject({ code: "STALE_PREVIEW" });
    expect(port.applyInTx).not.toHaveBeenCalled();
    expect(await saved(row.id)).toMatchObject({
      state: "READY",
      financialRequestId: null,
    });
  });
  it.each([
    {
      name: "revoked target grant",
      code: "NOT_FOUND",
      revoke: async (_roomId: string) => {
        await setup.user.update({
          where: { id: world.users.owner.id },
          data: {
            role: "USER",
            allowedModules: JSON.stringify(["creditCards", "expenses"]),
            allowedProjectTypes: JSON.stringify(["PESSOAL", "REFORMA"]),
            allowedProjects: JSON.stringify([world.projects.pessoal]),
          },
        });
      },
    },
    {
      name: "soft-deleted target project",
      code: "NOT_FOUND",
      revoke: async (_roomId: string) => {
        await setup.project.update({
          where: { id: world.projects.casa },
          data: { deletedAt: NOW },
        });
      },
    },
    {
      name: "soft-deleted target room",
      code: "NOT_FOUND",
      revoke: async (roomId: string) => {
        await setup.room.update({
          where: { id: roomId },
          data: { deletedAt: NOW },
        });
      },
    },
  ])(
    "reauthorizes proposal participants at confirm after $name",
    async ({ code, revoke }) => {
      const room = await setup.room.create({
        data: { projectId: world.projects.casa, name: "Cozinha" },
      });
      const fixture = await ready((seeded) => targetFirstLine(seeded, room.id));
      const expenseCount = await setup.expense.count({
        where: { tenantId: world.tenantId },
      });
      await expect(
        confirmReady(fixture, () => revoke(room.id)),
      ).rejects.toMatchObject({ code });
      expect(await saved(fixture.row.id)).toMatchObject({
        state: "READY",
        revision: 8,
        confirmedAt: null,
        financialRequestId: null,
      });
      expect(
        await setup.expense.count({ where: { tenantId: world.tenantId } }),
      ).toBe(expenseCount);
      expect(port.applyInTx).not.toHaveBeenCalled();
    },
  );
  it("fails a legacy READY proposal closed when its approval provenance is no longer canonical", async () => {
    const fixture = await ready();
    const expenseCount = await setup.expense.count({
      where: { tenantId: world.tenantId },
    });
    await expect(
      confirmReady(fixture, async () => {
        const stale = structuredClone(fixture.draft);
        delete stale.fieldProvenance;
        await setup.importSession.update({
          where: { id: fixture.row.id },
          data: { draftJson: JSON.stringify(stale) },
        });
      }),
    ).rejects.toMatchObject({ code: "STALE_PREVIEW" });
    expect(await saved(fixture.row.id)).toMatchObject({
      state: "REVIEW_REQUIRED",
      revision: 9,
      challengeJson: null,
      financialRequestId: null,
    });
    expect(
      await setup.expense.count({ where: { tenantId: world.tenantId } }),
    ).toBe(expenseCount);
    expect(port.applyInTx).not.toHaveBeenCalled();
  });
  it("permuted valid receipt binds by lineId, writes each claim once, atomically transfers full deferred scope and replays OFF", async () => {
    let pendingLine!: ImportSessionStoredDraftV1["lines"][number];
    const { w, row, draft, ref, artifact, hash } = await confirmed(
      async (fixture) => {
        pendingLine = {
          ...structuredClone(fixture.draft.lines[0]),
          id: "continuation-line",
          observationIds: [`${prefix}-obs-deferred`],
          targets: null,
          decision: { kind: "UNRESOLVED" },
        };
        fixture.draft.lines.push(pendingLine);
        fixture.draft.questions.push({
          id: "continuation-question",
          lineIds: [pendingLine.id],
          field: "decision",
          text: "Criar esta compra pendente?",
        });
        fixture.draft.fieldProvenance?.push({
          origin: "FILE",
          lineId: pendingLine.id,
          field: "amountCents",
          recordedRevision: 7,
        });
        await setup.importSession.update({
          where: { id: fixture.row.id },
          data: { draftJson: JSON.stringify(fixture.draft) },
        });
      },
    );
    const confirmedRow = await saved(row.id);
    const expensesBefore = await setup.expense.findMany({
      where: { tenantId: world.tenantId },
      orderBy: { id: "asc" },
    });
    returned = "reverse";
    events.length = 0;
    const receipt = await execute(w, row.id);
    expect(receipt).toMatchObject({
      confirmedRevision: 8,
      bindingVersion: 1,
      confirmationHash: hash,
      snapshot: { createdEconomicTotalCents: 0, bankCashDeltaCents: 0 },
    });
    expect(JSON.stringify(receipt)).not.toContain("proposalHash");
    expect(JSON.stringify(receipt)).not.toContain("fullPlanDigest");
    expect(receipt.items.map((item) => item.lineId)).toEqual([
      "line-a",
      "line-b",
    ]);
    expect(events).toEqual(["prepare", "apply", "claim", "claim", "final"]);
    for (const [index, line] of draft.lines
      .filter((candidate) => draft.selectedLineIds.includes(candidate.id))
      .entries()) {
      if (line.decision.kind !== "KEEP_EXISTING")
        throw new Error("Expected KEEP");
      expect(
        await setup.importObservation.findUniqueOrThrow({
          where: { id: line.observationIds[0] },
        }),
      ).toMatchObject({
        claimVersion: 1,
        canonicalProjectId: world.projects.pessoal,
        canonicalExpenseId: line.decision.expenseId,
        canonicalReceiptId: null,
        canonicalIndex: index === 0 ? null : 0,
        claimSessionId: row.id,
        claimReceiptJson: JSON.stringify({
          kind: "SESSION",
          sessionId: row.id,
          financialRequestId: KEY,
        }),
      });
    }
    expect(receipt.continuationSessionId).not.toBeNull();
    const child = await saved(receipt.continuationSessionId!);
    expect(child).toMatchObject({
      tenantId: world.tenantId,
      ownerUserId: world.users.owner.id,
      ownerProjectId: world.projects.pessoal,
      state: "DRAFT",
      revision: 1,
      lastUserEditAt: NOW,
      expiresAt: DEADLINE,
      financialRequestId: null,
      proposalJson: null,
      searchJson: null,
      challengeJson: null,
    });
    expect(JSON.parse(child.draftJson)).toEqual({
      version: 1,
      lines: [pendingLine],
      selectedLineIds: [pendingLine.id],
      questions: [
        {
          id: "continuation-question",
          lineIds: [pendingLine.id],
          field: "decision",
          text: "Criar esta compra pendente?",
        },
      ],
      fieldProvenance: [
        {
          origin: "FILE",
          lineId: pendingLine.id,
          field: "amountCents",
          recordedRevision: 7,
        },
      ],
      scope: {
        observationIds: [`${prefix}-obs-deferred`],
        pendingAttachmentIds: [],
      },
    });
    expect(
      await setup.importSessionArtifact.findUniqueOrThrow({
        where: { id: ref.id },
      }),
    ).toMatchObject({
      sessionId: child.id,
      reservedBytes: 10,
      uploadGeneration: 1,
    });
    expect(
      await setup.importArtifact.findUniqueOrThrow({
        where: { id: artifact.id },
      }),
    ).toMatchObject({ leaseSessionId: null, parseGeneration: 1 });
    const appliedRow = await saved(row.id);
    expect(appliedRow).toMatchObject({
      state: "APPLIED",
      revision: 10,
      closedAt: NOW,
      draftJson: EMPTY_DRAFT_JSON,
      searchJson: null,
      proposalJson: null,
      preflightHash: null,
      financialRequestId: confirmedRow.financialRequestId,
      confirmedRevision: 8,
      confirmedSessionVersion: confirmedRow.confirmedSessionVersion,
      confirmedAt: confirmedRow.confirmedAt,
      proposalHash: confirmedRow.proposalHash,
      receiptJson: expect.any(String),
    });
    expect(
      await setup.expense.findMany({
        where: { tenantId: world.tenantId },
        orderBy: { id: "asc" },
      }),
    ).toEqual(expensesBefore);
    const motherBeforeEdit = await saved(row.id);
    const deferredBeforeEdit = await setup.importObservation.findUniqueOrThrow({
      where: { id: `${prefix}-obs-deferred` },
    });
    const childLine: ImportSessionStoredDraftV1["lines"][number] = {
      ...pendingLine,
      titulo: "Compra pendente revisada",
    };
    clock.current = new Date(NOW.getTime() + 86400000);
    const childAction = admission({
      operation: "EXECUTE",
      sessionId: child.id,
      financialRequestId: KEY,
    });
    const childView = await w.edit(childAction.auth, child.id, {
      expectedRevision: 1,
      questionId: null,
      replaceLines: [],
      selectedLineIds: [pendingLine.id],
    });
    expect(childView).toMatchObject({
      state: "DRAFT",
      revision: 1,
      lines: [pendingLine],
      selectedLineIds: [pendingLine.id],
    });
    expect(childView.questions[0]).toMatchObject({
      id: "continuation-question",
      lineIds: [pendingLine.id],
      field: "decision",
    });
    expect(
      childView.questions[0]?.lineIds.some((lineId) =>
        childView.selectedLineIds.includes(lineId),
      ),
    ).toBe(true);
    expect(
      await w.edit(childAction.auth, child.id, {
        expectedRevision: 1,
        questionId: null,
        replaceLines: [childLine],
        selectedLineIds: [childLine.id],
      }),
    ).toMatchObject({
      state: "DRAFT",
      revision: 2,
      lines: [childLine],
      selectedLineIds: [childLine.id],
    });
    const editedChild = await saved(child.id);
    expect(JSON.parse(editedChild.draftJson)).toEqual({
      ...JSON.parse(child.draftJson),
      lines: [childLine],
      selectedLineIds: [childLine.id],
      fieldProvenance: [
        {
          origin: "FILE",
          lineId: childLine.id,
          field: "amountCents",
          recordedRevision: 7,
        },
      ],
    });
    expect(editedChild).toMatchObject({
      lastUserEditAt: clock.current,
      expiresAt: new Date(clock.current.getTime() + 604800000),
    });
    expect(await saved(row.id)).toEqual(motherBeforeEdit);
    expect(
      await setup.importObservation.findUniqueOrThrow({
        where: { id: deferredBeforeEdit.id },
      }),
    ).toEqual(deferredBeforeEdit);
    expect(
      await setup.importSessionArtifact.findUniqueOrThrow({
        where: { id: ref.id },
      }),
    ).toMatchObject({ sessionId: child.id, state: "ATTACHED" });
    clock.current = new Date(clock.current.getTime() + 1000);
    await w.edit(childAction.auth, child.id, {
      expectedRevision: 2,
      questionId: null,
      replaceLines: [childLine],
      selectedLineIds: [childLine.id],
    });
    expect(await saved(child.id)).toEqual(editedChild);
    enabled = false;
    expect(await execute(w, row.id)).toEqual(receipt);
    expect(await saved(row.id)).toEqual(appliedRow);
    expect(port.applyInTx).toHaveBeenCalledTimes(1);
    for (const [tx, auth, locked] of captured)
      expect(() => assertLockedImportSession(tx, auth, locked)).toThrow(
        "Invalid import execution handle",
      );
  });
  it("executes a legacy CONFIRMED row as binding version zero", async () => {
    const { w, row } = await confirmed();
    await setup.importSession.update({
      where: { id: row.id },
      data: { challengeJson: null },
    });
    const receipt = await execute(w, row.id);
    expect(receipt).toMatchObject({
      bindingVersion: 0,
      confirmationHash: null,
      confirmedRevision: 8,
    });
    expect(JSON.stringify(receipt)).not.toContain("proposalHash");
    expect(JSON.stringify(receipt)).not.toContain("fullPlanDigest");
    const stored = JSON.parse((await saved(row.id)).receiptJson!);
    expect(stored).toMatchObject({
      proposalHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(stored).not.toHaveProperty("fullPlanDigest");
  });
  it.each(["missing", "extra", "duplicate", "outcome", "source"] as const)(
    "rolls back the port probe on %s receipt coverage; never commits REVIEW_REQUIRED after effects",
    async (mode) => {
      const { w, row, ref } = await confirmed();
      const before = await saved(row.id);
      returned = mode;
      await expect(execute(w, row.id)).rejects.toBeDefined();
      expect(port.applyInTx).toHaveBeenCalledTimes(1);
      expect(await saved(row.id)).toEqual(before);
      expect(
        await setup.userActivityLog.count({
          where: { tenantId: world.tenantId },
        }),
      ).toBe(0);
      expect(
        await setup.importObservation.count({
          where: { tenantId: world.tenantId, claimVersion: { not: 0 } },
        }),
      ).toBe(0);
      expect(
        await setup.importSessionArtifact.findUniqueOrThrow({
          where: { id: ref.id },
        }),
      ).toMatchObject({ sessionId: row.id });
    },
  );
  it.each(["final"] as const)(
    "real SQLite %s CAS count=0 rolls back probe, claims, continuation, transfer, cleanup and audit",
    async (boundary) => {
      const { w, row, ref, artifact } = await confirmed();
      const before = await saved(row.id);
      finalZero = boundary === "final";
      claimZero = false;
      await expect(execute(w, row.id)).rejects.toMatchObject({
        code: "REVISION_CONFLICT",
      });
      expect(events).toContain("apply");
      expect(await saved(row.id)).toEqual(before);
      expect(
        await setup.importSession.count({
          where: { tenantId: world.tenantId },
        }),
      ).toBe(1);
      expect(
        await setup.importObservation.count({
          where: { tenantId: world.tenantId, claimVersion: { not: 0 } },
        }),
      ).toBe(0);
      expect(
        await setup.importSessionArtifact.findUniqueOrThrow({
          where: { id: ref.id },
        }),
      ).toMatchObject({ sessionId: row.id, uploadGeneration: 0 });
      expect(
        await setup.importArtifact.findUniqueOrThrow({
          where: { id: artifact.id },
        }),
      ).toMatchObject({ leaseSessionId: row.id, parseGeneration: 0 });
      expect(
        await setup.userActivityLog.count({
          where: { tenantId: world.tenantId },
        }),
      ).toBe(0);
      finalZero = claimZero = false;
      expect(await execute(w, row.id)).toMatchObject({ sessionId: row.id });
    },
  );
  it("private preflight drift commits only REVIEW_REQUIRED and preserves the approved tuple/proposal", async () => {
    const { w, row } = await confirmed();
    const before = await saved(row.id);
    salt = "changed";
    await expect(execute(w, row.id)).rejects.toMatchObject({
      code: "STALE_PREVIEW",
    });
    expect(await saved(row.id)).toMatchObject({
      state: "REVIEW_REQUIRED",
      confirmedRevision: 8,
      proposalJson: before.proposalJson,
      proposalHash: before.proposalHash,
      financialRequestId: KEY,
    });
    expect(port.applyInTx).not.toHaveBeenCalled();
  });
  it.each([
    ImportSessionErrorCode.INVALID_INPUT,
    ImportSessionErrorCode.NOT_FOUND,
  ])(
    "confirmed revalidation converts %s into review without financial writes",
    async (code) => {
      const { w, row } = await confirmed();
      const before = await saved(row.id);
      const financialBefore = {
        expenses: await setup.expense.count({
          where: { tenantId: world.tenantId },
        }),
        cashFlowEntries: await setup.cashFlowEntry.count({
          where: { tenantId: world.tenantId },
        }),
      };
      prepareFailureCode = code;

      await expect(execute(w, row.id)).rejects.toMatchObject({
        code: "STALE_PREVIEW",
      });

      expect(await saved(row.id)).toMatchObject({
        state: "REVIEW_REQUIRED",
        revision: 10,
        challengeJson: null,
        confirmedRevision: before.confirmedRevision,
        proposalHash: before.proposalHash,
        financialRequestId: before.financialRequestId,
      });
      expect(port.applyInTx).not.toHaveBeenCalled();
      expect(
        await setup.expense.count({ where: { tenantId: world.tenantId } }),
      ).toBe(financialBefore.expenses);
      expect(
        await setup.cashFlowEntry.count({
          where: { tenantId: world.tenantId },
        }),
      ).toBe(financialBefore.cashFlowEntries);
    },
  );
  it("execution at the retention boundary commits EXPIRED but does not apply", async () => {
    const { w, row, hash } = await confirmed();
    const confirmedRow = await saved(row.id);
    expect(confirmedRow).toMatchObject({
      state: "CONFIRMED",
      searchJson: expect.any(String),
      proposalJson: expect.any(String),
      preflightHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      proposalHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      receiptJson: null,
    });
    expect(confirmedRow.draftJson).not.toBe(EMPTY_DRAFT_JSON);
    clock.current = DEADLINE;
    await expect(
      execute(w, row.id, new Date(DEADLINE.getTime() + 86400000)),
    ).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    expect(await saved(row.id)).toMatchObject({
      state: "EXPIRED",
      draftJson: EMPTY_DRAFT_JSON,
      searchJson: null,
      proposalJson: null,
      preflightHash: null,
      financialRequestId: confirmedRow.financialRequestId,
      confirmedRevision: confirmedRow.confirmedRevision,
      confirmedSessionVersion: confirmedRow.confirmedSessionVersion,
      confirmedAt: confirmedRow.confirmedAt,
      proposalHash: confirmedRow.proposalHash,
      receiptJson: confirmedRow.receiptJson,
    });
    expect(port.applyInTx).not.toHaveBeenCalled();
  });
  it("a nonce expires exactly at 300 seconds without consuming confirmation", async () => {
    const { w, row, hash } = await ready();
    const first = admission({
      operation: "CHALLENGE",
      sessionId: row.id,
      expectedRevision: 8,
      confirmationHash: hash,
    });
    const challenge = await w.challenge(
      first.auth,
      row.id,
      { expectedRevision: 8, confirmationHash: hash },
      first.grant,
    );
    expect(Buffer.from(challenge.nonce, "base64url")).toHaveLength(32);
    const persisted = await saved(row.id);
    expect(persisted.challengeJson).not.toContain(challenge.nonce);
    expect(JSON.parse(persisted.challengeJson!)).toEqual({
      bindingVersion: 1,
      kind: "PENDING_CONFIRMATION",
      nonceHash: createHash("sha256").update(challenge.nonce).digest("hex"),
      revision: 8,
      confirmationHash: hash,
      fullPlanDigest: persisted.proposalHash,
      sessionVersion: 0,
      expiresAt: new Date(NOW.getTime() + 300000).toISOString(),
    });
    clock.current = new Date(NOW.getTime() + 300000);
    const fresh = admission({
      operation: "CONFIRM",
      sessionId: row.id,
      expectedRevision: 8,
      confirmationHash: hash,
      financialRequestId: KEY,
    });
    await expect(
      w.confirm(
        fresh.auth,
        row.id,
        {
          expectedRevision: 8,
          confirmationHash: hash,
          financialRequestId: KEY,
          nonce: challenge.nonce,
        },
        fresh.grant,
      ),
    ).rejects.toMatchObject({ code: "UI_ACTION_REQUIRED" });
    expect(await saved(row.id)).toMatchObject({
      state: "READY",
      revision: 8,
      financialRequestId: null,
    });
  });
  it("treats a legacy challenge as UI action required and replaces it safely", async () => {
    const { w, row, hash } = await ready();
    const legacyNonce = "legacy-nonce";
    await setup.importSession.update({
      where: { id: row.id },
      data: {
        challengeJson: JSON.stringify({
          nonceHash: createHash("sha256").update(legacyNonce).digest("hex"),
          revision: 8,
          proposalHash: (await saved(row.id)).proposalHash,
          sessionVersion: 0,
          expiresAt: new Date(NOW.getTime() + 300000).toISOString(),
        }),
      },
    });
    const confirmAction = admission({
      operation: "CONFIRM",
      sessionId: row.id,
      expectedRevision: 8,
      confirmationHash: hash,
      financialRequestId: KEY,
    });
    await expect(
      w.confirm(
        confirmAction.auth,
        row.id,
        {
          expectedRevision: 8,
          confirmationHash: hash,
          financialRequestId: KEY,
          nonce: legacyNonce,
        },
        confirmAction.grant,
      ),
    ).rejects.toMatchObject({ code: "UI_ACTION_REQUIRED" });
    const challengeAction = admission({
      operation: "CHALLENGE",
      sessionId: row.id,
      expectedRevision: 8,
      confirmationHash: hash,
    });
    await expect(
      w.challenge(
        challengeAction.auth,
        row.id,
        { expectedRevision: 8, confirmationHash: hash },
        challengeAction.grant,
      ),
    ).resolves.toMatchObject({ nonce: expect.any(String) });
    expect(JSON.parse((await saved(row.id)).challengeJson!)).toMatchObject({
      bindingVersion: 1,
      kind: "PENDING_CONFIRMATION",
      confirmationHash: hash,
    });
  });
  it("first confirmation rejects null nonce", async () => {
    const { w, row, hash } = await ready();
    const first = admission({
      operation: "CONFIRM",
      sessionId: row.id,
      expectedRevision: 8,
      confirmationHash: hash,
      financialRequestId: KEY,
    });
    await expect(
      w.confirm(
        first.auth,
        row.id,
        {
          expectedRevision: 8,
          confirmationHash: hash,
          financialRequestId: KEY,
          nonce: null,
        },
        first.grant,
      ),
    ).rejects.toMatchObject({ code: "UI_ACTION_REQUIRED" });
    expect(port.applyInTx).not.toHaveBeenCalled();
  });
  it("a real edit replaces only indicated lines, invalidates preparation and renews seven days once", async () => {
    const { w, row, draft } = await ready();
    const action = admission({
      operation: "EXECUTE",
      sessionId: row.id,
      financialRequestId: KEY,
    });
    clock.current = new Date(NOW.getTime() + 86400000);
    const updated = { ...draft.lines[0], titulo: "Human correction" };
    const view = await w.edit(action.auth, row.id, {
      expectedRevision: 8,
      questionId: null,
      replaceLines: [updated],
      selectedLineIds: draft.selectedLineIds,
    });
    expect(view).toMatchObject({
      state: "DRAFT",
      revision: 9,
      proposal: null,
      searchComplete: false,
    });
    expect(view.lines).toEqual([updated, draft.lines[1]]);
    expect(await saved(row.id)).toMatchObject({
      lastUserEditAt: clock.current,
      expiresAt: new Date(clock.current.getTime() + 604800000),
      proposalHash: null,
      preflightHash: null,
      searchJson: null,
      challengeJson: null,
    });
    const before = await saved(row.id);
    clock.current = new Date(clock.current.getTime() + 1000);
    await w.edit(action.auth, row.id, {
      expectedRevision: 9,
      questionId: null,
      replaceLines: [],
      selectedLineIds: draft.selectedLineIds,
    });
    expect(await saved(row.id)).toEqual(before);
  });
  it("G1 appends new lines in request order while replacing only indicated existing lines", async () => {
    const { w, row, draft } = await ready();
    const firstNew: ImportSessionStoredDraftV1["lines"][number] = {
      ...draft.lines[0],
      id: "new-first",
      observationIds: [`${prefix}-obs-deferred`],
      decision: { kind: "UNRESOLVED" },
      targets: null,
    };
    const secondNew = { ...draft.lines[1], id: "new-second" };
    const replaced = { ...draft.lines[0], titulo: "Human correction" };
    const selectedLineIds = [...draft.selectedLineIds, firstNew.id];
    const action = admission({
      operation: "EXECUTE",
      sessionId: row.id,
      financialRequestId: KEY,
    });
    clock.current = new Date(NOW.getTime() + 86400000);
    const before = await saved(row.id);
    const observationsBefore = await setup.importObservation.findMany({
      where: { tenantId: world.tenantId },
      orderBy: { id: "asc" },
    });
    const view = await w.edit(action.auth, row.id, {
      expectedRevision: 8,
      questionId: null,
      replaceLines: [firstNew, replaced, secondNew],
      selectedLineIds,
    });
    const lines = [replaced, draft.lines[1], firstNew, secondNew];
    expect(view).toMatchObject({
      state: "DRAFT",
      revision: 9,
      lines,
      selectedLineIds,
      proposal: null,
      searchComplete: false,
    });
    const after = await saved(row.id);
    expect(JSON.parse(after.draftJson)).toEqual({
      ...draft,
      lines,
      selectedLineIds,
      fieldProvenance: [
        ...(draft.fieldProvenance ?? []),
        ...[firstNew, secondNew].flatMap((line) =>
          [
            "amountMeaning",
            "amountCents",
            "installmentCount",
            "dataCompra",
            "firstDueDate",
          ].map((field) => ({
            origin: "USER",
            lineId: line.id,
            field,
            recordedRevision: 9,
          })),
        ),
      ],
    });
    expect(after).toMatchObject({
      prepareGeneration: before.prepareGeneration + 1,
      lastUserEditAt: clock.current,
      expiresAt: new Date(clock.current.getTime() + 604800000),
      searchJson: null,
      proposalJson: null,
      proposalHash: null,
      preflightHash: null,
      challengeJson: null,
      prepareLeaseJson: null,
    });
    expect(
      await setup.importObservation.findMany({
        where: { tenantId: world.tenantId },
        orderBy: { id: "asc" },
      }),
    ).toEqual(observationsBefore);
    expect(port.applyInTx).not.toHaveBeenCalled();
  });
  it.each([
    "outside-scope",
    "released-ref",
    "other-tenant",
    "other-anchor",
    "duplicate-selected-observation",
    "rewrite-existing-observation",
  ] as const)(
    "G1 rejects %s atomically when appending a line",
    async (mode) => {
      const w = workflow();
      const { row, draft, ref } = await seed();
      const deferredId = `${prefix}-obs-deferred`;
      if (mode === "outside-scope") {
        draft.scope.observationIds = draft.scope.observationIds.filter(
          (id) => id !== deferredId,
        );
        await setup.importSession.update({
          where: { id: row.id },
          data: { draftJson: JSON.stringify(draft) },
        });
      } else if (mode === "released-ref") {
        await setup.importSessionArtifact.update({
          where: { id: ref.id },
          data: { state: "RELEASED" },
        });
      } else if (mode === "other-tenant" || mode === "other-anchor") {
        const tenantId =
          mode === "other-tenant" ? world.otherTenantId : world.tenantId;
        const ownerProjectId =
          mode === "other-tenant"
            ? world.projects.foreign
            : world.projects.casa;
        const otherArtifact = await setup.importArtifact.create({
          data: {
            tenantId,
            ownerProjectId,
            documentSha256: "e".repeat(64),
            verifiedBytes: 10,
            detectedFormat: "PDF",
            state: "EXTRACTED",
          },
        });
        await setup.importObservation.update({
          where: { id: deferredId },
          data: { tenantId, ownerProjectId, artifactId: otherArtifact.id },
        });
      }
      const newLine: ImportSessionStoredDraftV1["lines"][number] = {
        ...draft.lines[0],
        id: "new-line",
        observationIds:
          mode === "duplicate-selected-observation"
            ? draft.lines[0].observationIds
            : [deferredId],
        decision: { kind: "UNRESOLVED" },
        targets: null,
      };
      const replacement = {
        ...draft.lines[0],
        titulo: "Must not be partially saved",
        ...(mode === "rewrite-existing-observation"
          ? { observationIds: [deferredId] }
          : {}),
      };
      const action = admission({
        operation: "EXECUTE",
        sessionId: row.id,
        financialRequestId: KEY,
      });
      const before = await saved(row.id);
      const observationsBefore = await setup.importObservation.findMany({
        where: {
          id: {
            in: ["a", "b", "deferred"].map((key) => `${prefix}-obs-${key}`),
          },
        },
        orderBy: { id: "asc" },
      });
      const attempt = w.edit(action.auth, row.id, {
        expectedRevision: 7,
        questionId: null,
        replaceLines: [replacement, newLine],
        selectedLineIds:
          mode === "rewrite-existing-observation"
            ? draft.selectedLineIds
            : [...draft.selectedLineIds, newLine.id],
      });
      if (mode === "other-tenant" || mode === "other-anchor") {
        await expect(attempt).rejects.toBeInstanceOf(
          ImportSessionCorruptStateError,
        );
      } else {
        await expect(attempt).rejects.toMatchObject({
          code: mode === "released-ref" ? "NOT_FOUND" : "INVALID_INPUT",
        });
      }
      expect(await saved(row.id)).toEqual(before);
      expect(
        await setup.importObservation.findMany({
          where: {
            id: { in: observationsBefore.map((observation) => observation.id) },
          },
          orderBy: { id: "asc" },
        }),
      ).toEqual(observationsBefore);
      expect(port.applyInTx).not.toHaveBeenCalled();
      expect(port.prepareInTx).not.toHaveBeenCalled();
    },
  );
  it.each([
    "field",
    "line",
    "selection",
    "observation",
    "unknown-key",
    "unknown-line",
  ] as const)(
    "question and document guards reject %s edits without mutating the stored draft",
    async (mode) => {
      const w = workflow();
      const { row, draft } = await seed();
      draft.questions = [
        {
          id: "amount-question",
          lineIds: ["line-a"],
          field: "amountCents",
          text: "Qual o total?",
        },
      ];
      await setup.importSession.update({
        where: { id: row.id },
        data: { draftJson: JSON.stringify(draft) },
      });
      const action = admission({
        operation: "EXECUTE",
        sessionId: row.id,
        financialRequestId: KEY,
      });
      const before = await saved(row.id);
      const line = structuredClone(draft.lines[mode === "line" ? 1 : 0]);
      line.amountCents = 150;
      if (mode === "field") line.titulo = "Not the question field";
      if (mode === "observation")
        line.observationIds = draft.lines[1].observationIds;
      if (mode === "unknown-key") Reflect.set(line, "scope", {});
      if (mode === "unknown-line") line.id = "unknown-line";
      await expect(
        w.edit(action.auth, row.id, {
          expectedRevision: 7,
          questionId: "amount-question",
          replaceLines: [line],
          selectedLineIds:
            mode === "selection" ? ["line-a"] : draft.selectedLineIds,
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(await saved(row.id)).toEqual(before);
    },
  );
  it("a question permits its own field only and cannot repair missing current documentary membership", async () => {
    const w = workflow();
    const { row, draft, ref } = await seed();
    draft.questions = [
      {
        id: "amount-question",
        lineIds: ["line-a"],
        field: "amountCents",
        text: "Qual o total?",
      },
    ];
    await setup.importSession.update({
      where: { id: row.id },
      data: { draftJson: JSON.stringify(draft) },
    });
    const action = admission({
      operation: "EXECUTE",
      sessionId: row.id,
      financialRequestId: KEY,
    });
    const line = { ...draft.lines[0], amountCents: 150 };
    expect(
      await w.edit(action.auth, row.id, {
        expectedRevision: 7,
        questionId: "amount-question",
        replaceLines: [line],
        selectedLineIds: draft.selectedLineIds,
      }),
    ).toMatchObject({ revision: 8 });
    const other = await seedSession(setup, world);
    await setup.importSessionArtifact.update({
      where: { id: ref.id },
      data: { sessionId: other.id },
    });
    const before = await saved(row.id);
    await expect(
      w.edit(action.auth, row.id, {
        expectedRevision: 8,
        questionId: null,
        replaceLines: [{ ...line, titulo: "Another edit" }],
        selectedLineIds: draft.selectedLineIds,
      }),
    ).rejects.toBeInstanceOf(ImportSessionCorruptStateError);
    expect(await saved(row.id)).toEqual(before);
  });
  it("an immutable confirmation cannot be replaced by edit or another first confirmation", async () => {
    const { w, row, draft, hash } = await confirmed();
    const before = await saved(row.id);
    const action = admission({
      operation: "CONFIRM",
      sessionId: row.id,
      expectedRevision: 9,
      confirmationHash: hash,
      financialRequestId: KEY,
    });
    await expect(
      w.edit(action.auth, row.id, {
        expectedRevision: 9,
        questionId: null,
        replaceLines: [],
        selectedLineIds: draft.selectedLineIds,
      }),
    ).rejects.toMatchObject({ code: "STALE_PREVIEW" });
    await expect(
      w.confirm(
        action.auth,
        row.id,
        {
          expectedRevision: 9,
          confirmationHash: hash,
          financialRequestId: KEY,
          nonce: null,
        },
        action.grant,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await saved(row.id)).toEqual(before);
  });
  it.each(["CHALLENGE", "CONFIRM", "EXECUTE"] as const)(
    "forced in-flight ref is checked independently of H8 for %s",
    async (operation) => {
      const fixture =
        operation === "EXECUTE" ? await confirmed() : await ready();
      const { w, row, hash } = fixture;
      const action = admission(
        operation === "EXECUTE"
          ? { operation, sessionId: row.id, financialRequestId: KEY }
          : operation === "CONFIRM"
            ? {
                operation,
                sessionId: row.id,
                expectedRevision: 8,
                confirmationHash: hash,
                financialRequestId: KEY,
              }
            : {
                operation,
                sessionId: row.id,
                expectedRevision: 8,
                confirmationHash: hash,
              },
      );
      await setup.importSessionArtifact.create({
        data: {
          tenantId: world.tenantId,
          ownerProjectId: world.projects.pessoal,
          sessionId: row.id,
          position: 1,
          fileName: "in-flight.pdf",
          declaredMime: "application/pdf",
          declaredBytes: 10,
          reservedBytes: 10,
          state: "RESERVED",
        },
      });
      if (operation === "EXECUTE") {
        await expect(execute(w, row.id)).rejects.toMatchObject({
          code: "STALE_PREVIEW",
        });
        expect(await saved(row.id)).toMatchObject({
          state: "REVIEW_REQUIRED",
          confirmedRevision: 8,
          proposalHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
      } else if (operation === "CHALLENGE") {
        await expect(
          w.challenge(
            action.auth,
            row.id,
            { expectedRevision: 8, confirmationHash: hash },
            action.grant,
          ),
        ).rejects.toMatchObject({
          code: "LEASE_CONFLICT",
          reason: "ATTACHMENT_IN_FLIGHT",
        });
      } else {
        await expect(
          w.confirm(
            action.auth,
            row.id,
            {
              expectedRevision: 8,
              confirmationHash: hash,
              financialRequestId: KEY,
              nonce: null,
            },
            action.grant,
          ),
        ).rejects.toMatchObject({
          code: "LEASE_CONFLICT",
          reason: "ATTACHMENT_IN_FLIGHT",
        });
      }
      expect(port.applyInTx).not.toHaveBeenCalled();
    },
  );
  it.each(["selected-version", "deferred-version", "already-claimed"] as const)(
    "current %s drift cannot reach apply",
    async (mode) => {
      const { w, row, draft } = await confirmed();
      if (mode === "already-claimed") {
        const decision = draft.lines[0].decision;
        if (decision.kind !== "KEEP_EXISTING") throw new Error("Expected KEEP");
        await setup.importObservation.update({
          where: { id: `${prefix}-obs-a` },
          data: {
            claimVersion: 1,
            canonicalExpenseId: decision.expenseId,
            canonicalProjectId: world.projects.pessoal,
            claimReceiptJson: JSON.stringify({
              kind: "LEGACY_IMPORT",
              engine: "CARD",
              importId: null,
              externalId: "private-other-claim",
            }),
            claimedAt: NOW,
          },
        });
      } else {
        await setup.importObservation.update({
          where: {
            id: `${prefix}-obs-${mode === "selected-version" ? "a" : "deferred"}`,
          },
          data: { claimVersion: { increment: 1 } },
        });
      }
      await expect(execute(w, row.id)).rejects.toMatchObject({
        code: "STALE_PREVIEW",
      });
      expect(await saved(row.id)).toMatchObject({
        state: "REVIEW_REQUIRED",
        receiptJson: null,
        financialRequestId: KEY,
      });
      expect(port.applyInTx).not.toHaveBeenCalled();
    },
  );
  it("new current JWT authority does not reactivate consent tied to a revoked confirmation version", async () => {
    const { w, row } = await confirmed();
    await setup.user.update({
      where: { id: world.users.owner.id },
      data: { sessionVersion: 1 },
    });
    world.users.owner.sessionVersion = 1;
    await expect(execute(w, row.id)).rejects.toMatchObject({
      code: "STALE_PREVIEW",
    });
    expect(await saved(row.id)).toMatchObject({
      state: "REVIEW_REQUIRED",
      confirmedSessionVersion: 0,
    });
    expect(port.applyInTx).not.toHaveBeenCalled();
  });
  it("continuation preserves FAILED bytes and no-line observations, and cleanup never clears another session's lease", async () => {
    let failedId = "";
    let otherId = "";
    let unusedArtifactId = "";
    const { w, row, artifact } = await confirmed(async (fixture) => {
      const other = await seedSession(setup, world);
      otherId = other.id;
      await setup.importArtifact.update({
        where: { id: fixture.artifact.id },
        data: { leaseSessionId: other.id },
      });
      const failed = await setup.importSessionArtifact.create({
        data: {
          tenantId: world.tenantId,
          ownerProjectId: world.projects.pessoal,
          sessionId: fixture.row.id,
          position: 1,
          fileName: "failed.pdf",
          declaredMime: "application/pdf",
          declaredBytes: 10,
          reservedBytes: 10,
          state: "FAILED",
          temporaryStorageKey: "private-failed-key",
          temporaryPurgePending: true,
        },
      });
      failedId = failed.id;
      fixture.draft.scope.pendingAttachmentIds.push(failed.id);
      await setup.importSession.update({
        where: { id: fixture.row.id },
        data: { draftJson: JSON.stringify(fixture.draft) },
      });
      const unused = await setup.importArtifact.create({
        data: {
          tenantId: world.tenantId,
          ownerProjectId: world.projects.pessoal,
          documentSha256: "e".repeat(64),
          verifiedBytes: 10,
          detectedFormat: "PDF",
          state: "EXTRACTED",
          leaseSessionId: fixture.row.id,
        },
      });
      unusedArtifactId = unused.id;
      await setup.importSessionArtifact.create({
        data: {
          tenantId: world.tenantId,
          ownerProjectId: world.projects.pessoal,
          sessionId: fixture.row.id,
          artifactId: unused.id,
          position: 2,
          fileName: "empty.pdf",
          declaredMime: "application/pdf",
          declaredBytes: 10,
          reservedBytes: 10,
          state: "ATTACHED",
          verifiedAt: NOW,
        },
      });
    });
    const receipt = await execute(w, row.id);
    expect(
      await setup.importSessionArtifact.findUniqueOrThrow({
        where: { id: failedId },
      }),
    ).toMatchObject({
      sessionId: receipt.continuationSessionId,
      state: "FAILED",
      artifactId: null,
      reservedBytes: 10,
      temporaryStorageKey: "private-failed-key",
      temporaryPurgePending: true,
      uploadGeneration: 1,
    });
    expect(
      JSON.parse((await saved(receipt.continuationSessionId!)).draftJson),
    ).toMatchObject({
      lines: [],
      selectedLineIds: [],
      questions: [],
      scope: {
        observationIds: [`${prefix}-obs-deferred`],
        pendingAttachmentIds: [failedId],
      },
    });
    expect(
      await setup.importArtifact.findUniqueOrThrow({
        where: { id: artifact.id },
      }),
    ).toMatchObject({ leaseSessionId: otherId, parseGeneration: 0 });
    expect(
      await setup.importArtifact.findUniqueOrThrow({
        where: { id: unusedArtifactId },
      }),
    ).toMatchObject({ leaseSessionId: null, parseGeneration: 1 });
  });
  it("cancel and execute serialize; whichever loses cannot leave partial coordination effects", async () => {
    const { w, row } = await confirmed();
    const action = admission({
      operation: "EXECUTE",
      sessionId: row.id,
      financialRequestId: KEY,
    });
    const cancelGrant = mintGrant(issuer, action.auth, {
      operation: "CANCEL_SESSION",
      sessionId: row.id,
      expectedRevision: 9,
    });
    const recovery = new ImportSessionService(
      prisma,
      clock,
      { writesEnabled: () => false, newImportFormats: () => [] },
      verifier,
      ...rawTestDependencies(
        new ImportVaultGate(prisma, clock, {}, process.cwd()),
        clock,
        { writesEnabled: () => false, newImportFormats: () => [] },
      ),
    );
    const results = await Promise.allSettled([
      execute(w, row.id),
      recovery.cancel(
        action.auth,
        row.id,
        { expectedRevision: 9 },
        cancelGrant,
      ),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const current = await saved(row.id);
    if (current.state === "APPLIED") {
      expect(
        await setup.importObservation.count({
          where: { claimSessionId: row.id },
        }),
      ).toBe(2);
      expect(results[1]).toMatchObject({
        status: "rejected",
        reason: { code: "ALREADY_APPLIED" },
      });
    } else {
      expect(current.state).toBe("CANCELLED");
      expect(
        await setup.importObservation.count({
          where: { claimSessionId: row.id },
        }),
      ).toBe(0);
      expect(
        await setup.userActivityLog.count({
          where: { tenantId: world.tenantId },
        }),
      ).toBe(0);
      expect(port.applyInTx).not.toHaveBeenCalled();
    }
  });
});
