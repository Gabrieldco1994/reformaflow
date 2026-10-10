import { randomUUID } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";

const now = new Date("2026-09-28T12:00:00.000Z");
const deadline = new Date("2026-10-05T12:00:00.000Z");
const emptyDraft =
  '{"version":1,"lines":[],"selectedLineIds":[],"questions":[],"scope":{"observationIds":[],"pendingAttachmentIds":[]}}';

describe("bootstrap schema with real PrismaService and FK enforcement", () => {
  const db = new PrismaService();
  const prefix = `bootstrap-${randomUUID()}`;
  const tenantId = `${prefix}-tenant`;
  const ownerUserId = `${prefix}-user`;
  const ownerProjectId = `${prefix}-project`;
  const cardId = `${prefix}-card`;
  let sessionId: string;
  let artifactId: string;

  beforeAll(async () => {
    await db.$connect();
    await db.tenant.create({
      data: { id: tenantId, name: "Synthetic schema tenant" },
    });
    await db.user.create({
      data: {
        id: ownerUserId,
        tenantId,
        username: prefix,
        name: "Synthetic actor",
      },
    });
    await db.project.create({
      data: {
        id: ownerProjectId,
        tenantId,
        name: "Synthetic anchor",
        type: "PESSOAL",
      },
    });
    await db.creditCard.create({
      data: {
        id: cardId,
        tenantId,
        projectId: ownerProjectId,
        institution: "OUTROS",
        nickname: "Synthetic card",
        last4: "1234",
      },
    });
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  const sessionData = () => ({
    tenantId,
    ownerUserId,
    ownerProjectId,
    cardId,
    kind: "CREATE_CARD_PURCHASES",
    state: "DRAFT",
    revision: 1,
    createRequestId: randomUUID(),
    createPayloadHash: "a".repeat(64),
    consentPolicyVersion: 1,
    consentedAt: now,
    lastUserEditAt: now,
    expiresAt: deadline,
    draftJson: emptyDraft,
  });
  const artifactData = () => ({
    tenantId,
    ownerProjectId,
    documentSha256: "b".repeat(64),
    verifiedBytes: 10485760,
    detectedFormat: "PNG",
    state: "RAW_READY",
  });

  it("supports all four lifecycle models without soft-delete injection, also inside tx", async () => {
    const session = await db.importSession.create({ data: sessionData() });
    sessionId = session.id;
    const artifact = await db.importArtifact.create({ data: artifactData() });
    artifactId = artifact.id;
    const attachment = await db.importSessionArtifact.create({
      data: {
        tenantId,
        ownerProjectId,
        sessionId,
        artifactId,
        position: 9,
        fileName: "synthetic.png",
        declaredMime: "image/png",
        declaredBytes: 10485760,
        state: "ATTACHED",
        reservedBytes: 0,
        verifiedAt: now,
      },
    });
    const observation = await db.importObservation.create({
      data: {
        tenantId,
        ownerProjectId,
        artifactId,
        reference: "page:1/row:1",
        evidenceJson: '{"version":1}',
      },
    });
    expect(
      await db.importSession.findFirst({ where: { id: sessionId } }),
    ).not.toBeNull();
    expect(
      await db.importArtifact.findMany({ where: { id: artifactId } }),
    ).toHaveLength(1);
    await db.$transaction(async (tx) => {
      expect(
        await tx.importSessionArtifact.findFirst({
          where: { id: attachment.id },
        }),
      ).not.toBeNull();
      expect(
        await tx.importObservation.findMany({ where: { id: observation.id } }),
      ).toHaveLength(1);
      const disposable = await tx.importObservation.create({
        data: {
          tenantId,
          ownerProjectId,
          artifactId,
          reference: "disposable",
          evidenceJson: '{"version":1}',
        },
      });
      await tx.importObservation.delete({ where: { id: disposable.id } });
      expect(
        await tx.importObservation.findUnique({ where: { id: disposable.id } }),
      ).toBeNull();
    });
    expect(session.expiresAt).toEqual(deadline);
  });

  it("rejects cross-tenant/anchor relations and dangling canonical financial links", async () => {
    await expect(
      db.importSession.create({
        data: { ...sessionData(), tenantId: "other-tenant" },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      db.importArtifact.create({
        data: { ...artifactData(), ownerProjectId: "other-anchor" },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      db.importSessionArtifact.create({
        data: {
          tenantId,
          ownerProjectId: "other-anchor",
          sessionId,
          artifactId: null,
          position: 0,
          fileName: "other.png",
          declaredMime: "image/png",
          declaredBytes: 1,
          state: "RESERVED",
          reservedBytes: 1,
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      db.importObservation.create({
        data: {
          tenantId,
          ownerProjectId,
          artifactId,
          reference: "invalid-claim",
          evidenceJson: '{"version":1}',
          canonicalProjectId: ownerProjectId,
          canonicalExpenseId: "missing-expense",
          claimSessionId: sessionId,
          claimReceiptJson: '{"kind":"SESSION"}',
          claimedAt: now,
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("enforces stable per-file and occurrence identity, without collapsing twins", async () => {
    await expect(
      db.importArtifact.create({ data: artifactData() }),
    ).rejects.toMatchObject({ code: "P2002" });
    await expect(
      db.importObservation.create({
        data: {
          tenantId,
          ownerProjectId,
          artifactId,
          reference: "page:1/row:1",
          evidenceJson: '{"version":1}',
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    await db.importObservation.create({
      data: {
        tenantId,
        ownerProjectId,
        artifactId,
        reference: "page:1/row:2",
        evidenceJson: '{"version":1}',
      },
    });
    expect(await db.importObservation.count({ where: { artifactId } })).toBe(2);
  });

  it("rejects existing foreign parents and same-tenant wrong anchors, not only missing IDs", async () => {
    const foreignTenant = `${prefix}-foreign`;
    const foreignProject = `${prefix}-foreign-project`;
    const foreignUser = `${prefix}-foreign-user`;
    const foreignCard = `${prefix}-foreign-card`;
    const siblingProject = `${prefix}-sibling`;
    const siblingCard = `${prefix}-sibling-card`;
    await db.tenant.create({
      data: { id: foreignTenant, name: "Foreign fixture" },
    });
    await db.project.create({
      data: {
        id: foreignProject,
        tenantId: foreignTenant,
        name: "Foreign fixture",
      },
    });
    await db.user.create({
      data: {
        id: foreignUser,
        tenantId: foreignTenant,
        username: foreignUser,
        name: "Foreign actor",
      },
    });
    await db.project.create({
      data: { id: siblingProject, tenantId, name: "Sibling anchor" },
    });
    for (const card of [
      { id: foreignCard, tenantId: foreignTenant, projectId: foreignProject },
      { id: siblingCard, tenantId, projectId: siblingProject },
    ]) {
      await db.creditCard.create({
        data: {
          ...card,
          institution: "OUTROS",
          nickname: "Fixture",
          last4: "1234",
        },
      });
    }
    for (const data of [
      { ...sessionData(), ownerUserId: foreignUser },
      { ...sessionData(), ownerProjectId: foreignProject },
      { ...sessionData(), cardId: foreignCard },
      { ...sessionData(), cardId: siblingCard },
    ]) {
      await expect(db.importSession.create({ data })).rejects.toMatchObject({
        code: "P2003",
      });
    }
    const siblingSession = await db.importSession.create({
      data: {
        ...sessionData(),
        ownerProjectId: siblingProject,
        cardId: siblingCard,
      },
    });
    const siblingArtifact = await db.importArtifact.create({
      data: {
        ...artifactData(),
        ownerProjectId: siblingProject,
      },
    });
    await expect(
      db.importArtifact.update({
        where: { id: artifactId },
        data: {
          leaseSessionId: siblingSession.id,
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      db.importSessionArtifact.create({
        data: {
          tenantId,
          ownerProjectId,
          sessionId,
          artifactId: siblingArtifact.id,
          position: 0,
          fileName: "sibling.png",
          declaredMime: "image/png",
          declaredBytes: 1,
          reservedBytes: 1,
          state: "RESERVED",
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
    const foreignExpense = await db.expense.create({
      data: {
        tenantId: foreignTenant,
        projectId: foreignProject,
        tipoDespesa: "OUTROS",
        valor: 1,
        valorTotal: 1,
        formaPagamento: "A_VISTA",
      },
    });
    const foreignReceipt = await db.receipt.create({
      data: {
        tenantId: foreignTenant,
        projectId: foreignProject,
        valor: 1,
        data: now,
        tipo: "OUTROS",
      },
    });
    for (const entity of [
      { canonicalExpenseId: foreignExpense.id },
      { canonicalReceiptId: foreignReceipt.id },
    ]) {
      await expect(
        db.importObservation.create({
          data: {
            tenantId,
            ownerProjectId,
            artifactId,
            reference: randomUUID(),
            evidenceJson: '{"version":1}',
            canonicalProjectId: foreignProject,
            ...entity,
            claimReceiptJson:
              '{"kind":"LEGACY_IMPORT","engine":"CARD","importId":null,"externalId":"synthetic"}',
            claimedAt: now,
          },
        }),
      ).rejects.toMatchObject({ code: "P2003" });
    }
    const ownExpense = await db.expense.create({
      data: {
        tenantId,
        projectId: ownerProjectId,
        tipoDespesa: "OUTROS",
        valor: 1,
        valorTotal: 1,
        formaPagamento: "A_VISTA",
      },
    });
    await expect(
      db.importObservation.create({
        data: {
          tenantId,
          ownerProjectId,
          artifactId,
          reference: randomUUID(),
          evidenceJson: '{"version":1}',
          canonicalProjectId: ownerProjectId,
          canonicalExpenseId: ownExpense.id,
          claimSessionId: siblingSession.id,
          claimReceiptJson: '{"kind":"SESSION"}',
          claimedAt: now,
        },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("keeps confirmation idempotency keys unique and financial references RESTRICTed", async () => {
    const financialRequestId = randomUUID();
    const confirmation = {
      financialRequestId,
      confirmedRevision: 1,
      confirmedSessionVersion: 0,
      confirmedAt: now,
      proposalHash: "c".repeat(64),
    };
    await db.importSession.update({
      where: { id: sessionId },
      data: confirmation,
    });
    await expect(
      db.importSession.create({
        data: {
          ...sessionData(),
          ...confirmation,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    const original = await db.importSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
    await expect(
      db.importSession.create({
        data: {
          ...sessionData(),
          createRequestId: original.createRequestId,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    const expense = await db.expense.create({
      data: {
        tenantId,
        projectId: ownerProjectId,
        tipoDespesa: "OUTROS",
        valor: 1,
        valorTotal: 1,
        formaPagamento: "A_VISTA",
      },
    });
    const claim = await db.importObservation.create({
      data: {
        tenantId,
        ownerProjectId,
        artifactId,
        reference: "claimed",
        evidenceJson: '{"version":1}',
        canonicalProjectId: ownerProjectId,
        canonicalExpenseId: expense.id,
        canonicalIndex: 2147483647,
        claimSessionId: sessionId,
        claimReceiptJson: JSON.stringify({
          kind: "SESSION",
          sessionId,
          financialRequestId,
        }),
        claimedAt: now,
      },
    });
    await expect(
      db.$executeRaw`DELETE FROM expenses WHERE id=${expense.id}`,
    ).rejects.toThrow();
    // $use still soft-deletes financial parents: retention must not cascade to the claim.
    await db.expense.delete({ where: { id: expense.id } });
    expect(
      (await db.expense.findUniqueOrThrow({ where: { id: expense.id } }))
        .deletedAt,
    ).not.toBeNull();
    expect(
      (
        await db.importObservation.findUniqueOrThrow({
          where: { id: claim.id },
        })
      ).canonicalExpenseId,
    ).toBe(expense.id);
    await expect(
      db.importSession.delete({ where: { id: sessionId } }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("bypasses soft-delete for all four models' reads and deletes inside the same transaction", async () => {
    await db.$transaction(async (tx) => {
      const session = await tx.importSession.create({ data: sessionData() });
      const artifact = await tx.importArtifact.create({
        data: {
          ...artifactData(),
          documentSha256: "d".repeat(64),
          verifiedBytes: 1,
        },
      });
      const attachment = await tx.importSessionArtifact.create({
        data: {
          tenantId,
          ownerProjectId,
          sessionId: session.id,
          artifactId: artifact.id,
          position: 0,
          fileName: "temporary.png",
          declaredMime: "image/png",
          declaredBytes: 1,
          reservedBytes: 10485760,
          state: "RESERVED",
        },
      });
      await tx.importObservation.create({
        data: {
          tenantId,
          ownerProjectId,
          artifactId: artifact.id,
          reference: "temporary",
          evidenceJson: '{"version":1}',
        },
      });
      expect(
        await tx.importSession.findMany({ where: { id: session.id } }),
      ).toHaveLength(1);
      expect(
        await tx.importArtifact.findFirst({ where: { id: artifact.id } }),
      ).not.toBeNull();
      expect(
        await tx.importSessionArtifact.findMany({
          where: { id: attachment.id },
        }),
      ).toHaveLength(1);
      expect(
        await tx.importObservation.findFirst({
          where: { artifactId: artifact.id },
        }),
      ).not.toBeNull();
      await tx.importObservation.deleteMany({
        where: { artifactId: artifact.id },
      });
      await tx.importSessionArtifact.delete({ where: { id: attachment.id } });
      await tx.importArtifact.delete({ where: { id: artifact.id } });
      await tx.importSession.deleteMany({ where: { id: session.id } });
      expect(
        await tx.importObservation.count({
          where: { artifactId: artifact.id },
        }),
      ).toBe(0);
      expect(
        await tx.importSessionArtifact.count({ where: { id: attachment.id } }),
      ).toBe(0);
      expect(
        await tx.importArtifact.count({ where: { id: artifact.id } }),
      ).toBe(0);
      expect(await tx.importSession.count({ where: { id: session.id } })).toBe(
        0,
      );
    });
  });

  it("enforces SQL bounds, closed states and cross-column invariants", async () => {
    for (const revision of [0, -1, 2147483648]) {
      await expect(
        db.$executeRaw`UPDATE import_sessions SET revision=${revision} WHERE id=${sessionId}`,
      ).rejects.toThrow();
    }
    await db.importSession.update({
      where: { id: sessionId },
      data: { revision: 2147483647 },
    });
    await expect(
      db.importSession.update({
        where: { id: sessionId },
        data: { state: "UNKNOWN" },
      }),
    ).rejects.toThrow();
    await expect(
      db.importSession.update({
        where: { id: sessionId },
        data: { state: "APPLIED" },
      }),
    ).rejects.toThrow();
    await expect(
      db.importSession.create({
        data: { ...sessionData(), financialRequestId: randomUUID() },
      }),
    ).rejects.toThrow();
    await expect(
      db.importSession.update({
        where: { id: sessionId },
        data: { confirmedAt: null },
      }),
    ).rejects.toThrow();
    for (const verifiedBytes of [0, -1, 10485761]) {
      await expect(
        db.importArtifact.update({
          where: { id: artifactId },
          data: { verifiedBytes },
        }),
      ).rejects.toThrow();
    }
    await expect(
      db.importArtifact.update({
        where: { id: artifactId },
        data: { state: "PURGED", storageKey: "private" },
      }),
    ).rejects.toThrow();
    await expect(
      db.importObservation.updateMany({
        where: { artifactId },
        data: { canonicalIndex: 0 },
      }),
    ).rejects.toThrow();
    expect(await db.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
  });

  it("retains NOT NULL historical deadline and valid empty draft at terminal state", async () => {
    await db.importSession.update({
      where: { id: sessionId },
      data: { state: "EXPIRED", closedAt: deadline, draftJson: emptyDraft },
    });
    const terminal = await db.importSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
    expect(terminal.expiresAt).toEqual(deadline);
    expect(JSON.parse(terminal.draftJson)).toEqual({
      version: 1,
      lines: [],
      selectedLineIds: [],
      questions: [],
      scope: { observationIds: [], pendingAttachmentIds: [] },
    });
    await expect(
      db.$executeRaw`UPDATE import_sessions SET expires_at=NULL WHERE id=${sessionId}`,
    ).rejects.toThrow();
  });
});
