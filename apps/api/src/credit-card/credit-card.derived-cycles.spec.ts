require("../../../../scripts/test-db-env.cjs");

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import { MonthlyOverviewService } from "../monthly-overview/monthly-overview.service";
import { PrismaService } from "../prisma/prisma.service";
import { ExpenseService } from "../expense/expense.service";
import {
  parseDocumentaryCycle,
  parseScheduleEvidenceInput,
  parseStoredExpenseSchedule,
} from "../expense/documented-schedule";
import {
  pessoalRequester,
  resetTenant,
  seedCardWithClosingDue,
  seedPessoal,
} from "../bank-account/__tests__/invoice-undo.fixtures";
import { CardInvoiceSettlementService } from "./card-invoice-settlement.service";
import { CreditCardService } from "./credit-card.service";
import { DocumentedScheduleService } from "./documented-schedule.service";
import { parseStatement } from "./parsers";

/**
 * P01 derived cycles. A NEW import carrying `documentaryCycle` for its source
 * installment (index 0) also derives the FUTURE generated installments: future
 * i lives in (anchor invoiceDueMonth + i months); date, cents, label and status
 * are untouched. Index 0 may print `2/3`: the offset is the array index, never
 * the printed number. Imports without the override, and every legacy schedule,
 * stay exactly as they are (no backfill).
 *
 * Correction reuses preview/fingerprint/apply. Changing an anchor lists the
 * dependents still derived from it; each needs an explicit `keep`/`rederive`
 * disposition, else 409 DERIVED_DEPENDENTS_UNRESOLVED with zero effects.
 */
const TENANT = "qa-p01-derived-cycles";
const PROJECT = `${TENANT}-pessoal`;
const ACTOR = { ...pessoalRequester(PROJECT), id: `${TENANT}-actor` };
const DOC = {
  documentSha256: "a".repeat(64),
  reference: "Synthetic statement page 1",
};
const CYCLE_NOV = { invoiceDueMonth: "2026-11", evidence: DOC };
const NEW_DOC = {
  documentSha256: "b".repeat(64),
  reference: "Synthetic corrected page",
};
const CLOCK_A = new Date("2026-11-05T12:00:00.000Z");
const CLOCK_B = new Date("2026-11-06T09:30:00.000Z");
const UNRESOLVED = "DERIVED_DEPENDENTS_UNRESOLVED";

describe("P01 derived cycles", () => {
  const setup = new PrismaClient();
  const prisma = new PrismaService();
  const conciliacao = new ConciliacaoService(prisma);
  const cards = new CreditCardService(
    prisma,
    conciliacao,
    new MerchantClassifierService(prisma),
  );
  const monthly = new MonthlyOverviewService(
    prisma,
    new CardInvoiceSettlementService(prisma),
  );
  const service = new DocumentedScheduleService(prisma);
  let cardId: string;
  let failCashCas = false;

  prisma.$use(async (params, next) => {
    if (
      failCashCas &&
      params.model === "CashFlowEntry" &&
      params.action === "updateMany"
    )
      return { count: 0 };
    return next(params);
  });

  beforeAll(async () => {
    await prisma.$connect();
    await setup.$connect();
  });
  beforeEach(async () => {
    failCashCas = false;
    jest.useFakeTimers({
      now: CLOCK_A,
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
    await setup.userActivityLog.deleteMany({ where: { tenantId: TENANT } });
    await setup.user.deleteMany({ where: { tenantId: TENANT } });
    await resetTenant(setup, TENANT);
    await seedPessoal(setup, { tenantId: TENANT, projectId: PROJECT });
    await setup.user.create({
      data: {
        id: ACTOR.id,
        tenantId: TENANT,
        username: ACTOR.id,
        name: "Synthetic operator",
        role: "USER",
        allowedProjects: JSON.stringify([PROJECT]),
        allowedProjectTypes: JSON.stringify(["PESSOAL"]),
        allowedModules: JSON.stringify(ACTOR.allowedModules),
      },
    });
    ({ id: cardId } = await seedCardWithClosingDue(setup, {
      tenantId: TENANT,
      projectId: PROJECT,
      last4: "0715",
      closingDay: 20,
      dueDay: 10,
    }));
  });
  afterEach(() => jest.useRealTimers());
  afterAll(async () => {
    await setup.userActivityLog.deleteMany({ where: { tenantId: TENANT } });
    await setup.user.deleteMany({ where: { tenantId: TENANT } });
    await resetTenant(setup, TENANT);
    await prisma.$disconnect();
    await setup.$disconnect();
  });

  async function importRows(
    rows: string[],
    cycle: typeof CYCLE_NOV | null = CYCLE_NOV,
  ) {
    const csv = `date,title,amount\n${rows.join("\n")}\n`;
    const transactions = parseStatement(
      csv,
      cardId,
      "CSV_GENERIC",
      "synthetic.csv",
    ).transactions;
    return cards.commitImport(
      TENANT,
      PROJECT,
      cardId,
      csv,
      "synthetic.csv",
      "CSV_GENERIC",
      undefined,
      undefined,
      transactions.map(({ externalId }) => ({
        externalId,
        action: "create",
        overrides: cycle === null ? {} : { documentaryCycle: cycle },
      })),
      ACTOR.id,
      ACTOR,
    );
  }
  const source = () =>
    setup.expense.findFirstOrThrow({
      where: { tenantId: TENANT },
      include: {
        cashFlow: { where: { deletedAt: null }, orderBy: { data: "asc" } },
      },
    });
  const cfeView = (
    rows: Array<{
      parcela: string | null;
      valor: number;
      data: Date;
      status: string;
      invoiceDueMonth: string | null;
    }>,
  ) =>
    rows.map(({ parcela, valor, data, status, invoiceDueMonth }) => ({
      parcela,
      valor,
      data: data.toISOString().slice(0, 10),
      status,
      invoiceDueMonth,
    }));
  const stored = async () =>
    parseStoredExpenseSchedule((await source()).documentedSchedule)!;
  async function snapshot() {
    const args = {
      where: { tenantId: TENANT },
      orderBy: { id: "asc" as const },
    };
    return {
      expenses: await setup.expense.findMany(args),
      cash: await setup.cashFlowEntry.findMany(args),
      audits: await setup.userActivityLog.findMany(args),
    };
  }

  // ── A. New import derives the generated futures ──────────────────────────

  it("A1: 2/3 printed at index 0 with a November document cycle puts 3/3 in December, never September", async () => {
    await importRows(["2026-07-14,QA SERIAL MAPLE 2/3,123.45"]);
    const row = await source();
    expect(cfeView(row.cashFlow)).toEqual([
      {
        parcela: "2/3",
        valor: 12345,
        data: "2026-07-14",
        status: "PLANEJADO",
        invoiceDueMonth: "2026-11",
      },
      {
        parcela: "3/3",
        valor: 12345,
        data: "2026-08-14",
        status: "PLANEJADO",
        invoiceDueMonth: "2026-12",
      },
    ]);
    const annual = await monthly.getCardInvoicesYearly(
      TENANT,
      PROJECT,
      2026,
      ACTOR,
    );
    expect(
      annual.months
        .filter(({ total }) => total !== 0)
        .map(({ mes, total }) => ({ mes, total })),
    ).toEqual([
      { mes: "2026-11", total: 12345 },
      { mes: "2026-12", total: 12345 },
    ]);
  });

  it("A2: year turn: 4/6 in November 2026 puts 5/6 in December and 6/6 in January 2027", async () => {
    await importRows(["2026-07-14,QA SERIAL YEAR 4/6,50.00"]);
    const row = await source();
    expect(row.cashFlow.map((c) => [c.parcela, c.invoiceDueMonth])).toEqual([
      ["4/6", "2026-11"],
      ["5/6", "2026-12"],
      ["6/6", "2027-01"],
    ]);
  });

  it("A3: derived proof is private, self-contained and carries no document artifact", async () => {
    await importRows(["2026-07-14,QA SERIAL MAPLE 2/3,123.45"]);
    const schedule = await stored();
    expect(schedule.kind).toBe("source");
    if (schedule.kind !== "source") throw new Error("unreachable");
    expect(schedule.occurrences[0].cycleEvidence).toMatchObject({
      ...DOC,
      actorUserId: ACTOR.id,
    });
    expect(schedule.occurrences[1].cycleEvidence).toEqual({
      evidenceKind: "derived-sequential",
      derivedFrom: { index: 0, invoiceDueMonth: "2026-11" },
      offset: 1,
      actorUserId: ACTOR.id,
      recordedAt: CLOCK_A.toISOString(),
    });
    expect(schedule.occurrences[1].amountEvidence).toBeNull();
    expect(schedule.occurrences[1].invoiceDueMonth).toBe("2026-12");
  });

  it("A4 control: an import WITHOUT documentaryCycle is unchanged (no derived months, no schedule)", async () => {
    await importRows(["2026-07-14,QA SERIAL MAPLE 2/3,123.45"], null);
    const row = await source();
    expect(row.documentedSchedule).toBeNull();
    expect(row.cashFlow.map((c) => c.invoiceDueMonth)).toEqual([null, null]);
  });

  it("A5 control: dates, cents, labels and statuses are preserved by derivation", async () => {
    await importRows(["2026-07-14,QA SERIAL MAPLE 2/3,123.45"]);
    const row = await source();
    expect(row.valorTotal).toBe(24690);
    expect(
      row.cashFlow.map((c) => [
        c.parcela,
        c.valor,
        c.data.toISOString().slice(0, 10),
        c.status,
      ]),
    ).toEqual([
      ["2/3", 12345, "2026-07-14", "PLANEJADO"],
      ["3/3", 12345, "2026-08-14", "PLANEJADO"],
    ]);
  });

  it("A6 control: 2/2 in October with a December document cycle stays December (no future to derive)", async () => {
    await importRows(["2026-10-14,QA SERIAL LAST 2/2,80.00"], {
      invoiceDueMonth: "2026-12",
      evidence: DOC,
    });
    const row = await source();
    expect(row.cashFlow.map((c) => [c.parcela, c.invoiceDueMonth])).toEqual([
      ["2/2", "2026-12"],
    ]);
    const annual = await monthly.getCardInvoicesYearly(
      TENANT,
      PROJECT,
      2026,
      ACTOR,
    );
    expect(
      annual.months.filter(({ total }) => total !== 0).map(({ mes }) => mes),
    ).toEqual(["2026-12"]);
  });

  // ── B. Parser: superset, self-contained derived proof ────────────────────

  const derivedStored = (
    mutate: (item: Record<string, any>) => void = () => undefined,
  ) => {
    const occurrences = [
      {
        index: 0,
        parcela: "2/3",
        valor: 100,
        data: "2026-07-14",
        invoiceDueMonth: "2026-11",
        amountEvidence: null,
        cycleEvidence: {
          ...DOC,
          actorUserId: "u",
          recordedAt: CLOCK_A.toISOString(),
        },
      },
      {
        index: 1,
        parcela: "3/3",
        valor: 100,
        data: "2026-08-14",
        invoiceDueMonth: "2026-12",
        amountEvidence: null,
        cycleEvidence: {
          evidenceKind: "derived-sequential",
          derivedFrom: { index: 0, invoiceDueMonth: "2026-11" },
          offset: 1,
          actorUserId: "u",
          recordedAt: CLOCK_A.toISOString(),
        },
      },
    ];
    mutate(occurrences[1].cycleEvidence as Record<string, any>);
    return JSON.stringify({
      version: 1,
      kind: "source",
      tenantId: "t",
      sourceExpenseId: "e",
      sourceProjectId: "p",
      cardId: "c",
      recordedByUserId: "u",
      recordedAt: CLOCK_A.toISOString(),
      importId: "i",
      externalId: "x",
      occurrences,
      projections: [],
      lastOperation: null,
    });
  };

  it("B1: accepts a valid self-contained derived proof (positive precondition for the B2 guards)", () => {
    expect(() => parseStoredExpenseSchedule(derivedStored())).not.toThrow();
  });
  it.each([
    [
      "offset differs from index - derivedFrom.index",
      (e: Record<string, any>) => {
        e.offset = 2;
      },
    ],
    [
      "month is not snapshot + offset",
      (e: Record<string, any>) => {
        e.derivedFrom.invoiceDueMonth = "2026-10";
      },
    ],
    [
      "derivedFrom.index is not before the occurrence",
      (e: Record<string, any>) => {
        e.derivedFrom.index = 1;
      },
    ],
    [
      "carries a document artifact",
      (e: Record<string, any>) => {
        e.documentSha256 = "c".repeat(64);
      },
    ],
    [
      "carries an extra field",
      (e: Record<string, any>) => {
        e.reference = "x";
      },
    ],
  ])("B2 guard: rejects derived proof whose %s", (_name, mutate) => {
    expect(() => parseStoredExpenseSchedule(derivedStored(mutate))).toThrow(
      RangeError,
    );
  });
  it("B2 guard: rejects a self-consistent month whose offset is not the array distance to the anchor", () => {
    const raw = JSON.parse(derivedStored());
    raw.occurrences[1].invoiceDueMonth = "2027-01";
    raw.occurrences[1].cycleEvidence.offset = 2;
    expect(() => parseStoredExpenseSchedule(JSON.stringify(raw))).toThrow(
      RangeError,
    );
  });
  it("B3 control: an unknown cycleEvidence kind fails and a legacy sparse v1 schedule still parses", () => {
    expect(() =>
      parseStoredExpenseSchedule(
        derivedStored((e) => {
          e.evidenceKind = "mystery";
        }),
      ),
    ).toThrow(RangeError);
    const legacy = JSON.parse(derivedStored());
    legacy.occurrences[1].invoiceDueMonth = null;
    legacy.occurrences[1].cycleEvidence = null;
    expect(() =>
      parseStoredExpenseSchedule(JSON.stringify(legacy)),
    ).not.toThrow();
  });
  it("B4 control: no client input can carry derived-sequential", () => {
    const derived = {
      evidenceKind: "derived-sequential",
      derivedFrom: { index: 0, invoiceDueMonth: "2026-11" },
      offset: 1,
    };
    expect(() => parseScheduleEvidenceInput(derived)).toThrow(RangeError);
    expect(() =>
      parseDocumentaryCycle({ invoiceDueMonth: "2026-12", evidence: derived }),
    ).toThrow(RangeError);
  });

  // ── C. Assisted correction of an anchor ──────────────────────────────────

  async function correctionFixture(
    rows = ["2026-07-14,QA SERIAL MAPLE 2/4,100.00"],
  ) {
    await importRows(rows);
    const row = await source();
    const scope = {
      tenantId: TENANT,
      projectId: PROJECT,
      cardId,
      importId: row.importId!,
      expenseId: row.id,
    };
    const [anchor, ...dependents] = row.cashFlow;
    const change = (month = "2026-12") => ({
      cashFlowEntryId: anchor.id,
      invoiceDueMonth: month,
      evidence: NEW_DOC,
    });
    return { scope, anchor, dependents, change };
  }
  const preview = (scope: object, body: object) =>
    service.correct(scope as never, ACTOR, { mode: "preview", ...body });
  const apply = (
    scope: object,
    body: object,
    expectedFingerprint: string,
    requestId = "req-1",
  ) =>
    service.correct(scope as never, ACTOR, {
      mode: "apply",
      requestId,
      expectedFingerprint,
      ...body,
    });

  it("C1: changing an anchor previews ONLY its derived dependents, with current/candidate/rederivable", async () => {
    const { scope, dependents, change } = await correctionFixture();
    const result: any = await preview(scope, { changes: [change("2026-12")] });
    expect(result).toMatchObject({ applicable: false, reason: UNRESOLVED });
    expect(result.staleDerivedDependents).toEqual([
      {
        cashFlowEntryId: dependents[0].id,
        parcela: "3/4",
        current: "2026-12",
        candidate: "2027-01",
        rederivable: true,
      },
      {
        cashFlowEntryId: dependents[1].id,
        parcela: "4/4",
        current: "2027-01",
        candidate: "2027-02",
        rederivable: true,
      },
    ]);
  });

  it("C2: apply without a disposition for every stale dependent is 409 with zero effects", async () => {
    const { scope, change } = await correctionFixture();
    const before = await snapshot();
    const { fingerprint }: any = await preview(scope, { changes: [change()] });
    await expect(
      apply(scope, { changes: [change()] }, fingerprint),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: UNRESOLVED }),
    });
    expect(await snapshot()).toEqual(before);
  });

  it("C3: keep retains the historical proof, month and snapshot; the anchor changes alone", async () => {
    const { scope, dependents, change } = await correctionFixture();
    const before = await source();
    const dispositions = dependents.map((d) => ({
      cashFlowEntryId: d.id,
      action: "keep",
    }));
    const body = { changes: [change()], dependentDispositions: dispositions };
    const { fingerprint }: any = await preview(scope, body);
    await apply(scope, body, fingerprint);
    const after = await source();
    expect(after.cashFlow.map((c) => c.invoiceDueMonth)).toEqual([
      "2026-12",
      before.cashFlow[1].invoiceDueMonth,
      before.cashFlow[2].invoiceDueMonth,
    ]);
    const schedule: any = await stored();
    expect(schedule.occurrences[1].cycleEvidence).toMatchObject({
      evidenceKind: "derived-sequential",
      derivedFrom: { index: 0, invoiceDueMonth: "2026-11" },
      offset: 1,
    });
  });

  it("C4: rederive moves only PLANEJADO dependents, with a new server proof stamped at apply time", async () => {
    const { scope, dependents, change } = await correctionFixture();
    const before = await source();
    const body = {
      changes: [change()],
      dependentDispositions: dependents.map((d) => ({
        cashFlowEntryId: d.id,
        action: "rederive",
      })),
    };
    const { fingerprint }: any = await preview(scope, body);
    jest.setSystemTime(CLOCK_B);
    await apply(scope, body, fingerprint);
    const after = await source();
    expect(after.cashFlow.map((c) => c.invoiceDueMonth)).toEqual([
      "2026-12",
      "2027-01",
      "2027-02",
    ]);
    expect(
      cfeView(after.cashFlow).map(({ invoiceDueMonth, ...rest }) => rest),
    ).toEqual(
      cfeView(before.cashFlow).map(({ invoiceDueMonth, ...rest }) => rest),
    );
    const schedule: any = await stored();
    expect(schedule.occurrences[2].cycleEvidence).toEqual({
      evidenceKind: "derived-sequential",
      derivedFrom: { index: 0, invoiceDueMonth: "2026-12" },
      offset: 2,
      actorUserId: ACTOR.id,
      recordedAt: CLOCK_B.toISOString(),
    });
    expect(after.valorTotal).toBe(before.valorTotal);
  });

  it("C5: a dependent the same request corrects itself becomes independent and needs no disposition", async () => {
    const { scope, dependents, change } = await correctionFixture();
    const own = {
      cashFlowEntryId: dependents[0].id,
      invoiceDueMonth: "2026-10",
      evidence: NEW_DOC,
    };
    const body = {
      changes: [change(), own],
      dependentDispositions: [
        { cashFlowEntryId: dependents[1].id, action: "rederive" },
      ],
    };
    const result: any = await preview(scope, body);
    expect(result.applicable).toBe(true);
    expect(
      result.staleDerivedDependents.map((d: any) => d.cashFlowEntryId),
    ).toEqual([dependents[1].id]);
    await apply(scope, body, result.fingerprint);
    const schedule: any = await stored();
    expect(schedule.occurrences[1].cycleEvidence).toMatchObject({ ...NEW_DOC });
    expect(schedule.occurrences[1].invoiceDueMonth).toBe("2026-10");
    expect(
      schedule.occurrences[2].cycleEvidence.derivedFrom.invoiceDueMonth,
    ).toBe("2026-12");
  });

  it("C6: a PAGO dependent is not rederivable (409), keep is allowed and its cents/status never change", async () => {
    const { scope, dependents, change } = await correctionFixture();
    await setup.cashFlowEntry.update({
      where: { id: dependents[0].id },
      data: { status: "PAGO" },
    });
    await setup.expense.updateMany({
      where: { tenantId: TENANT },
      data: { paidParcelas: "[1]" },
    });
    const rederive = dependents.map((d) => ({
      cashFlowEntryId: d.id,
      action: "rederive",
    }));
    const listing: any = await preview(scope, { changes: [change()] });
    expect(
      listing.staleDerivedDependents.map((d: any) => d.rederivable),
    ).toEqual([false, true]);
    const before = await snapshot();
    await expect(
      preview(scope, { changes: [change()], dependentDispositions: rederive }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await snapshot()).toEqual(before);
    const keep = [
      { cashFlowEntryId: dependents[0].id, action: "keep" },
      { cashFlowEntryId: dependents[1].id, action: "rederive" },
    ];
    const body = { changes: [change()], dependentDispositions: keep };
    const { fingerprint }: any = await preview(scope, body);
    await apply(scope, body, fingerprint);
    const after = await source();
    expect(
      after.cashFlow.map((c) => [c.status, c.valor, c.invoiceDueMonth]),
    ).toEqual([
      ["PLANEJADO", 10000, "2026-12"],
      ["PAGO", 10000, "2026-12"],
      ["PLANEJADO", 10000, "2027-02"],
    ]);
  });

  it("C7: dispositions enter the fingerprint and the replay hash", async () => {
    const { scope, dependents, change } = await correctionFixture();
    const keep = {
      changes: [change()],
      dependentDispositions: dependents.map((d) => ({
        cashFlowEntryId: d.id,
        action: "keep",
      })),
    };
    const redo = {
      changes: [change()],
      dependentDispositions: dependents.map((d) => ({
        cashFlowEntryId: d.id,
        action: "rederive",
      })),
    };
    const keepFp = ((await preview(scope, keep)) as any).fingerprint;
    const redoFp = ((await preview(scope, redo)) as any).fingerprint;
    expect(keepFp).not.toEqual(redoFp);
    const before = await snapshot();
    await expect(apply(scope, redo, keepFp)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(await snapshot()).toEqual(before);
    await apply(scope, keep, keepFp, "req-replay");
    const settled = await snapshot();
    await expect(
      apply(scope, keep, keepFp, "req-replay"),
    ).resolves.toMatchObject({ alreadyApplied: true, applied: false });
    await expect(
      apply(scope, redo, redoFp, "req-replay"),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await snapshot()).toEqual(settled);
  });

  it("C8: a failed CFE write during rederive rolls everything back", async () => {
    const { scope, dependents, change } = await correctionFixture();
    const body = {
      changes: [change()],
      dependentDispositions: dependents.map((d) => ({
        cashFlowEntryId: d.id,
        action: "rederive",
      })),
    };
    const { fingerprint }: any = await preview(scope, body);
    const before = await snapshot();
    failCashCas = true;
    await expect(apply(scope, body, fingerprint)).rejects.toBeInstanceOf(
      ConflictException,
    );
    failCashCas = false;
    expect(await snapshot()).toEqual(before);
  });

  it("C9 guard: a revoked actor gets 404 and no effects, also on retry", async () => {
    const { scope, dependents, change } = await correctionFixture();
    const body = {
      changes: [change()],
      dependentDispositions: dependents.map((d) => ({
        cashFlowEntryId: d.id,
        action: "keep",
      })),
    };
    const previewed: any = await preview(scope, body);
    // Positive precondition: the handler is reached and would apply.
    expect(previewed).toMatchObject({ applicable: true });
    const { fingerprint } = previewed;
    await setup.user.update({
      where: { id: ACTOR.id },
      data: { allowedProjects: JSON.stringify([`${TENANT}-elsewhere`]) },
    });
    const before = await snapshot();
    await expect(apply(scope, body, fingerprint)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(apply(scope, body, fingerprint)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(await snapshot()).toEqual(before);
  });

  // ── D. Financial asymmetry, scope and mirrors ────────────────────────────

  const sumOf = (rows: Array<{ valor: number }>) =>
    rows.reduce((total, row) => total + row.valor, 0);

  it("D1: PAGO 10000 + PLANEJADO 6000 keep cents, status and IDs; only the planned month moves", async () => {
    const { scope, dependents, change } = await correctionFixture();
    await setup.cashFlowEntry.update({
      where: { id: dependents[0].id },
      data: { status: "PAGO" },
    });
    await setup.expense.updateMany({
      where: { tenantId: TENANT },
      data: { paidParcelas: "[1]" },
    });
    // The planned occurrence gets its own independent amount proof through the real correction.
    const own = {
      cashFlowEntryId: dependents[1].id,
      amountCents: 6000,
      evidence: NEW_DOC,
    };
    const amount: any = await preview(scope, { changes: [own] });
    expect(amount.applicable).toBe(true);
    expect(amount).not.toHaveProperty("staleDerivedDependents");
    await apply(scope, { changes: [own] }, amount.fingerprint, "req-amount");
    const before = await source();
    expect(before.cashFlow.map((c) => [c.status, c.valor])).toEqual([
      ["PLANEJADO", 10000],
      ["PAGO", 10000],
      ["PLANEJADO", 6000],
    ]);
    expect(before.valorTotal).toBe(26000);
    const body = {
      changes: [change()],
      dependentDispositions: [
        { cashFlowEntryId: dependents[0].id, action: "keep" },
        { cashFlowEntryId: dependents[1].id, action: "rederive" },
      ],
    };
    const { fingerprint }: any = await preview(scope, body);
    await apply(scope, body, fingerprint);
    const after = await source();
    expect(after.cashFlow.map((c) => c.id)).toEqual(
      before.cashFlow.map((c) => c.id),
    );
    expect(after.cashFlow[1]).toEqual(before.cashFlow[1]);
    expect(
      after.cashFlow.map((c) => [c.status, c.valor, c.data.toISOString()]),
    ).toEqual(
      before.cashFlow.map((c) => [c.status, c.valor, c.data.toISOString()]),
    );
    expect(after.cashFlow.map((c) => c.invoiceDueMonth)).toEqual([
      "2026-12",
      before.cashFlow[1].invoiceDueMonth,
      "2027-02",
    ]);
    const schedule = await stored();
    expect(after.valorTotal).toBe(26000);
    expect(sumOf(after.cashFlow)).toBe(26000);
    expect(sumOf(schedule.occurrences)).toBe(26000);
    expect(
      schedule.occurrences.map((o) => [o.parcela, o.valor, o.invoiceDueMonth]),
    ).toEqual(
      after.cashFlow.map((c) => [c.parcela, c.valor, c.invoiceDueMonth]),
    );
  });

  it("D2 control: an anchor change that keeps its month has no dependents and needs no disposition", async () => {
    const { scope, anchor } = await correctionFixture();
    const same = {
      cashFlowEntryId: anchor.id,
      amountCents: 10001,
      evidence: NEW_DOC,
    };
    const result: any = await preview(scope, { changes: [same] });
    expect(result.applicable).toBe(true);
    expect(result).not.toHaveProperty("staleDerivedDependents");
    const sameMonth: any = await preview(scope, {
      changes: [{ ...same, invoiceDueMonth: "2026-11" }],
    });
    expect(sameMonth.applicable).toBe(true);
    expect(sameMonth).not.toHaveProperty("staleDerivedDependents");
  });

  it("D3: unknown, duplicate, non-stale and foreign-tenant disposition ids all fail with the same 400", async () => {
    const { scope, anchor, dependents, change } = await correctionFixture();
    const foreignTenant = `${TENANT}-foreign`;
    await resetTenant(setup, foreignTenant);
    await seedPessoal(setup, {
      tenantId: foreignTenant,
      projectId: `${foreignTenant}-pessoal`,
    });
    const foreign = await setup.cashFlowEntry.create({
      data: {
        tenantId: foreignTenant,
        projectId: `${foreignTenant}-pessoal`,
        valor: 1,
        tipo: "DESPESA",
        data: new Date("2026-08-14T00:00:00.000Z"),
        status: "PLANEJADO",
        categoria: "OUTROS",
        formaPagamento: "CARTAO_CREDITO",
      },
    });
    const valid = dependents.map((d) => ({
      cashFlowEntryId: d.id,
      action: "keep",
    }));
    const attempts = [
      [...valid, { cashFlowEntryId: "no-such-cfe", action: "keep" }],
      [...valid, { cashFlowEntryId: foreign.id, action: "keep" }],
      [...valid, { cashFlowEntryId: anchor.id, action: "keep" }],
      [...valid, valid[0]],
      [{ cashFlowEntryId: foreign.id, action: "keep" }],
    ];
    const before = await snapshot();
    const messages = new Set<string>();
    for (const dependentDispositions of attempts) {
      const error: any = await preview(scope, {
        changes: [change()],
        dependentDispositions,
      }).catch((e) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      messages.add(JSON.stringify(error.getResponse()));
    }
    expect(messages.size).toBe(1);
    expect(await snapshot()).toEqual(before);
    await resetTenant(setup, foreignTenant);
  });

  it("D4: rederive carries the new month to a mirror target through the existing helpers; a PAGO mirror row is not rederivable", async () => {
    const targetProject = `${TENANT}-target`;
    await setup.project.create({
      data: {
        id: targetProject,
        tenantId: TENANT,
        type: "REFORMA",
        name: "Synthetic target",
      },
    });
    const mirrorActor = {
      ...ACTOR,
      allowedProjects: [PROJECT, targetProject],
      allowedProjectTypes: ["PESSOAL", "REFORMA"],
    };
    await setup.user.update({
      where: { id: ACTOR.id },
      data: {
        allowedProjects: JSON.stringify(mirrorActor.allowedProjects),
        allowedProjectTypes: JSON.stringify(mirrorActor.allowedProjectTypes),
      },
    });
    const { scope, dependents, change } = await correctionFixture();
    const sourceRow = await source();
    const expenseService = new ExpenseService(prisma, conciliacao);
    const mirror = await expenseService.create(
      TENANT,
      targetProject,
      {
        titulo: "Synthetic mirror",
        tipoDespesa: "OUTROS",
        valor: 300,
        quantidade: 1,
        formaPagamento: "PARCELADO",
        quantidadeParcela: 3,
        dataInicioParcela: "2026-07-14",
        status: "PLANEJADO",
        linkedExpenseId: sourceRow.id,
      },
      mirrorActor.id,
      undefined,
      mirrorActor,
    );
    const mirrorRows = () =>
      setup.cashFlowEntry.findMany({
        where: { expenseId: mirror.id, deletedAt: null },
        orderBy: { data: "asc" },
      });
    expect((await mirrorRows()).map((c) => c.invoiceDueMonth)).toEqual([
      "2026-11",
      "2026-12",
      "2027-01",
    ]);
    const run = (body: object) =>
      service.correct(scope as never, mirrorActor, {
        mode: "preview",
        ...body,
      });
    const body = {
      changes: [change()],
      dependentDispositions: dependents.map((d) => ({
        cashFlowEntryId: d.id,
        action: "rederive",
      })),
    };
    const { fingerprint }: any = await run(body);
    await service.correct(scope as never, mirrorActor, {
      mode: "apply",
      requestId: "req-mirror",
      expectedFingerprint: fingerprint,
      ...body,
    });
    const rows = await mirrorRows();
    expect(rows.map((c) => c.invoiceDueMonth)).toEqual([
      "2026-12",
      "2027-01",
      "2027-02",
    ]);
    expect(rows.map((c) => [c.status, c.valor])).toEqual([
      ["PLANEJADO", 10000],
      ["PLANEJADO", 10000],
      ["PLANEJADO", 10000],
    ]);
    const projection: any = parseStoredExpenseSchedule(
      (await setup.expense.findUniqueOrThrow({ where: { id: mirror.id } }))
        .documentedSchedule,
    );
    expect(projection.occurrences.map((o: any) => o.invoiceDueMonth)).toEqual([
      "2026-12",
      "2027-01",
      "2027-02",
    ]);
    // A PAGO mirror row makes that occurrence keep-only.
    await setup.cashFlowEntry.update({
      where: { id: rows[1].id },
      data: { status: "PAGO" },
    });
    await setup.expense.update({
      where: { id: mirror.id },
      data: { paidParcelas: "[1]" },
    });
    const listing: any = await run({ changes: [change("2027-03")] });
    expect(
      listing.staleDerivedDependents.map((d: any) => d.rederivable),
    ).toEqual([false, true]);
  });

  it("D5: after a KEEP, a new request that restates the LIVE anchor month is a no-op for dependents; changing the anchor again still asks", async () => {
    const { scope, anchor, dependents, change } = await correctionFixture();
    const keep = {
      changes: [change("2026-12")],
      dependentDispositions: dependents.map((d) => ({
        cashFlowEntryId: d.id,
        action: "keep",
      })),
    };
    const first: any = await preview(scope, keep);
    await apply(scope, keep, first.fingerprint, "req-keep");
    const kept = await source();
    expect(kept.cashFlow.map((c) => c.invoiceDueMonth)).toEqual([
      "2026-12",
      "2026-12",
      "2027-01",
    ]);
    const keptSchedule: any = await stored();
    // Same live month, fresh valid evidence: nothing about the anchor changes.
    const restate = {
      cashFlowEntryId: anchor.id,
      invoiceDueMonth: "2026-12",
      evidence: { ...NEW_DOC, reference: "Synthetic re-attested page" },
    };
    const body = { changes: [restate] };
    const second: any = await preview(scope, body);
    expect(second.applicable).toBe(true);
    expect(second).not.toHaveProperty("staleDerivedDependents");
    expect(second).not.toHaveProperty("reason");
    await apply(scope, body, second.fingerprint, "req-restate");
    const after = await source();
    expect(after.cashFlow.slice(1)).toEqual(kept.cashFlow.slice(1));
    expect(after.cashFlow.map((c) => c.invoiceDueMonth)).toEqual(
      kept.cashFlow.map((c) => c.invoiceDueMonth),
    );
    expect(after.cashFlow.map((c) => [c.valor, c.status])).toEqual(
      kept.cashFlow.map((c) => [c.valor, c.status]),
    );
    const schedule: any = await stored();
    expect(schedule.occurrences.slice(1)).toEqual(
      keptSchedule.occurrences.slice(1),
    );
    expect(schedule.occurrences[0].cycleEvidence).toMatchObject({
      reference: "Synthetic re-attested page",
    });
    // Control: moving the anchor again still demands the dispositions.
    const moved: any = await preview(scope, {
      changes: [{ ...restate, invoiceDueMonth: "2027-03" }],
    });
    expect(moved).toMatchObject({ applicable: false, reason: UNRESOLVED });
    expect(
      moved.staleDerivedDependents.map((d: any) => [d.current, d.candidate]),
    ).toEqual([
      ["2026-12", "2027-04"],
      ["2027-01", "2027-05"],
    ]);
  });

  it("C10 guard: a client cannot supply proof for a disposition", async () => {
    const { scope, dependents, change } = await correctionFixture();
    const forged = {
      cashFlowEntryId: dependents[0].id,
      action: "rederive",
      evidence: { evidenceKind: "derived-sequential" },
    };
    await expect(
      preview(scope, { changes: [change()], dependentDispositions: [forged] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("C11 control: a legacy sparse schedule (no derived proof) has no dependents and corrects as today", async () => {
    const { scope, dependents, change } = await correctionFixture();
    // Rebuild the legacy shape regardless of what the writer emits.
    const row = await source();
    const legacy: any = JSON.parse(row.documentedSchedule!);
    legacy.occurrences.slice(1).forEach((o: any) => {
      o.invoiceDueMonth = null;
      o.cycleEvidence = null;
    });
    await setup.expense.update({
      where: { id: row.id },
      data: { documentedSchedule: JSON.stringify(legacy) },
    });
    await setup.cashFlowEntry.updateMany({
      where: { id: { in: dependents.map((d) => d.id) } },
      data: { invoiceDueMonth: null },
    });
    const result: any = await preview(scope, { changes: [change()] });
    expect(result.applicable).toBe(true);
    expect(result).not.toHaveProperty("staleDerivedDependents");
    await apply(scope, { changes: [change()] }, result.fingerprint);
    expect((await source()).cashFlow.map((c) => c.invoiceDueMonth)).toEqual([
      "2026-12",
      null,
      null,
    ]);
  });
});
