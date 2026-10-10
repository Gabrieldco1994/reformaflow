require("../../../../../scripts/test-db-env.cjs");

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { ImportSession } from "@prisma/client";
import type {
  ImportSessionDraftLineV1,
  ImportSessionStoredDraftV1,
  ImportSessionViewV1,
} from "@reformaflow/domain";
import * as documents from "../../credit-card/parsers/statement-document";
import { fileContentHash } from "../../credit-card/parsers/dedupe-key";
import {
  INCLUDE_SOFT_DELETED,
  PrismaService,
} from "../../prisma/prisma.service";
import {
  createBody,
  EMPTY_DRAFT_JSON,
  FIXED_NOW,
  seedImportWorld,
  seedSession,
  type ImportWorld,
} from "../../test-utils/import-session-harness";
import {
  bootVaultApp,
  CANONICAL_VAULT,
  createVaultTestDatabase,
  fileSeed,
  finishVaultFixture,
  reserve,
  seedArtifact,
  seedRef,
  UI_HEADERS,
  wire,
  type RecoveryApp,
  type Reply,
} from "../../test-utils/import-session-vault-harness";
import {
  IMPORT_SESSION_CAPABILITY,
  type ImportSessionCapability,
} from "./import-session.capability";
import { ImportSessionError } from "./import-session.errors";
import {
  parseStoredImportObservationEvidence,
  type StoredImportObservationEvidenceV1,
} from "./import-session.observation";
import { parseStoredDraft } from "./import-session.projection";
import * as writer from "./import-session.writer";
import { VaultStorage } from "./vault/vault-storage";

const CSV =
  "date,title,amount\n" +
  "2025-06-22,LOJA TESTE PARC 2/3,100.00\n" +
  ",,abc\n" +
  "2025-06-22,LOJA TESTE PARC 2/3,100.00\n";
const EMPTY_CSV = "date,title,amount\n";
const ONE_CSV = "date,title,amount\n2025-06-22,LOJA TESTE,100.00\n";
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SESSION_PATH = (id: string) => `/import-sessions/${id}`;
const ANALYZE_PATH = (id: string, ref: string) =>
  `${SESSION_PATH(id)}/attachments/${ref}/analyze`;

let database: Awaited<ReturnType<typeof createVaultTestDatabase>>;
let setup: PrismaService;
let api: RecoveryApp;
let world: ImportWorld;
let token: string;
let caseNumber = 0;
let writes: string[] = [];
const caseSpies: jest.SpyInstance[] = [];

async function saved(id: string) {
  return setup.importSession.findUniqueOrThrow({ where: { id } });
}

async function draftOf(id: string): Promise<ImportSessionStoredDraftV1> {
  return parseStoredDraft((await saved(id)).draftJson);
}

async function snapshot() {
  const where = { tenantId: world.tenantId };
  const orderBy = { id: "asc" as const };
  return {
    sessions: await setup.importSession.findMany({
      where: { ...where },
      orderBy,
    }),
    refs: await setup.importSessionArtifact.findMany({
      where: { ...where },
      orderBy,
    }),
    artifacts: await setup.importArtifact.findMany({
      where: { ...where },
      orderBy,
    }),
    observations: await setup.importObservation.findMany({
      where: { ...where },
      orderBy,
    }),
    expenses: await setup.expense.findMany({
      where: { ...where, deletedAt: INCLUDE_SOFT_DELETED },
      orderBy,
    }),
    receipts: await setup.receipt.findMany({
      where: { ...where, deletedAt: INCLUDE_SOFT_DELETED },
      orderBy,
    }),
    cfes: await setup.cashFlowEntry.findMany({
      where: { ...where, deletedAt: INCLUDE_SOFT_DELETED },
      orderBy,
    }),
    allocations: await setup.rateioAllocation.findMany({
      where: { ...where },
      orderBy,
    }),
  };
}

function fullView(reply: Reply, id: string): ImportSessionViewV1 {
  expect(reply.status).toBe(200);
  const view: ImportSessionViewV1 = reply.json;
  expect(view.id).toBe(id);
  expect(Object.keys(view).sort()).toEqual(
    [
      "version",
      "id",
      "ownerProjectId",
      "cardId",
      "state",
      "revision",
      "expiresAt",
      "attachments",
      "lines",
      "selectedLineIds",
      "questions",
      "searchComplete",
      "proposal",
      "confirmation",
      "receipt",
      "actions",
      "reviewBlockers",
      "declaredFacts",
    ].sort(),
  );
  expect(view).toHaveProperty("reviewBlockers", expect.any(Array));
  expect(view.declaredFacts).toEqual([]);
  for (const attachment of view.attachments) {
    expect(Object.keys(attachment).sort()).toEqual(
      [
        "id",
        "fileName",
        "declaredBytes",
        "state",
        "materializedInSession",
        "canAnalyze",
      ].sort(),
    );
    expect(attachment).toMatchObject({
      materializedInSession: expect.any(Boolean),
      canAnalyze: expect.any(Boolean),
    });
  }
  return view;
}

function attachment(
  view: ImportSessionViewV1,
  id: string,
  materializedInSession: boolean,
  canAnalyze: boolean,
) {
  expect(view.attachments.find((item) => item.id === id)).toMatchObject({
    id,
    state: "ATTACHED",
    materializedInSession,
    canAnalyze,
  });
}

async function noDocumentIO<T>(work: () => Promise<T>): Promise<T> {
  const forbidden = () => {
    throw new Error(
      "Cached adoption must not parse, open raw, or call a model",
    );
  };
  const spies = [
    jest
      .spyOn(documents, "extractCardStatementDocument")
      .mockImplementation(forbidden),
    jest
      .spyOn(documents, "extractCardStatementBinaryDocument")
      .mockImplementation(forbidden),
    jest
      .spyOn(VaultStorage.prototype, "withArtifactReader")
      .mockImplementation(forbidden),
    jest.spyOn(fs, "open").mockImplementation(forbidden),
    jest.spyOn(fs, "readFile").mockImplementation(forbidden),
    jest.spyOn(globalThis, "fetch").mockImplementation(forbidden),
  ];
  try {
    return await work();
  } finally {
    const calls = spies.map((spy) => spy.mock.calls.length);
    for (const spy of spies) spy.mockRestore();
    expect(calls).toEqual([0, 0, 0, 0, 0, 0]);
  }
}

function analyze(
  session: ImportSession,
  ref: string,
  revision = session.revision,
) {
  return api.call("POST", ANALYZE_PATH(session.id, ref), {
    token,
    headers: UI_HEADERS,
    body: { expectedRevision: revision },
  });
}

async function session() {
  return seedSession(setup, world, { ownerUserId: world.users.restricted.id });
}

// This arranges cached, frozen facts only. It is deliberately not RAW -> draft.
async function cached(
  row: ImportSession,
  content = CSV,
  position = 0,
  pending = true,
) {
  const bytes = Buffer.from(content);
  const extraction =
    content === EMPTY_CSV
      ? documents.validateDocumentExtraction({
          version: 1,
          parserVersion: "card-local-text-v1",
          documentKind: "UNKNOWN",
          invoiceDueMonth: null,
          metrics: {
            rows: 0,
            pages: 0,
            expandedBytes: 0,
            archiveEntries: 0,
            imagePixels: 0,
            frames: 0,
          },
          occurrences: [],
          diagnostics: [],
        })
      : documents.extractCardStatementDocument({
          version: 1,
          context: "CARD_INVOICE",
          format: "CSV",
          profile: "CSV_NUBANK",
          bytes,
        });
  expect(Object.isFrozen(extraction)).toBe(true);
  const artifactId = await seedArtifact(setup, row, {
    state: "EXTRACTED",
    verifiedBytes: bytes.length,
  });
  const sha = createHash("sha256").update(bytes).digest("hex");
  await setup.importArtifact.update({
    where: { id: artifactId },
    data: {
      documentSha256: sha,
      detectedFormat: "CSV",
      parserVersion: extraction.parserVersion,
      extractionJson: JSON.stringify(extraction),
    },
  });
  const ref = await seedRef(setup, row, world.users.restricted, {
    artifactId,
    position,
    state: "ATTACHED",
    fileName: `synthetic-${position}.csv`,
    declaredBytes: bytes.length,
    verifiedAt: FIXED_NOW,
    generation: 1,
  });
  const draft = await draftOf(row.id);
  if (pending) draft.scope.pendingAttachmentIds.push(ref);
  await setup.importSession.update({
    where: { id: row.id },
    data: { draftJson: JSON.stringify(draft) },
  });
  return { ref, artifactId, sha, extraction };
}

async function priorEditableLine(row: ImportSession) {
  const prior = await cached(row, ONE_CSV, 1, false);
  const evidence: StoredImportObservationEvidenceV1 = {
    version: 1,
    reference: "csv:record:2",
    text: "LOJA TESTE",
    amountMeaning: "UNKNOWN",
    amountCents: 10000,
    installmentCount: null,
    installmentIndex: null,
    dataCompra: "2025-06-22",
    identity: {
      merchant: "LOJA TESTE",
      externalId: null,
      fitId: null,
      ordinal: 0,
      fileContentHash: fileContentHash([Buffer.from(ONE_CSV)]),
    },
  };
  const observation = await setup.importObservation.create({
    data: {
      tenantId: row.tenantId,
      ownerProjectId: row.ownerProjectId,
      artifactId: prior.artifactId,
      reference: evidence.reference,
      evidenceJson: JSON.stringify(evidence),
    },
  });
  const line: ImportSessionDraftLineV1 = {
    id: randomUUID(),
    observationIds: [observation.id],
    titulo: "LOJA TESTE",
    fornecedor: "LOJA TESTE",
    tipoDespesa: null,
    categoriaMaoDeObra: null,
    amountMeaning: "UNKNOWN",
    amountCents: 10000,
    installmentCount: null,
    dataCompra: "2025-06-22",
    firstDueDate: null,
    targets: null,
    decision: { kind: "UNRESOLVED" },
  };
  const draft = await draftOf(row.id);
  draft.lines.push(line);
  draft.scope.observationIds.push(observation.id);
  await setup.importSession.update({
    where: { id: row.id },
    data: { draftJson: JSON.stringify(draft) },
  });
  return { line, observation, ref: prior.ref };
}

async function materialEdit(
  row: ImportSession,
  line: ImportSessionDraftLineV1,
) {
  const current = await saved(row.id);
  const draft = await draftOf(row.id);
  expect(current.revision).toBe(row.revision);
  expect(draft.lines).toEqual([line]);
  expect(line.amountCents).toBe(10000);
  expect(draft.selectedLineIds).toEqual([]);
  const replacement = { ...line, amountCents: 20000 };
  const body = {
    expectedRevision: current.revision,
    questionId: null,
    replaceLines: [replacement],
    selectedLineIds: [line.id],
  };
  const reply = await api.call("PATCH", `${SESSION_PATH(row.id)}/draft`, {
    token,
    headers: UI_HEADERS,
    body,
  });
  expect(reply.status).toBe(200);
  expect(reply.json.revision).toBe(current.revision + 1);
  expect(reply.json.lines).toEqual([replacement]);
  expect(reply.json.selectedLineIds).toEqual([line.id]);
  expect((await saved(row.id)).revision).toBe(current.revision + 1);
  expect(await draftOf(row.id)).toEqual({
    ...draft,
    lines: [replacement],
    selectedLineIds: [line.id],
  });
  return { ...body, expectedRevision: current.revision + 1 };
}

async function assertNoFinancialEffects() {
  const state = await snapshot();
  expect([
    state.expenses,
    state.receipts,
    state.cfes,
    state.allocations,
  ]).toEqual([[], [], [], []]);
  expect(
    state.observations.map((item) => [
      item.claimVersion,
      item.canonicalExpenseId,
      item.canonicalReceiptId,
      item.canonicalIndex,
      item.claimSessionId,
      item.claimReceiptJson,
      item.claimedAt,
    ]),
  ).toEqual(
    state.observations.map(() => [0, null, null, null, null, null, null]),
  );
}

describe("X3 cached EXTRACTED HTTP contract (local, inactive)", () => {
  beforeAll(async () => {
    database = await createVaultTestDatabase();
    setup = database.setup;
    const fk = await setup.$queryRaw<
      Array<{ foreign_keys: bigint | number }>
    >`PRAGMA foreign_keys`;
    expect(fk.map((row) => Number(row.foreign_keys))).toEqual([1]);
    api = await bootVaultApp(setup, {
      writes: true,
      vault: CANONICAL_VAULT,
      overrides: [
        {
          token: IMPORT_SESSION_CAPABILITY,
          value: {
            writesEnabled: () => true,
            newImportFormats: () => ["CSV"],
          } satisfies ImportSessionCapability,
        },
      ],
      beforeListen(app) {
        app.get(PrismaService).$use(async (params, next) => {
          if (
            params.model &&
            [
              "ImportSession",
              "ImportSessionArtifact",
              "ImportArtifact",
              "ImportObservation",
              "Expense",
              "Receipt",
              "CashFlowEntry",
              "RateioAllocation",
            ].includes(params.model) &&
            [
              "create",
              "createMany",
              "update",
              "updateMany",
              "upsert",
              "delete",
              "deleteMany",
            ].includes(params.action)
          )
            writes.push(`${params.model}.${params.action}`);
          return next(params);
        });
      },
    });
  });

  beforeEach(async () => {
    world = await seedImportWorld(setup, `x3-http-${++caseNumber}`);
    token = await api.tokenFor(world.users.restricted);
    api.clock.current = new Date(FIXED_NOW);
    writes = [];
  });

  afterEach(() => {
    for (const spy of caseSpies.splice(0)) spy.mockRestore();
  });

  afterAll(async () => {
    await finishVaultFixture(
      async () => {
        if (setup)
          expect(await setup.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
      },
      () => api?.close(),
      () => database?.close(),
    );
  });

  it("reserve_adds_only_pending_ids_atomically_with_refs", async () => {
    const row = await session();
    const files = [
      fileSeed({ fileName: "first.csv", mime: "text/csv" }),
      fileSeed({ fileName: "second.csv", mime: "text/csv" }),
    ];
    const reply = await reserve(api, token, row.id, files);
    expect(reply.status).toBe(200);
    expect(await draftOf(row.id)).toEqual({
      version: 1,
      lines: [],
      selectedLineIds: [],
      questions: [],
      scope: {
        observationIds: [],
        pendingAttachmentIds: files.map((file) => file.id),
      },
    });
    expect(
      await setup.importSessionArtifact.findMany({
        where: { sessionId: row.id },
        orderBy: { position: "asc" },
      }),
    ).toMatchObject(files.map((file) => ({ id: file.id, state: "RESERVED" })));
    expect((await saved(row.id)).revision).toBe(2);
  });

  it("reserve_failure_rolls_back_refs_and_pending_in_the_same_writer", async () => {
    const row = await session();
    const before = await snapshot();
    const prisma = api.app.get(PrismaService);
    let armed = true;
    let reached = 0;
    prisma.$use(async (params, next) => {
      if (
        armed &&
        params.model === "ImportSession" &&
        ["update", "updateMany"].includes(params.action)
      ) {
        reached++;
        throw new ImportSessionError("RETRYABLE_WRITE_CONFLICT");
      }
      return next(params);
    });
    let reply: Reply;
    try {
      reply = await reserve(api, token, row.id, [
        fileSeed({ fileName: "fatura.csv", mime: "text/csv" }),
      ]);
    } finally {
      armed = false;
    }
    expect([reply.status, reply.json]).toEqual([
      503,
      wire("RETRYABLE_WRITE_CONFLICT"),
    ]);
    expect(reached).toBeGreaterThan(0);
    expect(await snapshot()).toEqual(before);
  });

  it("stale_new_reservation_has_no_partial_pending_or_ref", async () => {
    const row = await session();
    const before = await snapshot();
    const reply = await reserve(
      api,
      token,
      row.id,
      [fileSeed({ fileName: "fatura.csv", mime: "text/csv" })],
      {
        expectedRevision: 2,
      },
    );
    expect([reply.status, reply.json]).toEqual([
      409,
      wire("REVISION_CONFLICT", {
        sessionId: row.id,
        currentRevision: 1,
      }),
    ]);
    expect(await snapshot()).toEqual(before);
  });

  it("get_distinguishes_completed_and_cached_pending_without_writes", async () => {
    const row = await session();
    const done = await cached(row, EMPTY_CSV, 0, false);
    const pending = await cached(row, CSV, 1);
    const before = await snapshot();
    const reply = await noDocumentIO(() =>
      api.call("GET", SESSION_PATH(row.id), { token }),
    );
    expect(await snapshot()).toEqual(before);
    expect(writes).toEqual([]);
    const view = fullView(reply, row.id);
    attachment(view, done.ref, true, false);
    attachment(view, pending.ref, false, true);
    expect(view.actions).toContain("ANALYZE");
    expect(view).toHaveProperty("reviewBlockers", []);
  });

  it("cached_http_publication_preserves_twins_null_facts_and_other_pending_ref", async () => {
    const row = await session();
    const first = await cached(row);
    const second = await cached(row, ONE_CSV, 1);
    const artifact = await setup.importArtifact.findUniqueOrThrow({
      where: { id: first.artifactId },
    });
    const reply = await noDocumentIO(() => analyze(row, first.ref));
    const view = fullView(reply, row.id);
    expect(view.revision).toBe(2);
    attachment(view, first.ref, true, false);
    attachment(view, second.ref, false, true);
    expect(view.actions).toContain("ANALYZE");
    expect(["DRAFT", "NEEDS_INPUT"]).toContain(view.state);
    expect([view.proposal, view.confirmation, view.receipt]).toEqual([
      null,
      null,
      null,
    ]);
    const observations = await setup.importObservation.findMany({
      where: { artifactId: first.artifactId },
      orderBy: { reference: "asc" },
    });
    expect(observations).toHaveLength(3);
    expect(new Set(observations.map((item) => item.id)).size).toBe(3);
    observations.forEach((item) => expect(item.id).toMatch(UUID_V4));
    const facts = observations.map((item) =>
      parseStoredImportObservationEvidence(item.evidenceJson),
    );
    expect(
      facts.map((fact) => [
        fact.reference,
        fact.dataCompra,
        fact.amountCents,
        fact.amountMeaning,
        fact.installmentIndex,
        fact.installmentCount,
        fact.identity.merchant,
        fact.identity.ordinal,
        fact.identity.externalId,
        fact.identity.fitId,
      ]),
    ).toEqual([
      [
        "csv:record:2",
        "2025-06-22",
        10000,
        "INSTALLMENT_CHARGE",
        2,
        3,
        "LOJA TESTE",
        0,
        null,
        null,
      ],
      [
        "csv:record:3",
        null,
        null,
        "UNKNOWN",
        null,
        null,
        null,
        null,
        null,
        null,
      ],
      [
        "csv:record:4",
        "2025-06-22",
        10000,
        "INSTALLMENT_CHARGE",
        2,
        3,
        "LOJA TESTE",
        1,
        null,
        null,
      ],
    ]);
    const legacyHash = createHash("sha256")
      .update(first.sha)
      .digest("hex")
      .slice(0, 32);
    expect(legacyHash).toBe(fileContentHash([Buffer.from(CSV)]));
    expect(legacyHash).not.toBe(first.sha.slice(0, 32));
    expect(facts.map((fact) => fact.identity.fileContentHash)).toEqual(
      Array(3).fill(legacyHash),
    );
    expect(view.lines).toHaveLength(3);
    expect(view.selectedLineIds).toEqual(view.lines.map((line) => line.id));
    for (const line of view.lines) {
      expect(line.id).toMatch(UUID_V4);
      expect(line).toMatchObject({
        observationIds: [expect.any(String)],
        decision: { kind: "UNRESOLVED" },
        targets: null,
        amountCents: null,
        firstDueDate: null,
        tipoDespesa: null,
      });
    }
    expect(view.lines.flatMap((line) => line.observationIds).sort()).toEqual(
      observations.map((item) => item.id).sort(),
    );
    const unknownLine = view.lines.find((line) =>
      line.observationIds.includes(observations[1]!.id),
    );
    expect(unknownLine).toBeDefined();
    expect(reply.json.reviewBlockers).toEqual(
      expect.arrayContaining([
        {
          lineId: unknownLine!.id,
          code: "ORIGINAL_IDENTITY_INCOMPLETE",
          resolution: "NEEDS_DECLARATION",
        },
      ]),
    );
    expect((await draftOf(row.id)).scope).toEqual({
      observationIds: expect.arrayContaining(
        observations.map((item) => item.id),
      ),
      pendingAttachmentIds: [second.ref],
    });
    expect(
      await setup.importArtifact.findUniqueOrThrow({
        where: { id: first.artifactId },
      }),
    ).toMatchObject({
      state: "EXTRACTED",
      extractionJson: artifact.extractionJson,
      storageKey: artifact.storageKey,
      verifiedBytes: artifact.verifiedBytes,
      documentSha256: artifact.documentSha256,
      leaseSessionId: null,
    });
    expect(await saved(row.id)).toMatchObject({
      expiresAt: row.expiresAt,
      lastUserEditAt: row.lastUserEditAt,
    });
    await assertNoFinancialEffects();
  });

  it("empty_extraction_completes_and_exact_replay_get_do_not_write_or_renew", async () => {
    const row = await session();
    const { ref } = await cached(row, EMPTY_CSV);
    const first = fullView(await noDocumentIO(() => analyze(row, ref)), row.id);
    attachment(first, ref, true, false);
    expect([first.lines, first.questions, first.selectedLineIds]).toEqual([
      [],
      [],
      [],
    ]);
    expect(first.actions).not.toContain("ANALYZE");
    expect((await draftOf(row.id)).scope).toEqual({
      observationIds: [],
      pendingAttachmentIds: [],
    });
    const before = await snapshot();
    writes = [];
    const recovered = await noDocumentIO(() =>
      api.call("GET", SESSION_PATH(row.id), { token }),
    );
    expect(fullView(recovered, row.id)).toEqual(first);
    const replay = await noDocumentIO(() => analyze(row, ref, first.revision));
    expect(fullView(replay, row.id)).toEqual(first);
    expect(writes).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("lost_response_get_first_uses_current_revision_for_only_the_remaining_ref", async () => {
    const row = await session();
    const first = await cached(row, EMPTY_CSV);
    const second = await cached(row, ONE_CSV, 1);
    // Discard the successful reply; this models response loss, not a TCP disconnect.
    expect((await noDocumentIO(() => analyze(row, first.ref))).status).toBe(
      200,
    );
    const before = await snapshot();
    writes = [];
    const current = fullView(
      await noDocumentIO(() =>
        api.call("GET", SESSION_PATH(row.id), { token }),
      ),
      row.id,
    );
    attachment(current, first.ref, true, false);
    attachment(current, second.ref, false, true);
    expect(writes).toEqual([]);
    expect(await snapshot()).toEqual(before);
    const stale = await noDocumentIO(() => analyze(row, second.ref));
    expect([stale.status, stale.json]).toEqual([
      409,
      wire("REVISION_CONFLICT", {
        sessionId: row.id,
        currentRevision: current.revision,
      }),
    ]);
    expect(await snapshot()).toEqual(before);
    const done = fullView(
      await noDocumentIO(() => analyze(row, second.ref, current.revision)),
      row.id,
    );
    attachment(done, first.ref, true, false);
    attachment(done, second.ref, true, false);
    expect(done.revision).toBe(current.revision + 1);
  });

  it("reservation_replay_does_not_reopen_a_materialized_reference", async () => {
    const row = await session();
    const file = fileSeed({
      fileName: "empty.csv",
      mime: "text/csv",
      declaredBytes: Buffer.byteLength(EMPTY_CSV),
    });
    expect((await reserve(api, token, row.id, [file])).status).toBe(200);
    const arranged = await session();
    const frozen = await cached(arranged, EMPTY_CSV);
    await setup.importSessionArtifact.update({
      where: { id: frozen.ref },
      data: { state: "RELEASED", releasedAt: FIXED_NOW },
    });
    await setup.importSessionArtifact.update({
      where: { id: file.id },
      data: {
        state: "ATTACHED",
        artifactId: frozen.artifactId,
        verifiedAt: FIXED_NOW,
        reservedBytes: 0,
        temporaryStorageKey: null,
        uploadLeaseExpiresAt: null,
      },
    });
    const first = fullView(
      await noDocumentIO(() => analyze(row, file.id, 2)),
      row.id,
    );
    const before = await snapshot();
    writes = [];
    const replay = await reserve(api, token, row.id, [file], {
      expectedRevision: 1,
    });
    expect(fullView(replay, row.id)).toEqual(first);
    expect(writes).toEqual([]);
    expect(await snapshot()).toEqual(before);
    expect((await draftOf(row.id)).scope.pendingAttachmentIds).toEqual([]);
  });

  it.each([false, true])(
    "already_claimed_completion_preserves_evidence_with_new_occurrence=%s",
    async (mixed) => {
      const row = await session();
      const content = mixed
        ? ONE_CSV + "2025-06-23,OUTRA LOJA,200.00\n"
        : ONE_CSV;
      const frozen = await cached(row, content);
      const prior = await session();
      const financialRequestId = randomUUID();
      const expense = await setup.expense.create({
        data: {
          tenantId: world.tenantId,
          projectId: world.projects.pessoal,
          titulo: "Synthetic prior claim",
          valor: 10000,
          valorTotal: 10000,
          formaPagamento: "A_VISTA",
          tipoDespesa: "MATERIAL",
          status: "PLANEJADO",
        },
      });
      const observation = await setup.importObservation.create({
        data: {
          tenantId: world.tenantId,
          ownerProjectId: world.projects.pessoal,
          artifactId: frozen.artifactId,
          reference: "csv:record:2",
          evidenceJson: JSON.stringify({
            version: 1,
            reference: "csv:record:2",
            text: "Frozen prior evidence",
            amountMeaning: "UNKNOWN",
            amountCents: 10000,
            installmentCount: null,
            installmentIndex: null,
            dataCompra: "2025-06-22",
            identity: {
              merchant: "LOJA TESTE",
              externalId: null,
              fitId: null,
              ordinal: 0,
              fileContentHash: fileContentHash([Buffer.from(content)]),
            },
          }),
          claimVersion: 1,
          canonicalProjectId: world.projects.pessoal,
          canonicalExpenseId: expense.id,
          claimSessionId: prior.id,
          claimReceiptJson: JSON.stringify({
            kind: "SESSION",
            sessionId: prior.id,
            financialRequestId,
          }),
          claimedAt: FIXED_NOW,
        },
      });
      const before = await snapshot();
      const view = fullView(
        await noDocumentIO(() => analyze(row, frozen.ref)),
        row.id,
      );
      attachment(view, frozen.ref, true, false);
      expect(view.lines).toHaveLength(mixed ? 1 : 0);
      expect(view.lines.flatMap((line) => line.observationIds)).not.toContain(
        observation.id,
      );
      const scope = (await draftOf(row.id)).scope;
      expect(scope.pendingAttachmentIds).toEqual([]);
      expect(scope.observationIds).toHaveLength(mixed ? 1 : 0);
      expect(scope.observationIds).not.toContain(observation.id);
      expect(
        await setup.importObservation.findUniqueOrThrow({
          where: { id: observation.id },
        }),
      ).toEqual(observation);
      const after = await snapshot();
      expect([
        after.expenses,
        after.receipts,
        after.cfes,
        after.allocations,
      ]).toEqual([
        before.expenses,
        before.receipts,
        before.cfes,
        before.allocations,
      ]);
      expect(after.observations).toHaveLength(mixed ? 2 : 1);
      expect(
        after.observations.filter((item) => item.claimVersion !== 0),
      ).toEqual([observation]);
    },
  );

  it("edit_and_reload_preserve_completion_and_original_nulls", async () => {
    const row = await session();
    const { ref } = await cached(row);
    const view = fullView(await noDocumentIO(() => analyze(row, ref)), row.id);
    const originals = (await snapshot()).observations;
    const unknown = originals.find(
      (item) =>
        parseStoredImportObservationEvidence(item.evidenceJson).dataCompra ===
        null,
    );
    expect(unknown).toBeDefined();
    const line = view.lines.find((item) =>
      item.observationIds.includes(unknown!.id),
    );
    expect(line).toBeDefined();
    const edited = await api.call("PATCH", `${SESSION_PATH(row.id)}/draft`, {
      token,
      headers: UI_HEADERS,
      body: {
        expectedRevision: view.revision,
        questionId: null,
        replaceLines: view.lines.map((item) =>
          item.id === line!.id
            ? { ...item, dataCompra: "2025-06-23", amountCents: 20000 }
            : item,
        ),
        selectedLineIds: [line!.id],
      },
    });
    const updated = fullView(edited, row.id);
    attachment(updated, ref, true, false);
    expect(updated.selectedLineIds).toEqual([line!.id]);
    expect(updated.actions).not.toContain("PREPARE");
    expect(updated).toHaveProperty(
      "reviewBlockers",
      expect.arrayContaining([
        {
          lineId: line!.id,
          code: "ORIGINAL_IDENTITY_INCOMPLETE",
          resolution: "NEEDS_DECLARATION",
        },
      ]),
    );
    const beforeRead = await snapshot();
    writes = [];
    const reloaded = await noDocumentIO(() =>
      api.call("GET", SESSION_PATH(row.id), { token }),
    );
    expect(fullView(reloaded, row.id)).toEqual(updated);
    expect((await snapshot()).observations).toEqual(originals);
    expect(await snapshot()).toEqual(beforeRead);
    expect(writes).toEqual([]);
    expect((await draftOf(row.id)).scope.pendingAttachmentIds).toEqual([]);
  });

  it.each([
    "edit",
    "cancel",
    "expiry",
    "acl",
    "session-version",
    "generation",
  ] as const)(
    "%s after a committed adoption claim fences late publication",
    async (change) => {
      const row = await session();
      const frozen = await cached(row);
      const prior = change === "edit" ? await priorEditableLine(row) : null;
      const originalWrite = writer.runImportSessionWrite;
      let reached = false;
      let winner: Awaited<ReturnType<typeof snapshot>> | undefined;
      const intercepted: typeof writer.runImportSessionWrite = async (
        prisma,
        clock,
        auth,
        work,
        guard,
      ) => {
        const result = await originalWrite(prisma, clock, auth, work, guard);
        const claimed = await setup.importArtifact.findUniqueOrThrow({
          where: { id: frozen.artifactId },
        });
        if (!reached && claimed.leaseSessionId === row.id) {
          reached = true;
          expect(claimed.state).toBe("EXTRACTED");
          expect(claimed.parseGeneration).toBeGreaterThan(0);
          if (change === "edit") {
            expect(prior).not.toBeNull();
            await materialEdit(row, prior!.line);
          } else if (change === "cancel") {
            const current = await saved(row.id);
            const reply = await api.call(
              "POST",
              `${SESSION_PATH(row.id)}/cancel`,
              {
                token,
                headers: UI_HEADERS,
                body: { expectedRevision: current.revision },
              },
            );
            expect(reply.status).toBe(200);
          } else if (change === "expiry") {
            api.clock.current = new Date(row.expiresAt);
          } else if (change === "acl") {
            await setup.user.update({
              where: { id: world.users.restricted.id },
              data: { allowedProjects: JSON.stringify([world.projects.casa]) },
            });
          } else if (change === "session-version") {
            await setup.user.update({
              where: { id: world.users.restricted.id },
              data: { sessionVersion: { increment: 1 } },
            });
          } else {
            await setup.importArtifact.update({
              where: { id: frozen.artifactId },
              data: { parseGeneration: { increment: 1 } },
            });
          }
          winner = await snapshot();
        }
        return result;
      };
      caseSpies.push(
        jest
          .spyOn(writer, "runImportSessionWrite")
          .mockImplementation(intercepted),
      );
      const reply = await noDocumentIO(() => analyze(row, frozen.ref));
      // Not a SQLite contention proof: the competing change is scheduled after commit.
      expect(reached).toBe(true);
      expect([401, 404, 409, 410, 503]).toContain(reply.status);
      expect(reply.json).toMatchObject({
        code: expect.any(String),
        retryable: expect.any(Boolean),
      });
      const after = await snapshot();
      expect(after.observations).toEqual(prior ? [prior.observation] : []);
      if (change !== "expiry") {
        expect(after.sessions).toEqual(winner!.sessions);
        expect(after.refs).toEqual(winner!.refs);
      }
      if (change === "generation")
        expect(after.artifacts).toEqual(winner!.artifacts);
      if (change === "cancel") {
        expect((await saved(row.id)).draftJson).toBe(EMPTY_DRAFT_JSON);
      } else if (change !== "expiry") {
        expect((await draftOf(row.id)).scope.pendingAttachmentIds).toEqual([
          frozen.ref,
        ]);
      }
      await assertNoFinancialEffects();
    },
  );

  it("material_edit_control_changes_value_and_selection_while_noop_preserves_revision", async () => {
    const row = await session();
    const pending = await cached(row);
    const prior = await priorEditableLine(row);
    const before = await snapshot();
    const noop = await noDocumentIO(() =>
      api.call("PATCH", `${SESSION_PATH(row.id)}/draft`, {
        token,
        headers: UI_HEADERS,
        body: {
          expectedRevision: row.revision,
          questionId: null,
          replaceLines: [],
          selectedLineIds: [],
        },
      }),
    );
    expect(noop.status).toBe(200);
    expect(noop.json.revision).toBe(row.revision);
    expect(noop.json.lines).toEqual([prior.line]);
    expect(noop.json.selectedLineIds).toEqual([]);
    expect(await snapshot()).toEqual(before);
    expect(writes).toEqual([]);
    const replayBody = await noDocumentIO(() => materialEdit(row, prior.line));
    const winner = await snapshot();
    expect(winner.observations).toEqual([prior.observation]);
    expect(winner.refs).toEqual(before.refs);
    expect(winner.artifacts).toEqual(before.artifacts);
    expect((await draftOf(row.id)).scope).toEqual({
      observationIds: [prior.observation.id],
      pendingAttachmentIds: [pending.ref],
    });
    writes = [];
    const replay = await noDocumentIO(() =>
      api.call("PATCH", `${SESSION_PATH(row.id)}/draft`, {
        token,
        headers: UI_HEADERS,
        body: replayBody,
      }),
    );
    expect(replay.status).toBe(200);
    expect(replay.json.revision).toBe(row.revision + 1);
    expect(replay.json.lines).toEqual(replayBody.replaceLines);
    expect(replay.json.selectedLineIds).toEqual([prior.line.id]);
    expect(await snapshot()).toEqual(winner);
    expect(writes).toEqual([]);
    await assertNoFinancialEffects();
  });

  it.each([
    ["missing", {}],
    ["origin only", { origin: UI_HEADERS.origin }],
    ["header only", { "x-rf-import-ui": "1" }],
    ["foreign origin", { ...UI_HEADERS, origin: "https://invalid.example" }],
    ["invalid marker", { ...UI_HEADERS, "x-rf-import-ui": "true" }],
  ] as const)(
    "rejects %s UI authority before materialization",
    async (_name, headers) => {
      const row = await session();
      const { ref } = await cached(row);
      const before = await snapshot();
      const reply = await noDocumentIO(() =>
        api.call("POST", ANALYZE_PATH(row.id, ref), {
          token,
          headers,
          body: { expectedRevision: 1 },
        }),
      );
      expect([reply.status, reply.json]).toEqual([
        403,
        wire("UI_ACTION_REQUIRED"),
      ]);
      expect(await snapshot()).toEqual(before);
      expect(writes).toEqual([]);
    },
  );

  it.each([
    {},
    { expectedRevision: "1" },
    { expectedRevision: 0 },
    { expectedRevision: 1, confirmed: true },
    { expectedRevision: 1, grant: { operation: "ANALYZE_ATTACHMENT" } },
    { expectedRevision: 1, artifactId: "client-chosen" },
  ])("accepts only exact revision body: %j", async (body) => {
    const row = await session();
    const { ref } = await cached(row);
    const before = await snapshot();
    const reply = await noDocumentIO(() =>
      api.call("POST", ANALYZE_PATH(row.id, ref), {
        token,
        headers: UI_HEADERS,
        body,
      }),
    );
    expect([reply.status, reply.json]).toEqual([400, wire("INVALID_INPUT")]);
    expect(await snapshot()).toEqual(before);
    expect(writes).toEqual([]);
  });

  it("requires_real_jwt_even_with_ui_headers", async () => {
    const row = await session();
    const { ref } = await cached(row);
    const before = await snapshot();
    const reply = await noDocumentIO(() =>
      api.call("POST", ANALYZE_PATH(row.id, ref), {
        headers: UI_HEADERS,
        body: { expectedRevision: 1 },
      }),
    );
    expect([reply.status, reply.json]).toEqual([401, wire("UNAUTHENTICATED")]);
    expect(await snapshot()).toEqual(before);
  });

  it.each(["peer", "foreign"] as const)(
    "conceals cached refs from %s",
    async (actor) => {
      const row = await session();
      const { ref } = await cached(row);
      const otherToken = await api.tokenFor(world.users[actor]);
      const before = await snapshot();
      const reply = await noDocumentIO(() =>
        api.call("POST", ANALYZE_PATH(row.id, ref), {
          token: otherToken,
          headers: UI_HEADERS,
          body: { expectedRevision: 1 },
        }),
      );
      expect([reply.status, reply.json]).toEqual([404, wire("NOT_FOUND")]);
      expect(await snapshot()).toEqual(before);
    },
  );

  it("off_preserves_completion_but_get_is_the_only_recovery_not_post", async () => {
    const row = await session();
    const done = await cached(row, EMPTY_CSV, 0, false);
    const pending = await cached(row, CSV, 1);
    caseSpies.push(
      jest
        .spyOn(
          api.app.get<ImportSessionCapability>(IMPORT_SESSION_CAPABILITY),
          "writesEnabled",
        )
        .mockReturnValue(false),
    );
    const before = await snapshot();
    const read = await noDocumentIO(() =>
      api.call("GET", SESSION_PATH(row.id), { token }),
    );
    expect(await snapshot()).toEqual(before);
    expect(writes).toEqual([]);
    const view = fullView(read, row.id);
    attachment(view, done.ref, true, false);
    attachment(view, pending.ref, false, false);
    expect(view.actions).not.toContain("ANALYZE");
    for (const ref of [done.ref, pending.ref]) {
      const reply = await noDocumentIO(() => analyze(row, ref));
      expect([reply.status, reply.json]).toEqual([
        503,
        wire("CAPABILITY_DISABLED"),
      ]);
    }
    expect(await snapshot()).toEqual(before);
  });

  it.each(["RAW_READY", "ANALYZING"])(
    "%s remains unavailable without an executor",
    async (state) => {
      const row = await session();
      const frozen = await cached(row);
      await setup.importArtifact.update({
        where: { id: frozen.artifactId },
        data: { state, extractionJson: null, parserVersion: null },
      });
      const before = await snapshot();
      const reply = await noDocumentIO(() => analyze(row, frozen.ref));
      expect([reply.status, reply.json]).toEqual([
        503,
        wire("CAPABILITY_DISABLED"),
      ]);
      const read = fullView(
        await noDocumentIO(() =>
          api.call("GET", SESSION_PATH(row.id), { token }),
        ),
        row.id,
      );
      attachment(read, frozen.ref, false, false);
      expect(read.actions).not.toContain("ANALYZE");
      expect(writes).toEqual([]);
      expect(await snapshot()).toEqual(before);
    },
  );

  it.each([99, 100, 101])(
    "consumer line boundary %i never publishes a prefix",
    async (count) => {
      const row = await session();
      const content =
        "date,title,amount\n" +
        Array.from(
          { length: count },
          (_, index) => `2025-06-22,LOJA ${index},100.00\n`,
        ).join("");
      const { ref } = await cached(row, content);
      const before = await snapshot();
      const reply = await noDocumentIO(() => analyze(row, ref));
      if (count === 101) {
        expect([reply.status, reply.json]).toEqual([
          422,
          wire("LIMIT_EXCEEDED"),
        ]);
        const after = await snapshot();
        expect(after.sessions).toEqual(before.sessions);
        expect(after.observations).toEqual([]);
        expect(after.refs).toEqual(before.refs);
        expect((await draftOf(row.id)).scope.pendingAttachmentIds).toEqual([
          ref,
        ]);
      } else {
        const view = fullView(reply, row.id);
        expect(view.lines).toHaveLength(count);
        expect((await draftOf(row.id)).scope.observationIds).toHaveLength(
          count,
        );
        attachment(view, ref, true, false);
      }
      await assertNoFinancialEffects();
    },
  );

  it("create_http_control_keeps_the_real_guard_chain", async () => {
    const reply = await api.call("POST", "/import-sessions", {
      token,
      headers: UI_HEADERS,
      body: createBody(world.cards.pessoal),
    });
    expect(reply.status).toBe(201);
    expect(reply.json).toMatchObject({
      ownerProjectId: world.projects.pessoal,
      cardId: world.cards.pessoal,
      state: "DRAFT",
      revision: 1,
    });
    const denied = await api.call("POST", "/import-sessions", {
      token,
      body: createBody(world.cards.pessoal),
    });
    expect([denied.status, denied.json]).toEqual([
      403,
      wire("UI_ACTION_REQUIRED"),
    ]);
    await assertNoFinancialEffects();
  });

  it("recovery_summary_remains_columns_only_without_review_blockers", async () => {
    const row = await session();
    await cached(row, EMPTY_CSV);
    const before = await snapshot();
    const reply = await noDocumentIO(() =>
      api.call("GET", "/import-sessions", { token }),
    );
    expect(reply.status).toBe(200);
    expect(reply.json.items).toEqual([
      {
        id: row.id,
        state: "DRAFT",
        revision: 1,
        cardId: row.cardId,
        ownerProjectId: row.ownerProjectId,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        appliedAt: null,
        attachmentCount: 1,
        hasConfirmation: false,
        continuationSessionId: null,
        actions: ["CANCEL"],
      },
    ]);
    expect(writes).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("second_adopter_cannot_steal_a_live_lease_or_publish_twice", async () => {
    const row = await session();
    const { ref, artifactId } = await cached(row, EMPTY_CSV);
    const originalWrite = writer.runImportSessionWrite;
    let contested = false;
    const intercepted: typeof writer.runImportSessionWrite = async (
      prisma,
      clock,
      auth,
      work,
      guard,
    ) => {
      const result = await originalWrite(prisma, clock, auth, work, guard);
      const claimed = await setup.importArtifact.findUniqueOrThrow({
        where: { id: artifactId },
      });
      if (!contested && claimed.leaseSessionId === row.id) {
        contested = true;
        const before = await snapshot();
        const loser = await analyze(row, ref);
        expect([loser.status, loser.json]).toEqual([
          409,
          wire("LEASE_CONFLICT"),
        ]);
        expect(await snapshot()).toEqual(before);
      }
      return result;
    };
    caseSpies.push(
      jest
        .spyOn(writer, "runImportSessionWrite")
        .mockImplementation(intercepted),
    );
    const reply = await noDocumentIO(() => analyze(row, ref));
    expect(reply.status).toBe(200);
    expect(contested).toBe(true);
    const view = fullView(reply, row.id);
    expect(view.revision).toBe(2);
    attachment(view, ref, true, false);
    expect((await draftOf(row.id)).scope.pendingAttachmentIds).toEqual([]);
    await assertNoFinancialEffects();
  });

  it.each(["publication", "release", "positive"] as const)(
    "late_cas_%s_uses_real_scoped_query_and_preserves_atomicity",
    async (loss) => {
      const row = await session();
      const frozen = await cached(row);
      const prior = await priorEditableLine(row);
      const before = await snapshot();
      const baseline = await saved(row.id);
      const beforeDraft = await draftOf(row.id);
      const artifact = await setup.importArtifact.findUniqueOrThrow({
        where: { id: frozen.artifactId },
      });
      const createdIds: string[] = [];
      const outcomes: Array<{
        stage: "publication" | "release";
        count: number;
      }> = [];
      let armed = true;
      let publicationAccepted = false;
      let releaseAttempted = false;
      api.app.get(PrismaService).$use(async (params, next) => {
        if (!armed) return next(params);
        if (
          params.model === "ImportObservation" &&
          params.action === "create" &&
          params.args?.data?.tenantId === world.tenantId &&
          params.args?.data?.artifactId === frozen.artifactId
        ) {
          const result = await next(params);
          expect(result).toMatchObject({
            id: expect.stringMatching(UUID_V4),
            artifactId: frozen.artifactId,
            tenantId: world.tenantId,
          });
          createdIds.push(result.id);
          return result;
        }
        const publication =
          params.model === "ImportSession" &&
          params.action === "updateMany" &&
          params.args?.where?.id === row.id &&
          params.args?.where?.tenantId === world.tenantId &&
          typeof params.args?.data?.draftJson === "string" &&
          params.args?.data?.revision?.increment === 1;
        const release =
          publicationAccepted &&
          !releaseAttempted &&
          params.model === "ImportArtifact" &&
          params.action === "updateMany" &&
          params.args?.where?.id === frozen.artifactId &&
          params.args?.where?.tenantId === world.tenantId &&
          params.args?.where?.leaseSessionId === row.id &&
          params.args?.data?.leaseSessionId === null;
        if (!publication && !release) return next(params);
        expect(createdIds).toHaveLength(3);
        if (publication) {
          expect(outcomes).toEqual([]);
          expect(params.args.where).toMatchObject({
            id: row.id,
            tenantId: world.tenantId,
            ownerUserId: row.ownerUserId,
            revision: baseline.revision,
          });
          const proposed = parseStoredDraft(params.args.data.draftJson);
          expect(proposed.scope).toEqual({
            observationIds: [prior.observation.id, ...createdIds],
            pendingAttachmentIds: [],
          });
        } else {
          releaseAttempted = true;
          expect(outcomes).toEqual([{ stage: "publication", count: 1 }]);
          expect(params.args.where).toMatchObject({
            ownerProjectId: row.ownerProjectId,
            parseGeneration: artifact.parseGeneration + 1,
            state: "EXTRACTED",
          });
        }
        const stage = publication ? "publication" : "release";
        // Keep the original predicate and execute SQL with one contradictory CAS term.
        const forwarded =
          loss === stage
            ? {
                ...params,
                args: {
                  ...params.args,
                  where: {
                    AND: [
                      params.args.where,
                      {
                        tenantId: world.tenantId,
                        ...(publication
                          ? {
                              id: row.id,
                              revision: { not: baseline.revision },
                            }
                          : {
                              id: frozen.artifactId,
                              parseGeneration: {
                                not: artifact.parseGeneration + 1,
                              },
                            }),
                      },
                    ],
                  },
                },
              }
            : params;
        const result = await next(forwarded);
        expect(result).toEqual({ count: loss === stage ? 0 : 1 });
        outcomes.push({ stage, count: result.count });
        if (publication) publicationAccepted = result.count === 1;
        return result;
      });
      let reply: Reply;
      try {
        reply = await noDocumentIO(() => analyze(row, frozen.ref));
      } finally {
        armed = false;
      }
      expect(createdIds).toHaveLength(3);
      expect(new Set(createdIds).size).toBe(3);
      expect(outcomes).toEqual(
        loss === "publication"
          ? [{ stage: "publication", count: 0 }]
          : [
              { stage: "publication", count: 1 },
              { stage: "release", count: loss === "release" ? 0 : 1 },
            ],
      );
      const after = await snapshot();
      const current = await saved(row.id);
      const currentDraft = await draftOf(row.id);
      if (loss === "positive") {
        const view = fullView(reply, row.id);
        attachment(view, frozen.ref, true, false);
        attachment(view, prior.ref, true, false);
        expect(view.revision).toBe(baseline.revision + 1);
        expect(view.lines).toHaveLength(4);
        expect(current.revision).toBe(baseline.revision + 1);
        expect(
          currentDraft.lines.find((line) => line.id === prior.line.id),
        ).toEqual(prior.line);
        expect(currentDraft.selectedLineIds).toEqual(
          currentDraft.lines
            .filter((line) => line.id !== prior.line.id)
            .map((line) => line.id),
        );
        expect(currentDraft.scope).toEqual({
          observationIds: [prior.observation.id, ...createdIds],
          pendingAttachmentIds: [],
        });
        expect(after.observations).toHaveLength(4);
        expect(
          after.observations
            .filter((item) => item.id !== prior.observation.id)
            .map((item) => item.id)
            .sort(),
        ).toEqual([...createdIds].sort());
      } else {
        expect([reply.status, reply.json]).toEqual([
          409,
          loss === "publication"
            ? wire("REVISION_CONFLICT", {
                sessionId: row.id,
                currentRevision: baseline.revision,
              })
            : wire("LEASE_CONFLICT"),
        ]);
        expect(after.observations).toEqual(before.observations);
        expect(currentDraft).toEqual(beforeDraft);
        expect(current).toMatchObject({
          revision: baseline.revision,
          state: baseline.state,
          draftJson: baseline.draftJson,
          searchJson: baseline.searchJson,
          proposalJson: baseline.proposalJson,
          proposalHash: baseline.proposalHash,
          preflightHash: baseline.preflightHash,
          challengeJson: baseline.challengeJson,
          prepareLeaseJson: baseline.prepareLeaseJson,
          prepareGeneration: baseline.prepareGeneration,
        });
        expect(currentDraft.scope.pendingAttachmentIds).toEqual([frozen.ref]);
        writes = [];
        const recovered = fullView(
          await noDocumentIO(() =>
            api.call("GET", SESSION_PATH(row.id), { token }),
          ),
          row.id,
        );
        attachment(recovered, frozen.ref, false, true);
        attachment(recovered, prior.ref, true, false);
        expect(recovered.revision).toBe(baseline.revision);
        expect(recovered.lines).toEqual([prior.line]);
        expect(writes).toEqual([]);
      }
      expect(
        after.observations.find((item) => item.id === prior.observation.id),
      ).toEqual(prior.observation);
      expect(current).toMatchObject({
        lastUserEditAt: baseline.lastUserEditAt,
        expiresAt: baseline.expiresAt,
      });
      expect(
        after.artifacts.find((item) => item.id === frozen.artifactId),
      ).toMatchObject({
        state: "EXTRACTED",
        documentSha256: artifact.documentSha256,
        storageKey: artifact.storageKey,
        extractionJson: artifact.extractionJson,
        verifiedBytes: artifact.verifiedBytes,
        leaseSessionId: null,
        leaseSessionVersion: null,
        leaseTokenExpiresAt: null,
        leaseExpiresAt: null,
      });
      await assertNoFinancialEffects();
    },
  );
});
