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
type Reservation = ReturnType<typeof input>;

async function persistReservationParents(
  prisma: PrismaService,
  reservation: Reservation,
): Promise<void> {
  await prisma.tenant.upsert({
    where: { id: reservation.tenantId },
    update: {},
    create: { id: reservation.tenantId, name: "OCR budget fixture" },
  });
  await prisma.user.upsert({
    where: { id: reservation.actorId },
    update: {},
    create: {
      id: reservation.actorId,
      tenantId: reservation.tenantId,
      username: reservation.actorId,
      name: "OCR budget fixture",
      role: "ADMIN",
    },
  });
  await prisma.project.create({
    data: {
      id: reservation.ownerProjectId,
      tenantId: reservation.tenantId,
      name: "OCR budget fixture",
      type: "PESSOAL",
    },
  });
  const cardId = randomUUID();
  await prisma.creditCard.create({
    data: {
      id: cardId,
      tenantId: reservation.tenantId,
      projectId: reservation.ownerProjectId,
      nickname: "OCR",
      institution: "fixture",
      last4: "0719",
    },
  });
  await prisma.importSession.create({
    data: {
      id: reservation.sessionId,
      tenantId: reservation.tenantId,
      ownerUserId: reservation.actorId,
      ownerProjectId: reservation.ownerProjectId,
      cardId,
      kind: "CREATE_CARD_PURCHASES",
      state: "DRAFT",
      revision: 1,
      createRequestId: randomUUID(),
      createPayloadHash: "b".repeat(64),
      consentPolicyVersion: 1,
      consentedAt: now,
      lastUserEditAt: now,
      expiresAt: new Date("2026-10-14T20:00:00.000Z"),
      draftJson:
        '{"version":1,"lines":[],"selectedLineIds":[],"questions":[],"scope":{"observationIds":[],"pendingAttachmentIds":[]}}',
    },
  });
  await prisma.importArtifact.create({
    data: {
      id: reservation.artifactId,
      tenantId: reservation.tenantId,
      ownerProjectId: reservation.ownerProjectId,
      documentSha256: reservation.artifactSha256,
      verifiedBytes: reservation.byteCount,
      detectedFormat: "PDF",
      state: "RAW_READY",
      storageKey: `fixture/${reservation.artifactId}`,
    },
  });
  await prisma.importSessionArtifact.create({
    data: {
      id: reservation.attachmentId,
      tenantId: reservation.tenantId,
      ownerProjectId: reservation.ownerProjectId,
      sessionId: reservation.sessionId,
      artifactId: reservation.artifactId,
      position: 0,
      fileName: "fixture.pdf",
      declaredMime: "application/pdf",
      declaredBytes: reservation.byteCount,
      state: "ATTACHED",
      reservedBytes: reservation.byteCount,
      verifiedAt: now,
    },
  });
}

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
    const reservations = [input(tenantId, actorId), input(tenantId, actorId)];
    for (const reservation of reservations)
      await persistReservationParents(prisma, reservation);
    const outcomes = await Promise.allSettled(
      reservations.map((reservation) =>
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
    await persistReservationParents(prisma, first);
    await prisma.$transaction((tx) => reservePdfOcrBudget(tx, first, limits));
    await prisma.$transaction((tx) =>
      reconcilePdfOcrBudget(tx, first.id, "UNKNOWN", now, null),
    );
    const restarted = new PrismaService();
    await restarted.$connect();
    try {
      const second = input(tenantId, actorId);
      await persistReservationParents(restarted, second);
      await expect(
        restarted.$transaction((tx) => reservePdfOcrBudget(tx, second, limits)),
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
    const first = input(tenantId);
    const sameTenant = input(tenantId);
    const otherTenant = input(randomUUID());
    for (const reservation of [first, sameTenant, otherTenant])
      await persistReservationParents(prisma, reservation);
    await prisma.$transaction((tx) => reservePdfOcrBudget(tx, first, limits));
    await expect(
      prisma.$transaction((tx) => reservePdfOcrBudget(tx, sameTenant, limits)),
    ).rejects.toMatchObject({ code: "OCR_BUDGET_EXHAUSTED" });
    await expect(
      prisma.$transaction((tx) => reservePdfOcrBudget(tx, otherTenant, limits)),
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
      await persistReservationParents(prisma, reservation);
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
