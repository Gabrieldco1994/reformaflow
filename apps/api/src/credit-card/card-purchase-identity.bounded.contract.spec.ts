require("../../../../scripts/test-db-env.cjs");

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Prisma } from "@prisma/client";
import { PrismaService, INCLUDE_SOFT_DELETED } from "../prisma/prisma.service";
import {
  buildStoredExpenseInstallments,
  parseStoredExpenseSchedule,
  toPublicExpenseSchedule,
} from "../expense/documented-schedule";
import type {
  StoredSourceSchedule,
  StoredProjectionScheduleV1,
} from "../expense/documented-schedule.types";
import {
  buildSeriesKey,
  classifyCardImport,
  type PurchaseIdentity as Purchase,
  type CardImportFacts as Facts,
  type CardImportEnumeration as Enumeration,
  type KeepLineFacts as Line,
  type KeepObservationFacts as Observation,
  type CardKeepCompatibility as Compatibility,
  inspectCardImportInTx,
  checkCardImportKeep,
  inspectCardPurchaseCompanions,
  hasUnknownCardOccurrenceFacts,
} from "./card-purchase-identity";

interface Helpers {
  inspectCardImportInTx: (
    tx: Prisma.TransactionClient,
    tenantId: string,
    purchase: Purchase,
    remaining: number,
    isSibling?: (externalId: string) => boolean,
  ) => Promise<Enumeration>;
  checkCardImportKeep: (
    tenantId: string,
    purchase: Purchase,
    facts: Facts,
    rootExpenseId: string,
    line: Line,
    observations: readonly Observation[],
  ) => Compatibility;
}
function load<K extends keyof Helpers>(name: K): Helpers[K] {
  const exports = {
    inspectCardImportInTx,
    checkCardImportKeep,
  } satisfies Helpers;
  expect({ export: name, type: typeof exports[name] }).toEqual({
    export: name,
    type: "function",
  });
  const fn = exports[name];
  if (!fn) throw new Error("Export assertion failed");
  return fn;
}

interface Read {
  model: string | undefined;
  action: string;
  args: Record<string, unknown>;
  ids: string[];
}
const NOW = new Date("2026-10-01T12:00:00.000Z");
const PURCHASE_DAY = new Date("2026-01-02T00:00:00.000Z");
const MONTHS = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10"];
const LINE: Line = {
  amountMeaning: "TOTAL_PURCHASE",
  amountCents: 69840,
  installmentCount: 10,
  dataCompra: "2026-01-02",
  firstDueDate: "2026-01-10",
};
const OBSERVATION: Observation = {
  id: "observation-2",
  amountMeaning: "INSTALLMENT_CHARGE",
  amountCents: 6984,
  installmentCount: 10,
  installmentIndex: 2,
  dataCompra: "2026-01-02",
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected instrumented record");
  return Object.fromEntries(Object.entries(value));
}
function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
}

describe("canonical bounded card inspection and pure KEEP (#701)", () => {
  const db = new PrismaService();
  let sequence = 0;
  let tenantId: string;
  let projectId: string;
  let otherProject: string;
  let cardId: string;
  let importId: string;
  let reads: Read[] = [];
  let capturing = false;
  let allowance = 0;
  let reached: string[];
  let attempts: string[];
  let runs: { remaining: number; attempts: string[]; reads: Read[] }[];
  let keepSnapshots: string[];

  db.$use(async (params, next) => {
    if (!capturing) return next(params);
    attempts.push(`${params.model}:${params.action}`);
    expect(["findMany", "findUnique", "findFirst"]).toContain(params.action);
    const args = object(params.args);
    const visited = reads.reduce((sum, read) => sum + read.ids.length, 0);
    expect(visited).toBeLessThanOrEqual(allowance);
    if (params.action === "findMany") {
      expect(Number.isSafeInteger(args.take)).toBe(true);
      expect(Number(args.take)).toBeGreaterThan(0);
      expect(Number(args.take)).toBeLessThanOrEqual(allowance - visited + 1);
      expect(args.orderBy).toBeDefined();
    }
    for (const key of ["include", "select"]) {
      if (args[key]) expect(object(args[key]).cashFlow).toBeUndefined();
    }
    if (params.model === "CashFlowEntry")
      expect(object(args.where).expenseId).not.toBeNull();
    const result: unknown = await next(params);
    const rows: unknown[] = Array.isArray(result)
      ? result
      : result === null
        ? []
        : [result];
    const ids = rows.map((row) => {
      const record = object(row);
      // The scalar cohort/card projection still materializes a physical record.
      for (const child of Object.values(record))
        expect(Array.isArray(child)).toBe(false);
      return typeof record.id === "string" ? record.id : "<scalar-record>";
    });
    reads.push({ model: params.model, action: params.action, args, ids });
    return result;
  });

  beforeAll(() => db.$connect());
  afterAll(() => db.$disconnect());
  beforeEach(async () => {
    sequence += 1;
    tenantId = `bounded-card-${sequence}`;
    projectId = `${tenantId}-p1`;
    otherProject = `${tenantId}-p2`;
    cardId = `${tenantId}-card`;
    importId = `${tenantId}-import`;
    reads = [];
    reached = [];
    attempts = [];
    runs = [];
    keepSnapshots = [];
    await db.tenant.create({
      data: { id: tenantId, name: "Synthetic card QA" },
    });
    await db.project.createMany({
      data: [projectId, otherProject].map((id) => ({
        id,
        tenantId,
        type: "PESSOAL",
        name: "Synthetic",
      })),
    });
    await db.creditCard.create({
      data: {
        id: cardId,
        tenantId,
        projectId,
        institution: "ITAU",
        brand: "Visa",
        nickname: "Synthetic",
        last4: "1234",
      },
    });
    await db.creditCardStatementImport.create({
      data: {
        id: importId,
        tenantId,
        cardId,
        periodLabel: "2026-01",
        source: "OFX",
      },
    });
  });
  afterEach(() => {
    const evidence = process.env.CANONICAL_QA_EVIDENCE_DIR;
    if (evidence)
      writeFileSync(
        join(evidence, `card-${sequence}.json`),
        JSON.stringify(
          {
            test: expect.getState().currentTestName,
            reached,
            attempts,
            runs,
            reads,
            keepSnapshots,
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
  });

  function purchase(patch: Partial<Purchase> = {}): Purchase {
    return {
      cardId,
      projectId,
      merchant: "QA LOJA",
      total: 10,
      seriesKey: buildSeriesKey(cardId, "QA LOJA", 7000, 10),
      externalId: "incoming-ext",
      dedupeKeyStrong: "incoming-strong",
      ...patch,
    };
  }

  async function root(
    name = "root",
    patch: Partial<Prisma.ExpenseCreateManyInput> = {},
  ) {
    return db.expense.create({
      data: {
        id: `${tenantId}-${name}`,
        tenantId,
        projectId,
        tipoDespesa: "OUTROS",
        titulo: "QA LOJA",
        fornecedor: "QA LOJA",
        valor: 69840,
        valorTotal: 69840,
        quantidade: 1,
        formaPagamento: "PARCELADO",
        quantidadeParcela: 10,
        dataCompra: PURCHASE_DAY,
        dataInicioParcela: new Date("2026-01-10T00:00:00.000Z"),
        status: "PLANEJADO",
        origin: "import",
        importId,
        externalId: `${name}-ext`,
        seriesKey: buildSeriesKey(cardId, "QA LOJA", 6984, 10),
        cardLast4: "1234",
        createdAt: NOW,
        updatedAt: NOW,
        ...patch,
      },
    });
  }
  async function cash(
    expenseId: string | null,
    name = "cash",
    patch: Partial<Prisma.CashFlowEntryCreateManyInput> = {},
  ) {
    return db.cashFlowEntry.create({
      data: {
        id: `${tenantId}-${name}`,
        tenantId,
        projectId,
        expenseId,
        tipo: "DESPESA",
        categoria: "OUTROS",
        valor: 6984,
        parcela: "2/10",
        data: new Date("2026-02-10T00:00:00.000Z"),
        invoiceDueMonth: null,
        formaPagamento: "CARTAO_CREDITO",
        status: "PLANEJADO",
        createdAt: NOW,
        updatedAt: NOW,
        ...patch,
      },
    });
  }
  async function receipt(externalId: string, deletedAt: Date | null = null) {
    return db.receipt.create({
      data: {
        id: `${tenantId}-receipt`,
        tenantId,
        projectId: otherProject,
        tipo: "OUTROS",
        valor: 6984,
        data: PURCHASE_DAY,
        externalId,
        deletedAt,
        createdAt: NOW,
        updatedAt: NOW,
      },
    });
  }

  async function inspect(
    remaining: number,
    identity = purchase(),
    sibling?: (id: string) => boolean,
  ) {
    const fn = load("inspectCardImportInTx");
    reads = [];
    attempts = [];
    allowance = remaining;
    capturing = true;
    reached.push("inspectCardImportInTx");
    try {
      const result = await db.$transaction((tx) =>
        fn(tx, tenantId, identity, remaining, sibling),
      );
      expect(result.visitedRows).toBe(
        reads.reduce((sum, read) => sum + read.ids.length, 0),
      );
      return result;
    } finally {
      runs.push({ remaining, attempts: [...attempts], reads: [...reads] });
      capturing = false;
    }
  }

  async function facts(): Promise<Facts> {
    const companions = await db.expense.findMany({
      where: { tenantId, deletedAt: INCLUDE_SOFT_DELETED },
      orderBy: { id: "asc" },
      include: {
        cashFlow: {
          where: { tenantId, deletedAt: null },
          orderBy: { id: "asc" },
        },
        _count: {
          select: { cashFlow: { where: { tenantId: { not: tenantId } } } },
        },
      },
    });
    return {
      companions,
      receipts: await db.receipt.findMany({
        where: { tenantId, deletedAt: INCLUDE_SOFT_DELETED },
      }),
      imports: await db.creditCardStatementImport.findMany({
        where: { tenantId, deletedAt: INCLUDE_SOFT_DELETED },
      }),
      cards: await db.creditCard.findMany({
        where: { tenantId, deletedAt: INCLUDE_SOFT_DELETED },
      }),
    };
  }

  async function scheduled(version: 1 | 2, partial = false, name = "source") {
    const sourceId = `${tenantId}-${name}`;
    const proof = {
      documentSha256: "a".repeat(64),
      reference: "synthetic-invoice",
      actorUserId: "qa-author",
      recordedAt: NOW.toISOString(),
    };
    const base = {
      kind: "source" as const,
      tenantId,
      sourceExpenseId: sourceId,
      sourceProjectId: projectId,
      cardId,
      recordedByUserId: "qa-author",
      recordedAt: NOW.toISOString(),
      occurrences: MONTHS.slice(partial ? 1 : 0).map((month, index) => ({
        index,
        parcela: `${Number(month)}/10`,
        valor: 6984,
        data: `2026-${month}-10`,
        invoiceDueMonth: `2026-${month}`,
        amountEvidence: proof,
        cycleEvidence: proof,
      })),
      projections: [],
      lastOperation: null,
    };
    const schedule: StoredSourceSchedule =
      version === 1
        ? { ...base, version: 1, importId, externalId: `${name}-ext` }
        : {
            ...base,
            version: 2,
            provenance: {
              kind: "assisted-card",
              basis: "no-import-reference",
              originalExternalId: null,
              originalImportId: null,
              referenceCheck: "NO_REFERENCE",
              evidence: proof,
              reason: "Synthetic fixture",
            },
          };
    const encoded = JSON.stringify(schedule);
    expect(parseStoredExpenseSchedule(encoded)).toEqual(schedule);
    const source = await root(name, {
      documentedSchedule: encoded,
      seriesKey: null,
      importId: version === 1 ? importId : null,
      externalId: version === 1 ? `${name}-ext` : null,
      quantidadeParcela: partial ? 9 : 10,
      valorTotal: partial ? 62856 : 69840,
      valor: partial ? 62856 : 69840,
      dataInicioParcela: new Date(partial ? "2026-02-10" : "2026-01-10"),
    });
    const installments = buildStoredExpenseInstallments(source);
    for (const item of installments)
      await cash(source.id, `${name}-cfe-${item.index}`, {
        parcela: item.parcela,
        valor: item.valor,
        data: item.data,
        invoiceDueMonth: item.invoiceDueMonth,
      });
    return { source, schedule, installments };
  }

  function keep(
    current: Facts,
    rootId: string,
    line = LINE,
    observations: readonly Observation[] = [OBSERVATION],
    identity = purchase({ seriesKey: null }),
  ) {
    const fn = load("checkCardImportKeep");
    const args = [
      tenantId,
      identity,
      current,
      rootId,
      line,
      observations,
    ] as const;
    const before = JSON.stringify(args);
    keepSnapshots.push(before);
    args.forEach(freeze);
    reads = [];
    attempts = [];
    allowance = 0;
    capturing = true;
    reached.push("checkCardImportKeep");
    try {
      const result = fn(...args);
      expect(result).not.toHaveProperty("then");
      expect(reads).toEqual([]);
      expect(attempts).toEqual([]);
      expect(JSON.stringify(args)).toBe(before);
      return result;
    } finally {
      capturing = false;
    }
  }

  it.each([
    "clear",
    "review",
    "same-series",
    "sibling",
    "strong",
    "tombstone",
    "different-total",
    "native-v2",
  ] as const)(
    "bounded admission preserves the real legacy %s decision",
    async (scenario) => {
      let identity = purchase();
      let expected = "BLOCKED";
      let sibling: ((id: string) => boolean) | undefined;
      if (scenario === "clear") expected = "CLEAR";
      else if (scenario === "native-v2") await scheduled(2);
      else {
        const source = await root("root", {
          ...(scenario === "same-series" || scenario === "sibling"
            ? { seriesKey: identity.seriesKey }
            : {}),
          ...(scenario === "strong" ? { externalId: identity.externalId } : {}),
          ...(scenario === "tombstone" ? { deletedAt: NOW } : {}),
          ...(scenario === "different-total"
            ? { seriesKey: buildSeriesKey(cardId, "QA LOJA", 6984, 12) }
            : {}),
        });
        await cash(source.id, "cash", {
          valor:
            scenario === "same-series" || scenario === "sibling" ? 7000 : 6984,
          parcela: scenario === "different-total" ? "2/12" : "2/10",
          status: "PAGO",
        });
        if (scenario === "review") expected = "REVIEW";
        if (scenario === "sibling") {
          expected = "CLEAR";
          sibling = (id) => id === "root-ext";
        }
        if (scenario === "different-total") expected = "CLEAR";
      }
      if (scenario === "native-v2") identity = purchase({ seriesKey: null });
      const legacy = await db.$transaction((tx) =>
        classifyCardImport(tx, tenantId, identity, sibling),
      );
      expect(legacy.kind).toBe(expected);
      const result = await inspect(100, identity, sibling);
      expect(result.kind).toBe("EXHAUSTED");
      if (result.kind !== "EXHAUSTED") throw new Error("Unexpected overflow");
      expect(result.admission).toEqual(legacy);
    },
  );

  it("strong closure crosses projects and includes strong-root imports and deleted Receipts", async () => {
    const family = await root();
    await cash(family.id);
    const strongImport = `${tenantId}-strong-import`;
    await db.creditCardStatementImport.create({
      data: {
        id: strongImport,
        tenantId,
        cardId,
        source: "CSV",
        periodLabel: "2026-02",
        deletedAt: NOW,
      },
    });
    const strong = await root("strong-root", {
      projectId: otherProject,
      importId: strongImport,
      externalId: "root-ext",
      titulo: "OTHER",
      fornecedor: "OTHER",
      seriesKey: null,
      cardLast4: null,
      deletedAt: NOW,
    });
    await cash(strong.id, "strong-cash", { projectId: otherProject });
    await receipt("root-ext", NOW);
    const result = await inspect(100);
    expect(result.kind).toBe("EXHAUSTED");
    if (result.kind !== "EXHAUSTED") throw new Error("Unexpected overflow");
    expect(result.admission).toEqual({ kind: "BLOCKED", sameSeries: false });
    expect(result.inspection.companions.map((row) => row.id).sort()).toEqual([
      `${tenantId}-root`,
      `${tenantId}-strong-root`,
    ]);
    expect(
      result.inspection.receipts.map((row) => [row.id, row.deletedAt]),
    ).toEqual([[`${tenantId}-receipt`, NOW]]);
    expect(result.inspection.imports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: importId,
          tenantId,
          cardId,
          deletedAt: null,
        }),
        expect.objectContaining({
          id: strongImport,
          tenantId,
          cardId,
          deletedAt: NOW,
        }),
      ]),
    );
    expect(result.inspection.cards).toEqual(
      expect.arrayContaining([
        { id: cardId, tenantId, projectId, last4: "1234", deletedAt: null },
      ]),
    );
  });

  it("foreign cash flow is only a scalar blocker, never hydrated; own deleted CFE stays excluded", async () => {
    const source = await root();
    await cash(source.id);
    await cash(source.id, "deleted-cash", { deletedAt: NOW });
    const foreignTenant = `${tenantId}-foreign`;
    const foreignProject = `${foreignTenant}-project`;
    await db.tenant.create({ data: { id: foreignTenant, name: "Foreign" } });
    await db.project.create({
      data: {
        id: foreignProject,
        tenantId: foreignTenant,
        type: "PESSOAL",
        name: "Foreign",
      },
    });
    for (let index = 0; index < 31; index++)
      await cash(source.id, `foreign-${index}`, {
        tenantId: foreignTenant,
        projectId: foreignProject,
      });
    const result = await inspect(100);
    expect(result.kind).toBe("EXHAUSTED");
    if (result.kind !== "EXHAUSTED") throw new Error("Unexpected overflow");
    expect(result.admission).toEqual({ kind: "BLOCKED", sameSeries: false });
    expect(result.inspection.companions[0]._count.cashFlow).toBe(31);
    expect(
      result.inspection.companions[0].cashFlow.map((row) => row.id),
    ).toEqual([`${tenantId}-cash`]);
    expect(
      reads
        .flatMap((read) => read.ids)
        .some((id) => id.includes("foreign-") || id.endsWith("deleted-cash")),
    ).toBe(false);
  });

  it("strong-only inspection loads the root import and excludes foreign tenant/deleted project rows", async () => {
    const foreignTenant = `${tenantId}-foreign`;
    const foreignProject = `${foreignTenant}-project`;
    const deletedProject = `${tenantId}-deleted-project`;
    await db.tenant.create({ data: { id: foreignTenant, name: "Foreign" } });
    await db.project.createMany({
      data: [
        {
          id: foreignProject,
          tenantId: foreignTenant,
          type: "PESSOAL",
          name: "Foreign",
        },
        {
          id: deletedProject,
          tenantId,
          type: "PESSOAL",
          name: "Deleted",
          deletedAt: NOW,
        },
      ],
    });
    await root("own-strong", {
      projectId: otherProject,
      externalId: "incoming-ext",
    });
    await root("foreign-strong", {
      tenantId: foreignTenant,
      projectId: foreignProject,
      externalId: "incoming-ext",
    });
    await root("deleted-project-strong", {
      projectId: deletedProject,
      externalId: "incoming-ext",
    });
    await db.receipt.create({
      data: {
        id: `${tenantId}-foreign-receipt`,
        tenantId: foreignTenant,
        projectId: foreignProject,
        tipo: "OUTROS",
        valor: 6984,
        data: PURCHASE_DAY,
        externalId: "incoming-ext",
      },
    });
    const result = await inspect(100, purchase({ total: 1 }));
    expect(result.kind).toBe("EXHAUSTED");
    if (result.kind !== "EXHAUSTED") throw new Error("Unexpected overflow");
    expect(result.inspection.companions.map((row) => row.id)).toEqual([
      `${tenantId}-own-strong`,
    ]);
    expect(result.inspection.receipts).toEqual([]);
    expect(result.inspection.imports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: importId,
          tenantId,
          cardId,
          deletedAt: null,
        }),
      ]),
    );
    expect(result.admission).toEqual({ kind: "BLOCKED", sameSeries: false });
  });

  it.each([
    "CreditCard",
    "Expense",
    "CreditCardStatementImport",
    "CashFlowEntry",
    "Receipt",
  ])(
    "counts the actual overflow witness at the %s stage and stops without partial inspection",
    async (model) => {
      const source = await root();
      await cash(source.id);
      await receipt("root-ext", NOW);
      const full = await inspect(100);
      expect(full.kind).toBe("EXHAUSTED");
      const target = reads.findIndex(
        (read) => read.model === model && read.ids.length > 0,
      );
      expect(target).toBeGreaterThanOrEqual(0);
      const remaining = reads
        .slice(0, target)
        .reduce((sum, read) => sum + read.ids.length, 0);
      const result = await inspect(remaining);
      expect(result).toEqual({
        kind: "BUDGET_EXCEEDED",
        visitedRows: remaining + 1,
      });
      expect(reads.at(-1)?.model).toBe(model);
      expect(reads.at(-1)?.ids).toHaveLength(1);
    },
  );

  it("zero allowance distinguishes empty from the first root on the strong-only path", async () => {
    const identity = purchase({ total: 1, cardId: `${tenantId}-absent-card` });
    expect(await inspect(0, identity)).toMatchObject({
      kind: "EXHAUSTED",
      visitedRows: 0,
      admission: { kind: "CLEAR" },
    });
    await root("strong", { externalId: "incoming-ext" });
    expect(await inspect(0, identity)).toEqual({
      kind: "BUDGET_EXCEEDED",
      visitedRows: 1,
    });
  });

  it.each([-1, 0.5, NaN, Infinity])(
    "inspection rejects invalid remaining %s before IO",
    async (remaining) => {
      const fn = load("inspectCardImportInTx");
      allowance = 0;
      capturing = true;
      reached.push("inspectCardImportInTx");
      try {
        await expect(
          db.$transaction((tx) => fn(tx, tenantId, purchase(), remaining)),
        ).rejects.toBeInstanceOf(Error);
        expect(reads).toEqual([]);
        expect(attempts).toEqual([]);
      } finally {
        capturing = false;
      }
    },
  );

  it("orphan cash flow belongs to RESTORE only, not IMPORT", async () => {
    await cash(null, "orphan");
    const identity = purchase({ total: 1 });
    await expect(
      db.$transaction((tx) =>
        inspectCardPurchaseCompanions(tx, tenantId, identity, "restore"),
      ),
    ).rejects.toThrow();
    expect(
      await db.$transaction((tx) => classifyCardImport(tx, tenantId, identity)),
    ).toEqual({ kind: "CLEAR" });
    const result = await inspect(50, identity);
    expect(result).toMatchObject({
      kind: "EXHAUSTED",
      admission: { kind: "CLEAR" },
    });
    expect(reads.filter((read) => read.model === "CashFlowEntry")).toEqual([]);
  });

  it.each([1, 2] as const)(
    "fixture control: real V%s parser and installment primitive preserve printed 2/10",
    async (version) => {
      const fixture = await scheduled(version);
      expect(
        toPublicExpenseSchedule(
          parseStoredExpenseSchedule(fixture.source.documentedSchedule),
        )?.occurrences[1],
      ).toEqual({
        index: 1,
        parcela: "2/10",
        valor: 6984,
        data: "2026-02-10",
        invoiceDueMonth: "2026-02",
      });
      expect(fixture.installments[1]).toEqual({
        index: 1,
        parcela: "2/10",
        valor: 6984,
        data: new Date("2026-02-10T00:00:00.000Z"),
        invoiceDueMonth: "2026-02",
      });
    },
  );

  it.each([1, 2] as const)(
    "KEEP V%s full schedule binds the real observation at index 1",
    async (version) => {
      const { source } = await scheduled(version);
      expect(keep(await facts(), source.id)).toEqual({
        kind: "COMPATIBLE",
        bindings: [
          {
            observationId: "observation-2",
            canonicalIndex: 1,
            cashFlowEntryId: `${tenantId}-source-cfe-1`,
          },
        ],
      });
    },
  );

  it.each([1, 2] as const)(
    "cutpoint: full V%s agenda has a positive first-occurrence control",
    async (version) => {
      const { source, schedule } = await scheduled(version);
      const current = await facts();
      expect(current.companions[0].cashFlow).toHaveLength(10);
      expect(schedule.occurrences[0]).toMatchObject({
        index: 0,
        parcela: "1/10",
        valor: 6984,
        data: "2026-01-10",
        invoiceDueMonth: "2026-01",
      });
      expect(schedule.occurrences[9]).toMatchObject({
        index: 9,
        parcela: "10/10",
        valor: 6984,
        data: "2026-10-10",
        invoiceDueMonth: "2026-10",
      });
      expect(
        keep(current, source.id, LINE, [
          { ...OBSERVATION, id: "observation-1", installmentIndex: 1 },
        ]),
      ).toEqual({
        kind: "COMPATIBLE",
        bindings: [
          {
            observationId: "observation-1",
            canonicalIndex: 0,
            cashFlowEntryId: `${tenantId}-source-cfe-0`,
          },
        ],
      });
    },
  );

  it("cutpoint: V1 import tombstone alone blocks an otherwise compatible full agenda", async () => {
    const { source } = await scheduled(1);
    const observations = [
      { ...OBSERVATION, id: "observation-1", installmentIndex: 1 },
    ];
    const active = await facts();
    expect(keep(active, source.id, LINE, observations)).toEqual({
      kind: "COMPATIBLE",
      bindings: [
        {
          observationId: "observation-1",
          canonicalIndex: 0,
          cashFlowEntryId: `${tenantId}-source-cfe-0`,
        },
      ],
    });
    await db.creditCardStatementImport.update({
      where: { id: importId },
      data: { deletedAt: NOW },
    });
    const deleted = await facts();
    expect(deleted.companions).toEqual(active.companions);
    expect(deleted.receipts).toEqual(active.receipts);
    expect(deleted.cards).toEqual(active.cards);
    expect(deleted.imports).toHaveLength(1);
    expect(deleted.imports[0]).toMatchObject({
      id: importId,
      tenantId,
      cardId,
      deletedAt: NOW,
    });
    expect(keep(deleted, source.id, LINE, observations)).toEqual({
      kind: "BLOCKED",
    });
  });

  it("KEEP partial 2..10 binds printed 2/10 at index 0, not printed minus one", async () => {
    const { source } = await scheduled(1, true);
    expect(
      keep(await facts(), source.id, {
        ...LINE,
        amountMeaning: "INSTALLMENT_CHARGE",
        amountCents: 6984,
        firstDueDate: "2026-02-10",
      }),
    ).toEqual({
      kind: "COMPATIBLE",
      bindings: [
        {
          observationId: "observation-2",
          canonicalIndex: 0,
          cashFlowEntryId: `${tenantId}-source-cfe-0`,
        },
      ],
    });
  });

  it.each([
    { count: 1, labels: [null], compatible: true },
    { count: 1, labels: ["1/1"], compatible: true },
    { count: 1, labels: ["2/3"], compatible: false },
    { count: 3, labels: [null], compatible: false },
    { count: 3, labels: ["1/1"], compatible: false },
    { count: 3, labels: ["3/3"], compatible: false },
    { count: 3, labels: ["1/3", "2/3", "3/3"], compatible: false },
    { count: 3, labels: [], compatible: false },
  ])(
    "X3 null-index KEEP count=$count labels=$labels uses native agenda, not warning inference",
    async ({ count, labels, compatible }) => {
      const { source, schedule } = await scheduled(2);
      const current = await facts();
      const originals: Observation[] = [
        {
          ...OBSERVATION,
          installmentCount: count,
          installmentIndex: null,
        },
      ];
      const line: Line = {
        ...LINE,
        amountMeaning: "INSTALLMENT_CHARGE",
        amountCents: 6984,
        installmentCount: count,
      };
      const adjusted: Facts = {
        ...current,
        companions: current.companions.map((row) =>
          row.id !== source.id
            ? row
            : {
                ...row,
                valor: labels.length * 6984,
                valorTotal: labels.length * 6984,
                quantidadeParcela: labels.length,
                documentedSchedule:
                  labels.length === 0
                    ? null
                    : JSON.stringify({
                        ...schedule,
                        occurrences: labels.map((parcela, index) => ({
                          ...schedule.occurrences[index],
                          index,
                          parcela,
                        })),
                      }),
                cashFlow: labels.map((parcela, index) => ({
                  ...row.cashFlow[index]!,
                  parcela,
                })),
              },
        ),
      };
      expect(hasUnknownCardOccurrenceFacts(originals[0]!)).toBe(false);
      expect(
        keep(
          adjusted,
          source.id,
          line,
          originals,
          purchase({ total: count, seriesKey: null }),
        ).kind === "COMPATIBLE",
      ).toBe(compatible);
    },
  );

  it.each([null, 3])(
    "X3 whole original count=%s is not evidence of KEEP compatibility",
    async (count) => {
      const { source } = await scheduled(2);
      const original = {
        ...OBSERVATION,
        amountMeaning: "TOTAL_PURCHASE" as const,
        amountCents: 69840,
        installmentCount: count,
        installmentIndex: null,
      };
      expect(hasUnknownCardOccurrenceFacts(original)).toBe(count === null);
      expect(keep(await facts(), source.id, LINE, [original]).kind).not.toBe(
        "COMPATIBLE",
      );
    },
  );

  it("X3 M extraction retains BLOCKED before unknown-facts NEEDS_INPUT", async () => {
    const { source } = await scheduled(2);
    const original: Observation = {
      ...OBSERVATION,
      amountMeaning: "UNKNOWN",
      amountCents: null,
    };
    expect(keep(await facts(), source.id, LINE, [original])).toEqual({
      kind: "NEEDS_INPUT",
    });
    await db.expense.update({
      where: { id: source.id },
      data: { deletedAt: NOW },
    });
    expect(keep(await facts(), source.id, LINE, [original])).toEqual({
      kind: "BLOCKED",
    });
  });

  it("twins remain separately compatible: explicit root B never binds A", async () => {
    await scheduled(2, false, "source-a");
    await scheduled(2, false, "source-b");
    const current = await facts();
    for (const name of ["source-a", "source-b"])
      expect(keep(current, `${tenantId}-${name}`)).toEqual({
        kind: "COMPATIBLE",
        bindings: [
          {
            observationId: "observation-2",
            canonicalIndex: 1,
            cashFlowEntryId: `${tenantId}-${name}-cfe-1`,
          },
        ],
      });
  });

  it("KEEP binds every observation to its own literal index and CFE", async () => {
    const { source } = await scheduled(2);
    const result = keep(await facts(), source.id, LINE, [
      { ...OBSERVATION, id: "observation-3", installmentIndex: 3 },
      OBSERVATION,
    ]);
    expect(result.kind).toBe("COMPATIBLE");
    if (result.kind !== "COMPATIBLE")
      throw new Error("Expected compatible observations");
    expect(result.bindings).toHaveLength(2);
    expect(result.bindings).toEqual(
      expect.arrayContaining([
        {
          observationId: "observation-2",
          canonicalIndex: 1,
          cashFlowEntryId: `${tenantId}-source-cfe-1`,
        },
        {
          observationId: "observation-3",
          canonicalIndex: 2,
          cashFlowEntryId: `${tenantId}-source-cfe-2`,
        },
      ]),
    );
  });

  it("KEEP cannot neutralize another strong-identity root, even outside the purchase project", async () => {
    const { source } = await scheduled(1);
    await root("strong-blocker", {
      projectId: otherProject,
      titulo: "OTHER",
      fornecedor: "OTHER",
      seriesKey: null,
      externalId: "incoming-ext",
    });
    expect(keep(await facts(), source.id)).toEqual({ kind: "BLOCKED" });
  });

  it("KEEP preserves active PAGO and unknown historical cycles without deriving them", async () => {
    const { source, schedule } = await scheduled(2);
    schedule.occurrences.forEach((occurrence) => {
      occurrence.invoiceDueMonth = null;
      occurrence.cycleEvidence = null;
    });
    await db.expense.update({
      where: { id: source.id },
      data: {
        documentedSchedule: JSON.stringify(schedule),
        status: "PAGO",
        paidParcelas: null,
      },
    });
    await db.cashFlowEntry.updateMany({
      where: { expenseId: source.id },
      data: { invoiceDueMonth: null, status: "PAGO" },
    });
    const before = await facts();
    expect(keep(before, source.id)).toEqual({
      kind: "COMPATIBLE",
      bindings: [
        {
          observationId: "observation-2",
          canonicalIndex: 1,
          cashFlowEntryId: `${tenantId}-source-cfe-1`,
        },
      ],
    });
    expect(await facts()).toEqual(before);
  });

  it("amountMeaning uses the declared total, not ten times a nonuniform installment charge", async () => {
    const { source, schedule } = await scheduled(1);
    schedule.occurrences[0].valor = 7000;
    schedule.occurrences[9].valor = 6968;
    await db.expense.update({
      where: { id: source.id },
      data: { documentedSchedule: JSON.stringify(schedule) },
    });
    await db.cashFlowEntry.update({
      where: { id: `${tenantId}-source-cfe-0` },
      data: { valor: 7000 },
    });
    await db.cashFlowEntry.update({
      where: { id: `${tenantId}-source-cfe-9` },
      data: { valor: 6968 },
    });
    const observations = [
      {
        ...OBSERVATION,
        id: "observation-1",
        installmentIndex: 1,
        amountCents: 7000,
      },
    ];
    expect(keep(await facts(), source.id, LINE, observations)).toEqual({
      kind: "COMPATIBLE",
      bindings: [
        {
          observationId: "observation-1",
          canonicalIndex: 0,
          cashFlowEntryId: `${tenantId}-source-cfe-0`,
        },
      ],
    });
    expect(
      keep(
        await facts(),
        source.id,
        { ...LINE, amountCents: 70000 },
        observations,
      ),
    ).toEqual({ kind: "BLOCKED" });
    expect(
      keep(
        await facts(),
        source.id,
        { ...LINE, amountMeaning: "INSTALLMENT_CHARGE", amountCents: 69840 },
        observations,
      ),
    ).toEqual({ kind: "BLOCKED" });
  });

  it.each([
    "root-id",
    "source-project",
    "source-tenant",
    "source-card",
    "root-tenant",
    "import-card",
    "import-identity",
    "import-tombstone",
    "card-last4",
    "card-tombstone",
    "external-id",
    "tombstone",
    "receipt",
    "amount",
    "date",
    "cycle",
    "projection",
  ] as const)(
    "KEEP blocks contradictory %s facts, with no IO or mutation",
    async (scenario) => {
      const { source, schedule } = await scheduled(1);
      const current = await facts();
      const selected = current.companions[0];
      if (scenario === "root-id") schedule.sourceExpenseId = "unrelated-root";
      if (scenario === "source-project")
        schedule.sourceProjectId = otherProject;
      if (scenario === "source-tenant") schedule.tenantId = "unrelated-tenant";
      if (scenario === "source-card") schedule.cardId = "unrelated-card";
      if (scenario === "external-id" && schedule.version === 1)
        schedule.externalId = "contradictory-external";
      selected.documentedSchedule = JSON.stringify(schedule);
      if (scenario === "root-tenant") selected.tenantId = "unrelated-tenant";
      if (scenario === "import-identity")
        selected.importId = "unrelated-import";
      if (scenario === "import-tombstone")
        current.imports = current.imports.map((item) => ({
          ...item,
          deletedAt: NOW,
        }));
      if (scenario === "card-tombstone")
        current.cards = current.cards.map((item) => ({
          ...item,
          deletedAt: NOW,
        }));
      if (scenario === "import-card")
        current.imports = current.imports.map((item) => ({
          ...item,
          cardId: "unrelated-card",
        }));
      if (scenario === "card-last4")
        current.cards = current.cards.map((item) => ({
          ...item,
          last4: "9999",
        }));
      if (scenario === "tombstone") selected.deletedAt = NOW;
      if (scenario === "receipt")
        current.receipts = [await receipt("source-ext", NOW)];
      const occurrence = selected.cashFlow.find(
        (entry) => entry.parcela === "2/10",
      );
      if (!occurrence) throw new Error("Missing fixture occurrence");
      if (scenario === "amount") occurrence.valor = 6985;
      if (scenario === "date")
        occurrence.data = new Date("2026-02-11T00:00:00.000Z");
      if (scenario === "cycle") occurrence.invoiceDueMonth = "2026-03";
      if (scenario === "projection") {
        const projection: StoredProjectionScheduleV1 = {
          version: 1,
          kind: "projection",
          tenantId,
          sourceExpenseId: "upstream",
          sourceProjectId: otherProject,
          cardId,
          recordedByUserId: "qa-author",
          recordedAt: NOW.toISOString(),
          targetExpenseId: source.id,
          targetProjectId: projectId,
          via: "mirror",
          allocationId: null,
          occurrences: schedule.occurrences.map(
            ({ amountEvidence, cycleEvidence, ...item }) => ({
              ...item,
              sourceIndex: item.index,
            }),
          ),
        };
        expect(
          parseStoredExpenseSchedule(JSON.stringify(projection))?.kind,
        ).toBe("projection");
        selected.documentedSchedule = JSON.stringify(projection);
      }
      expect(keep(current, source.id)).toEqual({ kind: "BLOCKED" });
    },
  );

  it.each([
    "no-schedule",
    "unknown-observation",
    "unknown-index",
    "missing-label",
    "duplicate-cfe",
  ] as const)("KEEP does not invent a binding for %s", async (scenario) => {
    const { source } = await scheduled(2);
    if (scenario === "duplicate-cfe")
      await cash(source.id, "second-real-cfe", { invoiceDueMonth: "2026-02" });
    const current = await facts();
    let observations: Observation[] = [{ ...OBSERVATION }];
    if (scenario === "no-schedule")
      current.companions[0].documentedSchedule = null;
    if (scenario === "unknown-observation")
      observations = [
        { ...OBSERVATION, amountMeaning: "UNKNOWN", amountCents: null },
      ];
    if (scenario === "unknown-index")
      observations = [{ ...OBSERVATION, installmentIndex: null }];
    if (scenario === "missing-label")
      observations = [{ ...OBSERVATION, installmentIndex: 11 }];
    const result = keep(current, source.id, LINE, observations);
    if (
      scenario === "no-schedule" ||
      scenario === "unknown-observation" ||
      scenario === "unknown-index"
    )
      expect(result).toEqual({ kind: "NEEDS_INPUT" });
    else {
      expect(["BLOCKED", "NEEDS_INPUT"]).toContain(result.kind);
      expect(result).not.toHaveProperty("bindings");
    }
  });
});
