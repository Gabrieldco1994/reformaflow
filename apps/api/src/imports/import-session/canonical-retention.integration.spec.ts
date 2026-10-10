import { randomUUID } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";

// Jest's test-db guard selects a disposable worker database and refuses dev.db.
describe("canonical import linkage retention", () => {
  const prisma = new PrismaService();
  let tenantId: string;
  let projectId: string;
  let userId: string;
  let cardId: string;

  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toMatch(/test(?:-worker-\d+)?\.db/);
    expect(process.env.DATABASE_URL).not.toContain("dev.db");
    await prisma.$connect();
    const tenant = await prisma.tenant.create({
      data: { name: "canonical retention fixture" },
    });
    tenantId = tenant.id;
    const project = await prisma.project.create({
      data: { tenantId, name: "canonical retention fixture", type: "PESSOAL" },
    });
    projectId = project.id;
    const user = await prisma.user.create({
      data: {
        tenantId,
        username: randomUUID(),
        name: "canonical retention fixture",
        role: "ADMIN",
      },
    });
    userId = user.id;
    const card = await prisma.creditCard.create({
      data: {
        tenantId,
        projectId,
        nickname: "retention fixture",
        institution: "retention fixture",
        last4: "1234",
        closingDay: 5,
        dueDay: 10,
      },
    });
    cardId = card.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createClaim() {
    const id = randomUUID();
    const expense = await prisma.expense.create({
      data: {
        id: `expense-${id}`,
        tenantId,
        projectId,
        tipoDespesa: "MATERIAL_CONSTRUCAO",
        valor: 100,
        quantidade: 1,
        valorTotal: 100,
        formaPagamento: "A_VISTA",
        status: "PLANEJADO",
      },
    });
    const artifact = await prisma.importArtifact.create({
      data: {
        tenantId,
        ownerProjectId: projectId,
        documentSha256: id.replaceAll("-", "").padEnd(64, "a").slice(0, 64),
        verifiedBytes: 1,
        detectedFormat: "CSV",
        state: "EXTRACTED",
        extractionJson: "{}",
      },
    });
    const observation = await prisma.importObservation.create({
      data: {
        tenantId,
        ownerProjectId: projectId,
        artifactId: artifact.id,
        reference: "row-1",
        evidenceJson: JSON.stringify({ sourceDescription: "private evidence" }),
        canonicalProjectId: projectId,
        canonicalExpenseId: expense.id,
        claimReceiptJson: "{}",
        claimedAt: new Date(),
      },
    });
    return { expense, artifact, observation };
  }

  async function attachArtifact(artifactId: string) {
    const now = new Date();
    const session = await prisma.importSession.create({
      data: {
        tenantId,
        ownerUserId: userId,
        ownerProjectId: projectId,
        cardId,
        kind: "CREATE_CARD_PURCHASES",
        state: "DRAFT",
        revision: 1,
        createRequestId: randomUUID(),
        createPayloadHash: "d".repeat(64),
        consentPolicyVersion: 1,
        consentedAt: now,
        updatedAt: now,
        lastUserEditAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
        draftJson: JSON.stringify({
          scope: { observationIds: [], pendingAttachmentIds: [] },
          lines: [],
        }),
      },
    });
    const attachment = await prisma.importSessionArtifact.create({
      data: {
        tenantId,
        ownerProjectId: projectId,
        sessionId: session.id,
        artifactId,
        position: 0,
        fileName: "fixture.csv",
        declaredMime: "text/csv",
        declaredBytes: 1,
        reservedBytes: 0,
        state: "ATTACHED",
        verifiedAt: now,
      },
    });
    return { session, attachment };
  }

  it("ends the claim when the canonical expense is soft-deleted inside a transaction", async () => {
    const { expense, observation } = await createClaim();

    await prisma.$transaction(async (tx) => {
      await tx.expense.update({
        where: { id: expense.id },
        data: { deletedAt: new Date() },
      });
    });

    expect(
      await prisma.importObservation.findUnique({
        where: { id: observation.id },
      }),
    ).toBeNull();
    expect(
      await prisma.expense.findUnique({ where: { id: expense.id } }),
    ).not.toBeNull();
  });

  it("prevents claims against a deleted canonical row and permits hard deletion", async () => {
    const { expense, artifact, observation } = await createClaim();
    const { attachment } = await attachArtifact(artifact.id);
    await prisma.expense.update({
      where: { id: expense.id },
      data: { deletedAt: new Date() },
    });

    expect(
      await prisma.importArtifact.findUnique({ where: { id: artifact.id } }),
    ).not.toBeNull();
    await expect(
      prisma.importObservation.create({
        data: {
          tenantId,
          ownerProjectId: projectId,
          artifactId: artifact.id,
          reference: "row-2",
          evidenceJson: "{}",
          canonicalProjectId: projectId,
          canonicalExpenseId: expense.id,
          claimReceiptJson: "{}",
          claimedAt: new Date(),
        },
      }),
    ).rejects.toThrow();

    await prisma.expense.update({
      where: { id: expense.id },
      data: { deletedAt: null },
    });
    expect(
      await prisma.importObservation.findUnique({
        where: { id: observation.id },
      }),
    ).toBeNull();

    await prisma.$executeRaw`DELETE FROM expenses WHERE id = ${expense.id}`;
    expect(
      await prisma.importObservation.findUnique({
        where: { id: observation.id },
      }),
    ).toBeNull();
    await prisma.importSessionArtifact.update({
      where: { id: attachment.id },
      data: { state: "RELEASED" },
    });
    expect(
      await prisma.importArtifact.findUnique({ where: { id: artifact.id } }),
    ).toBeNull();
  });

  it("rejects a claim transition onto an already deleted expense", async () => {
    const { expense, artifact } = await createClaim();
    const unclaimed = await prisma.importObservation.create({
      data: {
        tenantId,
        ownerProjectId: projectId,
        artifactId: artifact.id,
        reference: "unclaimed-row",
        evidenceJson: "{}",
      },
    });
    await prisma.expense.update({
      where: { id: expense.id },
      data: { deletedAt: new Date() },
    });

    await expect(
      prisma.importObservation.update({
        where: { id: unclaimed.id },
        data: {
          canonicalProjectId: projectId,
          canonicalExpenseId: expense.id,
          claimReceiptJson: "{}",
          claimedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });

  it("disposes receipt claims on a raw SQL tombstone transition", async () => {
    const receipt = await prisma.receipt.create({
      data: {
        tenantId,
        projectId,
        valor: 250,
        data: new Date(),
        tipo: "PAGAMENTO",
        status: "EM_CAIXA",
      },
    });
    const artifact = await prisma.importArtifact.create({
      data: {
        tenantId,
        ownerProjectId: projectId,
        documentSha256: randomUUID().replaceAll("-", "").padEnd(64, "c"),
        verifiedBytes: 1,
        detectedFormat: "CSV",
        state: "EXTRACTED",
      },
    });
    const observation = await prisma.importObservation.create({
      data: {
        tenantId,
        ownerProjectId: projectId,
        artifactId: artifact.id,
        reference: "receipt-row",
        evidenceJson: "{}",
        canonicalProjectId: projectId,
        canonicalReceiptId: receipt.id,
        claimReceiptJson: "{}",
        claimedAt: new Date(),
      },
    });

    await prisma.$executeRaw`
      UPDATE receipts SET deleted_at = CURRENT_TIMESTAMP
      WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND id = ${receipt.id}
    `;

    expect(
      await prisma.importObservation.findUnique({
        where: { id: observation.id },
      }),
    ).toBeNull();
    expect(
      await prisma.receipt.findUnique({ where: { id: receipt.id } }),
    ).not.toBeNull();
  });

  it("invalidates an artifact parse lease when claim disposal changes its evidence", async () => {
    const { expense, artifact } = await createClaim();
    const session = await attachArtifact(artifact.id);
    await prisma.importArtifact.update({
      where: { id: artifact.id },
      data: {
        state: "ANALYZING",
        leaseSessionId: session.session.id,
        leaseSessionVersion: 0,
        leaseTokenExpiresAt: new Date(Date.now() + 60_000),
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const generation = (
      await prisma.importArtifact.findUniqueOrThrow({
        where: { id: artifact.id },
      })
    ).parseGeneration;

    await prisma.expense.update({
      where: { id: expense.id },
      data: { deletedAt: new Date() },
    });

    const invalidated = await prisma.importArtifact.findUniqueOrThrow({
      where: { id: artifact.id },
    });
    expect(invalidated.parseGeneration).toBe(generation + 1);
    expect(invalidated.leaseSessionId).toBeNull();
    expect(invalidated.leaseSessionVersion).toBeNull();
    expect(invalidated.leaseTokenExpiresAt).toBeNull();
    expect(invalidated.leaseExpiresAt).toBeNull();
    expect(invalidated.state).toBe("PURGED");
    expect(invalidated.documentSha256).toBeNull();
    expect(invalidated.extractionJson).toBeNull();
    await expect(
      prisma.importArtifact.update({
        where: { id: artifact.id },
        data: { state: "RAW_READY", documentSha256: artifact.documentSha256 },
      }),
    ).rejects.toThrow();
  });

  it("retires the last claim with active refs, blocks resurrection and preserves never-claimed intake", async () => {
    const { expense, artifact } = await createClaim();
    const { attachment } = await attachArtifact(artifact.id);
    await prisma.importArtifact.update({
      where: { id: artifact.id },
      data: { storageKey: `objects/${artifact.id}`, parserVersion: "fixture" },
    });
    await prisma.expense.delete({ where: { id: expense.id } });
    const retired = await prisma.importArtifact.findUniqueOrThrow({
      where: { id: artifact.id },
    });
    expect(retired).toMatchObject({
      documentSha256: null,
      state: "PURGING",
      extractionJson: null,
      parserVersion: null,
      storageKey: `objects/${artifact.id}`,
    });
    expect(
      (
        await prisma.importSessionArtifact.findUniqueOrThrow({
          where: { id: attachment.id },
        })
      ).state,
    ).toBe("ATTACHED");
    for (const data of [
      { documentSha256: artifact.documentSha256 },
      { parserVersion: "resurrection", extractionJson: "{}" },
      { leaseSessionId: attachment.sessionId, leaseSessionVersion: 0 },
      { storageKey: "objects/resurrection" },
      { state: "RAW_READY" },
    ]) {
      await expect(
        prisma.importArtifact.update({
          where: { id: artifact.id },
          data,
        }),
      ).rejects.toThrow();
    }
    await expect(
      prisma.importObservation.create({
        data: {
          tenantId,
          ownerProjectId: projectId,
          artifactId: artifact.id,
          reference: "resurrection",
          evidenceJson: "{}",
        },
      }),
    ).rejects.toThrow();
    const another = await attachArtifact(artifact.id).catch(() => null);
    expect(another).toBeNull();
    const intake = await prisma.importArtifact.create({
      data: {
        tenantId,
        ownerProjectId: projectId,
        documentSha256: randomUUID().replaceAll("-", "").padEnd(64, "f"),
        verifiedBytes: 1,
        detectedFormat: "CSV",
        state: "EXTRACTED",
        extractionJson: "{}",
      },
    });
    await attachArtifact(intake.id);
    const observation = await prisma.importObservation.create({
      data: {
        tenantId,
        ownerProjectId: projectId,
        artifactId: intake.id,
        reference: "intake",
        evidenceJson: "{}",
      },
    });
    await expect(
      prisma.importObservation.update({
        where: { id: observation.id },
        data: { artifactId: artifact.id },
      }),
    ).rejects.toThrow();
    await prisma.importObservation.delete({ where: { id: observation.id } });
    expect(
      await prisma.importArtifact.findUniqueOrThrow({
        where: { id: intake.id },
      }),
    ).toEqual(intake);
    expect(await prisma.$queryRaw`PRAGMA foreign_keys`).toEqual([
      { foreign_keys: 1n },
    ]);
    expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
  });

  it("makes a purging artifact hash-unusable before a matching re-upload", async () => {
    const { expense, artifact, observation } = await createClaim();
    await prisma.importArtifact.update({
      where: { id: artifact.id },
      data: { storageKey: `objects/${artifact.id}`, extractionJson: "{}" },
    });
    await prisma.expense.update({
      where: { id: expense.id },
      data: { deletedAt: new Date() },
    });

    const retiring = await prisma.importArtifact.findUniqueOrThrow({
      where: { id: artifact.id },
    });
    expect(retiring.state).toBe("PURGING");
    expect(retiring.documentSha256).toBeNull();
    expect(retiring.extractionJson).toBeNull();
    expect(retiring.storageKey).toBe(`objects/${artifact.id}`);
    expect(
      await prisma.importObservation.findUnique({
        where: { id: observation.id },
      }),
    ).toBeNull();
    expect(
      await prisma.importArtifact.findFirst({
        where: {
          tenantId,
          ownerProjectId: projectId,
          documentSha256: artifact.documentSha256,
        },
      }),
    ).toBeNull();

    const replacement = await prisma.importArtifact.create({
      data: {
        tenantId,
        ownerProjectId: projectId,
        documentSha256: artifact.documentSha256,
        verifiedBytes: artifact.verifiedBytes,
        detectedFormat: artifact.detectedFormat,
        state: "RAW_READY",
        storageKey: `objects/reuploaded-${artifact.id}`,
      },
    });
    expect(replacement.id).not.toBe(artifact.id);
    expect(replacement.documentSha256).toBe(artifact.documentSha256);
  });

  it("does not release a claim for another canonical expense in the same artifact", async () => {
    const first = await createClaim();
    const otherExpense = await prisma.expense.create({
      data: {
        tenantId,
        projectId,
        tipoDespesa: "MATERIAL_CONSTRUCAO",
        valor: 200,
        quantidade: 1,
        valorTotal: 200,
        formaPagamento: "A_VISTA",
        status: "PLANEJADO",
      },
    });
    const other = await prisma.importObservation.create({
      data: {
        tenantId,
        ownerProjectId: projectId,
        artifactId: first.artifact.id,
        reference: "row-2",
        evidenceJson: "{}",
        canonicalProjectId: projectId,
        canonicalExpenseId: otherExpense.id,
        claimReceiptJson: "{}",
        claimedAt: new Date(),
      },
    });

    await prisma.expense.update({
      where: { id: first.expense.id },
      data: { deletedAt: new Date() },
    });

    expect(
      await prisma.importObservation.findUnique({
        where: { id: first.observation.id },
      }),
    ).toBeNull();
    expect(
      await prisma.importObservation.findUnique({
        where: { id: other.id },
      }),
    ).not.toBeNull();
    expect(
      (
        await prisma.importArtifact.findUniqueOrThrow({
          where: { id: first.artifact.id },
        })
      ).documentSha256,
    ).toBe(first.artifact.documentSha256);
    await attachArtifact(first.artifact.id);
    await prisma.expense.delete({ where: { id: otherExpense.id } });
    expect(
      (
        await prisma.importArtifact.findUniqueOrThrow({
          where: { id: first.artifact.id },
        })
      ).documentSha256,
    ).toBeNull();
  });

  it("invalidates only drafts that reference a disposed claim and preserves confirmation evidence", async () => {
    const { expense, artifact, observation } = await createClaim();
    // Partial disposal requires another live claim, not merely another row of
    // unclaimed evidence (last-claim deletion retires all of that evidence).
    const { expense: retainedExpense } = await createClaim();
    const retainedObservation = await prisma.importObservation.create({
      data: {
        tenantId,
        ownerProjectId: projectId,
        artifactId: artifact.id,
        reference: "retained-row",
        evidenceJson: "{}",
        canonicalProjectId: projectId,
        canonicalExpenseId: retainedExpense.id,
        claimReceiptJson: "{}",
        claimedAt: new Date(),
      },
    });
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60_000);
    const confirmedAt = new Date(now.getTime() - 1_000);
    const financialRequestId = randomUUID();
    const draftJson = JSON.stringify({
      version: 1,
      scope: {
        observationIds: [observation.id, retainedObservation.id],
        pendingAttachmentIds: [],
      },
      lines: [
        { id: "stale-line", observationIds: [observation.id] },
        { id: "retained-line", observationIds: [retainedObservation.id] },
      ],
      selectedLineIds: ["stale-line", "retained-line"],
      questions: [{ id: "question", lineIds: ["stale-line", "retained-line"] }],
      declarations: {
        version: 1,
        items: [
          {
            lineId: "stale-line",
            observationId: observation.id,
            field: "merchant",
          },
          {
            lineId: "retained-line",
            observationId: retainedObservation.id,
            field: "merchant",
          },
        ],
      },
    });
    const session = await prisma.importSession.create({
      data: {
        tenantId,
        ownerUserId: userId,
        ownerProjectId: projectId,
        cardId,
        kind: "CREATE_CARD_PURCHASES",
        state: "CONFIRMED",
        revision: 2,
        createRequestId: randomUUID(),
        createPayloadHash: "a".repeat(64),
        consentPolicyVersion: 1,
        consentedAt: now,
        updatedAt: now,
        lastUserEditAt: now,
        expiresAt,
        draftJson,
        proposalHash: "b".repeat(64),
        financialRequestId,
        confirmedRevision: 2,
        confirmedSessionVersion: 0,
        confirmedAt,
        challengeJson: "{}",
        prepareGeneration: 1,
        prepareLeaseJson: "{}",
      },
    });
    const unrelated = await attachArtifact(artifact.id);

    await prisma.expense.update({
      where: { id: expense.id },
      data: { deletedAt: new Date() },
    });

    const reconciled = await prisma.importSession.findUniqueOrThrow({
      where: { id: session.id },
    });
    expect(reconciled.state).toBe("REVIEW_REQUIRED");
    expect(reconciled.revision).toBe(3);
    expect(reconciled.challengeJson).toBeNull();
    expect(reconciled.prepareLeaseJson).toBeNull();
    expect(reconciled.prepareGeneration).toBe(2);
    expect(reconciled.lastUserEditAt).toEqual(now);
    expect(reconciled.expiresAt).toEqual(expiresAt);
    expect(reconciled.financialRequestId).toBe(financialRequestId);
    expect(reconciled.confirmedRevision).toBe(2);
    expect(reconciled.confirmedSessionVersion).toBe(0);
    expect(reconciled.confirmedAt).toEqual(confirmedAt);
    expect(JSON.parse(reconciled.draftJson)).toEqual({
      version: 1,
      scope: {
        observationIds: [retainedObservation.id],
        pendingAttachmentIds: [],
      },
      lines: [
        { id: "retained-line", observationIds: [retainedObservation.id] },
      ],
      selectedLineIds: ["retained-line"],
      questions: [{ id: "question", lineIds: ["retained-line"] }],
      declarations: {
        version: 1,
        items: [
          {
            lineId: "retained-line",
            observationId: retainedObservation.id,
            field: "merchant",
          },
        ],
      },
    });
    const untouched = await prisma.importSession.findUniqueOrThrow({
      where: { id: unrelated.session.id },
    });
    expect(untouched.state).toBe("DRAFT");
    expect(untouched.revision).toBe(1);
  });

  it("leaves the test database with valid foreign keys", async () => {
    expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
  });
});
