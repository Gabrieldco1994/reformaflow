// The database guard must run before PrismaClient is imported.
// eslint-disable-next-line @typescript-eslint/no-var-requires
require("../../../../../scripts/test-db-env.cjs");

import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  ExpenseType,
  ImportSessionAmountMeaning,
  type ImportInterpretationRequestV1,
  type ImportObservationQuestionV1,
  type ImportSessionStoredDraftV1,
} from "@reformaflow/domain";
import type { AgentDailyQuotaService } from "../../agent/agent-daily-quota.service";
import type {
  ChatMessage,
  LlmProvider,
  ToolDef,
} from "../../agent/llm/llm.types";
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
import { documentaryPayloadHash } from "./import-session-documentary.commands";
import { ImportSessionInterpretationService } from "./import-session-interpretation.service";
import type { ImportSessionCapability } from "./import-session.capability";
import type { UiImportGrantScope } from "./import-session.contract";
import {
  ImportUiGrantIssuer,
  RuntimeUiGrantVerifier,
} from "./import-session-ui-grant";
import { validateStoredDraft } from "./import-session.validation";

const PREFIX = "imp-interpretation-failure";
const setup = new PrismaClient();
const prisma = new PrismaService();
const clock = new MutableClock(new Date(FIXED_NOW));
const capability: ImportSessionCapability = {
  writesEnabled: () => true,
  newImportFormats: () => [],
};
const issuer = new ImportUiGrantIssuer(clock);
const question: ImportObservationQuestionV1 = {
  id: "question-1",
  lineIds: ["line-1"],
  field: "amountCents",
  text: "Valor",
  subject: {
    kind: "OBSERVATION",
    observationId: "observation-1",
    meaningContext: ImportSessionAmountMeaning.TOTAL_PURCHASE,
  },
  answerState: "UNANSWERED",
};

let world: ImportWorld;
let chat: jest.MockedFunction<LlmProvider["chat"]>;
let configured: jest.MockedFunction<LlmProvider["isConfigured"]>;
let consume: jest.MockedFunction<AgentDailyQuotaService["consume"]>;
let service: ImportSessionInterpretationService;

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
      amountCents: null,
      installmentCount: 1,
      dataCompra: "2026-10-09",
      firstDueDate: "2026-10-09",
      targets: null,
      decision: { kind: "UNRESOLVED" },
    },
  ],
  selectedLineIds: ["line-1"],
  questions: [],
  scope: {
    observationIds: ["observation-1"],
    pendingAttachmentIds: [],
  },
});

function request(
  overrides: Partial<ImportInterpretationRequestV1> = {},
): ImportInterpretationRequestV1 {
  return {
    version: 1,
    requestId: randomUUID(),
    expectedRevision: 1,
    questionId: question.id,
    text: "R$ 100,01",
    consentExternalProcessing: true,
    ...overrides,
  };
}

function grant(
  auth: ReturnType<typeof authFor>,
  sessionId: string,
  command: ImportInterpretationRequestV1,
): unknown {
  const payloadHash = documentaryPayloadHash(
    sessionId,
    "INTERPRET_QUESTION",
    command,
  );
  const scope: UiImportGrantScope = {
    operation: "INTERPRET_QUESTION",
    sessionId,
    expectedRevision: command.expectedRevision,
    requestId: command.requestId,
    questionId: command.questionId,
    payloadHash,
  };
  return mintGrant(issuer, auth, scope);
}

function exactClarify(messages: ChatMessage[]) {
  const focused = JSON.parse(messages[1]!.content) as {
    focusAlias: string;
    literal: string;
  };
  return {
    content: "",
    toolCalls: [
      {
        id: "call-1",
        name: "submit_import_interpretation",
        arguments: {
          version: 1,
          focusAlias: focused.focusAlias,
          evidence: {
            start: 0,
            end: focused.literal.length,
            text: focused.literal,
          },
          outcome: "CLARIFY",
          candidate: null,
        },
      },
    ],
  };
}

async function seeded() {
  const row = await seedSession(setup, world, {
    draftJson: JSON.stringify(draft()),
  });
  return { row, auth: authFor(world.users.owner) };
}

async function seededPending(recordedAt: Date) {
  const seededRow = await seeded();
  const command = request();
  const stored = draft();
  stored.interpretationLedger = {
    version: 1,
    items: [
      {
        requestId: command.requestId,
        payloadHash: documentaryPayloadHash(
          seededRow.row.id,
          "INTERPRET_QUESTION",
          command,
        ),
        expectedRevision: command.expectedRevision,
        status: "PENDING",
        recordedAt: recordedAt.toISOString(),
      },
    ],
  };
  await setup.importSession.update({
    where: { id: seededRow.row.id },
    data: { draftJson: JSON.stringify(stored) },
  });
  return { ...seededRow, command };
}

describe("focused interpretation coordination (real Prisma)", () => {
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
    chat = jest.fn();
    configured = jest.fn(() => true);
    consume = jest.fn(async (_tenantId: string) => undefined);
    service = new ImportSessionInterpretationService(
      prisma,
      clock,
      capability,
      new RuntimeUiGrantVerifier(),
      {
        id: "focused-test",
        isConfigured: configured,
        chat,
      },
      { consume } as unknown as AgentDailyQuotaService,
    );
    jest
      .spyOn(
        service as unknown as {
          question(...args: unknown[]): Promise<ImportObservationQuestionV1>;
        },
        "question",
      )
      .mockResolvedValue(question);
  });

  afterAll(async () => {
    await cleanupImportWorld(setup, PREFIX);
    await prisma.onModuleDestroy();
    await setup.$disconnect();
  });

  it("persists and exactly replays provider failure without another call or quota", async () => {
    const { row, auth } = await seeded();
    const command = request();
    chat.mockRejectedValue(new Error("synthetic provider failure"));

    await expect(
      service.interpret(auth, row.id, command, grant(auth, row.id, command)),
    ).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      status: 503,
      retryable: true,
    });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledTimes(1);

    const persisted = await setup.importSession.findUniqueOrThrow({
      where: { id: row.id },
    });
    const ledger = (
      JSON.parse(persisted.draftJson) as ImportSessionStoredDraftV1
    ).interpretationLedger;
    expect(ledger?.items).toEqual([
      expect.objectContaining({
        requestId: command.requestId,
        status: "FAILED",
        failureCode: "PROVIDER_UNAVAILABLE",
      }),
    ]);
    expect(JSON.stringify(ledger)).not.toContain(command.text);
    expect(JSON.stringify(ledger)).not.toContain("synthetic provider failure");
    expect(JSON.stringify(ledger)).not.toContain(question.id);
    expect(JSON.stringify(ledger)).not.toContain(question.lineIds[0]);
    expect(JSON.stringify(ledger)).not.toContain(
      question.subject.observationId,
    );

    await expect(
      service.interpret(auth, row.id, command, grant(auth, row.id, command)),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it("does not consume quota when provider configuration is unavailable", async () => {
    const { row, auth } = await seeded();
    const command = request();
    configured.mockReturnValue(false);

    await expect(
      service.interpret(auth, row.id, command, grant(auth, row.id, command)),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(chat).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });

  it("persists malformed model output as non-retryable and conflicts on another hash", async () => {
    const { row, auth } = await seeded();
    const command = request();
    chat.mockResolvedValue({ content: "", toolCalls: [] });

    await expect(
      service.interpret(auth, row.id, command, grant(auth, row.id, command)),
    ).rejects.toMatchObject({
      code: "MODEL_OUTPUT_INVALID",
      status: 502,
      retryable: false,
    });
    const changed = { ...command, text: "R$ 999,99" };
    await expect(
      service.interpret(auth, row.id, changed, grant(auth, row.id, changed)),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it("keeps exact model clarification as a successful replay", async () => {
    const { row, auth } = await seeded();
    const command = request();
    chat.mockImplementation(async (messages) => exactClarify(messages));

    const result = await service.interpret(
      auth,
      row.id,
      command,
      grant(auth, row.id, command),
    );
    expect(result).toEqual({
      version: 1,
      requestId: command.requestId,
      outcome: "CLARIFY",
    });
    await expect(
      service.interpret(auth, row.id, command, grant(auth, row.id, command)),
    ).resolves.toEqual(result);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledTimes(1);
  });

  it("returns lease conflict for fresh pending and fails expired pending without quota", async () => {
    const fresh = await seededPending(clock.now());
    await expect(
      service.interpret(
        fresh.auth,
        fresh.row.id,
        fresh.command,
        grant(fresh.auth, fresh.row.id, fresh.command),
      ),
    ).rejects.toMatchObject({ code: "LEASE_CONFLICT" });
    expect(chat).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();

    await setup.importSession.delete({ where: { id: fresh.row.id } });
    const expired = await seededPending(
      new Date(clock.now().getTime() - 121_000),
    );
    await expect(
      service.interpret(
        expired.auth,
        expired.row.id,
        expired.command,
        grant(expired.auth, expired.row.id, expired.command),
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    const persisted = await setup.importSession.findUniqueOrThrow({
      where: { id: expired.row.id },
    });
    expect(
      (JSON.parse(persisted.draftJson) as ImportSessionStoredDraftV1)
        .interpretationLedger?.items[0],
    ).toMatchObject({
      status: "FAILED",
      failureCode: "PROVIDER_UNAVAILABLE",
    });
    expect(chat).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
  });

  it("never downgrades a stale post-provider result to clarification", async () => {
    const { row, auth } = await seeded();
    const command = request();
    chat.mockImplementation(async (messages) => {
      await setup.importSession.update({
        where: { id: row.id },
        data: { revision: { increment: 1 } },
      });
      return exactClarify(messages);
    });

    await expect(
      service.interpret(auth, row.id, command, grant(auth, row.id, command)),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const persisted = await setup.importSession.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(
      (JSON.parse(persisted.draftJson) as ImportSessionStoredDraftV1)
        .interpretationLedger?.items[0]?.status,
    ).toBe("PENDING");
  });

  it("allows only one provider call while an exact concurrent replay is pending", async () => {
    const { row, auth } = await seeded();
    const command = request();
    let announceStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    let releaseProvider: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    chat.mockImplementation(async (messages) => {
      announceStarted?.();
      await released;
      return exactClarify(messages);
    });

    const first = service.interpret(
      auth,
      row.id,
      command,
      grant(auth, row.id, command),
    );
    await started;
    await expect(
      service.interpret(auth, row.id, command, grant(auth, row.id, command)),
    ).rejects.toMatchObject({ code: "LEASE_CONFLICT" });
    releaseProvider?.();
    await expect(first).resolves.toMatchObject({ outcome: "CLARIFY" });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledTimes(1);
  });
});

describe("stored interpretation failure validation", () => {
  const base = draft();
  const requestId = "71600000-0000-4000-8000-000000000010";
  const failed = {
    requestId,
    payloadHash: "a".repeat(64),
    expectedRevision: 1,
    status: "FAILED",
    failureCode: "PROVIDER_UNAVAILABLE",
    recordedAt: FIXED_NOW.toISOString(),
  } as const;

  it("accepts only the bounded sanitized FAILED record", () => {
    expect(() =>
      validateStoredDraft({
        ...base,
        interpretationLedger: { version: 1, items: [failed] },
      }),
    ).not.toThrow();
    for (const extra of [
      { result: { outcome: "CLARIFY" } },
      { rawOutput: "private" },
      { text: "R$ 100,01" },
      { questionId: "question-1" },
    ])
      expect(() =>
        validateStoredDraft({
          ...base,
          interpretationLedger: {
            version: 1,
            items: [{ ...failed, ...extra }],
          },
        }),
      ).toThrow();
  });
});
