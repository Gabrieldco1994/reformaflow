require("../../../../scripts/test-db-env.cjs");

import { PrismaClient } from "@prisma/client";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { attachDedupeKeys } from "../import-dedupe/cross-origin-dedupe";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import { PrismaService } from "../prisma/prisma.service";
import {
  pessoalRequester,
  resetTenant,
  seedCardWithClosingDue,
  seedPessoal,
} from "../bank-account/__tests__/invoice-undo.fixtures";
import { CreditCardService } from "./credit-card.service";
import { parseStatement } from "./parsers";

/**
 * P01 preview policy: an invoice-payment line ("PAGAMENTO EFETUADO", ...) is
 * never created by the import, so the PREVIEW must not promise it. `ignored`
 * is a presentation/selection signal computed from the ORIGINAL merchant with
 * the same pattern the commit uses; it is independent of Tier B metadata and
 * loses only to a strong duplicate. It is not a promise of any legacy commit
 * outcome; the guaranteed property is that no expense is ever created.
 * Entry point: `CreditCardService.previewImport/commitImport` with a real
 * PrismaService (service-level, NOT HTTP: no controller, guards or multipart
 * here). Raw Prisma only seeds/reads.
 */
const TENANT = "qa-p01-payment-preview";
const PROJECT = `${TENANT}-pessoal`;
const ACTOR = { ...pessoalRequester(PROJECT), id: `${TENANT}-actor` };
const CLOCK = new Date("2026-09-28T12:00:00.000Z");
// Pinned literally: the producer will read the domain constant, the barrier must not.
const IGNORED = "INVOICE_PAYMENT";

const PAY_POS = "2026-09-03,PAGAMENTO EFETUADO,50.00";
const PAY_NEG = "2026-09-03,PAGAMENTO EFETUADO,-50.00";
const PAY_FAT = "2026-09-04,PGTO FAT 08/2026,30.00";
const PAY_FATURA = "2026-09-05,FATURA PAGA,20.00";
const PAY_PIX = "2026-09-06,PAGAMENTO PIX,25.00";
const BUY = "2026-09-07,QA MERCADO BAIRRO,10.00";
const NOT_PAYMENT = "2026-09-08,PAGAMENTO CONTA,15.00";
const PAYMENTS = [PAY_POS, PAY_NEG, PAY_FAT, PAY_FATURA, PAY_PIX];

describe("P01 card import preview: invoice-payment policy (server contract)", () => {
  const setup = new PrismaClient();
  const prisma = new PrismaService();
  const cards = new CreditCardService(
    prisma,
    new ConciliacaoService(prisma),
    new MerchantClassifierService(prisma),
  );
  let cardId: string;

  const doc = (...rows: string[]) => `date,title,amount\n${rows.join("\n")}\n`;
  const parse = (row: string) =>
    parseStatement(doc(row), cardId, "CSV_GENERIC", "s.csv").transactions[0]!;
  const idOf = (row: string) => parse(row).externalId;
  const previewOf = (csv: string): Promise<any> =>
    cards.previewImport(
      TENANT,
      PROJECT,
      cardId,
      csv,
      "s.csv",
      "CSV_GENERIC",
      undefined,
      ACTOR,
    ) as Promise<any>;
  const rowOf = async (row: string): Promise<any> =>
    (await previewOf(doc(row))).preview[0];
  const commit = (
    csv: string,
    decisions?: unknown,
    selected?: unknown,
  ): Promise<any> =>
    cards.commitImport(
      TENANT,
      PROJECT,
      cardId,
      csv,
      "s.csv",
      "CSV_GENERIC",
      undefined,
      undefined,
      decisions,
      ACTOR.id,
      ACTOR,
      selected,
    );
  const outcomes = (res: any): Record<string, string> =>
    Object.fromEntries(
      (res.lineResults ?? []).map((r: any) => [r.externalId, r.outcome]),
    );
  const expenses = () =>
    setup.expense.findMany({
      where: { tenantId: TENANT },
      orderBy: { id: "asc" },
      include: { cashFlow: { orderBy: { id: "asc" } } },
    });
  const imports = () =>
    setup.creditCardStatementImport.count({ where: { tenantId: TENANT } });

  /** A legitimate witness of the SAME line: same external id (a strong identity). */
  const seedStrongWitness = (row: string) =>
    setup.expense.create({
      data: {
        tenantId: TENANT,
        projectId: PROJECT,
        tipoDespesa: "OUTROS",
        titulo: "testemunha forte",
        valor: 100,
        valorTotal: 100,
        quantidade: 1,
        formaPagamento: "A_VISTA",
        status: "PLANEJADO",
        origin: "import",
        externalId: idOf(row),
      },
    });
  /** A line of ANOTHER origin that matches only the natural key (Tier B). */
  const seedTierBWitness = async (row: string) => {
    const parsed = parseStatement(doc(row), cardId, "CSV_GENERIC", "s.csv");
    attachDedupeKeys(parsed.transactions, {
      tenantId: TENANT,
      projectId: PROJECT,
      fileContentHash: "payment-preview",
    });
    return setup.expense.create({
      data: {
        tenantId: TENANT,
        projectId: PROJECT,
        tipoDespesa: "OUTROS",
        titulo: "outra origem",
        valor: 100,
        valorTotal: 100,
        quantidade: 1,
        formaPagamento: "A_VISTA",
        status: "PLANEJADO",
        origin: "import",
        dedupeKeyNatural: parsed.transactions[0]!.dedupeKeyNatural ?? null,
      },
    });
  };

  beforeAll(async () => {
    await prisma.$connect();
    await setup.$connect();
  });
  beforeEach(async () => {
    jest.useFakeTimers({
      now: CLOCK,
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
    await resetTenant(setup, TENANT);
    await seedPessoal(setup, { tenantId: TENANT, projectId: PROJECT });
    ({ id: cardId } = await seedCardWithClosingDue(setup, {
      tenantId: TENANT,
      projectId: PROJECT,
      last4: "0718",
      closingDay: 20,
      dueDay: 10,
    }));
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await resetTenant(setup, TENANT);
    await prisma.$disconnect();
    await setup.$disconnect();
  });

  // ── B1. Patterns ─────────────────────────────────────────────────────────

  it("classifies_the_existing_payment_literals_once_for_direct_and_Maria_paths", async () => {
    for (const title of [
      "PAGAMENTO EFETUADO",
      "PAGAMENTO PIX",
      "PGTO FAT",
      "FATURA PAG",
    ]) {
      await expect(rowOf(`2026-09-03,${title},50.00`)).resolves.toMatchObject({
        ignored: IGNORED,
        willImport: false,
      });
    }
    await expect(rowOf(BUY)).resolves.toMatchObject({
      ignored: null,
      willImport: true,
    });
  });

  it("B1: every invoice-payment pattern is ignored, not willImport, not duplicate, no review; ordinary and look-alike lines are untouched; totals stay factual", async () => {
    const all = [...PAYMENTS, BUY, NOT_PAYMENT];
    const res = await previewOf(doc(...all));
    const byId = new Map<string, any>(
      res.preview.map((p: any) => [p.externalId, p]),
    );
    expect(res.preview).toHaveLength(all.length);
    for (const row of PAYMENTS) {
      const line = byId.get(idOf(row));
      // precondition: the row really reached the preview as this payment
      expect(line).toBeDefined();
      expect(line.duplicate).toBe(false);
      expect(line.review).toBeNull();
      expect(line.ignored).toBe(IGNORED);
      expect(line.willImport).toBe(false);
    }
    for (const row of [BUY, NOT_PAYMENT]) {
      const line = byId.get(idOf(row));
      expect(line).toBeDefined();
      expect(line.ignored).toBeNull();
      expect(line.willImport).toBe(true);
    }
    // `total` / `totalAmountCents` stay the FACTUAL file numbers; `duplicated` is Tier A only
    expect(res.total).toBe(all.length);
    expect(res.duplicated).toBe(0);
    expect(res.totalAmountCents).toBe(
      res.preview.reduce((sum: number, p: any) => sum + p.amountCents, 0),
    );
    // no new counter, and the wire carries the signal per line only
    expect(Object.keys(res).sort()).toEqual(
      [
        "classificationStatus",
        "duplicated",
        "futureInstallments",
        "inserted",
        "periodLabel",
        "possibleDuplicates",
        "preview",
        "source",
        "total",
        "totalAmountCents",
      ].sort(),
    );
    expect(await imports()).toBe(0);
  });

  // ── B2. Zero creation (legacy commit, no selection) ──────────────────────

  it("B2: a legacy commit without selection creates nothing for an ignored line and creates the ordinary purchases", async () => {
    const res = await commit(doc(...PAYMENTS, BUY, NOT_PAYMENT));
    const out = outcomes(res);
    expect(out[idOf(BUY)]).toBe("CREATED");
    expect(out[idOf(NOT_PAYMENT)]).toBe("CREATED");
    for (const row of PAYMENTS) expect(out[idOf(row)]).not.toBe("CREATED");
    const rows = await expenses();
    expect(rows.map((r) => r.externalId).sort()).toEqual(
      [idOf(BUY), idOf(NOT_PAYMENT)].sort(),
    );
    // only the two purchases carry an import stamp
    expect(rows.every((r) => r.importId)).toBe(true);
    expect(res.inserted).toBe(2);
  });

  // ── B3. Crossing with duplicate tiers ────────────────────────────────────

  it("B3a: a strong duplicate wins over the policy: duplicate:true, ignored:null, willImport:false, commit DUPLICATED", async () => {
    const witness = await seedStrongWitness(PAY_POS);
    const line = await rowOf(PAY_POS);
    expect(line.duplicate).toBe(true);
    expect(line.ignored).toBeNull();
    expect(line.willImport).toBe(false);
    expect(witness.externalId).toBe(idOf(PAY_POS));
  });

  it("B3a (commit): a strong-duplicate payment is DUPLICATED and writes nothing", async () => {
    const witness = await seedStrongWitness(PAY_POS);
    const before = await expenses();
    const res = await commit(doc(PAY_POS));
    expect(outcomes(res)[idOf(PAY_POS)]).toBe("DUPLICATED");
    expect(await expenses()).toEqual(before);
    expect(before.map((r) => r.id)).toEqual([witness.id]);
  });

  it("B3b: payment + Tier B keeps the Tier B metadata AND is ignored", async () => {
    const witness = await seedTierBWitness(PAY_POS);
    const line = await rowOf(PAY_POS);
    // precondition: the Tier B witness is really matched
    expect(line.possibleDuplicate).toMatchObject({ existingId: witness.id });
    expect(line.duplicate).toBe(false);
    expect(line.review).toBeNull();
    expect(line.ignored).toBe(IGNORED);
    expect(line.willImport).toBe(false);
  });

  it("B3b (commit): payment + Tier B without a decision is POSSIBLE_DUPLICATE, and with `import` is SKIPPED; neither creates anything", async () => {
    await seedTierBWitness(PAY_POS);
    const before = await expenses();
    const undecided = await commit(doc(PAY_POS));
    expect(outcomes(undecided)[idOf(PAY_POS)]).toBe("POSSIBLE_DUPLICATE");
    expect(await expenses()).toEqual(before);

    const forced = await commit(doc(PAY_POS), [
      { externalId: idOf(PAY_POS), action: "import" },
    ]);
    expect(outcomes(forced)[idOf(PAY_POS)]).toBe("SKIPPED");
    expect(await expenses()).toEqual(before);
  });

  it("B3c: control — an ordinary purchase + Tier B is NOT ignored and keeps its Tier B metadata", async () => {
    const witness = await seedTierBWitness(BUY);
    const line = await rowOf(BUY);
    expect(line.possibleDuplicate).toMatchObject({ existingId: witness.id });
    expect(line.ignored).toBeNull();
    expect(line.willImport).toBe(false);
    expect(line.duplicate).toBe(false);
  });

  // ── B4. Attempt selection ────────────────────────────────────────────────

  it("B4: selecting only the purchase creates it and leaves the payments NOT_SELECTED; payments are never CREATED, not even when forced with overrides", async () => {
    const file = doc(PAY_POS, PAY_NEG, BUY);
    const first = await commit(file, undefined, [idOf(BUY)]);
    expect(outcomes(first)).toEqual({
      [idOf(PAY_POS)]: "NOT_SELECTED",
      [idOf(PAY_NEG)]: "NOT_SELECTED",
      [idOf(BUY)]: "CREATED",
    });
    let rows = await expenses();
    expect(rows.map((r) => r.externalId)).toEqual([idOf(BUY)]);

    // retry limited to the pending (payment) ids never creates them
    const retry = await commit(file, undefined, [idOf(PAY_POS), idOf(PAY_NEG)]);
    for (const row of [PAY_POS, PAY_NEG])
      expect(outcomes(retry)[idOf(row)]).not.toBe("CREATED");
    expect(outcomes(retry)[idOf(BUY)]).toBe("NOT_SELECTED");
    expect((await expenses()).map((r) => r.externalId)).toEqual([idOf(BUY)]);

    // a legacy client forcing the payment with overrides still creates nothing
    const forced = await commit(
      doc(PAY_POS),
      [
        {
          externalId: idOf(PAY_POS),
          action: "import",
          overrides: { valorCents: 4200, titulo: "QA MERCADO RENOMEADO" },
        },
      ],
      [idOf(PAY_POS)],
    );
    expect(outcomes(forced)[idOf(PAY_POS)]).not.toBe("CREATED");
    rows = await expenses();
    expect(rows.map((r) => r.externalId)).toEqual([idOf(BUY)]);
    expect(rows.every((r) => r.titulo !== "QA MERCADO RENOMEADO")).toBe(true);
  });
});
