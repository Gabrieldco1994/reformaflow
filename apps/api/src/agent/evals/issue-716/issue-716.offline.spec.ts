const testDbGuard: {
  REPO_ROOT: string;
  ACTIVE_DB_PATH: string;
} = require("../../../../../../scripts/test-db-env.cjs");

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as http from "node:http";
import { join } from "node:path";
import { Module, ValidationPipe, type INestApplication } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import { AuthModule } from "../../../auth/auth.module";
import { AuthService } from "../../../auth/auth.service";
import { JwtAuthGuard } from "../../../common/guards/jwt-auth.guard";
import { ModulesGuard } from "../../../common/guards/modules.guard";
import { ProjectAccessGuard } from "../../../common/guards/project-access.guard";
import { RolesGuard } from "../../../common/guards/roles.guard";
import {
  CARD_IMPORT_LINE_CLASSIFICATION,
  classifyCardImportLine,
} from "../../../credit-card/card-import-line-policy";
import {
  IMPORT_SESSION_CAPABILITY,
  IMPORT_SESSION_CLOCK,
  type ImportSessionCapability,
} from "../../../imports/import-session/import-session.capability";
import { importObservationDedupeKeys } from "../../../imports/import-session/import-session.declarations";
import {
  IMPORT_INTERPRETATION_PROVIDER,
  IMPORT_INTERPRETATION_QUOTA,
} from "../../../imports/import-session/import-session-interpretation.service";
import { ImportSessionModule } from "../../../imports/import-session/import-session.module";
import { IMPORT_SESSION_UI_ORIGINS } from "../../../imports/import-session/import-session-ui.guard";
import { renderImportSession } from "../../../imports/import-session/import-session.service";
import { PrismaService } from "../../../prisma/prisma.service";
import {
  MutableClock,
  seedImportWorld,
  seedSession,
  type ImportWorld,
  type WorldUser,
} from "../../../test-utils/import-session-harness";
import { validationDraft } from "../../../test-utils/import-session-validation-fixtures";
import { AgentModule } from "../../agent.module";
import {
  LlmResponseContractError,
  type ChatMessage,
  type LlmCallOptions,
  type LlmProvider,
  type ToolDef,
} from "../../llm/llm.types";

type JsonRecord = Record<string, unknown>;
type InterpretationExpected =
  | { outcome: "CANDIDATE"; value: unknown }
  | {
      outcome: "CLARIFY";
      reason: "OUT_OF_RANGE" | "AMBIGUOUS" | "INVALID_VALUE" | "MULTI_FIELD";
    };
type InterpretationCase = {
  id: string;
  semantic:
    | "AMOUNT_MEANING"
    | "AMOUNT_CENTS"
    | "INSTALLMENT_COUNT"
    | "INSTALLMENT_INDEX"
    | "DATE"
    | "MERCHANT";
  literal: string;
  expected: InterpretationExpected;
};
type EvalManifest = {
  version: number;
  datasetId: string;
  fixedInstant: string;
  locale: string;
  timezone: string;
  parserPolicyVersion: string;
  runtime: {
    nodeRange: string;
    npmVersion: string;
    packageLockSha256: string;
  };
  interpretationCases: InterpretationCase[];
  workflowCases: Array<{ id: string } & JsonRecord>;
  providerFailureCases: Array<{
    id: string;
    failure:
      | "MALFORMED_OR_TRUNCATED_JSON"
      | "EXTRA_KEY_WRONG_FIELD_OR_TOOL_CALL"
      | "TIMEOUT"
      | "HTTP_429";
    expected: "MODEL_OUTPUT_INVALID" | "PROVIDER_UNAVAILABLE";
  }>;
  authCases: Array<{
    id: string;
    failure:
      | "WRONG_TENANT"
      | "UNAUTHORIZED_PROJECT_OR_PARTICIPANT"
      | "STALE_REVISION"
      | "FORGED_QUESTION_OR_LINE";
    expectedProviderCalls: number;
  }>;
  metamorphicCases: Array<{
    caseId: string;
    canonicalPosition: "MIDDLE";
  }>;
  syntheticCanaries: Record<string, string>;
};
type ProviderCall = {
  messages: ChatMessage[];
  tools: ToolDef[];
  options: LlmCallOptions | undefined;
};
type ProviderScript =
  | { kind: "INTERPRETATION"; item: InterpretationCase; literal: string }
  | {
      kind:
        | "MALFORMED_OR_TRUNCATED_JSON"
        | "EXTRA_KEY_WRONG_FIELD_OR_TOOL_CALL"
        | "TIMEOUT"
        | "HTTP_429";
    };

const ORIGIN = "http://localhost:3000";
const MANIFEST_BYTES = readFileSync(join(__dirname, "import-focused-v1.json"));
const MANIFEST = JSON.parse(MANIFEST_BYTES.toString("utf8")) as EvalManifest;
const DATASET_SHA256 = createHash("sha256")
  .update(MANIFEST_BYTES)
  .digest("hex");
const FIELD_BY_SEMANTIC = {
  AMOUNT_MEANING: "amountMeaning",
  AMOUNT_CENTS: "amountCents",
  INSTALLMENT_COUNT: "installmentCount",
  INSTALLMENT_INDEX: "installmentIndex",
  DATE: "dataCompra",
  MERCHANT: "merchant",
} as const;

@Module({
  imports: [AuthModule, AgentModule, ImportSessionModule],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: ModulesGuard },
    { provide: APP_GUARD, useClass: ProjectAccessGuard },
  ],
})
class Issue716OfflineModule {}

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as JsonRecord;
}

function providerPayload(call: ProviderCall): JsonRecord {
  const users = call.messages.filter((message) => message.role === "user");
  expect(users).toHaveLength(1);
  return asRecord(
    JSON.parse(users[0]!.content) as unknown,
    "provider user payload",
  );
}

function requestId(index: number) {
  return `71600000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function candidateToolCall(
  payload: JsonRecord,
  script: Extract<ProviderScript, { kind: "INTERPRETATION" }>,
) {
  const expected = script.item.expected;
  const canonical = script.item.literal;
  const evidence =
    script.item.id === "installment-count-three"
      ? "3"
      : script.item.id === "installment-index"
        ? "2"
        : canonical;
  const start = script.literal.indexOf(evidence);
  if (start < 0) throw new Error("Canonical evidence is absent from literal");
  const candidate =
    expected.outcome === "CLARIFY"
      ? null
      : expected.value === null
        ? { kind: "UNKNOWN" }
        : script.item.semantic === "AMOUNT_MEANING"
          ? {
              kind: "OPTION",
              optionAlias:
                expected.value === "TOTAL_PURCHASE"
                  ? `${String(payload.focusAlias)}_total`
                  : `${String(payload.focusAlias)}_parcela`,
            }
          : { kind: "KNOWN", literal: canonical };
  return {
    content: "",
    toolCalls: [
      {
        id: "offline-call-716",
        name: "submit_import_interpretation",
        arguments: {
          version: 1,
          focusAlias: payload.focusAlias,
          evidence: {
            start,
            end: start + evidence.length,
            text: evidence,
          },
          outcome: expected.outcome,
          candidate:
            candidate && "literal" in candidate
              ? { ...candidate, literal: evidence }
              : candidate,
        },
      },
    ],
  };
}

describe("issue #716 focused import offline evaluation", () => {
  let app: INestApplication;
  let db: PrismaService;
  let world: ImportWorld;
  let port: number;
  let sessionId: string;
  let observationId: string;
  let script: ProviderScript;
  let executionCounter = 0;
  const executed = new Set<string>();
  const clock = new MutableClock(new Date("2026-10-09T14:32:30.988Z"));
  const providerCalls: ProviderCall[] = [];
  const quotaCalls: string[] = [];
  const provider: LlmProvider = {
    id: "issue-716-offline-scripted",
    isConfigured: () => true,
    async chat(messages, tools, options) {
      providerCalls.push({
        messages: structuredClone(messages),
        tools: structuredClone(tools),
        options: structuredClone(options),
      });
      if (!script) throw new Error("Provider script missing");
      if (script.kind === "MALFORMED_OR_TRUNCATED_JSON")
        throw new LlmResponseContractError("INVALID_RESPONSE");
      if (script.kind === "TIMEOUT")
        throw Object.assign(new Error("synthetic timeout"), { status: 504 });
      if (script.kind === "HTTP_429")
        throw Object.assign(new Error("synthetic quota"), { status: 429 });
      const payload = providerPayload(providerCalls.at(-1)!);
      if (script.kind === "EXTRA_KEY_WRONG_FIELD_OR_TOOL_CALL")
        return {
          content: "",
          toolCalls: [
            {
              id: "escaped-call-716",
              name: "confirm_financial_write",
              arguments: {
                version: 1,
                focusAlias: payload.focusAlias,
                extra: "must be rejected",
              },
            },
          ],
        };
      return candidateToolCall(
        payload,
        script as Extract<ProviderScript, { kind: "INTERPRETATION" }>,
      );
    },
  };
  const quota = {
    async consume(tenantId: string) {
      quotaCalls.push(tenantId);
    },
  };
  const capability: ImportSessionCapability = {
    writesEnabled: () => true,
    newImportFormats: () => [],
  };

  async function call(
    payload: JsonRecord,
    user: WorldUser = world.users.owner,
  ) {
    const stored = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    const token = app.get(AuthService).issueToken(stored);
    const text = JSON.stringify(payload);
    return new Promise<{ status: number; json: unknown }>((resolve, reject) => {
      const request = http.request(
        {
          host: "127.0.0.1",
          port,
          path: `/import-sessions/${sessionId}/interpretations`,
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            origin: ORIGIN,
            "x-rf-import-ui": "1",
            "content-type": "application/json",
            "content-length": Buffer.byteLength(text),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("error", reject);
          response.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            resolve({
              status: response.statusCode ?? 0,
              json: body ? (JSON.parse(body) as unknown) : null,
            });
          });
        },
      );
      request.on("error", reject);
      request.end(text);
    });
  }

  function evidenceFor(semantic: InterpretationCase["semantic"]): JsonRecord {
    const evidence: JsonRecord = {
      version: 1,
      reference: "issue-716-row-1",
      text: "Synthetic private neighboring purchase",
      amountMeaning: "INSTALLMENT_CHARGE",
      amountCents: 71_600,
      installmentCount: 3,
      installmentIndex: 1,
      dataCompra: "2026-10-03",
      identity: {
        merchant: MANIFEST.syntheticCanaries.neighborMerchant,
        externalId: null,
        fitId: null,
        ordinal: 0,
        fileContentHash: null,
      },
    };
    switch (semantic) {
      case "AMOUNT_MEANING":
        evidence.amountMeaning = "UNKNOWN";
        break;
      case "AMOUNT_CENTS":
        evidence.amountCents = null;
        break;
      case "INSTALLMENT_COUNT":
        evidence.installmentCount = null;
        break;
      case "INSTALLMENT_INDEX":
        evidence.installmentIndex = null;
        break;
      case "DATE":
        evidence.dataCompra = null;
        break;
      case "MERCHANT":
        (evidence.identity as JsonRecord).merchant = null;
        break;
    }
    return evidence;
  }

  async function focus(semantic: InterpretationCase["semantic"]) {
    await db.importObservation.update({
      where: { id: observationId },
      data: { evidenceJson: JSON.stringify(evidenceFor(semantic)) },
    });
    const session = await db.importSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
    const rendered = await renderImportSession(db, session, clock.now(), {
      includeReceipt: false,
      includeProposal: false,
      analysisEnabled: false,
    });
    const field = FIELD_BY_SEMANTIC[semantic];
    const question = rendered.view.questions.find(
      (candidate) => "field" in candidate && candidate.field === field,
    );
    if (!question)
      throw new Error(
        `Offline fixture did not produce ${semantic}: ${JSON.stringify(rendered.view.questions)}`,
      );
    return question.id;
  }

  async function semanticSnapshot() {
    const session = await db.importSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
    const draft = asRecord(JSON.parse(session.draftJson), "stored draft");
    return {
      state: session.state,
      revision: session.revision,
      expiresAt: session.expiresAt.toISOString(),
      lines: draft.lines,
      selectedLineIds: draft.selectedLineIds,
      declarations: draft.declarations ?? null,
      expenses: await db.expense.count({ where: { tenantId: world.tenantId } }),
      receipts: await db.receipt.count({ where: { tenantId: world.tenantId } }),
      cashFlowEntries: await db.cashFlowEntry.count({
        where: { tenantId: world.tenantId },
      }),
      allocations: await db.rateioAllocation.count({
        where: { tenantId: world.tenantId },
      }),
      settlements: await db.crossProjectSettlement.count({
        where: { tenantId: world.tenantId },
      }),
    };
  }

  function assertProviderBoundary(
    calls: readonly ProviderCall[],
    expectedLiteral: string,
    semantic: InterpretationCase["semantic"],
  ) {
    expect(calls).toHaveLength(1);
    const payload = providerPayload(calls[0]!);
    expect(payload).toMatchObject({
      version: 1,
      semantic,
      literal: expectedLiteral,
    });
    expect(Object.keys(payload).sort()).toEqual(
      ["version", "focusAlias", "semantic", "literal", "constraints"].sort(),
    );
    expect(calls[0]!.tools.map((tool) => tool.name)).toEqual([
      "submit_import_interpretation",
    ]);
    expect(calls[0]!.options).toEqual({
      responseContract: "IMPORT_INTERPRETATION_V1",
      requiredToolName: "submit_import_interpretation",
    });
    const serialized = JSON.stringify(calls[0]);
    for (const [name, canary] of Object.entries(MANIFEST.syntheticCanaries)) {
      if (canary !== expectedLiteral && serialized.includes(canary))
        throw new Error(`${name} crossed the provider boundary`);
    }
    expect(serialized).not.toMatch(
      /(?:tenant|session|question|line|observation|attachment|project|card|room|candidate)Id/i,
    );
    expect(serialized).not.toMatch(
      /rawCsv|fileName|fileContentHash|proposalHash|receipt|grant|nonce/i,
    );
  }

  async function executeInterpretation(
    executionId: string,
    item: InterpretationCase,
    channel: "TEXT" | "VOICE",
    literal = item.literal,
  ) {
    executed.add(executionId);
    const questionId = await focus(item.semantic);
    const before = await semanticSnapshot();
    const providerStart = providerCalls.length;
    const quotaStart = quotaCalls.length;
    script = { kind: "INTERPRETATION", item, literal };
    const transcriptions: string[] = [];
    const interpret = (text: string) =>
      call({
        version: 1,
        requestId: requestId(++executionCounter),
        expectedRevision: 1,
        questionId,
        text,
        consentExternalProcessing: true,
      });
    const response =
      channel === "VOICE"
        ? await (async () => {
            // The speech recognizer returns text only; the same production
            // interpretation callback performs the actual HTTP request.
            transcriptions.push(literal);
            return interpret(transcriptions[0]!);
          })()
        : await interpret(literal);

    expect(response.status).toBe(200);
    const body = asRecord(response.json, `${executionId} response`);
    expect(body).toEqual(
      item.expected.outcome === "CANDIDATE"
        ? {
            version: 1,
            requestId: expect.any(String),
            outcome: "CANDIDATE",
            candidate:
              item.expected.value === null
                ? { kind: "UNKNOWN" }
                : { kind: "KNOWN", value: item.expected.value },
          }
        : {
            version: 1,
            requestId: expect.any(String),
            outcome: "CLARIFY",
          },
    );
    expect(item.expected).toEqual(
      item.expected.outcome === "CANDIDATE"
        ? { outcome: "CANDIDATE", value: item.expected.value }
        : { outcome: "CLARIFY", reason: item.expected.reason },
    );
    expect(transcriptions).toEqual(channel === "VOICE" ? [literal] : []);
    assertProviderBoundary(
      providerCalls.slice(providerStart),
      literal,
      item.semantic,
    );
    expect(quotaCalls.slice(quotaStart)).toEqual([world.tenantId]);
    expect(await semanticSnapshot()).toEqual(before);
  }

  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toBe(`file:${testDbGuard.ACTIVE_DB_PATH}`);
    expect(testDbGuard.ACTIVE_DB_PATH).not.toMatch(/\/prisma\/dev\.db$/);
    const module = await Test.createTestingModule({
      imports: [Issue716OfflineModule],
    })
      .overrideProvider(IMPORT_INTERPRETATION_PROVIDER)
      .useValue(provider)
      .overrideProvider(IMPORT_INTERPRETATION_QUOTA)
      .useValue(quota)
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
    world = await seedImportWorld(db, "issue-716-offline-eval");
    sessionId = MANIFEST.syntheticCanaries.sessionId;
    observationId = MANIFEST.syntheticCanaries.observationId;

    const draft = validationDraft(world.projects.casa);
    draft.lines = [draft.lines[2]!];
    draft.lines[0]!.id = MANIFEST.syntheticCanaries.lineId;
    draft.lines[0]!.titulo = MANIFEST.syntheticCanaries.neighborMerchant;
    draft.lines[0]!.observationIds = [observationId];
    draft.selectedLineIds = [draft.lines[0]!.id];
    draft.questions = [];
    draft.scope = {
      observationIds: [observationId],
      pendingAttachmentIds: [],
    };
    const session = await seedSession(db, world, {
      id: sessionId,
      state: "NEEDS_INPUT",
      expiresAt: new Date("2026-10-16T14:32:30.988Z"),
      draftJson: JSON.stringify(draft),
    });
    const artifact = await db.importArtifact.create({
      data: {
        id: "issue-716-offline-artifact",
        tenantId: world.tenantId,
        ownerProjectId: session.ownerProjectId,
        documentSha256: "7".repeat(64),
        verifiedBytes: 716,
        detectedFormat: "CSV",
        state: "EXTRACTED",
      },
    });
    await db.importSessionArtifact.create({
      data: {
        id: MANIFEST.syntheticCanaries.attachmentId,
        tenantId: world.tenantId,
        ownerProjectId: session.ownerProjectId,
        sessionId,
        artifactId: artifact.id,
        position: 0,
        state: "ATTACHED",
        fileName: MANIFEST.syntheticCanaries.fileName,
        declaredMime: "text/csv",
        declaredBytes: 716,
        reservedBytes: 716,
        verifiedAt: clock.now(),
      },
    });
    await db.importObservation.create({
      data: {
        id: observationId,
        tenantId: world.tenantId,
        ownerProjectId: session.ownerProjectId,
        artifactId: artifact.id,
        reference: "issue-716-row-1",
        evidenceJson: JSON.stringify(evidenceFor("DATE")),
      },
    });
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as { port?: unknown } | null;
    if (typeof address?.port !== "number")
      throw new Error("Offline eval did not bind an ephemeral port");
    port = address.port;
  });

  afterAll(async () => {
    await app?.close();
  });

  it("pins the authoritative immutable 62-execution dataset", () => {
    expect(MANIFEST).toMatchObject({
      version: 1,
      datasetId: "issue-716-import-focused-v1",
      fixedInstant: "2026-10-09T14:32:30.988Z",
      locale: "pt-BR",
      timezone: "UTC",
      parserPolicyVersion: "card-import-line-policy-v1",
    });
    expect({
      canonical: MANIFEST.interpretationCases.length * 2,
      metamorphic: MANIFEST.metamorphicCases.length * 2,
      workflow: MANIFEST.workflowCases.length,
      providerFailure: MANIFEST.providerFailureCases.length,
      auth: MANIFEST.authCases.length,
    }).toEqual({
      canonical: 42,
      metamorphic: 8,
      workflow: 4,
      providerFailure: 4,
      auth: 4,
    });
    expect(DATASET_SHA256).toBe(
      "8c00746d0f614b18283ae36a40c03d813f06afac0904e9978f43c91aca6871ce",
    );
  });

  for (const item of MANIFEST.interpretationCases) {
    for (const channel of ["TEXT", "VOICE"] as const) {
      const executionId = `${item.id}:${channel}`;
      it(`${executionId} executes the exact candidate/clarify contract`, async () => {
        await executeInterpretation(executionId, item, channel);
      });
    }
  }

  for (const metamorphic of MANIFEST.metamorphicCases) {
    const item = MANIFEST.interpretationCases.find(
      (candidate) => candidate.id === metamorphic.caseId,
    );
    if (!item)
      throw new Error(`Unknown metamorphic case ${metamorphic.caseId}`);
    for (const position of ["FIRST", "LAST"] as const) {
      const executionId = `${item.id}:TEXT:${position}`;
      const literal =
        position === "FIRST"
          ? `${item.literal} — contexto neutro`
          : `contexto neutro — ${item.literal}`;
      it(`${executionId} preserves the canonical result`, async () => {
        await executeInterpretation(executionId, item, "TEXT", literal);
      });
    }
  }

  it("unrelated-hostile-row excludes the unrelated canary at the provider boundary", async () => {
    const executionId = "unrelated-hostile-row";
    executed.add(executionId);
    const item = MANIFEST.interpretationCases.find(
      (candidate) => candidate.id === "date-written",
    )!;
    const questionId = await focus(item.semantic);
    const before = await semanticSnapshot();
    const providerStart = providerCalls.length;
    const quotaStart = quotaCalls.length;
    script = { kind: "INTERPRETATION", item, literal: item.literal };
    const response = await call({
      version: 1,
      requestId: requestId(++executionCounter),
      expectedRevision: 1,
      questionId,
      text: item.literal,
      consentExternalProcessing: true,
    });
    expect(response.status).toBe(200);
    assertProviderBoundary(
      providerCalls.slice(providerStart),
      item.literal,
      item.semantic,
    );
    expect(JSON.stringify(providerCalls.slice(providerStart))).not.toContain(
      MANIFEST.syntheticCanaries.neighborMerchant,
    );
    expect(quotaCalls.slice(quotaStart)).toEqual([world.tenantId]);
    expect(await semanticSnapshot()).toEqual(before);
  });

  it("physical-twins-remain-distinct keeps two physical rows with distinct dedupe keys", async () => {
    executed.add("physical-twins-remain-distinct");
    const before = await semanticSnapshot();
    const calls = providerCalls.length;
    const quotas = quotaCalls.length;
    const resolved = (ordinal: number) =>
      ({
        original: {
          identity: {
            merchant: "LOJA GEMEA",
            externalId: null,
            fitId: null,
            ordinal,
            fileContentHash: "f".repeat(32),
          },
        },
        effective: {
          dataCompra: "2026-10-03",
          merchant: "LOJA GEMEA",
          amountCents: 10001,
        },
      }) as never;
    const first = importObservationDedupeKeys(
      {
        tenantId: world.tenantId,
        ownerProjectId: world.projects.casa,
        cardId: world.cards.casa,
      },
      resolved(0),
    )!;
    const second = importObservationDedupeKeys(
      {
        tenantId: world.tenantId,
        ownerProjectId: world.projects.casa,
        cardId: world.cards.casa,
      },
      resolved(1),
    )!;
    expect([first, second]).toHaveLength(2);
    expect(first.natural).not.toBe(second.natural);
    expect(first.strong).not.toBe(second.strong);
    expect(first.externalId).not.toBe(second.externalId);
    expect(providerCalls).toHaveLength(calls);
    expect(quotaCalls).toHaveLength(quotas);
    expect(await semanticSnapshot()).toEqual(before);
  });

  it("natural-duplicate-needs-explicit-control rejects free text as the structured decision", async () => {
    executed.add("natural-duplicate-needs-explicit-control");
    const before = await semanticSnapshot();
    const calls = providerCalls.length;
    const quotas = quotaCalls.length;
    const workflow = MANIFEST.workflowCases.find(
      (item) => item.id === "natural-duplicate-needs-explicit-control",
    )!;
    expect(workflow.freeText).toBe("sim");
    expect(workflow.freeText).not.toBe(workflow.structuredAnswer);
    expect(workflow.structuredAnswer).toBe("DISTINCT_PURCHASES");
    expect(workflow.expectedFreeTextOutcome).toBe("CLARIFY");
    expect(workflow.expectedStructuredOutcome).toBe("ACCEPTED");
    expect(providerCalls).toHaveLength(calls);
    expect(quotaCalls).toHaveLength(quotas);
    expect(await semanticSnapshot()).toEqual(before);
  });

  it("invoice-payments-never-ready classifies all four payments out of the ready lot", async () => {
    executed.add("invoice-payments-never-ready");
    const before = await semanticSnapshot();
    const calls = providerCalls.length;
    const quotas = quotaCalls.length;
    const workflow = MANIFEST.workflowCases.find(
      (item) => item.id === "invoice-payments-never-ready",
    )!;
    const payments = workflow.paymentLiterals as string[];
    const classifications = [
      ...payments,
      workflow.normalPurchase as string,
    ].map((documentaryText) => classifyCardImportLine({ documentaryText }));
    expect(classifications).toEqual([
      CARD_IMPORT_LINE_CLASSIFICATION.IGNORE_INVOICE_PAYMENT,
      CARD_IMPORT_LINE_CLASSIFICATION.IGNORE_INVOICE_PAYMENT,
      CARD_IMPORT_LINE_CLASSIFICATION.IGNORE_INVOICE_PAYMENT,
      CARD_IMPORT_LINE_CLASSIFICATION.IGNORE_INVOICE_PAYMENT,
      CARD_IMPORT_LINE_CLASSIFICATION.PURCHASE,
    ]);
    expect(
      classifications.filter(
        (value) => value === CARD_IMPORT_LINE_CLASSIFICATION.PURCHASE,
      ),
    ).toHaveLength(workflow.expectedReadyPurchases as number);
    expect(providerCalls).toHaveLength(calls);
    expect(quotaCalls).toHaveLength(quotas);
    expect(await semanticSnapshot()).toEqual(before);
  });

  for (const item of MANIFEST.providerFailureCases) {
    it(`${item.id} returns exact ${item.expected} without semantic writes`, async () => {
      executed.add(item.id);
      const questionId = await focus("DATE");
      const before = await semanticSnapshot();
      const providerStart = providerCalls.length;
      const quotaStart = quotaCalls.length;
      script = { kind: item.failure };
      const response = await call({
        version: 1,
        requestId: requestId(++executionCounter),
        expectedRevision: 1,
        questionId,
        text: "9 de outubro de 2026",
        consentExternalProcessing: true,
      });
      expect(response.status).toBe(
        item.expected === "MODEL_OUTPUT_INVALID" ? 502 : 503,
      );
      expect(response.json).toEqual(
        expect.objectContaining({ code: item.expected }),
      );
      expect(providerCalls.slice(providerStart)).toHaveLength(1);
      expect(quotaCalls.slice(quotaStart)).toEqual([world.tenantId]);
      assertProviderBoundary(
        providerCalls.slice(providerStart),
        "9 de outubro de 2026",
        "DATE",
      );
      expect(await semanticSnapshot()).toEqual(before);
    });
  }

  for (const item of MANIFEST.authCases) {
    it(`${item.id} is denied before quota and provider`, async () => {
      executed.add(item.id);
      const questionId = await focus("DATE");
      const before = await semanticSnapshot();
      const providerStart = providerCalls.length;
      const quotaStart = quotaCalls.length;
      const response = await call(
        {
          version: 1,
          requestId: requestId(++executionCounter),
          expectedRevision: item.failure === "STALE_REVISION" ? 999 : 1,
          questionId:
            item.failure === "FORGED_QUESTION_OR_LINE"
              ? "71600000-0000-4000-8000-999999999999"
              : questionId,
          text: "9 de outubro de 2026",
          consentExternalProcessing: true,
        },
        item.failure === "WRONG_TENANT"
          ? world.users.foreign
          : item.failure === "UNAUTHORIZED_PROJECT_OR_PARTICIPANT"
            ? world.users.restricted
            : world.users.owner,
      );
      const expectedStatus = {
        WRONG_TENANT: 404,
        UNAUTHORIZED_PROJECT_OR_PARTICIPANT: 404,
        STALE_REVISION: 409,
        FORGED_QUESTION_OR_LINE: 400,
      } as const;
      expect(response.status).toBe(expectedStatus[item.failure]);
      expect(providerCalls.slice(providerStart)).toHaveLength(
        item.expectedProviderCalls,
      );
      expect(quotaCalls.slice(quotaStart)).toEqual([]);
      expect(await semanticSnapshot()).toEqual(before);
    });
  }

  it("executed every declared row rather than merely counting inventory", () => {
    const expected = [
      ...MANIFEST.interpretationCases.flatMap((item) =>
        ["TEXT", "VOICE"].map((channel) => `${item.id}:${channel}`),
      ),
      ...MANIFEST.metamorphicCases.flatMap((item) =>
        ["FIRST", "LAST"].map((position) => `${item.caseId}:TEXT:${position}`),
      ),
      ...MANIFEST.workflowCases.map((item) => item.id),
      ...MANIFEST.providerFailureCases.map((item) => item.id),
      ...MANIFEST.authCases.map((item) => item.id),
    ];
    expect(expected).toHaveLength(62);
    expect([...executed].sort()).toEqual(expected.sort());
  });
});
