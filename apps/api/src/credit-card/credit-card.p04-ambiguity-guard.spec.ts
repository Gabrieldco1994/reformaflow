require("../../../../scripts/test-db-env.cjs");

import { PrismaClient } from "@prisma/client";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import { PrismaService } from "../prisma/prisma.service";
import {
  pessoalRequester,
  resetTenant,
  seedCardWithClosingDue,
  seedPessoal,
} from "../bank-account/__tests__/invoice-undo.fixtures";
import * as identity from "./card-purchase-identity";
import { CreditCardService } from "./credit-card.service";
import { parseStatement } from "./parsers";

/**
 * P04 owner tests that the frozen QA specs do not cover: the ambiguity sentinel
 * fail-safe (reuse saw >= 2 candidate roots but the classifier disagrees =>
 * BLOCKED, never a create) and the pure sibling helpers. Real PrismaService and
 * CSV parser; the classifier is only stubbed in the divergence test, after the
 * unstubbed positive precondition.
 */
const TENANT = "qa-p04-ambiguity-guard";
const PROJECT = `${TENANT}-pessoal`;
const ACTOR = { ...pessoalRequester(PROJECT), id: `${TENANT}-actor` };
const CLOCK = new Date("2026-09-28T12:00:00.000Z");
const FIRST = "2026-09-05,QA GEMEA LOJA 1/10,69.84";
const SECOND = "2026-10-05,QA GEMEA LOJA 2/10,69.84";

describe("P04 ambiguity guard and sibling helpers", () => {
  const setup = new PrismaClient();
  const prisma = new PrismaService();
  const cards = new CreditCardService(
    prisma,
    new ConciliacaoService(prisma),
    new MerchantClassifierService(prisma),
  );
  let cardId: string;

  const doc = (...rows: string[]) => `date,title,amount\n${rows.join("\n")}\n`;
  const commit = (csv: string, decisions?: unknown, selected?: string[]) =>
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
  const everything = () =>
    setup.expense.findMany({
      where: { tenantId: TENANT },
      orderBy: { id: "asc" },
      include: { cashFlow: { orderBy: { id: "asc" } } },
    });
  /** Two live nominal roots of one series: a real commit and an exact clone. */
  const seedTwoRoots = async () => {
    await commit(doc(FIRST));
    const base = await setup.expense.findFirstOrThrow({
      where: { tenantId: TENANT },
      include: { cashFlow: true },
    });
    const { id: _id, createdAt: _c, updatedAt: _u, cashFlow, ...row } = base;
    const clone = await setup.expense.create({
      data: {
        ...row,
        externalId: "guard-x2",
        dedupeKeyStrong: "guard-strong-2",
      },
    });
    for (const entry of cashFlow) {
      const {
        id: _e,
        createdAt: _ec,
        updatedAt: _eu,
        expenseId: _x,
        ...rest
      } = entry;
      await setup.cashFlowEntry.create({
        data: { ...rest, expenseId: clone.id },
      });
    }
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
      last4: "0719",
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

  it.each([
    ["CLEAR", { kind: "CLEAR" }],
    ["BLOCKED sameSeries", { kind: "BLOCKED", sameSeries: true }],
  ] as const)(
    "reuse saw two candidate roots but the classifier answered %s: the line is BLOCKED and nothing is written or created",
    async (_name, answer) => {
      await seedTwoRoots();
      // positive precondition: the real classifier answers REVIEW for this state
      const real = await commit(doc(SECOND));
      expect(real.lineResults.map((l) => l.outcome)).toEqual([
        "REVIEW_REQUIRED",
      ]);

      const before = await everything();
      jest
        .spyOn(identity, "classifyCardImport")
        .mockResolvedValue(answer as identity.ImportAdmission);
      const res = await commit(doc(SECOND));
      expect(res.lineResults.map((l) => l.outcome)).toEqual(["BLOCKED"]);
      expect(res).toMatchObject({ inserted: 0, settled: 0 });
      expect(await everything()).toEqual(before);
    },
  );

  it.each([
    ["ordinal 0 first", 0, 1],
    ["ordinal 1 first", 1, 0],
  ])(
    "selection: the twins sent one at a time (%s) still make TWO purchases, because siblinghood is read from the whole document",
    async (_name, firstIdx, secondIdx) => {
      const csv = doc(FIRST, FIRST);
      const ids = parseStatement(
        csv,
        cardId,
        "CSV_GENERIC",
        "s.csv",
      ).transactions.map((t) => t.externalId);
      const one = await commit(csv, undefined, [ids[firstIdx]!]);
      expect(
        one.lineResults.find((l) => l.externalId === ids[firstIdx])!.outcome,
      ).toBe("CREATED");
      const two = await commit(csv, undefined, [ids[secondIdx]!]);
      expect(
        two.lineResults.find((l) => l.externalId === ids[secondIdx])!.outcome,
      ).toBe("CREATED");
      const roots = await everything();
      expect(roots.map((r) => r.externalId).sort()).toEqual([...ids].sort());
      expect(roots.map((r) => r.cashFlow.length)).toEqual([10, 10]);
    },
  );

  it("occurrenceGroups keys every installment line by its current, ignores single payments, and a line is never its own sibling", () => {
    const groups = identity.occurrenceGroups([
      { externalId: "a", installmentCurrent: 2, installmentTotal: 10 },
      { externalId: "b", installmentCurrent: 2, installmentTotal: 10 },
      { externalId: "c", installmentCurrent: null, installmentTotal: 3 },
      { externalId: "d", installmentCurrent: 1, installmentTotal: 1 },
      { externalId: "e", installmentCurrent: 5, installmentTotal: null },
    ]);
    expect([...groups.entries()].map(([k, v]) => [k, [...v].sort()])).toEqual([
      [2, ["a", "b"]],
      [1, ["c"]],
    ]);
    const forA = identity.siblingPredicate(groups, {
      externalId: "a",
      current: 2,
    });
    expect(forA("b")).toBe(true);
    expect(forA("a")).toBe(false);
    expect(forA("c")).toBe(false);
    expect(forA("zzz")).toBe(false);
  });

  it("the real parser puts both twin lines of one document in the same occurrence group", () => {
    const txs = parseStatement(
      doc(SECOND, SECOND),
      cardId,
      "CSV_GENERIC",
      "s.csv",
    ).transactions;
    const groups = identity.occurrenceGroups(txs);
    expect(txs).toHaveLength(2);
    expect([...(groups.get(2) ?? [])].sort()).toEqual(
      txs.map((t) => t.externalId).sort(),
    );
  });
});
