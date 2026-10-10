require("../../../../scripts/test-db-env.cjs");

import { BadRequestException, ConflictException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Prisma, PrismaClient } from "@prisma/client";
import { ConciliacaoService } from "../conciliacao/conciliacao.service";
import { attachDedupeKeys } from "../import-dedupe/cross-origin-dedupe";
import { MerchantClassifierService } from "../merchant-classifier/merchant-classifier.service";
import { PrismaService } from "../prisma/prisma.service";
import {
  ADMIN_REQUESTER,
  pessoalRequester,
  resetTenant,
  seedCardWithClosingDue,
  seedPessoal,
  seedProject,
} from "../bank-account/__tests__/invoice-undo.fixtures";
import { CreditCardController } from "./credit-card.controller";
import { CreditCardService } from "./credit-card.service";
import { parseStatement } from "./parsers";

/**
 * P01 REVIEW: a new installment line with the SAME full count and card as a
 * live purchase but a DIFFERENT per-installment amount is neither a duplicate
 * nor proven independent. The server asks (REVIEW_REQUIRED) instead of
 * silently skipping, and only a decision bound to the reviewed state
 * (reviewFingerprint) inserts it, leaving the old purchase untouched.
 * Strong identities, Receipt, foreign/deleted evidence and identical-key twins
 * keep their current behavior. Real PrismaService; raw Prisma only seeds/reads.
 */
const TENANT = "qa-p01-import-review";
const PROJECT = `${TENANT}-pessoal`;
const OTHER_PROJECT = `${TENANT}-outra`;
const ACTOR = { ...pessoalRequester(PROJECT), id: `${TENANT}-actor` };
const SECRET = "SEGREDO-OCULTO";
const HEX64 = /^[0-9a-f]{64}$/;
const REQUIRED = "REVIEW_REQUIRED";
const STALE = "REVIEW_STALE";
const BLOCKED = "BLOCKED_IDENTITY";
const OLD = "2026-01-05,QA LOJA RECORRENTE 1/10,100.00";
const NEW = "2026-09-10,QA LOJA RECORRENTE 1/10,150.00";
// The closed contract: exactly these keys, no prose.
const CONFLICT_KEYS = ["code", "missingCount", "missingExternalIds"];
const CLOCK = new Date("2026-09-28T12:00:00.000Z");

describe("P01 card import REVIEW (server contract)", () => {
  const setup = new PrismaClient();
  const prisma = new PrismaService();
  const cards = new CreditCardService(
    prisma,
    new ConciliacaoService(prisma),
    new MerchantClassifierService(prisma),
  );
  let cardId: string;
  let raceTitle: string | null = null;
  // Real write failure: after the matching Expense is created, the NEXT cash
  // flow write throws, so the whole line transaction must roll back.
  let failTitle: string | null = null;
  let failArmed = false;
  let actor: any = ACTOR;
  // Runs right after the import record exists, i.e. after the batch dedupe read.
  let afterImportRecord: (() => Promise<void>) | null = null;

  prisma.$use(async (params, next) => {
    if (failTitle && params.model === "Expense" && params.action === "create") {
      if (String(params.args?.data?.titulo ?? "").includes(failTitle))
        failArmed = true;
    }
    if (
      failArmed &&
      params.model === "CashFlowEntry" &&
      params.action === "create"
    ) {
      failArmed = false;
      throw new Error("synthetic write failure");
    }
    if (
      afterImportRecord &&
      params.model === "CreditCardStatementImport" &&
      params.action === "create"
    ) {
      const result = await next(params);
      const hook = afterImportRecord;
      afterImportRecord = null;
      await hook();
      return result;
    }
    if (
      raceTitle &&
      params.model === "Expense" &&
      params.action === "create" &&
      String(params.args?.data?.titulo ?? "").includes(raceTitle)
    )
      throw new Prisma.PrismaClientKnownRequestError("synthetic race", {
        code: "P2002",
        clientVersion: "synthetic",
        meta: { target: ["dedupe_key_strong"] },
      });
    return next(params);
  });

  const doc = (...rows: string[]) => `date,title,amount\n${rows.join("\n")}\n`;
  const idOf = (row: string) =>
    parseStatement(doc(row), cardId, "CSV_GENERIC", "s.csv").transactions[0]!
      .externalId;
  // `selected` is the trailing selectedExternalIds argument (not typed yet in RED).
  const commit = (
    csv: string,
    decisions?: unknown,
    selected?: unknown,
  ): Promise<any> =>
    (cards as any).commitImport(
      TENANT,
      PROJECT,
      cardId,
      csv,
      "s.csv",
      "CSV_GENERIC",
      undefined,
      undefined,
      decisions as never,
      actor.id,
      actor,
      selected,
    );
  const preview = (csv: string) =>
    cards.previewImport(
      TENANT,
      PROJECT,
      cardId,
      csv,
      "s.csv",
      "CSV_GENERIC",
      undefined,
      ACTOR,
    );
  const rowOf = async (csv: string, at = 0): Promise<any> =>
    ((await preview(csv)) as any).preview[at];
  const roots = () =>
    setup.expense.findMany({
      where: { tenantId: TENANT },
      orderBy: { id: "asc" },
      include: { cashFlow: { orderBy: { id: "asc" } } },
    });
  const live = async () => (await roots()).filter((r) => !r.deletedAt);
  const oldRoot = async () =>
    setup.expense.findFirstOrThrow({
      where: { tenantId: TENANT, externalId: idOf(OLD) },
      include: { cashFlow: { orderBy: { id: "asc" } } },
    });
  const lineOutcomes = (res: any): Record<string, string> => {
    const map: Record<string, string> = {};
    for (const r of res.lineResults ?? []) map[r.externalId] = r.outcome;
    return map;
  };
  /** A planned single purchase of another project that a card line can be linked to. */
  const plannedTarget = async (name: string, valor: number) => {
    if (!(await setup.project.findUnique({ where: { id: OTHER_PROJECT } })))
      await seedProject(setup, {
        tenantId: TENANT,
        projectId: OTHER_PROJECT,
        type: "REFORMA",
        name: "Reforma",
      });
    const when = new Date("2026-09-20T00:00:00.000Z");
    const target = await setup.expense.create({
      data: {
        tenantId: TENANT,
        projectId: OTHER_PROJECT,
        tipoDespesa: "MATERIAL_CONSTRUCAO",
        titulo: `${SECRET} ${name}`,
        fornecedor: "Loja",
        valor,
        quantidade: 1,
        valorTotal: valor,
        formaPagamento: "A_VISTA",
        dataInicioParcela: when,
        status: "PLANEJADO",
      },
    });
    await setup.cashFlowEntry.create({
      data: {
        tenantId: TENANT,
        projectId: OTHER_PROJECT,
        expenseId: target.id,
        valor,
        tipo: "DESPESA",
        data: when,
        categoria: "MATERIAL_CONSTRUCAO",
        formaPagamento: "A_VISTA",
        status: "PLANEJADO",
      },
    });
    return target;
  };
  const settleSpy = () =>
    jest.spyOn(ConciliacaoService.prototype, "assertCanSettleTargets");
  const linkedIds = (res: any): string[] =>
    (res.lineResults ?? [])
      .filter((r: any) => r.linked === true)
      .map((r: any) => r.externalId);
  /** Everything a finished round wrote, including timestamps, for byte-identity checks. */
  const financialState = async () => ({
    roots: await roots(),
    targets: await setup.expense.findMany({
      where: { tenantId: TENANT, projectId: OTHER_PROJECT },
      orderBy: { id: "asc" },
      include: { cashFlow: { orderBy: { id: "asc" } } },
    }),
    settlements: await setup.crossProjectSettlement.findMany({
      where: { tenantId: TENANT },
      orderBy: { id: "asc" },
    }),
  });
  const importCount = () =>
    setup.creditCardStatementImport.count({ where: { tenantId: TENANT } });

  /** Positive precondition + fingerprint of the current review of NEW. */
  async function reviewedFingerprint(csv = doc(NEW)): Promise<string> {
    const { review } = await rowOf(csv);
    expect(review ?? null).not.toBeNull();
    expect(review).toMatchObject({ reason: REQUIRED });
    expect(review.fingerprint).toMatch(HEX64);
    return review.fingerprint;
  }
  const withFp = (fingerprint: string, extra: object = {}) => [
    {
      externalId: idOf(NEW),
      action: "import",
      reviewFingerprint: fingerprint,
      ...extra,
    },
  ];

  beforeAll(async () => {
    await prisma.$connect();
    await setup.$connect();
  });
  beforeEach(async () => {
    raceTitle = null;
    failTitle = null;
    failArmed = false;
    actor = ACTOR;
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
      last4: "0717",
      closingDay: 20,
      dueDay: 10,
    }));
    await commit(doc(OLD));
    expect((await live()).map((r) => r.cashFlow.length)).toEqual([10]);
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

  // ── P. Preview classifies persisted families ─────────────────────────────

  it("P1: preview puts the line in REVIEW with a public-safe same-project candidate and willImport=false", async () => {
    const old = await oldRoot();
    const row = await rowOf(doc(NEW));
    expect(row.willImport).toBe(false);
    expect(row.review).toEqual({
      externalId: idOf(NEW),
      reason: REQUIRED,
      fingerprint: expect.stringMatching(HEX64),
      candidates: [
        {
          expenseId: old.id,
          titulo: old.titulo,
          installmentCount: 10,
          seriesAmountCents: 10000,
          dataCompra: "2026-01-05",
        },
      ],
    });
    const json = JSON.stringify(row.review);
    for (const leak of ["cashFlow", "tenantId", "projectId", "hidden"])
      expect(json).not.toContain(leak);
  });

  it("P2 controls: an unrelated line, a different-N line and an identical-key twin carry no review", async () => {
    for (const line of [
      "2026-09-10,QA OUTRA LOJA 1/10,150.00",
      "2026-09-10,QA LOJA RECORRENTE 1/3,150.00",
      "2026-09-10,QA LOJA RECORRENTE 1/10,100.00",
    ]) {
      const row = await rowOf(doc(line));
      expect(row.review ?? null).toBeNull();
      expect(row.willImport).toBe(true);
    }
  });

  it("P3: the fingerprint does not depend on the process time zone", async () => {
    const zone = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      const utc = await reviewedFingerprint();
      process.env.TZ = "America/Sao_Paulo";
      expect(await reviewedFingerprint()).toBe(utc);
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });

  it("P4: a family of another project is BLOCKED with no candidate, never a REVIEW that leaks it", async () => {
    await seedProject(setup, {
      tenantId: TENANT,
      projectId: OTHER_PROJECT,
      type: "CASA",
      name: "Outra",
    });
    const old = await oldRoot();
    await setup.expense.update({
      where: { id: old.id },
      data: { projectId: OTHER_PROJECT },
    });
    await setup.cashFlowEntry.updateMany({
      where: { expenseId: old.id },
      data: { projectId: OTHER_PROJECT },
    });
    const row = await rowOf(doc(NEW));
    expect(row.willImport).toBe(false);
    expect(row.review).toEqual({
      externalId: idOf(NEW),
      reason: BLOCKED,
      fingerprint: null,
      candidates: [],
    });
    const res: any = await commit(doc(NEW), withFp("a".repeat(64)));
    expect(res.skippedItems).toEqual([
      { externalId: idOf(NEW), reason: BLOCKED },
    ]);
    expect(res.inserted).toBe(0);
  });

  // ── C. Commit: explicit review, then a bound decision inserts ────────────

  it("C1: without a decision the line is reviewRequired (real candidate, same fingerprint), never a silent skip", async () => {
    const fingerprint = await reviewedFingerprint();
    const before = await roots();
    const res: any = await commit(doc(NEW));
    expect(res).toMatchObject({ inserted: 0, skipped: 0, skippedItems: [] });
    expect(res.reviewRequired).toEqual([
      {
        externalId: idOf(NEW),
        reason: REQUIRED,
        fingerprint,
        candidates: [
          expect.objectContaining({ expenseId: (await oldRoot()).id }),
        ],
      },
    ]);
    expect(await roots()).toEqual(before);
  });

  it("C2: a decision bound to the reviewed fingerprint inserts the new purchase and leaves the old one untouched", async () => {
    const fingerprint = await reviewedFingerprint();
    const oldBefore = await oldRoot();
    const res: any = await commit(doc(NEW), withFp(fingerprint));
    expect(res).toMatchObject({
      inserted: 1,
      skipped: 0,
      reviewRequired: [],
      skippedItems: [],
    });
    expect(await oldRoot()).toEqual(oldBefore);
    const created = (await live()).filter((r) => r.id !== oldBefore.id);
    expect(created).toHaveLength(1);
    expect(created[0].seriesKey).toMatch(/\|15000\|10$/);
    expect(created[0].cashFlow.map((c) => [c.valor, c.status])).toEqual(
      Array(10).fill([15000, "PLANEJADO"]),
    );
  });

  it("C3: a generic force (action import without a fingerprint) never authorizes a REVIEW line", async () => {
    const before = await roots();
    const res: any = await commit(doc(NEW), [
      { externalId: idOf(NEW), action: "import" },
    ]);
    expect(res.inserted).toBe(0);
    expect(res.reviewRequired).toHaveLength(1);
    expect(res.reviewRequired[0].reason).toBe(REQUIRED);
    expect(await roots()).toEqual(before);
  });

  it("C4: a fabricated well-formed fingerprint never authorizes a review; the current one is returned", async () => {
    const fingerprint = await reviewedFingerprint();
    const before = await roots();
    const res: any = await commit(doc(NEW), withFp("a".repeat(64)));
    expect(res.inserted).toBe(0);
    expect(res.reviewRequired).toEqual([
      expect.objectContaining({ reason: STALE, fingerprint }),
    ]);
    expect(await roots()).toEqual(before);
  });

  it("C5 control: skip on a REVIEW line is a user skip, not a pending review", async () => {
    const res: any = await commit(doc(NEW), [
      { externalId: idOf(NEW), action: "skip" },
    ]);
    expect(res).toMatchObject({ inserted: 0, skipped: 1 });
    expect(res.reviewRequired ?? []).toEqual([]);
  });

  it("C6: a retry of the same decision after the insert is a strong duplicate, never STALE and never a second root", async () => {
    const fingerprint = await reviewedFingerprint();
    await commit(doc(NEW), withFp(fingerprint));
    const before = await roots();
    const res: any = await commit(doc(NEW), withFp(fingerprint));
    expect(res).toMatchObject({ inserted: 0, duplicated: 1, skipped: 0 });
    expect(res.reviewRequired).toEqual([]);
    expect(await roots()).toEqual(before);
  });

  it("C7: a strong duplicate that appears after the batch dedupe read keeps precedence over the review, with or without a fingerprint", async () => {
    const fingerprint = await reviewedFingerprint();
    for (const decisions of [withFp(fingerprint), undefined]) {
      await setup.expense.deleteMany({
        where: { tenantId: TENANT, externalId: idOf(NEW) },
      });
      afterImportRecord = async () => {
        await setup.expense.create({
          data: {
            tenantId: TENANT,
            projectId: PROJECT,
            tipoDespesa: "OUTROS",
            titulo: "cross-channel racer",
            valor: 1,
            valorTotal: 1,
            quantidade: 1,
            formaPagamento: "A_VISTA",
            status: "PLANEJADO",
            externalId: idOf(NEW),
          },
        });
      };
      const res: any = await commit(doc(NEW), decisions);
      expect(res).toMatchObject({ inserted: 0, duplicated: 1, skipped: 0 });
      expect(res.reviewRequired).toEqual([]);
      expect(res.skippedItems).toEqual([]);
      expect(lineOutcomes(res)[idOf(NEW)]).toBe("DUPLICATED");
      expect(
        (await roots()).filter((r) => r.externalId === idOf(NEW)),
      ).toHaveLength(1);
    }
  });

  // ── F. The fingerprint binds the material state that was reviewed ────────

  const clone = async (oldId: string) => {
    const old = await setup.expense.findUniqueOrThrow({
      where: { id: oldId },
      include: { cashFlow: true },
    });
    const { id, cashFlow, createdAt, updatedAt, ...rest } = old;
    const replacement = await setup.expense.create({
      data: {
        ...rest,
        externalId: `${old.externalId}-r`,
        dedupeKeyStrong: null,
      },
    });
    for (const {
      id: _i,
      createdAt: _c,
      updatedAt: _u,
      expenseId,
      ...cfe
    } of cashFlow)
      await setup.cashFlowEntry.create({
        data: { ...cfe, expenseId: replacement.id },
      });
    return replacement;
  };
  const firstCfe = async () => (await oldRoot()).cashFlow[3]!;
  const STALE_MUTATIONS: Array<[string, () => Promise<void>]> = [
    [
      "the root is replaced by another with the same key",
      async () => {
        const old = await oldRoot();
        await clone(old.id);
        await setup.cashFlowEntry.updateMany({
          where: { expenseId: old.id },
          data: { deletedAt: new Date() },
        });
        await setup.expense.update({
          where: { id: old.id },
          data: { deletedAt: new Date() },
        });
      },
    ],
    [
      "a CFE date changes",
      async () => {
        const c = await firstCfe();
        await setup.cashFlowEntry.update({
          where: { id: c.id },
          data: { data: new Date(c.data.getTime() + 86_400_000) },
        });
      },
    ],
    [
      "a CFE status changes",
      async () => {
        await setup.cashFlowEntry.update({
          where: { id: (await firstCfe()).id },
          data: { status: "PAGO" },
        });
      },
    ],
    [
      "a CFE label changes",
      async () => {
        await setup.cashFlowEntry.update({
          where: { id: (await firstCfe()).id },
          data: { parcela: "5/10" },
        });
      },
    ],
    [
      "a CFE is added",
      async () => {
        const { id, createdAt, updatedAt, ...cfe } = await firstCfe();
        await setup.cashFlowEntry.create({ data: cfe });
      },
    ],
    [
      "a CFE is removed",
      async () => {
        await setup.cashFlowEntry.update({
          where: { id: (await firstCfe()).id },
          data: { deletedAt: new Date() },
        });
      },
    ],
    [
      "the root title changes",
      async () => {
        await setup.expense.update({
          where: { id: (await oldRoot()).id },
          data: { titulo: "QA LOJA RECORRENTE (1/10) editada" },
        });
      },
    ],
    [
      "the root supplier changes",
      async () => {
        await setup.expense.update({
          where: { id: (await oldRoot()).id },
          data: { fornecedor: "OUTRO FORNECEDOR" },
        });
      },
    ],
    [
      "the root purchase date changes",
      async () => {
        await setup.expense.update({
          where: { id: (await oldRoot()).id },
          data: { dataCompra: new Date("2026-02-02T00:00:00.000Z") },
        });
      },
    ],
  ];
  it.each(STALE_MUTATIONS)(
    "F1: %s after the review -> REVIEW_STALE with a new fingerprint and zero creation",
    async (_name, mutate) => {
      const fingerprint = await reviewedFingerprint();
      await mutate();
      const before = await roots();
      const res: any = await commit(doc(NEW), withFp(fingerprint));
      expect(res.inserted).toBe(0);
      expect(res.reviewRequired).toHaveLength(1);
      expect(res.reviewRequired[0]).toMatchObject({ reason: STALE });
      expect(res.reviewRequired[0].fingerprint).toMatch(HEX64);
      expect(res.reviewRequired[0].fingerprint).not.toBe(fingerprint);
      expect(await roots()).toEqual(before);
    },
  );

  it.each([
    ["valorCents", { valorCents: 16000 }],
    ["titulo", { titulo: "QA LOJA RECORRENTE OUTRA" }],
  ])(
    "F2: the adjusted line (%s override) is part of what was reviewed",
    async (_name, overrides) => {
      const fingerprint = await reviewedFingerprint();
      const before = await roots();
      const res: any = await commit(
        doc(NEW),
        withFp(fingerprint, { overrides }),
      );
      expect(res.inserted).toBe(0);
      expect(res.reviewRequired[0]).toMatchObject({ reason: STALE });
      expect(await roots()).toEqual(before);
    },
  );

  it("F3: a STALE answer carries a new fingerprint that, once reviewed, inserts", async () => {
    const fingerprint = await reviewedFingerprint();
    await setup.expense.update({
      where: { id: (await oldRoot()).id },
      data: { fornecedor: "OUTRO FORNECEDOR" },
    });
    const stale: any = await commit(doc(NEW), withFp(fingerprint));
    const next = stale.reviewRequired[0].fingerprint;
    expect(next).toMatch(HEX64);
    const res: any = await commit(doc(NEW), withFp(next));
    expect(res).toMatchObject({ inserted: 1, reviewRequired: [] });
  });

  it("F4: a lone CFE value off the key nominal is BLOCKED (with or without a fingerprint), not STALE", async () => {
    const fingerprint = await reviewedFingerprint();
    await setup.cashFlowEntry.update({
      where: { id: (await firstCfe()).id },
      data: { valor: 10001 },
    });
    const before = await roots();
    for (const decisions of [undefined, withFp(fingerprint)]) {
      const res: any = await commit(doc(NEW), decisions);
      expect(res.inserted).toBe(0);
      expect(res.reviewRequired ?? []).toEqual([]);
      expect(res.skippedItems).toEqual([
        { externalId: idOf(NEW), reason: BLOCKED },
      ]);
    }
    expect(await roots()).toEqual(before);
  });

  it("F5: uniform CFEs that are not the key nominal are BLOCKED too", async () => {
    await setup.cashFlowEntry.updateMany({
      where: { expenseId: (await oldRoot()).id },
      data: { valor: 12000 },
    });
    const row = await rowOf(doc(NEW));
    expect(row.willImport).toBe(false);
    expect(row.review).toMatchObject({ reason: BLOCKED, fingerprint: null });
  });

  // ── S. STALE vs BLOCKED when the reviewed family disappears or changes ───

  it("S1: the reviewed family vanished -> STALE with fingerprint null, no creation; a fresh preview then imports ordinarily", async () => {
    const fingerprint = await reviewedFingerprint();
    const old = await oldRoot();
    await setup.cashFlowEntry.updateMany({
      where: { expenseId: old.id },
      data: { deletedAt: new Date() },
    });
    await setup.expense.update({
      where: { id: old.id },
      data: { deletedAt: new Date() },
    });
    const before = await roots();
    const res: any = await commit(doc(NEW), withFp(fingerprint));
    expect(res.inserted).toBe(0);
    expect(res.reviewRequired).toEqual([
      {
        externalId: idOf(NEW),
        reason: STALE,
        fingerprint: null,
        candidates: [],
      },
    ]);
    expect(await roots()).toEqual(before);
    expect((await rowOf(doc(NEW))).review ?? null).toBeNull();
    expect(await commit(doc(NEW))).toMatchObject({ inserted: 1 });
  });

  it("S2: a root with the SAME key as the new line appears after the review -> STALE, and nobody is stamped", async () => {
    const fingerprint = await reviewedFingerprint();
    const old = await oldRoot();
    const twin = await clone(old.id);
    await setup.expense.update({
      where: { id: twin.id },
      data: {
        seriesKey: old.seriesKey!.replace("|10000|10", "|15000|10"),
        externalId: null,
      },
    });
    await setup.cashFlowEntry.updateMany({
      where: { expenseId: twin.id },
      data: { valor: 15000 },
    });
    const before = await roots();
    const res: any = await commit(doc(NEW), withFp(fingerprint));
    expect(res.inserted).toBe(0);
    expect(res.reviewRequired[0]).toMatchObject({ reason: STALE });
    expect(await roots()).toEqual(before);
    expect(
      (await roots()).find((r) => r.id === twin.id)!.externalId,
    ).toBeNull();
  });

  it("S3: a tombstone with an active CFE is BLOCKED_IDENTITY, with or without a decision", async () => {
    const fingerprint = await reviewedFingerprint();
    await setup.expense.update({
      where: { id: (await oldRoot()).id },
      data: { deletedAt: new Date() },
    });
    const before = await roots();
    for (const decisions of [undefined, withFp(fingerprint)]) {
      const res: any = await commit(doc(NEW), decisions);
      expect(res.inserted).toBe(0);
      expect(res.skippedItems).toEqual([
        { externalId: idOf(NEW), reason: BLOCKED },
      ]);
    }
    expect(await roots()).toEqual(before);
  });

  it("S4 control: a passive tombstone (no active CFE, coherent) does not block or review an ordinary insert", async () => {
    const old = await oldRoot();
    await setup.cashFlowEntry.updateMany({
      where: { expenseId: old.id },
      data: { deletedAt: new Date() },
    });
    await setup.expense.update({
      where: { id: old.id },
      data: { deletedAt: new Date() },
    });
    expect((await rowOf(doc(NEW))).review ?? null).toBeNull();
    expect(await commit(doc(NEW))).toMatchObject({ inserted: 1, skipped: 0 });
  });

  it.each([
    [
      "a Receipt holding the family's identity",
      async () => {
        await setup.receipt.create({
          data: {
            tenantId: TENANT,
            projectId: PROJECT,
            valor: 1,
            data: new Date("2026-01-05T00:00:00.000Z"),
            tipo: "OUTROS",
            externalId: idOf(OLD),
          },
        });
      },
    ],
    [
      "a foreign-tenant CFE on the family root",
      async () => {
        const foreign = `${TENANT}-foreign`;
        await resetTenant(setup, foreign);
        await seedPessoal(setup, {
          tenantId: foreign,
          projectId: `${foreign}-pessoal`,
        });
        await setup.cashFlowEntry.create({
          data: {
            tenantId: foreign,
            projectId: `${foreign}-pessoal`,
            expenseId: (await oldRoot()).id,
            valor: 1,
            tipo: "DESPESA",
            data: new Date("2026-08-14T00:00:00.000Z"),
            status: "PLANEJADO",
            categoria: "OUTROS",
            formaPagamento: "CARTAO_CREDITO",
          },
        });
      },
    ],
  ])("S5: %s -> BLOCKED_IDENTITY, no override", async (_name, arrange) => {
    await arrange();
    const before = await roots();
    const row = await rowOf(doc(NEW));
    expect(row.willImport).toBe(false);
    expect(row.review).toMatchObject({
      reason: BLOCKED,
      fingerprint: null,
      candidates: [],
    });
    const res: any = await commit(doc(NEW), withFp("b".repeat(64)));
    expect(res.inserted).toBe(0);
    expect(res.skippedItems).toEqual([
      { externalId: idOf(NEW), reason: BLOCKED },
    ]);
    expect(await roots()).toEqual(before);
    await resetTenant(setup, `${TENANT}-foreign`);
  });

  it("S6 controls: 1/3 against 3/10 stays released; an identical-key twin stays reused, never a review", async () => {
    await commit(doc("2026-02-01,QA VELHA SERIE 3/10,100.00"));
    expect(
      await commit(doc("2026-09-10,QA VELHA SERIE 1/3,150.00")),
    ).toMatchObject({ inserted: 1, skipped: 0 });
    const twin: any = await commit(
      doc("2026-03-03,QA LOJA RECORRENTE 1/10,100.00"),
    );
    expect(twin).toMatchObject({ inserted: 0, settled: 1 });
    expect(twin.reviewRequired ?? []).toEqual([]);
  });

  // ── B. Batch: a root created by an earlier line of the same file ─────────

  it("B1: line B sees the root that line A just created -> visible REVIEW, then a second commit converges", async () => {
    await resetTenant(setup, TENANT);
    await seedPessoal(setup, { tenantId: TENANT, projectId: PROJECT });
    ({ id: cardId } = await seedCardWithClosingDue(setup, {
      tenantId: TENANT,
      projectId: PROJECT,
      last4: "0717",
      closingDay: 20,
      dueDay: 10,
    }));
    const A = "2026-09-05,QA LOTE LOJA 1/10,100.00";
    const B = "2026-09-06,QA LOTE LOJA 1/10,150.00";
    const file = doc(A, B);
    const shown: any = await preview(file);
    expect(
      shown.preview.map((r: any) => [r.willImport, r.review ?? null]),
    ).toEqual([
      [true, null],
      [true, null],
    ]);
    const first: any = await commit(file);
    expect(first).toMatchObject({
      total: 2,
      inserted: 1,
      skipped: 0,
      skippedItems: [],
    });
    const created = (await live())[0];
    expect(first.reviewRequired).toEqual([
      {
        externalId: idOf(B),
        reason: REQUIRED,
        fingerprint: expect.stringMatching(HEX64),
        candidates: [
          expect.objectContaining({
            expenseId: created.id,
            seriesAmountCents: 10000,
            installmentCount: 10,
          }),
        ],
      },
    ]);
    const second: any = await commit(file, [
      {
        externalId: idOf(B),
        action: "import",
        reviewFingerprint: first.reviewRequired[0].fingerprint,
      },
    ]);
    expect(second).toMatchObject({
      total: 2,
      inserted: 1,
      duplicated: 1,
      reviewRequired: [],
    });
    const all = await live();
    expect(all).toHaveLength(2);
    expect(all.flatMap((r) => r.cashFlow)).toHaveLength(20);
  });

  // ── V. Decisions are validated before any import record exists ───────────

  it.each([
    ["an object instead of an array", () => ({ externalId: idOf(NEW) })],
    ["an item that is not an object", () => ["skip"]],
    ["a null item", () => [null]],
    ["a missing externalId", () => [{ action: "skip" }]],
    ["a non-string externalId", () => [{ externalId: 7, action: "skip" }]],
    ["an unknown action", () => [{ externalId: idOf(NEW), action: "force" }]],
    [
      "a repeated externalId",
      () => [
        { externalId: idOf(NEW), action: "skip" },
        { externalId: idOf(NEW), action: "skip" },
      ],
    ],
    ["a null fingerprint", () => withFp(null as never)],
    ["a short fingerprint", () => withFp("abc")],
    ["an uppercase fingerprint", () => withFp("A".repeat(64))],
    ["a numeric fingerprint", () => withFp(12345 as never)],
    [
      "a fingerprint on action create",
      () => [
        {
          externalId: idOf(NEW),
          action: "create",
          reviewFingerprint: "a".repeat(64),
        },
      ],
    ],
    [
      "a fingerprint on action skip",
      () => [
        {
          externalId: idOf(NEW),
          action: "skip",
          reviewFingerprint: "a".repeat(64),
        },
      ],
    ],
    [
      "a fingerprint on action link",
      () => [
        {
          externalId: idOf(NEW),
          action: "link",
          linkToExpenseId: "x",
          reviewFingerprint: "a".repeat(64),
        },
      ],
    ],
    [
      "a fingerprint with no action",
      () => [{ externalId: idOf(NEW), reviewFingerprint: "a".repeat(64) }],
    ],
  ])(
    "V1: %s -> 400 INVALID_DECISION before any import record",
    async (_name, decisions) => {
      const records = await importCount();
      const before = await roots();
      const error: any = await commit(doc(NEW), decisions()).catch((e) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse()).toMatchObject({ code: "INVALID_DECISION" });
      expect(await importCount()).toBe(records);
      expect(await roots()).toEqual(before);
    },
  );

  it("V2 control: the payload shapes the modal sends today stay valid", async () => {
    const res: any = await commit(
      doc(NEW, "2026-09-11,QA OUTRA LOJA 1/3,30.00"),
      [
        { externalId: idOf(NEW), action: "skip" },
        {
          externalId: idOf("2026-09-11,QA OUTRA LOJA 1/3,30.00"),
          action: "create",
          overrides: { titulo: "QA OUTRA LOJA", valorCents: 3000 },
        },
      ],
    );
    expect(res).toMatchObject({ total: 2, inserted: 1, skipped: 1 });
  });

  // ── N. Counters, persistence and wording ─────────────────────────────────

  it("N1: extraneous decisions never count as skipped nor push the persisted duplicated below zero", async () => {
    const res: any = await commit(
      doc("2026-09-12,QA LINHA SIMPLES 1/2,20.00"),
      [
        { externalId: "not-in-the-file-1", action: "skip" },
        { externalId: "not-in-the-file-2", action: "skip" },
      ],
    );
    expect(res).toMatchObject({
      total: 1,
      inserted: 1,
      skipped: 0,
      duplicated: 0,
    });
    const record = await setup.creditCardStatementImport.findUniqueOrThrow({
      where: { id: res.importId },
    });
    expect(record).toMatchObject({ inserted: 1, skipped: 0, duplicated: 0 });
  });

  async function arrangeAll() {
    actor = { ...ADMIN_REQUESTER };
    const DUP = "2026-02-01,QA DUP UNICA 1/2,20.00";
    const BLK_OLD = "2026-01-06,QA LOJA BLOQ 1/5,50.00";
    const SECOND_OLD = "2026-01-07,QA LOJA SEGUNDA 1/10,100.00";
    await commit(doc(DUP, BLK_OLD, SECOND_OLD));
    const targetForCreated = await plannedTarget("nova", 6000);
    const targetForReused = await plannedTarget("reuso", 10000);
    const blk = await setup.expense.findFirstOrThrow({
      where: { tenantId: TENANT, externalId: idOf(BLK_OLD) },
    });
    await setup.receipt.create({
      data: {
        tenantId: TENANT,
        projectId: PROJECT,
        valor: 1,
        data: new Date("2026-01-06T00:00:00.000Z"),
        tipo: "OUTROS",
        externalId: blk.externalId,
      },
    });
    const parsed = parseStatement(
      doc("2026-09-13,QA TIER B 1/2,40.00"),
      cardId,
      "CSV_GENERIC",
      "s.csv",
    );
    attachDedupeKeys(parsed.transactions, {
      tenantId: TENANT,
      projectId: PROJECT,
      fileContentHash: "n2",
    });
    await setup.expense.create({
      data: {
        tenantId: TENANT,
        projectId: PROJECT,
        tipoDespesa: "OUTROS",
        titulo: "outra origem",
        valor: 4000,
        valorTotal: 4000,
        quantidade: 1,
        formaPagamento: "A_VISTA",
        status: "PLANEJADO",
        origin: "import",
        dedupeKeyNatural: parsed.transactions[0]!.dedupeKeyNatural ?? null,
      },
    });
    raceTitle = "QA CORRIDA";
    failTitle = "QA FALHA ESCRITA";
    const lines = {
      inserted: "2026-09-01,QA NOVA COMPRA A 1/3,30.00",
      userSkip: "2026-09-02,QA PULADA 1/2,10.00",
      duplicate: DUP,
      settled: "2026-03-03,QA LOJA SEGUNDA 1/10,100.00",
      payment: "2026-09-03,PAGAMENTO EFETUADO 1/2,50.00",
      error: "2026-09-03,QA FALHA ESCRITA 1/2,50.00",
      review: NEW,
      blocked: "2026-09-04,QA LOJA BLOQ 1/5,80.00",
      race: "2026-09-05,QA CORRIDA 1/2,12.00",
      tierB: "2026-09-13,QA TIER B 1/2,40.00",
      createdLinked: "2026-09-06,QA COMPRA LINKADA,60.00",
    };
    const decisions = [
      { externalId: idOf(lines.userSkip), action: "skip" },
      { externalId: "ghost", action: "skip" },
      {
        externalId: idOf(lines.createdLinked),
        action: "link",
        linkToExpenseId: targetForCreated.id,
      },
      {
        externalId: idOf(lines.settled),
        action: "link",
        linkToExpenseId: targetForReused.id,
      },
    ];
    return {
      lines,
      file: doc(...Object.values(lines)),
      decisions,
      targetForCreated,
      targetForReused,
    };
  }

  it("N2: every destination in one commit obeys the response equation, the line results and the (different) persisted one", async () => {
    const { lines, file, decisions } = await arrangeAll();
    const res: any = await commit(file, decisions);
    expect(res).toMatchObject({
      total: 11,
      inserted: 2,
      settled: 1,
      duplicated: 2,
      skipped: 4,
      notSelected: 0,
      linked: 2,
    });
    expect(lineOutcomes(res)).toEqual({
      [idOf(lines.inserted)]: "CREATED",
      [idOf(lines.createdLinked)]: "CREATED",
      [idOf(lines.userSkip)]: "SKIPPED",
      [idOf(lines.payment)]: "SKIPPED",
      [idOf(lines.duplicate)]: "DUPLICATED",
      [idOf(lines.settled)]: "REUSED",
      [idOf(lines.error)]: "ERROR",
      [idOf(lines.review)]: "REVIEW_REQUIRED",
      [idOf(lines.blocked)]: "BLOCKED",
      [idOf(lines.race)]: "DUPLICATED",
      [idOf(lines.tierB)]: "POSSIBLE_DUPLICATE",
    });
    expect(res.possibleDuplicates).toHaveLength(1);
    expect(res.reviewRequired.map((r: any) => r.externalId)).toEqual([
      idOf(lines.review),
    ]);
    expect(res.skippedItems).toEqual([
      { externalId: idOf(lines.blocked), reason: BLOCKED },
    ]);
    expect(res.total).toBe(
      res.inserted +
        res.settled +
        res.duplicated +
        res.skipped +
        res.possibleDuplicates.length +
        res.reviewRequired.length +
        res.notSelected,
    );
    // one entry per parsed line, in parse order, with exactly the public keys
    expect(res.lineResults.map((r: any) => r.externalId)).toEqual(
      Object.values(lines).map(idOf),
    );
    for (const r of res.lineResults)
      expect(
        Object.keys(r).every((k) =>
          ["externalId", "outcome", "linked"].includes(k),
        ),
      ).toBe(true);
    // linked is an attribute of CREATED and REUSED, and matches the counter
    expect(linkedIds(res).sort()).toEqual(
      [idOf(lines.createdLinked), idOf(lines.settled)].sort(),
    );
    expect(linkedIds(res)).toHaveLength(res.linked);
    expect(JSON.stringify(res)).not.toContain(SECRET);
    const record = await setup.creditCardStatementImport.findUniqueOrThrow({
      where: { id: res.importId },
    });
    expect(record).toMatchObject({
      inserted: res.inserted,
      duplicated: res.duplicated + res.settled,
      skipped: res.skipped + res.reviewRequired.length + res.notSelected,
    });
    expect(record.duplicated).toBeGreaterThanOrEqual(0);
    expect(record.message).toContain("1 compra(s) aguardando revisão");
  });

  it("N3: reused (settled) purchases are worded as already existing, without payment, and stay PLANEJADO", async () => {
    const res: any = await commit(
      doc("2026-03-03,QA LOJA RECORRENTE 1/10,100.00"),
    );
    expect(res.settled).toBe(1);
    const record = await setup.creditCardStatementImport.findUniqueOrThrow({
      where: { id: res.importId },
    });
    expect(record.message).toBe(
      "1 parcela(s) já existente(s) reaproveitada(s), sem pagamento",
    );
    expect(record.message).not.toMatch(/liquidad|pag(a|o)s?\b(?!amento)/i);
    expect(
      (await oldRoot()).cashFlow.every((c) => c.status === "PLANEJADO"),
    ).toBe(true);
  });

  it("N4: lines outside the selection are NOT_SELECTED, counted visibly and never dedupe/reuse/link/stamp", async () => {
    const { lines, file, decisions, targetForReused } = await arrangeAll();
    const spy = settleSpy();
    const unselected = [lines.inserted, lines.duplicate, lines.settled];
    const selected = Object.values(lines)
      .filter((l) => !unselected.includes(l))
      .map(idOf);
    const res: any = await commit(file, decisions, selected);
    expect(res).toMatchObject({
      total: 11,
      inserted: 1,
      settled: 0,
      duplicated: 1,
      skipped: 4,
      notSelected: 3,
      linked: 1,
    });
    expect(res.total).toBe(
      res.inserted +
        res.settled +
        res.duplicated +
        res.skipped +
        res.possibleDuplicates.length +
        res.reviewRequired.length +
        res.notSelected,
    );
    const outcomes = lineOutcomes(res);
    for (const l of unselected) expect(outcomes[idOf(l)]).toBe("NOT_SELECTED");
    expect(outcomes[idOf(lines.error)]).toBe("ERROR");
    expect(outcomes[idOf(lines.payment)]).toBe("SKIPPED");
    expect(res.lineResults.map((r: any) => r.externalId)).toEqual(
      Object.values(lines).map(idOf),
    );
    expect(linkedIds(res)).toEqual([idOf(lines.createdLinked)]);
    // the unselected reuse decision (link) never reached the target
    for (const [input] of spy.mock.calls.map((c) => [c[1]] as const))
      expect((input as any).targetExpenseIds).not.toContain(targetForReused.id);
    expect(
      (
        await setup.expense.findUniqueOrThrow({
          where: { id: targetForReused.id },
        })
      ).status,
    ).toBe("PLANEJADO");
    expect(res.duplicatedItems.map((d: any) => d.externalId)).not.toContain(
      idOf(lines.duplicate),
    );
    expect(
      await setup.expense.count({
        where: { tenantId: TENANT, externalId: idOf(lines.inserted) },
      }),
    ).toBe(0);
    const record = await setup.creditCardStatementImport.findUniqueOrThrow({
      where: { id: res.importId },
    });
    expect(record.skipped).toBe(
      res.skipped + res.reviewRequired.length + res.notSelected,
    );
    expect(record.message).toContain("3 não selecionada(s)");
  });

  it("N5: a plain created line carries no linked key at all", async () => {
    const row = "2026-09-14,QA LINHA SIMPLES 1/2,20.00";
    const res: any = await commit(doc(row));
    expect(res.lineResults).toEqual([
      { externalId: idOf(row), outcome: "CREATED" },
    ]);
  });

  // ── S. Attempt selection (design "Delta: seleção da tentativa") ──────────
  // The server adds no size cap of its own to selectedExternalIds; the only
  // limits are the multipart envelope (H group, real HTTP).

  it("Sel1: retrying only the pending line never re-runs an earlier create, link or reuse", async () => {
    actor = { ...ADMIN_REQUESTER };
    const SECOND_OLD = "2026-01-07,QA LOJA SEGUNDA 1/10,100.00";
    await commit(doc(SECOND_OLD));
    const target = await plannedTarget("reuso", 10000);
    const A = "2026-09-01,QA NOVA COMPRA A 1/3,30.00";
    const C = "2026-03-04,QA LOJA SEGUNDA 1/10,100.00";
    const file = doc(A, C, NEW);
    const link = {
      externalId: idOf(C),
      action: "link",
      linkToExpenseId: target.id,
    };
    const first = await commit(file, [link], [A, C, NEW].map(idOf));
    expect(lineOutcomes(first)).toEqual({
      [idOf(A)]: "CREATED",
      [idOf(C)]: "REUSED",
      [idOf(NEW)]: "REVIEW_REQUIRED",
    });
    expect(linkedIds(first)).toEqual([idOf(C)]);
    expect(first.linked).toBe(1);
    const afterFirst = await financialState();
    expect(afterFirst.settlements).toHaveLength(1);

    const spy = settleSpy();
    const fingerprint = first.reviewRequired[0].fingerprint;
    const retry = await commit(
      file,
      [
        {
          externalId: idOf(NEW),
          action: "import",
          reviewFingerprint: fingerprint,
        },
        link,
      ],
      [idOf(NEW)],
    );
    expect(retry).toMatchObject({
      total: 3,
      inserted: 1,
      settled: 0,
      duplicated: 0,
      skipped: 0,
      notSelected: 2,
      linked: 0,
      reviewRequired: [],
    });
    expect(lineOutcomes(retry)).toEqual({
      [idOf(A)]: "NOT_SELECTED",
      [idOf(C)]: "NOT_SELECTED",
      [idOf(NEW)]: "CREATED",
    });
    expect(spy).not.toHaveBeenCalled();
    const afterRetry = await financialState();
    const untouched = <T extends { id: string }>(before: T[], after: T[]) =>
      after.filter((row) => before.some((b) => b.id === row.id));
    expect(untouched(afterFirst.roots, afterRetry.roots)).toEqual(
      afterFirst.roots,
    );
    expect(afterRetry.targets).toEqual(afterFirst.targets);
    expect(afterRetry.settlements).toEqual(afterFirst.settlements);
    expect(afterRetry.roots).toHaveLength(afterFirst.roots.length + 1);

    const again = await commit(file, withFp(fingerprint), [idOf(NEW)]);
    expect(lineOutcomes(again)[idOf(NEW)]).toBe("DUPLICATED");
    expect(again).toMatchObject({ inserted: 0, duplicated: 1, notSelected: 2 });
  });

  it("Sel2: without selectedExternalIds the round is the legacy one, with a complete lineResults and notSelected 0", async () => {
    const other = "2026-09-11,QA OUTRA LOJA 1/3,30.00";
    const twin = "2026-03-03,QA LOJA RECORRENTE 1/10,100.00";
    const res = await commit(doc(other, twin, NEW));
    expect(res).toMatchObject({
      total: 3,
      inserted: 1,
      settled: 1,
      notSelected: 0,
    });
    expect(res.reviewRequired).toHaveLength(1);
    expect(lineOutcomes(res)).toEqual({
      [idOf(other)]: "CREATED",
      [idOf(twin)]: "REUSED",
      [idOf(NEW)]: "REVIEW_REQUIRED",
    });
  });

  it.each([
    ["an object", () => ({ a: 1 })],
    ["a string", () => "abc"],
    ["an empty array", () => []],
    ["a non-string entry", () => [7]],
    ["a null entry", () => [null]],
    ["an empty-string entry", () => [""]],
    ["a repeated id", () => [idOf(NEW), idOf(NEW)]],
  ])(
    "Sel3: a selection that is %s -> 400 INVALID_SELECTION, zero effects",
    async (_n, selection) => {
      const records = await importCount();
      const before = await roots();
      const error: any = await commit(doc(NEW), undefined, selection()).catch(
        (e) => e,
      );
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.getResponse()).toMatchObject({ code: "INVALID_SELECTION" });
      expect(await importCount()).toBe(records);
      expect(await roots()).toEqual(before);
    },
  );

  it("Sel3b: selection is validated before the link target ACL, and a decision for an unselected line never counts", async () => {
    const error: any = await commit(
      doc(NEW),
      [{ externalId: idOf(NEW), action: "link", linkToExpenseId: "not-mine" }],
      [],
    ).catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getResponse()).toMatchObject({ code: "INVALID_SELECTION" });
    const other = "2026-09-11,QA OUTRA LOJA 1/3,30.00";
    const res: any = await commit(
      doc(NEW, other),
      [
        { externalId: idOf(NEW), action: "skip" },
        { externalId: "ghost", action: "skip" },
      ],
      [idOf(other)],
    );
    expect(res).toMatchObject({
      total: 2,
      inserted: 1,
      skipped: 0,
      notSelected: 1,
    });
    expect(lineOutcomes(res)[idOf(NEW)]).toBe("NOT_SELECTED");
  });

  it("Sel4: a selected id missing from the reparsed document -> 409 SELECTED_ROWS_CHANGED with zero effects (no record, no expense, no ACL check)", async () => {
    actor = { ...ADMIN_REQUESTER };
    const target = await plannedTarget("x", 3000);
    const other = "2026-09-11,QA OUTRA LOJA 1/3,30.00";
    const spy = settleSpy();
    const records = await importCount();
    const before = await financialState();
    const error: any = await commit(
      doc(NEW, other),
      [{ externalId: idOf(other), action: "link", linkToExpenseId: target.id }],
      [idOf(other), "gone-1", "gone-2"],
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toEqual({
      code: "SELECTED_ROWS_CHANGED",
      missingCount: 2,
      missingExternalIds: ["gone-1", "gone-2"],
    });
    expect(Object.keys(error.getResponse()).sort()).toEqual(CONFLICT_KEYS);
    expect(spy).not.toHaveBeenCalled();
    expect(await importCount()).toBe(records);
    expect(await financialState()).toEqual(before);
  });

  it("Sel4b: a new line of the file outside the selection is NOT_SELECTED and is never created", async () => {
    const wanted = "2026-09-11,QA OUTRA LOJA 1/3,30.00";
    const extra = "2026-09-12,QA LINHA EXTRA 1/2,20.00";
    const res = await commit(doc(wanted, extra), undefined, [idOf(wanted)]);
    expect(res).toMatchObject({ total: 2, inserted: 1, notSelected: 1 });
    expect(lineOutcomes(res)[idOf(extra)]).toBe("NOT_SELECTED");
    expect(
      await setup.expense.count({
        where: { tenantId: TENANT, externalId: idOf(extra) },
      }),
    ).toBe(0);
  });

  it("Sel4c: no invented cap: 250 selected ids are all honored; 2500 missing ids report the count and only the first 50", async () => {
    const rows = Array.from(
      { length: 250 },
      (_v, i) =>
        `2026-09-${String((i % 27) + 1).padStart(2, "0")},QA LOTE GRANDE ${i} 1/2,${10 + i}.00`,
    );
    const ok = await commit(doc(...rows), undefined, rows.map(idOf));
    expect(ok).toMatchObject({ total: 250, inserted: 250, notSelected: 0 });
    expect(ok.lineResults).toHaveLength(250);
    const missing = Array.from({ length: 2500 }, (_v, i) => `gone-${i}`);
    const error: any = await commit(doc(NEW), undefined, [
      idOf(NEW),
      ...missing,
    ]).catch((e) => e);
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toEqual({
      code: "SELECTED_ROWS_CHANGED",
      missingCount: 2500,
      missingExternalIds: missing.slice(0, 50),
    });
  });

  it("Sel5: the partition of one file: one entry per line in parse order, per-outcome counts equal every counter", async () => {
    const { lines, file, decisions } = await arrangeAll();
    const res = await commit(file, decisions);
    expect(res.lineResults).toBeDefined();
    const byOutcome: Record<string, number> = {};
    for (const r of res.lineResults)
      byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
    expect(res.lineResults).toHaveLength(Object.keys(lines).length);
    expect(new Set(res.lineResults.map((r: any) => r.externalId)).size).toBe(
      res.lineResults.length,
    );
    expect(byOutcome.CREATED ?? 0).toBe(res.inserted);
    expect(byOutcome.REUSED ?? 0).toBe(res.settled);
    expect(byOutcome.DUPLICATED ?? 0).toBe(res.duplicated);
    expect(
      (byOutcome.SKIPPED ?? 0) +
        (byOutcome.BLOCKED ?? 0) +
        (byOutcome.ERROR ?? 0),
    ).toBe(res.skipped);
    expect(byOutcome.POSSIBLE_DUPLICATE ?? 0).toBe(
      res.possibleDuplicates.length,
    );
    expect(byOutcome.REVIEW_REQUIRED ?? 0).toBe(res.reviewRequired.length);
    expect(byOutcome.NOT_SELECTED ?? 0).toBe(res.notSelected);
    expect(byOutcome.ERROR).toBe(1);
    expect(byOutcome.SKIPPED).toBe(2);
  });

  // ── E. Deterministic policy ignores are terminal; real failures are retryable ──

  const expensesTitled = (needle: string) =>
    setup.expense.findMany({
      where: { tenantId: TENANT, titulo: { contains: needle } },
    });

  it("E1: an invoice-payment line (either sign) is a terminal SKIPPED, never a retryable ERROR, and never a user skip", async () => {
    const before = await roots();
    for (const amount of ["50.00", "-50.00"]) {
      const row = `2026-09-03,PAGAMENTO EFETUADO,${amount}`;
      const res: any = await commit(doc(row));
      expect(res).toMatchObject({
        total: 1,
        inserted: 0,
        duplicated: 0,
        skipped: 1,
        reviewRequired: [],
        skippedItems: [],
      });
      expect(res.lineResults).toEqual([
        { externalId: idOf(row), outcome: "SKIPPED" },
      ]);
      // it is not a user skip: no decision exists, and the ledger is untouched
      expect(await roots()).toEqual(before);
    }
  });

  it("E2: a real write failure stays a retryable ERROR that rolls back the whole line, and the retry then creates it", async () => {
    const row = "2026-09-03,QA FALHA ESCRITA 1/2,50.00";
    failTitle = "QA FALHA ESCRITA";
    const warns = jest.spyOn(console, "warn").mockImplementation(() => {});
    const before = await roots();
    const first: any = await commit(doc(row));
    warns.mockRestore();
    expect(first).toMatchObject({ inserted: 0, skipped: 1 });
    expect(first.lineResults).toEqual([
      { externalId: idOf(row), outcome: "ERROR" },
    ]);
    expect(await roots()).toEqual(before);
    expect(await expensesTitled("QA FALHA ESCRITA")).toHaveLength(0);
    failTitle = null;
    const retry: any = await commit(doc(row), undefined, [idOf(row)]);
    expect(retry).toMatchObject({ inserted: 1, skipped: 0 });
    expect(retry.lineResults).toEqual([
      { externalId: idOf(row), outcome: "CREATED" },
    ]);
    expect(await expensesTitled("QA FALHA ESCRITA")).toHaveLength(1);
  });

  it("Sel6: removing the notSelected term breaks the equation (a selection commit must close it)", async () => {
    const other = "2026-09-11,QA OUTRA LOJA 1/3,30.00";
    const res = await commit(doc(NEW, other), undefined, [idOf(other)]);
    expect(res.notSelected).toBe(1);
    const withoutTerm =
      res.inserted +
      res.settled +
      res.duplicated +
      res.skipped +
      res.possibleDuplicates.length +
      res.reviewRequired.length;
    expect(withoutTerm).not.toBe(res.total);
    expect(withoutTerm + res.notSelected).toBe(res.total);
  });

  it("B2: the second commit sends only B selected: A is NOT_SELECTED, not DUPLICATED (a full legacy resend stays DUPLICATED, B1)", async () => {
    await resetTenant(setup, TENANT);
    await seedPessoal(setup, { tenantId: TENANT, projectId: PROJECT });
    ({ id: cardId } = await seedCardWithClosingDue(setup, {
      tenantId: TENANT,
      projectId: PROJECT,
      last4: "0717",
      closingDay: 20,
      dueDay: 10,
    }));
    const A = "2026-09-05,QA LOTE LOJA 1/10,100.00";
    const B = "2026-09-06,QA LOTE LOJA 1/10,150.00";
    const first = await commit(doc(A, B), undefined, [A, B].map(idOf));
    expect(lineOutcomes(first)).toEqual({
      [idOf(A)]: "CREATED",
      [idOf(B)]: "REVIEW_REQUIRED",
    });
    const second = await commit(
      doc(A, B),
      [
        {
          externalId: idOf(B),
          action: "import",
          reviewFingerprint: first.reviewRequired[0].fingerprint,
        },
      ],
      [idOf(B)],
    );
    expect(second).toMatchObject({
      total: 2,
      inserted: 1,
      duplicated: 0,
      notSelected: 1,
    });
    expect(lineOutcomes(second)).toEqual({
      [idOf(A)]: "NOT_SELECTED",
      [idOf(B)]: "CREATED",
    });
    expect((await live()).flatMap((r) => r.cashFlow)).toHaveLength(20);
  });

  // ── H. Real HTTP: multipart envelope and controller wiring ───────────────
  // Envelope limits that apply to selectedExternalIds (and decisions): a text
  // field is at most 1 MiB (busboy default; Nest answers 400 "Field value too
  // long"), and the endpoint accepts at most 5 files of 10 MiB each.

  const FIELD_LIMIT_BYTES = 1024 * 1024;
  const missingIds = (n: number) =>
    Array.from(
      { length: n },
      (_v, i) => `missing-${String(i).padStart(24, "0")}`,
    );

  async function post(
    fields: Record<string, string>,
    files: string[] = [doc(NEW)],
  ) {
    const moduleRef = await Test.createTestingModule({
      controllers: [CreditCardController],
      providers: [{ provide: CreditCardService, useValue: cards }],
    }).compile();
    const app = moduleRef.createNestApplication();
    app.use((req: any, _res: any, next: () => void) => {
      req.user = { ...ACTOR, tenantId: TENANT };
      next();
    });
    await app.listen(0);
    try {
      const form = new FormData();
      files.forEach((content, i) =>
        form.append("file", new Blob([content]), `s${i}.csv`),
      );
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      const res = await fetch(
        `${await app.getUrl()}/projects/${PROJECT}/credit-cards/${cardId}/import-statement?mode=commit&source=CSV_GENERIC`,
        { method: "POST", body: form },
      );
      return { status: res.status, body: await res.json().catch(() => null) };
    } finally {
      await app.close();
    }
  }

  it("H1: over HTTP a valid selection is forwarded: the unselected line is NOT_SELECTED", async () => {
    const other = "2026-09-11,QA OUTRA LOJA 1/3,30.00";
    const { status, body } = await post(
      { selectedExternalIds: JSON.stringify([idOf(other)]) },
      [doc(NEW, other)],
    );
    expect(status).toBe(201);
    expect(body).toMatchObject({ total: 2, inserted: 1, notSelected: 1 });
    expect(lineOutcomes(body)[idOf(NEW)]).toBe("NOT_SELECTED");
  });

  it("H2: over HTTP a malformed selection is 400 INVALID_SELECTION, and one that is not in the file is 409 SELECTED_ROWS_CHANGED", async () => {
    const bad = await post({ selectedExternalIds: "[not json" });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: "INVALID_SELECTION" });
    const gone = await post({ selectedExternalIds: JSON.stringify(["gone"]) });
    expect(gone.status).toBe(409);
    expect(gone.body).toEqual({
      code: "SELECTED_ROWS_CHANGED",
      missingCount: 1,
      missingExternalIds: ["gone"],
    });
    expect(Object.keys(gone.body).sort()).toEqual(CONFLICT_KEYS);
  });

  it("H3: a selection just under the 1 MiB text-field limit reaches the service (409 with the full missingCount), it is not capped", async () => {
    const ids = missingIds(25_000);
    const payload = JSON.stringify(ids);
    expect(payload.length).toBeLessThan(FIELD_LIMIT_BYTES);
    const { status, body } = await post({ selectedExternalIds: payload });
    expect(status).toBe(409);
    expect(body).toEqual({
      code: "SELECTED_ROWS_CHANGED",
      missingCount: 25_000,
      missingExternalIds: ids.slice(0, 50),
    });
    expect(Object.keys(body).sort()).toEqual(CONFLICT_KEYS);
  });

  it("H4 control: a selection over the 1 MiB text-field limit is rejected by the envelope (400 Field value too long), before any import", async () => {
    const payload = JSON.stringify(missingIds(31_000));
    expect(payload.length).toBeGreaterThan(FIELD_LIMIT_BYTES);
    const records = await importCount();
    const { status, body } = await post({ selectedExternalIds: payload });
    expect(status).toBe(400);
    expect(JSON.stringify(body)).toContain("Field value too long");
    expect(await importCount()).toBe(records);
  });

  it("H5 control: more than 5 files or a file over 10 MiB is rejected by the envelope", async () => {
    const six = await post({}, Array(6).fill(doc(NEW)));
    expect(six.status).toBe(400);
    expect(JSON.stringify(six.body)).toContain("Too many files");
    const big = await post({}, ["x".repeat(10 * 1024 * 1024 + 1)]);
    expect(big.status).toBe(413);
  });
});
