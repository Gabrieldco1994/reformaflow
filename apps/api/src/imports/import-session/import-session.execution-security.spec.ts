import { rawTestDependencies } from "../../test-utils/import-session-raw-harness";
require("../../../../../scripts/test-db-env.cjs");
import { ImportVaultGate } from "./vault/vault-state";

import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ExecutionContextHost } from "@nestjs/core/helpers/execution-context-host";
import { PrismaClient } from "@prisma/client";
import type {
  ImportSessionChallengeResponseV1,
  ImportSessionConfirmResponseV1,
  ImportSessionReceiptV1,
} from "@reformaflow/domain";
import { PrismaService } from "../../prisma/prisma.service";
import {
  cleanupImportWorld,
  MutableClock,
  seedImportWorld,
  seedSession,
  VALID_RECEIPT,
  type ImportWorld,
} from "../../test-utils/import-session-harness";
import type { CardPurchaseBatchPort } from "./card-purchase-batch.port";
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
import { ImportSessionError, importSessionWire } from "./import-session.errors";
import { ImportSessionService } from "./import-session.service";
import {
  ImportUiGrantIssuer,
  RuntimeUiGrantVerifier,
} from "./import-session-ui-grant";
import { IMPORT_UI_HEADER, ImportUiGuard } from "./import-session-ui.guard";

interface Workflow {
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
const H8 = "8".repeat(64);
const KEY = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_KEY = "223e4567-e89b-42d3-a456-426614174000";

describe("W security RED: per-invocation admission and current writer authority", () => {
  const prefix = "w636-security";
  const setup = new PrismaClient();
  const prisma = new PrismaService();
  const clock = new MutableClock(NOW);
  const verifier = new RuntimeUiGrantVerifier();
  const issuer = new ImportUiGrantIssuer(clock);
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
  let world: ImportWorld;
  let onUserRead: (() => Promise<void>) | null = null;
  let userReads = 0;
  const events: string[] = [];
  const port: CardPurchaseBatchPort = {
    prepareInTx: jest.fn(async () => {
      throw new Error("Historical replay must not prepare");
    }),
    applyInTx: jest.fn(async () => {
      throw new Error("Historical replay must not apply");
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

  function admission(
    scope: UiImportFinancialActionScope,
    user: ImportWorld["users"]["owner"] = world.users.owner,
    tokenDeadline = DEADLINE,
  ) {
    const request = {
      headers: { origin: "http://localhost:3000", [IMPORT_UI_HEADER]: "1" },
      user: {
        id: user.id,
        tenantId: user.tenantId,
        authClaims: {
          sessionVersion: user.sessionVersion,
          expiresAtEpochSeconds: tokenDeadline.getTime() / 1000,
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

  async function applied() {
    const id = randomUUID();
    const receipt = {
      ...VALID_RECEIPT(id, ["historical-source"], [world.projects.pessoal]),
      financialRequestId: KEY,
      confirmedRevision: 8,
      proposalHash: H8,
    };
    return seedSession(setup, world, {
      id,
      state: "APPLIED",
      revision: 10,
      financialRequestId: KEY,
      confirmedRevision: 8,
      confirmedSessionVersion: 0,
      proposalHash: H8,
      confirmedAt: NOW,
      closedAt: NOW,
      receiptJson: JSON.stringify(receipt),
      expiresAt: DEADLINE,
    });
  }

  beforeAll(async () => {
    await setup.$connect();
    await prisma.onModuleInit();
    prisma.$use(async (params, next) => {
      events.push(`${params.model ?? "raw"}:${params.action}`);
      if (params.model === "User" && params.action === "findUnique") {
        userReads++;
        await onUserRead?.();
      }
      return next(params);
    });
  });
  beforeEach(async () => {
    clock.current = NOW;
    onUserRead = null;
    world = await seedImportWorld(setup, prefix);
    userReads = 0;
    events.length = 0;
    jest.clearAllMocks();
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    onUserRead = null;
    await cleanupImportWorld(setup, prefix);
    await setup.$disconnect();
    await prisma.onModuleDestroy();
  });

  it("exports all three financial admission methods", () => {
    const instance = workflow();
    expect(typeof instance.challenge).toBe("function");
    expect(typeof instance.confirm).toBe("function");
    expect(typeof instance.execute).toBe("function");
  });

  it.each(["CHALLENGE", "CONFIRM", "EXECUTE"] as const)(
    "%s refuses a forged grant before writer admission, including while OFF",
    async (operation) => {
      const instance = workflow();
      const row = await applied();
      const action = admission({
        operation: "EXECUTE",
        sessionId: row.id,
        financialRequestId: KEY,
      });
      events.length = 0;
      const call =
        operation === "CHALLENGE"
          ? instance.challenge(
              action.auth,
              row.id,
              { expectedRevision: 8, confirmationHash: H8 },
              {},
            )
          : operation === "CONFIRM"
            ? instance.confirm(
                action.auth,
                row.id,
                {
                  expectedRevision: 8,
                  confirmationHash: H8,
                  financialRequestId: KEY,
                  nonce: null,
                },
                {},
              )
            : instance.execute(
                action.auth,
                row.id,
                { financialRequestId: KEY },
                {},
              );
      await expect(call).rejects.toMatchObject({ code: "UI_ACTION_REQUIRED" });
      expect(events).toEqual([]);
      expect(port.applyInTx).not.toHaveBeenCalled();
    },
  );

  it("financial admission expires at 30 seconds, independently of the 300-second nonce contract", async () => {
    const instance = workflow();
    const row = await applied();
    const action = admission({
      operation: "EXECUTE",
      sessionId: row.id,
      financialRequestId: KEY,
    });
    clock.current = new Date(NOW.getTime() + 30_000);
    await expect(
      instance.execute(
        action.auth,
        row.id,
        { financialRequestId: KEY },
        action.grant,
      ),
    ).rejects.toMatchObject({ code: "UI_ACTION_REQUIRED" });
    expect(userReads).toBe(0);
  });

  it("a consumed grant cannot authorize another invocation, but fresh admission can replay", async () => {
    const instance = workflow();
    const row = await applied();
    const scope = {
      operation: "EXECUTE" as const,
      sessionId: row.id,
      financialRequestId: KEY,
    };
    const first = admission(scope);
    const receipt = await instance.execute(
      first.auth,
      row.id,
      { financialRequestId: KEY },
      first.grant,
    );
    await expect(
      instance.execute(
        first.auth,
        row.id,
        { financialRequestId: KEY },
        first.grant,
      ),
    ).rejects.toMatchObject({ code: "UI_ACTION_REQUIRED" });
    const second = admission(scope);
    expect(
      await instance.execute(
        second.auth,
        row.id,
        { financialRequestId: KEY },
        second.grant,
      ),
    ).toEqual(receipt);
  });

  it("snapshots execute arguments before its first await", async () => {
    const instance = workflow();
    const row = await applied();
    const body = { financialRequestId: KEY };
    const action = admission({
      operation: "EXECUTE",
      sessionId: row.id,
      financialRequestId: KEY,
    });
    onUserRead = async () => {
      body.financialRequestId = OTHER_KEY;
    };
    const result = await instance.execute(
      action.auth,
      row.id,
      body,
      action.grant,
    );
    expect(body.financialRequestId).toBe(OTHER_KEY);
    expect(result.financialRequestId).toBe(KEY);
    expect(
      await setup.importSession.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({
      financialRequestId: KEY,
      revision: 10,
      proposalHash: H8,
    });
  });

  it("snapshots the whole confirm replay tuple and nonce before its first await", async () => {
    const instance = workflow();
    const row = await applied();
    const body = {
      expectedRevision: 8,
      confirmationHash: H8,
      financialRequestId: KEY,
      nonce: null as string | null,
    };
    const action = admission({
      operation: "CONFIRM",
      sessionId: row.id,
      expectedRevision: 8,
      confirmationHash: H8,
      financialRequestId: KEY,
    });
    onUserRead = async () => {
      Object.assign(body, {
        expectedRevision: 9,
        confirmationHash: "f".repeat(64),
        financialRequestId: OTHER_KEY,
        nonce: "mutated",
      });
    };
    await expect(
      instance.confirm(action.auth, row.id, body, action.grant),
    ).resolves.toEqual({
      sessionId: row.id,
      financialRequestId: KEY,
      state: "APPLIED",
    });
    expect(body.financialRequestId).toBe(OTHER_KEY);
  });

  it("verifies once across three real writer attempts and reauthorizes each attempt", async () => {
    const instance = workflow();
    const row = await applied();
    const action = admission({
      operation: "EXECUTE",
      sessionId: row.id,
      financialRequestId: KEY,
    });
    const verification = jest.spyOn(verifier, "verifyFinancialAction");
    const transactions = jest.spyOn(prisma, "$transaction");
    onUserRead = async () => {
      if (userReads < 3) throw new Error("SQLITE_BUSY");
    };
    await expect(
      instance.execute(
        action.auth,
        row.id,
        { financialRequestId: KEY },
        action.grant,
      ),
    ).resolves.toMatchObject({
      financialRequestId: KEY,
      confirmedRevision: 8,
      bindingVersion: 0,
      confirmationHash: null,
    });
    expect(verification).toHaveBeenCalledTimes(1);
    expect(userReads).toBe(3);
    expect(transactions).toHaveBeenCalledTimes(3);
    expect(events.filter((event) => event === "raw:executeRaw")).toHaveLength(
      3,
    );
    expect(events[0]).toBe("raw:executeRaw");
    for (const call of transactions.mock.calls)
      expect(call[1]).toEqual({ maxWait: 5000, timeout: 20000 });
  });

  it("retry does not renew admission and still checks current JWT expiration after the next writer lock", async () => {
    const instance = workflow();
    const row = await applied();
    const expires = new Date(NOW.getTime() + 60_000);
    const action = admission(
      { operation: "EXECUTE", sessionId: row.id, financialRequestId: KEY },
      world.users.owner,
      expires,
    );
    const verification = jest.spyOn(verifier, "verifyFinancialAction");
    onUserRead = async () => {
      clock.current = expires;
      throw new Error("SQLITE_BUSY");
    };
    await expect(
      instance.execute(
        action.auth,
        row.id,
        { financialRequestId: KEY },
        action.grant,
      ),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(verification).toHaveBeenCalledTimes(1);
    expect(events.filter((event) => event === "raw:executeRaw")).toHaveLength(
      2,
    );
    expect(userReads).toBe(1);
    expect(
      await setup.importSession.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({ state: "APPLIED", revision: 10 });
  });

  it.each([
    "session-version",
    "malformed-grants",
    "tenant",
    "card",
    "anchor",
  ] as const)(
    "fresh current-authority check rejects %s revoked after grant issuance",
    async (revoked) => {
      const instance = workflow();
      const row = await applied();
      const action = admission({
        operation: "EXECUTE",
        sessionId: row.id,
        financialRequestId: KEY,
      });
      if (revoked === "session-version")
        await setup.user.update({
          where: { id: world.users.owner.id },
          data: { sessionVersion: 1 },
        });
      if (revoked === "malformed-grants")
        await setup.user.update({
          where: { id: world.users.owner.id },
          data: { allowedModules: "null" },
        });
      if (revoked === "tenant")
        await setup.tenant.update({
          where: { id: world.tenantId },
          data: { deletedAt: NOW },
        });
      if (revoked === "card")
        await setup.creditCard.update({
          where: { id: world.cards.pessoal },
          data: { deletedAt: NOW },
        });
      if (revoked === "anchor")
        await setup.project.update({
          where: { id: world.projects.pessoal },
          data: { deletedAt: NOW },
        });
      const before = await setup.importSession.findUniqueOrThrow({
        where: { id: row.id },
      });
      await expect(
        instance.execute(
          action.auth,
          row.id,
          { financialRequestId: KEY },
          action.grant,
        ),
      ).rejects.toMatchObject({
        code:
          revoked === "card" || revoked === "anchor"
            ? "NOT_FOUND"
            : "UNAUTHENTICATED",
      });
      expect(events[0]).toBe("raw:executeRaw");
      expect(
        await setup.importSession.findUniqueOrThrow({ where: { id: row.id } }),
      ).toEqual(before);
      expect(port.applyInTx).not.toHaveBeenCalled();
    },
  );

  it("another owner and a missing session yield identical public errors after valid UI admission", async () => {
    const instance = workflow();
    const row = await applied();
    const capture = async (id: string): Promise<string> => {
      const action = admission(
        { operation: "EXECUTE", sessionId: id, financialRequestId: KEY },
        world.users.peer,
      );
      try {
        await instance.execute(
          action.auth,
          id,
          { financialRequestId: KEY },
          action.grant,
        );
      } catch (error) {
        expect(error).toBeInstanceOf(ImportSessionError);
        if (!(error instanceof ImportSessionError)) throw error;
        expect(error.code).toBe("NOT_FOUND");
        return JSON.stringify(importSessionWire(error));
      }
      throw new Error("Expected opaque denial");
    };
    expect(await capture(row.id)).toBe(await capture("nonexistent-session"));
  });

  it("CONTROL: read/result needs no financial grant or explicit tenant UPDATE, even after admission TTL", async () => {
    const row = await applied();
    const { auth } = admission({
      operation: "EXECUTE",
      sessionId: row.id,
      financialRequestId: KEY,
    });
    clock.current = new Date(NOW.getTime() + 30_000);
    const verification = jest.spyOn(verifier, "verifyFinancialAction");
    const result = await recovery.getResult(auth, row.id);
    expect(result.state).toBe("APPLIED");
    expect(result.receipt?.financialRequestId).toBe(KEY);
    expect(verification).not.toHaveBeenCalled();
    expect(events.filter((event) => event === "raw:executeRaw")).toEqual([]);
  });
});
