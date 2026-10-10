require("../../../../../scripts/test-db-env.cjs");

import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Prisma, type ImportSession } from "@prisma/client";
import {
  ExpenseType,
  IMPORT_SESSION_PRIMITIVES,
  type ExpenseScheduleV1,
  type ImportSessionDraftLineV1,
  type ImportSessionObservationViewV1,
  type ImportSessionStoredDraftV1,
} from "@reformaflow/domain";
import { ConciliacaoService } from "../../conciliacao/conciliacao.service";
import { canonical } from "../../common/canonical";
import * as canonicalSerialization from "../../common/canonical";
import {
  computeImportOrdinals,
  dedupeKeyNatural,
  fileContentHash,
} from "../../credit-card/parsers/dedupe-key";
import { createRateioTargets } from "../../expense/create-rateio-targets";
import {
  parseStoredExpenseSchedule,
  toPublicExpenseSchedule,
} from "../../expense/documented-schedule";
import { ExpenseService } from "../../expense/expense.service";
import type { RateioRequester } from "../../expense/rateio.types";
import {
  INCLUDE_SOFT_DELETED,
  PrismaService,
} from "../../prisma/prisma.service";
import {
  authFor,
  MutableClock,
  seedImportWorld,
  seedSession,
  type ImportWorld,
} from "../../test-utils/import-session-harness";
import type {
  CardPurchaseBatchPort,
  CardPurchasePreparation,
  StoredImportSearchV1,
} from "./card-purchase-batch.port";
import { CardPurchasePreparationPurpose } from "./card-purchase-batch.port";
import { reauthorize } from "./import-session.auth";
import type { ImportSessionClock } from "./import-session.capability";
import {
  assertPreparedCardBatch,
  mintLockedImportSession,
  releaseLockedImportSession,
  type AuthenticatedImportContext,
  type LockedImportSession,
  type PreparedCardBatch,
} from "./import-session.contract";
import * as executionContract from "./import-session.contract";
import { validateStoredDraft } from "./import-session.validation";
import { parseStoredImportObservationEvidence } from "./import-session.observation";
import { validateDocumentExtraction } from "../../credit-card/parsers/statement-document";
import * as extractionHelpers from "./import-session.extraction";
import { resolveImportDeclarations } from "./import-session.declarations";

type AdapterConstructor = new (
  expenses: ExpenseService,
  conciliacao: ConciliacaoService,
  clock: ImportSessionClock,
) => CardPurchaseBatchPort;

function adapterExport(): unknown {
  const candidate = resolve(__dirname, "card-purchase-batch.adapter");
  let resolved: string;
  try {
    resolved = require.resolve(candidate);
  } catch (error) {
    if (
      object(error) &&
      error.code === "MODULE_NOT_FOUND" &&
      typeof error.message === "string" &&
      /^Cannot find module '([^']+)'/.exec(error.message)?.[1] === candidate
    ) {
      return undefined;
    }
    throw error;
  }
  // Loading is deliberately outside the catch: a missing transitive dependency is not RED.
  const loaded: unknown = require(resolved);
  return loaded !== null && typeof loaded === "object"
    ? Reflect.get(loaded, "CardPurchaseBatchAdapter")
    : undefined;
}

function assertConstructor(
  value: unknown,
): asserts value is AdapterConstructor {
  expect({
    export: "CardPurchaseBatchAdapter",
    type: typeof value,
  }).toEqual({ export: "CardPurchaseBatchAdapter", type: "function" });
}

const NOW = new Date("2026-10-06T15:00:00.000Z");
const EXPIRES = new Date("2026-10-13T15:00:00.000Z");
const SCHEDULE: ExpenseScheduleV1 = {
  version: 1,
  occurrences: [
    {
      index: 0,
      parcela: "1/10",
      valor: 6984,
      data: "2026-11-10",
      invoiceDueMonth: "2026-11",
    },
    {
      index: 1,
      parcela: "2/10",
      valor: 6984,
      data: "2026-12-10",
      invoiceDueMonth: "2026-12",
    },
    {
      index: 2,
      parcela: "3/10",
      valor: 6984,
      data: "2027-01-10",
      invoiceDueMonth: "2027-01",
    },
    {
      index: 3,
      parcela: "4/10",
      valor: 6984,
      data: "2027-02-10",
      invoiceDueMonth: "2027-02",
    },
    {
      index: 4,
      parcela: "5/10",
      valor: 6984,
      data: "2027-03-10",
      invoiceDueMonth: "2027-03",
    },
    {
      index: 5,
      parcela: "6/10",
      valor: 6984,
      data: "2027-04-10",
      invoiceDueMonth: "2027-04",
    },
    {
      index: 6,
      parcela: "7/10",
      valor: 6984,
      data: "2027-05-10",
      invoiceDueMonth: "2027-05",
    },
    {
      index: 7,
      parcela: "8/10",
      valor: 6984,
      data: "2027-06-10",
      invoiceDueMonth: "2027-06",
    },
    {
      index: 8,
      parcela: "9/10",
      valor: 6984,
      data: "2027-07-10",
      invoiceDueMonth: "2027-07",
    },
    {
      index: 9,
      parcela: "10/10",
      valor: 6984,
      data: "2027-08-10",
      invoiceDueMonth: "2027-08",
    },
  ],
};
const INVOICE_DELTAS = [
  { invoiceDueMonth: "2026-11", amountCents: 13968 },
  { invoiceDueMonth: "2026-12", amountCents: 13968 },
  { invoiceDueMonth: "2027-01", amountCents: 13968 },
  { invoiceDueMonth: "2027-02", amountCents: 13968 },
  { invoiceDueMonth: "2027-03", amountCents: 13968 },
  { invoiceDueMonth: "2027-04", amountCents: 13968 },
  { invoiceDueMonth: "2027-05", amountCents: 13968 },
  { invoiceDueMonth: "2027-06", amountCents: 13968 },
  { invoiceDueMonth: "2027-07", amountCents: 13968 },
  { invoiceDueMonth: "2027-08", amountCents: 13968 },
];
const STAGES = ["DOCUMENT_IDENTITY", "CROSS_ORIGIN", "CARD_IDENTITY"];
const SIDE_TABLES = [
  "receipts",
  "credit_card_imports",
  "bank_statement_imports",
  "cross_project_settlements",
  "imported_invoice_liquidations",
  "invoice_funding_allocations",
  "invoice_adjustments",
  "invoice_reconciliation_sources",
  "invoice_replay_operations",
  "budget_allocations",
  "bank_accounts",
] as const;
type Fixture = {
  world: ImportWorld;
  row: ImportSession;
  draft: ImportSessionStoredDraftV1;
  auth: AuthenticatedImportContext;
  requester: RateioRequester & { id: string };
  artifactId: string;
  attachmentId: string;
  documentSha256: string;
  fileContentHash: string;
};
type OriginalObservation = Omit<
  ImportSessionObservationViewV1,
  "id" | "attachmentId"
> & { merchant: string; dataCompra: string; amountCents: number };
const WRITE_BOUNDARIES = [
  { claims: 188, perLine: [19, 19, 19, 19, 19, 19, 19, 19, 18, 18], cost: 512 },
  { claims: 189, perLine: [19, 19, 19, 19, 19, 19, 19, 19, 19, 18], cost: 513 },
  { claims: 200, perLine: [20, 20, 20, 20, 20, 20, 20, 20, 20, 20], cost: 524 },
];
type Write = {
  model: string;
  action: string;
  inTransaction: boolean;
  args: unknown;
};
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function canonicalInputForHash(
  serialization: jest.SpyInstance,
  expectedHash: string,
): unknown {
  for (let index = 0; index < serialization.mock.calls.length; index += 1) {
    const result = serialization.mock.results[index];
    if (result?.type !== "return" || typeof result.value !== "string") continue;
    if (sha(result.value) === expectedHash)
      return structuredClone(serialization.mock.calls[index][0]);
  }
  throw new Error(`Missing canonical input for hash ${expectedHash}`);
}

function changedCanonicalPaths(
  before: unknown,
  after: unknown,
  path = "$",
): string[] {
  if (canonical(before) === canonical(after)) return [];
  if (Array.isArray(before) && Array.isArray(after)) {
    const paths: string[] = [];
    for (
      let index = 0;
      index < Math.max(before.length, after.length);
      index += 1
    )
      paths.push(
        ...changedCanonicalPaths(
          before[index],
          after[index],
          `${path}[${index}]`,
        ),
      );
    return paths;
  }
  if (object(before) && object(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .sort()
      .flatMap((key) =>
        changedCanonicalPaths(before[key], after[key], `${path}.${key}`),
      );
  }
  return [path];
}

// Fixture serializer only; the shared production parser remains W-owned and is not imported here.
function originalEvidence(
  fact: OriginalObservation,
  ordinal: number,
  contentHash: string,
): string {
  const { merchant, ...fields } = fact;
  return JSON.stringify({
    version: 1,
    ...fields,
    identity: {
      merchant,
      externalId: null,
      fitId: null,
      ordinal,
      fileContentHash: contentHash,
    },
  });
}

describe("M1 CardPurchaseBatchPort adapter (in-process; no workflow implementation)", () => {
  const prisma = new PrismaService();
  const conciliacao = new ConciliacaoService(prisma);
  const expenses = new ExpenseService(prisma, conciliacao);
  const clock = new MutableClock(NOW);
  const writes: Write[] = [];
  let failTargetProject: string | null = null;
  let targetCfes = 0;
  let measuredReads: Array<{
    model: string;
    rows: number;
    cap: number;
  }> | null = null;

  prisma.$use(async (params, next) => {
    if (
      [
        "create",
        "createMany",
        "update",
        "updateMany",
        "delete",
        "deleteMany",
        "upsert",
      ].includes(params.action)
    ) {
      writes.push({
        model: params.model ?? "",
        action: params.action,
        inTransaction: params.runInTransaction,
        args: structuredClone(params.args),
      });
      if (
        params.model === "CashFlowEntry" &&
        ["create", "createMany"].includes(params.action)
      ) {
        const data: unknown = params.args?.data;
        for (const entry of Array.isArray(data) ? data : [data]) {
          if (
            object(entry) &&
            failTargetProject !== null &&
            entry.projectId === failTargetProject
          ) {
            targetCfes += 1;
            if (targetCfes === 20) throw new Error("qa-last-target-cfe");
          }
        }
      }
    }
    return next(params);
  });
  prisma.$use(async (params, next) => {
    if (
      !measuredReads ||
      !["findUnique", "findFirst", "findMany", "queryRaw"].includes(
        params.action,
      )
    )
      return next(params);
    let cap: unknown = params.action === "findUnique" ? 1 : params.args?.take;
    if (params.action === "queryRaw") {
      const sql = Prisma.sql(params.args[0], ...params.args.slice(1));
      expect(sql.sql).toMatch(/LIMIT\s+\?\s*$/);
      cap = sql.values[sql.values.length - 1];
    }
    const spent = measuredReads.reduce((sum, row) => sum + row.rows, 0);
    expect(typeof cap).toBe("number");
    if (typeof cap !== "number")
      throw new Error("Unbounded materializing query");
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThanOrEqual(Math.min(300, 5001 - spent));
    const result: unknown = await next(params);
    let rows = Array.isArray(result) ? result.length : result === null ? 0 : 1;
    if (params.model === "User" && object(result) && object(result.tenant))
      rows += 1;
    measuredReads.push({ model: params.model ?? "RAW", rows, cap });
    return result;
  });

  function adapter(): CardPurchaseBatchPort {
    const exported = adapterExport();
    assertConstructor(exported);
    return new exported(expenses, conciliacao, clock);
  }

  async function fixture(
    options: {
      lineCount?: number;
      targets?: boolean;
      observationsPerLine?: number | readonly number[];
      installmentCount?: number;
      merchants?: readonly string[];
    } = {},
  ): Promise<Fixture> {
    const world = await seedImportWorld(prisma, `qa-adapter-${randomUUID()}`);
    await prisma.project.update({
      where: { id: world.projects.casa },
      data: { type: "REFORMA", name: "Synthetic Reforma" },
    });
    await prisma.creditCard.update({
      where: { id: world.cards.pessoal },
      data: { closingDay: 4, dueDay: 10 },
    });
    const row = await seedSession(prisma, world, {
      revision: 7,
      consentedAt: NOW,
      lastUserEditAt: NOW,
      expiresAt: EXPIRES,
    });
    const artifactId = randomUUID();
    const attachmentId = randomUUID();
    const documentText = `Synthetic purchase document ${artifactId}`;
    const documentSha256 = sha(documentText);
    const contentHash = fileContentHash([Buffer.from(documentText)]);
    await prisma.importArtifact.create({
      data: {
        id: artifactId,
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        documentSha256,
        verifiedBytes: 100,
        detectedFormat: "PDF",
        state: "EXTRACTED",
        parserVersion: "card-local-pdf-v1",
        storageKey: `synthetic/${artifactId}`,
      },
    });
    await prisma.importSessionArtifact.create({
      data: {
        id: attachmentId,
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        sessionId: row.id,
        artifactId,
        position: 0,
        fileName: "synthetic.pdf",
        declaredMime: "application/pdf",
        declaredBytes: 100,
        reservedBytes: 0,
        state: "ATTACHED",
        verifiedAt: NOW,
      },
    });
    const lineCount = options.lineCount ?? 2;
    const count = options.installmentCount ?? 10;
    const perLine = options.observationsPerLine ?? 1;
    const extracted: Array<{ lineIndex: number; fact: OriginalObservation }> =
      [];
    for (let index = 0; index < lineCount; index += 1) {
      const observations =
        typeof perLine === "number" ? perLine : perLine[index];
      if (observations === undefined || observations < 1 || observations > 20)
        throw new Error("Invalid observation-count fixture");
      for (let part = 0; part < observations; part += 1) {
        extracted.push({
          lineIndex: index,
          fact: {
            reference: `pdf:page:1:line:${index * 20 + part + 1}`,
            text: `Synthetic supplier: total 69840 cents in ${count} installments`,
            amountMeaning: "TOTAL_PURCHASE",
            amountCents: 69840,
            installmentCount: count,
            installmentIndex: null,
            dataCompra: "2026-10-05",
            merchant: options.merchants?.[index] ?? "Synthetic supplier",
          },
        });
      }
    }
    const ordinals = computeImportOrdinals(
      extracted.map(({ fact }) => ({
        date: new Date(fact.dataCompra),
        merchant: fact.merchant,
        amountCents: fact.amountCents,
      })),
    );
    const idsByLine = Array.from({ length: lineCount }, (): string[] => []);
    for (const [position, { lineIndex, fact }] of extracted.entries()) {
      const id = randomUUID();
      await prisma.importObservation.create({
        data: {
          id,
          tenantId: world.tenantId,
          ownerProjectId: world.projects.pessoal,
          artifactId,
          reference: fact.reference,
          evidenceJson: originalEvidence(fact, ordinals[position], contentHash),
        },
      });
      idsByLine[lineIndex].push(id);
    }
    await freezeExtraction(prisma, artifactId);
    const lines: ImportSessionDraftLineV1[] = [];
    for (let index = 0; index < lineCount; index += 1) {
      lines.push({
        id: `purchase-${index}`,
        observationIds: idsByLine[index],
        titulo: "Synthetic supplier purchase",
        fornecedor: options.merchants?.[index] ?? "Synthetic supplier",
        tipoDespesa:
          options.targets === false
            ? ExpenseType.ELETRODOMESTICO
            : ExpenseType.MATERIAL_CONSTRUCAO,
        categoriaMaoDeObra: null,
        amountMeaning: "TOTAL_PURCHASE",
        amountCents: 69840,
        installmentCount: count,
        dataCompra: "2026-10-05",
        firstDueDate: "2026-11-10",
        targets:
          options.targets === false
            ? []
            : [
                {
                  projectId: world.projects.casa,
                  roomId: null,
                  amountCents: 69840,
                },
              ],
        decision: { kind: "CREATE", acceptNaturalDuplicate: false },
      });
    }
    const draft = validateStoredDraft({
      version: 1,
      lines,
      selectedLineIds: lines.map((line) => line.id),
      questions: [],
      fieldProvenance: lines.flatMap((line) => [
        {
          origin: "FILE",
          lineId: line.id,
          field: "decision",
          recordedRevision: 7,
        },
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
      ]),
      scope: {
        observationIds: lines.flatMap((line) => line.observationIds),
        pendingAttachmentIds: [],
      },
    });
    await prisma.importSession.update({
      where: { id: row.id },
      data: { draftJson: JSON.stringify(draft) },
    });
    return {
      world,
      row,
      draft,
      artifactId,
      attachmentId,
      documentSha256,
      fileContentHash: contentHash,
      auth: authFor(world.users.owner, { expiresAt: EXPIRES }),
      requester: { id: world.users.owner.id, role: "OWNER" },
    };
  }

  async function saveDraft(f: Fixture): Promise<void> {
    await prisma.importSession.update({
      where: { id: f.row.id },
      data: { draftJson: JSON.stringify(f.draft) },
    });
  }

  async function setPurchaseAmounts(
    f: Fixture,
    amounts: readonly number[],
  ): Promise<void> {
    if (amounts.length !== f.draft.lines.length)
      throw new Error("Amount fixture must cover every draft line");
    const observations = await prisma.importObservation.findMany({
      where: { artifactId: f.artifactId },
      orderBy: { reference: "asc" },
    });
    for (const [index, line] of f.draft.lines.entries()) {
      const amountCents = amounts[index]!;
      line.amountCents = amountCents;
      line.installmentCount = 1;
      line.targets = [];
      const observation = observations.find((row) =>
        line.observationIds.includes(row.id),
      );
      if (!observation) throw new Error("Missing amount fixture observation");
      const evidence = parseStoredImportObservationEvidence(
        observation.evidenceJson,
      );
      await prisma.importObservation.update({
        where: { id: observation.id },
        data: {
          evidenceJson: JSON.stringify({
            ...evidence,
            text: `Synthetic aggregate purchase ${amountCents} cents`,
            amountCents,
            installmentCount: 1,
            identity: { ...evidence.identity, ordinal: 0 },
          }),
        },
      });
    }
    await freezeExtraction(prisma, f.artifactId);
    await saveDraft(f);
  }

  async function unresolvedDocumentaryQuestions(f: Fixture, lineId: string) {
    const line = f.draft.lines.find((candidate) => candidate.id === lineId);
    if (!line) throw new Error("Missing documentary fixture line");
    for (const observationId of line.observationIds) {
      const observation = await prisma.importObservation.findUniqueOrThrow({
        where: { id: observationId },
      });
      const evidence = parseStoredImportObservationEvidence(
        observation.evidenceJson,
      );
      await prisma.importObservation.update({
        where: { id: observation.id },
        data: {
          evidenceJson: JSON.stringify({
            ...evidence,
            installmentCount: null,
            dataCompra: null,
            identity: { ...evidence.identity, ordinal: null },
          }),
        },
      });
    }
    const artifactObservations = await prisma.importObservation.findMany({
      where: { artifactId: f.artifactId },
      orderBy: { reference: "asc" },
    });
    const parsed = artifactObservations.map((observation) => ({
      observation,
      evidence: parseStoredImportObservationEvidence(observation.evidenceJson),
    }));
    const ordinals = computeImportOrdinals(
      parsed.flatMap(({ evidence }) =>
        evidence.dataCompra === null ||
        evidence.identity.merchant === null ||
        evidence.amountCents === null
          ? []
          : [
              {
                date: new Date(`${evidence.dataCompra}T00:00:00.000Z`),
                merchant: evidence.identity.merchant,
                amountCents: evidence.amountCents,
              },
            ],
      ),
    );
    let ordinalIndex = 0;
    for (const { observation, evidence } of parsed) {
      const ordinal =
        evidence.dataCompra === null ||
        evidence.identity.merchant === null ||
        evidence.amountCents === null
          ? null
          : ordinals[ordinalIndex++];
      await prisma.importObservation.update({
        where: { id: observation.id },
        data: {
          evidenceJson: JSON.stringify({
            ...evidence,
            identity: { ...evidence.identity, ordinal },
          }),
        },
      });
    }
    await freezeExtraction(prisma, f.artifactId);
    const observations = await prisma.importObservation.findMany({
      where: { id: { in: f.draft.scope.observationIds } },
    });
    const references = await prisma.importSessionArtifact.findMany({
      where: { sessionId: f.row.id },
    });
    const artifactIds = references.flatMap((reference) =>
      reference.artifactId === null ? [] : [reference.artifactId],
    );
    const artifacts = await prisma.importArtifact.findMany({
      where: { id: { in: artifactIds } },
    });
    const artifactById = new Map(
      artifacts.map((artifact) => [artifact.id, artifact]),
    );
    return resolveImportDeclarations(f.row, f.draft, {
      observations,
      references: references.map((ref) => ({
        ref,
        artifact:
          ref.artifactId === null
            ? null
            : (artifactById.get(ref.artifactId) ?? null),
      })),
    }).questions;
  }

  async function pendingAttachments(f: Fixture, count: number): Promise<void> {
    const previous = await prisma.importSessionArtifact.findFirstOrThrow({
      where: { sessionId: f.row.id },
      orderBy: { position: "desc" },
    });
    for (let index = 0; index < count; index += 1) {
      const artifact = await prisma.importArtifact.create({
        data: {
          tenantId: f.world.tenantId,
          ownerProjectId: f.world.projects.pessoal,
          documentSha256: sha(`Synthetic deferred ${f.row.id}/${index}`),
          verifiedBytes: 100,
          detectedFormat: "PDF",
          state: "RAW_READY",
          storageKey: `synthetic/deferred/${f.row.id}/${index}`,
        },
      });
      const ref = await prisma.importSessionArtifact.create({
        data: {
          tenantId: f.world.tenantId,
          ownerProjectId: f.world.projects.pessoal,
          sessionId: f.row.id,
          artifactId: artifact.id,
          position: previous.position + index + 1,
          fileName: "synthetic-deferred.pdf",
          declaredMime: "application/pdf",
          declaredBytes: 100,
          reservedBytes: 0,
          state: "ATTACHED",
          verifiedAt: NOW,
        },
      });
      f.draft.scope.pendingAttachmentIds.push(ref.id);
    }
    validateStoredDraft(f.draft);
    await saveDraft(f);
  }

  async function locked<T>(
    f: Fixture,
    run: (
      tx: Prisma.TransactionClient,
      session: LockedImportSession,
    ) => Promise<T>,
    auth = f.auth,
  ): Promise<T> {
    return prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`UPDATE tenants SET id = id WHERE id = ${f.world.tenantId}`;
        await reauthorize(tx, auth, clock.now());
        const row = await tx.importSession.findUniqueOrThrow({
          where: { id: f.row.id },
        });
        const session = mintLockedImportSession(tx, auth, row, f.draft);
        try {
          return await run(tx, session);
        } finally {
          releaseLockedImportSession(session);
        }
      },
      { maxWait: 5000, timeout: 20000 },
    );
  }

  const prepare = (a: CardPurchaseBatchPort, f: Fixture) =>
    locked(f, (tx, session) => a.prepareInTx(tx, f.auth, session));

  function ready(
    value: CardPurchasePreparation,
  ): asserts value is Extract<CardPurchasePreparation, { kind: "READY" }> {
    expect(value.kind).toBe("READY");
  }

  function searchShape(search: StoredImportSearchV1, f: Fixture): void {
    expect(Object.keys(search).sort()).toEqual([
      "candidates",
      "complete",
      "coverage",
      "revision",
      "version",
    ]);
    expect(search).toMatchObject({
      version: 1,
      revision: 8,
      coverage: { recipe: "CARD_PURCHASE_V1" },
    });
    expect(search.coverage.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(
      search.coverage.steps
        .map((step) => `${step.lineId}:${step.stage}`)
        .sort(),
    ).toEqual(
      f.draft.selectedLineIds
        .flatMap((id) => STAGES.map((stage) => `${id}:${stage}`))
        .sort(),
    );
    expect(
      search.coverage.steps.reduce((sum, step) => sum + step.visitedRows, 0),
    ).toBeLessThanOrEqual(5000);
    for (const step of search.coverage.steps) {
      expect(Number.isSafeInteger(step.visitedRows)).toBe(true);
      expect(step.visitedRows).toBeGreaterThanOrEqual(0);
      expect(step.endCursor).toBeNull();
      if (step.status === "EXHAUSTED")
        expect(step.predicateHash).toMatch(/^[0-9a-f]{64}$/);
      else
        expect(step).toMatchObject({
          status: "NOT_RUN",
          predicateHash: null,
          visitedRows: 0,
        });
    }
    expect(search.complete).toBe(
      f.draft.selectedLineIds.length > 0 &&
        search.coverage.steps.every((step) => step.status === "EXHAUSTED"),
    );
  }

  // Confirmation rows are test fixtures, not a replacement workflow or proof of its CAS/grants.
  async function seedConfirmation(
    f: Fixture,
    result: CardPurchasePreparation,
  ): Promise<void> {
    ready(result);
    f.draft = structuredClone(result.draft);
    await prisma.importSession.update({
      where: { id: f.row.id },
      data: {
        state: "CONFIRMED",
        revision: 9,
        draftJson: JSON.stringify(result.draft),
        searchJson: JSON.stringify(result.search),
        proposalJson: JSON.stringify(result.batch.proposal),
        proposalHash: result.batch.proposal.proposalHash,
        preflightHash: result.batch.preflightHash,
        confirmedRevision: 8,
        confirmedAt: NOW,
        confirmedSessionVersion: f.auth.presentedSessionVersion,
        financialRequestId: randomUUID(),
      },
    });
  }

  async function apply(a: CardPurchaseBatchPort, f: Fixture) {
    const initial = await prepare(a, f);
    await seedConfirmation(f, initial);
    return locked(f, async (tx, session) => {
      const result = await a.prepareInTx(tx, f.auth, session);
      ready(result);
      ready(initial);
      expect(result.batch.proposal).toEqual(initial.batch.proposal);
      expect(result.batch.preflightHash).toBe(initial.batch.preflightHash);
      assertPreparedCardBatch(tx, f.auth, result.batch);
      const items = await a.applyInTx(tx, f.auth, result.batch);
      expect(() => assertPreparedCardBatch(tx, f.auth, result.batch)).toThrow(
        "Invalid import execution handle",
      );
      return {
        items,
        proposal: result.batch.proposal,
        counts: result.batch.expandedCounts,
      };
    });
  }

  async function financial(f: Fixture) {
    const side: Record<string, unknown[]> = {};
    for (const table of SIDE_TABLES) {
      side[table] = await prisma.$queryRawUnsafe(
        `SELECT * FROM "${table}" WHERE tenant_id = ? ORDER BY id`,
        f.world.tenantId,
      );
    }
    return {
      expenses: await prisma.expense.findMany({
        where: { tenantId: f.world.tenantId, deletedAt: INCLUDE_SOFT_DELETED },
        orderBy: { id: "asc" },
      }),
      cfes: await prisma.cashFlowEntry.findMany({
        where: { tenantId: f.world.tenantId, deletedAt: INCLUDE_SOFT_DELETED },
        orderBy: { id: "asc" },
      }),
      allocations: await prisma.rateioAllocation.findMany({
        where: { tenantId: f.world.tenantId },
        orderBy: { id: "asc" },
      }),
      side,
    };
  }

  async function coordination(f: Fixture) {
    return {
      sessions: await prisma.importSession.findMany({
        where: { tenantId: f.world.tenantId },
        orderBy: { id: "asc" },
      }),
      observations: await prisma.importObservation.findMany({
        where: { tenantId: f.world.tenantId },
        orderBy: { id: "asc" },
      }),
      refs: await prisma.importSessionArtifact.findMany({
        where: { tenantId: f.world.tenantId },
        orderBy: { id: "asc" },
      }),
      artifacts: await prisma.importArtifact.findMany({
        where: { tenantId: f.world.tenantId },
        orderBy: { id: "asc" },
      }),
      audits: await prisma.userActivityLog.findMany({
        where: { tenantId: f.world.tenantId },
        orderBy: { id: "asc" },
      }),
    };
  }

  async function nativeSource(
    f: Fixture,
    tx: Prisma.TransactionClient,
    reference: string,
    schedule: ExpenseScheduleV1 = SCHEDULE,
  ) {
    return expenses.createPlannedCardPurchaseInTx(
      tx,
      f.world.tenantId,
      f.world.projects.pessoal,
      {
        titulo: "Synthetic supplier purchase",
        fornecedor: "Synthetic supplier",
        tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
        categoriaMaoDeObra: null,
        dataCompra: "2026-10-05",
        totalCents: schedule.occurrences.reduce(
          (sum, item) => sum + item.valor,
          0,
        ),
        schedule: structuredClone(schedule),
        cardId: f.world.cards.pessoal,
        evidence: { documentSha256: f.documentSha256, reference },
        reason: "Synthetic approved card purchase",
      },
      f.requester.id,
      f.requester,
    );
  }

  async function replaceObservationFacts(
    id: string,
    change: Partial<OriginalObservation>,
  ): Promise<void> {
    const row = await prisma.importObservation.findUniqueOrThrow({
      where: { id },
    });
    const evidence: unknown = JSON.parse(row.evidenceJson);
    if (!object(evidence)) throw new Error("Invalid fixture evidence");
    await prisma.importObservation.update({
      where: { id },
      data: { evidenceJson: JSON.stringify({ ...evidence, ...change }) },
    });
  }

  async function nativeTarget(
    f: Fixture,
    tx: Prisma.TransactionClient,
    source: { id: string; status: string },
  ) {
    return createRateioTargets(
      tx,
      conciliacao,
      f.world.tenantId,
      source,
      {
        existing: [],
        newTargets: [
          {
            targetProjectId: f.world.projects.casa,
            tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
            titulo: "Synthetic full Reforma destination",
            valor: 698.4,
            quantidade: 1,
            allocation: 69840,
            status: "PLANEJADO",
          },
        ],
      },
      f.requester.id,
      f.requester,
    );
  }

  async function nativeTwins(f: Fixture, count = 2): Promise<string[]> {
    return locked(f, async (tx) => {
      const ids: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const source = await nativeSource(
          f,
          tx,
          `pdf:page:1:line:${i * 20 + 1}`,
        );
        await nativeTarget(f, tx, source);
        ids.push(source.id);
      }
      return ids;
    });
  }

  async function laterInvoice(f: Fixture): Promise<void> {
    f.draft.lines = [f.draft.lines[0]];
    const line = f.draft.lines[0];
    f.draft.fieldProvenance = f.draft.fieldProvenance?.filter(
      (item) => item.lineId === line.id,
    );
    line.amountMeaning = "INSTALLMENT_CHARGE";
    line.amountCents = 6984;
    line.firstDueDate = "2026-11-10";
    line.targets = null;
    line.decision = { kind: "UNRESOLVED" };
    f.draft.selectedLineIds = [line.id];
    const documentText = `Synthetic later invoice ${f.artifactId}`;
    f.documentSha256 = sha(documentText);
    f.fileContentHash = fileContentHash([Buffer.from(documentText)]);
    const previous = await prisma.importSessionArtifact.findFirstOrThrow({
      where: { sessionId: f.row.id },
      orderBy: { position: "desc" },
    });
    const artifact = await prisma.importArtifact.create({
      data: {
        tenantId: f.world.tenantId,
        ownerProjectId: f.world.projects.pessoal,
        documentSha256: f.documentSha256,
        verifiedBytes: 100,
        detectedFormat: "PDF",
        state: "EXTRACTED",
        parserVersion: "card-local-pdf-v1",
        storageKey: `synthetic/later/${f.row.id}`,
      },
    });
    const attachment = await prisma.importSessionArtifact.create({
      data: {
        tenantId: f.world.tenantId,
        ownerProjectId: f.world.projects.pessoal,
        sessionId: f.row.id,
        artifactId: artifact.id,
        position: previous.position + 1,
        fileName: "synthetic-later.pdf",
        declaredMime: "application/pdf",
        declaredBytes: 100,
        reservedBytes: 0,
        state: "ATTACHED",
        verifiedAt: NOW,
      },
    });
    f.artifactId = artifact.id;
    f.attachmentId = attachment.id;
    const observation: OriginalObservation = {
      reference: "pdf:page:1:line:1",
      text: "Synthetic supplier 2/10, 6984 cents",
      amountMeaning: "INSTALLMENT_CHARGE",
      amountCents: 6984,
      installmentCount: 10,
      installmentIndex: 2,
      dataCompra: "2026-10-05",
      merchant: "Synthetic supplier",
    };
    const [ordinal] = computeImportOrdinals([
      {
        date: new Date(observation.dataCompra),
        merchant: observation.merchant,
        amountCents: observation.amountCents,
      },
    ]);
    const row = await prisma.importObservation.create({
      data: {
        tenantId: f.world.tenantId,
        ownerProjectId: f.world.projects.pessoal,
        artifactId: f.artifactId,
        reference: observation.reference,
        evidenceJson: originalEvidence(observation, ordinal, f.fileContentHash),
      },
    });
    line.observationIds = [row.id];
    f.draft.scope.observationIds = [row.id];
    await freezeExtraction(prisma, artifact.id);
    await saveDraft(f);
  }

  async function noEffects<T>(
    f: Fixture,
    action: () => Promise<T>,
  ): Promise<T> {
    const before = {
      financial: await financial(f),
      coordination: await coordination(f),
    };
    try {
      return await action();
    } finally {
      expect({
        financial: await financial(f),
        coordination: await coordination(f),
      }).toEqual(before);
    }
  }

  beforeAll(async () => {
    expect(process.env.TZ).toBe("UTC");
    await prisma.$connect();
    const databases = await prisma.$queryRaw<
      Array<{ name: string; file: string }>
    >`PRAGMA database_list`;
    expect(databases.find((row) => row.name === "main")?.file).toBe(
      resolve(__dirname, "../../../../../prisma/test-worker-1.db"),
    );
    const fk = await prisma.$queryRaw<
      Array<{ foreign_keys: bigint | number }>
    >`PRAGMA foreign_keys`;
    expect(fk.map((row) => Number(row.foreign_keys))).toEqual([1]);
    expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
  });
  beforeEach(() => {
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
    clock.current = NOW;
    writes.length = 0;
    targetCfes = 0;
    failTargetProject = null;
  });
  afterEach(() => {
    measuredReads = null;
    failTargetProject = null;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
  afterAll(async () => {
    expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
    await prisma.$disconnect();
  });

  it("CONTROL: genuine auth/locked handles bind the actual transaction and release", async () => {
    const f = await fixture();
    let saved: LockedImportSession | undefined;
    await locked(f, async (_tx, session) => {
      saved = session;
      expect(session).toMatchObject({
        id: f.row.id,
        revision: 7,
        ownerUserId: f.auth.userId,
      });
      expect(Object.isFrozen(session.draft.lines[0])).toBe(true);
    });
    expect(saved).toBeDefined();
    expect(() => releaseLockedImportSession(saved!)).not.toThrow();
  });

  it("CONTROL: original evidence uses the exact envelope and full-document ordinals, unchanged by editing/selection", async () => {
    const f = await fixture();
    const before = await prisma.importObservation.findMany({
      where: { artifactId: f.artifactId },
      orderBy: { reference: "asc" },
    });
    expect(before.map((row) => JSON.parse(row.evidenceJson))).toEqual(
      [0, 1].map((index) => ({
        version: 1,
        reference: `pdf:page:1:line:${index * 20 + 1}`,
        text: "Synthetic supplier: total 69840 cents in 10 installments",
        amountMeaning: "TOTAL_PURCHASE",
        amountCents: 69840,
        installmentCount: 10,
        installmentIndex: null,
        dataCompra: "2026-10-05",
        identity: {
          merchant: "Synthetic supplier",
          externalId: null,
          fitId: null,
          ordinal: index,
          fileContentHash: f.fileContentHash,
        },
      })),
    );
    expect(f.documentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(f.fileContentHash).toMatch(/^[0-9a-f]{32}$/);
    f.draft.selectedLineIds = ["purchase-1"];
    f.draft.lines[1].fornecedor = "Human corrected title";
    await saveDraft(f);
    expect(
      await prisma.importObservation.findMany({
        where: { artifactId: f.artifactId },
        orderBy: { reference: "asc" },
      }),
    ).toEqual(before);
    expect(JSON.parse(before[1].evidenceJson).identity.ordinal).toBe(1);
  });

  it.each(WRITE_BOUNDARIES)(
    "CONTROL: $claims distinct claims have ten actual 12-installment/integral-target lines, one artifact and no deferred scope",
    async ({ claims, perLine }) => {
      const f = await fixture({
        lineCount: 10,
        observationsPerLine: perLine,
        installmentCount: 12,
      });
      const rows = await coordination(f);
      expect(f.draft.selectedLineIds).toHaveLength(10);
      expect(f.draft.lines.map((line) => line.observationIds.length)).toEqual(
        perLine,
      );
      expect(
        f.draft.lines.every((line) => line.observationIds.length <= 20),
      ).toBe(true);
      expect(
        f.draft.lines.every(
          (line) =>
            line.installmentCount === 12 &&
            line.targets?.length === 1 &&
            line.targets[0].amountCents === 69840,
        ),
      ).toBe(true);
      expect(rows.observations).toHaveLength(claims);
      expect(
        new Set(f.draft.lines.flatMap((line) => line.observationIds)).size,
      ).toBe(claims);
      expect(
        rows.observations.every(
          (row) =>
            row.claimVersion === 0 &&
            JSON.parse(row.evidenceJson).installmentCount === 12,
        ),
      ).toBe(true);
      expect(rows.refs).toHaveLength(1);
      expect(rows.artifacts).toHaveLength(1);
      expect(rows.artifacts[0].leaseSessionId).toBeNull();
      expect(f.draft.scope.observationIds).toHaveLength(claims);
      expect(f.draft.scope.pendingAttachmentIds).toEqual([]);
      const money = await financial(f);
      expect(money.expenses).toEqual([]);
      expect(money.allocations).toEqual([]);
      expect(money.cfes).toEqual([]);
    },
  );

  it("CONTROL: native V2 source has the literal ten cycles and no bank effects", async () => {
    const f = await fixture({ lineCount: 1, targets: false });
    const before = await coordination(f);
    const source = await locked(f, (tx) =>
      nativeSource(f, tx, "pdf:page:1:line:1"),
    );
    const rows = await financial(f);
    expect(rows.expenses).toHaveLength(1);
    expect(rows.cfes).toHaveLength(10);
    expect(
      toPublicExpenseSchedule(
        parseStoredExpenseSchedule(source.documentedSchedule),
      ),
    ).toEqual(SCHEDULE);
    expect(source).toMatchObject({
      status: "PLANEJADO",
      valorTotal: 69840,
      bankLast4: null,
      accountId: null,
    });
    expect(rows.side).toEqual(
      Object.fromEntries(SIDE_TABLES.map((table) => [table, []])),
    );
    expect(await coordination(f)).toEqual(before);
  });

  it("CONTROL: native twins and integral targets produce 4 expenses/2 allocations/40 CFEs", async () => {
    const f = await fixture();
    const ids = await nativeTwins(f);
    expect(new Set(ids).size).toBe(2);
    const rows = await financial(f);
    expect(rows.expenses).toHaveLength(4);
    expect(rows.allocations).toHaveLength(2);
    expect(rows.cfes).toHaveLength(40);
    expect(
      rows.cfes.every(
        (entry) => entry.deletedAt === null && entry.status === "PLANEJADO",
      ),
    ).toBe(true);
    for (const expense of rows.expenses) {
      expect(
        toPublicExpenseSchedule(
          parseStoredExpenseSchedule(expense.documentedSchedule),
        ),
      ).toEqual(SCHEDULE);
    }
    expect(
      rows.expenses
        .filter((expense) => ids.includes(expense.id))
        .reduce((sum, row) => sum + row.valorTotal, 0),
    ).toBe(139680);
    expect(rows.side).toEqual(
      Object.fromEntries(SIDE_TABLES.map((table) => [table, []])),
    );
  });

  it("CONTROL: last native target CFE failure rolls back even physical/tombstoned rows", async () => {
    const f = await fixture();
    const before = await financial(f);
    failTargetProject = f.world.projects.casa;
    await expect(nativeTwins(f)).rejects.toThrow("qa-last-target-cfe");
    expect(targetCfes).toBe(20);
    expect(await financial(f)).toEqual(before);
  });

  it("CONTROL: native paid V2 history and deferred scope fixtures are valid without W", async () => {
    const f = await fixture();
    const ids = await nativeTwins(f);
    await locked(f, (tx) =>
      expenses.markPaidInPlace(
        f.world.tenantId,
        ids[1],
        new Date("2026-12-10"),
        tx,
      ),
    );
    const rows = await financial(f);
    expect(rows.expenses.find((row) => row.id === ids[1])).toMatchObject({
      status: "PAGO",
    });
    const paid = rows.cfes.filter(
      (row) => row.expenseId === ids[1] && row.deletedAt === null,
    );
    expect(paid).toHaveLength(10);
    expect(paid.every((row) => row.status === "PAGO")).toBe(true);
    const originalArtifact = await prisma.importArtifact.findUniqueOrThrow({
      where: { id: f.artifactId },
    });
    const originalRows = await prisma.importObservation.findMany({
      where: { artifactId: f.artifactId },
      orderBy: { id: "asc" },
    });
    await laterInvoice(f);
    expect(f.artifactId).not.toBe(originalArtifact.id);
    expect(
      await prisma.importArtifact.findUniqueOrThrow({
        where: { id: originalArtifact.id },
      }),
    ).toEqual(originalArtifact);
    expect(
      await prisma.importObservation.findMany({
        where: { artifactId: originalArtifact.id },
        orderBy: { id: "asc" },
      }),
    ).toEqual(originalRows);
    const observed = await prisma.importObservation.findUniqueOrThrow({
      where: { id: f.draft.lines[0].observationIds[0] },
    });
    expect(JSON.parse(observed.evidenceJson)).toMatchObject({
      version: 1,
      installmentIndex: 2,
      amountCents: 6984,
      identity: {
        merchant: "Synthetic supplier",
        ordinal: 0,
        fileContentHash: f.fileContentHash,
      },
    });
    expect(JSON.parse(observed.evidenceJson)).not.toHaveProperty("id");
    expect(JSON.parse(observed.evidenceJson)).not.toHaveProperty(
      "attachmentId",
    );
    await pendingAttachments(f, 8);
    expect(
      validateStoredDraft(f.draft).scope.pendingAttachmentIds,
    ).toHaveLength(8);
  });

  it("exports the approved real adapter constructor", () => {
    assertConstructor(adapterExport());
  });

  it("prepare is read-only and returns READY8 with genuine handles/full coverage and literal money", async () => {
    const a = adapter();
    const f = await fixture();
    await noEffects(f, () =>
      locked(f, async (tx, session) => {
        writes.length = 0;
        const result = await a.prepareInTx(tx, f.auth, session);
        ready(result);
        expect(writes).toEqual([]);
        assertPreparedCardBatch(tx, f.auth, result.batch);
        searchShape(result.search, f);
        expect(result.search.complete).toBe(true);
        expect(result.batch.proposal).toMatchObject({
          sessionId: f.row.id,
          revision: 8,
          createdEconomicTotalCents: 139680,
          bankCashDeltaCents: 0,
          invoiceDeltas: INVOICE_DELTAS,
        });
        expect(result.batch.proposal.lines).toHaveLength(2);
        for (const line of result.batch.proposal.lines) {
          expect(line).toMatchObject({
            kind: "CREATE",
            totalCents: 69840,
            schedule: SCHEDULE,
          });
          expect(line.kind === "CREATE" && line.targets).toEqual([
            {
              projectId: f.world.projects.casa,
              roomId: null,
              amountCents: 69840,
              schedule: SCHEDULE,
            },
          ]);
        }
        expect(result.batch.observations.map((row) => row.reference)).toEqual([
          "pdf:page:1:line:1",
          "pdf:page:1:line:21",
        ]);
        expect(result.batch.expandedCounts.cashFlowEntries).toBe(40);
        expect(result.batch.expandedCounts.financialAndCoordinationWrites).toBe(
          62,
        );
        const { proposalHash, ...proposal } = result.batch.proposal;
        expect(proposalHash).toBe(
          sha(
            canonical({
              proposal,
              continuation: {
                deferredObservations: [],
                refs: [],
                writeCostUpperBound: 62,
              },
            }),
          ),
        );
      }),
    );
  });

  it.each([1, 10])(
    "binding CREATE total without occurrence stays null with %i installments",
    async (installmentCount) => {
      const a = adapter();
      const f = await fixture({
        lineCount: 1,
        targets: false,
        installmentCount,
      });
      await noEffects(f, async () => {
        const result = await prepare(a, f);
        ready(result);
        expect(
          result.batch.observations.map(
            ({ id, lineId, canonicalIndex, claimVersion }) => ({
              id,
              lineId,
              canonicalIndex,
              claimVersion,
            }),
          ),
        ).toEqual([
          {
            id: f.draft.lines[0].observationIds[0],
            lineId: "purchase-0",
            canonicalIndex: null,
            claimVersion: 0,
          },
        ]);
      });
    },
  );

  it("binding distinct CREATE observations may share occurrence0 and preflight commits their sorted bindings", async () => {
    const a = adapter();
    const f = await fixture({
      lineCount: 1,
      targets: false,
      observationsPerLine: 2,
    });
    for (const id of f.draft.lines[0].observationIds)
      await replaceObservationFacts(id, {
        amountMeaning: "INSTALLMENT_CHARGE",
        amountCents: 6984,
        installmentIndex: 1,
      });
    const bindings = f.draft.lines[0].observationIds
      .map((id) => ({
        id,
        lineId: "purchase-0",
        canonicalIndex: 0,
        claimVersion: 0,
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    await noEffects(f, async () => {
      const serialization = jest.spyOn(canonicalSerialization, "canonical");
      const result = await prepare(a, f);
      ready(result);
      expect(result.batch.observations).toHaveLength(2);
      expect(
        result.batch.observations.map(
          ({ id, lineId, canonicalIndex, claimVersion }) => ({
            id,
            lineId,
            canonicalIndex,
            claimVersion,
          }),
        ),
      ).toEqual(expect.arrayContaining(bindings));
      expect(serialization).toHaveBeenCalledWith(
        expect.arrayContaining([bindings]),
      );
      expect(Object.isFrozen(result.batch.observations)).toBe(true);
      expect(result.batch.observations.every(Object.isFrozen)).toBe(true);
    });
  });

  it("binding CREATE 2/10 resolves occurrence1 against the proposed schedule", async () => {
    const a = adapter();
    const f = await fixture({ lineCount: 1, targets: false });
    await replaceObservationFacts(f.draft.lines[0].observationIds[0], {
      amountMeaning: "INSTALLMENT_CHARGE",
      amountCents: 6984,
      installmentIndex: 2,
    });
    await noEffects(f, async () => {
      const result = await prepare(a, f);
      ready(result);
      expect(result.batch.observations[0].lineId).toBe("purchase-0");
      expect(result.batch.observations[0].canonicalIndex).toBe(1);
    });
  });

  it("binding explicit single charge is occurrence0, not a whole-total inference from quantity1", async () => {
    const a = adapter();
    const f = await fixture({
      lineCount: 1,
      targets: false,
      installmentCount: 1,
    });
    await replaceObservationFacts(f.draft.lines[0].observationIds[0], {
      amountMeaning: "INSTALLMENT_CHARGE",
    });
    await noEffects(f, async () => {
      const result = await prepare(a, f);
      ready(result);
      expect(result.batch.observations[0].lineId).toBe("purchase-0");
      expect(result.batch.observations[0].canonicalIndex).toBe(0);
    });
  });

  it.each([
    {
      amountMeaning: "INSTALLMENT_CHARGE",
      amountCents: 6984,
      installmentIndex: null,
    },
    {
      amountMeaning: "INSTALLMENT_CHARGE",
      amountCents: 6984,
      installmentIndex: 11,
    },
    {
      amountMeaning: "INSTALLMENT_CHARGE",
      amountCents: 6984,
      installmentIndex: 2,
      installmentCount: 9,
    },
    {
      amountMeaning: "INSTALLMENT_CHARGE",
      amountCents: 6983,
      installmentIndex: 2,
    },
    { amountMeaning: "UNKNOWN", installmentIndex: null },
  ] satisfies Partial<OriginalObservation>[])(
    "binding unresolved CREATE facts %j cannot mint a guessed/null occurrence",
    async (change) => {
      const a = adapter();
      const f = await fixture({ lineCount: 1, targets: false });
      await replaceObservationFacts(f.draft.lines[0].observationIds[0], change);
      await noEffects(f, async () => {
        const result = await prepare(a, f);
        expect(result.kind).toBe("NEEDS_INPUT");
        expect(result).not.toHaveProperty("batch");
        if (change.installmentIndex === null) {
          expect(result.draft.questions).toEqual([]);
        } else
          expect(result.draft.questions).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                lineIds: ["purchase-0"],
                field: "decision",
              }),
            ]),
          );
      });
    },
  );

  it.each([
    { partial: false, index: 1, total: 69840, firstDueDate: "2026-11-10" },
    { partial: true, index: 0, total: 62856, firstDueDate: "2026-12-10" },
  ])(
    "binding KEEP full/partial=$partial copies canonical local index$index for printed2/10",
    async ({ partial, index, total, firstDueDate }) => {
      const a = adapter();
      const f = await fixture({ lineCount: 1, targets: false });
      const schedule: ExpenseScheduleV1 = {
        version: 1,
        occurrences: SCHEDULE.occurrences
          .slice(partial ? 1 : 0)
          .map((item, index) => ({ ...item, index })),
      };
      const source = await locked(f, (tx) =>
        nativeSource(f, tx, "binding-native", schedule),
      );
      expect(source.valorTotal).toBe(total);
      expect(
        parseStoredExpenseSchedule(source.documentedSchedule)?.occurrences.find(
          (item) => item.parcela === "2/10",
        )?.index,
      ).toBe(index);
      await laterInvoice(f);
      f.draft.lines[0].decision = {
        kind: "KEEP_EXISTING",
        expenseId: source.id,
      };
      f.draft.lines[0].targets = [];
      f.draft.lines[0].firstDueDate = firstDueDate;
      await saveDraft(f);
      await noEffects(f, async () => {
        const result = await prepare(a, f);
        ready(result);
        expect(
          result.batch.observations.map(({ id, lineId, canonicalIndex }) => ({
            id,
            lineId,
            canonicalIndex,
          })),
        ).toEqual([
          {
            id: f.draft.lines[0].observationIds[0],
            lineId: "purchase-0",
            canonicalIndex: index,
          },
        ]);
      });
    },
  );

  it("binding KEEP cannot replace canonical NEEDS_INPUT with a whole-purchase null", async () => {
    const a = adapter();
    const f = await fixture({ lineCount: 1, targets: false });
    const source = await locked(f, (tx) =>
      nativeSource(f, tx, "binding-native"),
    );
    f.draft.lines[0].decision = { kind: "KEEP_EXISTING", expenseId: source.id };
    f.draft.lines[0].targets = [];
    await saveDraft(f);
    await noEffects(f, async () => {
      const result = await prepare(a, f);
      expect(result.kind).toBe("NEEDS_INPUT");
      expect(result).not.toHaveProperty("batch");
    });
  });

  async function documentaryCycle(
    f: Fixture,
    month: string,
    reference = "pdf:page:1:line:1",
  ) {
    const artifact = await prisma.importArtifact.findUniqueOrThrow({
      where: { id: f.artifactId },
    });
    if (artifact.extractionJson === null)
      throw new Error("Frozen extraction required");
    const extraction = validateDocumentExtraction(
      JSON.parse(artifact.extractionJson),
    );
    await prisma.importArtifact.update({
      where: { id: artifact.id },
      data: {
        extractionJson: JSON.stringify(
          validateDocumentExtraction({
            ...extraction,
            occurrences: extraction.occurrences.map((occurrence) => ({
              ...occurrence,
              cycle: { invoiceDueMonth: month, reference },
            })),
          }),
        ),
      },
    });
  }

  it("X3 B2 validates and indexes each selected extraction once per preparation", async () => {
    const f = await fixture({ lineCount: 2, targets: false });
    const readStored = extractionHelpers.readStoredImportExtraction;
    const referenceVisits: string[] = [];
    const read = jest
      .spyOn(extractionHelpers, "readStoredImportExtraction")
      .mockImplementation((artifact) => {
        const extraction = readStored(artifact);
        return Object.freeze({
          ...extraction,
          occurrences: Object.freeze(
            extraction.occurrences.map(
              (occurrence) =>
                new Proxy(occurrence, {
                  get(target, property, receiver) {
                    if (property === "reference")
                      referenceVisits.push(target.reference);
                    return Reflect.get(target, property, receiver);
                  },
                }),
            ),
          ),
        });
      });
    const a = adapter();
    await noEffects(f, async () => {
      ready(await prepare(a, f));
      expect(read).toHaveBeenCalledTimes(1);
      expect(referenceVisits).toEqual([
        "pdf:page:1:line:1",
        "pdf:page:1:line:21",
      ]);
      ready(await prepare(a, f));
      expect(read).toHaveBeenCalledTimes(2);
      expect(referenceVisits).toEqual([
        "pdf:page:1:line:1",
        "pdf:page:1:line:21",
        "pdf:page:1:line:1",
        "pdf:page:1:line:21",
      ]);
    });
  });

  it.each(["2026-12", "2026-11"])(
    "X3 B2 CREATE compares documentary %s only with the bound occurrence",
    async (month) => {
      const f = await fixture({ lineCount: 1, targets: false });
      await replaceObservationFacts(f.draft.lines[0].observationIds[0], {
        amountMeaning: "INSTALLMENT_CHARGE",
        amountCents: 6984,
        installmentIndex: 2,
      });
      await freezeExtraction(prisma, f.artifactId);
      await documentaryCycle(f, month);
      await noEffects(f, async () => {
        const result = await prepare(adapter(), f);
        if (month === "2026-12") {
          ready(result);
          expect(result.batch.observations[0].canonicalIndex).toBe(1);
        } else {
          expect(result.kind).toBe("NEEDS_INPUT");
          expect(result).not.toHaveProperty("batch");
        }
      });
    },
  );

  it("X3 B2 whole CREATE with multiple occurrences never chooses the first cycle", async () => {
    const f = await fixture({ lineCount: 1, targets: false });
    await documentaryCycle(f, "2026-11");
    await noEffects(f, async () => {
      const result = await prepare(adapter(), f);
      expect(result.kind).toBe("NEEDS_INPUT");
      expect(result).not.toHaveProperty("batch");
    });
  });

  it.each(["2026-12", "2026-11"])(
    "X3 B2 KEEP partial index zero checks %s after native binding",
    async (month) => {
      const f = await fixture({ lineCount: 1, targets: false });
      const schedule: ExpenseScheduleV1 = {
        version: 1,
        occurrences: SCHEDULE.occurrences
          .slice(1)
          .map((item, index) => ({ ...item, index })),
      };
      const source = await locked(f, (tx) =>
        nativeSource(f, tx, "cycle-native", schedule),
      );
      await laterInvoice(f);
      f.draft.lines[0].decision = {
        kind: "KEEP_EXISTING",
        expenseId: source.id,
      };
      f.draft.lines[0].targets = [];
      f.draft.lines[0].firstDueDate = "2026-12-10";
      await saveDraft(f);
      await documentaryCycle(f, month);
      await noEffects(f, async () => {
        const result = await prepare(adapter(), f);
        if (month === "2026-12") {
          ready(result);
          expect(result.batch.observations[0].canonicalIndex).toBe(0);
        } else {
          expect(result.kind).toBe("NEEDS_INPUT");
          expect(result).not.toHaveProperty("batch");
        }
      });
    },
  );

  it("X3 B2 cycle evidence drift changes coverage and preflight even when the month still matches", async () => {
    const f = await fixture({ lineCount: 1, targets: false });
    await replaceObservationFacts(f.draft.lines[0].observationIds[0], {
      amountMeaning: "INSTALLMENT_CHARGE",
      amountCents: 6984,
      installmentIndex: 2,
    });
    await freezeExtraction(prisma, f.artifactId);
    await documentaryCycle(f, "2026-12");
    const first = await noEffects(f, () => prepare(adapter(), f));
    ready(first);
    await documentaryCycle(f, "2026-12", "pdf:page:1:line:2");
    const second = await noEffects(f, () => prepare(adapter(), f));
    ready(second);
    expect(second.search.coverage.inputHash).not.toBe(
      first.search.coverage.inputHash,
    );
    expect(second.batch.preflightHash).not.toBe(first.batch.preflightHash);
  });

  it("binding drift changes private preflight but never H8 or public proposal", async () => {
    const a = adapter();
    const f = await fixture({ lineCount: 1, targets: false });
    const id = f.draft.lines[0].observationIds[0];
    await replaceObservationFacts(id, {
      amountMeaning: "INSTALLMENT_CHARGE",
      amountCents: 6984,
      installmentIndex: 1,
    });
    const before = await prepare(a, f);
    ready(before);
    await replaceObservationFacts(id, { installmentIndex: 2 });
    await noEffects(f, async () => {
      const after = await prepare(a, f);
      ready(after);
      expect(before.batch.observations[0].canonicalIndex).toBe(0);
      expect(after.batch.observations[0].canonicalIndex).toBe(1);
      expect(after.batch.preflightHash).not.toBe(before.batch.preflightHash);
      expect(after.batch.proposal).toEqual(before.batch.proposal);
    });
  });

  it.each(["wrong-line", "missing-observation"] as const)(
    "the real factory's %s rejection propagates instead of producing a fallback preparation",
    async (corruption) => {
      const a = adapter();
      const f = await fixture({ lineCount: 1, targets: false });
      const mint = executionContract.mintPreparedCardBatch;
      const spy = jest
        .spyOn(executionContract, "mintPreparedCardBatch")
        .mockImplementation((tx, auth, session, data) =>
          mint(tx, auth, session, {
            ...data,
            observations:
              corruption === "wrong-line"
                ? data.observations.map((observation) => ({
                    ...observation,
                    lineId: "not-selected",
                  }))
                : data.observations.slice(1),
          }),
        );
      await noEffects(f, () =>
        expect(prepare(a, f)).rejects.toThrow(
          "Invalid import execution handle",
        ),
      );
      expect(spy).toHaveBeenCalledTimes(1);
    },
  );

  it("apply creates separate native V2 twins/targets once, but no claims/audit/receipt/session writes", async () => {
    const a = adapter();
    const f = await fixture();
    const result = await prepare(a, f);
    await seedConfirmation(f, result);
    const before = await coordination(f);
    const items = await locked(f, async (tx, session) => {
      const current = await a.prepareInTx(tx, f.auth, session);
      ready(current);
      writes.length = 0;
      return a.applyInTx(tx, f.auth, current.batch);
    });
    expect(await coordination(f)).toEqual(before);
    expect(items.map((item) => item.lineId)).toEqual([
      "purchase-0",
      "purchase-1",
    ]);
    expect(new Set(items.map((item) => item.sourceExpenseId)).size).toBe(2);
    const rows = await financial(f);
    expect(rows.expenses).toHaveLength(4);
    expect(rows.allocations).toHaveLength(2);
    expect(rows.cfes).toHaveLength(40);
    expect(writes.every((event) => event.inTransaction)).toBe(true);
    expect(
      writes.every((event) =>
        ["Expense", "CashFlowEntry", "RateioAllocation"].includes(event.model),
      ),
    ).toBe(true);
    expect(rows.side).toEqual(
      Object.fromEntries(SIDE_TABLES.map((table) => [table, []])),
    );
    for (const item of items) {
      expect(item.outcome).toBe("CREATED");
      expect(item.targetExpenseIds).toHaveLength(1);
      expect(item.allocationIds).toHaveLength(1);
      expect(item.cashFlowEntryIds).toHaveLength(20);
      const expenseIds = [item.sourceExpenseId, ...item.targetExpenseIds];
      expect(item.cashFlowEntryIds.slice().sort()).toEqual(
        rows.cfes
          .filter(
            (row) =>
              row.expenseId !== null && expenseIds.includes(row.expenseId),
          )
          .map((row) => row.id)
          .sort(),
      );
      const source = rows.expenses.find(
        (row) => row.id === item.sourceExpenseId,
      )!;
      expect(
        parseStoredExpenseSchedule(source.documentedSchedule),
      ).toMatchObject({
        version: 2,
        kind: "source",
        cardId: f.world.cards.pessoal,
        provenance: {
          kind: "assisted-card",
          basis: "no-import-reference",
          originalImportId: null,
        },
      });
    }
    for (const row of rows.expenses) {
      expect(row).toMatchObject({
        status: "PLANEJADO",
        valorTotal: 69840,
        bankLast4: null,
        accountId: null,
      });
      expect(
        toPublicExpenseSchedule(
          parseStoredExpenseSchedule(row.documentedSchedule),
        ),
      ).toEqual(SCHEDULE);
    }
    expect(
      rows.cfes.every(
        (row) => row.deletedAt === null && row.status === "PLANEJADO",
      ),
    ).toBe(true);
  });

  it("zero targets creates only sources and never invokes ratearSource([])", async () => {
    const a = adapter();
    const f = await fixture({ targets: false });
    const spy = jest.spyOn(conciliacao, "ratearSource");
    const result = await apply(a, f);
    expect(spy).not.toHaveBeenCalled();
    expect(
      result.items.every(
        (item) =>
          item.targetExpenseIds.length === 0 && item.allocationIds.length === 0,
      ),
    ).toBe(true);
    const rows = await financial(f);
    expect(rows.expenses).toHaveLength(2);
    expect(rows.cfes).toHaveLength(20);
    expect(rows.allocations).toEqual([]);
    expect(result.proposal.invoiceDeltas).toEqual(INVOICE_DELTAS);
  });

  it("prepares one server-ready line while preserving two pending lines for continuation", async () => {
    const a = adapter();
    const f = await fixture({ lineCount: 3, targets: false });
    f.draft.lines[1].tipoDespesa = null;
    f.draft.lines[2].targets = null;
    await saveDraft(f);

    await noEffects(f, async () => {
      const result = await prepare(a, f);
      ready(result);
      expect(result.batch.proposal.lines.map((line) => line.lineId)).toEqual([
        "purchase-0",
      ]);
      expect(result.draft.selectedLineIds).toEqual(["purchase-0"]);
      expect(result.draft.questions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            lineIds: ["purchase-1"],
            field: "tipoDespesa",
          }),
          expect.objectContaining({
            lineIds: ["purchase-2"],
            field: "targets",
          }),
        ]),
      );
      expect(result.batch.proposal.deferredObservationIds).toHaveLength(2);
      expect(
        validateStoredDraft(JSON.parse(JSON.stringify(result.draft)) as unknown)
          .fieldProvenance,
      ).toEqual(result.draft.fieldProvenance);
    });
  });

  it.each([
    ["legacy provenance", false],
    ["explicit provenance", true],
  ] as const)(
    "source-only MATERIAL_CONSTRUCAO with %s asks for a canonical PESSOAL type",
    async (_, withProvenance) => {
      const a = adapter();
      const f = await fixture({ lineCount: 1, targets: false });
      f.draft.lines[0].tipoDespesa = ExpenseType.MATERIAL_CONSTRUCAO;
      if (withProvenance) f.draft.fieldProvenance = [];
      else delete f.draft.fieldProvenance;
      await saveDraft(f);

      await noEffects(f, async () => {
        const result = await prepare(a, f);
        expect(result.kind).toBe("NEEDS_INPUT");
        expect(result).not.toHaveProperty("batch");
        expect(result.draft.questions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              lineIds: ["purchase-0"],
              field: "tipoDespesa",
            }),
          ]),
        );
      });
    },
  );

  it("missing provenance asks for every approval-owned field even when values are canonical", async () => {
    const a = adapter();
    const f = await fixture({ lineCount: 1, targets: false });
    delete f.draft.fieldProvenance;
    await saveDraft(f);

    await noEffects(f, async () => {
      const result = await prepare(a, f);
      expect(result.kind).toBe("NEEDS_INPUT");
      expect(result).not.toHaveProperty("batch");
      expect(result.draft.questions.map((question) => question.field)).toEqual(
        expect.arrayContaining(["decision", "targets", "tipoDespesa"]),
      );
    });
  });

  it("keeps an explicit unresolved amount question as a canonical blocker", async () => {
    const a = adapter();
    const f = await fixture({ lineCount: 1, targets: false });
    f.draft.questions = [
      {
        id: "legacy-amount-question",
        lineIds: ["purchase-0"],
        field: "amountCents",
        text: "Legacy untrusted prompt",
      },
    ];
    await saveDraft(f);

    await noEffects(f, async () => {
      const result = await prepare(a, f);
      expect(result.kind).toBe("NEEDS_INPUT");
      expect(result).not.toHaveProperty("batch");
      expect(result.draft.questions).toEqual([
        expect.objectContaining({
          lineIds: ["purchase-0"],
          field: "amountCents",
          text: "Confirme o campo amountCents desta compra antes de continuar.",
        }),
      ]);
      expect(result.draft.questions[0]?.id).not.toBe("legacy-amount-question");
    });
  });

  it("preserves documentary identity while recalculating only selected guided questions", async () => {
    const a = adapter();
    const f = await fixture({ lineCount: 2 });
    await unresolvedDocumentaryQuestions(f, "purchase-0");
    const allDocumentary = await unresolvedDocumentaryQuestions(
      f,
      "purchase-1",
    );
    const documentary = allDocumentary.filter(
      (question) => question.lineIds[0] === "purchase-0",
    );
    const unselectedDocumentary = allDocumentary.filter(
      (question) => question.lineIds[0] === "purchase-1",
    );
    expect(documentary.length).toBeGreaterThan(0);
    expect(unselectedDocumentary.length).toBeGreaterThan(0);
    const unselectedQuestion = {
      id: "unselected-question",
      lineIds: ["purchase-1"],
      field: "tipoDespesa" as const,
      text: "Keep this unselected question exactly.",
    };
    const sharedQuestion = {
      id: sha(canonical({ lineId: "purchase-0", field: "targets" })),
      lineIds: ["purchase-0", "purchase-1"],
      field: "targets" as const,
      text: "Keep the unselected membership.",
    };
    f.draft.selectedLineIds = ["purchase-0"];
    f.draft.lines[0].decision = { kind: "UNRESOLVED" };
    f.draft.lines[0].targets = null;
    f.draft.fieldProvenance = (f.draft.fieldProvenance ?? []).filter(
      (entry) =>
        entry.lineId !== "purchase-0" ||
        !["decision", "targets"].includes(entry.field),
    );
    f.draft.questions = [
      ...(allDocumentary as unknown as typeof f.draft.questions),
      unselectedQuestion,
      sharedQuestion,
    ];
    await saveDraft(f);

    await noEffects(f, async () => {
      const result = await prepare(a, f);
      expect(result.kind).toBe("NEEDS_INPUT");
      expect(validateStoredDraft(result.draft)).toEqual(result.draft);
      for (const question of allDocumentary) {
        const preserved = result.draft.questions.find(
          (candidate) => candidate.id === question.id,
        );
        expect(preserved).toEqual(question);
        expect(JSON.stringify(preserved)).toBe(JSON.stringify(question));
      }
      expect(
        result.draft.questions.find(
          (question) => question.id === unselectedQuestion.id,
        ),
      ).toEqual(unselectedQuestion);
      expect(
        result.draft.questions.find(
          (question) => question.id === sharedQuestion.id,
        ),
      ).toEqual({ ...sharedQuestion, lineIds: ["purchase-1"] });
      const guided = result.draft.questions.find(
        (question) =>
          question.lineIds.length === 1 &&
          question.lineIds[0] === "purchase-0" &&
          question.field === "targets",
      );
      expect(guided).toBeDefined();
      expect(Object.keys(guided ?? {}).sort()).toEqual(
        ["field", "id", "lineIds", "text"].sort(),
      );
      const ids = result.draft.questions.map((question) => question.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  it.each([
    {
      name: "PESSOAL source only",
      targets: false,
      type: ExpenseType.ELETRODOMESTICO,
      expectedTargets: 0,
    },
    {
      name: "PESSOAL source plus one REFORMA mirror",
      targets: true,
      type: ExpenseType.MATERIAL_CONSTRUCAO,
      expectedTargets: 1,
    },
  ] as const)(
    "keeps $name canonically ready",
    async ({ targets, type, expectedTargets }) => {
      const a = adapter();
      const f = await fixture({ lineCount: 1, targets });
      f.draft.lines[0].tipoDespesa = type;
      await saveDraft(f);

      await noEffects(f, async () => {
        const result = await prepare(a, f);
        ready(result);
        expect(result.batch.proposal.lines).toEqual([
          expect.objectContaining({
            kind: "CREATE",
            lineId: "purchase-0",
            tipoDespesa: type,
            targets: expect.arrayContaining(
              expectedTargets === 0 ? [] : [expect.any(Object)],
            ),
          }),
        ]);
        const line = result.batch.proposal.lines[0];
        expect(line.kind).toBe("CREATE");
        if (line.kind !== "CREATE") throw new Error("Expected CREATE");
        expect(line.targets).toHaveLength(expectedTargets);
      });
    },
  );

  it.each([
    ["amountCents", { amountCents: null }],
    ["amountMeaning", { amountMeaning: "UNKNOWN" }],
    ["installmentCount", { installmentCount: null }],
    ["dataCompra", { dataCompra: null }],
    ["firstDueDate", { firstDueDate: null }],
    ["targets", { targets: null }],
    ["tipoDespesa", { tipoDespesa: null }],
  ] satisfies Array<[string, Partial<ImportSessionDraftLineV1>]>)(
    "unknown %s produces a scoped question, full search shape and no batch/effects",
    async (field, change) => {
      const a = adapter();
      const f = await fixture({ lineCount: 1 });
      Object.assign(f.draft.lines[0], change);
      await saveDraft(f);
      await noEffects(f, async () => {
        const result = await prepare(a, f);
        expect(result.kind).toBe("NEEDS_INPUT");
        expect(result).not.toHaveProperty("batch");
        expect(result.draft.questions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ field, lineIds: ["purchase-0"] }),
          ]),
        );
        searchShape(result.search, f);
      });
    },
  );

  it("an installment charge cannot authorize multiplying an unknown total", async () => {
    const a = adapter();
    const f = await fixture({ lineCount: 1 });
    Object.assign(f.draft.lines[0], {
      amountMeaning: "INSTALLMENT_CHARGE",
      amountCents: 6984,
    });
    await saveDraft(f);
    await noEffects(f, async () => {
      const result = await prepare(a, f);
      expect(result.kind).toBe("NEEDS_INPUT");
      expect(result).not.toHaveProperty("batch");
      expect(
        result.draft.questions.some((q) =>
          ["amountMeaning", "amountCents"].includes(q.field),
        ),
      ).toBe(true);
    });
  });

  it.each(["missing-card-cycle", "incompatible-first-due"] as const)(
    "%s asks instead of guessing or shifting the first invoice twice",
    async (scenario) => {
      const a = adapter();
      const f = await fixture({ lineCount: 1 });
      if (scenario === "missing-card-cycle") {
        await prisma.creditCard.update({
          where: { id: f.world.cards.pessoal },
          data: { closingDay: null, dueDay: null },
        });
      } else {
        f.draft.lines[0].firstDueDate = "2026-10-11";
        await saveDraft(f);
      }
      await noEffects(f, async () => {
        const result = await prepare(a, f);
        expect(result.kind).toBe("NEEDS_INPUT");
        expect(result).not.toHaveProperty("batch");
        expect(result.draft.questions.length).toBeGreaterThan(0);
      });
    },
  );

  it.each([
    {
      scenario: "documentary November after a September purchase",
      dataCompra: "2026-09-25",
      closingDay: 27,
      dueDay: 5,
      firstDueDate: "2026-11-05",
      cycles: [
        { data: "2026-11-05", invoiceDueMonth: "2026-11" },
        { data: "2026-12-05", invoiceDueMonth: "2026-12" },
        { data: "2027-01-05", invoiceDueMonth: "2027-01" },
      ],
    },
    {
      scenario: "documentary October before the inferred November",
      dataCompra: "2026-10-05",
      closingDay: 4,
      dueDay: 10,
      firstDueDate: "2026-10-10",
      cycles: [
        { data: "2026-10-10", invoiceDueMonth: "2026-10" },
        { data: "2026-11-10", invoiceDueMonth: "2026-11" },
        { data: "2026-12-10", invoiceDueMonth: "2026-12" },
      ],
    },
    {
      scenario: "the normal inference-compatible November",
      dataCompra: "2026-10-05",
      closingDay: 4,
      dueDay: 10,
      firstDueDate: "2026-11-10",
      cycles: [
        { data: "2026-11-10", invoiceDueMonth: "2026-11" },
        { data: "2026-12-10", invoiceDueMonth: "2026-12" },
        { data: "2027-01-10", invoiceDueMonth: "2027-01" },
      ],
    },
    {
      scenario: "a documentary short month after the inferred January",
      dataCompra: "2027-01-25",
      closingDay: 26,
      dueDay: 31,
      firstDueDate: "2027-02-28",
      cycles: [
        { data: "2027-02-28", invoiceDueMonth: "2027-02" },
        { data: "2027-03-31", invoiceDueMonth: "2027-03" },
        { data: "2027-04-30", invoiceDueMonth: "2027-04" },
      ],
    },
  ])(
    "explicit first due preserves $scenario, purchase date and every native cycle",
    async ({ dataCompra, closingDay, dueDay, firstDueDate, cycles }) => {
      const a = adapter();
      const f = await fixture({
        lineCount: 1,
        targets: false,
        installmentCount: 3,
      });
      await prisma.creditCard.update({
        where: { id: f.world.cards.pessoal },
        data: { closingDay, dueDay },
      });
      await replaceObservationFacts(f.draft.lines[0].observationIds[0], {
        dataCompra,
      });
      Object.assign(f.draft.lines[0], { dataCompra, firstDueDate });
      await saveDraft(f);
      await noEffects(f, async () => ready(await prepare(a, f)));
      const result = await apply(a, f);
      expect(result.proposal).toMatchObject({
        createdEconomicTotalCents: 69840,
        bankCashDeltaCents: 0,
        invoiceDeltas: cycles.map(({ invoiceDueMonth }) => ({
          invoiceDueMonth,
          amountCents: 23280,
        })),
      });
      const rows = await financial(f);
      expect(rows.expenses).toHaveLength(1);
      expect(rows.expenses[0]).toMatchObject({
        id: result.items[0].sourceExpenseId,
        dataCompra: new Date(`${dataCompra}T00:00:00.000Z`),
        dataInicioParcela: new Date(`${firstDueDate}T00:00:00.000Z`),
        valorTotal: 69840,
        status: "PLANEJADO",
        bankLast4: null,
        accountId: null,
      });
      expect(
        toPublicExpenseSchedule(
          parseStoredExpenseSchedule(rows.expenses[0].documentedSchedule),
        ),
      ).toEqual({
        version: 1,
        occurrences: cycles.map((cycle, index) => ({
          ...cycle,
          index,
          parcela: `${index + 1}/3`,
          valor: 23280,
        })),
      });
      expect(
        rows.cfes
          .sort((left, right) => left.data.getTime() - right.data.getTime())
          .map(({ data, invoiceDueMonth, valor, status }) => ({
            data: data.toISOString().slice(0, 10),
            invoiceDueMonth,
            valor,
            status,
          })),
      ).toEqual(
        cycles.map((cycle) => ({
          ...cycle,
          valor: 23280,
          status: "PLANEJADO",
        })),
      );
      expect(rows.allocations).toEqual([]);
      expect(rows.side).toEqual(
        Object.fromEntries(SIDE_TABLES.map((table) => [table, []])),
      );
    },
  );

  it("explicit first due before the purchase remains a question with no effects", async () => {
    const a = adapter();
    const f = await fixture({ lineCount: 1 });
    await replaceObservationFacts(f.draft.lines[0].observationIds[0], {
      dataCompra: "2026-10-15",
    });
    Object.assign(f.draft.lines[0], {
      dataCompra: "2026-10-15",
      firstDueDate: "2026-10-10",
    });
    await saveDraft(f);
    await noEffects(f, async () => {
      const result = await prepare(a, f);
      expect(result.kind).toBe("NEEDS_INPUT");
      expect(result).not.toHaveProperty("batch");
      expect(result.draft.questions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: "firstDueDate",
            lineIds: ["purchase-0"],
          }),
        ]),
      );
    });
  });

  it.each([
    { closingDay: null, dueDay: 10 },
    { closingDay: 4, dueDay: null },
  ])(
    "explicit first due does not bypass a missing card cycle %j",
    async (cycle) => {
      const a = adapter();
      const f = await fixture({ lineCount: 1 });
      await prisma.creditCard.update({
        where: { id: f.world.cards.pessoal },
        data: cycle,
      });
      await noEffects(f, async () => {
        const result = await prepare(a, f);
        expect(result.kind).toBe("NEEDS_INPUT");
        expect(result).not.toHaveProperty("batch");
        expect(result.draft.questions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              field: "firstDueDate",
              lineIds: ["purchase-0"],
            }),
          ]),
        );
      });
    },
  );

  it("multiple integral-target selections never silently apply only the first target", async () => {
    const a = adapter();
    const f = await fixture({ lineCount: 1 });
    const second = await prisma.project.create({
      data: {
        tenantId: f.world.tenantId,
        type: "REFORMA",
        name: "Second synthetic Reforma",
      },
    });

    f.draft.lines[0].targets = [
      { projectId: f.world.projects.casa, roomId: null, amountCents: 34920 },
      { projectId: second.id, roomId: null, amountCents: 34920 },
    ];
    await saveDraft(f);
    await noEffects(f, async () => {
      await expect(prepare(a, f)).rejects.toBeInstanceOf(Error);
    });
  });

  it("a short first month clamps that occurrence without moving the following card due days", async () => {
    const a = adapter();
    const f = await fixture({ lineCount: 1, targets: false });
    await prisma.creditCard.update({
      where: { id: f.world.cards.pessoal },
      data: { closingDay: 26, dueDay: 31 },
    });
    Object.assign(f.draft.lines[0], {
      dataCompra: "2027-01-26",
      firstDueDate: "2027-02-28",
    });
    await saveDraft(f);
    await noEffects(f, async () => {
      const result = await prepare(a, f);
      ready(result);
      expect(
        result.batch.proposal.lines[0].schedule.occurrences
          .slice(0, 4)
          .map(({ data, invoiceDueMonth }) => ({ data, invoiceDueMonth })),
      ).toEqual([
        { data: "2027-02-28", invoiceDueMonth: "2027-02" },
        { data: "2027-03-31", invoiceDueMonth: "2027-03" },
        { data: "2027-04-30", invoiceDueMonth: "2027-04" },
        { data: "2027-05-31", invoiceDueMonth: "2027-05" },
      ]);
    });
  });

  it("later invoice 2/10 offers both native V2 twins; explicit KEEP preserves every financial row", async () => {
    const a = adapter();
    const f = await fixture();
    const ids = await nativeTwins(f);
    await laterInvoice(f);
    const before = await financial(f);
    const ambiguous = await prepare(a, f);
    expect(ambiguous.kind).toBe("NEEDS_INPUT");
    expect(ambiguous).not.toHaveProperty("batch");
    expect(
      ambiguous.search.candidates
        .filter((candidate) => candidate.kind === "EXPENSE")
        .map((candidate) => candidate.id)
        .sort(),
    ).toEqual(ids.slice().sort());
    expect(ambiguous.draft.questions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "decision", lineIds: ["purchase-0"] }),
      ]),
    );
    f.draft.lines[0].decision = { kind: "KEEP_EXISTING", expenseId: ids[1] };
    f.draft.lines[0].targets = [];
    await saveDraft(f);
    const result = await apply(a, f);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      sourceExpenseId: ids[1],
      outcome: "KEPT_EXISTING",
    });
    expect(result.proposal.createdEconomicTotalCents).toBe(0);
    expect(result.proposal.invoiceDeltas).toEqual([]);
    expect(await financial(f)).toEqual(before);
    expect(
      (await coordination(f)).observations.every(
        (row) => row.canonicalIndex === null && row.claimVersion === 0,
      ),
    ).toBe(true);
  });

  it.each(["unchanged", "valor", "status", "data", "invoiceDueMonth"] as const)(
    "KEEP target CFE %s is a coherent private-preflight/receipt snapshot without financial writes",
    async (field) => {
      const a = adapter();
      const f = await fixture({ lineCount: 1 });
      const [sourceId] = await nativeTwins(f, 1);
      const allocation = await prisma.rateioAllocation.findFirstOrThrow({
        where: { tenantId: f.world.tenantId, sourceExpenseId: sourceId },
      });
      const targetCfe = await prisma.cashFlowEntry.findFirstOrThrow({
        where: {
          tenantId: f.world.tenantId,
          expenseId: allocation.targetExpenseId,
          parcela: "2/10",
        },
      });
      await laterInvoice(f);
      f.draft.lines[0].decision = {
        kind: "KEEP_EXISTING",
        expenseId: sourceId,
      };
      f.draft.lines[0].targets = [];
      await saveDraft(f);
      const initial = await noEffects(f, () => prepare(a, f));
      ready(initial);
      await seedConfirmation(f, initial);
      if (field !== "unchanged") {
        const changes: Record<
          Exclude<typeof field, "unchanged">,
          Prisma.CashFlowEntryUpdateInput
        > = {
          valor: { valor: targetCfe.valor + 1 },
          status: { status: "PAGO" },
          data: { data: new Date("2026-12-11T00:00:00.000Z") },
          invoiceDueMonth: { invoiceDueMonth: "2027-01" },
        };
        await prisma.cashFlowEntry.update({
          where: { id: targetCfe.id },
          data: changes[field],
        });
      }
      const currentCfe = await prisma.cashFlowEntry.findUniqueOrThrow({
        where: { id: targetCfe.id },
      });
      expect(currentCfe.id).toBe(targetCfe.id);
      expect(currentCfe.deletedAt).toBeNull();
      if (field === "unchanged") expect(currentCfe).toEqual(targetCfe);
      else expect(currentCfe[field]).not.toEqual(targetCfe[field]);
      const snapshot = await financial(f);
      expect(snapshot.cfes).toHaveLength(20);
      await noEffects(f, () =>
        locked(f, async (tx, session) => {
          const current = await a.prepareInTx(tx, f.auth, session);
          ready(current);
          expect(current.batch.proposal).toEqual(initial.batch.proposal);
          if (field === "unchanged")
            expect(current.batch.preflightHash).toBe(
              initial.batch.preflightHash,
            );
          else
            expect(current.batch.preflightHash).not.toBe(
              initial.batch.preflightHash,
            );
          const items = await a.applyInTx(tx, f.auth, current.batch);
          expect(items).toHaveLength(1);
          expect(items[0].cashFlowEntryIds.slice().sort()).toEqual(
            snapshot.cfes.map((row) => row.id).sort(),
          );
          expect(items[0].cashFlowEntryIds).toContain(targetCfe.id);
          expect(items[0].sourceExpenseId).toBe(sourceId);
          expect(items[0].targetExpenseIds).toEqual([
            allocation.targetExpenseId,
          ]);
        }),
      );
    },
  );

  it("KEEP may preserve a compatible paid occurrence without funding/status/ID changes", async () => {
    const a = adapter();
    const f = await fixture();
    const ids = await nativeTwins(f);
    await locked(f, (tx) =>
      expenses.markPaidInPlace(
        f.world.tenantId,
        ids[1],
        new Date("2026-12-10"),
        tx,
      ),
    );
    await laterInvoice(f);
    f.draft.lines[0].decision = { kind: "KEEP_EXISTING", expenseId: ids[1] };
    f.draft.lines[0].targets = [];
    await saveDraft(f);
    const before = await financial(f);
    const result = await apply(a, f);
    expect(result.items[0]).toMatchObject({
      outcome: "KEPT_EXISTING",
      sourceExpenseId: ids[1],
    });
    expect(await financial(f)).toEqual(before);
  });

  it.each([
    "wrong-amount",
    "wrong-printed-index",
    "deleted-root",
    "unrelated-choice",
  ] as const)(
    "KEEP rejects %s and never creates a substitute",
    async (scenario) => {
      const a = adapter();
      const f = await fixture();
      const ids = await nativeTwins(f);
      await laterInvoice(f);
      f.draft.lines[0].decision = {
        kind: "KEEP_EXISTING",
        expenseId: scenario === "unrelated-choice" ? randomUUID() : ids[0],
      };
      f.draft.lines[0].targets = [];
      if (scenario === "wrong-amount") f.draft.lines[0].amountCents = 6983;
      if (scenario === "wrong-printed-index") {
        const row = await prisma.importObservation.findUniqueOrThrow({
          where: { id: f.draft.lines[0].observationIds[0] },
        });
        const evidence: unknown = JSON.parse(row.evidenceJson);
        expect(object(evidence)).toBe(true);
        if (!object(evidence)) throw new Error("Invalid test observation");
        await prisma.importObservation.update({
          where: { id: row.id },
          data: {
            evidenceJson: JSON.stringify({ ...evidence, installmentIndex: 11 }),
          },
        });
      }
      if (scenario === "deleted-root") {
        await prisma.expense.delete({ where: { id: ids[0] } });
      }
      await saveDraft(f);
      await noEffects(f, async () => {
        const result = await prepare(a, f);
        expect(["NEEDS_INPUT", "REVIEW_REQUIRED"]).toContain(result.kind);
        expect(result).not.toHaveProperty("batch");
        expect(
          result.search.candidates.some(
            (candidate) =>
              candidate.id === ids[0] && scenario === "deleted-root",
          ),
        ).toBe(false);
      });
    },
  );

  it("a rateio participant cannot use KEEP to add a new destination", async () => {
    const a = adapter();
    const f = await fixture();
    const ids = await nativeTwins(f);
    await laterInvoice(f);
    const allocation = await prisma.rateioAllocation.findFirstOrThrow({
      where: { tenantId: f.world.tenantId, sourceExpenseId: ids[0] },
    });
    f.draft.lines[0].decision = {
      kind: "KEEP_EXISTING",
      expenseId: allocation.targetExpenseId,
    };
    const newProject = await prisma.project.create({
      data: {
        tenantId: f.world.tenantId,
        type: "REFORMA",
        name: "New synthetic destination",
      },
    });
    f.draft.lines[0].targets = [
      { projectId: newProject.id, roomId: null, amountCents: 69840 },
    ];
    await saveDraft(f);
    await noEffects(f, async () => {
      await expect(prepare(a, f)).rejects.toBeInstanceOf(Error);
    });
  });

  it("hidden allocation participant denies KEEP without serializing its id or financial facts", async () => {
    const a = adapter();
    const f = await fixture();
    const ids = await nativeTwins(f);
    await laterInvoice(f);
    f.draft.lines[0].decision = { kind: "KEEP_EXISTING", expenseId: ids[0] };
    f.draft.lines[0].targets = [];
    await saveDraft(f);
    await prisma.user.update({
      where: { id: f.auth.userId },
      data: {
        role: "USER",
        allowedProjects: JSON.stringify([f.world.projects.pessoal]),
        allowedModules: '["creditCards","expenses"]',
        allowedProjectTypes: "[]",
      },
    });
    const before = await financial(f);
    await expect(prepare(a, f)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await financial(f)).toEqual(before);
  });

  it.each([
    "target-acl",
    "target-deleted",
    "wrong-room",
    "card-anchor",
  ] as const)(
    "current %s is checked before any source or candidate disclosure",
    async (scenario) => {
      const a = adapter();
      const f = await fixture({ lineCount: 1 });
      if (scenario === "target-acl") {
        await prisma.user.update({
          where: { id: f.auth.userId },
          data: {
            role: "USER",
            allowedProjects: JSON.stringify([f.world.projects.pessoal]),
            allowedModules: '["creditCards","expenses"]',
            allowedProjectTypes: "[]",
          },
        });
      } else if (scenario === "target-deleted") {
        await prisma.project.delete({ where: { id: f.world.projects.casa } });
      } else if (scenario === "wrong-room") {
        const room = await prisma.room.create({
          data: { projectId: f.world.projects.pessoal, name: "Wrong room" },
        });
        f.draft.lines[0].targets![0].roomId = room.id;
        await saveDraft(f);
      } else {
        await prisma.creditCard.delete({
          where: { id: f.world.cards.pessoal },
        });
      }
      const before = await financial(f);
      await expect(prepare(a, f)).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await financial(f)).toEqual(before);
    },
  );

  it("candidate 26 and the last native occurrence remain in complete private coverage", async () => {
    const a = adapter();
    const f = await fixture({ lineCount: 1 });
    const ids = await nativeTwins(f, 26);
    await laterInvoice(f);
    const result = await prepare(a, f);
    expect(result.kind).toBe("NEEDS_INPUT");
    expect(result.search.complete).toBe(true);
    searchShape(result.search, f);
    expect(
      result.search.candidates.map((candidate) => candidate.id).sort(),
    ).toEqual(ids.slice().sort());
    f.draft.lines[0].decision = { kind: "KEEP_EXISTING", expenseId: ids[25] };
    f.draft.lines[0].targets = [];
    await saveDraft(f);
    const kept = await apply(a, f);
    expect(kept.items[0].sourceExpenseId).toBe(ids[25]);
  });

  it("Receipt natural matches are enumerated, never mistaken for absence or a KEEP expense", async () => {
    const a = adapter();
    const f = await fixture({ lineCount: 1, targets: false });
    const natural = dedupeKeyNatural({
      tenantId: f.world.tenantId,
      projectId: f.world.projects.pessoal,
      date: new Date("2026-10-05"),
      merchant: "Synthetic supplier",
      amountCents: 69840,
      ordinal: 0,
    });
    const receipt = await prisma.receipt.create({
      data: {
        tenantId: f.world.tenantId,
        projectId: f.world.projects.pessoal,
        descricao: "Synthetic receipt",
        valor: 69840,
        data: new Date("2026-10-05"),
        status: "PREVISTO",
        tipo: "OUTROS",
        dedupeKeyNatural: natural,
        origin: "account",
      },
    });
    await noEffects(f, async () => {
      const result = await prepare(a, f);
      expect(result).not.toHaveProperty("batch");
      expect(result.search.candidates).toContainEqual({
        lineId: "purchase-0",
        kind: "RECEIPT",
        id: receipt.id,
        reason: "NATURAL_MATCH",
      });
      expect(
        result.search.coverage.steps.find(
          (step) => step.stage === "CROSS_ORIGIN",
        ),
      ).toMatchObject({ status: "EXHAUSTED" });
    });
  });

  // Seed cardinality is only a lower bound: all materializations, including rereads, spend the shared budget.
  it.each([
    { receipts: 4992, visited: 5000, ready: true },
    { receipts: 4993, visited: 5001, ready: false },
  ])(
    "real three-stage search measures $visited rows, including metadata/card reread and overflow witness",
    async ({ receipts, visited, ready: executable }) => {
      const a = adapter();
      const f = await fixture({ lineCount: 1, targets: false });
      f.draft.lines[0].decision = {
        kind: "CREATE",
        acceptNaturalDuplicate: true,
      };
      await saveDraft(f);
      const natural = dedupeKeyNatural({
        tenantId: f.world.tenantId,
        projectId: f.world.projects.pessoal,
        date: new Date("2026-10-05"),
        merchant: "Synthetic supplier",
        amountCents: 69840,
        ordinal: 0,
      });
      for (let offset = 0; offset < receipts; offset += 250) {
        await prisma.receipt.createMany({
          data: Array.from(
            { length: Math.min(250, receipts - offset) },
            () => ({
              tenantId: f.world.tenantId,
              projectId: f.world.projects.pessoal,
              descricao: "Synthetic measured natural candidate",
              valor: 69840,
              data: new Date("2026-10-05"),
              status: "PREVISTO",
              tipo: "OUTROS",
              dedupeKeyNatural: natural,
              origin: "account",
            }),
          ),
        });
      }
      await noEffects(f, () =>
        locked(f, async (tx, session) => {
          measuredReads = [];
          try {
            if (executable) {
              const result = await a.prepareInTx(tx, f.auth, session);
              ready(result);
              expect(result.search.candidates).toHaveLength(4992);
              expect(
                result.search.coverage.steps.map(
                  ({ stage, status, visitedRows }) => ({
                    stage,
                    status,
                    visitedRows,
                  }),
                ),
              ).toEqual([
                {
                  stage: "DOCUMENT_IDENTITY",
                  status: "EXHAUSTED",
                  visitedRows: 7,
                },
                {
                  stage: "CROSS_ORIGIN",
                  status: "EXHAUSTED",
                  visitedRows: 4992,
                },
                { stage: "CARD_IDENTITY", status: "EXHAUSTED", visitedRows: 1 },
              ]);
              expect(
                result.search.coverage.steps.reduce(
                  (sum, step) => sum + step.visitedRows,
                  0,
                ),
              ).toBe(5000);
            } else {
              await expect(
                a.prepareInTx(tx, f.auth, session),
              ).rejects.toMatchObject({ code: "SEARCH_TOO_BROAD" });
            }
            expect(measuredReads.reduce((sum, row) => sum + row.rows, 0)).toBe(
              visited,
            );
            expect(
              measuredReads.filter((row) => row.model === "RAW" && row.rows > 0)
                .length,
            ).toBeGreaterThan(16);
            expect(
              measuredReads
                .filter((row) => row.model === "CreditCard")
                .map((row) => row.rows),
            ).toEqual([1, 1]);
            if (!executable)
              expect(measuredReads[measuredReads.length - 1]).toEqual({
                model: "CreditCard",
                rows: 1,
                cap: 1,
              });
          } finally {
            measuredReads = null;
          }
        }),
      );
    },
  );

  it("human merchant/amount edits cannot replace the original document keys used by matching", async () => {
    const a = adapter();
    const f = await fixture({ lineCount: 1, targets: false });
    const receipt = await prisma.receipt.create({
      data: {
        tenantId: f.world.tenantId,
        projectId: f.world.projects.pessoal,
        descricao: "Synthetic original document receipt",
        valor: 69840,
        data: new Date("2026-10-05"),
        status: "PREVISTO",
        tipo: "OUTROS",
        dedupeKeyNatural: dedupeKeyNatural({
          tenantId: f.world.tenantId,
          projectId: f.world.projects.pessoal,
          date: new Date("2026-10-05"),
          merchant: "Synthetic supplier",
          amountCents: 69840,
          ordinal: 0,
        }),
      },
    });
    const original = await prepare(a, f);
    f.draft.lines[0].fornecedor = "Edited supplier";
    f.draft.lines[0].titulo = "Edited supplier";
    f.draft.lines[0].amountCents = 77777;
    await saveDraft(f);
    const changed = await noEffects(f, () => prepare(a, f));
    expect(changed.kind).toBe("NEEDS_INPUT");
    expect(changed.search.candidates).toContainEqual({
      lineId: "purchase-0",
      kind: "RECEIPT",
      id: receipt.id,
      reason: "NATURAL_MATCH",
    });
    expect(changed.search.coverage.inputHash).not.toBe(
      original.search.coverage.inputHash,
    );
    expect(
      changed.search.coverage.steps.find(
        (step) => step.stage === "CROSS_ORIGIN",
      )?.predicateHash,
    ).toBe(
      original.search.coverage.steps.find(
        (step) => step.stage === "CROSS_ORIGIN",
      )?.predicateHash,
    );
  });

  it("a soft-deleted allocation target blocks KEEP without restoring or rewriting its graph", async () => {
    const a = adapter();
    const f = await fixture();
    const ids = await nativeTwins(f);
    const allocation = await prisma.rateioAllocation.findFirstOrThrow({
      where: { tenantId: f.world.tenantId, sourceExpenseId: ids[0] },
    });
    await prisma.expense.delete({ where: { id: allocation.targetExpenseId } });
    await laterInvoice(f);
    f.draft.lines[0].decision = { kind: "KEEP_EXISTING", expenseId: ids[0] };
    f.draft.lines[0].targets = [];
    await saveDraft(f);
    await noEffects(f, async () => {
      const result = await prepare(a, f);
      expect(result.kind).toBe("NEEDS_INPUT");
      expect(result).not.toHaveProperty("batch");
    });
  });

  it.each([5001, 10001])(
    "%i matching history rows cannot certify READY using an internal first page/chunk",
    async (count) => {
      const a = adapter();
      const f = await fixture({ lineCount: 1, targets: false });
      const natural = dedupeKeyNatural({
        tenantId: f.world.tenantId,
        projectId: f.world.projects.pessoal,
        date: new Date("2026-10-05"),
        merchant: "Synthetic supplier",
        amountCents: 69840,
        ordinal: 0,
      });
      for (let offset = 0; offset < count; offset += 250) {
        await prisma.receipt.createMany({
          data: Array.from(
            { length: Math.min(250, count - offset) },
            (_, index) => ({
              tenantId: f.world.tenantId,
              projectId: f.world.projects.pessoal,
              descricao: `Synthetic legacy receipt ${offset + index}`,
              valor: 69840,
              data: new Date("2026-10-05"),
              status: "PREVISTO",
              tipo: "OUTROS",
              dedupeKeyNatural: natural,
              origin: "account",
            }),
          ),
        });
      }
      await noEffects(f, () =>
        expect(prepare(a, f)).rejects.toMatchObject({
          code: "SEARCH_TOO_BROAD",
        }),
      );
    },
  );

  it("the 5000 visit budget is shared across selected lines, not renewed per line", async () => {
    const a = adapter();
    const f = await fixture({
      targets: false,
      merchants: ["Synthetic supplier 0", "Synthetic supplier 1"],
    });
    for (let line = 0; line < 2; line += 1) {
      const natural = dedupeKeyNatural({
        tenantId: f.world.tenantId,
        projectId: f.world.projects.pessoal,
        date: new Date("2026-10-05"),
        merchant: `Synthetic supplier ${line}`,
        amountCents: 69840,
        ordinal: 0,
      });
      for (let chunk = 0; chunk < 11; chunk += 1) {
        await prisma.receipt.createMany({
          data: Array.from({ length: 250 }, () => ({
            tenantId: f.world.tenantId,
            projectId: f.world.projects.pessoal,
            descricao: `Synthetic legacy receipt ${line}`,
            valor: 69840,
            data: new Date("2026-10-05"),
            status: "PREVISTO",
            tipo: "OUTROS",
            dedupeKeyNatural: natural,
            origin: "account",
          })),
        });
      }
    }
    await noEffects(f, () =>
      expect(prepare(a, f)).rejects.toMatchObject({
        code: "SEARCH_TOO_BROAD",
      }),
    );
  });

  it("exactly 240 expanded CFEs is supported without narrowing the ten-line/24-installment contract", async () => {
    const a = adapter();
    const f = await fixture({ lineCount: 5, installmentCount: 24 });
    const result = await prepare(a, f);
    ready(result);
    expect(result.batch.expandedCounts.cashFlowEntries).toBe(240);
    expect(
      result.batch.expandedCounts.financialAndCoordinationWrites,
    ).toBeLessThanOrEqual(512);
    expect(
      result.batch.proposal.lines.every(
        (line) => line.schedule.occurrences.length === 24,
      ),
    ).toBe(true);
  });

  it("accepts the exact aggregate cents ceiling across multiple purchases and month deltas", async () => {
    const a = adapter();
    const f = await fixture({
      lineCount: 2,
      targets: false,
      installmentCount: 1,
    });
    await setPurchaseAmounts(f, [IMPORT_SESSION_PRIMITIVES.maxCents - 1, 1]);

    await noEffects(f, async () => {
      const result = await prepare(a, f);
      ready(result);
      expect(result.batch.proposal.createdEconomicTotalCents).toBe(
        IMPORT_SESSION_PRIMITIVES.maxCents,
      );
      expect(result.batch.proposal.invoiceDeltas).toEqual([
        {
          invoiceDueMonth: "2026-11",
          amountCents: IMPORT_SESSION_PRIMITIVES.maxCents,
        },
      ]);
    });
  });

  it("rejects aggregate max plus one as LIMIT_EXCEEDED with zero writes", async () => {
    const a = adapter();
    const f = await fixture({
      lineCount: 2,
      targets: false,
      installmentCount: 1,
    });
    await setPurchaseAmounts(f, [IMPORT_SESSION_PRIMITIVES.maxCents, 1]);

    await noEffects(f, () =>
      locked(f, async (tx, session) => {
        writes.length = 0;
        await expect(a.prepareInTx(tx, f.auth, session)).rejects.toMatchObject({
          code: "LIMIT_EXCEEDED",
        });
        expect(writes).toEqual([]);
      }),
    );
  });

  it("241 expanded CFEs rejects the whole selection, not only its last source", async () => {
    const a = adapter();
    const f = await fixture({ lineCount: 6 });
    for (const line of f.draft.lines.slice(0, 5)) line.installmentCount = 24;
    f.draft.lines[5].installmentCount = 1;
    f.draft.lines[5].targets = [];
    f.draft.lines[5].tipoDespesa = ExpenseType.ELETRODOMESTICO;
    await saveDraft(f);
    await expect(prepare(a, f)).rejects.toMatchObject({
      code: "LIMIT_EXCEEDED",
    });
    expect((await financial(f)).expenses).toEqual([]);
  });

  // S10/T10/P10/N240/K0/R0/L1: fixed cost 324 plus distinct selected claims.
  it.each(WRITE_BOUNDARIES)(
    "AC18 $claims actual claims has literal cost $cost, with no partial financial/coordination effects",
    async ({ claims, perLine, cost }) => {
      const a = adapter();
      const f = await fixture({
        lineCount: 10,
        observationsPerLine: perLine,
        installmentCount: 12,
      });
      await noEffects(f, async () => {
        if (cost > 512) {
          await expect(prepare(a, f)).rejects.toMatchObject({
            code: "LIMIT_EXCEEDED",
            reason: "WRITE_BUDGET_EXCEEDED",
          });
          return;
        }
        const result = await prepare(a, f);
        ready(result);
        expect(result.batch.observations).toHaveLength(claims);
        expect(
          new Set(result.batch.observations.map((row) => row.id)).size,
        ).toBe(188);
        expect(result.batch.expandedCounts).toEqual({
          cashFlowEntries: 240,
          financialAndCoordinationWrites: 512,
        });
        expect(result.batch.proposal.lines).toHaveLength(10);
        for (const line of result.batch.proposal.lines) {
          expect(line.kind).toBe("CREATE");
          expect(line.schedule.occurrences).toHaveLength(12);
          if (line.kind !== "CREATE")
            throw new Error("Expected CREATE fixture");
          expect(line.targets).toHaveLength(1);
          expect(line.targets[0].schedule.occurrences).toHaveLength(12);
        }
        expect(result.batch.proposal.deferredObservationIds).toEqual([]);
        expect(result.batch.proposal.deferredAttachmentIds).toEqual([]);
      });
    },
  );

  it("AC18 twins/deferred cost65 includes both mother artifacts; H8 includes only the transferred ref", async () => {
    const a = adapter();
    const f = await fixture();
    await pendingAttachments(f, 1);
    const first = await noEffects(f, () => prepare(a, f));
    ready(first);
    expect(first.batch.proposal).toMatchObject({
      deferredAttachmentIds: f.draft.scope.pendingAttachmentIds,
      retainUntil: EXPIRES.toISOString(),
    });
    expect(first.batch.expandedCounts).toEqual({
      cashFlowEntries: 40,
      financialAndCoordinationWrites: 65,
    });
    const mother = await coordination(f);
    expect(mother.refs).toHaveLength(2);
    expect(mother.artifacts).toHaveLength(2);
    expect(mother.artifacts.every((row) => row.leaseSessionId === null)).toBe(
      true,
    );
    const ref = await prisma.importSessionArtifact.findUniqueOrThrow({
      where: { id: f.draft.scope.pendingAttachmentIds[0] },
    });
    expect(ref.artifactId).not.toBeNull();
    const artifact = await prisma.importArtifact.findUniqueOrThrow({
      where: { id: ref.artifactId! },
    });
    const { proposalHash, ...proposal } = first.batch.proposal;
    expect(proposalHash).toBe(
      sha(
        canonical({
          proposal,
          continuation: {
            deferredObservations: [],
            refs: [
              {
                refId: ref.id,
                refState: "ATTACHED",
                uploadGeneration: 0,
                artifactId: artifact.id,
                artifactSha256: artifact.documentSha256,
                phase: "NOT_EXTRACTED",
              },
            ],
            writeCostUpperBound: 65,
          },
        }),
      ),
    );
    await prisma.importArtifact.update({
      where: { id: ref.artifactId! },
      data: { state: "ANALYZING", parseGeneration: { increment: 1 } },
    });
    const equivalent = await noEffects(f, () => prepare(a, f));
    ready(equivalent);
    expect(equivalent.batch.proposal.proposalHash).toBe(
      first.batch.proposal.proposalHash,
    );
    await prisma.importSessionArtifact.update({
      where: { id: f.attachmentId },
      data: { uploadGeneration: { increment: 1 } },
    });
    const consumedRefChange = await noEffects(f, () => prepare(a, f));
    ready(consumedRefChange);
    expect(consumedRefChange.batch.proposal.proposalHash).toBe(proposalHash);
    await prisma.importSessionArtifact.update({
      where: { id: ref.id },
      data: { uploadGeneration: { increment: 1 } },
    });
    const changed = await noEffects(f, () => prepare(a, f));
    ready(changed);
    expect(changed.batch.proposal.proposalHash).not.toBe(
      first.batch.proposal.proposalHash,
    );
    expect((await coordination(f)).sessions).toHaveLength(1);
  });

  it.each([
    "eleventh-line",
    "twenty-fifth-installment",
    "zero",
    "negative",
    "overflow",
  ] as const)(
    "%s cannot mint an executable batch or make a financial write",
    async (scenario) => {
      const a = adapter();
      const f = await fixture({
        lineCount: scenario === "eleventh-line" ? 10 : 1,
      });
      if (scenario === "eleventh-line") {
        const extra = structuredClone(f.draft.lines[0]);
        extra.id = "purchase-10";
        f.draft.lines.push(extra);
        f.draft.selectedLineIds.push(extra.id);
      } else if (scenario === "twenty-fifth-installment") {
        f.draft.lines[0].installmentCount = 25;
      } else {
        f.draft.lines[0].amountCents =
          scenario === "zero" ? 0 : scenario === "negative" ? -1 : 2147483648;
      }
      await saveDraft(f);
      const before = await financial(f);
      await expect(prepare(a, f)).rejects.toBeInstanceOf(Error);
      expect(await financial(f)).toEqual(before);
    },
  );

  it("CONFIRMED9 reprepare keeps proposal revision8/H8 despite processing time/nonce changes", async () => {
    const a = adapter();
    const f = await fixture();
    const initial = await prepare(a, f);
    ready(initial);
    await seedConfirmation(f, initial);
    clock.current = new Date("2026-10-06T15:00:30.000Z");
    await prisma.importSession.update({
      where: { id: f.row.id },
      data: { challengeJson: null },
    });
    const again = await prepare(a, f);
    ready(again);
    expect(again.batch.proposal.revision).toBe(8);
    expect(again.batch.proposal.proposalHash).toBe(
      initial.batch.proposal.proposalHash,
    );
    expect(again.batch.preflightHash).toBe(initial.batch.preflightHash);
    expect(
      await prisma.importSession.findUnique({ where: { id: f.row.id } }),
    ).toMatchObject({
      revision: 9,
      confirmedRevision: 8,
      state: "CONFIRMED",
    });
  });

  it("keeps the private preflight canonical input stable when confirming a ready subset", async () => {
    const a = adapter();
    const f = await fixture({ lineCount: 2 });
    const pending = f.draft.lines[1]!;
    pending.decision = { kind: "UNRESOLVED" };
    pending.targets = null;
    pending.tipoDespesa = null;
    f.draft.questions = [
      {
        id: "pending-decision",
        lineIds: [pending.id],
        field: "decision",
        text: "Resolve the pending purchase",
      },
    ];
    f.draft.fieldProvenance = f.draft.fieldProvenance?.filter(
      (item) => item.lineId !== pending.id,
    );
    await saveDraft(f);

    const firstSerialization = jest.spyOn(canonicalSerialization, "canonical");
    const initial = await prepare(a, f);
    ready(initial);
    expect(initial.draft.selectedLineIds).toEqual(["purchase-0"]);
    const initialInput = canonicalInputForHash(
      firstSerialization,
      initial.batch.preflightHash,
    );
    firstSerialization.mockRestore();
    if (!Array.isArray(initialInput))
      throw new Error("Expected an array preflight input");
    expect(initialInput[1]).toEqual([
      expect.objectContaining({
        id: f.draft.lines[0]!.observationIds[0],
      }),
    ]);
    expect(initialInput[3]).toEqual({
      financialPreparation: expect.objectContaining({
        selectedLineIds: ["purchase-0"],
      }),
    });

    await seedConfirmation(f, initial);
    const confirmedSerialization = jest.spyOn(
      canonicalSerialization,
      "canonical",
    );
    const confirmed = await noEffects(f, () => prepare(a, f));
    ready(confirmed);
    const confirmedInput = canonicalInputForHash(
      confirmedSerialization,
      confirmed.batch.preflightHash,
    );
    confirmedSerialization.mockRestore();

    expect(confirmed.batch.proposal).toEqual(initial.batch.proposal);
    expect(changedCanonicalPaths(initialInput, confirmedInput)).toEqual([]);
    expect(confirmed.batch.preflightHash).toBe(initial.batch.preflightHash);
  });

  it("keeps private preflight stable when only the command ledger changes", async () => {
    const a = adapter();
    const f = await fixture({ lineCount: 1 });
    f.draft.declarations = { version: 1, items: [] };
    await saveDraft(f);
    const initial = await prepare(a, f);
    ready(initial);

    f.draft = structuredClone(initial.draft);
    const requestId = randomUUID();
    f.draft.commandLedger = {
      version: 1,
      items: [
        {
          requestId,
          operation: "PREPARE_CURRENT_LOT",
          payloadHash: "f".repeat(64),
          expectedRevision: 7,
          result: {
            version: 1,
            requestId,
            operation: "PREPARE_CURRENT_LOT",
            outcome: "CURRENT_LOT_READY",
            revision: 8,
          },
          actorUserId: f.world.users.owner.id,
          recordedAt: NOW.toISOString(),
        },
      ],
    };
    await saveDraft(f);
    const withOperationalLedger = await prepare(a, f);
    ready(withOperationalLedger);

    expect(withOperationalLedger.batch.proposal).toEqual(
      initial.batch.proposal,
    );
    expect(withOperationalLedger.batch.preflightHash).toBe(
      initial.batch.preflightHash,
    );
  });

  it.each(["semantic-declaration", "guided-provenance", "target"] as const)(
    "changes private preflight for %s semantic drift",
    async (scenario) => {
      const a = adapter();
      const f = await fixture({ lineCount: 1 });
      const initial = await prepare(a, f);
      ready(initial);
      f.draft = structuredClone(initial.draft);

      if (scenario === "semantic-declaration") {
        const observation = await prisma.importObservation.findUniqueOrThrow({
          where: { id: f.draft.lines[0]!.observationIds[0]! },
        });
        const evidence = parseStoredImportObservationEvidence(
          observation.evidenceJson,
        );
        const originalFingerprint = sha(
          canonical({
            tenantId: f.world.tenantId,
            ownerProjectId: f.world.projects.pessoal,
            observationId: observation.id,
            artifactId: f.artifactId,
            documentSha256: f.documentSha256,
            reference: observation.reference,
            evidence,
          }),
        );
        const declaration = {
          field: "merchant" as const,
          value: evidence.identity.merchant,
          meaningContext: null,
          lineId: "purchase-0",
          observationId: observation.id,
          originalFingerprint,
          claimVersion: observation.claimVersion,
          originSessionId: f.row.id,
          recordedRevision: 7,
          questionId:
            "oq_" +
            sha(
              canonical({
                version: 1,
                tenantId: f.world.tenantId,
                sessionId: f.row.id,
                lineId: "purchase-0",
                observationId: observation.id,
                originalFingerprint,
                claimVersion: observation.claimVersion,
                field: "merchant",
                meaningContext: null,
              }),
            ),
          turnId: randomUUID(),
          attestedByUserId: f.world.users.owner.id,
          attestedAt: NOW.toISOString(),
          literalHash: sha(evidence.identity.merchant ?? ""),
        };
        f.draft.declarations = { version: 1, items: [declaration] };
      } else if (scenario === "guided-provenance") {
        const provenance = f.draft.fieldProvenance?.find(
          (item) => item.lineId === "purchase-0" && item.field === "targets",
        );
        if (!provenance) throw new Error("missing provenance fixture");
        provenance.origin = "USER";
      } else {
        const room = await prisma.room.create({
          data: {
            projectId: f.world.projects.casa,
            name: "Semantic drift room",
          },
        });
        const target = f.draft.lines[0]?.targets?.[0];
        if (!target) throw new Error("missing target fixture");
        target.roomId = room.id;
      }
      await saveDraft(f);
      const drifted = await prepare(a, f);
      if (drifted.kind === "READY") {
        expect(drifted.batch.preflightHash).not.toBe(
          initial.batch.preflightHash,
        );
      } else {
        expect(["NEEDS_INPUT", "REVIEW_REQUIRED"]).toContain(drifted.kind);
      }
    },
  );

  it.each(["card", "claim", "financial-row", "observation-reference"] as const)(
    "reprepare exposes %s drift without mutating the confirmed session or financial history",
    async (scenario) => {
      const a = adapter();
      const f = await fixture();
      const initial = await prepare(a, f);
      ready(initial);
      await seedConfirmation(f, initial);
      if (scenario === "card") {
        await prisma.creditCard.update({
          where: { id: f.world.cards.pessoal },
          data: { closingDay: 6 },
        });
      } else if (scenario === "claim") {
        await prisma.importObservation.update({
          where: { id: f.draft.lines[0].observationIds[0] },
          data: { claimVersion: { increment: 1 } },
        });
      } else if (scenario === "observation-reference") {
        await prisma.importObservation.update({
          where: { id: f.draft.lines[0].observationIds[0] },
          data: { reference: "identity-drift" },
        });
      } else {
        await nativeTwins(f);
      }
      await noEffects(f, async () => {
        if (scenario === "observation-reference") {
          await expect(prepare(a, f)).rejects.toMatchObject({
            name: "ImportSessionCorruptStateError",
            field: "evidence_json",
          });
          return;
        }
        const current = await prepare(a, f);
        if (current.kind === "READY") {
          expect(
            current.batch.preflightHash === initial.batch.preflightHash &&
              current.batch.proposal.proposalHash ===
                initial.batch.proposal.proposalHash,
          ).toBe(false);
        } else {
          expect(["NEEDS_INPUT", "REVIEW_REQUIRED"]).toContain(current.kind);
          expect(current).not.toHaveProperty("batch");
        }
      });
    },
  );

  it("material draft edits change search input without rewriting frozen document identity", async () => {
    const a = adapter();
    const f = await fixture({ lineCount: 1, targets: false });
    const first = await prepare(a, f);
    ready(first);
    const observations = await prisma.importObservation.findMany({
      where: { artifactId: f.artifactId },
      orderBy: { id: "asc" },
    });
    f.draft.lines[0].fornecedor = "Different synthetic supplier";
    f.draft.lines[0].titulo = "Different synthetic supplier";
    await saveDraft(f);
    const changed = await prepare(a, f);
    ready(changed);
    expect(changed.search.coverage.inputHash).not.toBe(
      first.search.coverage.inputHash,
    );
    expect(
      await prisma.importObservation.findMany({
        where: { artifactId: f.artifactId },
        orderBy: { id: "asc" },
      }),
    ).toEqual(observations);
  });

  it.each(["clone", "different-auth", "released"] as const)(
    "prepare refuses a %s locked handle before any writes",
    async (scenario) => {
      const a = adapter();
      const f = await fixture();
      await locked(f, async (tx, session) => {
        if (scenario === "released") releaseLockedImportSession(session);
        const auth =
          scenario === "different-auth"
            ? authFor(f.world.users.owner, { expiresAt: EXPIRES })
            : f.auth;
        writes.length = 0;
        await expect(
          a.prepareInTx(
            tx,
            auth,
            scenario === "clone" ? { ...session } : session,
          ),
        ).rejects.toThrow("Invalid import execution handle");
        expect(writes).toEqual([]);
      });
    },
  );

  it("a previous transaction/attempt batch cannot be applied in the next one", async () => {
    const a = adapter();
    const f = await fixture();
    const prepared = await prepare(a, f);
    ready(prepared);
    await locked(f, async (tx) => {
      writes.length = 0;
      await expect(a.applyInTx(tx, f.auth, prepared.batch)).rejects.toThrow(
        "Invalid import execution handle",
      );
      expect(writes).toEqual([]);
    });
  });

  it("ANSWER_PENDING preserves the authoritative selection and questions without minting a proposal", async () => {
    const a = adapter();
    const f = await fixture({ lineCount: 1, targets: false });
    f.draft.questions = [
      {
        id: "pending-question",
        lineIds: [f.draft.lines[0]!.id],
        field: "decision",
        text: "Pending authoritative question",
      },
    ];
    await saveDraft(f);

    await locked(f, async (tx, session) => {
      const prepared = await a.prepareInTx(
        tx,
        f.auth,
        session,
        CardPurchasePreparationPurpose.ANSWER_PENDING,
      );
      expect(prepared.kind).toBe("NEEDS_INPUT");
      expect(prepared).not.toHaveProperty("batch");
      expect(prepared.draft.selectedLineIds).toEqual(f.draft.selectedLineIds);
      expect(prepared.draft.questions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "pending-question",
            lineIds: [f.draft.lines[0]!.id],
          }),
        ]),
      );
    });
  });

  it("cloning a genuine batch cannot carry authority through a structural source cast", async () => {
    const a = adapter();
    const f = await fixture();
    await locked(f, async (tx, session) => {
      const prepared = await a.prepareInTx(tx, f.auth, session);
      ready(prepared);
      writes.length = 0;
      await expect(
        a.applyInTx(tx, f.auth, { ...prepared.batch }),
      ).rejects.toThrow("Invalid import execution handle");
      expect(writes).toEqual([]);
    });
  });

  it("apply consumes before entering the first native financial primitive; a second call cannot write", async () => {
    const a = adapter();
    const f = await fixture();
    const initial = await prepare(a, f);
    await seedConfirmation(f, initial);
    await locked(f, async (tx, session) => {
      const prepared = await a.prepareInTx(tx, f.auth, session);
      ready(prepared);
      const original = expenses.createPlannedCardPurchaseInTx.bind(expenses);
      const spy = jest
        .spyOn(expenses, "createPlannedCardPurchaseInTx")
        .mockImplementation(async (...args) => {
          expect(() =>
            assertPreparedCardBatch(tx, f.auth, prepared.batch),
          ).toThrow("Invalid import execution handle");
          expect(args[0]).toBe(tx);
          return original(...args);
        });
      await a.applyInTx(tx, f.auth, prepared.batch);
      expect(spy).toHaveBeenCalledTimes(2);
      writes.length = 0;
      await expect(a.applyInTx(tx, f.auth, prepared.batch)).rejects.toThrow(
        "Invalid import execution handle",
      );
      expect(writes).toEqual([]);
    });
  });

  it("last target CFE failure rolls back the entire adapter batch, not compensating tombstones", async () => {
    const a = adapter();
    const f = await fixture();
    const initial = await prepare(a, f);
    await seedConfirmation(f, initial);
    const before = {
      financial: await financial(f),
      coordination: await coordination(f),
    };
    failTargetProject = f.world.projects.casa;
    await expect(
      locked(f, async (tx, session) => {
        const prepared = await a.prepareInTx(tx, f.auth, session);
        ready(prepared);
        return a.applyInTx(tx, f.auth, prepared.batch);
      }),
    ).rejects.toThrow("qa-last-target-cfe");
    expect(targetCfes).toBe(20);
    expect({
      financial: await financial(f),
      coordination: await coordination(f),
    }).toEqual(before);
    failTargetProject = null;
    await locked(f, async (tx, session) => {
      const prepared = await a.prepareInTx(tx, f.auth, session);
      ready(prepared);
      expect(await a.applyInTx(tx, f.auth, prepared.batch)).toHaveLength(2);
    });
    expect((await financial(f)).cfes).toHaveLength(40);
  });
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
    parserVersion: "card-local-pdf-v1",
    documentKind: "UNKNOWN",
    invoiceDueMonth: null,
    metrics: {
      pages: 1,
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
