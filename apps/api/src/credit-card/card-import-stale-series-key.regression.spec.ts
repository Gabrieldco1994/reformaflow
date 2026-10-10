require("../../../../scripts/test-db-env.cjs");

import { PrismaClient } from "@prisma/client";
import {
  bankOfx,
  ofxDebit,
  pessoalRequester,
  resetTenant,
  seedCardWithClosingDue,
  seedPessoal,
  seedProject,
} from "../bank-account/__tests__/invoice-undo.fixtures";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import { PrismaService } from "../prisma/prisma.service";
import { CreditCardService } from "./credit-card.service";
import { ExpenseService } from "../expense/expense.service";

/**
 * P01 (#714 independent review): installment x installment admission.
 *
 * Two installment purchases at the same card+merchant whose DOCUMENTED full
 * counts are provably different (3/10 vs 1/3) are different purchases. The
 * preview says they are importable; commit must agree. Controls pin every
 * guard that must NOT relax: same full count, remaining-only legacy counts,
 * contradictory explicit counts and strong external identity.
 */
const TENANT = "qa-p01-stale-series-key";
const PROJECT = `${TENANT}-pessoal`;
const OTHER_PROJECT = `${TENANT}-outro`;
const LAST4 = "0714";
const REQUESTER = { ...pessoalRequester(PROJECT), id: `${TENANT}-actor` };
const OLD_DOCUMENT = bankOfx(
  LAST4,
  ofxDebit("20260105120000", 10000, "QA LOJA PARC 3/10", "canonical-3of10-fit"),
);

const NEW_DOCUMENT = bankOfx(
  LAST4,
  ofxDebit("20260928120000", 5000, "QA LOJA PARC 1/3", "new-1of3-fit"),
);

describe("P01 D1: a stale seriesKey total (after a native ExpenseService.update) cannot prove independence", () => {
  const setup = new PrismaClient();
  const prisma = new PrismaService();
  const cards = new CreditCardService(
    prisma,
    new ConciliacaoService(prisma),
    new MerchantClassifierService(prisma),
  );
  const expenses = new ExpenseService(prisma, new ConciliacaoService(prisma));
  let cardId: string;
  let oldExpenseId: string;
  let warn: jest.SpyInstance;

  const commit = (document: Buffer, fileName: string) =>
    cards.commitImport(
      TENANT,
      PROJECT,
      cardId,
      document,
      fileName,
      "OFX",
      undefined,
      undefined,
      undefined,
      REQUESTER.id,
      REQUESTER,
    );
  const readOld = async () => {
    const row = await setup.expense.findUniqueOrThrow({
      where: { id: oldExpenseId },
      include: {
        cashFlow: { where: { deletedAt: null }, orderBy: { parcela: "asc" } },
      },
    });
    return {
      titulo: row.titulo,
      valor: row.valor,
      valorTotal: row.valorTotal,
      quantidadeParcela: row.quantidadeParcela,
      seriesKey: row.seriesKey,
      documentedSchedule: row.documentedSchedule,
      activeCfeLabels: row.cashFlow.map((c) => c.parcela),
    };
  };

  beforeAll(async () => {
    await setup.$connect();
    await prisma.$connect();
  });
  beforeEach(async () => {
    jest.useFakeTimers({
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
    jest.setSystemTime(new Date("2026-09-28T12:00:00.000Z"));
    warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    await resetTenant(setup, TENANT);
    await seedPessoal(setup, { tenantId: TENANT, projectId: PROJECT });
    await seedProject(setup, {
      tenantId: TENANT,
      projectId: OTHER_PROJECT,
      type: "PESSOAL",
      name: "Outro",
    });
    ({ id: cardId } = await seedCardWithClosingDue(setup, {
      tenantId: TENANT,
      projectId: PROJECT,
      last4: LAST4,
      closingDay: 27,
      dueDay: 5,
    }));
    const imported = await commit(OLD_DOCUMENT, "canonical-series.ofx");
    expect(imported).toMatchObject({ inserted: 1, skipped: 0 });
    oldExpenseId = (
      await setup.expense.findFirstOrThrow({
        where: { tenantId: TENANT, importId: imported.importId },
      })
    ).id;
    warn.mockClear();
  });
  afterEach(async () => {
    warn.mockRestore();
    try {
      await resetTenant(setup, TENANT);
    } finally {
      jest.useRealTimers();
    }
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await setup.$disconnect();
  });

  const editedRow = async (dto: Record<string, unknown>) => {
    await expenses.update(
      TENANT,
      PROJECT,
      oldExpenseId,
      dto as never,
      REQUESTER,
    );
    const row = await readOld();
    // Fixture preconditions (the hypothesis, not the behavior under test): the
    // native edit is accepted, the key keeps total 10, active labels are 1/3..3/3.
    expect(row.quantidadeParcela).toBe(3);
    expect(row.seriesKey).toMatch(/\|10000\|10$/);
    expect(row.activeCfeLabels).toEqual(["1/3", "2/3", "3/3"]);
    return row;
  };
  const liveRows = () =>
    setup.expense.count({ where: { tenantId: TENANT, deletedAt: null } });

  // Contract: a stale key total (10) must not alone make the new 1/3 line a
  // different purchase. Cash flow now says 3 installments, so the cohort stays
  // conservative: commit skips the line instead of duplicating the purchase.
  it.each([
    ["title keeps the (3/10) marker", { quantidadeParcela: 3 }],
    ["title marker removed", { quantidadeParcela: 3, titulo: "QA LOJA" }],
  ])(
    "edited 8 -> 3, %s: the new 1/3 line is not admitted",
    async (_name, dto) => {
      await editedRow(dto);
      const before = await readOld();
      const result = await commit(NEW_DOCUMENT, "stale.ofx");
      expect(result).toMatchObject({ inserted: 0, skipped: 1, duplicated: 0 });
      expect(await liveRows()).toBe(1);
      expect(await readOld()).toEqual(before);
    },
  );

  it("control: unedited 3/10 keeps admitting a different 1/3 purchase", async () => {
    const result = await commit(NEW_DOCUMENT, "control.ofx");
    expect(result).toMatchObject({ inserted: 1, skipped: 0, duplicated: 0 });
    expect(await liveRows()).toBe(2);
  });
});
