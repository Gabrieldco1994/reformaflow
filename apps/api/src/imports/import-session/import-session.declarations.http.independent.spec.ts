const dbGuard: {
  REPO_ROOT: string;
  ACTIVE_DB_PATH: string;
} = require("../../../../../scripts/test-db-env.cjs");

import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import { resolve } from "node:path";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { SchedulerRegistry } from "@nestjs/schedule";
import { Test } from "@nestjs/testing";
import type { Prisma } from "@prisma/client";
import {
  ExpenseType,
  type ImportChatOutcomeV1,
  type ImportSessionDraftLineV1,
  type ImportSessionQuestionV1,
  type ImportSessionReceiptV1,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import cookieParser from "cookie-parser";
import { AuthService } from "../../auth/auth.service";
import {
  LLM_PROVIDER,
  type LlmChatResult,
  type LlmProvider,
} from "../../agent/llm/llm.types";
import * as keys from "../../credit-card/parsers/dedupe-key";
import * as crossOrigin from "../../import-dedupe/cross-origin-dedupe";
import * as cardIdentity from "../../credit-card/card-purchase-identity";
import { validateDocumentExtraction } from "../../credit-card/parsers/statement-document";
import { parseStoredExpenseSchedule } from "../../expense/documented-schedule";
import { PrismaService } from "../../prisma/prisma.service";
import {
  MutableClock,
  SEVEN_DAYS_MS,
  seedImportWorld,
  seedSession,
  type ImportWorld,
} from "../../test-utils/import-session-harness";
import {
  IMPORT_SESSION_CAPABILITY,
  IMPORT_SESSION_CLOCK,
  type ImportSessionCapability,
} from "./import-session.capability";
import { IMPORT_SESSION_UI_ORIGINS } from "./import-session-ui.guard";
import { parseStoredDraft } from "./import-session.projection";
import { parseStoredImportSearch } from "./import-session.search";
import {
  buildImportMaterialization,
  importFileContentHash,
} from "./import-session.extraction";
import type { StoredImportObservationEvidenceV1 } from "./import-session.observation";
import * as writer from "./import-session.writer";

// Expected wire from TYPE turn9, not a producer or a substitute for the domain helper.
type Field =
  | "dataCompra"
  | "merchant"
  | "amountMeaning"
  | "amountCents"
  | "installmentCount"
  | "installmentIndex";
type Meaning = "TOTAL_PURCHASE" | "INSTALLMENT_CHARGE";
type DocumentaryQuestion = {
  id: string;
  lineIds: [string];
  field: Field;
  text: string;
  subject: {
    kind: "OBSERVATION";
    observationId: string;
    meaningContext: Meaning | null;
  };
  answerState: "UNANSWERED" | "DECLARED" | "UNKNOWN";
};
type Fact = {
  lineId: string;
  observationId: string;
  questionId: string;
  field: Field;
  value: string | number | null;
  meaningContext: Meaning | null;
  origin: "USER_ATTESTATION";
  status: "CURRENT" | "UNKNOWN" | "CONTEXT_CHANGED";
};
type View = Omit<ImportSessionViewV1, "questions" | "reviewBlockers"> & {
  questions: Array<ImportSessionQuestionV1 | DocumentaryQuestion>;
  declaredFacts: Fact[];
  reviewBlockers: Array<{
    lineId: string;
    code: "ORIGINAL_IDENTITY_INCOMPLETE" | "ORIGINAL_OCCURRENCE_INCOMPLETE";
    resolution:
      | "NEEDS_DECLARATION"
      | "RESOLVED_BY_USER"
      | "SEARCH_IDENTITY_UNAVAILABLE";
  }>;
};
type Reply<T> = { status: number; body: T };
const NOW = new Date("2026-10-08T12:30:00.000Z");
const UI_HEADERS = { origin: "http://localhost:3000", "x-rf-import-ui": "1" };
const clock = new MutableClock(NOW);
const evidenceRoot =
  process.env.B3_QA_EVIDENCE ??
  resolve(dbGuard.REPO_ROOT, ".agents/b3-contract-evidence");
mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
const evidenceDir = mkdtempSync(resolve(evidenceRoot, "http-"));
const originalBytes = Buffer.from(
  "Synthetic B3 purchase; original date absent",
);
const hash = (text: string) =>
  crypto.createHash("sha256").update(text).digest("hex");

function proveDb(label: string) {
  expect(process.env.DATABASE_URL).toBe(`file:${dbGuard.ACTIVE_DB_PATH}`);
  const raw = execFileSync(
    "lsof",
    ["-nP", "-a", "-p", String(process.pid), "-Fn"],
    {
      encoding: "utf8",
    },
  );
  writeFileSync(resolve(evidenceDir, `${label}.lsof`), raw, {
    flag: "wx",
    mode: 0o600,
  });
  const databases = raw
    .split("\n")
    .filter((line) => /^n.*\.(db|sqlite3?)(-(wal|shm|journal))?$/.test(line))
    .map((line) => line.slice(1));
  expect(databases).toContain(dbGuard.ACTIVE_DB_PATH);
  expect(
    databases.filter(
      (name) =>
        ![
          dbGuard.ACTIVE_DB_PATH,
          `${dbGuard.ACTIVE_DB_PATH}-wal`,
          `${dbGuard.ACTIVE_DB_PATH}-shm`,
          `${dbGuard.ACTIVE_DB_PATH}-journal`,
        ].includes(name),
    ),
  ).toEqual([]);
}

describe("B3 independent HTTP producer on real AppModule (local/inactive)", () => {
  let app: INestApplication;
  let db: PrismaService;
  let port: number;
  let world: ImportWorld;
  let sessionId: string;
  let token: string;
  let observations: string[];
  let sequence = 0;
  let enabled = true;
  let nextModel: LlmChatResult;
  const modelChat = jest.fn<
    ReturnType<LlmProvider["chat"]>,
    Parameters<LlmProvider["chat"]>
  >();
  const savedEnv = new Map<string, string | undefined>();
  const events: Array<{ model: string | undefined; action: string }> = [];
  const envKeys = [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GROQ_API_KEY",
    "CEREBRAS_API_KEY",
    "OLLAMA_API_KEY",
    "AGENT_LLM_PROVIDER",
    "AGENT_LLM_FALLBACK",
    "JWT_SECRET",
    "VIBEVOICE_WS_URL",
  ];

  beforeAll(async () => {
    for (const key of envKeys) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.JWT_SECRET = "synthetic-b3-contract-only-not-a-credential";
    process.env.AGENT_LLM_PROVIDER = "ollama";
    jest.useFakeTimers({
      now: NOW,
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
    const { AppModule } = await import("../../app.module");
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IMPORT_SESSION_CLOCK)
      .useValue(clock)
      .overrideProvider(IMPORT_SESSION_CAPABILITY)
      .useValue({
        writesEnabled: () => enabled,
        newImportFormats: () => [],
      } satisfies ImportSessionCapability)
      .overrideProvider(IMPORT_SESSION_UI_ORIGINS)
      .useValue({ allowed: () => [UI_HEADERS.origin] })
      .overrideProvider(LLM_PROVIDER)
      .useValue({
        id: "synthetic-b3-protocol",
        isConfigured: () => true,
        chat: modelChat,
      } satisfies LlmProvider)
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
    db = app.get(PrismaService);
    await db.$connect();
    proveDb("connected-before-init-seed-listen");
    expect(
      (await db.$queryRaw<Array<{ file: string }>>`PRAGMA database_list`)
        .map((row) => row.file)
        .filter(Boolean),
    ).toEqual([dbGuard.ACTIVE_DB_PATH]);
    await app.init();
    for (const job of app.get(SchedulerRegistry).getCronJobs().values())
      job.stop();
    proveDb("initialized-before-seed-listen");
    db.$use(async (params, next) => {
      events.push({ model: params.model, action: params.action });
      return next(params);
    });
    await app.listen(0, "127.0.0.1");
    const address: unknown = app.getHttpServer().address();
    if (
      !address ||
      typeof address !== "object" ||
      !("port" in address) ||
      typeof address.port !== "number"
    )
      throw new Error("No own loopback port");
    port = address.port;
    expect((await call("GET", "/auth/me", undefined, "")).status).toBe(401);
  });
  beforeEach(async () => {
    enabled = true;
    sequence++;
    clock.current = new Date(NOW);
    jest.setSystemTime(clock.current);
    jest
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("External fetch forbidden"));
    modelChat.mockReset().mockImplementation(async () => nextModel);
    world = await seedImportWorld(db, `b3-http-${process.pid}-${sequence}`);
    await db.user.updateMany({
      where: { tenantId: world.tenantId },
      data: { lastActivityAt: clock.now() },
    });
    await db.creditCard.update({
      where: { id: world.cards.pessoal },
      data: { closingDay: 27, dueDay: 5 },
    });
    token = await app.get(AuthService).issueToken(
      await db.user.findUniqueOrThrow({
        where: { id: world.users.owner.id },
      }),
    );
    const row = await seedSession(db, world, {
      consentedAt: clock.now(),
      lastUserEditAt: clock.now(),
      expiresAt: new Date(clock.now().getTime() + SEVEN_DAYS_MS),
    });
    sessionId = row.id;
    observations = [];
  });
  afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await app?.close();
    jest.useRealTimers();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function call<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    auth = token,
    headers: Record<string, string> = UI_HEADERS,
  ): Promise<Reply<T>> {
    return new Promise((done, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const request = http.request(
        {
          hostname: "127.0.0.1",
          port,
          method,
          path,
          headers: {
            ...headers,
            "x-forwarded-for": `127.0.0.${sequence + 1}`,
            ...(auth ? { authorization: `Bearer ${auth}` } : {}),
            ...(payload === undefined
              ? {}
              : {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(payload),
                }),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () => {
            try {
              done({
                status: response.statusCode ?? 0,
                body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on("error", reject);
      request.end(payload);
    });
  }
  const row = () =>
    db.importSession.findUniqueOrThrow({ where: { id: sessionId } });
  async function view(id = sessionId): Promise<View> {
    const response = await call<View>("GET", `/import-sessions/${id}`);
    expect(response.status).toBe(200);
    return response.body;
  }
  async function finances() {
    const where = () => ({ tenantId: world.tenantId });
    return {
      expenses: await db.expense.findMany({
        where: where(),
        orderBy: { id: "asc" },
      }),
      cash: await db.cashFlowEntry.findMany({
        where: where(),
        orderBy: { id: "asc" },
      }),
      receipts: await db.receipt.findMany({
        where: where(),
        orderBy: { id: "asc" },
      }),
      allocations: await db.rateioAllocation.findMany({
        where: where(),
        orderBy: { id: "asc" },
      }),
      settlements: await db.crossProjectSettlement.findMany({
        where: where(),
        orderBy: { id: "asc" },
      }),
      adjustments: await db.invoiceAdjustment.findMany({
        where: where(),
        orderBy: { id: "asc" },
      }),
      bankImports: await db.bankStatementImport.findMany({ where: where() }),
      cardImports: await db.creditCardStatementImport.findMany({
        where: where(),
      }),
    };
  }
  async function originals() {
    return {
      observations: await db.importObservation.findMany({
        where: { tenantId: world.tenantId },
        orderBy: { id: "asc" },
      }),
      artifacts: (
        await db.importArtifact.findMany({
          where: { tenantId: world.tenantId },
          orderBy: { id: "asc" },
        })
      ).map(({ id, documentSha256, extractionJson }) => ({
        id,
        documentSha256,
        extractionJson,
      })),
    };
  }
  async function document(
    changes: Partial<StoredImportObservationEvidenceV1> = {},
    identityChanges: Partial<
      StoredImportObservationEvidenceV1["identity"]
    > = {},
  ) {
    const index = observations.length;
    // These bytes describe the original fixture, before any authenticated ANSWER.
    const documentBytes =
      changes.dataCompra === undefined || changes.dataCompra === null
        ? originalBytes
        : Buffer.from(
            `Synthetic B3 purchase; original date ${changes.dataCompra}`,
          );
    const documentSha =
      index === 0
        ? crypto.createHash("sha256").update(documentBytes).digest("hex")
        : hash(`Synthetic B3 artifact ${index}`);
    const evidence: StoredImportObservationEvidenceV1 = {
      version: 1,
      reference: `csv:record:${index + 2}`,
      text: "Synthetic B3 purchase",
      dataCompra: null,
      amountMeaning: "TOTAL_PURCHASE",
      amountCents: 60000,
      installmentCount: 3,
      installmentIndex: null,
      ...changes,
      identity: {
        merchant: "Synthetic B3 purchase",
        ordinal:
          (changes.dataCompra ?? null) !== null &&
          changes.amountCents !== null &&
          identityChanges.merchant !== null
            ? 0
            : null,
        externalId: null,
        fitId: null,
        fileContentHash: importFileContentHash(documentSha),
        ...identityChanges,
      },
    };
    const extraction = validateDocumentExtraction({
      version: 1,
      parserVersion: "card-local-text-v1",
      documentKind: "UNKNOWN",
      invoiceDueMonth: null,
      metrics: {
        pages: 0,
        rows: 1,
        expandedBytes: 0,
        archiveEntries: 0,
        imagePixels: 0,
        frames: 0,
      },
      occurrences: [
        {
          reference: evidence.reference,
          sourceOrdinal: 0,
          section: "UNKNOWN",
          raw: {
            date: evidence.dataCompra,
            description: evidence.text,
            amount: null,
            installment: null,
          },
          cycle: null,
          dateOnly: evidence.dataCompra,
          merchant: evidence.identity.merchant,
          amountCents: evidence.amountCents,
          amountMeaning: evidence.amountMeaning,
          installmentCount: evidence.installmentCount,
          installmentIndex: evidence.installmentIndex,
          fitId: evidence.identity.fitId,
          identityOrdinal: evidence.identity.ordinal,
        },
      ],
      diagnostics: [],
    });
    const artifact = await db.importArtifact.create({
      data: {
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        documentSha256: documentSha,
        verifiedBytes: documentBytes.length,
        detectedFormat: "CSV",
        state: "EXTRACTED",
        parserVersion: extraction.parserVersion,
        extractionJson: JSON.stringify(extraction),
      },
    });
    const attachment = await db.importSessionArtifact.create({
      data: {
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        sessionId,
        artifactId: artifact.id,
        position: index,
        state: "ATTACHED",
        fileName: `synthetic-${index}.csv`,
        declaredMime: "text/csv",
        declaredBytes: documentBytes.length,
        reservedBytes: documentBytes.length,
        verifiedAt: clock.now(),
      },
    });
    const observation = await db.importObservation.create({
      data: {
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        artifactId: artifact.id,
        reference: evidence.reference,
        evidenceJson: JSON.stringify(evidence),
      },
    });
    observations.push(observation.id);
    const current = await row();
    const draft = parseStoredDraft(current.draftJson);
    const line: ImportSessionDraftLineV1 = {
      id: `purchase-${index}`,
      observationIds: [observation.id],
      titulo: "Synthetic B3 purchase",
      fornecedor: "Synthetic B3 purchase",
      tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
      categoriaMaoDeObra: null,
      amountMeaning: "TOTAL_PURCHASE",
      amountCents: 60000,
      installmentCount: 3,
      dataCompra: evidence.dataCompra ?? "2026-09-25",
      firstDueDate: "2026-11-05",
      targets: [],
      decision: { kind: "CREATE", acceptNaturalDuplicate: false },
    };
    draft.lines.push(line);
    draft.selectedLineIds.push(line.id);
    draft.scope.observationIds.push(observation.id);
    await db.importSession.update({
      where: { id: sessionId },
      data: { draftJson: JSON.stringify(draft) },
    });
    return { evidence, extraction, artifact, attachment, observation, line };
  }
  function question(
    v: View,
    field: Field,
    observationId = observations[0],
  ): DocumentaryQuestion {
    const found = v.questions.find(
      (q): q is DocumentaryQuestion =>
        "subject" in q &&
        q.subject.observationId === observationId &&
        q.field === field,
    );
    expect({ field, observationId, producerQuestion: found }).toEqual({
      field,
      observationId,
      producerQuestion: expect.objectContaining({
        id: expect.stringMatching(/^oq_[0-9a-f]{64}$/),
        field,
        subject: expect.objectContaining({
          kind: "OBSERVATION",
          observationId,
        }),
      }),
    });
    if (!found) throw new Error("Documentary question producer absent");
    expect(found.lineIds).toHaveLength(1);
    expect(Object.keys(found).sort()).toEqual(
      ["id", "lineIds", "field", "text", "subject", "answerState"].sort(),
    );
    return found;
  }
  function answerBody(v: View, q: DocumentaryQuestion, literal: string) {
    return {
      messages: [{ role: "user", content: literal }],
      importTurn: {
        version: 1,
        turnId: crypto.randomUUID(),
        sessionId: v.id,
        expectedRevision: v.revision,
        channel: "TEXT",
        literalAnswer: literal,
        intent: "ANSWER",
        focus: { id: q.id, field: q.field, lineIds: q.lineIds },
        scope: { kind: "LINES", lineIds: q.lineIds },
      },
    };
  }
  function modelValue(field: Field, literal: string, value: unknown) {
    const span = { start: 0, end: literal.length };
    nextModel = {
      content: "",
      toolCalls: [
        {
          id: "synthetic-tool-call",
          name: "import_edit_answer",
          arguments: {
            interpretation: {
              kind: "VALUE",
              field,
              evidence: span,
              value:
                field === "amountCents" && value !== null
                  ? { span, text: literal }
                  : value,
            },
          },
        },
      ],
    };
  }
  async function answer(
    v: View,
    field: Field,
    literal: string,
    value: unknown,
    observationId = observations[0],
  ) {
    const q = question(v, field, observationId);
    modelValue(field, literal, value);
    const body = answerBody(v, q, literal);
    const response = await call<{ importOutcome: ImportChatOutcomeV1 }>(
      "POST",
      "/agent/chat",
      body,
    );
    expect(response.status).toBe(201);
    return { outcome: response.body.importOutcome, body, q };
  }
  async function save(
    v: View,
    field: Field,
    literal: string,
    value: string | number | null,
    observationId = observations[0],
  ) {
    const financialBefore = await finances();
    const immutableBefore = await originals();
    const result = await answer(v, field, literal, value, observationId);
    expect(result.outcome).toMatchObject({
      kind: "REVISED_SESSION",
      acknowledgment: "EDITED",
      ref: { sessionId: v.id, revision: v.revision + 1 },
    });
    const after = await view(v.id);
    expect(after.declaredFacts).toContainEqual({
      lineId: result.q.lineIds[0],
      observationId,
      questionId: result.q.id,
      field,
      value,
      meaningContext: result.q.subject.meaningContext,
      origin: "USER_ATTESTATION",
      status: value === null ? "UNKNOWN" : "CURRENT",
    });
    expect(await originals()).toEqual(immutableBefore);
    expect(await finances()).toEqual(financialBefore);
    return after;
  }
  async function prepare(v: View) {
    const financialBefore = await finances();
    const response = await call<View>(
      "POST",
      `/import-sessions/${v.id}/prepare`,
      { expectedRevision: v.revision },
    );
    expect(response.status).toBe(200);
    expect(await finances()).toEqual(financialBefore);
    return response.body;
  }
  async function confirm(v: View) {
    expect(v.proposal).not.toBeNull();
    if (!v.proposal) throw new Error("No proposal to confirm");
    const lot = await call<{ confirmationHash: string }>(
      "GET",
      `/import-sessions/${v.id}/current-lot`,
    );
    expect(lot.status).toBe(200);
    const c = await call<{ nonce: string }>(
      "POST",
      `/import-sessions/${v.id}/confirmation-challenge`,
      {
        expectedRevision: v.revision,
        confirmationHash: lot.body.confirmationHash,
      },
    );
    expect(c.status).toBe(200);
    const body = {
      expectedRevision: v.revision,
      confirmationHash: lot.body.confirmationHash,
      financialRequestId: crypto.randomUUID(),
      nonce: c.body.nonce,
    };
    const financialBefore = await finances();
    expect(
      (await call("POST", `/import-sessions/${v.id}/confirm`, body)).status,
    ).toBe(200);
    expect(await finances()).toEqual(financialBefore);
    return { financialRequestId: body.financialRequestId };
  }

  it("legacy draft edits never mint attestation and fullview alone gains declaredFacts", async () => {
    const f = await document();
    const before = await originals();
    const current = await view();
    const patch = await call<View>(
      "PATCH",
      `/import-sessions/${sessionId}/draft`,
      {
        expectedRevision: current.revision,
        questionId: null,
        replaceLines: [
          {
            ...f.line,
            fornecedor: "Human draft title",
            dataCompra: "2026-10-01",
          },
        ],
        selectedLineIds: [f.line.id],
      },
    );
    expect(patch.status).toBe(200);
    expect(Object.keys(patch.body).sort()).toEqual(
      [
        "version",
        "id",
        "ownerProjectId",
        "cardId",
        "state",
        "revision",
        "expiresAt",
        "lines",
        "selectedLineIds",
        "questions",
        "declaredFacts",
        "reviewBlockers",
        "attachments",
        "searchComplete",
        "proposal",
        "confirmation",
        "receipt",
        "actions",
      ].sort(),
    );
    expect(patch.body.declaredFacts).toEqual([]);
    expect(parseStoredDraft((await row()).draftJson)).not.toHaveProperty(
      "declarations",
    );
    expect(await originals()).toEqual(before);
    expect(patch.body.reviewBlockers).toEqual([
      {
        lineId: f.line.id,
        code: "ORIGINAL_IDENTITY_INCOMPLETE",
        resolution: "NEEDS_DECLARATION",
      },
    ]);
    const list = await call<{ items: unknown[] }>("GET", "/import-sessions");
    expect(list.status).toBe(200);
    for (const item of list.body.items) {
      expect(item).not.toHaveProperty("declaredFacts");
      expect(item).not.toHaveProperty("declarations");
    }
    const obs = await call<{ items: Array<Record<string, unknown>> }>(
      "GET",
      `/import-sessions/${sessionId}/observations`,
    );
    expect(obs.status).toBe(200);
    expect(obs.body.items).toHaveLength(1);
    expect(Object.keys(obs.body.items[0]).sort()).toEqual(
      [
        "id",
        "attachmentId",
        "reference",
        "text",
        "amountMeaning",
        "amountCents",
        "installmentCount",
        "installmentIndex",
        "dataCompra",
      ].sort(),
    );
  });

  it("PATCH and authority-shaped ANSWER input fail closed without financial effects", async () => {
    await document();
    const before = await row();
    const financialBefore = await finances();
    const patch = await call("PATCH", `/import-sessions/${sessionId}/draft`, {
      expectedRevision: before.revision,
      questionId: null,
      replaceLines: [],
      selectedLineIds: ["purchase-0"],
      declarations: { version: 1, items: [] },
    });
    expect(patch.status).toBe(400);
    const forged = await call("POST", "/agent/chat", {
      messages: [{ role: "user", content: "25/09/2026" }],
      importTurn: {
        version: 1,
        turnId: crypto.randomUUID(),
        sessionId,
        expectedRevision: before.revision,
        channel: "TEXT",
        literalAnswer: "25/09/2026",
        intent: "ANSWER",
        focus: {
          id: "oq_forged",
          field: "dataCompra",
          lineIds: ["purchase-0"],
          subject: { kind: "OBSERVATION", observationId: observations[0] },
        },
        scope: { kind: "LINES", lineIds: ["purchase-0"] },
        attestedByUserId: world.users.owner.id,
        confirmed: true,
      },
    });
    expect(forged.status).toBe(400);
    expect(await row()).toEqual(before);
    expect(await finances()).toEqual(financialBefore);
    expect(modelChat).not.toHaveBeenCalled();
  });

  it("GET before PREPARE derives stable questions without writes, UUIDs or financial queries", async () => {
    await document({ dataCompra: "2026-09-25", amountMeaning: "UNKNOWN" });
    const before = await row();
    const uuid = jest.spyOn(
      jest.requireActual<typeof crypto>("node:crypto"),
      "randomUUID",
    );
    events.length = 0;
    const first = await view();
    const second = await view();
    expect(second).toEqual(first);
    expect(
      events.filter((event) =>
        /^(create|update|delete|upsert|executeRaw)/.test(event.action),
      ),
    ).toEqual([]);
    expect(
      events.filter((event) =>
        ["Expense", "Receipt", "CashFlowEntry", "RateioAllocation"].includes(
          event.model ?? "",
        ),
      ),
    ).toEqual([]);
    expect(uuid).not.toHaveBeenCalled();
    expect(await row()).toEqual(before);
    expect(question(first, "amountMeaning").answerState).toBe("UNANSWERED");
    expect(first.declaredFacts).toEqual([]);
    expect(first.actions).not.toContain("PREPARE");
    const updated = await save(
      first,
      "amountMeaning",
      "total da compra",
      "TOTAL_PURCHASE",
    );
    expect(updated.actions).toContain("PREPARE");
    expect((await prepare(updated)).state).toBe("READY");
  });

  it("multiple answers are one-observation scoped; correction preserves siblings; NO_CHANGE preserves metadata", async () => {
    await document();
    await document();
    let current = await save(
      await view(),
      "dataCompra",
      "25/09/2026",
      "2026-09-25",
    );
    expect(question(current, "dataCompra", observations[1]).answerState).toBe(
      "UNANSWERED",
    );
    current = await save(
      current,
      "dataCompra",
      "25/09/2026",
      "2026-09-25",
      observations[1],
    );
    const before = await row();
    const stored = JSON.parse(before.draftJson);
    expect(stored.declarations.items).toHaveLength(2);
    const first = stored.declarations.items.find(
      (item: { observationId: string }) =>
        item.observationId === observations[0],
    );
    expect(first).toMatchObject({
      lineId: "purchase-0",
      originSessionId: sessionId,
      observationId: observations[0],
      claimVersion: 0,
      recordedRevision: 2,
      attestedByUserId: world.users.owner.id,
      attestedAt: clock.now().toISOString(),
      literalHash: hash("25/09/2026"),
      originalFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    clock.current = new Date(clock.now().getTime() + 60_000);
    const repeat = await answer(
      current,
      "dataCompra",
      "25/09/2026",
      "2026-09-25",
    );
    expect(repeat.outcome).toMatchObject({ acknowledgment: "NO_CHANGE" });
    expect(await row()).toEqual(before);
    const corrected = await save(
      await view(),
      "dataCompra",
      "26/09/2026",
      "2026-09-26",
    );
    expect(
      corrected.declaredFacts.find(
        (fact) => fact.observationId === observations[1],
      ),
    ).toEqual(
      current.declaredFacts.find(
        (fact) => fact.observationId === observations[1],
      ),
    );
    const nowStored = JSON.parse((await row()).draftJson);
    expect(nowStored.declarations.items).toHaveLength(2);
    expect(
      nowStored.declarations.items.find(
        (item: { observationId: string }) =>
          item.observationId === observations[1],
      ),
    ).toEqual(
      stored.declarations.items.find(
        (item: { observationId: string }) =>
          item.observationId === observations[1],
      ),
    );
  });

  it("unknown remains editable but CONTINUE never automatically repeats it", async () => {
    await document();
    const current = await save(
      await view(),
      "dataCompra",
      "nao sei informar",
      null,
    );
    const q = question(current, "dataCompra");
    expect(q.answerState).toBe("UNKNOWN");
    const before = await row();
    const response = await call<{ importOutcome: ImportChatOutcomeV1 }>(
      "POST",
      "/agent/chat",
      {
        messages: [{ role: "user", content: "Continuar" }],
        importTurn: {
          version: 1,
          turnId: crypto.randomUUID(),
          sessionId,
          expectedRevision: current.revision,
          channel: "TEXT",
          literalAnswer: "Continuar",
          intent: "CONTINUE",
          focus: null,
          scope: null,
        },
      },
    );
    expect(response.status).toBe(201);
    expect(response.body.importOutcome).not.toMatchObject({
      kind: "QUESTION",
      questionId: q.id,
    });
    expect(await row()).toEqual(before);
    expect(current.actions).not.toContain("CONFIRM");
  });

  it.each(["não foi R$ 100,00", "não foi 100, foi 120", "100 e 120", "sim"])(
    "negation/prose is not a human monetary fact: %s",
    async (literal) => {
      await document({ amountCents: null, dataCompra: "2026-09-25" });
      const v = await view();
      const before = await row();
      const financialBefore = await finances();
      const q = question(v, "amountCents");
      nextModel = {
        content: "I saved it",
        toolCalls: [
          {
            id: "forged-span",
            name: "import_edit_answer",
            arguments: {
              interpretation: {
                kind: "VALUE",
                field: "amountCents",
                evidence: { start: 0, end: literal.length },
                value: {
                  span: {
                    start: Math.max(0, literal.indexOf("100")),
                    end: literal.length,
                  },
                  text: "100,00",
                },
              },
            },
          },
        ],
      };
      const result = await call<{ importOutcome: ImportChatOutcomeV1 }>(
        "POST",
        "/agent/chat",
        answerBody(v, q, literal),
      );
      expect(result.status).toBe(201);
      expect(result.body.importOutcome).toMatchObject({
        kind: "CLARIFY",
        acknowledgment: "NONE",
      });
      expect(await row()).toEqual(before);
      expect(await finances()).toEqual(financialBefore);
    },
  );

  it("the six-field literal grammar never promotes model values or plain merchant prose", async () => {
    await document(
      {
        dataCompra: null,
        amountMeaning: "UNKNOWN",
        amountCents: null,
        installmentCount: null,
        installmentIndex: null,
      },
      { merchant: null },
    );
    let current = await view();
    const cases: Array<{
      field: Field;
      literal: string;
      value: string | number;
      invalid: string[];
    }> = [
      {
        field: "dataCompra",
        literal: "25/09/2026",
        value: "2026-09-25",
        invalid: ["25/09", "2026-02-30"],
      },
      {
        field: "merchant",
        literal: '"Loja Alfa"',
        value: "Loja Alfa",
        invalid: ["Loja Alfa", '{"name":"Loja Alfa"}'],
      },
      {
        field: "amountMeaning",
        literal: "valor da parcela",
        value: "INSTALLMENT_CHARGE",
        invalid: ["acho que parcela", "INSTALLMENT_CHARGE"],
      },
      {
        field: "installmentCount",
        literal: "3",
        value: 3,
        invalid: ["0", "25"],
      },
      {
        field: "installmentIndex",
        literal: "2",
        value: 2,
        invalid: ["2/3", "4"],
      },
      {
        field: "amountCents",
        literal: "206,96",
        value: 20696,
        invalid: ["0", "-1"],
      },
    ];
    for (const c of cases) {
      current = await save(current, c.field, c.literal, c.value);
      for (const invalid of c.invalid) {
        const before = await row();
        const response = await answer(current, c.field, invalid, c.value);
        expect(response.outcome).toMatchObject({
          kind: "CLARIFY",
          acknowledgment: "NONE",
        });
        expect(await row()).toEqual(before);
      }
    }
    current = await save(current, "merchant", '"remover"', "remover");
    current = await save(current, "merchant", "remover", null);
    expect(
      current.declaredFacts.find((fact) => fact.field === "merchant"),
    ).toMatchObject({
      value: null,
      status: "UNKNOWN",
    });
    expect((await finances()).expenses).toEqual([]);
  });

  it("PARCELA to TOTAL preserves the previous amount with its old context, unused", async () => {
    await document({
      amountMeaning: "UNKNOWN",
      amountCents: null,
      installmentIndex: 2,
    });
    let current = await view();
    question(current, "amountMeaning");
    expect(
      current.questions.filter(
        (q) => "subject" in q && q.field === "amountCents",
      ),
    ).toEqual([]);
    current = await save(
      current,
      "amountMeaning",
      "valor da parcela",
      "INSTALLMENT_CHARGE",
    );
    const oldQuestion = question(current, "amountCents");
    current = await save(current, "amountCents", "R$ 100,00", 10000);
    const amountRecord = JSON.parse(
      (await row()).draftJson,
    ).declarations.items.find(
      (item: { field: string }) => item.field === "amountCents",
    );
    current = await save(
      current,
      "amountMeaning",
      "total da compra",
      "TOTAL_PURCHASE",
    );
    const changed = current.declaredFacts.find(
      (fact) => fact.field === "amountCents",
    );
    expect(changed).toMatchObject({
      value: 10000,
      status: "CONTEXT_CHANGED",
      meaningContext: "INSTALLMENT_CHARGE",
    });
    const newQuestion = question(current, "amountCents");
    expect(newQuestion.id).not.toBe(oldQuestion.id);
    expect(newQuestion.subject.meaningContext).toBe("TOTAL_PURCHASE");
    expect(newQuestion.answerState).toBe("UNANSWERED");
    expect(
      JSON.parse((await row()).draftJson).declarations.items.find(
        (item: { field: string }) => item.field === "amountCents",
      ),
    ).toEqual(amountRecord);
    expect(current.actions).not.toContain("PREPARE");
    expect(current.proposal).toBeNull();
  });

  it.each([null, "synthetic-fitid"] as const)(
    "ordinal zero uses effective canonical query inputs without persisting keys (fitId=%s)",
    async (fitId) => {
      const original = await document(
        { dataCompra: "2026-09-25", amountMeaning: "UNKNOWN" },
        { ordinal: 0, fitId },
      );
      expect(original.artifact).toMatchObject({
        documentSha256:
          "b7cdf096e4dd040646c54d48e40249e88cd0693ce2daa8e06be42b242da0e1d7",
        verifiedBytes: 47,
      });
      expect(original.extraction.occurrences[0]).toMatchObject({
        dateOnly: "2026-09-25",
        merchant: "Synthetic B3 purchase",
        amountCents: 60000,
        identityOrdinal: 0,
      });
      const before = await originals();
      const current = await save(
        await view(),
        "amountMeaning",
        "total da compra",
        "TOTAL_PURCHASE",
      );
      const natural = jest.spyOn(keys, "dedupeKeyNatural");
      const strong = jest.spyOn(keys, "dedupeKeyStrong");
      const enumerate = jest.spyOn(crossOrigin, "enumerateDedupeMatches");
      const inspect = jest.spyOn(cardIdentity, "inspectCardImportInTx");
      const ready = await prepare(current);
      expect(natural).toHaveBeenCalledWith({
        tenantId: world.tenantId,
        projectId: world.projects.pessoal,
        date: new Date("2026-09-25T00:00:00.000Z"),
        merchant: "Synthetic B3 purchase",
        amountCents: 60000,
        ordinal: 0,
      });
      expect(strong).toHaveBeenCalledWith(
        expect.objectContaining({
          ordinal: 0,
          fitId: fitId ?? undefined,
          fileContentHash: importFileContentHash(
            "b7cdf096e4dd040646c54d48e40249e88cd0693ce2daa8e06be42b242da0e1d7",
          ),
        }),
      );
      expect(enumerate).toHaveBeenCalled();
      expect(inspect).toHaveBeenCalled();
      const persisted = await row();
      const search = parseStoredImportSearch(
        persisted.searchJson,
        ready.revision,
        parseStoredDraft(persisted.draftJson),
      );
      expect(search.kind).toBe("SEARCH");
      if (search.kind !== "SEARCH")
        throw new Error("Missing persisted canonical search");
      expect(
        search.value.coverage.steps.map(({ stage, status }) => ({
          stage,
          status,
        })),
      ).toEqual([
        { stage: "DOCUMENT_IDENTITY", status: "EXHAUSTED" },
        { stage: "CROSS_ORIGIN", status: "EXHAUSTED" },
        { stage: "CARD_IDENTITY", status: "EXHAUSTED" },
      ]);
      expect(ready).toMatchObject({
        state: "READY",
        searchComplete: true,
        proposal: { createdEconomicTotalCents: 60000, bankCashDeltaCents: 0 },
      });
      expect(ready.reviewBlockers).toEqual([
        {
          lineId: "purchase-0",
          code: "ORIGINAL_OCCURRENCE_INCOMPLETE",
          resolution: "RESOLVED_BY_USER",
        },
      ]);
      expect(await originals()).toEqual(before);
    },
  );

  it("null ordinal plus FITID never becomes exhausted cross-origin or an applicable proposal", async () => {
    await document({}, { ordinal: null, fitId: "synthetic-fitid" });
    const current = await save(
      await view(),
      "dataCompra",
      "25/09/2026",
      "2026-09-25",
    );
    const enumerate = jest.spyOn(crossOrigin, "enumerateDedupeMatches");
    const prepared = await prepare(current);
    const persisted = await row();
    const search = parseStoredImportSearch(
      persisted.searchJson,
      prepared.revision,
      parseStoredDraft(persisted.draftJson),
    );
    expect(search.kind).toBe("SEARCH");
    if (search.kind !== "SEARCH") throw new Error("Missing incomplete search");
    expect(
      search.value.coverage.steps.find((step) => step.stage === "CROSS_ORIGIN"),
    ).toEqual({
      lineId: "purchase-0",
      stage: "CROSS_ORIGIN",
      status: "NOT_RUN",
      predicateHash: null,
      visitedRows: 0,
      endCursor: null,
    });
    expect(enumerate).not.toHaveBeenCalled();
    expect(prepared).toMatchObject({
      state: "NEEDS_INPUT",
      searchComplete: false,
      proposal: null,
    });
    expect(prepared.actions).not.toContain("CONFIRM");
    expect(prepared.reviewBlockers).toContainEqual({
      lineId: "purchase-0",
      code: "ORIGINAL_IDENTITY_INCOMPLETE",
      resolution: "SEARCH_IDENTITY_UNAVAILABLE",
    });
  });

  it("original known fields are authoritative; forged focus and attachment broadcast cannot declare", async () => {
    const f = await document();
    const v = await view();
    const q = question(v, "dataCompra");
    const before = await row();
    const immutable = await originals();
    for (const mode of ["field", "scope", "subject"] as const) {
      modelValue("installmentCount", "4", 4);
      const request = answerBody(v, q, "4");
      const importTurn = {
        ...request.importTurn,
        ...(mode === "field"
          ? {
              focus: { ...request.importTurn.focus, field: "installmentCount" },
            }
          : {}),
        ...(mode === "scope"
          ? { scope: { kind: "ATTACHMENT", attachmentId: f.attachment.id } }
          : {}),
        ...(mode === "subject"
          ? {
              focus: {
                ...request.importTurn.focus,
                subject: {
                  kind: "OBSERVATION",
                  observationId: "foreign-observation",
                },
              },
            }
          : {}),
      };
      const result = await call<{ importOutcome?: ImportChatOutcomeV1 }>(
        "POST",
        "/agent/chat",
        { ...request, importTurn },
      );
      if (result.status === 201) {
        expect(result.body.importOutcome).toMatchObject({
          acknowledgment: "NONE",
        });
        expect(["ERROR", "CLARIFY"]).toContain(result.body.importOutcome?.kind);
      } else expect([400, 403, 409]).toContain(result.status);
      expect(await row()).toEqual(before);
      expect(await originals()).toEqual(immutable);
    }
  });

  it("materialization clones actual ANSWER records without spreading them to a new observation", async () => {
    await document({ dataCompra: "2026-09-25", amountMeaning: "UNKNOWN" });
    const answered = await save(
      await view(),
      "amountMeaning",
      "total da compra",
      "TOTAL_PURCHASE",
    );
    const before = await row();
    const added = await document();
    const persisted = await row();
    const draft = parseStoredDraft(persisted.draftJson);
    draft.lines = draft.lines.filter((line) => line.id !== added.line.id);
    draft.selectedLineIds = [answered.lines[0].id];
    draft.scope.observationIds = [observations[0]];
    draft.scope.pendingAttachmentIds = [added.attachment.id];
    const plan = buildImportMaterialization({
      session: persisted,
      attachment: added.attachment,
      artifact: added.artifact,
      extraction: added.extraction,
      draft,
      observations: [added.observation],
      newIds: new Map([
        [
          added.evidence.reference,
          {
            observationId: added.observation.id,
            lineId: added.line.id,
          },
        ],
      ]),
    });
    expect(plan.draft).toHaveProperty(
      "declarations",
      JSON.parse(before.draftJson).declarations,
    );
    expect(plan.draft.lines[0]).toEqual(answered.lines[0]);
    expect(plan.draft.scope.observationIds).toEqual(observations);
    expect(plan.observations).toEqual([]);
    expect(
      (
        await call("PATCH", `/import-sessions/${sessionId}/draft`, {
          expectedRevision: persisted.revision,
          questionId: null,
          replaceLines: [],
          selectedLineIds: ["purchase-0"],
        })
      ).status,
    ).toBe(200);
    const prepared = await prepare(await view());
    expect(prepared.declaredFacts).toEqual(answered.declaredFacts);
    expect(question(prepared, "dataCompra", observations[1]).answerState).toBe(
      "UNANSWERED",
    );
  });

  it("writer rechecks claim drift after admission and before its real transaction", async () => {
    await document();
    const v = await view();
    const q = question(v, "dataCompra");
    const before = await row();
    const realWrite = writer.runImportSessionWrite;
    let intercepted = false;
    jest
      .spyOn(writer, "runImportSessionWrite")
      .mockImplementation(async (...args) => {
        if (!intercepted) {
          intercepted = true;
          await db.importObservation.update({
            where: { id: observations[0] },
            data: { claimVersion: { increment: 1 } },
          });
        }
        return realWrite(...args);
      });
    modelValue("dataCompra", "25/09/2026", "2026-09-25");
    const response = await call<{ importOutcome: ImportChatOutcomeV1 }>(
      "POST",
      "/agent/chat",
      answerBody(v, q, "25/09/2026"),
    );
    expect(intercepted).toBe(true);
    expect(response.status).toBe(409);
    expect(response.body.importOutcome).toMatchObject({
      kind: "ERROR",
      code: "REVISION_CONFLICT",
      acknowledgment: "UNKNOWN",
    });
    expect(await row()).toEqual(before);
    expect((await finances()).expenses).toEqual([]);
  });

  it("lost ANSWER response is recovered by GET, stale replay never renews or duplicates", async () => {
    await document();
    const originalView = await view();
    const accepted = await answer(
      originalView,
      "dataCompra",
      "25/09/2026",
      "2026-09-25",
    );
    expect(accepted.outcome).toMatchObject({ acknowledgment: "EDITED" });
    const committed = await row();
    modelChat.mockClear();
    const recovered = await view();
    expect(recovered.revision).toBe(originalView.revision + 1);
    expect(recovered.declaredFacts).toHaveLength(1);
    expect(modelChat).not.toHaveBeenCalled();
    expect(await row()).toEqual(committed);
    const replay = await call<{ importOutcome: ImportChatOutcomeV1 }>(
      "POST",
      "/agent/chat",
      accepted.body,
    );
    expect(replay.status).toBe(409);
    expect(replay.body.importOutcome).toMatchObject({
      kind: "ERROR",
      acknowledgment: "NONE",
      code: "REVISION_CONFLICT",
    });
    expect(await row()).toEqual(committed);
  });

  it("mixed support survives confirmed reprepare; evidence time is confirmedAt, not latest answer or execution", async () => {
    await document({ dataCompra: "2026-09-25", amountMeaning: "UNKNOWN" });
    await document({ dataCompra: "2026-09-26", amountMeaning: "UNKNOWN" });
    clock.current = new Date("2026-10-08T12:30:00.000Z");
    jest.setSystemTime(clock.current);
    let current = await save(
      await view(),
      "amountMeaning",
      "total da compra",
      "TOTAL_PURCHASE",
    );
    clock.current = new Date("2026-10-08T12:31:00.000Z");
    jest.setSystemTime(clock.current);
    current = await save(
      current,
      "amountMeaning",
      "total da compra",
      "TOTAL_PURCHASE",
      observations[1],
    );
    const declarations = JSON.parse((await row()).draftJson).declarations;
    expect(
      declarations.items
        .map((item: { attestedAt: string }) => item.attestedAt)
        .sort(),
    ).toEqual(["2026-10-08T12:30:00.000Z", "2026-10-08T12:31:00.000Z"]);
    const ready = await prepare(current);
    expect(ready.declaredFacts).toEqual(current.declaredFacts);
    clock.current = new Date("2026-10-08T12:35:00.000Z");
    jest.setSystemTime(clock.current);
    const executeBody = await confirm(ready);
    expect(JSON.parse((await row()).draftJson).declarations).toEqual(
      declarations,
    );
    clock.current = new Date("2026-10-08T12:36:00.000Z");
    jest.setSystemTime(clock.current);
    const applied = await call<ImportSessionReceiptV1>(
      "POST",
      `/import-sessions/${sessionId}/execute`,
      executeBody,
    );
    expect(applied.status).toBe(200);
    expect(applied.body.snapshot).toMatchObject({
      createdEconomicTotalCents: 120000,
      bankCashDeltaCents: 0,
    });
    const expense = await db.expense.findUniqueOrThrow({
      where: { id: applied.body.items[0].sourceExpenseId },
    });
    const schedule = parseStoredExpenseSchedule(expense.documentedSchedule);
    expect(schedule).toMatchObject({
      provenance: {
        evidence: {
          evidenceKind: "user-attestation",
          attestedByUserId: world.users.owner.id,
          attestedAt: "2026-10-08T12:35:00.000Z",
          documentSha256:
            "b7cdf096e4dd040646c54d48e40249e88cd0693ce2daa8e06be42b242da0e1d7",
        },
      },
    });
    expect(schedule).toHaveProperty(
      "provenance.reason",
      expect.stringMatching(/[0-9a-f]{64}/),
    );
    const financialAfter = await finances();
    expect(
      (await call("POST", `/import-sessions/${sessionId}/execute`, executeBody))
        .body,
    ).toEqual(applied.body);
    expect(await finances()).toEqual(financialAfter);
    const terminal = await view();
    expect(terminal).toMatchObject({
      questions: [],
      declaredFacts: [],
      reviewBlockers: [],
    });
  });

  it.each(["claim", "acl", "deferred-support"] as const)(
    "confirmed preflight detects %s drift even with unchanged economic JSON",
    async (kind) => {
      await document({ dataCompra: "2026-09-25", amountMeaning: "UNKNOWN" });
      await document({ dataCompra: "2026-09-26", amountMeaning: "UNKNOWN" });
      let current = await save(
        await view(),
        "amountMeaning",
        "total da compra",
        "TOTAL_PURCHASE",
      );
      current = await save(
        current,
        "amountMeaning",
        "total da compra",
        "TOTAL_PURCHASE",
        observations[1],
      );
      expect(
        (
          await call("PATCH", `/import-sessions/${sessionId}/draft`, {
            expectedRevision: current.revision,
            questionId: null,
            replaceLines: [],
            selectedLineIds: ["purchase-0"],
          })
        ).status,
      ).toBe(200);
      const ready = await prepare(await view());
      const executeBody = await confirm(ready);
      const economic = (await row()).proposalJson;
      if (kind === "claim")
        await db.importObservation.update({
          where: { id: observations[0] },
          data: { claimVersion: { increment: 1 } },
        });
      else if (kind === "acl")
        await db.project.update({
          where: { id: world.projects.pessoal },
          data: { deletedAt: clock.now() },
        });
      else {
        const persisted = await row();
        const draft = JSON.parse(persisted.draftJson);
        const declaration = draft.declarations.items.find(
          (item: { observationId: string }) =>
            item.observationId === observations[1],
        );
        declaration.attestedAt = "2026-10-08T12:29:00.000Z";
        await db.importSession.update({
          where: { id: sessionId },
          data: { draftJson: JSON.stringify(draft) },
        });
      }
      expect((await row()).proposalJson).toBe(economic);
      const before = await finances();
      const beforeClaims = await db.importObservation.findMany({
        where: { tenantId: world.tenantId },
      });
      const result = await call(
        "POST",
        `/import-sessions/${sessionId}/execute`,
        executeBody,
      );
      expect([403, 404, 409]).toContain(result.status);
      expect(await finances()).toEqual(before);
      expect(
        await db.importObservation.findMany({
          where: { tenantId: world.tenantId },
        }),
      ).toEqual(beforeClaims);
    },
  );

  it("AC18 transfers only deferred support without renewing provenance or old-session focus", async () => {
    await document({ dataCompra: "2026-09-25", amountMeaning: "UNKNOWN" });
    await document({ dataCompra: "2026-09-26", amountMeaning: "UNKNOWN" });
    let current = await save(
      await view(),
      "amountMeaning",
      "total da compra",
      "TOTAL_PURCHASE",
    );
    current = await save(
      current,
      "amountMeaning",
      "total da compra",
      "TOTAL_PURCHASE",
      observations[1],
    );
    const oldQuestion = question(current, "amountMeaning", observations[1]);
    expect(
      (
        await call("PATCH", `/import-sessions/${sessionId}/draft`, {
          expectedRevision: current.revision,
          questionId: null,
          replaceLines: [],
          selectedLineIds: ["purchase-0"],
        })
      ).status,
    ).toBe(200);
    const before = await row();
    const declarations = JSON.parse(before.draftJson).declarations.items;
    const ready = await prepare(await view());
    expect(ready.proposal?.deferredObservationIds).toEqual([observations[1]]);
    const executeBody = await confirm(ready);
    const applied = await call<ImportSessionReceiptV1>(
      "POST",
      `/import-sessions/${sessionId}/execute`,
      executeBody,
    );
    expect(applied.status).toBe(200);
    const successorId = applied.body.continuationSessionId;
    expect(typeof successorId).toBe("string");
    if (!successorId) throw new Error("No AC18 successor");
    const successor = await db.importSession.findUniqueOrThrow({
      where: { id: successorId },
    });
    expect(successor.expiresAt).toEqual(before.expiresAt);
    expect(JSON.parse(successor.draftJson).declarations).toEqual({
      version: 1,
      items: declarations.filter(
        (item: { observationId: string }) =>
          item.observationId === observations[1],
      ),
    });
    const next = await view(successorId);
    const newQuestion = question(next, "amountMeaning", observations[1]);
    expect(newQuestion.id).not.toBe(oldQuestion.id);
    expect(newQuestion.answerState).toBe("DECLARED");
    expect(next.declaredFacts).toHaveLength(1);
    expect(next.declaredFacts[0].questionId).toBe(newQuestion.id);
    modelValue("amountMeaning", "valor da parcela", "INSTALLMENT_CHARGE");
    const denied = await call<{ importOutcome: ImportChatOutcomeV1 }>(
      "POST",
      "/agent/chat",
      answerBody(next, oldQuestion, "valor da parcela"),
    );
    expect(denied.status).toBe(409);
    expect(denied.body.importOutcome).toMatchObject({
      kind: "ERROR",
      code: "REVISION_CONFLICT",
      acknowledgment: "NONE",
    });
    expect(
      await db.importSession.findUniqueOrThrow({ where: { id: successorId } }),
    ).toEqual(successor);
  });
});
