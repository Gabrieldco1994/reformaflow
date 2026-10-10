require("../../../../../scripts/test-db-env.cjs");

import { resolve } from "node:path";
import type { Prisma } from "@prisma/client";
import { ExpenseType } from "@reformaflow/domain";
import { ConciliacaoService } from "../../conciliacao/conciliacao.service";
import { validateDocumentExtraction } from "../../credit-card/parsers/statement-document";
import { createRateioTargets } from "../../expense/create-rateio-targets";
import { ExpenseService } from "../../expense/expense.service";
import {
  INCLUDE_SOFT_DELETED,
  PrismaService,
} from "../../prisma/prisma.service";
import {
  authFor,
  MutableClock,
  seedImportWorld,
  seedSession,
} from "../../test-utils/import-session-harness";
import { CardPurchaseBatchAdapter } from "./card-purchase-batch.adapter";
import { reauthorize } from "./import-session.auth";
import {
  mintLockedImportSession,
  releaseLockedImportSession,
  type LockedImportSession,
} from "./import-session.contract";
import { validateStoredDraft } from "./import-session.validation";
import { parseStoredImportObservationEvidence } from "./import-session.observation";
import { connectVaultTestDatabase } from "../../test-utils/import-session-vault-harness";

const NOW = new Date("2026-10-07T15:00:00.000Z");
const EXPIRES = new Date("2026-10-14T15:00:00.000Z");

describe("independent frozen adapter body verification", () => {
  const prisma = new PrismaService();
  const conciliacao = new ConciliacaoService(prisma);
  const expenses = new ExpenseService(prisma, conciliacao);
  const adapter = new CardPurchaseBatchAdapter(
    expenses,
    conciliacao,
    new MutableClock(NOW),
  );

  beforeAll(async () => {
    jest.useFakeTimers({
      now: NOW,
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
    expect(process.env.TZ).toBe("UTC");
    await connectVaultTestDatabase(prisma);
    const databases = await prisma.$queryRaw<
      Array<{ name: string; file: string }>
    >`PRAGMA database_list`;
    expect(databases.find((row) => row.name === "main")?.file).toBe(
      resolve(__dirname, "../../../../../prisma/test-worker-1.db"),
    );
    const fk = await prisma.$queryRaw<
      Array<{ foreign_keys: bigint | number }>
    >`PRAGMA foreign_keys`;
    expect(fk.map((row) => Number(row.foreign_keys))).toEqual([1]);
  });

  afterAll(async () => {
    expect(await prisma.$queryRaw`PRAGMA foreign_key_check`).toEqual([]);
    await prisma.$disconnect();
    jest.useRealTimers();
  });

  it("KEEP reprepare must invalidate private preflight when a target CFE is soft-deleted", async () => {
    const world = await seedImportWorld(prisma, "independent-keep-cfe-drift");
    await prisma.project.update({
      where: { id: world.projects.casa },
      data: { type: "REFORMA" },
    });
    await prisma.creditCard.update({
      where: { id: world.cards.pessoal },
      data: { closingDay: 4, dueDay: 10 },
    });
    const auth = authFor(world.users.owner, { expiresAt: EXPIRES });
    const requester = { id: auth.userId, role: "OWNER" };
    const native = await prisma.$transaction(async (tx) => {
      const source = await expenses.createPlannedCardPurchaseInTx(
        tx,
        world.tenantId,
        world.projects.pessoal,
        {
          titulo: "Independent synthetic supplier",
          fornecedor: "Independent synthetic supplier",
          tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
          categoriaMaoDeObra: null,
          dataCompra: "2026-10-05",
          totalCents: 2000,
          cardId: world.cards.pessoal,
          evidence: { documentSha256: "a".repeat(64), reference: "purchase" },
          reason: "Synthetic independent fixture",
          schedule: {
            version: 1,
            occurrences: [
              {
                index: 0,
                parcela: "1/2",
                valor: 1000,
                data: "2026-11-10",
                invoiceDueMonth: "2026-11",
              },
              {
                index: 1,
                parcela: "2/2",
                valor: 1000,
                data: "2026-12-10",
                invoiceDueMonth: "2026-12",
              },
            ],
          },
        },
        auth.userId,
        requester,
      );
      const targets = await createRateioTargets(
        tx,
        conciliacao,
        world.tenantId,
        source,
        {
          existing: [],
          newTargets: [
            {
              targetProjectId: world.projects.casa,
              tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
              titulo: "Synthetic destination",
              valor: 20,
              quantidade: 1,
              allocation: 2000,
              status: "PLANEJADO",
            },
          ],
        },
        auth.userId,
        requester,
      );
      return { source, targetId: targets.createdTargetIds[0]! };
    });
    const row = await seedSession(prisma, world, {
      revision: 7,
      consentedAt: NOW,
      lastUserEditAt: NOW,
      expiresAt: EXPIRES,
    });
    const artifact = await prisma.importArtifact.create({
      data: {
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        documentSha256: "b".repeat(64),
        verifiedBytes: 100,
        detectedFormat: "PDF",
        state: "EXTRACTED",
        parserVersion: "card-local-pdf-v1",
        storageKey: "synthetic/independent-keep-cfe-drift",
      },
    });
    await prisma.importSessionArtifact.create({
      data: {
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        sessionId: row.id,
        artifactId: artifact.id,
        position: 0,
        fileName: "synthetic.pdf",
        declaredMime: "application/pdf",
        declaredBytes: 100,
        reservedBytes: 0,
        state: "ATTACHED",
        verifiedAt: NOW,
      },
    });
    const observation = await prisma.importObservation.create({
      data: {
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        artifactId: artifact.id,
        reference: "pdf:page:1:line:1",
        evidenceJson: JSON.stringify({
          version: 1,
          reference: "pdf:page:1:line:1",
          text: "Synthetic supplier 2/2",
          amountMeaning: "INSTALLMENT_CHARGE",
          amountCents: 1000,
          installmentCount: 2,
          installmentIndex: 2,
          dataCompra: "2026-10-05",
          identity: {
            merchant: "Independent synthetic supplier",
            externalId: null,
            fitId: null,
            ordinal: 0,
            fileContentHash: "c".repeat(32),
          },
        }),
      },
    });
    const evidence = parseStoredImportObservationEvidence(
      observation.evidenceJson,
    );
    const extraction = validateDocumentExtraction({
      version: 1,
      parserVersion: "card-local-pdf-v1",
      documentKind: "INVOICE",
      invoiceDueMonth: null,
      metrics: {
        pages: 1,
        rows: 1,
        expandedBytes: 0,
        archiveEntries: 0,
        imagePixels: 0,
        frames: 0,
      },
      occurrences: [
        {
          reference: evidence.reference,
          sourceOrdinal: 0,
          section: "UNKNOWN",
          raw: {
            date: evidence.dataCompra,
            description: evidence.text,
            amount: "1000 cents",
            installment: "2/2",
          },
          cycle: null,
          dateOnly: evidence.dataCompra,
          merchant: evidence.identity.merchant,
          amountCents: evidence.amountCents,
          amountMeaning: evidence.amountMeaning,
          installmentCount: evidence.installmentCount,
          installmentIndex: evidence.installmentIndex,
          fitId: evidence.identity.fitId,
          identityOrdinal: evidence.identity.ordinal,
        },
      ],
      diagnostics: [],
    });
    await prisma.importArtifact.update({
      where: { id: artifact.id },
      data: { extractionJson: JSON.stringify(extraction) },
    });
    const draft = validateStoredDraft({
      version: 1,
      lines: [
        {
          id: "keep-line",
          observationIds: [observation.id],
          titulo: "Independent synthetic supplier",
          fornecedor: "Independent synthetic supplier",
          tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
          categoriaMaoDeObra: null,
          amountMeaning: "INSTALLMENT_CHARGE",
          amountCents: 1000,
          installmentCount: 2,
          dataCompra: "2026-10-05",
          firstDueDate: "2026-11-10",
          targets: [],
          decision: { kind: "KEEP_EXISTING", expenseId: native.source.id },
        },
      ],
      selectedLineIds: ["keep-line"],
      questions: [],
      scope: { observationIds: [observation.id], pendingAttachmentIds: [] },
    });
    await prisma.importSession.update({
      where: { id: row.id },
      data: { draftJson: JSON.stringify(draft) },
    });
    const locked = <T>(
      run: (
        tx: Prisma.TransactionClient,
        session: LockedImportSession,
      ) => Promise<T>,
    ) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`UPDATE tenants SET id = id WHERE id = ${world.tenantId}`;
        await reauthorize(tx, auth, NOW);
        const current = await tx.importSession.findUniqueOrThrow({
          where: { id: row.id },
        });
        const session = mintLockedImportSession(tx, auth, current, draft);
        try {
          return await run(tx, session);
        } finally {
          releaseLockedImportSession(session);
        }
      });
    const before = await locked(async (tx, session) => {
      const result = await adapter.prepareInTx(tx, auth, session);
      expect(result.kind).toBe("READY");
      if (result.kind !== "READY") throw new Error("Invalid KEEP fixture");
      const items = await adapter.applyInTx(tx, auth, result.batch);
      expect(items[0].cashFlowEntryIds).toHaveLength(4);
      expect(items[0].sourceExpenseId).toBe(native.source.id);
      expect(items[0].targetExpenseIds).toEqual([native.targetId]);
      return result.batch;
    });
    await prisma.importSession.update({
      where: { id: row.id },
      data: {
        state: "CONFIRMED",
        revision: 9,
        confirmedRevision: 8,
        confirmedAt: NOW,
        confirmedSessionVersion: auth.presentedSessionVersion,
        financialRequestId: "00000000-0000-4000-8000-000000000007",
        proposalJson: JSON.stringify(before.proposal),
        proposalHash: before.proposal.proposalHash,
        preflightHash: before.preflightHash,
      },
    });
    const targetCfe = await prisma.cashFlowEntry.findFirstOrThrow({
      where: { expenseId: native.targetId, parcela: "2/2" },
    });
    await prisma.cashFlowEntry.delete({ where: { id: targetCfe.id } });
    expect(
      await prisma.cashFlowEntry.findUnique({ where: { id: targetCfe.id } }),
    ).toMatchObject({ deletedAt: expect.any(Date) });
    const financialState = () =>
      prisma.cashFlowEntry.findMany({
        where: {
          tenantId: world.tenantId,
          deletedAt: INCLUDE_SOFT_DELETED,
        },
        orderBy: { id: "asc" },
      });
    const afterDeletion = await financialState();
    expect(afterDeletion).toHaveLength(4);
    expect(
      afterDeletion.filter((entry) => entry.deletedAt === null),
    ).toHaveLength(3);
    try {
      await locked(async (tx, session) => {
        const result = await adapter.prepareInTx(tx, auth, session);
        if (result.kind !== "READY") {
          expect(result).not.toHaveProperty("batch");
          return;
        }
        const items = await adapter.applyInTx(tx, auth, result.batch);
        expect(items[0].cashFlowEntryIds.slice().sort()).toEqual(
          afterDeletion
            .filter((entry) => entry.deletedAt === null)
            .map((entry) => entry.id)
            .sort(),
        );
        console.info("independent-target-cfe-drift", {
          kind: result.kind,
          sameProposalHash:
            result.batch.proposal.proposalHash === before.proposal.proposalHash,
          samePreflightHash:
            result.batch.preflightHash === before.preflightHash,
          returnedCfeCount: items[0].cashFlowEntryIds.length,
          includesDeletedCfe: items[0].cashFlowEntryIds.includes(targetCfe.id),
        });
        expect(result.batch.preflightHash).not.toBe(before.preflightHash);
      });
    } finally {
      expect(await financialState()).toEqual(afterDeletion);
    }
  });
});
