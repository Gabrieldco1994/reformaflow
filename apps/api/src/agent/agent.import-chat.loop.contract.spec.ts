const testDbGuard: {
  REPO_ROOT: string;
  ACTIVE_DB_PATH: string;
} = require("../../../../scripts/test-db-env.cjs");

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { basename, resolve } from "node:path";
import { Module, ValidationPipe, type INestApplication } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type {
  ImportChatTurnV1,
  ImportSessionDraftQuestionV1,
  ImportSessionStoredDraftV1,
} from "@reformaflow/domain";
import cookieParser from "cookie-parser";
import { AuthModule } from "../auth/auth.module";
import { AuthService } from "../auth/auth.service";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard";
import { ModulesGuard } from "../common/guards/modules.guard";
import { ProjectAccessGuard } from "../common/guards/project-access.guard";
import { RolesGuard } from "../common/guards/roles.guard";
import { ExpenseService } from "../expense/expense.service";
import {
  IMPORT_SESSION_CAPABILITY,
  IMPORT_SESSION_CLOCK,
  type ImportSessionCapability,
} from "../imports/import-session/import-session.capability";
import { ImportSessionModule } from "../imports/import-session/import-session.module";
import { ImportChatBridge } from "../imports/import-session/import-chat.bridge";
import { IMPORT_SESSION_UI_ORIGINS } from "../imports/import-session/import-session-ui.guard";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import { PrismaService } from "../prisma/prisma.service";
import {
  FIXED_NOW,
  MutableClock,
  seedImportWorld,
  seedSession,
  type ImportWorld,
} from "../test-utils/import-session-harness";
import { validationDraft } from "../test-utils/import-session-validation-fixtures";
import { AgentModule } from "./agent.module";
import { AgentService } from "./agent.service";
import {
  FallbackLlmProvider,
  RateLimitError,
} from "./llm/fallback-llm.provider";
import {
  LLM_PROVIDER,
  LlmResponseContractError,
  type LlmProvider,
  type ToolCall,
} from "./llm/llm.types";
import { OpenAiCompatibleProvider } from "./llm/openai-compatible.provider";
import { AgentToolsService } from "./tools/agent-tools.service";

const evidenceRoot =
  process.env.P08_QA_EVIDENCE ??
  resolve(testDbGuard.REPO_ROOT, ".agents/p08-contextual-evidence");
mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
const evidenceDirectory = mkdtempSync(resolve(evidenceRoot, "loop-"));
const suiteRun = basename(evidenceDirectory);

const TURN_ID = "9cad9057-c2d4-4ddd-bc49-79e651b9a002";
const ORIGIN = "http://localhost:3000";
const clock = new MutableClock(FIXED_NOW);
const capability: ImportSessionCapability = {
  writesEnabled: () => true,
  newImportFormats: () => [],
};
const primary: LlmProvider = {
  id: "qa-primary",
  isConfigured: () => true,
  chat: jest.fn(),
};
const secondary: LlmProvider = {
  id: "qa-secondary",
  isConfigured: () => true,
  chat: jest.fn(),
};
const fallback = new FallbackLlmProvider([primary, secondary]);

@Module({
  imports: [AuthModule, AgentModule, ImportSessionModule],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: ModulesGuard },
    { provide: APP_GUARD, useClass: ProjectAccessGuard },
  ],
})
class ContextualLoopModule {}

function object(value: unknown): Record<string, unknown> {
  expect(value).not.toBeNull();
  expect(typeof value).toBe("object");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object");
  }
  return value as Record<string, unknown>;
}

function proveDatabase(label: string): void {
  const expected = testDbGuard.ACTIVE_DB_PATH;
  expect(process.env.DATABASE_URL).toBe(`file:${expected}`);
  const raw = execFileSync(
    "lsof",
    ["-nP", "-a", "-p", String(process.pid), "-Fn"],
    {
      encoding: "utf8",
    },
  );
  writeFileSync(resolve(evidenceDirectory, `${label}.lsof`), raw, {
    mode: 0o600,
    flag: "wx",
  });
  const files = raw
    .split("\n")
    .filter((line) =>
      /^n.*\.(?:db|sqlite3?)(?:-(?:wal|shm|journal))?$/.test(line),
    )
    .map((line) => line.slice(1));
  expect(files).toContain(expected);
  expect(
    files.filter(
      (file) =>
        ![
          expected,
          `${expected}-wal`,
          `${expected}-shm`,
          `${expected}-journal`,
        ].includes(file),
    ),
  ).toEqual([]);
}

const read: ToolCall = {
  id: "read-1",
  name: "import_read_session",
  arguments: {},
};
const edit: ToolCall = {
  id: "edit-1",
  name: "import_edit_answer",
  arguments: {
    interpretation: {
      kind: "VALUE",
      field: "amountCents",
      evidence: { start: 0, end: 6 },
      value: { span: { start: 0, end: 6 }, text: "206,96" },
    },
  },
};
const forbidden: ToolCall = {
  id: "write-1",
  name: "create_expense",
  arguments: {},
};
const ambiguous: ToolCall = {
  id: "answer-1",
  name: "import_edit_answer",
  arguments: { interpretation: { kind: "AMBIGUOUS" } },
};

describe("P08 contextual loop contract (HTTP -> real AgentService/AgentToolsService)", () => {
  let app: INestApplication;
  let db: PrismaService;
  let world: ImportWorld;
  let port: number;
  let sessionId: string;
  let attachmentId: string;
  let draft: ImportSessionStoredDraftV1;
  let tick = 0;
  let dispatch: jest.SpyInstance<
    ReturnType<AgentToolsService["execute"]>,
    Parameters<AgentToolsService["execute"]>
  >;

  const answer = (
    field: ImportSessionDraftQuestionV1["field"] = "amountCents",
    channel: "TEXT" | "VOICE" = "TEXT",
    literalAnswer = "206,96",
  ): ImportChatTurnV1 => ({
    version: 1,
    turnId: TURN_ID,
    sessionId,
    expectedRevision: 1,
    channel,
    literalAnswer,
    intent: "ANSWER",
    focus: { id: "question-amount", field, lineIds: ["line-unknown"] },
    scope: { kind: "LINES", lineIds: ["line-unknown"] },
  });

  const consult = (
    intent: "CONTINUE" | "OPEN_REVIEW" | "READ_RESULT",
    channel: "TEXT" | "VOICE" = "TEXT",
  ): ImportChatTurnV1 => ({
    version: 1,
    turnId: TURN_ID,
    sessionId,
    expectedRevision: 1,
    channel,
    literalAnswer: "sim",
    intent,
    focus: null,
    scope: null,
  });

  async function call(
    method: "GET" | "POST",
    path: string,
    payload?: unknown,
    userId = world.users.owner.id,
  ): Promise<{ status: number; json: unknown }> {
    const token = app.get(AuthService).issueToken(
      await db.user.findUniqueOrThrow({
        where: { id: userId },
      }),
    );
    const text = payload === undefined ? undefined : JSON.stringify(payload);
    return new Promise((resolveReply, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path,
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(text === undefined
              ? {}
              : {
                  origin: ORIGIN,
                  "x-rf-import-ui": "1",
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(text),
                }),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () => {
            const json: unknown = JSON.parse(
              Buffer.concat(chunks).toString("utf8"),
            );
            resolveReply({ status: res.statusCode ?? 0, json });
          });
        },
      );
      req.on("error", reject);
      req.end(text);
    });
  }

  function post(importTurn: ImportChatTurnV1) {
    return call("POST", "/agent/chat", {
      messages: [{ role: "user", content: importTurn.literalAnswer }],
      importTurn,
    });
  }

  async function snapshot() {
    return {
      session: await db.importSession.findUniqueOrThrow({
        where: { id: sessionId },
      }),
      expenses: await db.expense.count({ where: { tenantId: world.tenantId } }),
      receipts: await db.receipt.count({ where: { tenantId: world.tenantId } }),
      cash: await db.cashFlowEntry.count({
        where: { tenantId: world.tenantId },
      }),
      rules: await db.merchantCategory.count({
        where: { tenantId: world.tenantId },
      }),
    };
  }

  async function focus(field: ImportSessionDraftQuestionV1["field"]) {
    draft.questions[0]!.field = field;
    await db.importSession.update({
      where: { id: sessionId },
      data: { draftJson: JSON.stringify(draft) },
    });
  }

  beforeAll(async () => {
    jest.useFakeTimers({
      now: FIXED_NOW,
      doNotFake: [
        "hrtime",
        "nextTick",
        "performance",
        "queueMicrotask",
        "setImmediate",
        "clearImmediate",
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
      ],
    });
    const module = await Test.createTestingModule({
      imports: [ContextualLoopModule],
    })
      .overrideProvider(LLM_PROVIDER)
      .useValue(fallback)
      .overrideProvider(IMPORT_SESSION_CLOCK)
      .useValue(clock)
      .overrideProvider(IMPORT_SESSION_CAPABILITY)
      .useValue(capability)
      .overrideProvider(IMPORT_SESSION_UI_ORIGINS)
      .useValue({ allowed: () => [ORIGIN] })
      .compile();
    app = module.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    db = app.get(PrismaService);
    proveDatabase("loop-first-connect-before-seed");
    const databases = await db.$queryRaw<
      Array<{ file: string }>
    >`PRAGMA database_list`;
    expect(databases.map((row) => row.file).filter(Boolean)).toEqual([
      testDbGuard.ACTIVE_DB_PATH,
    ]);
    world = await seedImportWorld(db, `p08-loop-contract-${suiteRun}`);
    await app.listen(0, "127.0.0.1");
    const address: unknown = app.getHttpServer().address();
    const number = object(address).port;
    if (typeof number !== "number" || number <= 0)
      throw new Error("No ephemeral port");
    port = number;
    proveDatabase("loop-boot-before-request");
  });

  beforeEach(async () => {
    tick++;
    clock.current = new Date(FIXED_NOW.getTime() + tick * 61_000);
    jest.setSystemTime(clock.current);
    jest
      .mocked(primary.chat)
      .mockReset()
      .mockResolvedValue({ content: "Lote confirmado.", toolCalls: [] });
    jest
      .mocked(secondary.chat)
      .mockReset()
      .mockResolvedValue({ content: "Lote confirmado.", toolCalls: [] });
    jest
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("External fetch forbidden in P08 QA"));
    dispatch = jest.spyOn(app.get(AgentToolsService), "execute");
    await db.agentDailyQuota.updateMany({
      where: { tenantId: world.tenantId },
      data: { count: 0 },
    });
    await db.user.update({
      where: { id: world.users.owner.id },
      data: { sessionVersion: 0 },
    });
    const observationId = `p08-observation-${suiteRun}-${tick}`;
    draft = validationDraft(world.projects.casa);
    draft.lines = [draft.lines[2]!];
    draft.lines[0]!.observationIds = [observationId];
    draft.selectedLineIds = ["line-unknown"];
    draft.scope = { observationIds: [observationId], pendingAttachmentIds: [] };
    const session = await seedSession(db, world, {
      id: `p08-loop-session-${suiteRun}-${tick}`,
      state: "NEEDS_INPUT",
      draftJson: JSON.stringify(draft),
    });
    sessionId = session.id;
    const artifact = await db.importArtifact.create({
      data: {
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        documentSha256: createHash("sha256").update(sessionId).digest("hex"),
        verifiedBytes: 100,
        detectedFormat: "CSV",
        state: "EXTRACTED",
      },
    });
    attachmentId = (
      await db.importSessionArtifact.create({
        data: {
          tenantId: world.tenantId,
          ownerProjectId: world.projects.pessoal,
          sessionId,
          artifactId: artifact.id,
          position: 0,
          state: "ATTACHED",
          fileName: "synthetic.csv",
          declaredMime: "text/csv",
          declaredBytes: 100,
          reservedBytes: 0,
          verifiedAt: clock.current,
        },
      })
    ).id;
    await db.importObservation.create({
      data: {
        id: observationId,
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        artifactId: artifact.id,
        reference: "row-0",
        evidenceJson: JSON.stringify({
          version: 1,
          reference: "row-0",
          text: "Synthetic fixture",
          amountMeaning: "UNKNOWN",
          amountCents: null,
          installmentCount: null,
          installmentIndex: null,
          dataCompra: null,
          identity: {
            merchant: null,
            externalId: null,
            fitId: null,
            ordinal: 0,
            fileContentHash: "a".repeat(32),
          },
        }),
      },
    });
  });

  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await app?.close();
    jest.useRealTimers();
  });

  it.each([
    ["edit,forbidden", [edit, forbidden]],
    ["edit,edit", [edit, { ...edit, id: "edit-2" }]],
    ["edit,read", [edit, read]],
    ["read,forbidden", [read, forbidden]],
    ["read,edit,forbidden", [read, edit, forbidden]],
    [
      "read,read,edit,edit",
      [read, { ...read, id: "read-2" }, edit, { ...edit, id: "edit-2" }],
    ],
  ] satisfies Array<[string, ToolCall[]]>)(
    "preflights the ENTIRE batch [%s] before the first dispatch",
    async (_name, calls) => {
      const before = await snapshot();
      jest
        .mocked(primary.chat)
        .mockResolvedValueOnce({ content: "", toolCalls: calls });
      const result = await post(answer());
      expect(primary.chat).toHaveBeenCalledTimes(1);
      expect(dispatch).not.toHaveBeenCalled();
      expect(secondary.chat).not.toHaveBeenCalled();
      const outcome = object(object(result.json).importOutcome);
      expect([
        { status: 403, code: "TOOL_NOT_ALLOWED" },
        { status: 502, code: "MODEL_OUTPUT_INVALID" },
      ]).toContainEqual({ status: result.status, code: outcome.code });
      expect(outcome).toMatchObject({
        version: 1,
        turnId: TURN_ID,
        kind: "ERROR",
        acknowledgment: "NONE",
      });
      expect(Object.keys(object(result.json))).toEqual(["importOutcome"]);
      expect(await snapshot()).toEqual(before);
    },
  );

  it("rejects valid read prefix plus an invalid argument schema without dispatching either", async () => {
    jest.mocked(primary.chat).mockResolvedValueOnce({
      content: "",
      toolCalls: [
        read,
        { ...read, id: "read-2", arguments: { sessionId: "foreign-session" } },
      ],
    });
    const result = await post(answer());
    expect(primary.chat).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.status).toBe(502);
    expect(object(result.json).importOutcome).toMatchObject({
      kind: "ERROR",
      code: "MODEL_OUTPUT_INVALID",
      acknowledgment: "NONE",
    });
  });

  it.each([
    ["amountMeaning", []],
    ["amountCents", []],
    ["installmentCount", []],
    ["dataCompra", []],
    ["firstDueDate", []],
    ["targets", ["list_projects"]],
    ["decision", ["import_read_candidates"]],
    ["tipoDespesa", ["get_category_taxonomy"]],
    ["categoriaMaoDeObra", ["get_category_taxonomy"]],
  ] satisfies Array<[ImportSessionDraftQuestionV1["field"], string[]]>)(
    "offers the literal field allowlist for %s, including through fallback",
    async (field, additional) => {
      await focus(field);
      jest
        .mocked(primary.chat)
        .mockRejectedValueOnce(
          Object.assign(new Error("local unavailable"), { status: 503 }),
        );
      jest
        .mocked(secondary.chat)
        .mockRejectedValueOnce(
          new LlmResponseContractError("INVALID_RESPONSE"),
        );
      const result = await post(answer(field));
      expect(primary.chat).toHaveBeenCalledTimes(1);
      expect(secondary.chat).toHaveBeenCalledTimes(1);
      const first = jest.mocked(primary.chat).mock.calls[0]!;
      const second = jest.mocked(secondary.chat).mock.calls[0]!;
      expect(first[1].map((tool) => tool.name).sort()).toEqual(
        [
          "import_read_session",
          "import_read_observations",
          "list_payment_methods",
          "import_edit_answer",
          ...additional,
        ].sort(),
      );
      expect(first[2]).toEqual({ responseContract: "IMPORT_CHAT_V1" });
      expect(second[2]).toBe(first[2]);
      expect(second[1]).toBe(first[1]);
      expect(result.status).toBe(502);
      expect(object(result.json).importOutcome).toMatchObject({
        kind: "ERROR",
        code: "MODEL_OUTPUT_INVALID",
        acknowledgment: "NONE",
      });
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it.each(["ANSWER", "APPROVE_ATTACHMENT_SCOPE"] as const)(
    "%s ends after one logical edit attempt; no repair, prepare or extra model turn",
    async (intent) => {
      const before = await snapshot();
      jest
        .mocked(primary.chat)
        .mockResolvedValueOnce({ content: "", toolCalls: [read, ambiguous] })
        .mockResolvedValueOnce({ content: "", toolCalls: [forbidden] });
      const turn: ImportChatTurnV1 =
        intent === "ANSWER"
          ? answer()
          : {
              ...answer(),
              intent,
              focus: {
                id: "question-amount",
                field: "amountCents",
                lineIds: ["line-unknown"],
              },
              scope: {
                kind: "ATTACHMENT",
                attachmentId,
                approvedLineIds: ["line-unknown"],
              },
            };
      const result = await post(turn);
      expect(primary.chat).toHaveBeenCalledTimes(1);
      expect(dispatch.mock.calls.map(([name]) => name)).toEqual([
        "import_read_session",
        "import_edit_answer",
      ]);
      expect(result.status).toBe(201);
      expect(object(result.json).importOutcome).toEqual({
        version: 1,
        turnId: TURN_ID,
        ref: { sessionId, revision: 1 },
        kind: "CLARIFY",
        acknowledgment: "NONE",
        reason: "AMBIGUOUS",
        scopeReview: null,
      });
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each([
    "create_expense",
    "create_receipt",
    "create_recurring_expense",
    "check_price_monitor_item",
    "find_expenses",
    "constructor",
    "__proto__",
    "unknown_tool",
  ])(
    "AgentToolsService rejects %s before registry/catch and nested effects",
    async (name) => {
      const classify = jest.spyOn(
        app.get(MerchantClassifierService),
        "classifyBatch",
      );
      const create = jest.spyOn(app.get(ExpenseService), "create");
      jest
        .mocked(primary.chat)
        .mockResolvedValueOnce({ content: "", toolCalls: [read] })
        .mockImplementationOnce(async () => {
          const context = dispatch.mock.calls[0]?.[1];
          if (!context) throw new Error("No genuine contextual ToolContext");
          await expect(
            app.get(AgentToolsService).execute(name, context, {
              projectId: world.projects.pessoal,
              titulo: "Synthetic",
              valor: "206,96",
              tipoDespesa: "OUTROS",
            }),
          ).rejects.toMatchObject({ code: "TOOL_NOT_ALLOWED" });
          return { content: "", toolCalls: [ambiguous] };
        });
      const before = await snapshot();
      const result = await post(answer());
      expect(primary.chat).toHaveBeenCalledTimes(2);
      expect(classify).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
      expect(result.status).toBe(201);
      expect(object(result.json).importOutcome).toMatchObject({
        kind: "CLARIFY",
        acknowledgment: "NONE",
      });
    },
  );

  it("model call IDs are correlation only, not a session or auth selector", async () => {
    const foreignId = "not-the-admitted-session";
    jest
      .mocked(primary.chat)
      .mockResolvedValueOnce({
        content: "",
        toolCalls: [{ ...read, id: foreignId }],
      })
      .mockResolvedValueOnce({ content: "", toolCalls: [ambiguous] });
    const result = await post(answer());
    expect(primary.chat).toHaveBeenCalledTimes(2);
    const messages = jest.mocked(primary.chat).mock.calls[1]![0];
    expect(
      messages.find((message) => message.role === "tool")?.toolCallId,
    ).toBe(foreignId);
    expect(object(result.json).importOutcome).toMatchObject({
      ref: { sessionId, revision: 1 },
      acknowledgment: "NONE",
    });
    expect(dispatch.mock.calls[0]?.[1]).toMatchObject({
      tenantId: world.tenantId,
      userId: world.users.owner.id,
    });
  });

  it("the actual strict provider error is terminal in its real AgentService consumer", async () => {
    const provider = new OpenAiCompatibleProvider(
      "ollama",
      "synthetic-no-network",
    );
    const chat = jest.spyOn(provider, "chat");
    jest.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "read",
                    type: "function",
                    function: { name: "import_read_session", arguments: "{}" },
                  },
                  {
                    id: "bad",
                    type: "function",
                    function: { name: "import_edit_answer", arguments: "{" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        }),
        { status: 200 },
      ),
    );
    jest
      .mocked(primary.chat)
      .mockImplementation((messages, definitions, options) =>
        provider.chat(messages, definitions, options),
      );
    const result = await post(answer());
    expect(primary.chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0]?.[2]).toEqual({
      responseContract: "IMPORT_CHAT_V1",
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(secondary.chat).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.status).toBe(502);
    expect(object(result.json).importOutcome).toMatchObject({
      kind: "ERROR",
      code: "MODEL_OUTPUT_INVALID",
      acknowledgment: "NONE",
    });
  });

  it.each([
    ["CONTINUE", "TEXT"],
    ["CONTINUE", "VOICE"],
    ["READ_RESULT", "TEXT"],
    ["READ_RESULT", "VOICE"],
  ] as const)(
    "deterministic %s with available chat quota needs no model/config on %s",
    async (intent, channel) => {
      jest.spyOn(capability, "writesEnabled").mockReturnValue(false);
      jest.spyOn(fallback, "isConfigured").mockReturnValue(false);
      await db.agentDailyQuota.upsert({
        where: {
          tenantId_dayKey: {
            tenantId: world.tenantId,
            dayKey: clock.current.toISOString().slice(0, 10),
          },
        },
        create: {
          tenantId: world.tenantId,
          dayKey: clock.current.toISOString().slice(0, 10),
          count: 0,
        },
        update: { count: 0 },
      });
      const before = await snapshot();
      const result = await post(consult(intent, channel));
      expect(result.status).toBe(201);
      expect(object(result.json).importOutcome).toEqual({
        version: 1,
        turnId: TURN_ID,
        ref: { sessionId, revision: 1 },
        acknowledgment: "NONE",
        kind: intent === "CONTINUE" ? "QUESTION" : "READ_RESULT",
        ...(intent === "CONTINUE" ? { questionId: "question-amount" } : {}),
      });
      expect(primary.chat).not.toHaveBeenCalled();
      expect(secondary.chat).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
      expect(
        (await db.importSession.findUniqueOrThrow({ where: { id: sessionId } }))
          .receiptJson,
      ).toBeNull();
      expect(
        (
          await db.agentDailyQuota.findUniqueOrThrow({
            where: {
              tenantId_dayKey: {
                tenantId: world.tenantId,
                dayKey: clock.current.toISOString().slice(0, 10),
              },
            },
          })
        ).count,
      ).toBe(1);
    },
  );

  it.each(["TEXT", "VOICE"] as const)(
    "saturated chat quota rejects before handler; direct recovery remains authorized on %s",
    async (channel) => {
      jest.spyOn(capability, "writesEnabled").mockReturnValue(false);
      jest.spyOn(fallback, "isConfigured").mockReturnValue(false);
      const chat = jest.spyOn(app.get(AgentService), "chat");
      const before = await snapshot();
      const beforeQuota = await call("GET", `/import-sessions/${sessionId}`);
      expect(beforeQuota.status).toBe(200);
      const quotaKey = {
        tenantId: world.tenantId,
        dayKey: clock.current.toISOString().slice(0, 10),
      };
      await db.agentDailyQuota.upsert({
        where: { tenantId_dayKey: quotaKey },
        create: { ...quotaKey, count: 30 },
        update: { count: 30 },
      });
      for (const intent of ["CONTINUE", "READ_RESULT"] as const) {
        const result = await post(consult(intent, channel));
        expect(result.status).toBe(429);
        expect(object(result.json)).not.toHaveProperty("reply");
      }
      expect(chat).not.toHaveBeenCalled();
      const session = await call("GET", `/import-sessions/${sessionId}`);
      expect(session.status).toBe(200);
      expect(session.json).toEqual(beforeQuota.json);
      expect(session.json).toMatchObject({
        id: sessionId,
        state: "NEEDS_INPUT",
        revision: 1,
        receipt: null,
      });
      const questions = object(session.json).questions;
      if (!Array.isArray(questions))
        throw new Error("Expected questions array");
      const publicQuestions = questions.map(object);
      expect(publicQuestions).toHaveLength(6);
      const ids = publicQuestions.map((question) => question.id);
      for (const id of ids) {
        if (typeof id !== "string") throw new Error("Expected question ID");
        expect(id.trim()).not.toBe("");
      }
      expect(new Set(ids).size).toBe(6);
      expect(publicQuestions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "question-amount",
            field: "amountCents",
            lineIds: ["line-unknown"],
          }),
          ...[
            "dataCompra",
            "merchant",
            "amountMeaning",
            "installmentCount",
            "installmentIndex",
          ].map((field) =>
            expect.objectContaining({
              field,
              lineIds: ["line-unknown"],
              answerState: "UNANSWERED",
              subject: {
                kind: "OBSERVATION",
                observationId: draft.lines[0]!.observationIds[0],
                meaningContext: null,
              },
            }),
          ),
        ]),
      );
      const result = await call("GET", `/import-sessions/${sessionId}/result`);
      expect(result.status).toBe(200);
      expect(result.json).toEqual({ state: "NEEDS_INPUT", receipt: null });
      for (const suffix of ["", "/result"]) {
        const denied = await call(
          "GET",
          `/import-sessions/${sessionId}${suffix}`,
          undefined,
          world.users.peer.id,
        );
        expect(denied.status).toBe(404);
        expect(denied.json).toEqual({
          code: "NOT_FOUND",
          retryable: false,
          sessionId: null,
          currentRevision: null,
          reason: null,
        });
      }
      expect(primary.chat).not.toHaveBeenCalled();
      expect(secondary.chat).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
      expect(
        (
          await db.agentDailyQuota.findUniqueOrThrow({
            where: { tenantId_dayKey: quotaKey },
          })
        ).count,
      ).toBe(30);
    },
  );

  it.each(["TEXT", "VOICE"] as const)(
    "false_model_success_is_not_an_outcome: content without tools on %s",
    async (channel) => {
      const prose = "Ja lancei tudo";
      jest
        .mocked(primary.chat)
        .mockResolvedValue({ content: prose, toolCalls: [] });
      const before = await snapshot();
      const turn = answer("amountCents", channel);
      const result = await post(turn);
      expect(primary.chat).toHaveBeenCalledTimes(1);
      expect(secondary.chat).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(await snapshot()).toEqual(before);
      const response = object(result.json);
      const outcome = object(response.importOutcome);
      expect(["CLARIFY", "ERROR"]).toContain(outcome.kind);
      expect(outcome).toMatchObject({
        version: 1,
        turnId: TURN_ID,
        acknowledgment: "NONE",
      });
      if (outcome.kind === "CLARIFY") {
        expect(result.status).toBeGreaterThanOrEqual(200);
        expect(result.status).toBeLessThan(300);
        expect(outcome).toEqual({
          version: 1,
          turnId: TURN_ID,
          acknowledgment: "NONE",
          kind: "CLARIFY",
          ref: { sessionId, revision: 1 },
          reason: expect.any(String),
          scopeReview: null,
        });
        expect([
          "AMBIGUOUS",
          "INVALID_VALUE",
          "MULTI_FIELD",
          "UNSUPPORTED_NORMALIZATION",
          "INCOMPLETE_SCOPE",
        ]).toContain(outcome.reason);
        expect(typeof response.reply).toBe("string");
      } else {
        expect([
          400, 401, 403, 404, 409, 410, 422, 429, 500, 502, 503,
        ]).toContain(result.status);
        expect(Object.keys(response)).toEqual(["importOutcome"]);
        expect(outcome).toEqual({
          version: 1,
          turnId: TURN_ID,
          acknowledgment: "NONE",
          kind: "ERROR",
          ref: outcome.ref,
          code: expect.any(String),
          reason: outcome.reason,
          retryable: expect.any(Boolean),
          recovery: expect.any(String),
        });
        expect([
          "INVALID_INPUT",
          "UNAUTHENTICATED",
          "NOT_FOUND",
          "UI_ACTION_REQUIRED",
          "REVISION_CONFLICT",
          "IDEMPOTENCY_CONFLICT",
          "STALE_PREVIEW",
          "REVIEW_REQUIRED",
          "SEARCH_TOO_BROAD",
          "LIMIT_EXCEEDED",
          "UNSUPPORTED_DOCUMENT",
          "LEASE_CONFLICT",
          "RETRYABLE_WRITE_CONFLICT",
          "CAPABILITY_DISABLED",
          "SESSION_EXPIRED",
          "ALREADY_APPLIED",
          "PROVIDER_UNAVAILABLE",
          "MODEL_OUTPUT_INVALID",
          "TOOL_NOT_ALLOWED",
          "TURN_LIMIT",
          "INTERNAL_ERROR",
        ]).toContain(outcome.code);
        expect([
          null,
          "ATTACHMENT_IN_FLIGHT",
          "WRITE_BUDGET_EXCEEDED",
        ]).toContain(outcome.reason);
        expect([
          "READ_SESSION",
          "READ_RESULT",
          "REAUTHENTICATE",
          "NONE",
        ]).toContain(outcome.recovery);
        if (
          ["UNAUTHENTICATED", "UI_ACTION_REQUIRED", "NOT_FOUND"].includes(
            String(outcome.code),
          )
        ) {
          expect(outcome.ref).toBeNull();
        } else {
          expect([null, { sessionId, revision: 1 }]).toContainEqual(
            outcome.ref,
          );
        }
      }
      if (typeof response.reply === "string")
        expect(response.reply).not.toContain(prose);
    },
  );

  it("explicit OPEN_REVIEW with sim never opens an ineligible card or calls the model", async () => {
    jest.spyOn(capability, "writesEnabled").mockReturnValue(false);
    const before = await snapshot();
    const result = await post(consult("OPEN_REVIEW"));
    expect(result.status).toBe(503);
    expect(object(result.json).importOutcome).toMatchObject({
      version: 1,
      turnId: TURN_ID,
      kind: "ERROR",
      code: "CAPABILITY_DISABLED",
      acknowledgment: "NONE",
    });
    expect(primary.chat).not.toHaveBeenCalled();
    expect(secondary.chat).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(before);
  });

  it.each(["amountCents", "targets", "decision"] as const)(
    "focused sim on %s is identical in TEXT/VOICE: clarify, never prepare/confirm/execute",
    async (field) => {
      await focus(field);
      const before = await snapshot();
      jest.mocked(primary.chat).mockResolvedValue({
        content: "Lote confirmado.",
        toolCalls: [ambiguous],
      });
      const outcomes: unknown[] = [];
      for (const channel of ["TEXT", "VOICE"] as const) {
        const result = await post(answer(field, channel, "sim"));
        expect(result.status).toBe(201);
        expect(object(result.json).reply).not.toBe("Lote confirmado.");
        outcomes.push(object(result.json).importOutcome);
      }
      expect(outcomes).toEqual(
        Array(2).fill({
          version: 1,
          turnId: TURN_ID,
          ref: { sessionId, revision: 1 },
          kind: "CLARIFY",
          reason: "AMBIGUOUS",
          acknowledgment: "NONE",
          scopeReview: null,
        }),
      );
      expect(dispatch.mock.calls.map(([name]) => name)).toEqual([
        "import_edit_answer",
        "import_edit_answer",
      ]);
      expect(await snapshot()).toEqual(before);
    },
  );

  it("sim is never evidence for the model's acceptNaturalDuplicate:true", async () => {
    await focus("decision");
    const before = await snapshot();
    jest.mocked(primary.chat).mockResolvedValueOnce({
      content: "",
      toolCalls: [
        {
          id: "duplicate-opt-in",
          name: "import_edit_answer",
          arguments: {
            interpretation: {
              kind: "VALUE",
              field: "decision",
              evidence: { start: 0, end: 3 },
              value: { kind: "CREATE", acceptNaturalDuplicate: true },
            },
          },
        },
      ],
    });
    const result = await post(answer("decision", "TEXT", "sim"));
    expect(primary.chat).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(201);
    expect(object(result.json).importOutcome).toEqual({
      version: 1,
      turnId: TURN_ID,
      ref: { sessionId, revision: 1 },
      kind: "CLARIFY",
      reason: "AMBIGUOUS",
      acknowledgment: "NONE",
      scopeReview: null,
    });
    expect(await snapshot()).toEqual(before);
  });

  it.each([
    ["sv", 401, "UNAUTHENTICATED"],
    ["owner", 404, "NOT_FOUND"],
  ] as const)(
    "admitted %s drift is opaque and never a 200 acknowledgment",
    async (drift, status, code) => {
      jest.mocked(primary.chat).mockImplementationOnce(async () => {
        if (drift === "sv") {
          await db.user.update({
            where: { id: world.users.owner.id },
            data: { sessionVersion: 1 },
          });
        } else {
          await db.importSession.update({
            where: { id: sessionId },
            data: { ownerUserId: world.users.peer.id },
          });
        }
        return { content: "Editei e preparei tudo.", toolCalls: [ambiguous] };
      });
      const result = await post(answer());
      expect(primary.chat).toHaveBeenCalledTimes(1);
      expect(result.status).toBe(status);
      expect(Object.keys(object(result.json))).toEqual(["importOutcome"]);
      expect(object(result.json).importOutcome).toMatchObject({
        version: 1,
        turnId: TURN_ID,
        kind: "ERROR",
        code,
        acknowledgment: "NONE",
        ref: null,
      });
      expect(secondary.chat).not.toHaveBeenCalled();
    },
  );

  it("iteration limit returns TURN_LIMIT without the generic final prose call", async () => {
    jest
      .mocked(primary.chat)
      .mockResolvedValue({ content: "", toolCalls: [read] });
    const result = await post(answer());
    expect(primary.chat).toHaveBeenCalledTimes(12);
    expect(
      jest.mocked(primary.chat).mock.calls.every((call) => call[1].length > 0),
    ).toBe(true);
    expect(result.status).toBe(502);
    expect(object(result.json).importOutcome).toMatchObject({
      kind: "ERROR",
      code: "TURN_LIMIT",
      acknowledgment: "NONE",
    });
  });

  describe("F1 publication reauthorization", () => {
    function barrier() {
      let release!: () => void;
      const reached = new Promise<void>((resolveBarrier) => {
        release = resolveBarrier;
      });
      return { reached, release };
    }

    async function requireBoundary(
      boundary: Promise<void>,
      response: ReturnType<typeof post>,
    ) {
      await Promise.race([
        boundary,
        response.then((result) => {
          throw new Error(
            `HTTP ${result.status} completed before the controlled boundary`,
          );
        }),
      ]);
    }

    it.each([
      ["sv", "strict", 401, "UNAUTHENTICATED", false, "REAUTHENTICATE"],
      ["sv", "prose", 401, "UNAUTHENTICATED", false, "REAUTHENTICATE"],
      ["sv", "unavailable", 401, "UNAUTHENTICATED", false, "REAUTHENTICATE"],
      ["owner", "strict", 404, "NOT_FOUND", false, "NONE"],
      ["owner", "prose", 404, "NOT_FOUND", false, "NONE"],
      ["owner", "unavailable", 404, "NOT_FOUND", false, "NONE"],
      ["none", "strict", 502, "MODEL_OUTPUT_INVALID", false, "READ_SESSION"],
      ["none", "prose", 502, "MODEL_OUTPUT_INVALID", false, "READ_SESSION"],
      [
        "none",
        "unavailable",
        503,
        "PROVIDER_UNAVAILABLE",
        true,
        "READ_SESSION",
      ],
    ] as const)(
      "%s drift with %s termination preserves the current publication boundary",
      async (drift, termination, status, code, retryable, recovery) => {
        const entered = barrier();
        const resume = barrier();
        jest.mocked(primary.chat).mockImplementationOnce(async () => {
          entered.release();
          await resume.reached;
          if (termination === "strict")
            throw new LlmResponseContractError("INVALID_RESPONSE");
          if (termination === "unavailable") throw new RateLimitError();
          return { content: "Ja lancei tudo", toolCalls: [] };
        });
        const before = await snapshot();
        const pending = post(answer());
        await requireBoundary(entered.reached, pending);
        let expectedAfterDrift = before;
        try {
          expect(dispatch).not.toHaveBeenCalled();
          if (drift === "sv") {
            await db.user.update({
              where: { id: world.users.owner.id },
              data: { sessionVersion: 1 },
            });
          } else if (drift === "owner") {
            await db.importSession.update({
              where: { id: sessionId },
              data: { ownerUserId: world.users.peer.id },
            });
          }
          expectedAfterDrift = await snapshot();
          expect(expectedAfterDrift.session.draftJson).toBe(
            before.session.draftJson,
          );
        } finally {
          resume.release();
        }
        const result = await pending;
        expect(await snapshot()).toEqual(expectedAfterDrift);
        expect(dispatch).not.toHaveBeenCalled();
        expect(primary.chat).toHaveBeenCalledTimes(1);
        expect(jest.mocked(primary.chat).mock.calls[0]?.[2]).toEqual({
          responseContract: "IMPORT_CHAT_V1",
        });
        expect(secondary.chat).not.toHaveBeenCalled();
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(result).toEqual({
          status,
          json: {
            importOutcome: {
              version: 1,
              turnId: TURN_ID,
              kind: "ERROR",
              code,
              ref: drift === "none" ? { sessionId, revision: 1 } : null,
              reason: null,
              retryable,
              recovery,
              acknowledgment: "NONE",
            },
          },
        });
      },
    );

    it("reauthorizes the prewrapped TURN_LIMIT after the last real read", async () => {
      const lastRead = barrier();
      const resume = barrier();
      const bridge = app.get(ImportChatBridge);
      const actualRead = bridge.read.bind(bridge);
      let completedReads = 0;
      jest.spyOn(bridge, "read").mockImplementation(async (...args) => {
        const result = await actualRead(...args);
        completedReads++;
        // The initial session read precedes twelve model-requested reads.
        if (completedReads === 13) {
          lastRead.release();
          await resume.reached;
        }
        return result;
      });
      jest
        .mocked(primary.chat)
        .mockResolvedValue({ content: "", toolCalls: [read] });
      const before = await snapshot();
      const pending = post(answer());
      await requireBoundary(lastRead.reached, pending);
      try {
        expect(completedReads).toBe(13);
        expect(primary.chat).toHaveBeenCalledTimes(12);
        await db.user.update({
          where: { id: world.users.owner.id },
          data: { sessionVersion: 1 },
        });
      } finally {
        resume.release();
      }
      const result = await pending;
      expect(await snapshot()).toEqual(before);
      expect(completedReads).toBe(13);
      expect(dispatch).toHaveBeenCalledTimes(12);
      expect(dispatch.mock.calls.map(([name]) => name)).toEqual(
        Array.from({ length: 12 }, () => "import_read_session"),
      );
      expect(primary.chat).toHaveBeenCalledTimes(12);
      expect(secondary.chat).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
      expect(result).toEqual({
        status: 401,
        json: {
          importOutcome: {
            version: 1,
            turnId: TURN_ID,
            kind: "ERROR",
            code: "UNAUTHENTICATED",
            ref: null,
            reason: null,
            retryable: false,
            recovery: "REAUTHENTICATE",
            acknowledgment: "NONE",
          },
        },
      });
    });
  });
});
