import { rawTestDependencies } from "../../test-utils/import-session-raw-harness";
require("../../../../../scripts/test-db-env.cjs");
import { ImportVaultGate } from "./vault/vault-state";

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ImportSessionStoredDraftV1 } from "@reformaflow/domain";
import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import {
  authFor,
  cleanupImportWorld,
  MutableClock,
  seedImportWorld,
  seedSession,
  VALID_RECEIPT,
  type ImportWorld,
} from "../../test-utils/import-session-harness";
import { validationDraft } from "../../test-utils/import-session-validation-fixtures";
import type { StoredImportSearchV1 } from "./card-purchase-batch.port";
import {
  ImportSessionCorruptStateError,
  importSessionWire,
} from "./import-session.errors";
import { ImportSessionError } from "./import-session.errors";
import { ImportSessionService } from "./import-session.service";
import { RuntimeUiGrantVerifier } from "./import-session-ui-grant";
import * as declarations from "./import-session.declarations";
import * as cardIdentity from "../../credit-card/card-purchase-identity";
import type { StoredAssistedSourceScheduleV2 } from "../../expense/documented-schedule.types";
import {
  deriveCursorKey,
  signPageCursor,
  verifyPageCursor,
  signListCursor,
  type ImportPageCursorBinding,
} from "./import-session.cursor";

type SearchParser = (
  raw: string | null,
  expectedPrepRevision: number,
  draft: ImportSessionStoredDraftV1,
) => { kind: "EMPTY_SEARCH" } | { kind: "SEARCH"; value: StoredImportSearchV1 };

function parserUnderTest(): SearchParser {
  const path = join(__dirname, "import-session.search.ts");
  expect({ path, exists: existsSync(path) }).toEqual({ path, exists: true });
  const exports: {
    parseStoredImportSearch: SearchParser;
  } = require("./import-session.search");
  expect(typeof exports.parseStoredImportSearch).toBe("function");
  return exports.parseStoredImportSearch;
}

function draft(): ImportSessionStoredDraftV1 {
  const value = validationDraft("search-target");
  value.lines = [value.lines[0]];
  value.selectedLineIds = ["line-create"];
  value.questions = [];
  value.scope = {
    observationIds: ["observation-create"],
    pendingAttachmentIds: [],
  };
  return value;
}

function search(): StoredImportSearchV1 {
  return {
    version: 1,
    revision: 8,
    complete: true,
    candidates: [
      {
        lineId: "line-create",
        kind: "EXPENSE",
        id: "expense-26",
        reason: "NATURAL_MATCH",
      },
    ],
    coverage: {
      recipe: "CARD_PURCHASE_V1",
      inputHash: "a".repeat(64),
      steps: [
        {
          lineId: "line-create",
          stage: "DOCUMENT_IDENTITY",
          status: "EXHAUSTED",
          predicateHash: "b".repeat(64),
          visitedRows: 0,
          endCursor: null,
        },
        {
          lineId: "line-create",
          stage: "CROSS_ORIGIN",
          status: "EXHAUSTED",
          predicateHash: "c".repeat(64),
          visitedRows: 26,
          endCursor: null,
        },
        {
          lineId: "line-create",
          stage: "CARD_IDENTITY",
          status: "EXHAUSTED",
          predicateHash: "d".repeat(64),
          visitedRows: 1,
          endCursor: null,
        },
      ],
    },
  };
}

describe("S parser RED: exact private coverage, not proof of matcher execution", () => {
  it("exports the actual parser at the approved path", () => {
    parserUnderTest();
  });

  it("SQL NULL alone denotes EMPTY_SEARCH", () => {
    const parse = parserUnderTest();
    expect(parse(null, 8, draft())).toEqual({ kind: "EMPTY_SEARCH" });
  });

  it.each([
    "",
    " ",
    "null",
    "{}",
    "[]",
    "{",
    '{"complete":true}',
    '{"version":1}',
  ])(
    "rejects non-null incompatible search %p as sanitized corruption",
    (raw) => {
      const parse = parserUnderTest();
      expect(() => parse(raw, 8, draft())).toThrow(
        ImportSessionCorruptStateError,
      );
      expect(() => parse(raw, 8, draft())).toThrow(
        expect.objectContaining({
          field: "search",
          message: "import session state is corrupted",
        }),
      );
    },
  );

  it("accepts the complete shape at preparation revision 8, not current CONFIRMED revision 9", () => {
    const parse = parserUnderTest();
    const value = search();
    expect(parse(JSON.stringify(value), 8, draft())).toEqual({
      kind: "SEARCH",
      value,
    });
    expect(() => parse(JSON.stringify(value), 9, draft())).toThrow(
      ImportSessionCorruptStateError,
    );
  });

  it("accepts zero visited rows for an actually exhausted stage", () => {
    const parse = parserUnderTest();
    const value = search();
    value.candidates = [];
    for (const step of value.coverage.steps) step.visitedRows = 0;
    expect(parse(JSON.stringify(value), 8, draft())).toEqual({
      kind: "SEARCH",
      value,
    });
  });

  it("retains candidate 26 rather than truncating private search to a public page", () => {
    const parse = parserUnderTest();
    const value = search();
    value.candidates = Array.from({ length: 26 }, (_, index) => ({
      lineId: "line-create",
      kind: "EXPENSE",
      id: `expense-${index + 1}`,
      reason: "NATURAL_MATCH",
    }));
    expect(parse(JSON.stringify(value), 8, draft())).toEqual({
      kind: "SEARCH",
      value,
    });
  });

  const mutations: Array<[string, (value: StoredImportSearchV1) => void]> = [
    [
      "unknown root key",
      (value) => {
        Object.assign(value, { privateText: "SEARCH_SENTINEL" });
      },
    ],
    [
      "wrong version",
      (value) => {
        Object.assign(value, { version: 2 });
      },
    ],
    [
      "wrong recipe",
      (value) => {
        Object.assign(value.coverage, { recipe: "OTHER" });
      },
    ],
    [
      "unknown coverage key",
      (value) => {
        Object.assign(value.coverage, { resume: "cursor" });
      },
    ],
    [
      "bad input hash",
      (value) => {
        value.coverage.inputHash = "SEARCH_SENTINEL";
      },
    ],
    [
      "missing Receipt/cross-origin stage",
      (value) => {
        value.coverage.steps.splice(1, 1);
      },
    ],
    [
      "duplicate stage",
      (value) => {
        value.coverage.steps[1] = { ...value.coverage.steps[0] };
      },
    ],
    [
      "foreign line stage",
      (value) => {
        value.coverage.steps[0].lineId = "not-in-draft";
      },
    ],
    [
      "unknown step key",
      (value) => {
        Object.assign(value.coverage.steps[0], { sql: "SEARCH_SENTINEL" });
      },
    ],
    [
      "partial resume cursor",
      (value) => {
        Object.assign(value.coverage.steps[0], { endCursor: "resume" });
      },
    ],
    [
      "missing predicate hash",
      (value) => {
        Object.assign(value.coverage.steps[0], { predicateHash: null });
      },
    ],
    [
      "fractional visits",
      (value) => {
        value.coverage.steps[0].visitedRows = 0.5;
      },
    ],
    [
      "negative visits",
      (value) => {
        value.coverage.steps[0].visitedRows = -1;
      },
    ],
    [
      "unknown candidate key",
      (value) => {
        Object.assign(value.candidates[0], { description: "SEARCH_SENTINEL" });
      },
    ],
    [
      "foreign candidate line",
      (value) => {
        value.candidates[0].lineId = "not-in-draft";
      },
    ],
    [
      "unknown candidate kind",
      (value) => {
        Object.assign(value.candidates[0], { kind: "CARD" });
      },
    ],
    [
      "unknown candidate reason",
      (value) => {
        Object.assign(value.candidates[0], { reason: "ABSENT_HISTORY" });
      },
    ],
    [
      "duplicate candidate reference",
      (value) => {
        value.candidates.push({ ...value.candidates[0] });
      },
    ],
    [
      "complete false despite exact exhausted coverage",
      (value) => {
        value.complete = false;
      },
    ],
  ];
  it.each(mutations)("rejects %s", (_label, mutate) => {
    const parse = parserUnderTest();
    const value = search();
    mutate(value);
    expect(() => parse(JSON.stringify(value), 8, draft())).toThrow(
      ImportSessionCorruptStateError,
    );
  });

  it("accepts NOT_RUN only as incomplete, with its exact null/zero fields", () => {
    const parse = parserUnderTest();
    const value = search();
    value.complete = false;
    value.coverage.steps[1] = {
      lineId: "line-create",
      stage: "CROSS_ORIGIN",
      status: "NOT_RUN",
      predicateHash: null,
      visitedRows: 0,
      endCursor: null,
    };
    expect(parse(JSON.stringify(value), 8, draft())).toEqual({
      kind: "SEARCH",
      value,
    });
    for (const patch of [
      { predicateHash: "a".repeat(64) },
      { visitedRows: 1 },
      { endCursor: "resume" },
    ]) {
      const broken = structuredClone(value);
      Object.assign(broken.coverage.steps[1], patch);
      expect(() => parse(JSON.stringify(broken), 8, draft())).toThrow(
        ImportSessionCorruptStateError,
      );
    }
    value.complete = true;
    expect(() => parse(JSON.stringify(value), 8, draft())).toThrow(
      ImportSessionCorruptStateError,
    );
  });

  it("enforces 5000 aggregate visits, not 5000 per stage", () => {
    const parse = parserUnderTest();
    const value = search();
    [1700, 1700, 1600].forEach((count, index) => {
      value.coverage.steps[index].visitedRows = count;
    });
    expect(parse(JSON.stringify(value), 8, draft())).toEqual({
      kind: "SEARCH",
      value,
    });
    value.coverage.steps[2].visitedRows += 1;
    expect(() => parse(JSON.stringify(value), 8, draft())).toThrow(
      ImportSessionCorruptStateError,
    );
  });

  it("does not reset the 5000 budget for another selected line", () => {
    const parse = parserUnderTest();
    const value = search();
    const input = draft();
    input.lines.push({
      ...structuredClone(input.lines[0]),
      id: "line-two",
      observationIds: ["observation-two"],
    });
    input.selectedLineIds.push("line-two");
    input.scope.observationIds.push("observation-two");
    value.coverage.steps = ["line-create", "line-two"].flatMap((lineId) =>
      search().coverage.steps.map((step) => {
        if (step.status !== "EXHAUSTED") {
          throw new Error("Expected the literal exhausted-coverage fixture");
        }
        return { ...step, lineId, visitedRows: 834 };
      }),
    );
    expect(() => parse(JSON.stringify(value), 8, input)).toThrow(
      ImportSessionCorruptStateError,
    );
  });
});

describe("S live recovery RED: ACL precedes search corruption", () => {
  const prefix = "w636-search";
  const setup = new PrismaClient();
  const prisma = new PrismaService();
  const clock = new MutableClock(new Date("2026-10-06T15:00:00.000Z"));
  const service = new ImportSessionService(
    prisma,
    clock,
    { writesEnabled: () => false, newImportFormats: () => [] },
    new RuntimeUiGrantVerifier(),
    ...rawTestDependencies(
      new ImportVaultGate(prisma, clock, {}, process.cwd()),
      clock,
      { writesEnabled: () => false, newImportFormats: () => [] },
    ),
  );
  let world: ImportWorld;
  const auth = (user: ImportWorld["users"]["owner"]) =>
    authFor(user, { expiresAt: new Date("2026-10-07T15:00:00.000Z") });

  beforeAll(async () => {
    await setup.$connect();
    await prisma.onModuleInit();
    world = await seedImportWorld(setup, prefix);
  });
  afterAll(async () => {
    await cleanupImportWorld(setup, prefix);
    await setup.$disconnect();
    await prisma.onModuleDestroy();
  });

  it("CONTROL: real middleware retains FK enforcement", async () => {
    const [row] = await prisma.$queryRaw<
      Array<{ foreign_keys: bigint }>
    >`PRAGMA foreign_keys`;
    expect(Number(row.foreign_keys)).toBe(1);
  });

  it.each(["getObservations", "getCandidates"])(
    "exposes the approved in-process read method %s",
    (name) => {
      expect({ name, type: typeof Reflect.get(service, name) }).toEqual({
        name,
        type: "function",
      });
    },
  );

  it.each(["{}", "null", '{"private":"SEARCH_SENTINEL"}'])(
    "authorized read rejects persisted %p without reflecting stored content",
    async (raw) => {
      const row = await seedSession(setup, world, {
        searchJson: raw,
        expiresAt: new Date("2026-10-13T15:00:00.000Z"),
      });
      await expect(
        service.getSession(auth(world.users.owner), row.id),
      ).rejects.toMatchObject({
        name: "ImportSessionCorruptStateError",
        field: "search",
        message: "import session state is corrupted",
      });
    },
  );

  it("the database rejects blank search JSON before any reader is invoked", async () => {
    await expect(seedSession(setup, world, { searchJson: "" })).rejects.toThrow(
      "CHECK constraint failed: search_json",
    );
  });

  it("SQL NULL remains readable as incomplete with OFF", async () => {
    const row = await seedSession(setup, world, {
      searchJson: null,
      expiresAt: new Date("2026-10-13T15:00:00.000Z"),
    });
    expect(
      await service.getSession(auth(world.users.owner), row.id),
    ).toMatchObject({
      searchComplete: false,
      proposal: null,
      confirmation: null,
    });
  });

  describe("S scoped in-process pages", () => {
    const prefix = "w636-pages";
    const setup = new PrismaClient();
    const prisma = new PrismaService();
    const now = new Date("2026-10-06T15:00:00.000Z");
    const clock = new MutableClock(now);
    const service = new ImportSessionService(
      prisma,
      clock,
      { writesEnabled: () => false, newImportFormats: () => [] },
      new RuntimeUiGrantVerifier(),
      ...rawTestDependencies(
        new ImportVaultGate(prisma, clock, {}, process.cwd()),
        clock,
        { writesEnabled: () => false, newImportFormats: () => [] },
      ),
    );
    let world: ImportWorld;
    const events: string[] = [];
    const auth = (user: ImportWorld["users"]["owner"] = world.users.owner) =>
      authFor(user, { expiresAt: new Date("2026-10-07T15:00:00.000Z") });
    async function page(
      kind: "getObservations" | "getCandidates",
      id: string,
      query: unknown = {},
      context = auth(),
    ): Promise<{
      items: Record<string, unknown>[];
      nextCursor: string | null;
    }> {
      const method: unknown = Reflect.get(service, kind);
      expect(typeof method).toBe("function");
      if (typeof method !== "function")
        throw new Error(`Missing reader ${kind}`);
      return method.call(service, context, id, query);
    }
    beforeAll(async () => {
      await setup.$connect();
      await prisma.onModuleInit();
      prisma.$use(async (params, next) => {
        events.push(`${params.model ?? "SQL"}.${params.action}`);
        return next(params);
      });
      world = await seedImportWorld(setup, prefix);
    });
    beforeEach(() => {
      clock.current = new Date(now);
      events.length = 0;
    });
    afterAll(async () => {
      await setup.rateioAllocation.deleteMany({
        where: { tenantId: world.tenantId },
      });
      await setup.cashFlowEntry.deleteMany({
        where: { tenantId: world.tenantId },
      });
      await setup.receipt.deleteMany({ where: { tenantId: world.tenantId } });
      await cleanupImportWorld(setup, prefix);
      await setup.$disconnect();
      await prisma.onModuleDestroy();
    });
    async function fixture(count = 26, ownerUserId = world.users.owner.id) {
      const tag = randomUUID();
      const ids = Array.from(
        { length: count },
        (_, i) => `${tag}-obs-${String(i).padStart(2, "0")}`,
      );
      const value = draft();
      value.lines[0].targets = [];
      value.lines[0].observationIds = [ids[0]];
      value.scope.observationIds = ids;
      const row = await seedSession(setup, world, {
        ownerUserId,
        revision: 8,
        draftJson: JSON.stringify(value),
        expiresAt: new Date("2026-10-13T15:00:00.000Z"),
      });
      const artifact = await setup.importArtifact.create({
        data: {
          tenantId: world.tenantId,
          ownerProjectId: world.projects.pessoal,
          documentSha256: createHash("sha256").update(tag).digest("hex"),
          verifiedBytes: 100,
          detectedFormat: "CSV",
          state: "EXTRACTED",
        },
      });
      const ref = await setup.importSessionArtifact.create({
        data: {
          tenantId: world.tenantId,
          ownerProjectId: world.projects.pessoal,
          sessionId: row.id,
          artifactId: artifact.id,
          position: 0,
          state: "ATTACHED",
          fileName: "facts.csv",
          declaredMime: "text/csv",
          declaredBytes: 100,
          reservedBytes: 100,
          verifiedAt: now,
        },
      });
      for (const [index, id] of ids.entries())
        await setup.importObservation.create({
          data: {
            id,
            tenantId: world.tenantId,
            ownerProjectId: world.projects.pessoal,
            artifactId: artifact.id,
            reference: `row-${index}`,
            evidenceJson: JSON.stringify({
              version: 1,
              reference: `row-${index}`,
              text: `Original ${index}`,
              amountMeaning: "INSTALLMENT_CHARGE",
              amountCents: index === 0 ? -123456 : 6984,
              installmentCount: 30,
              installmentIndex: index + 1,
              dataCompra: null,
              identity: {
                merchant: "Original",
                externalId: null,
                fitId: null,
                ordinal: index,
                fileContentHash: "a".repeat(32),
              },
            }),
          },
        });
      return { row, ids, ref, artifact, value };
    }
    async function candidates(ownerUserId = world.users.owner.id) {
      const f = await fixture(1, ownerUserId);
      const catalog = search();
      catalog.candidates = [];
      for (let i = 0; i < 26; i++) {
        const id = `${f.row.id}-expense-${String(i).padStart(2, "0")}`;
        await setup.expense.create({
          data: {
            id,
            tenantId: world.tenantId,
            projectId: world.projects.pessoal,
            tipoDespesa: "MATERIAL_CONSTRUCAO",
            titulo: `Candidate ${i}`,
            valor: 6984,
            valorTotal: 6984,
            quantidade: 1,
            formaPagamento: "A_VISTA",
            dataCompra: now,
          },
        });
        catalog.candidates.push({
          lineId: "line-create",
          kind: "EXPENSE",
          id,
          reason: "NATURAL_MATCH",
        });
      }
      await setup.importSession.update({
        where: { id: f.row.id },
        data: { searchJson: JSON.stringify(catalog) },
      });
      return { ...f, catalog };
    }
    it("reads all scoped original observations including those without editable lines, 25 then 1", async () => {
      const f = await fixture();
      const first = await page("getObservations", f.row.id);
      expect(first.items.map((item) => item.id)).toEqual(f.ids.slice(0, 25));
      expect(first.items[0]).toEqual({
        id: f.ids[0],
        attachmentId: f.ref.id,
        reference: "row-0",
        text: "Original 0",
        amountMeaning: "INSTALLMENT_CHARGE",
        amountCents: -123456,
        installmentCount: 30,
        installmentIndex: 1,
        dataCompra: null,
      });
      expect(first.nextCursor).toEqual(expect.any(String));
      expect(
        await page("getObservations", f.row.id, { cursor: first.nextCursor }),
      ).toEqual({
        items: [
          expect.objectContaining({ id: f.ids[25], text: "Original 25" }),
        ],
        nextCursor: null,
      });
      expect(
        events.some((event) => /executeRaw|create|update|delete/i.test(event)),
      ).toBe(false);
    });
    it("excludes out-of-scope and no-longer-attached observations without parsing their evidence", async () => {
      const f = await fixture(2);
      await setup.importObservation.update({
        where: { id: f.ids[1] },
        data: { evidenceJson: '{"private":"SENTINEL"}' },
      });
      f.value.scope.observationIds = [f.ids[0]];
      await setup.importSession.update({
        where: { id: f.row.id },
        data: { draftJson: JSON.stringify(f.value) },
      });
      expect(
        (await page("getObservations", f.row.id)).items.map((item) => item.id),
      ).toEqual([f.ids[0]]);
      await setup.importSessionArtifact.update({
        where: { id: f.ref.id },
        data: { state: "RELEASED" },
      });
      expect(await page("getObservations", f.row.id)).toEqual({
        items: [],
        nextCursor: null,
      });
    });
    it("sanitizes authorized evidence corruption but hides it behind current ownership and participant ACL", async () => {
      const f = await fixture(1);
      await setup.importObservation.update({
        where: { id: f.ids[0] },
        data: { evidenceJson: '{"private":"SENTINEL"}' },
      });
      await expect(page("getObservations", f.row.id)).rejects.toMatchObject({
        name: "ImportSessionCorruptStateError",
        field: "evidence_json",
        message: "import session state is corrupted",
      });
      await expect(
        page("getObservations", f.row.id, {}, auth(world.users.restricted)),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await setup.importSession.update({
        where: { id: f.row.id },
        data: {
          ownerUserId: world.users.restricted.id,
          draftJson: JSON.stringify({
            ...f.value,
            lines: [
              {
                ...f.value.lines[0],
                targets: [{ projectId: world.projects.casa, amountCents: 100 }],
              },
            ],
          }),
        },
      });
      await expect(
        page("getObservations", f.row.id, {}, auth(world.users.restricted)),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
    it.each(["CANCELLED", "EXPIRED"])(
      "does not inspect hidden %s evidence or search",
      async (state) => {
        const f = await fixture(1);
        await setup.importSession.update({
          where: { id: f.row.id },
          data: { state, searchJson: "{}" },
        });
        await setup.importObservation.update({
          where: { id: f.ids[0] },
          data: { evidenceJson: "{}" },
        });
        expect(await page("getObservations", f.row.id)).toEqual({
          items: [],
          nextCursor: null,
        });
        expect(
          await page("getCandidates", f.row.id, { lineId: "line-create" }),
        ).toEqual({ items: [], nextCursor: null });
      },
    );
    it("uses canonical KEEP compatibility for a real V2 remaining agenda, retaining PAGO and unknown cycles", async () => {
      const f = await candidates();
      const sourceId = f.catalog.candidates[0].id;
      const proof = {
        documentSha256: "a".repeat(64),
        reference: "read-fixture",
        actorUserId: world.users.owner.id,
        recordedAt: now.toISOString(),
      };
      const schedule: StoredAssistedSourceScheduleV2 = {
        version: 2,
        kind: "source",
        tenantId: world.tenantId,
        sourceExpenseId: sourceId,
        sourceProjectId: world.projects.pessoal,
        cardId: world.cards.pessoal,
        recordedByUserId: world.users.owner.id,
        recordedAt: now.toISOString(),
        provenance: {
          kind: "assisted-card",
          basis: "no-import-reference",
          originalExternalId: null,
          originalImportId: null,
          referenceCheck: "NO_REFERENCE",
          evidence: proof,
          reason: "Reader-only fixture",
        },
        occurrences: Array.from({ length: 9 }, (_, index) => ({
          index,
          parcela: `${index + 2}/10`,
          valor: 6984,
          data: new Date(Date.UTC(2026, 10 + index, 10))
            .toISOString()
            .slice(0, 10),
          invoiceDueMonth: null,
          amountEvidence: proof,
          cycleEvidence: null,
        })),
        projections: [],
        lastOperation: null,
      };
      const card = await setup.creditCard.findUniqueOrThrow({
        where: { id: world.cards.pessoal },
      });
      await setup.expense.update({
        where: { id: sourceId },
        data: {
          valor: 62856,
          valorTotal: 62856,
          formaPagamento: "PARCELADO",
          quantidadeParcela: 9,
          dataCompra: new Date("2026-10-05T00:00:00.000Z"),
          dataInicioParcela: new Date("2026-11-10T00:00:00.000Z"),
          cardLast4: card.last4,
          documentedSchedule: JSON.stringify(schedule),
        },
      });
      for (const occurrence of schedule.occurrences)
        await setup.cashFlowEntry.create({
          data: {
            id: `${sourceId}-cash-${occurrence.index}`,
            expenseId: sourceId,
            tenantId: world.tenantId,
            projectId: world.projects.pessoal,
            tipo: "DESPESA",
            categoria: "OUTROS",
            valor: occurrence.valor,
            parcela: occurrence.parcela,
            data: new Date(`${occurrence.data}T00:00:00.000Z`),
            invoiceDueMonth: null,
            formaPagamento: "CARTAO_CREDITO",
            status: occurrence.index === 0 ? "PAGO" : "PLANEJADO",
          },
        });
      f.value.lines[0] = {
        ...f.value.lines[0],
        amountMeaning: "INSTALLMENT_CHARGE",
        amountCents: 6984,
        installmentCount: 10,
        dataCompra: "2026-10-05",
        firstDueDate: "2026-11-10",
      };
      const raw = {
        version: 1,
        reference: "row-0",
        text: "Original 2/10",
        amountMeaning: "INSTALLMENT_CHARGE",
        amountCents: 6984,
        installmentCount: 10,
        installmentIndex: 2,
        dataCompra: "2026-10-05",
        identity: {
          merchant: "Original",
          externalId: null,
          fitId: null,
          ordinal: 0,
          fileContentHash: null,
        },
      };
      await setup.importObservation.update({
        where: { id: f.ids[0] },
        data: { evidenceJson: JSON.stringify(raw) },
      });
      f.catalog.candidates = [
        { ...f.catalog.candidates[0], reason: "INSTALLMENT_MATCH" },
      ];
      await setup.importSession.update({
        where: { id: f.row.id },
        data: {
          draftJson: JSON.stringify(f.value),
          searchJson: JSON.stringify(f.catalog),
        },
      });
      const before = await setup.expense.findUniqueOrThrow({
        where: { id: sourceId },
        include: { cashFlow: true },
      });
      const sessionBefore = await setup.importSession.findUniqueOrThrow({
        where: { id: f.row.id },
      });
      async function diagnosedCandidates(
        phase: string,
        expectedIdentity: {
          ordinal: number | null;
          effectiveDate: string | null;
          fitId: string | null;
        },
        compatibility: "COMPATIBLE" | "BLOCKED" | null,
      ) {
        const sourceBeforeRead = await setup.expense.findUniqueOrThrow({
          where: { id: sourceId },
          include: { cashFlow: true },
        });
        const sessionBeforeRead = await setup.importSession.findUniqueOrThrow({
          where: { id: f.row.id },
        });
        const keys = jest.spyOn(declarations, "importObservationDedupeKeys");
        const keep = jest.spyOn(cardIdentity, "checkCardImportKeep");
        try {
          const result = await page("getCandidates", f.row.id, {
            lineId: "line-create",
          });
          expect(
            await setup.expense.findUniqueOrThrow({
              where: { id: sourceId },
              include: { cashFlow: true },
            }),
          ).toEqual(sourceBeforeRead);
          expect(
            await setup.importSession.findUniqueOrThrow({
              where: { id: f.row.id },
            }),
          ).toEqual(sessionBeforeRead);
          const inputs = keys.mock.calls.map(([, observation]) => ({
            ordinal: observation.original.identity.ordinal,
            effectiveDate: observation.effective.dataCompra,
            fitId: observation.original.identity.fitId,
          }));
          expect(inputs).toEqual([expectedIdentity]);
          if (compatibility === null) {
            expect(keys.mock.results).toEqual([
              { type: "return", value: null },
            ]);
            expect(keep).not.toHaveBeenCalled();
          } else {
            expect(keys).toHaveReturnedWith(
              expect.objectContaining({
                externalId: expect.any(String),
                strong: null,
                natural: expect.any(String),
              }),
            );
            expect(keep).toHaveBeenCalledTimes(1);
            expect(keep).toHaveReturnedWith(
              expect.objectContaining({ kind: compatibility }),
            );
          }
          console.info("SEARCH_KEEP_DIAGNOSTIC", {
            phase,
            inputs,
            keysAvailable: keys.mock.results.map(
              (result) => result.type === "return" && result.value !== null,
            ),
            canonicalKeepCalls: keep.mock.calls.length,
            canonicalKeepResults: keep.mock.results.map((result) =>
              result.type === "return" ? result.value.kind : result.type,
            ),
            canKeepExisting: result.items[0]?.canKeepExisting,
            sourceCashFlowAndSessionUnchanged: true,
          });
          return result;
        } finally {
          keys.mockRestore();
          keep.mockRestore();
        }
      }
      const originalIdentity = {
        ordinal: 0,
        effectiveDate: "2026-10-05",
        fitId: null,
      };
      expect(
        (
          await diagnosedCandidates(
            "valid-original-identity",
            originalIdentity,
            "COMPATIBLE",
          )
        ).items,
      ).toEqual([
        expect.objectContaining({
          id: sourceId,
          amountCents: 62856,
          canKeepExisting: true,
        }),
      ]);
      expect(
        await setup.expense.findUniqueOrThrow({
          where: { id: sourceId },
          include: { cashFlow: true },
        }),
      ).toEqual(before);
      expect(
        await setup.importSession.findUniqueOrThrow({
          where: { id: f.row.id },
        }),
      ).toEqual(sessionBefore);
      for (const { phase, dataCompra, ordinal, fitId } of [
        {
          phase: "date-missing-ordinal-valid",
          dataCompra: null,
          ordinal: 0,
          fitId: null,
        },
        {
          phase: "ordinal-missing-date-valid",
          dataCompra: "2026-10-05",
          ordinal: null,
          fitId: null,
        },
        {
          phase: "ordinal-missing-with-fitid-and-valid-date",
          dataCompra: "2026-10-05",
          ordinal: null,
          fitId: "statement-occurrence-fitid",
        },
      ]) {
        await setup.importObservation.update({
          where: { id: f.ids[0] },
          data: {
            evidenceJson: JSON.stringify({
              ...raw,
              dataCompra,
              identity: { ...raw.identity, ordinal, fitId },
            }),
          },
        });
        expect(
          (
            await diagnosedCandidates(
              phase,
              { ordinal, effectiveDate: dataCompra, fitId },
              null,
            )
          ).items[0],
        ).toMatchObject({ canKeepExisting: false });
      }
      await setup.importObservation.update({
        where: { id: f.ids[0] },
        data: { evidenceJson: JSON.stringify(raw) },
      });
      expect(
        await setup.importObservation.findUniqueOrThrow({
          where: { id: f.ids[0] },
        }),
      ).toMatchObject({ evidenceJson: JSON.stringify(raw) });
      await setup.cashFlowEntry.update({
        where: { id: `${sourceId}-cash-0` },
        data: { valor: 6985 },
      });
      expect(
        (
          await diagnosedCandidates(
            "cash-flow-drift-with-restored-original-identity",
            originalIdentity,
            "BLOCKED",
          )
        ).items[0],
      ).toMatchObject({ canKeepExisting: false });
    });

    it.each(["rateio", "forward-mirror", "reverse-mirror"] as const)(
      "hides a candidate with a current inaccessible %s participant before its corrupt schedule",
      async (relation) => {
        const f = await candidates(world.users.restricted.id);
        const sourceId = f.catalog.candidates[0].id;
        const target = await setup.expense.create({
          data: {
            tenantId: world.tenantId,
            projectId: world.projects.casa,
            tipoDespesa: "MATERIAL_CONSTRUCAO",
            valor: 6984,
            valorTotal: 6984,
            formaPagamento: "A_VISTA",
            ...(relation === "reverse-mirror"
              ? { linkedExpenseId: sourceId }
              : {}),
          },
        });
        await setup.expense.update({
          where: { id: sourceId },
          data: {
            documentedSchedule: '{"private":"SCHEDULE_SENTINEL"}',
            ...(relation === "forward-mirror"
              ? { linkedExpenseId: target.id }
              : {}),
          },
        });
        if (relation === "rateio")
          await setup.rateioAllocation.create({
            data: {
              tenantId: world.tenantId,
              sourceExpenseId: sourceId,
              targetExpenseId: target.id,
              allocation: 6984,
              plannedStatus: "PLANEJADO",
            },
          });
        const result = await page(
          "getCandidates",
          f.row.id,
          { lineId: "line-create" },
          auth(world.users.restricted),
        );
        expect(result.items.map((item) => item.id)).toEqual(
          f.catalog.candidates.slice(1).map((item) => item.id),
        );
        expect(result.nextCursor).toBeNull();
      },
    );

    it("hydrates a valid non-null complete search and returns candidate 26 on the second page", async () => {
      const f = await candidates();
      expect(await service.getSession(auth(), f.row.id)).toMatchObject({
        searchComplete: true,
      });
      const first = await page("getCandidates", f.row.id, {
        lineId: "line-create",
      });
      expect(first.items).toHaveLength(25);
      expect(first.items[0]).toEqual({
        lineId: "line-create",
        kind: "EXPENSE",
        id: f.catalog.candidates[0].id,
        projectId: world.projects.pessoal,
        description: "Candidate 0",
        amountCents: 6984,
        date: "2026-10-06",
        reason: "NATURAL_MATCH",
        canKeepExisting: false,
      });
      expect(
        await page("getCandidates", f.row.id, {
          lineId: "line-create",
          cursor: first.nextCursor,
        }),
      ).toEqual({
        items: [expect.objectContaining({ id: f.catalog.candidates[25].id })],
        nextCursor: null,
      });
    });
    it("keeps Expense/Receipt namespaces distinct and never makes Receipt a KEEP choice", async () => {
      const f = await candidates();
      const id = f.catalog.candidates[0].id;
      await setup.receipt.create({
        data: {
          id,
          tenantId: world.tenantId,
          projectId: world.projects.pessoal,
          valor: 19,
          data: now,
          tipo: "OUTROS",
          descricao: "Receipt",
        },
      });
      f.catalog.candidates = [
        f.catalog.candidates[0],
        {
          lineId: "line-create",
          kind: "RECEIPT",
          id,
          reason: "STRONG_IDENTITY",
        },
      ];
      await setup.importSession.update({
        where: { id: f.row.id },
        data: { searchJson: JSON.stringify(f.catalog) },
      });
      expect(
        (await page("getCandidates", f.row.id, { lineId: "line-create" }))
          .items,
      ).toEqual([
        expect.objectContaining({ kind: "EXPENSE", id }),
        expect.objectContaining({
          kind: "RECEIPT",
          id,
          amountCents: 19,
          canKeepExisting: false,
        }),
      ]);
    });
    it.each([
      "module-revoked",
      "missing",
      "deleted",
      "project-inaccessible",
    ] as const)(
      "keeps Receipt %s opaque while preserving the visible Expense with the same id",
      async (hidden) => {
        const f = await candidates(world.users.restricted.id);
        const id = f.catalog.candidates[0].id;
        const user = await setup.user.findUniqueOrThrow({
          where: { id: world.users.restricted.id },
        });
        await setup.user.update({
          where: { id: user.id },
          data: {
            allowedModules: JSON.stringify([
              "creditCards",
              "expenses",
              "receipts",
            ]),
          },
        });
        try {
          await setup.receipt.create({
            data: {
              id,
              tenantId: world.tenantId,
              projectId: world.projects.pessoal,
              valor: 123456,
              data: now,
              tipo: "OUTROS",
              descricao: "PRIVATE_RECEIPT_MODULE_SENTINEL",
            },
          });
          f.catalog.candidates = [
            f.catalog.candidates[0],
            {
              lineId: "line-create",
              kind: "RECEIPT",
              id,
              reason: "NATURAL_MATCH",
            },
          ];
          await setup.importSession.update({
            where: { id: f.row.id },
            data: { searchJson: JSON.stringify(f.catalog) },
          });
          const context = auth(world.users.restricted);
          const query = { lineId: "line-create" };
          const expense = {
            lineId: "line-create",
            kind: "EXPENSE",
            id,
            projectId: world.projects.pessoal,
            description: "Candidate 0",
            amountCents: 6984,
            date: "2026-10-06",
            reason: "NATURAL_MATCH",
            canKeepExisting: false,
          };
          expect(await page("getCandidates", f.row.id, query, context)).toEqual(
            {
              items: [
                expense,
                {
                  lineId: "line-create",
                  kind: "RECEIPT",
                  id,
                  projectId: world.projects.pessoal,
                  description: "PRIVATE_RECEIPT_MODULE_SENTINEL",
                  amountCents: 123456,
                  date: "2026-10-06",
                  reason: "NATURAL_MATCH",
                  canKeepExisting: false,
                },
              ],
              nextCursor: null,
            },
          );
          if (hidden === "module-revoked") {
            await setup.user.update({
              where: { id: user.id },
              data: {
                allowedModules: JSON.stringify(["creditCards", "expenses"]),
              },
            });
          } else if (hidden === "missing") {
            await setup.receipt.delete({ where: { id } });
          } else {
            await setup.receipt.update({
              where: { id },
              data:
                hidden === "deleted"
                  ? { deletedAt: now }
                  : { projectId: world.projects.casa },
            });
          }
          expect(await page("getCandidates", f.row.id, query, context)).toEqual(
            {
              items: [expense],
              nextCursor: null,
            },
          );
        } finally {
          await setup.user.update({
            where: { id: user.id },
            data: { allowedModules: user.allowedModules },
          });
        }
      },
    );
    it("filters inaccessible or deleted current candidates before pagination, without hidden counts", async () => {
      const f = await candidates(world.users.restricted.id);
      await setup.expense.update({
        where: { id: f.catalog.candidates[0].id },
        data: { projectId: world.projects.casa },
      });
      await setup.expense.update({
        where: { id: f.catalog.candidates[1].id },
        data: { deletedAt: now },
      });
      const result = await page(
        "getCandidates",
        f.row.id,
        { lineId: "line-create" },
        auth(world.users.restricted),
      );
      expect(result.items.map((item) => item.id)).toEqual(
        f.catalog.candidates.slice(2).map((item) => item.id),
      );
      expect(Object.keys(result).sort()).toEqual(["items", "nextCursor"]);
      expect(result.nextCursor).toBeNull();
    });

    it("does not expose stale candidates after the line loses its current attachment", async () => {
      const f = await candidates();
      await setup.importSessionArtifact.update({
        where: { id: f.ref.id },
        data: { state: "RELEASED" },
      });
      await expect(
        page("getCandidates", f.row.id, { lineId: "line-create" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
    it.each(["getObservations", "getCandidates"] as const)(
      "binds %s cursor to session and revision",
      async (kind) => {
        const f = await candidates();
        // Observations need a second page as well, not a synthetic cursor fixture.
        const observed = kind === "getObservations" ? await fixture() : f;
        const query = kind === "getCandidates" ? { lineId: "line-create" } : {};
        const first = await page(kind, observed.row.id, query);
        expect(first.nextCursor).toEqual(expect.any(String));
        const other = await fixture();
        await expect(
          page(kind, other.row.id, { ...query, cursor: first.nextCursor }),
        ).rejects.toMatchObject({ code: "INVALID_INPUT" });
        await setup.importSession.update({
          where: { id: observed.row.id },
          data: { revision: 9 },
        });
        if (kind === "getCandidates") {
          const updated = { ...f.catalog, revision: 9 };
          await setup.importSession.update({
            where: { id: observed.row.id },
            data: { searchJson: JSON.stringify(updated) },
          });
        }
        await expect(
          page(kind, observed.row.id, { ...query, cursor: first.nextCursor }),
        ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      },
    );
    it("rejects tampered/expired cursors and out-of-scope lines without accepting caller-owned scope", async () => {
      const f = await candidates();
      const query = { lineId: "line-create" };
      const first = await page("getCandidates", f.row.id, query);
      await expect(
        page("getCandidates", f.row.id, {
          ...query,
          cursor: `${first.nextCursor}A`,
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(
        page("getCandidates", f.row.id, { lineId: "foreign" }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(
        page("getObservations", f.row.id, { tenantId: world.tenantId }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      clock.current = new Date(now.getTime() + 900_000);
      await expect(
        page("getCandidates", f.row.id, { ...query, cursor: first.nextCursor }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    });

    it("binds cursors to the actor, collection and selected line rather than accepting another valid signature", async () => {
      const f = await candidates();
      const first = await page("getCandidates", f.row.id, {
        lineId: "line-create",
      });
      await expect(
        page("getObservations", f.row.id, { cursor: first.nextCursor }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await setup.importSession.update({
        where: { id: f.row.id },
        data: { ownerUserId: world.users.restricted.id },
      });
      await expect(
        page(
          "getCandidates",
          f.row.id,
          { lineId: "line-create", cursor: first.nextCursor },
          auth(world.users.restricted),
        ),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await setup.importSession.update({
        where: { id: f.row.id },
        data: { ownerUserId: world.users.owner.id },
      });
      const original = f.value.lines[0];
      f.value.lines.push({
        ...original,
        id: "second-line",
        observationIds: [],
      });
      // A second selected line must have a distinct, genuinely scoped observation.
      const second = await setup.importObservation.create({
        data: {
          tenantId: world.tenantId,
          ownerProjectId: world.projects.pessoal,
          artifactId: f.artifact.id,
          reference: "second",
          evidenceJson: JSON.stringify({
            ...JSON.parse(
              (
                await setup.importObservation.findUniqueOrThrow({
                  where: { id: f.ids[0] },
                })
              ).evidenceJson,
            ),
            reference: "second",
          }),
        },
      });
      f.value.lines[1].observationIds = [second.id];
      f.value.scope.observationIds.push(second.id);
      f.value.selectedLineIds.push("second-line");
      f.catalog.coverage.steps.push(
        ...search().coverage.steps.map((step) => ({
          ...step,
          lineId: "second-line",
        })),
      );
      f.catalog.candidates.push({
        ...f.catalog.candidates[0],
        lineId: "second-line",
      });
      await setup.importSession.update({
        where: { id: f.row.id },
        data: {
          draftJson: JSON.stringify(f.value),
          searchJson: JSON.stringify(f.catalog),
        },
      });
      const refreshed = await page("getCandidates", f.row.id, {
        lineId: "line-create",
      });
      await expect(
        page("getCandidates", f.row.id, {
          lineId: "second-line",
          cursor: refreshed.nextCursor,
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    });

    it("rechecks current auth and card access on every read, including requests carrying a valid cursor", async () => {
      const f = await fixture();
      const first = await page("getObservations", f.row.id);
      await setup.user.update({
        where: { id: world.users.owner.id },
        data: { sessionVersion: { increment: 1 } },
      });
      try {
        await expect(
          page("getObservations", f.row.id, { cursor: first.nextCursor }),
        ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      } finally {
        await setup.user.update({
          where: { id: world.users.owner.id },
          data: { sessionVersion: world.users.owner.sessionVersion },
        });
      }
      await setup.creditCard.update({
        where: { id: world.cards.pessoal },
        data: { deletedAt: now },
      });
      try {
        await expect(
          page("getObservations", f.row.id, { cursor: first.nextCursor }),
        ).rejects.toMatchObject({ code: "NOT_FOUND" });
      } finally {
        await setup.creditCard.update({
          where: { id: world.cards.pessoal },
          data: { deletedAt: null },
        });
      }
    });

    it("rechecks the active bound card before observation or candidate cursor parsing", async () => {
      const observed = await fixture();
      const searched = await candidates();
      const observationCursor = (await page("getObservations", observed.row.id))
        .nextCursor;
      const candidateCursor = (
        await page("getCandidates", searched.row.id, {
          lineId: "line-create",
        })
      ).nextCursor;
      expect([observationCursor, candidateCursor]).toEqual([
        expect.any(String),
        expect.any(String),
      ]);

      await setup.creditCard.update({
        where: { id: world.cards.pessoal },
        data: { deletedAt: now },
      });
      try {
        const outcomes = await Promise.all(
          [
            () =>
              page("getObservations", observed.row.id, {
                cursor: observationCursor,
              }),
            () =>
              page("getCandidates", searched.row.id, {
                lineId: "line-create",
                cursor: candidateCursor,
              }),
          ].map(async (run) => {
            try {
              await run();
              return "RESOLVED";
            } catch (error) {
              return (error as { code?: string }).code ?? "REJECTED";
            }
          }),
        );
        expect(outcomes).toEqual(["NOT_FOUND", "NOT_FOUND"]);
      } finally {
        await setup.creditCard.update({
          where: { id: world.cards.pessoal },
          data: { deletedAt: null },
        });
      }
    });

    it("authorizes every APPLIED receipt participant before observation or candidate parsing", async () => {
      const observed = await fixture(26, world.users.restricted.id);
      const searched = await candidates(world.users.restricted.id);
      const restricted = auth(world.users.restricted);
      const observationCursor = (
        await page("getObservations", observed.row.id, {}, restricted)
      ).nextCursor;
      const candidateCursor = (
        await page(
          "getCandidates",
          searched.row.id,
          { lineId: "line-create" },
          restricted,
        )
      ).nextCursor;
      expect([observationCursor, candidateCursor]).toEqual([
        expect.any(String),
        expect.any(String),
      ]);

      for (const row of [observed.row, searched.row]) {
        const receipt = VALID_RECEIPT(
          row.id,
          [`${row.id}-historical-expense`],
          [world.projects.pessoal, world.projects.casa],
        );
        receipt.financialRequestId = randomUUID();
        receipt.snapshot.lines[0]!.totalCents = 100.5;
        await setup.importSession.update({
          where: { id: row.id },
          data: {
            state: "APPLIED",
            financialRequestId: receipt.financialRequestId,
            confirmedRevision: receipt.confirmedRevision,
            confirmedSessionVersion: 0,
            confirmedAt: now,
            proposalHash: receipt.proposalHash,
            receiptJson: JSON.stringify(receipt),
            closedAt: now,
          },
        });
      }

      const outcomes = await Promise.all(
        [
          () =>
            page(
              "getObservations",
              observed.row.id,
              { cursor: observationCursor },
              restricted,
            ),
          () =>
            page(
              "getCandidates",
              searched.row.id,
              { lineId: "line-create", cursor: candidateCursor },
              restricted,
            ),
        ].map(async (run) => {
          try {
            await run();
            return "RESOLVED";
          } catch (error) {
            return error instanceof ImportSessionCorruptStateError
              ? "CORRUPT_RECEIPT"
              : ((error as { code?: string }).code ?? "REJECTED");
          }
        }),
      );
      expect(outcomes).toEqual(["NOT_FOUND", "NOT_FOUND"]);

      await setup.user.update({
        where: { id: world.users.restricted.id },
        data: {
          allowedProjects: JSON.stringify([
            world.projects.pessoal,
            world.projects.casa,
          ]),
        },
      });
      try {
        await expect(
          page(
            "getObservations",
            observed.row.id,
            { cursor: observationCursor },
            restricted,
          ),
        ).rejects.toBeInstanceOf(ImportSessionCorruptStateError);
        await expect(
          page(
            "getCandidates",
            searched.row.id,
            { lineId: "line-create", cursor: candidateCursor },
            restricted,
          ),
        ).rejects.toBeInstanceOf(ImportSessionCorruptStateError);
      } finally {
        await setup.user.update({
          where: { id: world.users.restricted.id },
          data: {
            allowedProjects: JSON.stringify([world.projects.pessoal]),
          },
        });
      }
    });
  });
  it("hidden draft participant and nonexistent session have byte-identical 404s before corrupt search", async () => {
    const row = await seedSession(setup, world, {
      ownerUserId: world.users.restricted.id,
      draftJson: JSON.stringify(validationDraft(world.projects.casa)),
      searchJson: '{"private":"SEARCH_SENTINEL"}',
      expiresAt: new Date("2026-10-13T15:00:00.000Z"),
    });
    const capture = async (id: string): Promise<string> => {
      try {
        await service.getSession(auth(world.users.restricted), id);
      } catch (error) {
        expect(error).toBeInstanceOf(ImportSessionError);
        if (!(error instanceof ImportSessionError)) throw error;
        expect(error.code).toBe("NOT_FOUND");
        return JSON.stringify(importSessionWire(error));
      }
      throw new Error("Expected an opaque NOT_FOUND");
    };
    expect(await capture(row.id)).toBe(await capture("nonexistent-session"));
  });
});

describe("S collection cursor protocol", () => {
  const now = new Date("2026-10-06T15:00:00.000Z");
  const key = deriveCursorKey({
    NODE_ENV: "test",
    JWT_SECRET: "test-page-cursor-key-not-a-credential",
  });
  const binding: ImportPageCursorBinding = {
    tenantId: "tenant",
    userId: "owner",
    sessionId: "session",
    revision: 8,
    collection: "CANDIDATES",
    lineId: "line",
    queryHash: "a".repeat(64),
  };
  const position = { kind: "EXPENSE" as const, id: "e".repeat(191) };
  it("round-trips the longest allowed entity id; page cursors remain distinct from recovery-list cursors", () => {
    const cursor = signPageCursor(key, binding, position, now);
    expect(verifyPageCursor(key, binding, cursor, now)).toEqual(position);
    const list = signListCursor(
      key,
      { tenantId: "tenant", userId: "owner", filter: "active" },
      { sortAtMs: 1, id: "expense" },
      now,
    );
    expect(() => verifyPageCursor(key, binding, list, now)).toThrow(
      ImportSessionError,
    );
  });
  it.each([
    { tenantId: "other" },
    { userId: "other" },
    { sessionId: "other" },
    { revision: 9 },
    { lineId: "other" },
    { queryHash: "b".repeat(64) },
    { collection: "OBSERVATIONS" as const, lineId: null },
  ])("rejects a valid token in another binding %p", (change) => {
    const cursor = signPageCursor(key, binding, position, now);
    expect(() =>
      verifyPageCursor(key, { ...binding, ...change }, cursor, now),
    ).toThrow(ImportSessionError);
  });
  it("accepts age 899999ms but rejects exactly 900000ms and a future issue time", () => {
    const cursor = signPageCursor(key, binding, position, now);
    expect(
      verifyPageCursor(key, binding, cursor, new Date(now.getTime() + 899999)),
    ).toEqual(position);
    for (const offset of [-1, 900000]) {
      expect(() =>
        verifyPageCursor(
          key,
          binding,
          cursor,
          new Date(now.getTime() + offset),
        ),
      ).toThrow(ImportSessionError);
    }
  });
});
