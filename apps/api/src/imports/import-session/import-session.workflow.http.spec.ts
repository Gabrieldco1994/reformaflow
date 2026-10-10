const testDbGuard: {
  ACTIVE_DB_PATH: string;
} = require("../../../../../scripts/test-db-env.cjs");

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import * as http from "node:http";
import { resolve } from "node:path";
import {
  RequestMethod,
  ValidationPipe,
  type INestApplication,
} from "@nestjs/common";
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from "@nestjs/common/constants";
import { JwtService } from "@nestjs/jwt";
import { SchedulerRegistry } from "@nestjs/schedule";
import { Test } from "@nestjs/testing";
import type { Prisma } from "@prisma/client";
import {
  ExpenseType,
  IMPORT_SESSION_LIMITS,
  type ImportSessionChallengeResponseV1,
  type ImportSessionCandidateV1,
  type ImportSessionConfirmRequestV1,
  type ImportCurrentLotV1,
  type ImportDocumentaryCommandReceiptV1,
  type ImportSessionObservationViewV1,
  type ImportSessionPageV1,
  type ImportSessionProposalV1,
  type ImportSessionReceiptV1,
  type ImportSessionStoredDraftV1,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import cookieParser from "cookie-parser";
import type { Request, Response, NextFunction } from "express";
import { AuthService } from "../../auth/auth.service";
import * as canonicalSerialization from "../../common/canonical";
import { SERVICE_OWNED_PROJECT_ACCESS_KEY } from "../../common/decorators/service-owned-project-access.decorator";
import { ConciliacaoModule } from "../../conciliacao/conciliacao.module";
import { ConciliacaoService } from "../../conciliacao/conciliacao.service";
import {
  computeImportOrdinals,
  dedupeKeyNatural,
  fileContentHash,
} from "../../credit-card/parsers/dedupe-key";
import { ExpenseModule } from "../../expense/expense.module";
import { ExpenseService } from "../../expense/expense.service";
import { PrismaService } from "../../prisma/prisma.service";
import {
  FIXED_NOW,
  MutableClock,
  seedImportWorld,
  seedSession,
} from "../../test-utils/import-session-harness";
import { CardPurchaseBatchAdapter } from "./card-purchase-batch.adapter";
import { CARD_PURCHASE_BATCH_PORT } from "./card-purchase-batch.port";
import { ImportChatBridge } from "./import-chat.bridge";
import { ImportChatGuard } from "./import-chat.guard";
import { ImportSessionWorkflowService } from "./import-session-workflow.service";
import { ImportSessionInterpretationService } from "./import-session-interpretation.service";
import { ImportRawExecutions } from "./import-session.raw-executions";
import {
  ImportUiGrantIssuer,
  RuntimeUiGrantVerifier,
} from "./import-session-ui-grant";
import {
  IMPORT_SESSION_UI_ORIGINS,
  ImportUiGuard,
} from "./import-session-ui.guard";
import { assertImportAuthForRequest } from "./import-session.auth";
import {
  DefaultImportSessionCapability,
  IMPORT_SESSION_CAPABILITY,
  IMPORT_SESSION_CLOCK,
  IMPORT_SESSION_GRANT_VERIFIER,
  type ImportSessionCapability,
} from "./import-session.capability";
import { ImportSessionController } from "./import-session.controller";
import { IMPORT_SESSION_WRITES_ENABLED } from "./import-session.disabled";
import { ImportSessionModule } from "./import-session.module";
import type { StoredImportObservationEvidenceV1 } from "./import-session.observation";
import { ImportSessionService } from "./import-session.service";
import { validateStoredDraft } from "./import-session.validation";
import { registerImportUploadFraming } from "./vault/vault-framing";
import { parseStoredImportObservationEvidence } from "./import-session.observation";
import { validateDocumentExtraction } from "../../credit-card/parsers/statement-document";
import { IMPORT_VAULT_GATE } from "./vault/vault-state";
import { resolveImportDeclarations } from "./import-session.declarations";

const ORIGIN = "http://localhost:3000";
const UI = { origin: ORIGIN, "x-rf-import-ui": "1" };
const ROOT = resolve(__dirname, "../../../../..");
const evidenceRoot =
  process.env.B3_QA_EVIDENCE ??
  resolve(ROOT, ".agents/b3-workflow-http-evidence");
mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
const evidenceDirectory = mkdtempSync(resolve(evidenceRoot, "workflow-http-"));
const ORIGINAL = Buffer.from("Synthetic HTTP purchase 60000 cents / 3");
const DOCUMENT_HASH = createHash("sha256").update(ORIGINAL).digest("hex");
const FILE_HASH = fileContentHash([ORIGINAL]);
const FINANCIAL_ID = "123e4567-e89b-42d3-a456-426614174000";
const DOCUMENTARY_IDS = {
  declaration: "11111111-1111-4111-8111-111111111111",
  resolution: "22222222-2222-4222-8222-222222222222",
  defer: "33333333-3333-4333-8333-333333333333",
  reactivate: "44444444-4444-4444-8444-444444444444",
  prepareCurrentLot: "55555555-5555-4555-8555-555555555555",
  interpret: "66666666-6666-4666-8666-666666666666",
  continueAnswering: "77777777-7777-4777-8777-777777777777",
} as const;
const ROUTES = [
  ["declaration", "POST", "declarations"],
  ["resolution", "POST", "resolutions"],
  ["defer", "POST", "defer"],
  ["reactivate", "POST", "reactivate"],
  ["prepareCurrentLot", "POST", "current-lot/prepare"],
  ["currentLot", "GET", "current-lot"],
  ["interpret", "POST", "interpretations"],
  ["getObservations", "GET", "observations"],
  ["getCandidates", "GET", "candidates"],
  ["challenge", "POST", "confirmation-challenge"],
  ["confirm", "POST", "confirm"],
  ["execute", "POST", "execute"],
  ["continueAnswering", "POST", "current-lot/continue"],
] as const;
type Route = readonly [
  (typeof ROUTES)[number][0],
  (typeof ROUTES)[number][1],
  (typeof ROUTES)[number][2] | "",
];
type Hook = (
  params: Prisma.MiddlewareParams,
  result: unknown,
) => void | Promise<void>;
type Reply<T = unknown> = { status: number; body: T };
type Harness = {
  app: INestApplication;
  prisma: PrismaService;
  auth: AuthService;
  port: number;
  requests: Request[];
  hook: Hook | null;
};

const clock = new MutableClock(new Date(FIXED_NOW));
const testOnlyCapability: ImportSessionCapability & { enabled: boolean } = {
  enabled: true,
  writesEnabled() {
    return this.enabled;
  },
  newImportFormats: () => [],
};
const wire = (
  code: string,
  extra: {
    sessionId?: string;
    currentRevision?: number;
    retryable?: boolean;
  } = {},
) => ({
  code,
  retryable: false,
  sessionId: null,
  currentRevision: null,
  reason: null,
  ...extra,
});

function object(value: unknown): asserts value is Record<string, unknown> {
  expect(value).not.toBeNull();
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a JSON object after the reached assertion");
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function changedCanonicalPaths(
  before: unknown,
  after: unknown,
  path = "$",
): string[] {
  if (
    canonicalSerialization.canonical(before) ===
    canonicalSerialization.canonical(after)
  )
    return [];
  if (Array.isArray(before) && Array.isArray(after)) {
    return Array.from(
      { length: Math.max(before.length, after.length) },
      (_, index) => index,
    ).flatMap((index) =>
      changedCanonicalPaths(before[index], after[index], `${path}[${index}]`),
    );
  }
  if (isRecord(before) && isRecord(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .sort()
      .flatMap((key) =>
        changedCanonicalPaths(before[key], after[key], `${path}.${key}`),
      );
  }
  return [path];
}

function call<T = unknown>(
  h: Harness,
  method: string,
  path: string,
  options: {
    token?: string;
    cookie?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): Promise<Reply<T>> {
  return new Promise((done, reject) => {
    const payload =
      options.body === undefined ? undefined : JSON.stringify(options.body);
    const headers: Record<string, string> = { ...options.headers };
    if (payload !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(payload));
    }
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.cookie) headers.cookie = `rf_token=${options.cookie}`;
    const request = http.request(
      { host: "127.0.0.1", port: h.port, method, path, headers },
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

async function boot(testOnlyOverride: boolean): Promise<Harness> {
  const { AppModule } = await import("../../app.module");
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(IMPORT_SESSION_CLOCK)
    .useValue(clock)
    .overrideProvider(IMPORT_SESSION_UI_ORIGINS)
    .useValue({ allowed: () => [ORIGIN] });
  if (testOnlyOverride)
    builder = builder
      .overrideProvider(IMPORT_SESSION_CAPABILITY)
      .useValue(testOnlyCapability);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication();
  const h: Harness = {
    app,
    prisma: app.get(PrismaService),
    auth: app.get(AuthService),
    port: 0,
    requests: [],
    hook: null,
  };
  h.prisma.$use(async (params, next) => {
    const result: unknown = await next(params);
    await h.hook?.(params, result);
    return result;
  });
  app.use(cookieParser());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    h.requests.push(req);
    next();
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableCors({ origin: ORIGIN, credentials: true });
  registerImportUploadFraming(app);
  await app.init();
  expect(process.env.DATABASE_URL).toBe(`file:${testDbGuard.ACTIVE_DB_PATH}`);
  expect(realpathSync(testDbGuard.ACTIVE_DB_PATH)).toBe(
    testDbGuard.ACTIVE_DB_PATH,
  );
  chmodSync(testDbGuard.ACTIVE_DB_PATH, 0o600);
  const beforeListen = execFileSync(
    "lsof",
    ["-nP", "-a", "-p", String(process.pid), "-Fn"],
    { encoding: "utf8" },
  );
  writeFileSync(
    resolve(
      evidenceDirectory,
      `${testOnlyOverride ? "active" : "off"}-before-listen.lsof`,
    ),
    beforeListen,
    { mode: 0o600, flag: "wx" },
  );
  const openDatabases = beforeListen
    .split("\n")
    .filter((line) => /^n.*\.(db|sqlite3?)(-(wal|shm|journal))?$/.test(line))
    .map((line) => line.slice(1));
  expect(openDatabases).toContain(testDbGuard.ACTIVE_DB_PATH);
  expect(
    openDatabases.filter(
      (file) =>
        ![
          testDbGuard.ACTIVE_DB_PATH,
          `${testDbGuard.ACTIVE_DB_PATH}-wal`,
          `${testDbGuard.ACTIVE_DB_PATH}-shm`,
          `${testDbGuard.ACTIVE_DB_PATH}-journal`,
        ].includes(file),
    ),
  ).toEqual([]);
  await app.listen(0, "127.0.0.1");
  const address: unknown = app.getHttpServer().address();
  object(address);
  expect(typeof address.port).toBe("number");
  if (typeof address.port !== "number") throw new Error("No ephemeral port");
  h.port = address.port;
  const scheduler = app.get(SchedulerRegistry);
  for (const job of scheduler.getCronJobs().values()) await job.stop();
  for (const name of scheduler.getIntervals()) scheduler.deleteInterval(name);
  for (const name of scheduler.getTimeouts()) scheduler.deleteTimeout(name);
  const db = process.env.DATABASE_URL;
  expect(db).toBe(`file:${ROOT}/prisma/test-worker-1.db`);
  if (db !== `file:${ROOT}/prisma/test-worker-1.db`)
    throw new Error("Refusing an unexpected test database");
  expect(realpathSync(db.slice(5))).toBe(`${ROOT}/prisma/test-worker-1.db`);
  chmodSync(db.slice(5), 0o600);
  const descriptors = execFileSync(
    "lsof",
    ["-a", "-p", String(process.pid), "-Fn"],
    { encoding: "utf8" },
  );
  if (/^n.*\/dev\.db(?:-|$)/m.test(descriptors)) {
    await app.close();
    throw new Error("Refusing application boot with an open real dev.db");
  }
  expect(descriptors).toContain(`n${ROOT}/prisma/test-worker-1.db`);
  console.info(
    JSON.stringify({
      mode: testOnlyOverride ? "TEST_ONLY" : "DEFAULT_OFF",
      pid: process.pid,
      port: h.port,
      database: db,
      openDatabases: descriptors
        .split("\n")
        .filter((line) => /\.db/.test(line)),
    }),
  );
  const live = await call(h, "GET", "/import-sessions");
  expect(live).toEqual({ status: 401, body: wire("UNAUTHENTICATED") });
  return h;
}

async function fixture(
  h: Harness,
  options: {
    observations?: number;
    deferred?: boolean;
    documentaryQuestions?: boolean;
  } = {},
) {
  const world = await seedImportWorld(h.prisma, `http-${randomUUID()}`);
  const target = await h.prisma.project.create({
    data: {
      tenantId: world.tenantId,
      type: "REFORMA",
      name: "Synthetic target",
    },
  });
  await h.prisma.user.update({
    where: { id: world.users.restricted.id },
    data: {
      allowedProjects: JSON.stringify([world.projects.pessoal, target.id]),
    },
  });
  await h.prisma.creditCard.update({
    where: { id: world.cards.pessoal },
    data: { closingDay: 27, dueDay: 5 },
  });
  const row = await seedSession(h.prisma, world, {
    ownerUserId: world.users.restricted.id,
    revision: 7,
  });
  const artifact = await h.prisma.importArtifact.create({
    data: {
      tenantId: world.tenantId,
      ownerProjectId: world.projects.pessoal,
      documentSha256: DOCUMENT_HASH,
      verifiedBytes: ORIGINAL.length,
      detectedFormat: "CSV",
      state: "EXTRACTED",
      parserVersion: "card-local-text-v1",
    },
  });
  const attachment = await h.prisma.importSessionArtifact.create({
    data: {
      tenantId: world.tenantId,
      ownerProjectId: world.projects.pessoal,
      sessionId: row.id,
      artifactId: artifact.id,
      position: 0,
      fileName: "synthetic-http.csv",
      declaredMime: "text/csv",
      declaredBytes: ORIGINAL.length,
      reservedBytes: ORIGINAL.length,
      state: "ATTACHED",
      verifiedAt: FIXED_NOW,
    },
  });
  const count = options.observations ?? 1;
  const ordinals = computeImportOrdinals(
    Array.from({ length: count }, () => ({
      date: new Date("2026-09-25"),
      merchant: "Synthetic HTTP purchase",
      amountCents: 60000,
    })),
  );
  const observationIds: string[] = [];
  const expectedObservations: ImportSessionObservationViewV1[] = [];
  for (let index = 0; index < count; index++) {
    const documentary = options.documentaryQuestions && index === 0;
    const evidence: StoredImportObservationEvidenceV1 = {
      version: 1,
      reference: `csv:record:${index + 2}`,
      text: "Synthetic HTTP purchase",
      amountMeaning: documentary ? "UNKNOWN" : "TOTAL_PURCHASE",
      amountCents: 60000,
      installmentCount: 3,
      installmentIndex: null,
      dataCompra: "2026-09-25",
      identity: {
        merchant: "Synthetic HTTP purchase",
        externalId: null,
        fitId: null,
        ordinal: ordinals[index],
        fileContentHash: FILE_HASH,
      },
    };
    const observation = await h.prisma.importObservation.create({
      data: {
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        artifactId: artifact.id,
        reference: evidence.reference,
        evidenceJson: JSON.stringify(evidence),
      },
    });
    observationIds.push(observation.id);
    expectedObservations.push({
      id: observation.id,
      attachmentId: attachment.id,
      reference: evidence.reference,
      text: evidence.text,
      amountMeaning: "TOTAL_PURCHASE",
      amountCents: 60000,
      installmentCount: 3,
      installmentIndex: null,
      dataCompra: "2026-09-25",
    });
  }
  const draft: ImportSessionStoredDraftV1 = {
    version: 1,
    lines: [
      {
        id: "purchase",
        observationIds: [observationIds[0]],
        titulo: "Synthetic HTTP purchase",
        fornecedor: "Synthetic HTTP purchase",
        tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
        categoriaMaoDeObra: null,
        amountMeaning: "TOTAL_PURCHASE",
        amountCents: 60000,
        installmentCount: 3,
        dataCompra: "2026-09-25",
        firstDueDate: "2026-11-05",
        targets: [{ projectId: target.id, roomId: null, amountCents: 60000 }],
        decision: { kind: "CREATE", acceptNaturalDuplicate: false },
      },
    ],
    selectedLineIds: ["purchase"],
    questions: [],
    fieldProvenance: [
      ...(options.documentaryQuestions
        ? []
        : [
            {
              origin: "FILE" as const,
              lineId: "purchase",
              field: "decision" as const,
              recordedRevision: 7,
            },
          ]),
      {
        origin: "FILE",
        lineId: "purchase",
        field: "targets",
        recordedRevision: 7,
      },
      {
        origin: "FILE",
        lineId: "purchase",
        field: "tipoDespesa",
        recordedRevision: 7,
      },
    ],
    scope: { observationIds, pendingAttachmentIds: [] },
  };
  if (options.deferred) {
    const evidence: StoredImportObservationEvidenceV1 = {
      version: 1,
      reference: "csv:record:1001",
      text: "Synthetic unresolved observation",
      amountMeaning: "UNKNOWN",
      amountCents: null,
      installmentCount: null,
      installmentIndex: null,
      dataCompra: null,
      identity: {
        merchant: null,
        externalId: null,
        fitId: null,
        ordinal: null,
        fileContentHash: null,
      },
    };
    const pending = await h.prisma.importObservation.create({
      data: {
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        artifactId: artifact.id,
        reference: evidence.reference,
        evidenceJson: JSON.stringify(evidence),
        claimVersion: 3,
      },
    });
    const pendingAttachment = await h.prisma.importSessionArtifact.create({
      data: {
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        sessionId: row.id,
        position: 1,
        fileName: "pending.csv",
        declaredMime: "text/csv",
        declaredBytes: 11,
        reservedBytes: 11,
        state: "FAILED",
        temporaryPurgePending: true,
        uploadGeneration: 4,
      },
    });
    draft.scope.observationIds.push(pending.id);
    draft.scope.pendingAttachmentIds.push(pendingAttachment.id);
    draft.lines.push({
      id: "deferred",
      observationIds: [pending.id],
      titulo: "Synthetic unresolved purchase",
      fornecedor: null,
      tipoDespesa: null,
      categoriaMaoDeObra: null,
      amountMeaning: "UNKNOWN",
      amountCents: null,
      installmentCount: null,
      dataCompra: null,
      firstDueDate: null,
      targets: null,
      decision: { kind: "UNRESOLVED" },
    });
    draft.questions.push({
      id: "pending-question",
      lineIds: ["deferred"],
      field: "amountCents",
      text: "Synthetic question",
    });
  }
  await freezeExtraction(h.prisma, artifact.id);
  if (options.documentaryQuestions) {
    const observations = await h.prisma.importObservation.findMany({
      where: { id: { in: observationIds } },
    });
    draft.questions = resolveImportDeclarations(row, draft, {
      observations,
      references: [{ ref: attachment, artifact }],
    }).questions as unknown as typeof draft.questions;
  } else {
    validateStoredDraft(draft);
  }
  await h.prisma.importSession.update({
    where: { id: row.id },
    data: { draftJson: JSON.stringify(draft) },
  });
  const token = await tokenFor(h, world.users.restricted.id);
  return {
    world,
    target,
    row,
    artifact,
    attachment,
    draft,
    token,
    expectedObservations,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function tokenFor(h: Harness, userId: string) {
  return h.auth.issueToken(
    await h.prisma.user.findUniqueOrThrow({ where: { id: userId } }),
  );
}
function input(route: Route, f: Fixture): Record<string, unknown> {
  switch (route[0]) {
    case "declaration":
      return {
        version: 1,
        requestId: DOCUMENTARY_IDS.declaration,
        expectedRevision: 7,
        questionId: "pending-question",
        answer: { kind: "KNOWN", value: 60000 },
      };
    case "resolution":
      return {
        version: 1,
        requestId: DOCUMENTARY_IDS.resolution,
        expectedRevision: 7,
        questionId: "pending-question",
        answer: { kind: "CENTS", value: 60000 },
      };
    case "defer":
      return {
        version: 1,
        requestId: DOCUMENTARY_IDS.defer,
        expectedRevision: 7,
        lineId: "purchase",
      };
    case "reactivate":
      return {
        version: 1,
        requestId: DOCUMENTARY_IDS.reactivate,
        expectedRevision: 7,
        lineId: "purchase",
      };
    case "prepareCurrentLot":
      return {
        version: 1,
        requestId: DOCUMENTARY_IDS.prepareCurrentLot,
        expectedRevision: 7,
      };
    case "currentLot":
      return {};
    case "continueAnswering":
      return {
        version: 1,
        requestId: DOCUMENTARY_IDS.continueAnswering,
        expectedRevision: 8,
      };
    case "interpret":
      return {
        version: 1,
        requestId: DOCUMENTARY_IDS.interpret,
        expectedRevision: 7,
        questionId: "pending-question",
        text: "R$ 600,00",
        consentExternalProcessing: true,
      };
    case "getObservations":
      return {};
    case "getCandidates":
      return { lineId: "purchase" };
    case "challenge":
      return { expectedRevision: 7, confirmationHash: "a".repeat(64) };
    case "confirm":
      return {
        expectedRevision: 7,
        confirmationHash: "a".repeat(64),
        financialRequestId: FINANCIAL_ID,
        nonce: null,
      };
    case "execute":
      return { financialRequestId: f.row.financialRequestId ?? FINANCIAL_ID };
  }
}
function invoke<T = unknown>(
  h: Harness,
  f: Fixture,
  route: Route,
  options: {
    data?: Record<string, unknown>;
    id?: string;
    token?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const data = options.data ?? input(route, f);
  const query =
    route[1] === "GET"
      ? `?${new URLSearchParams(Object.entries(data).map(([k, v]) => [k, String(v)]))}`
      : "";
  return call<T>(
    h,
    route[1],
    `/import-sessions/${options.id ?? f.row.id}/${route[2]}${query}`,
    {
      token: options.token ?? f.token,
      headers: options.headers ?? UI,
      ...(route[1] === "GET" ? {} : { body: data }),
    },
  );
}

async function snapshot(h: Harness, f: Fixture) {
  const where = () => ({ tenantId: f.world.tenantId });
  const orderBy = { id: "asc" } as const;
  return {
    sessions: await h.prisma.importSession.findMany({
      where: where(),
      orderBy,
    }),
    artifacts: await h.prisma.importArtifact.findMany({
      where: where(),
      orderBy,
    }),
    attachments: await h.prisma.importSessionArtifact.findMany({
      where: where(),
      orderBy,
    }),
    observations: await h.prisma.importObservation.findMany({
      where: where(),
      orderBy,
    }),
    expenses: await h.prisma.expense.findMany({ where: where(), orderBy }),
    cfes: await h.prisma.cashFlowEntry.findMany({ where: where(), orderBy }),
    allocations: await h.prisma.rateioAllocation.findMany({
      where: where(),
      orderBy,
    }),
    receipts: await h.prisma.receipt.findMany({ where: where(), orderBy }),
    accounts: await h.prisma.bankAccount.findMany({ where: where(), orderBy }),
    cards: await h.prisma.creditCard.findMany({ where: where(), orderBy }),
    cardImports: await h.prisma.creditCardStatementImport.findMany({
      where: where(),
      orderBy,
    }),
    bankImports: await h.prisma.bankStatementImport.findMany({
      where: where(),
      orderBy,
    }),
    settlements: await h.prisma.crossProjectSettlement.findMany({
      where: where(),
      orderBy,
    }),
    liquidations: await h.prisma.importedInvoiceLiquidation.findMany({
      where: where(),
      orderBy,
    }),
    adjustments: await h.prisma.invoiceAdjustment.findMany({
      where: where(),
      orderBy,
    }),
    funding: await h.prisma.invoiceFundingAllocation.findMany({
      where: where(),
      orderBy,
    }),
    reconciliation: await h.prisma.invoiceReconciliationSource.findMany({
      where: where(),
      orderBy,
    }),
    replayOperations: await h.prisma.invoiceReplayOperation.findMany({
      where: where(),
      orderBy,
    }),
    budgetAllocations: await h.prisma.budgetAllocation.findMany({
      where: where(),
      orderBy,
    }),
    audit: await h.prisma.userActivityLog.findMany({
      where: { ...where(), action: "importSessions.execute" },
      orderBy,
    }),
  };
}

async function prepare(h: Harness, f: Fixture): Promise<ImportCurrentLotV1> {
  const prepared = await invoke<ImportDocumentaryCommandReceiptV1>(
    h,
    f,
    ROUTES[4],
  );
  expect(prepared).toEqual({
    status: 200,
    body: {
      version: 1,
      requestId: DOCUMENTARY_IDS.prepareCurrentLot,
      operation: "PREPARE_CURRENT_LOT",
      outcome: "CURRENT_LOT_READY",
      revision: 8,
    },
  });
  const response = await call<ImportSessionViewV1>(
    h,
    "GET",
    `/import-sessions/${f.row.id}`,
    { token: f.token },
  );
  expect(response.status).toBe(200);
  object(response.body);
  const selectedLineIds = new Set(response.body.selectedLineIds);
  const currentLotObservationIds = new Set(
    f.draft.lines
      .filter((line) => selectedLineIds.has(line.id))
      .flatMap((line) => line.observationIds),
  );
  const expectedRemainingWork =
    f.draft.scope.pendingAttachmentIds.length > 0 ||
    f.draft.scope.observationIds.some(
      (observationId) => !currentLotObservationIds.has(observationId),
    );
  expect(Object.keys(response.body).sort()).toEqual(
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
      ...(response.body.guidedReview === undefined ? [] : ["guidedReview"]),
      "actions",
    ].sort(),
  );
  expect(response.body).toMatchObject({
    version: 1,
    id: f.row.id,
    ownerProjectId: f.world.projects.pessoal,
    cardId: f.world.cards.pessoal,
    state: "READY",
    revision: 8,
    searchComplete: true,
    confirmation: null,
    receipt: null,
    declaredFacts: [],
    ...(response.body.guidedReview === undefined
      ? {}
      : {
          guidedReview: {
            progress: expectedRemainingWork ? "READY_WITH_PENDING" : "READY",
            focus: null,
            actions: expectedRemainingWork
              ? ["CONTINUE_ANSWERING", "REVIEW_READY"]
              : ["REVIEW_READY"],
          },
        }),
    actions: ["CANCEL", "RESOLVE", "PREPARE"],
    selectedLineIds: ["purchase"],
    proposal: null,
  });
  const currentLot = await invoke<ImportCurrentLotV1>(h, f, ROUTES[5], {
    headers: {},
  });
  expect(currentLot).toEqual({
    status: 200,
    body: expect.objectContaining({
      version: 1,
      state: expectedRemainingWork ? "READY_WITH_PENDING" : "READY",
      revision: 8,
      confirmationHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      createdEconomicTotalCents: 60000,
      bankCashDeltaCents: 0,
      hasRemainingWork: expectedRemainingWork,
    }),
  });
  expect(currentLot.body.purchases).toHaveLength(1);
  return currentLot.body;
}
async function challenge(h: Harness, f: Fixture, ready: ImportCurrentLotV1) {
  const response = await invoke<ImportSessionChallengeResponseV1>(
    h,
    f,
    ROUTES[9],
    {
      data: {
        expectedRevision: 8,
        confirmationHash: ready.confirmationHash,
      },
    },
  );
  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    nonce: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    expiresAt: new Date(clock.now().getTime() + 300000).toISOString(),
  });
  const body = response.body;
  return {
    body,
    confirmation: {
      expectedRevision: 8,
      confirmationHash: ready.confirmationHash,
      financialRequestId: FINANCIAL_ID,
      nonce: body.nonce,
    } satisfies ImportSessionConfirmRequestV1,
  };
}
async function confirmed(h: Harness, f: Fixture) {
  const ready = await prepare(h, f);
  const c = await challenge(h, f, ready);
  const response = await invoke(h, f, ROUTES[10], {
    data: { ...c.confirmation },
  });
  expect(response).toEqual({
    status: 200,
    body: {
      sessionId: f.row.id,
      financialRequestId: FINANCIAL_ID,
      state: "CONFIRMED",
    },
  });
  return { ready, ...c };
}
async function execute(
  h: Harness,
  f: Fixture,
): Promise<ImportSessionReceiptV1> {
  const response = await invoke<ImportSessionReceiptV1>(h, f, ROUTES[11]);
  expect(response.status).toBe(200);
  object(response.body);
  expect(Object.keys(response.body).sort()).toEqual(
    [
      "version",
      "sessionId",
      "financialRequestId",
      "confirmedRevision",
      "bindingVersion",
      "confirmationHash",
      "appliedAt",
      "continuationSessionId",
      "items",
      "auditItems",
      "snapshot",
    ].sort(),
  );
  return response.body;
}
function assertOriginalGrant(
  h: Harness,
  issued: Parameters<ImportUiGrantIssuer["issueFinancialAction"]>,
  verified: Parameters<RuntimeUiGrantVerifier["verifyFinancialAction"]>,
) {
  const [request, auth, scope] = issued;
  expect(h.requests).toContain(request);
  expect(verified[1]).toBe(auth);
  expect(verified[2]).toEqual(scope);
  // The production assertion consults the private request -> auth WeakMap.
  assertImportAuthForRequest(request, auth);
}

describe("M1 inactive HTTP/DI independent RED (real AppModule)", () => {
  let off: Harness;
  let active: Harness;
  const savedEnvironment = new Map<string, string | undefined>();
  let nowSpy: jest.SpyInstance;
  const ENV_KEYS = [
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GROQ_API_KEY",
    "CEREBRAS_API_KEY",
    "OLLAMA_API_KEY",
    "AGENT_LLM_PROVIDER",
    "AGENT_LLM_FALLBACK",
    "JWT_SECRET",
    "CORS_ORIGIN",
    "VIBEVOICE_WS_URL",
  ];

  beforeAll(async () => {
    for (const key of ENV_KEYS) {
      savedEnvironment.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.JWT_SECRET = "synthetic-http-test-only-not-a-credential";
    process.env.CORS_ORIGIN = ORIGIN;
    process.env.AGENT_LLM_PROVIDER = "ollama";
    nowSpy = jest
      .spyOn(Date, "now")
      .mockImplementation(() => clock.now().getTime());
    off = await boot(false);
    active = await boot(true);
  });
  beforeEach(() => {
    clock.current = new Date(FIXED_NOW);
    testOnlyCapability.enabled = true;
    off.requests.length = 0;
    active.requests.length = 0;
  });
  afterEach(() => {
    off.hook = null;
    active.hook = null;
    // Date.now remains pinned without fake timers interfering with Prisma or HTTP teardown.
    jest.restoreAllMocks();
    nowSpy = jest
      .spyOn(Date, "now")
      .mockImplementation(() => clock.now().getTime());
  });
  afterAll(async () => {
    if (active) await active.app.close();
    if (off) await off.app.close();
    nowSpy?.mockRestore();
    for (const [key, value] of savedEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("registers_eighteen_literal_routes_and_private_real_factories: literal routes and metadata", () => {
    const prototype = ImportSessionController.prototype;
    const methods = Object.getOwnPropertyNames(prototype)
      .filter((name) => name !== "constructor")
      .map((name) => {
        const handler: unknown = Reflect.get(prototype, name);
        if (typeof handler !== "function")
          throw new Error("Non-function handler");
        return {
          name,
          path: Reflect.getMetadata(PATH_METADATA, handler),
          method: Reflect.getMetadata(METHOD_METADATA, handler),
          owned: Reflect.getMetadata(SERVICE_OWNED_PROJECT_ACCESS_KEY, handler),
          ui: (Reflect.getMetadata(GUARDS_METADATA, handler) ?? []).includes(
            ImportUiGuard,
          ),
        };
      });
    const expected = [
      ["create", "/", RequestMethod.POST, true],
      ["list", "/", RequestMethod.GET, false],
      ["getSession", ":id", RequestMethod.GET, false],
      ["getResult", ":id/result", RequestMethod.GET, false],
      ["cancel", ":id/cancel", RequestMethod.POST, true],
      ["declaration", ":id/declarations", RequestMethod.POST, true],
      ["resolution", ":id/resolutions", RequestMethod.POST, true],
      ["defer", ":id/defer", RequestMethod.POST, true],
      ["reactivate", ":id/reactivate", RequestMethod.POST, true],
      [
        "prepareCurrentLot",
        ":id/current-lot/prepare",
        RequestMethod.POST,
        true,
      ],
      [
        "continueAnswering",
        ":id/current-lot/continue",
        RequestMethod.POST,
        true,
      ],
      ["currentLot", ":id/current-lot", RequestMethod.GET, false],
      ["interpret", ":id/interpretations", RequestMethod.POST, true],
      ["getObservations", ":id/observations", RequestMethod.GET, false],
      ["getCandidates", ":id/candidates", RequestMethod.GET, false],
      ["challenge", ":id/confirmation-challenge", RequestMethod.POST, true],
      ["confirm", ":id/confirm", RequestMethod.POST, true],
      ["execute", ":id/execute", RequestMethod.POST, true],
    ].map(([name, path, method, ui]) => ({
      name,
      path,
      method,
      ui,
      owned: true,
    }));
    expect(methods.sort((a, b) => a.name.localeCompare(b.name))).toEqual(
      expected.sort((a, b) => String(a.name).localeCompare(String(b.name))),
    );
    expect(methods).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: RequestMethod.PATCH,
          path: ":id/draft",
        }),
        expect.objectContaining({
          method: RequestMethod.POST,
          path: ":id/prepare",
        }),
      ]),
    );
  });

  it("retired generic draft and prepare routes stay unreachable without writes", async () => {
    const f = await fixture(active);
    const before = await snapshot(active, f);
    for (const [method, suffix] of [
      ["PATCH", "draft"],
      ["POST", "prepare"],
    ] as const) {
      const response = await call(
        active,
        method,
        `/import-sessions/${f.row.id}/${suffix}`,
        {
          token: f.token,
          headers: UI,
          body: {
            version: 1,
            requestId: randomUUID(),
            expectedRevision: 7,
          },
        },
      );
      expect(response).toEqual({
        status: 404,
        body: {
          message: `Cannot ${method} /import-sessions/${f.row.id}/${suffix}`,
          error: "Not Found",
          statusCode: 404,
        },
      });
    }
    expect(await snapshot(active, f)).toEqual(before);
  });

  it("registers_eighteen_literal_routes_and_private_real_factories: required real private DI", () => {
    const imports: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      ImportSessionModule,
    );
    expect(imports).toEqual(
      expect.arrayContaining([ExpenseModule, ConciliacaoModule]),
    );
    expect(
      Reflect.getMetadata(MODULE_METADATA.EXPORTS, ImportSessionModule) ?? [],
    ).toEqual([ImportChatGuard, ImportChatBridge]);
    const providers: unknown[] = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      ImportSessionModule,
    );
    expect(providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provide: CARD_PURCHASE_BATCH_PORT,
          useFactory: expect.any(Function),
          inject: [ExpenseService, ConciliacaoService, IMPORT_SESSION_CLOCK],
        }),
        expect.objectContaining({
          provide: ImportSessionWorkflowService,
          useFactory: expect.any(Function),
          inject: [
            PrismaService,
            IMPORT_SESSION_CLOCK,
            IMPORT_SESSION_CAPABILITY,
            IMPORT_SESSION_GRANT_VERIFIER,
            CARD_PURCHASE_BATCH_PORT,
            IMPORT_VAULT_GATE,
            ImportRawExecutions,
          ],
        }),
      ]),
    );
    expect(off.app.get(CARD_PURCHASE_BATCH_PORT)).toBeInstanceOf(
      CardPurchaseBatchAdapter,
    );
    expect(off.app.get(ImportSessionWorkflowService)).toBeInstanceOf(
      ImportSessionWorkflowService,
    );
    expect(off.app.get(ImportSessionService)).toBeInstanceOf(
      ImportSessionService,
    );
  });

  it("default_off_preserves_the_five_existing_handlers", async () => {
    expect(IMPORT_SESSION_WRITES_ENABLED).toBe(false);
    expect(off.app.get(IMPORT_SESSION_CAPABILITY)).toBeInstanceOf(
      DefaultImportSessionCapability,
    );
    expect(off.app.get(IMPORT_SESSION_CAPABILITY).writesEnabled()).toBe(false);
    const f = await fixture(off);
    const before = await snapshot(off, f);
    expect(
      await call(off, "POST", "/import-sessions", {
        token: f.token,
        headers: UI,
        body: {
          version: 1,
          createRequestId: randomUUID(),
          cardId: f.world.cards.pessoal,
          consentPolicyVersion: 1,
          consentAnalyze: true,
        },
      }),
    ).toEqual({
      status: 503,
      body: wire("CAPABILITY_DISABLED", { retryable: true }),
    });
    const session = await call(off, "GET", `/import-sessions/${f.row.id}`, {
      cookie: f.token,
    });
    expect(session.status).toBe(200);
    expect(session.body).toEqual({
      version: 1,
      reviewBlockers: [],
      declaredFacts: [],
      id: f.row.id,
      ownerProjectId: f.world.projects.pessoal,
      cardId: f.world.cards.pessoal,
      state: "DRAFT",
      revision: 7,
      expiresAt: f.row.expiresAt.toISOString(),
      lines: f.draft.lines,
      selectedLineIds: ["purchase"],
      questions: [],
      attachments: [
        {
          id: f.attachment.id,
          materializedInSession: true,
          canAnalyze: false,
          fileName: "synthetic-http.csv",
          declaredBytes: ORIGINAL.length,
          state: "ATTACHED",
        },
      ],
      searchComplete: false,
      proposal: null,
      confirmation: null,
      receipt: null,
      actions: ["CANCEL"],
    });
    const list = await call(off, "GET", "/import-sessions", { token: f.token });
    expect(list).toEqual({
      status: 200,
      body: {
        entry: {
          kind: "UNAVAILABLE",
          version: 1,
          reason: "NOT_ENABLED",
        },
        items: [
          {
            id: f.row.id,
            state: "DRAFT",
            revision: 7,
            cardId: f.world.cards.pessoal,
            ownerProjectId: f.world.projects.pessoal,
            createdAt: f.row.createdAt.toISOString(),
            expiresAt: f.row.expiresAt.toISOString(),
            appliedAt: null,
            attachmentCount: 1,
            hasConfirmation: false,
            continuationSessionId: null,
            actions: ["CANCEL"],
          },
        ],
        nextCursor: null,
      },
    });
    expect(
      await call(off, "GET", `/import-sessions/${f.row.id}/result`, {
        token: f.token,
      }),
    ).toEqual({ status: 200, body: { state: "DRAFT", receipt: null } });
    expect(await snapshot(off, f)).toEqual(before);
    const cancelled = await call(
      off,
      "POST",
      `/import-sessions/${f.row.id}/cancel`,
      {
        token: f.token,
        headers: UI,
        body: { expectedRevision: 7 },
      },
    );
    expect(cancelled).toEqual({
      status: 200,
      body: {
        reviewBlockers: [],
        declaredFacts: [],
        version: 1,
        id: f.row.id,
        ownerProjectId: f.world.projects.pessoal,
        cardId: f.world.cards.pessoal,
        state: "CANCELLED",
        revision: 8,
        expiresAt: null,
        lines: [],
        selectedLineIds: [],
        questions: [],
        attachments: [],
        searchComplete: false,
        proposal: null,
        confirmation: null,
        receipt: null,
        actions: [],
      },
    });
    const after = await snapshot(off, f);
    expect(after.expenses).toEqual([]);
    expect(after.cfes).toEqual([]);
    expect(after.audit).toEqual([]);
  });

  it("keeps documentary questions authoritative through prepare before exposing a guided decision", async () => {
    const f = await fixture(active, { documentaryQuestions: true });
    expect(validateStoredDraft(f.draft)).toEqual(f.draft);
    const originalDocumentary = f.draft.questions.map((question) =>
      JSON.parse(JSON.stringify(question)),
    );

    const firstPrepare = await invoke(active, f, ROUTES[4]);
    expect(firstPrepare).toEqual({
      status: 200,
      body: {
        version: 1,
        requestId: DOCUMENTARY_IDS.prepareCurrentLot,
        operation: "PREPARE_CURRENT_LOT",
        outcome: "NEEDS_INPUT",
        revision: 8,
      },
    });
    let revision = 8;
    let view = await call<ImportSessionViewV1>(
      active,
      "GET",
      `/import-sessions/${f.row.id}`,
      { token: f.token },
    );
    expect(view.status).toBe(200);
    const documentary = view.body.questions.filter(
      (question) =>
        "subject" in question && question.answerState === "UNANSWERED",
    );
    expect(documentary).toEqual(originalDocumentary);
    expect(documentary).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: expect.objectContaining({ kind: "OBSERVATION" }),
          answerState: "UNANSWERED",
        }),
      ]),
    );
    const rawGuided = view.body.questions.find(
      (question) => !("subject" in question) && question.field === "decision",
    );
    expect(rawGuided).toBeDefined();
    expect(Object.keys(rawGuided ?? {}).sort()).toEqual(
      ["field", "id", "lineIds", "text"].sort(),
    );
    expect(view.body.guidedReview).toMatchObject({
      progress: "ANSWERING",
      focus: null,
      actions: ["CONTINUE_ANSWERING"],
    });

    let remaining = documentary.length;
    let documentaryAnswers = 0;
    while (remaining > 0) {
      documentaryAnswers += 1;
      if (documentaryAnswers > 6)
        throw new Error("Documentary questions did not converge");
      const question = view.body.questions.find(
        (candidate) =>
          "subject" in candidate && candidate.answerState === "UNANSWERED",
      );
      if (!question || !("subject" in question))
        throw new Error("Expected the next documentary question");
      const value =
        question.field === "amountMeaning" ? "TOTAL_PURCHASE" : null;
      if (value === null)
        throw new Error(`Unexpected documentary field ${question.field}`);
      const answer = await invoke(active, f, ROUTES[0], {
        data: {
          version: 1,
          requestId: randomUUID(),
          expectedRevision: revision,
          questionId: question.id,
          answer: { kind: "KNOWN", value },
        },
      });
      expect(answer.status).toBe(200);
      revision += 1;
      view = await call<ImportSessionViewV1>(
        active,
        "GET",
        `/import-sessions/${f.row.id}`,
        { token: f.token },
      );
      expect(view.status).toBe(200);
      const nextDocumentary = view.body.questions.filter(
        (candidate) =>
          "subject" in candidate && candidate.answerState === "UNANSWERED",
      );
      expect(
        nextDocumentary.some((candidate) => candidate.id === question.id),
      ).toBe(false);
      remaining = nextDocumentary.length;
    }

    expect(view.body.guidedReview).toMatchObject({
      progress: "ANSWERING",
      focus: null,
      actions: ["CONTINUE_ANSWERING"],
    });
    const secondPrepare = await invoke(active, f, ROUTES[4], {
      data: {
        version: 1,
        requestId: randomUUID(),
        expectedRevision: revision,
      },
    });
    expect(secondPrepare.status).toBe(200);
    revision += 1;
    view = await call<ImportSessionViewV1>(
      active,
      "GET",
      `/import-sessions/${f.row.id}`,
      { token: f.token },
    );
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({
      state: "NEEDS_INPUT",
      revision,
      searchComplete: true,
      guidedReview: {
        progress: "ANSWERING",
        focus: {
          lineId: "purchase",
          control: "DECISION",
        },
        actions: ["CONTINUE_ANSWERING"],
      },
    });
  });

  it.each(ROUTES)(
    "binds_every_new_handler_to_its_real_service: %s",
    async (...route) => {
      const f = await fixture(off);
      let target: jest.SpyInstance;
      if (route[0] === "getObservations" || route[0] === "getCandidates") {
        target = jest.spyOn(ImportSessionService.prototype, route[0]);
      } else if (route[0] === "interpret") {
        target = jest.spyOn(
          ImportSessionInterpretationService.prototype,
          "interpret",
        );
      } else if (route[0] === "declaration") {
        target = jest.spyOn(ImportSessionWorkflowService.prototype, "declare");
      } else if (route[0] === "resolution") {
        target = jest.spyOn(ImportSessionWorkflowService.prototype, "resolve");
      } else {
        target = jest.spyOn(ImportSessionWorkflowService.prototype, route[0]);
      }
      const response = await invoke(off, f, route);
      expect(response.status).toBe(
        route[0] === "getObservations" || route[0] === "getCandidates"
          ? 200
          : route[0] === "currentLot" || route[0] === "execute"
            ? 409
            : 503,
      );
      expect(target).toHaveBeenCalledTimes(1);
      const [auth, id, body] = target.mock.calls[0];
      expect(id).toBe(f.row.id);
      expect(body).toEqual(
        route[0] === "currentLot" ? undefined : input(route, f),
      );
      assertImportAuthForRequest(off.requests[0], auth);
      expect(auth).toEqual({
        tenantId: f.world.tenantId,
        userId: f.world.users.restricted.id,
        presentedSessionVersion: 0,
        tokenExpiresAt: expect.any(String),
      });
      if (route[0] === "getObservations" || route[0] === "getCandidates") {
        expect(response.body).toEqual({
          items: route[0] === "getObservations" ? f.expectedObservations : [],
          nextCursor: null,
        });
      } else if (route[0] === "currentLot")
        expect(response.body).toEqual(
          wire("STALE_PREVIEW", {
            sessionId: f.row.id,
            currentRevision: 7,
          }),
        );
      else if (route[0] === "execute")
        expect(response.body).toEqual(
          wire("IDEMPOTENCY_CONFLICT", {
            sessionId: f.row.id,
            currentRevision: 7,
          }),
        );
      else
        expect(response.body).toEqual(
          wire("CAPABILITY_DISABLED", { retryable: true }),
        );
    },
  );

  it.each(
    ROUTES.filter((route) => route[1] !== "GET" && route[0] !== "confirm"),
  )(
    "malformed_request_shape_is_uniform_before_session_lookup: nonce is not authority for %s",
    async (...route) => {
      const f = await fixture(off);
      const hidden = await seedSession(off.prisma, f.world);
      for (const id of [f.row.id, hidden.id, randomUUID()]) {
        expect(
          await invoke(off, f, route, {
            id,
            data: { ...input(route, f), nonce: "not-authority" },
          }),
        ).toEqual({ status: 400, body: wire("INVALID_INPUT") });
      }
    },
  );

  describe.each(["absent", "invalid", "expired", "revoked"] as const)(
    "jwt_failure_precedes_ui_body_and_visibility: %s",
    (kind) => {
      it.each(ROUTES)("%s", async (...route) => {
        const f = await fixture(off);
        let token = kind === "invalid" ? "not-a-token" : undefined;
        if (kind === "expired")
          token = new JwtService({
            secret: process.env.JWT_SECRET,
          }).sign(
            {
              sub: f.world.users.restricted.id,
              tenantId: f.world.tenantId,
              sv: 0,
            },
            { expiresIn: -1 },
          );
        if (kind === "revoked") {
          token = f.token;
          await off.prisma.user.update({
            where: { id: f.world.users.restricted.id },
            data: { sessionVersion: 1 },
          });
        }
        const response = await call(
          off,
          route[1],
          `/import-sessions/${randomUUID()}/${route[2]}`,
          {
            token,
            body: { tenantId: "hidden", expectedRevision: "invalid" },
          },
        );
        expect(response).toEqual({
          status: 401,
          body: wire("UNAUTHENTICATED"),
        });
      });
    },
  );

  it("collection_queries_preserve_cursor_binding_and_opacity: real candidate pages 25+1 and selected line binding", async () => {
    const f = await fixture(active, { observations: 2 });
    f.draft.lines.push({
      ...f.draft.lines[0],
      id: "other-purchase",
      observationIds: [f.draft.scope.observationIds[1]],
    });
    f.draft.selectedLineIds.push("other-purchase");
    f.draft.fieldProvenance?.push(
      {
        origin: "FILE",
        lineId: "other-purchase",
        field: "decision",
        recordedRevision: 7,
      },
      {
        origin: "FILE",
        lineId: "other-purchase",
        field: "targets",
        recordedRevision: 7,
      },
      {
        origin: "FILE",
        lineId: "other-purchase",
        field: "tipoDespesa",
        recordedRevision: 7,
      },
    );
    validateStoredDraft(f.draft);
    await active.prisma.importSession.update({
      where: { id: f.row.id },
      data: { draftJson: JSON.stringify(f.draft) },
    });
    const naturalKey = dedupeKeyNatural({
      tenantId: f.world.tenantId,
      projectId: f.world.projects.pessoal,
      date: new Date("2026-09-25T00:00:00.000Z"),
      merchant: "Synthetic HTTP purchase",
      amountCents: 60000,
      ordinal: 0,
    });
    const expected: ImportSessionCandidateV1[] = [];
    for (let index = 0; index < 26; index++) {
      const historic = await active.prisma.expense.create({
        data: {
          tenantId: f.world.tenantId,
          projectId: f.world.projects.pessoal,
          titulo: `Synthetic historical purchase ${index}`,
          fornecedor: "Synthetic HTTP purchase",
          tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
          valor: 60000,
          quantidade: 1,
          valorTotal: 60000,
          formaPagamento: "PARCELADO",
          quantidadeParcela: 3,
          status: "PLANEJADO",
          cardLast4: "1234",
          dataCompra: new Date("2026-09-25T00:00:00.000Z"),
          dedupeKeyNatural: naturalKey,
        },
      });
      expected.push({
        lineId: "purchase",
        kind: "EXPENSE",
        id: historic.id,
        projectId: f.world.projects.pessoal,
        description: `Synthetic historical purchase ${index}`,
        amountCents: 60000,
        date: "2026-09-25",
        reason: "NATURAL_MATCH",
        canKeepExisting: false,
      });
    }
    expected.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const before = await snapshot(active, f);
    const preparedReceipt = await invoke(active, f, ROUTES[4]);
    expect(preparedReceipt).toEqual({
      status: 200,
      body: {
        version: 1,
        requestId: DOCUMENTARY_IDS.prepareCurrentLot,
        operation: "PREPARE_CURRENT_LOT",
        outcome: "NEEDS_INPUT",
        revision: 8,
      },
    });
    const prepared = await call(active, "GET", `/import-sessions/${f.row.id}`, {
      token: f.token,
    });
    expect(prepared.status).toBe(200);
    object(prepared.body);
    expect(prepared.body).toMatchObject({
      state: "NEEDS_INPUT",
      revision: 8,
      searchComplete: true,
      proposal: null,
    });
    expect(prepared.body.questions).toEqual([
      expect.objectContaining({ field: "decision", lineIds: ["purchase"] }),
      expect.objectContaining({
        field: "decision",
        lineIds: ["other-purchase"],
      }),
    ]);
    const after = await snapshot(active, f);
    expect(after.expenses).toEqual(before.expenses);
    expect(after.cfes).toEqual(before.cfes);
    expect(after.allocations).toEqual(before.allocations);
    expect(after.receipts).toEqual(before.receipts);
    expect(after.audit).toEqual(before.audit);
    const first = await invoke<ImportSessionPageV1<ImportSessionCandidateV1>>(
      active,
      f,
      ROUTES[8],
    );
    expect(first).toEqual({
      status: 200,
      body: {
        items: expected.slice(0, 25),
        nextCursor: expect.any(String),
      },
    });
    expect(
      await invoke(active, f, ROUTES[8], {
        data: { lineId: "purchase", cursor: first.body.nextCursor },
      }),
    ).toEqual({
      status: 200,
      body: { items: expected.slice(25), nextCursor: null },
    });
    expect(
      await invoke(active, f, ROUTES[8], {
        data: { lineId: "other-purchase", cursor: first.body.nextCursor },
      }),
    ).toEqual({ status: 400, body: wire("INVALID_INPUT") });
    expect(
      await invoke(active, f, ROUTES[7], {
        data: { cursor: first.body.nextCursor },
      }),
    ).toEqual({ status: 400, body: wire("INVALID_INPUT") });
    const hiddenToken = await tokenFor(active, f.world.users.peer.id);
    expect(
      await invoke(active, f, ROUTES[8], {
        token: hiddenToken,
        data: { lineId: "purchase", cursor: `${first.body.nextCursor}A` },
      }),
    ).toEqual({ status: 404, body: wire("NOT_FOUND") });
  });

  describe.each<Record<string, string>>([
    {},
    { origin: ORIGIN },
    { "x-rf-import-ui": "1" },
    { origin: "https://untrusted.invalid", "x-rf-import-ui": "1" },
    { origin: ORIGIN, "x-rf-import-ui": "true" },
  ])("ui_guard_precedes_mutation_parsing_but_not_reads: %j", (headers) => {
    it.each(ROUTES)("%s", async (...route) => {
      const f = await fixture(off);
      const issue = jest.spyOn(
        ImportUiGrantIssuer.prototype,
        "issueFinancialAction",
      );
      const response = await invoke(off, f, route, {
        headers,
        ...(route[1] === "GET" ? {} : { data: { invalid: true } }),
      });
      expect(response.status).toBe(
        route[1] !== "GET" ? 403 : route[0] === "currentLot" ? 409 : 200,
      );
      if (route[1] !== "GET") {
        expect(response.body).toEqual(wire("UI_ACTION_REQUIRED"));
      } else if (route[0] === "currentLot") {
        expect(response.body).toEqual(
          wire("STALE_PREVIEW", {
            sessionId: f.row.id,
            currentRevision: 7,
          }),
        );
      }
      expect(issue).not.toHaveBeenCalled();
    });
  });

  describe.each([
    "tenantId",
    "projectId",
    "sourceProjectId",
    "targetProjectId",
    "grant",
    "confirmed",
    "scope",
  ] as const)(
    "malformed_request_shape_is_uniform_before_session_lookup: extra %s",
    (key) => {
      it.each(ROUTES.filter((route) => route[0] !== "currentLot"))(
        "%s",
        async (...route) => {
          const f = await fixture(off);
          const hidden = await seedSession(off.prisma, f.world);
          const issue = jest.spyOn(
            ImportUiGrantIssuer.prototype,
            "issueFinancialAction",
          );
          for (const id of [f.row.id, hidden.id, randomUUID()]) {
            const response = await invoke(off, f, route, {
              id,
              data: { ...input(route, f), [key]: f.world.projects.foreign },
            });
            expect(response).toEqual({
              status: 400,
              body: wire("INVALID_INPUT"),
            });
          }
          expect(issue).not.toHaveBeenCalled();
        },
      );
    },
  );

  it.each(ROUTES.filter((route) => route[0] !== "currentLot"))(
    "malformed_request_shape_is_uniform_before_session_lookup: invalid type %s",
    async (...route) => {
      const f = await fixture(off);
      const response = await call(
        off,
        route[1],
        `/import-sessions/${f.row.id}/${route[2]}${
          route[1] === "GET" ? "?cursor[a]=invalid&lineId[]=purchase" : ""
        }`,
        {
          token: f.token,
          headers: UI,
          ...(route[1] === "GET"
            ? {}
            : { body: { ...input(route, f), expectedRevision: "7" } }),
        },
      );
      expect(response).toEqual({ status: 400, body: wire("INVALID_INPUT") });
    },
  );

  describe.each(["owner", "tenant", "anchor"] as const)(
    "hidden_acl_precedes_corrupt_stored_content_and_off: %s",
    (hidden) => {
      it.each([...ROUTES, ["getSession", "GET", ""] as const])(
        "%s",
        async (...route) => {
          const f = await fixture(off);
          await off.prisma.importSession.update({
            where: { id: f.row.id },
            data: {
              draftJson: JSON.stringify({
                ...f.draft,
                lines: [
                  {
                    ...f.draft.lines[0],
                    amountCents: "corrupt-private-financial-content",
                  },
                ],
              }),
              ...(hidden === "owner"
                ? { ownerUserId: f.world.users.peer.id }
                : {}),
            },
          });
          if (hidden === "tenant")
            f.token = await tokenFor(off, f.world.users.foreign.id);
          if (hidden === "anchor")
            await off.prisma.user.update({
              where: { id: f.world.users.restricted.id },
              data: { allowedProjects: JSON.stringify([f.target.id]) },
            });
          const response =
            route[0] === "getSession"
              ? await call(off, "GET", `/import-sessions/${f.row.id}`, {
                  token: f.token,
                })
              : await invoke(off, f, [route[0], route[1], route[2]]);
          expect(response).toEqual({ status: 404, body: wire("NOT_FOUND") });
        },
      );
    },
  );

  it("hidden_acl_precedes_corrupt_stored_content_and_off: authorized READER has sanitized 500", async () => {
    const f = await fixture(off);
    await off.prisma.importSession.update({
      where: { id: f.row.id },
      data: {
        draftJson: JSON.stringify({
          ...f.draft,
          lines: [
            {
              ...f.draft.lines[0],
              amountCents: "corrupt-private-financial-content",
            },
          ],
        }),
      },
    });
    expect(
      await call(off, "GET", `/import-sessions/${f.row.id}`, {
        token: f.token,
      }),
    ).toEqual({
      status: 500,
      body: { statusCode: 500, message: "Internal server error" },
    });
  });

  it("collection_queries_preserve_cursor_binding_and_opacity", async () => {
    const f = await fixture(active, { observations: 26 });
    const first = await invoke<
      ImportSessionPageV1<ImportSessionObservationViewV1>
    >(active, f, ROUTES[7], { headers: {} });
    expect(first.status).toBe(200);
    object(first.body);
    expect(first.body).toEqual({
      items: [...f.expectedObservations]
        .sort((a, b) => a.id.localeCompare(b.id))
        .slice(0, 25),
      nextCursor: expect.any(String),
    });
    const page = first.body;
    const second = await invoke(active, f, ROUTES[7], {
      data: { cursor: page.nextCursor },
    });
    expect(second).toEqual({
      status: 200,
      body: {
        items: [...f.expectedObservations]
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(25),
        nextCursor: null,
      },
    });
    for (const data of [
      { cursor: `${page.nextCursor}A` },
      { cursor: "" },
      { lineId: "purchase" },
    ]) {
      expect(await invoke(active, f, ROUTES[7], { data })).toEqual({
        status: 400,
        body: wire("INVALID_INPUT"),
      });
    }
    expect(await invoke(active, f, ROUTES[8], { data: {} })).toEqual({
      status: 400,
      body: wire("INVALID_INPUT"),
    });
    const other = await seedSession(active.prisma, f.world);
    expect(
      await invoke(active, f, ROUTES[7], {
        id: other.id,
        data: { cursor: `${page.nextCursor}A` },
      }),
    ).toEqual({ status: 404, body: wire("NOT_FOUND") });
    const ownOther = await seedSession(active.prisma, f.world, {
      ownerUserId: f.world.users.restricted.id,
    });
    expect(
      await invoke(active, f, ROUTES[7], {
        id: ownOther.id,
        data: { cursor: page.nextCursor },
      }),
    ).toEqual({ status: 400, body: wire("INVALID_INPUT") });
    await prepare(active, f);
    expect(
      await invoke(active, f, ROUTES[8], { data: { lineId: "purchase" } }),
    ).toEqual({ status: 200, body: { items: [], nextCursor: null } });
    expect(
      await invoke(active, f, ROUTES[8], { data: { lineId: "not-selected" } }),
    ).toEqual({ status: 400, body: wire("INVALID_INPUT") });
    expect(
      await invoke(active, f, ROUTES[8], {
        data: { lineId: "purchase", cursor: page.nextCursor },
      }),
    ).toEqual({ status: 400, body: wire("INVALID_INPUT") });
    expect(
      await invoke(active, f, ROUTES[7], { data: { cursor: page.nextCursor } }),
    ).toEqual({ status: 400, body: wire("INVALID_INPUT") });
  });

  it.each(ROUTES.filter((route) => route[1] === "POST"))(
    "default_off_has_no_new_documentary_or_financial_effects: %s",
    async (...route) => {
      const f = await fixture(off);
      if (route[0] === "execute") await confirmed(active, f);
      const before = await snapshot(off, f);
      const apply = jest.spyOn(CardPurchaseBatchAdapter.prototype, "applyInTx");
      const response = await invoke(off, f, route);
      expect(await snapshot(off, f)).toEqual(before);
      expect(apply).not.toHaveBeenCalled();
      expect(response).toEqual({
        status: 503,
        body: wire("CAPABILITY_DISABLED", { retryable: true }),
      });
    },
  );

  it.each([ROUTES[9], ROUTES[10], ROUTES[11]])(
    "financial_grants_are_fresh_request_bound_and_not_body_authority: %s",
    async (...route) => {
      const f = await fixture(off);
      const issue = jest.spyOn(
        ImportUiGrantIssuer.prototype,
        "issueFinancialAction",
      );
      const verify = jest.spyOn(
        RuntimeUiGrantVerifier.prototype,
        "verifyFinancialAction",
      );
      for (let index = 0; index < 2; index++) {
        expect((await invoke(off, f, route)).status).toBe(
          route[0] === "execute" ? 409 : 503,
        );
        expect(issue).toHaveBeenCalledTimes(index + 1);
        expect(verify).toHaveBeenCalledTimes(index + 1);
        assertOriginalGrant(
          off,
          issue.mock.calls[index],
          verify.mock.calls[index],
        );
        expect(verify.mock.calls[index][0]).toBe(
          issue.mock.results[index].value,
        );
      }
      expect(issue.mock.calls[0][0]).not.toBe(issue.mock.calls[1][0]);
      expect(issue.mock.calls[0][1]).not.toBe(issue.mock.calls[1][1]);
      expect(issue.mock.results[0].value).not.toBe(issue.mock.results[1].value);
      const data = input(route, f);
      const expectedScope =
        route[0] === "execute"
          ? {
              operation: "EXECUTE",
              sessionId: f.row.id,
              financialRequestId: FINANCIAL_ID,
            }
          : {
              operation: route[0] === "challenge" ? "CHALLENGE" : "CONFIRM",
              sessionId: f.row.id,
              expectedRevision: 7,
              confirmationHash: "a".repeat(64),
              ...(route[0] === "confirm"
                ? { financialRequestId: FINANCIAL_ID }
                : {}),
            };
      expect(issue.mock.calls[0][2]).toEqual(expectedScope);
      expect(
        await invoke(off, f, route, {
          data: { ...data, grant: issue.mock.results[0].value },
        }),
      ).toEqual({ status: 400, body: wire("INVALID_INPUT") });
      expect(issue).toHaveBeenCalledTimes(2);
    },
  );

  it("continues a sealed partial lot from server-owned deferred scope with exact replay and CAS", async () => {
    const f = await fixture(active, { deferred: true });
    await prepare(active, f);

    expect(
      await invoke<ImportDocumentaryCommandReceiptV1>(active, f, ROUTES[4]),
    ).toEqual({
      status: 200,
      body: {
        version: 1,
        requestId: DOCUMENTARY_IDS.prepareCurrentLot,
        operation: "PREPARE_CURRENT_LOT",
        outcome: "CURRENT_LOT_READY",
        revision: 8,
      },
    });
    const duplicatePrepare = await call(
      active,
      "POST",
      `/import-sessions/${f.row.id}/current-lot/prepare`,
      {
        token: f.token,
        headers: UI,
        body: {
          version: 1,
          requestId: randomUUID(),
          expectedRevision: 8,
        },
      },
    );
    expect(duplicatePrepare).toEqual({
      status: 409,
      body: wire("STALE_PREVIEW", {
        sessionId: f.row.id,
        currentRevision: 8,
      }),
    });

    const command = {
      version: 1,
      requestId: DOCUMENTARY_IDS.continueAnswering,
      expectedRevision: 8,
    };
    const concurrent = await Promise.all([
      call<ImportDocumentaryCommandReceiptV1>(
        active,
        "POST",
        `/import-sessions/${f.row.id}/current-lot/continue`,
        { token: f.token, headers: UI, body: command },
      ),
      call<ImportDocumentaryCommandReceiptV1>(
        active,
        "POST",
        `/import-sessions/${f.row.id}/current-lot/continue`,
        { token: f.token, headers: UI, body: command },
      ),
    ]);
    const expectedReceipt = {
      version: 1,
      requestId: command.requestId,
      operation: "CONTINUE_ANSWERING",
      outcome: "NEEDS_INPUT",
      revision: 9,
    };
    expect(concurrent).toEqual([
      { status: 200, body: expectedReceipt },
      { status: 200, body: expectedReceipt },
    ]);

    const after = await active.prisma.importSession.findUniqueOrThrow({
      where: { id: f.row.id },
    });
    expect(after).toMatchObject({
      state: "NEEDS_INPUT",
      revision: 9,
      proposalJson: null,
      proposalHash: null,
      preflightHash: null,
      challengeJson: null,
    });
    const stored = JSON.parse(after.draftJson) as ImportSessionStoredDraftV1;
    expect(stored.selectedLineIds).toEqual(["purchase", "deferred"]);
    expect(stored.questions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "pending-question",
          lineIds: ["deferred"],
        }),
      ]),
    );
    expect(stored.commandLedger?.items.at(-1)?.result).toEqual(expectedReceipt);
    expect(
      stored.commandLedger?.items.filter(
        (item) => item.requestId === command.requestId,
      ),
    ).toHaveLength(1);

    const view = await call<ImportSessionViewV1>(
      active,
      "GET",
      `/import-sessions/${f.row.id}`,
      { token: f.token },
    );
    expect(view).toMatchObject({
      status: 200,
      body: {
        state: "NEEDS_INPUT",
        revision: 9,
        selectedLineIds: ["purchase", "deferred"],
        proposal: null,
        guidedReview: {
          progress: "ANSWERING",
          actions: ["CONTINUE_ANSWERING"],
        },
      },
    });
  });

  it("observes continue, reseal, read-only review, confirm, apply, and continuation revisions", async () => {
    const f = await fixture(active, { observations: 3 });
    const secondLine = {
      ...structuredClone(f.draft.lines[0]!),
      id: "second",
      observationIds: [f.draft.scope.observationIds[1]!],
      tipoDespesa: null,
      targets: null,
      decision: { kind: "UNRESOLVED" as const },
    };
    const thirdLine = {
      ...structuredClone(secondLine),
      id: "third",
      observationIds: [f.draft.scope.observationIds[2]!],
      titulo: "Still deferred purchase",
    };
    f.draft.lines.push(secondLine, thirdLine);
    f.draft.questions.push(
      {
        id: "second-decision",
        lineIds: ["second"],
        field: "decision",
        text: "Resolve the second purchase decision",
      },
      {
        id: "second-targets",
        lineIds: ["second"],
        field: "targets",
        text: "Resolve the second purchase targets",
      },
      {
        id: "second-expense-type",
        lineIds: ["second"],
        field: "tipoDespesa",
        text: "Resolve the second purchase type",
      },
      {
        id: "third-decision",
        lineIds: ["third"],
        field: "decision",
        text: "Keep the third purchase deferred",
      },
    );
    await active.prisma.importSession.update({
      where: { id: f.row.id },
      data: { revision: 29, draftJson: JSON.stringify(f.draft) },
    });

    const firstSeal = await call<ImportDocumentaryCommandReceiptV1>(
      active,
      "POST",
      `/import-sessions/${f.row.id}/current-lot/prepare`,
      {
        token: f.token,
        headers: UI,
        body: {
          version: 1,
          requestId: randomUUID(),
          expectedRevision: 29,
        },
      },
    );
    expect(firstSeal).toMatchObject({
      status: 200,
      body: { outcome: "CURRENT_LOT_READY", revision: 30 },
    });
    expect(
      await call(
        active,
        "POST",
        `/import-sessions/${f.row.id}/current-lot/continue`,
        {
          token: f.token,
          headers: UI,
          body: {
            version: 1,
            requestId: randomUUID(),
            expectedRevision: 30,
          },
        },
      ),
    ).toMatchObject({
      status: 200,
      body: { outcome: "NEEDS_INPUT", revision: 31 },
    });

    const continued = await call<ImportSessionViewV1>(
      active,
      "GET",
      `/import-sessions/${f.row.id}`,
      { token: f.token },
    );
    expect(continued).toMatchObject({
      status: 200,
      body: {
        state: "NEEDS_INPUT",
        revision: 31,
        selectedLineIds: ["purchase", "second", "third"],
        guidedReview: {
          focus: { lineId: "second", control: "DECISION" },
        },
      },
    });

    const answers = [
      {
        questionId: "second-decision",
        answer: {
          kind: "DECISION",
          value: { kind: "CREATE", acceptNaturalDuplicate: false },
        },
      },
      {
        questionId: "second-targets",
        answer: { kind: "TARGETS", value: [] },
      },
      {
        questionId: "second-expense-type",
        answer: {
          kind: "EXPENSE_TYPE",
          value: ExpenseType.COMPRAS_VAREJO,
        },
      },
    ] as const;
    for (const [index, answer] of answers.entries()) {
      const response = await call<ImportDocumentaryCommandReceiptV1>(
        active,
        "POST",
        `/import-sessions/${f.row.id}/resolutions`,
        {
          token: f.token,
          headers: UI,
          body: {
            version: 1,
            requestId: randomUUID(),
            expectedRevision: 31 + index,
            ...answer,
          },
        },
      );
      expect(response).toMatchObject({
        status: 200,
        body: { operation: "RESOLVE", revision: 32 + index },
      });
    }

    const serialization = jest.spyOn(canonicalSerialization, "canonical");
    const resealed = await call<ImportDocumentaryCommandReceiptV1>(
      active,
      "POST",
      `/import-sessions/${f.row.id}/current-lot/prepare`,
      {
        token: f.token,
        headers: UI,
        body: {
          version: 1,
          requestId: randomUUID(),
          expectedRevision: 34,
        },
      },
    );
    expect(resealed).toMatchObject({
      status: 200,
      body: { outcome: "CURRENT_LOT_READY", revision: 35 },
    });
    const review = await call<ImportCurrentLotV1>(
      active,
      "GET",
      `/import-sessions/${f.row.id}/current-lot`,
      { token: f.token },
    );
    expect(review).toMatchObject({
      status: 200,
      body: { revision: 35, state: "READY_WITH_PENDING" },
    });
    expect(review.body.purchases).toHaveLength(2);
    const sealedRow = await active.prisma.importSession.findUniqueOrThrow({
      where: { id: f.row.id },
    });
    expect(sealedRow).toMatchObject({ state: "READY", revision: 35 });
    expect(
      (
        JSON.parse(sealedRow.proposalJson!) as ImportSessionProposalV1
      ).lines.map((line) => line.lineId),
    ).toEqual(["purchase", "second"]);

    const issued = await call<ImportSessionChallengeResponseV1>(
      active,
      "POST",
      `/import-sessions/${f.row.id}/confirmation-challenge`,
      {
        token: f.token,
        headers: UI,
        body: {
          expectedRevision: 35,
          confirmationHash: review.body.confirmationHash,
        },
      },
    );
    expect(issued.status).toBe(200);
    const confirmation = await call(
      active,
      "POST",
      `/import-sessions/${f.row.id}/confirm`,
      {
        token: f.token,
        headers: UI,
        body: {
          expectedRevision: 35,
          confirmationHash: review.body.confirmationHash,
          financialRequestId: FINANCIAL_ID,
          nonce: issued.body.nonce,
        },
      },
    );
    expect(confirmation).toMatchObject({
      status: 200,
      body: { state: "CONFIRMED" },
    });
    expect(
      await active.prisma.importSession.findUniqueOrThrow({
        where: { id: f.row.id },
      }),
    ).toMatchObject({
      state: "CONFIRMED",
      revision: 36,
      confirmedRevision: 35,
    });

    const applied = await call<ImportSessionReceiptV1>(
      active,
      "POST",
      `/import-sessions/${f.row.id}/execute`,
      {
        token: f.token,
        headers: UI,
        body: { financialRequestId: FINANCIAL_ID },
      },
    );
    const preflightInputs = serialization.mock.calls
      .map(([value]) => value)
      .filter(
        (value): value is unknown[] =>
          Array.isArray(value) &&
          value.length > 4 &&
          isRecord(value[3]) &&
          "financialPreparation" in value[3],
      )
      .map((value) => structuredClone(value));
    serialization.mockRestore();
    expect(preflightInputs).toHaveLength(2);
    expect(
      changedCanonicalPaths(preflightInputs[0], preflightInputs[1]),
    ).toEqual([]);
    expect(applied).toMatchObject({
      status: 200,
      body: {
        confirmedRevision: 35,
        continuationSessionId: expect.any(String),
      },
    });
    expect(
      await active.prisma.importSession.findUniqueOrThrow({
        where: { id: f.row.id },
      }),
    ).toMatchObject({ state: "APPLIED", revision: 37 });
    const continuation = await active.prisma.importSession.findUniqueOrThrow({
      where: { id: applied.body.continuationSessionId! },
    });
    const continuationDraft = JSON.parse(
      continuation.draftJson,
    ) as ImportSessionStoredDraftV1;
    expect(continuationDraft.lines.map((line) => line.id)).toEqual(["third"]);
  });

  it("applies a first ready subset without preflight drift and continues the pending work", async () => {
    const f = await fixture(active, { deferred: true });
    f.draft.selectedLineIds.push("deferred");
    await active.prisma.importSession.update({
      where: { id: f.row.id },
      data: { revision: 29, draftJson: JSON.stringify(f.draft) },
    });
    const serialization = jest.spyOn(canonicalSerialization, "canonical");

    const sealed = await call<ImportDocumentaryCommandReceiptV1>(
      active,
      "POST",
      `/import-sessions/${f.row.id}/current-lot/prepare`,
      {
        token: f.token,
        headers: UI,
        body: {
          version: 1,
          requestId: randomUUID(),
          expectedRevision: 29,
        },
      },
    );
    expect(sealed).toMatchObject({
      status: 200,
      body: { outcome: "CURRENT_LOT_READY", revision: 30 },
    });
    const readyRow = await active.prisma.importSession.findUniqueOrThrow({
      where: { id: f.row.id },
    });
    const readyDraft = JSON.parse(
      readyRow.draftJson,
    ) as ImportSessionStoredDraftV1;
    expect(readyDraft.selectedLineIds).toEqual(["purchase"]);
    expect(
      (JSON.parse(readyRow.proposalJson!) as ImportSessionProposalV1).lines.map(
        (line) => line.lineId,
      ),
    ).toEqual(["purchase"]);

    const beforeReview = await snapshot(active, f);
    const review = await call<ImportCurrentLotV1>(
      active,
      "GET",
      `/import-sessions/${f.row.id}/current-lot`,
      { token: f.token },
    );
    expect(review).toMatchObject({
      status: 200,
      body: {
        state: "READY_WITH_PENDING",
        revision: 30,
        hasRemainingWork: true,
      },
    });
    expect(review.body.purchases).toHaveLength(1);
    expect(await snapshot(active, f)).toEqual(beforeReview);

    const challenged = await call<ImportSessionChallengeResponseV1>(
      active,
      "POST",
      `/import-sessions/${f.row.id}/confirmation-challenge`,
      {
        token: f.token,
        headers: UI,
        body: {
          expectedRevision: 30,
          confirmationHash: review.body.confirmationHash,
        },
      },
    );
    expect(challenged.status).toBe(200);
    expect(
      await call(active, "POST", `/import-sessions/${f.row.id}/confirm`, {
        token: f.token,
        headers: UI,
        body: {
          expectedRevision: 30,
          confirmationHash: review.body.confirmationHash,
          financialRequestId: FINANCIAL_ID,
          nonce: challenged.body.nonce,
        },
      }),
    ).toMatchObject({
      status: 200,
      body: { state: "CONFIRMED" },
    });
    const confirmedRow = await active.prisma.importSession.findUniqueOrThrow({
      where: { id: f.row.id },
    });
    expect(confirmedRow).toMatchObject({
      state: "CONFIRMED",
      revision: 31,
      confirmedRevision: 30,
      proposalHash: readyRow.proposalHash,
      preflightHash: readyRow.preflightHash,
    });

    const applied = await call<ImportSessionReceiptV1>(
      active,
      "POST",
      `/import-sessions/${f.row.id}/execute`,
      {
        token: f.token,
        headers: UI,
        body: { financialRequestId: FINANCIAL_ID },
      },
    );
    const preflightInputs = serialization.mock.calls
      .map(([value]) => value)
      .filter(
        (value): value is unknown[] =>
          Array.isArray(value) &&
          value.length > 4 &&
          isRecord(value[3]) &&
          "financialPreparation" in value[3],
      )
      .map((value) => structuredClone(value));
    serialization.mockRestore();
    expect(preflightInputs).toHaveLength(2);
    expect(
      changedCanonicalPaths(preflightInputs[0], preflightInputs[1]),
    ).toEqual([]);
    expect(applied).toMatchObject({
      status: 200,
      body: {
        confirmedRevision: 30,
        continuationSessionId: expect.any(String),
        items: [expect.objectContaining({ lineId: "purchase" })],
      },
    });
    expect(
      await active.prisma.importSession.findUniqueOrThrow({
        where: { id: f.row.id },
      }),
    ).toMatchObject({ state: "APPLIED", revision: 32 });
    const child = await active.prisma.importSession.findUniqueOrThrow({
      where: { id: applied.body.continuationSessionId! },
    });
    expect(
      (JSON.parse(child.draftJson) as ImportSessionStoredDraftV1).lines.map(
        (line) => line.id,
      ),
    ).toEqual(["deferred"]);
  });

  it("projects a ready lot with only an ignored policy row as complete", async () => {
    const f = await fixture(active, { observations: 4 });
    const readyLines = [1, 2].map((index) => ({
      ...structuredClone(f.draft.lines[0]!),
      id: `ready-${index + 1}`,
      observationIds: [f.draft.scope.observationIds[index]!],
    }));
    const ignoredLine = {
      ...structuredClone(f.draft.lines[0]!),
      id: "hidden-invoice-payment",
      observationIds: [f.draft.scope.observationIds[3]!],
      titulo: "Hidden invoice payment 98765",
      tipoDespesa: null,
      categoriaMaoDeObra: null,
      targets: [],
      decision: {
        kind: "IGNORED_POLICY" as const,
        reason: "INVOICE_PAYMENT" as const,
        policyVersion: 1 as const,
      },
    };
    f.draft.lines.push(...readyLines, ignoredLine);
    f.draft.selectedLineIds.push(...readyLines.map((line) => line.id));
    f.draft.fieldProvenance?.push(
      ...readyLines.flatMap((line) =>
        (["decision", "targets", "tipoDespesa"] as const).map((field) => ({
          origin: "FILE" as const,
          lineId: line.id,
          field,
          recordedRevision: 7,
        })),
      ),
    );
    await active.prisma.importSession.update({
      where: { id: f.row.id },
      data: { revision: 39, draftJson: JSON.stringify(f.draft) },
    });

    const sealed = await call<ImportDocumentaryCommandReceiptV1>(
      active,
      "POST",
      `/import-sessions/${f.row.id}/current-lot/prepare`,
      {
        token: f.token,
        headers: UI,
        body: {
          version: 1,
          requestId: randomUUID(),
          expectedRevision: 39,
        },
      },
    );
    expect(sealed).toMatchObject({
      status: 200,
      body: { outcome: "CURRENT_LOT_READY", revision: 40 },
    });
    const readyRow = await active.prisma.importSession.findUniqueOrThrow({
      where: { id: f.row.id },
    });
    const privateProposal = JSON.parse(
      readyRow.proposalJson!,
    ) as ImportSessionProposalV1;
    expect(privateProposal.lines).toHaveLength(3);
    expect(privateProposal.noWriteRows).toEqual([
      {
        lineId: ignoredLine.id,
        outcome: "IGNORED",
        reason: "INVOICE_PAYMENT",
        title: ignoredLine.titulo,
        amountCents: 60000,
      },
    ]);
    expect(privateProposal.deferredObservationIds).toEqual([]);
    expect(privateProposal.deferredAttachmentIds).toEqual([]);

    const view = await call<ImportSessionViewV1>(
      active,
      "GET",
      `/import-sessions/${f.row.id}`,
      { token: f.token },
    );
    expect(view).toMatchObject({
      status: 200,
      body: {
        state: "READY",
        revision: 40,
        guidedReview: {
          progress: "READY",
          focus: null,
          actions: ["REVIEW_READY"],
        },
      },
    });

    const currentLot = await call<ImportCurrentLotV1>(
      active,
      "GET",
      `/import-sessions/${f.row.id}/current-lot`,
      { token: f.token },
    );
    expect(currentLot).toMatchObject({
      status: 200,
      body: {
        state: "READY",
        revision: 40,
        hasRemainingWork: false,
      },
    });
    expect(currentLot.body.purchases).toHaveLength(3);
    for (const projection of [
      view.body.guidedReview,
      currentLot.body,
    ] as const) {
      const serialized = JSON.stringify(projection);
      expect(serialized).not.toContain(ignoredLine.id);
      expect(serialized).not.toContain(ignoredLine.titulo);
      expect(serialized).not.toContain("98765");
      expect(projection).not.toHaveProperty("remainingCount");
      expect(projection).not.toHaveProperty("remainingAmountCents");
    }
  });

  it("fails continue without sealed work, after revocation, or after proposal semantic drift", async () => {
    const complete = await fixture(active);
    await prepare(active, complete);
    const noPending = await call(
      active,
      "POST",
      `/import-sessions/${complete.row.id}/current-lot/continue`,
      {
        token: complete.token,
        headers: UI,
        body: {
          version: 1,
          requestId: randomUUID(),
          expectedRevision: 8,
        },
      },
    );
    expect(noPending).toEqual({
      status: 409,
      body: wire("STALE_PREVIEW", {
        sessionId: complete.row.id,
        currentRevision: 8,
      }),
    });

    const revoked = await fixture(active, { deferred: true });
    await prepare(active, revoked);
    await active.prisma.user.update({
      where: { id: revoked.world.users.restricted.id },
      data: { sessionVersion: { increment: 1 } },
    });
    const revokedResponse = await call(
      active,
      "POST",
      `/import-sessions/${revoked.row.id}/current-lot/continue`,
      {
        token: revoked.token,
        headers: UI,
        body: {
          version: 1,
          requestId: randomUUID(),
          expectedRevision: 8,
        },
      },
    );
    expect(revokedResponse).toEqual({
      status: 401,
      body: wire("UNAUTHENTICATED"),
    });

    const drifted = await fixture(active, { deferred: true });
    await prepare(active, drifted);
    const driftedRow = await active.prisma.importSession.findUniqueOrThrow({
      where: { id: drifted.row.id },
    });
    const driftedDraft = JSON.parse(
      driftedRow.draftJson,
    ) as ImportSessionStoredDraftV1;
    const selected = driftedDraft.lines.find((line) => line.id === "purchase");
    if (!selected?.targets?.[0])
      throw new Error("Expected selected fixture target");
    if (selected.amountCents === null)
      throw new Error("Expected selected fixture amount");
    selected.amountCents += 1;
    selected.targets[0].amountCents += 1;
    await active.prisma.importSession.update({
      where: { id: drifted.row.id },
      data: { draftJson: JSON.stringify(driftedDraft) },
    });
    const drift = await call(
      active,
      "POST",
      `/import-sessions/${drifted.row.id}/current-lot/continue`,
      {
        token: drifted.token,
        headers: UI,
        body: {
          version: 1,
          requestId: randomUUID(),
          expectedRevision: 8,
        },
      },
    );
    expect(drift).toEqual({
      status: 409,
      body: wire("STALE_PREVIEW", {
        sessionId: drifted.row.id,
        currentRevision: 8,
      }),
    });
  });

  it("supports attachment-only continuation and arbitrates continue against challenge and confirm", async () => {
    const attachmentOnly = await fixture(active, { deferred: true });
    const attachmentDraft = structuredClone(attachmentOnly.draft);
    attachmentDraft.lines = attachmentDraft.lines.filter(
      (line) => line.id !== "deferred",
    );
    attachmentDraft.questions = attachmentDraft.questions.filter(
      (question) => !question.lineIds.includes("deferred"),
    );
    attachmentDraft.scope.observationIds =
      attachmentOnly.draft.lines.find((line) => line.id === "purchase")
        ?.observationIds ?? [];
    await active.prisma.importSession.update({
      where: { id: attachmentOnly.row.id },
      data: { draftJson: JSON.stringify(attachmentDraft) },
    });
    await prepare(active, attachmentOnly);
    const attachmentContinue = await call(
      active,
      "POST",
      `/import-sessions/${attachmentOnly.row.id}/current-lot/continue`,
      {
        token: attachmentOnly.token,
        headers: UI,
        body: {
          version: 1,
          requestId: randomUUID(),
          expectedRevision: 8,
        },
      },
    );
    expect(attachmentContinue).toMatchObject({
      status: 200,
      body: {
        operation: "CONTINUE_ANSWERING",
        outcome: "NEEDS_INPUT",
        revision: 9,
      },
    });
    const attachmentAfter = await active.prisma.importSession.findUniqueOrThrow(
      {
        where: { id: attachmentOnly.row.id },
      },
    );
    expect(
      (JSON.parse(attachmentAfter.draftJson) as ImportSessionStoredDraftV1)
        .selectedLineIds,
    ).toEqual(["purchase"]);

    const challengeRace = await fixture(active, { deferred: true });
    const ready = await prepare(active, challengeRace);
    const [continued, challenged] = await Promise.all([
      call(
        active,
        "POST",
        `/import-sessions/${challengeRace.row.id}/current-lot/continue`,
        {
          token: challengeRace.token,
          headers: UI,
          body: {
            version: 1,
            requestId: randomUUID(),
            expectedRevision: 8,
          },
        },
      ),
      call(
        active,
        "POST",
        `/import-sessions/${challengeRace.row.id}/confirmation-challenge`,
        {
          token: challengeRace.token,
          headers: UI,
          body: {
            expectedRevision: 8,
            confirmationHash: ready.confirmationHash,
          },
        },
      ),
    ]);
    expect(continued.status).toBe(200);
    expect([200, 409]).toContain(challenged.status);
    expect(
      await active.prisma.importSession.findUniqueOrThrow({
        where: { id: challengeRace.row.id },
      }),
    ).toMatchObject({
      state: "NEEDS_INPUT",
      revision: 9,
      challengeJson: null,
    });

    const confirmRace = await fixture(active, { deferred: true });
    const confirmReady = await prepare(active, confirmRace);
    const issued = await challenge(active, confirmRace, confirmReady);
    const raced = await Promise.all([
      call(
        active,
        "POST",
        `/import-sessions/${confirmRace.row.id}/current-lot/continue`,
        {
          token: confirmRace.token,
          headers: UI,
          body: {
            version: 1,
            requestId: randomUUID(),
            expectedRevision: 8,
          },
        },
      ),
      call(active, "POST", `/import-sessions/${confirmRace.row.id}/confirm`, {
        token: confirmRace.token,
        headers: UI,
        body: issued.confirmation,
      }),
    ]);
    expect(raced.map((response) => response.status).sort()).toEqual([200, 409]);
    const confirmAfter = await active.prisma.importSession.findUniqueOrThrow({
      where: { id: confirmRace.row.id },
    });
    expect(["NEEDS_INPUT", "CONFIRMED"]).toContain(confirmAfter.state);
    expect(confirmAfter.revision).toBe(9);
  });

  it("http_prepare_challenge_confirm_execute_returns_exact_wire", async () => {
    const f = await fixture(active);
    const revisions = [7];
    const ready = await prepare(active, f);
    revisions.push(ready.revision);
    const c = await challenge(active, f, ready);
    revisions.push(
      (
        await active.prisma.importSession.findUniqueOrThrow({
          where: { id: f.row.id },
        })
      ).revision,
    );
    expect(
      await invoke(active, f, ROUTES[10], { data: { ...c.confirmation } }),
    ).toEqual({
      status: 200,
      body: {
        sessionId: f.row.id,
        financialRequestId: FINANCIAL_ID,
        state: "CONFIRMED",
      },
    });
    const beforeMoney = await snapshot(active, f);
    revisions.push(beforeMoney.sessions[0].revision);
    expect(beforeMoney.expenses).toEqual([]);
    expect(beforeMoney.cfes).toEqual([]);
    expect(beforeMoney.allocations).toEqual([]);
    expect(beforeMoney.observations[0].claimSessionId).toBeNull();
    const claimCalls: unknown[] = [];
    active.hook = (params, result) => {
      if (
        params.model === "ImportObservation" &&
        params.action === "updateMany"
      ) {
        claimCalls.push({
          args: params.args,
          result,
          inTransaction: params.runInTransaction,
        });
      }
    };
    const receipt = await execute(active, f);
    const after = await snapshot(active, f);
    revisions.push(after.sessions[0].revision);
    expect(revisions).toEqual([7, 8, 8, 9, 10]);
    expect(after.expenses).toHaveLength(2);
    expect(after.cfes).toHaveLength(6);
    expect(after.allocations).toHaveLength(1);
    expect(after.audit).toHaveLength(1);
    expect(after.observations[0]).toMatchObject({
      claimVersion: 1,
      claimSessionId: f.row.id,
      claimedAt: FIXED_NOW,
    });
    expect(claimCalls).toEqual([
      {
        args: expect.objectContaining({
          where: expect.objectContaining({
            id: f.draft.scope.observationIds[0],
            claimVersion: 0,
          }),
          data: expect.objectContaining({
            claimVersion: { increment: 1 },
            claimSessionId: f.row.id,
          }),
        }),
        result: { count: 1 },
        inTransaction: true,
      },
    ]);
    const source = after.expenses.find(
      (row) => row.projectId === f.world.projects.pessoal,
    );
    const target = after.expenses.find((row) => row.projectId === f.target.id);
    expect(source).toBeDefined();
    expect(target).toBeDefined();
    expect(
      after.expenses.every(
        (row) => row.valorTotal === 60000 && row.bankLast4 === null,
      ),
    ).toBe(true);
    expect(after.cfes.map((row) => row.valor)).toEqual([
      20000, 20000, 20000, 20000, 20000, 20000,
    ]);
    const expected: ImportSessionReceiptV1 = {
      version: 1,
      sessionId: f.row.id,
      financialRequestId: FINANCIAL_ID,
      confirmedRevision: 8,
      bindingVersion: 1,
      confirmationHash: c.confirmation.confirmationHash,
      appliedAt: FIXED_NOW.toISOString(),
      continuationSessionId: null,
      items: [
        {
          lineId: "purchase",
          outcome: "CREATED",
          sourceExpenseId: source!.id,
          targetExpenseIds: [target!.id],
          allocationIds: [after.allocations[0].id],
          cashFlowEntryIds: after.cfes.map((row) => row.id).sort(),
        },
      ],
      auditItems: [],
      snapshot: {
        lines: [
          {
            lineId: "purchase",
            titulo: "Synthetic HTTP purchase",
            dataCompra: "2026-09-25",
            totalCents: 60000,
            schedule: {
              version: 1,
              occurrences: [
                {
                  index: 0,
                  parcela: "1/3",
                  valor: 20000,
                  data: "2026-11-05",
                  invoiceDueMonth: "2026-11",
                },
                {
                  index: 1,
                  parcela: "2/3",
                  valor: 20000,
                  data: "2026-12-05",
                  invoiceDueMonth: "2026-12",
                },
                {
                  index: 2,
                  parcela: "3/3",
                  valor: 20000,
                  data: "2027-01-05",
                  invoiceDueMonth: "2027-01",
                },
              ],
            },
            sourceProjectId: f.world.projects.pessoal,
            targets: [{ projectId: f.target.id, amountCents: 60000 }],
          },
        ],
        participantProjectIds: [f.world.projects.pessoal, f.target.id].sort(),
        createdEconomicTotalCents: 60000,
        bankCashDeltaCents: 0,
        invoiceDeltas: [
          { invoiceDueMonth: "2026-11", amountCents: 20000 },
          { invoiceDueMonth: "2026-12", amountCents: 20000 },
          { invoiceDueMonth: "2027-01", amountCents: 20000 },
        ],
      },
    };
    expect(receipt).toEqual(expected);
    expect(JSON.parse(after.sessions[0].receiptJson!)).toEqual({
      ...expected,
      fullPlanDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(
      await call(active, "GET", `/import-sessions/${f.row.id}/result`, {
        token: f.token,
      }),
    ).toEqual({ status: 200, body: { state: "APPLIED", receipt: expected } });
  });

  it.each(["null", "wrong", "before-boundary", "at-boundary"] as const)(
    "nonce_is_required_only_for_first_confirmation_and_expires_at_boundary: %s",
    async (kind) => {
      const f = await fixture(active);
      const ready = await prepare(active, f);
      const c = await challenge(active, f, ready);
      if (kind.endsWith("boundary"))
        clock.current = new Date(
          Date.parse(c.body.expiresAt) - (kind === "before-boundary" ? 1 : 0),
        );
      const issue = jest.spyOn(
        ImportUiGrantIssuer.prototype,
        "issueFinancialAction",
      );
      const verify = jest.spyOn(
        RuntimeUiGrantVerifier.prototype,
        "verifyFinancialAction",
      );
      const confirmation = {
        ...c.confirmation,
        nonce:
          kind === "null" ? null : kind === "wrong" ? "wrong" : c.body.nonce,
      };
      const response = await invoke(active, f, ROUTES[10], {
        data: confirmation,
      });
      expect(response).toEqual(
        kind === "before-boundary"
          ? {
              status: 200,
              body: {
                sessionId: f.row.id,
                financialRequestId: FINANCIAL_ID,
                state: "CONFIRMED",
              },
            }
          : {
              status: 403,
              body: wire("UI_ACTION_REQUIRED", {
                sessionId: f.row.id,
                currentRevision: 8,
              }),
            },
      );
      expect(issue).toHaveBeenCalledTimes(1);
      expect(verify).toHaveBeenCalledTimes(1);
      assertOriginalGrant(active, issue.mock.calls[0], verify.mock.calls[0]);
      expect((await snapshot(active, f)).expenses).toEqual([]);
    },
  );

  it("off_replays_exact_confirmation_and_applied_receipt", async () => {
    const f = await fixture(active);
    const c = await confirmed(active, f);
    const confirmedSnapshot = await snapshot(active, f);
    expect(
      await invoke(off, f, ROUTES[10], {
        data: { ...c.confirmation, nonce: null },
      }),
    ).toEqual({
      status: 200,
      body: {
        sessionId: f.row.id,
        financialRequestId: FINANCIAL_ID,
        state: "CONFIRMED",
      },
    });
    expect(await snapshot(active, f)).toEqual(confirmedSnapshot);
    const receipt = await execute(active, f);
    testOnlyCapability.enabled = false;
    const before = await snapshot(active, f);
    const issue = jest.spyOn(
      ImportUiGrantIssuer.prototype,
      "issueFinancialAction",
    );
    for (const h of [active, off]) {
      expect(
        await invoke(h, f, ROUTES[10], {
          data: { ...c.confirmation, nonce: null },
        }),
      ).toEqual({
        status: 200,
        body: {
          sessionId: f.row.id,
          financialRequestId: FINANCIAL_ID,
          state: "APPLIED",
        },
      });
      expect(await invoke(h, f, ROUTES[11])).toEqual({
        status: 200,
        body: receipt,
      });
      for (const route of [ROUTES[10], ROUTES[11]]) {
        const data =
          route[0] === "confirm"
            ? { ...c.confirmation, nonce: null }
            : input(route, f);
        expect(await invoke(h, f, route, { data, headers: {} })).toEqual({
          status: 403,
          body: wire("UI_ACTION_REQUIRED"),
        });
        expect(
          await invoke(h, f, route, {
            data: { ...data, financialRequestId: randomUUID() },
          }),
        ).toEqual({
          status: 409,
          body: wire("IDEMPOTENCY_CONFLICT", {
            sessionId: f.row.id,
            currentRevision: 10,
          }),
        });
      }
    }
    for (const h of [active, off]) {
      for (const changed of [
        { ...c.confirmation, nonce: null, expectedRevision: 9 },
        { ...c.confirmation, nonce: null, confirmationHash: "b".repeat(64) },
      ]) {
        expect(await invoke(h, f, ROUTES[10], { data: changed })).toEqual({
          status: 409,
          body: wire("IDEMPOTENCY_CONFLICT", {
            sessionId: f.row.id,
            currentRevision: 10,
          }),
        });
      }
    }
    expect(new Set(issue.mock.results.map((result) => result.value)).size).toBe(
      12,
    );
    expect(await snapshot(active, f)).toEqual(before);
  });

  it.each([false, true])(
    "internal_retry_does_not_remint_but_reauthorizes: revoke=%s",
    async (revoke) => {
      const f = await fixture(active);
      await confirmed(active, f);
      const before = await snapshot(active, f);
      const issue = jest.spyOn(
        ImportUiGrantIssuer.prototype,
        "issueFinancialAction",
      );
      const verify = jest.spyOn(
        RuntimeUiGrantVerifier.prototype,
        "verifyFinancialAction",
      );
      const retry = new Error(
        "SQLITE_BUSY synthetic once after real authorization",
      );
      let reservations = 0;
      let authReads = 0;
      let thrown = false;
      const trace: string[] = [];
      active.hook = (params) => {
        if (params.action === "executeRaw") {
          const args: unknown = params.args;
          expect(args).toEqual([
            ["UPDATE tenants SET id = id WHERE id = ", ""],
            f.world.tenantId,
          ]);
          expect(params.runInTransaction).toBe(true);
          reservations++;
          trace.push(`reservation:${reservations}`);
        }
        if (
          params.model === "User" &&
          params.action === "findUnique" &&
          params.runInTransaction
        ) {
          authReads++;
          trace.push(`reauthorize:${authReads}`);
          if (!thrown) {
            thrown = true;
            trace.push("SQLITE_BUSY:injected");
            throw retry;
          }
        }
      };
      const transaction = active.prisma.$transaction.bind(active.prisma);
      jest
        .spyOn(active.prisma, "$transaction")
        .mockImplementation(async (work, options) => {
          try {
            return await transaction(work, options);
          } catch (error) {
            if (error === retry) {
              trace.push("SQLITE_BUSY:rolled-back");
              if (revoke) {
                await active.prisma.user.update({
                  where: { id: f.world.users.restricted.id },
                  data: { sessionVersion: 1 },
                });
                trace.push("sessionVersion:revoked");
              }
            }
            throw error;
          }
        });
      const response = await invoke(active, f, ROUTES[11]);
      console.info("QA_HTTP_RETRY_TRACE", {
        revoke,
        trace,
        reservations,
        authReads,
        thrown,
        grantIssues: issue.mock.calls.length,
        grantVerifications: verify.mock.calls.length,
        status: response.status,
      });
      expect(response.status).toBe(revoke ? 401 : 200);
      expect(thrown).toBe(true);
      expect(reservations).toBe(2);
      expect(authReads).toBeGreaterThanOrEqual(2);
      expect(trace.slice(0, revoke ? 7 : 6)).toEqual([
        "reservation:1",
        "reauthorize:1",
        "SQLITE_BUSY:injected",
        "SQLITE_BUSY:rolled-back",
        ...(revoke ? ["sessionVersion:revoked"] : []),
        "reservation:2",
        "reauthorize:2",
      ]);
      expect(issue).toHaveBeenCalledTimes(1);
      expect(verify).toHaveBeenCalledTimes(1);
      assertOriginalGrant(active, issue.mock.calls[0], verify.mock.calls[0]);
      active.hook = null;
      if (revoke) {
        expect(response.body).toEqual(wire("UNAUTHENTICATED"));
        expect(await snapshot(active, f)).toEqual(before);
      } else {
        const after = await snapshot(active, f);
        expect(after.expenses).toHaveLength(2);
        expect(after.audit).toHaveLength(1);
      }
    },
  );

  it("post_effect_failure_rolls_back_the_entire_http_execution", async () => {
    const f = await fixture(active, { deferred: true });
    await confirmed(active, f);
    const before = await snapshot(active, f);
    const issue = jest.spyOn(
      ImportUiGrantIssuer.prototype,
      "issueFinancialAction",
    );
    const verify = jest.spyOn(
      RuntimeUiGrantVerifier.prototype,
      "verifyFinancialAction",
    );
    let failedAfterApplied = false;
    const effects: string[] = [];
    active.hook = (params, result) => {
      if (
        [
          "Expense",
          "CashFlowEntry",
          "RateioAllocation",
          "ImportObservation",
          "UserActivityLog",
        ].includes(params.model ?? "") &&
        ["create", "createMany", "updateMany", "upsert"].includes(params.action)
      )
        effects.push(params.model!);
      if (
        params.model === "ImportSession" &&
        params.action === "updateMany" &&
        params.args.data.state === "APPLIED"
      ) {
        expect(result).toEqual({ count: 1 });
        failedAfterApplied = true;
        throw new Error("synthetic-private-failure-after-final-APPLIED");
      }
    };
    const response = await invoke(active, f, ROUTES[11]);
    expect(response).toEqual({
      status: 500,
      body: { statusCode: 500, message: "Internal server error" },
    });
    expect(failedAfterApplied).toBe(true);
    expect(effects).toEqual(
      expect.arrayContaining([
        "Expense",
        "CashFlowEntry",
        "RateioAllocation",
        "ImportObservation",
        "UserActivityLog",
      ]),
    );
    active.hook = null;
    expect(await snapshot(active, f)).toEqual(before);
    await execute(active, f);
    expect(issue).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledTimes(2);
    expect(issue.mock.results[0].value).not.toBe(issue.mock.results[1].value);
    for (let index = 0; index < 2; index++)
      assertOriginalGrant(
        active,
        issue.mock.calls[index],
        verify.mock.calls[index],
      );
    const after = await snapshot(active, f);
    expect(after.expenses).toHaveLength(2);
    expect(after.cfes).toHaveLength(6);
    expect(after.allocations).toHaveLength(1);
    expect(after.audit).toHaveLength(1);
    expect(after.sessions).toHaveLength(2);
  });

  it("overlapping_http_replays_write_once", async () => {
    const f = await fixture(active);
    await confirmed(active, f);
    let arrivals = 0;
    let release!: () => void;
    const bothDispatched = new Promise<void>((done) => {
      release = done;
    });
    const original = ImportSessionWorkflowService.prototype.execute;
    jest
      .spyOn(ImportSessionWorkflowService.prototype, "execute")
      .mockImplementation(async function (
        this: ImportSessionWorkflowService,
        ...args: Parameters<typeof original>
      ) {
        arrivals++;
        if (arrivals === 2) release();
        await bothDispatched;
        return original.apply(this, args);
      });
    const issue = jest.spyOn(
      ImportUiGrantIssuer.prototype,
      "issueFinancialAction",
    );
    const [a, b] = await Promise.all([
      invoke(active, f, ROUTES[11]),
      invoke(active, f, ROUTES[11]),
    ]);
    expect(a.status).toBe(200);
    expect(b).toEqual(a);
    expect(arrivals).toBe(2);
    expect(issue).toHaveBeenCalledTimes(2);
    expect(issue.mock.results[0].value).not.toBe(issue.mock.results[1].value);
    const after = await snapshot(active, f);
    expect(after.expenses).toHaveLength(2);
    expect(after.cfes).toHaveLength(6);
    expect(after.allocations).toHaveLength(1);
    expect(after.audit).toHaveLength(1);
    expect(after.observations[0].claimVersion).toBe(1);
    expect(after.sessions[0].revision).toBe(10);
  });

  it("deferred_and_multitarget_inputs_are_not_silently_truncated: deferred continuation", async () => {
    const f = await fixture(active, { deferred: true });
    await confirmed(active, f);
    const receipt = await execute(active, f);
    expect(receipt.continuationSessionId).toEqual(expect.any(String));
    const after = await snapshot(active, f);
    const child = after.sessions.find(
      (row) => row.id === receipt.continuationSessionId,
    );
    expect(child).toBeDefined();
    expect(child).toMatchObject({
      state: "DRAFT",
      revision: 1,
      ownerUserId: f.world.users.restricted.id,
    });
    expect(JSON.parse(child!.draftJson)).toEqual({
      version: 1,
      lines: [f.draft.lines[1]],
      selectedLineIds: [f.draft.lines[1].id],
      questions: f.draft.questions,
      fieldProvenance: [],
      scope: {
        observationIds: [f.draft.scope.observationIds[1]],
        pendingAttachmentIds: f.draft.scope.pendingAttachmentIds,
      },
    });
    const childDraft = JSON.parse(
      child!.draftJson,
    ) as ImportSessionStoredDraftV1;
    expect(childDraft.scope.pendingAttachmentIds).toHaveLength(1);
    expect(
      after.attachments.filter((row) => row.sessionId === child!.id),
    ).toHaveLength(2);
    expect(
      after.observations.find(
        (row) => row.id === f.draft.scope.observationIds[1],
      ),
    ).toMatchObject({
      claimVersion: 3,
      claimSessionId: null,
      canonicalExpenseId: null,
    });
    expect(receipt.items.map((item) => item.lineId)).toEqual(["purchase"]);
  });

  it.each([2, 4])(
    "deferred_and_multitarget_inputs_are_not_silently_truncated: %s targets",
    async (count) => {
      const f = await fixture(active);
      const projects = [f.target.id];
      for (let index = 1; index < count; index++) {
        projects.push(
          (
            await active.prisma.project.create({
              data: {
                tenantId: f.world.tenantId,
                type: "REFORMA",
                name: `Synthetic ${index}`,
              },
            })
          ).id,
        );
      }
      await active.prisma.user.update({
        where: { id: f.world.users.restricted.id },
        data: {
          allowedProjects: JSON.stringify([
            f.world.projects.pessoal,
            ...projects,
          ]),
        },
      });
      const rejected = await invoke(active, f, ROUTES[1], {
        data: {
          version: 1,
          requestId: DOCUMENTARY_IDS.resolution,
          expectedRevision: 7,
          questionId: "pending-question",
          answer: {
            kind: "TARGETS",
            value: projects.map((projectId) => ({
              projectId,
              roomId: null,
              amountCents: 60000 / count,
            })),
          },
        },
      });
      expect(rejected).toEqual({
        status: 400,
        body: wire("INVALID_INPUT"),
      });
      expect(IMPORT_SESSION_LIMITS.targetsPerPurchase).toBe(1);
      const after = await snapshot(active, f);
      expect(after.expenses).toEqual([]);
      expect(after.cfes).toEqual([]);
      expect(after.allocations).toEqual([]);
      expect(after.audit).toEqual([]);
      expect(after.observations[0].claimVersion).toBe(0);
    },
  );
});

async function freezeExtraction(
  prisma: PrismaService,
  artifactId: string,
): Promise<void> {
  const rows = await prisma.importObservation.findMany({
    where: { artifactId },
  });
  rows.sort((a, b) =>
    a.reference.localeCompare(b.reference, "en", { numeric: true }),
  );
  const extraction = validateDocumentExtraction({
    version: 1,
    parserVersion: "card-local-text-v1",
    documentKind: "UNKNOWN",
    invoiceDueMonth: null,
    metrics: {
      pages: 0,
      rows: rows.length,
      expandedBytes: 0,
      archiveEntries: 0,
      imagePixels: 0,
      frames: 0,
    },
    occurrences: rows.map((row, sourceOrdinal) => {
      const original = parseStoredImportObservationEvidence(row.evidenceJson);
      return {
        reference: row.reference,
        sourceOrdinal,
        section: "UNKNOWN",
        raw: {
          date: original.dataCompra,
          description: original.text,
          amount: null,
          installment: null,
        },
        cycle: null,
        dateOnly: original.dataCompra,
        merchant: original.identity.merchant,
        amountCents: original.amountCents,
        amountMeaning: original.amountMeaning,
        installmentCount: original.installmentCount,
        installmentIndex: original.installmentIndex,
        fitId: original.identity.fitId,
        identityOrdinal: original.identity.ordinal,
      };
    }),
    diagnostics: [],
  });
  await prisma.importArtifact.update({
    where: { id: artifactId },
    data: { extractionJson: JSON.stringify(extraction) },
  });
}
