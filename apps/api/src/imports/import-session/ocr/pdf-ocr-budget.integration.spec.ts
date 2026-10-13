import { randomUUID } from "node:crypto";
import { PrismaService } from "../../../prisma/prisma.service";
import {
  PDF_OCR_RESERVED_COST_UNITS_PER_CALL,
  reconcilePdfOcrBudget,
  reservePdfOcrBudget,
  type PdfOcrDailyBudgetLimits,
} from "./pdf-ocr-budget";

const now = new Date("2026-10-13T20:00:00.000Z");
const roomy = {
  calls: { user: 100, tenant: 100, global: 100 },
  pages: { user: 1_000, tenant: 1_000, global: 1_000 },
  bytes: { user: 1_000_000, tenant: 1_000_000, global: 1_000_000 },
  costUnits: {
    user: 1_000_000,
    tenant: 1_000_000,
    global: 1_000_000,
  },
} satisfies PdfOcrDailyBudgetLimits;
const input = (
  tenantId = randomUUID(),
  actorId = randomUUID(),
  overrides: Partial<Parameters<typeof reservePdfOcrBudget>[1]> = {},
) => ({
  id: randomUUID(),
  tenantId,
  ownerProjectId: randomUUID(),
  actorId,
  sessionId: randomUUID(),
  attachmentId: randomUUID(),
  artifactId: randomUUID(),
  artifactSha256: "a".repeat(64),
  requestId: randomUUID(),
  pageCount: 1,
  byteCount: 1_000,
  now,
  ...overrides,
});

describe("durable direct OCR abuse budget", () => {
  const prisma = new PrismaService();
  beforeAll(() => prisma.$connect());
  beforeEach(() => prisma.importOcrUsage.deleteMany());
  afterAll(() => prisma.$disconnect());

  it("admits at most one concurrent per-user reservation at the limit", async () => {
    const tenantId = randomUUID();
    const actorId = randomUUID();
    const limits = {
      ...roomy,
      calls: { user: 1, tenant: 10, global: 10 },
    };
    const outcomes = await Promise.allSettled(
      [input(tenantId, actorId), input(tenantId, actorId)].map((reservation) =>
        prisma.$transaction((tx) =>
          reservePdfOcrBudget(tx, reservation, limits),
        ),
      ),
    );
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(
      1,
    );
    expect(
      await prisma.importOcrUsage.count({ where: { tenantId, actorId } }),
    ).toBe(1);
  });

  it("survives restart and charges abort/UNKNOWN against a new session", async () => {
    const tenantId = randomUUID();
    const actorId = randomUUID();
    const first = input(tenantId, actorId);
    const limits = {
      ...roomy,
      calls: { user: 1, tenant: 10, global: 10 },
    };
    await prisma.$transaction((tx) => reservePdfOcrBudget(tx, first, limits));
    await prisma.$transaction((tx) =>
      reconcilePdfOcrBudget(tx, first.id, "UNKNOWN", now, null),
    );
    const restarted = new PrismaService();
    await restarted.$connect();
    try {
      await expect(
        restarted.$transaction((tx) =>
          reservePdfOcrBudget(tx, input(tenantId, actorId), limits),
        ),
      ).rejects.toMatchObject({ code: "OCR_BUDGET_EXHAUSTED" });
    } finally {
      await restarted.$disconnect();
    }
  });

  it("enforces tenant and global daily calls across users and tenants", async () => {
    const tenantId = randomUUID();
    const limits = {
      ...roomy,
      calls: { user: 10, tenant: 1, global: 1 },
    };
    await prisma.$transaction((tx) =>
      reservePdfOcrBudget(tx, input(tenantId), limits),
    );
    await expect(
      prisma.$transaction((tx) =>
        reservePdfOcrBudget(tx, input(tenantId), limits),
      ),
    ).rejects.toMatchObject({ code: "OCR_BUDGET_EXHAUSTED" });
    await expect(
      prisma.$transaction((tx) =>
        reservePdfOcrBudget(tx, input(randomUUID()), limits),
      ),
    ).rejects.toMatchObject({ code: "OCR_BUDGET_EXHAUSTED" });
  });

  it.each([
    [
      "pages",
      { pageCount: 2 },
      { ...roomy, pages: { user: 1, tenant: 1, global: 1 } },
    ],
    [
      "bytes",
      { byteCount: 2_000 },
      { ...roomy, bytes: { user: 1_000, tenant: 1_000, global: 1_000 } },
    ],
    [
      "cost",
      {},
      {
        ...roomy,
        costUnits: {
          user: PDF_OCR_RESERVED_COST_UNITS_PER_CALL - 1,
          tenant: PDF_OCR_RESERVED_COST_UNITS_PER_CALL - 1,
          global: PDF_OCR_RESERVED_COST_UNITS_PER_CALL - 1,
        },
      },
    ],
  ] as const)(
    "rejects %s exhaustion before an attempt row",
    async (_label, overrides, limits) => {
      const reservation = input(randomUUID(), randomUUID(), overrides);
      await expect(
        prisma.$transaction((tx) =>
          reservePdfOcrBudget(tx, reservation, limits),
        ),
      ).rejects.toMatchObject({ code: "OCR_BUDGET_EXHAUSTED" });
      expect(
        await prisma.importOcrUsage.count({ where: { id: reservation.id } }),
      ).toBe(0);
    },
  );
});
