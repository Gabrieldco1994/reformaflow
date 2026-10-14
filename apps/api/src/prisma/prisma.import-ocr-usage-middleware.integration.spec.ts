import { randomUUID } from "node:crypto";
import { PrismaService } from "./prisma.service";

const NOW = new Date("2026-10-13T23:30:00.000Z");

describe("PrismaService ImportOcrUsage middleware exemption", () => {
  const prisma = new PrismaService();

  beforeAll(() => prisma.$connect());
  afterAll(() => prisma.$disconnect());

  it("keeps transaction reads and deletes physical for the non-soft-delete model", async () => {
    const tenantId = (
      await prisma.tenant.create({ data: { name: "OCR middleware" } })
    ).id;
    const userId = (
      await prisma.user.create({
        data: {
          tenantId,
          username: randomUUID(),
          name: "OCR middleware",
          role: "ADMIN",
        },
      })
    ).id;
    const ownerProjectId = (
      await prisma.project.create({
        data: { tenantId, name: "OCR middleware", type: "PESSOAL" },
      })
    ).id;
    const cardId = (
      await prisma.creditCard.create({
        data: {
          tenantId,
          projectId: ownerProjectId,
          nickname: "OCR",
          institution: "fixture",
          last4: "0719",
        },
      })
    ).id;
    const sessionId = randomUUID();
    const artifactId = randomUUID();
    const attachmentId = randomUUID();
    await prisma.importSession.create({
      data: {
        id: sessionId,
        tenantId,
        ownerUserId: userId,
        ownerProjectId,
        cardId,
        kind: "CREATE_CARD_PURCHASES",
        state: "DRAFT",
        revision: 1,
        createRequestId: randomUUID(),
        createPayloadHash: "a".repeat(64),
        consentPolicyVersion: 1,
        consentedAt: NOW,
        lastUserEditAt: NOW,
        expiresAt: new Date("2026-10-14T23:30:00.000Z"),
        draftJson:
          '{"version":1,"lines":[],"selectedLineIds":[],"questions":[],"scope":{"observationIds":[],"pendingAttachmentIds":[]}}',
      },
    });
    await prisma.importArtifact.create({
      data: {
        id: artifactId,
        tenantId,
        ownerProjectId,
        documentSha256: "b".repeat(64),
        verifiedBytes: 128,
        detectedFormat: "PDF",
        state: "RAW_READY",
        storageKey: `fixture/${artifactId}`,
      },
    });
    await prisma.importSessionArtifact.create({
      data: {
        id: attachmentId,
        tenantId,
        ownerProjectId,
        sessionId,
        artifactId,
        position: 0,
        fileName: "fixture.pdf",
        declaredMime: "application/pdf",
        declaredBytes: 128,
        state: "ATTACHED",
        reservedBytes: 128,
        verifiedAt: NOW,
      },
    });
    const usageId = randomUUID();
    await prisma.importOcrUsage.create({
      data: {
        id: usageId,
        day: "2026-10-13",
        tenantId,
        ownerProjectId,
        actorId: userId,
        sessionId,
        attachmentId,
        artifactId,
        artifactSha256: "b".repeat(64),
        requestId: randomUUID(),
        provider: "vertex-ai",
        model: "gemini-2.5-flash",
        reservedCalls: 1,
        reservedPages: 1,
        reservedBytes: 128,
        reservedCostUnits: 32_768,
        outcome: "NOT_DISPATCHED",
      },
    });

    await prisma.$transaction(async (tx) => {
      await expect(
        tx.importOcrUsage.findMany({ where: { id: usageId } }),
      ).resolves.toHaveLength(1);
      await expect(
        tx.importOcrUsage.deleteMany({ where: { id: usageId } }),
      ).resolves.toEqual({ count: 1 });
    });

    expect(
      await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT count(*) AS count FROM "import_ocr_usage" WHERE "id" = ${usageId}
      `,
    ).toEqual([{ count: 0n }]);
  });
});
