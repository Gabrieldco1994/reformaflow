import { rawTestDependencies } from "../../test-utils/import-session-raw-harness";
require("../../../../../scripts/test-db-env.cjs");
import { ImportVaultGate } from "./vault/vault-state";

import { createHash } from "node:crypto";
import type { StoredImportSearchV1 } from "./card-purchase-batch.port";
import { PrismaService } from "../../prisma/prisma.service";
import {
  authFor,
  MutableClock,
  seedImportWorld,
  seedSession,
} from "../../test-utils/import-session-harness";
import { validationDraft } from "../../test-utils/import-session-validation-fixtures";
import { RuntimeUiGrantVerifier } from "./import-session-ui-grant";
import { ImportSessionService } from "./import-session.service";

describe("S independent current-module and cursor-binding regressions", () => {
  const now = new Date("2026-10-06T15:00:00.000Z");
  const prisma = new PrismaService();
  const service = new ImportSessionService(
    prisma,
    new MutableClock(now),
    { writesEnabled: () => false, newImportFormats: () => [] },
    new RuntimeUiGrantVerifier(),
    ...rawTestDependencies(new ImportVaultGate(prisma, new MutableClock(now), {}, process.cwd()), new MutableClock(now), { writesEnabled: () => false, newImportFormats: () => [] }),
  );

  beforeAll(async () => {
    await prisma.onModuleInit();
    const [row] = await prisma.$queryRaw<
      Array<{ foreign_keys: bigint }>
    >`PRAGMA foreign_keys`;
    expect(Number(row.foreign_keys)).toBe(1);
  });

  afterAll(async () => {
    // Keep the synthetic reproduction rows in the retained per-run database.
    await prisma.onModuleDestroy();
  });

  async function fixture(tag: string, kind: "EXPENSE" | "RECEIPT") {
    const world = await seedImportWorld(prisma, `sqa-${tag}`);
    const ids = Array.from(
      { length: 26 },
      (_, index) => `${tag}-observation-${String(index).padStart(2, "0")}`,
    );
    const draft = validationDraft(world.projects.pessoal);
    draft.lines = [
      { ...draft.lines[0], observationIds: [ids[0]], targets: [] },
    ];
    draft.selectedLineIds = ["line-create"];
    draft.questions = [];
    draft.scope = { observationIds: ids, pendingAttachmentIds: [] };
    const row = await seedSession(prisma, world, {
      id: `${tag}-session`,
      ownerUserId: world.users.restricted.id,
      revision: 8,
      expiresAt: new Date("2026-10-13T15:00:00.000Z"),
      draftJson: JSON.stringify(draft),
    });
    const artifact = await prisma.importArtifact.create({
      data: {
        id: `${tag}-artifact`,
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        documentSha256: createHash("sha256").update(tag).digest("hex"),
        verifiedBytes: 100,
        detectedFormat: "CSV",
        state: "EXTRACTED",
      },
    });
    const ref = await prisma.importSessionArtifact.create({
      data: {
        id: `${tag}-ref`,
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        sessionId: row.id,
        artifactId: artifact.id,
        position: 0,
        state: "ATTACHED",
        fileName: "synthetic.csv",
        declaredMime: "text/csv",
        declaredBytes: 100,
        reservedBytes: 100,
        verifiedAt: now,
      },
    });
    await prisma.importObservation.createMany({
      data: ids.map((id, index) => ({
        id,
        tenantId: world.tenantId,
        ownerProjectId: world.projects.pessoal,
        artifactId: artifact.id,
        reference: `row-${index}`,
        evidenceJson: JSON.stringify({
          version: 1,
          reference: `row-${index}`,
          text: "Synthetic evidence",
          amountMeaning: "TOTAL_PURCHASE",
          amountCents: 101,
          installmentCount: 1,
          installmentIndex: 1,
          dataCompra: "2026-10-06",
          identity: {
            merchant: "Synthetic",
            externalId: null,
            fitId: null,
            ordinal: index,
            fileContentHash: null,
          },
        }),
      })),
    });
    const candidateIds =
      kind === "RECEIPT"
        ? [`${tag}-receipt`]
        : ids.map(
            (_, index) => `${tag}-expense-${String(index).padStart(2, "0")}`,
          );
    if (kind === "RECEIPT") {
      await prisma.receipt.create({
        data: {
          id: candidateIds[0],
          tenantId: world.tenantId,
          projectId: world.projects.pessoal,
          valor: 123456,
          data: new Date("2026-10-06T00:00:00.000Z"),
          tipo: "OUTROS",
          descricao: "SYNTHETIC_RECEIPT_PRIVATE_TO_MODULE",
        },
      });
    } else {
      await prisma.expense.createMany({
        data: candidateIds.map((id) => ({
          id,
          tenantId: world.tenantId,
          projectId: world.projects.pessoal,
          tipoDespesa: "MATERIAL_CONSTRUCAO",
          titulo: "Synthetic candidate",
          valor: 101,
          valorTotal: 101,
          quantidade: 1,
          formaPagamento: "A_VISTA",
          dataCompra: new Date("2026-10-06T00:00:00.000Z"),
        })),
      });
    }
    const search: StoredImportSearchV1 = {
      version: 1,
      revision: 8,
      complete: true,
      candidates: candidateIds.map((id) => ({
        lineId: "line-create",
        kind,
        id,
        reason: "NATURAL_MATCH",
      })),
      coverage: {
        recipe: "CARD_PURCHASE_V1",
        inputHash: "a".repeat(64),
        steps: [
          {
            lineId: "line-create",
            stage: "DOCUMENT_IDENTITY",
            status: "EXHAUSTED",
            predicateHash: "b".repeat(64),
            visitedRows: 0,
            endCursor: null,
          },
          {
            lineId: "line-create",
            stage: "CROSS_ORIGIN",
            status: "EXHAUSTED",
            predicateHash: "c".repeat(64),
            visitedRows: candidateIds.length,
            endCursor: null,
          },
          {
            lineId: "line-create",
            stage: "CARD_IDENTITY",
            status: "EXHAUSTED",
            predicateHash: "d".repeat(64),
            visitedRows: 0,
            endCursor: null,
          },
        ],
      },
    };
    await prisma.importSession.update({
      where: { id: row.id },
      data: { searchJson: JSON.stringify(search) },
    });
    const auth = authFor(world.users.restricted, {
      expiresAt: new Date("2026-10-07T15:00:00.000Z"),
    });
    return { world, row, draft, search, auth, ref, ids, candidateIds };
  }

  it("does not disclose a Receipt after its module is revoked while expenses and creditCards remain", async () => {
    const f = await fixture("receipt-acl", "RECEIPT");
    await prisma.user.update({
      where: { id: f.world.users.restricted.id },
      data: {
        allowedModules: JSON.stringify(["creditCards", "expenses", "receipts"]),
      },
    });
    expect(
      await service.getCandidates(f.auth, f.row.id, { lineId: "line-create" }),
    ).toEqual({
      items: [
        {
          lineId: "line-create",
          kind: "RECEIPT",
          id: f.candidateIds[0],
          projectId: f.world.projects.pessoal,
          description: "SYNTHETIC_RECEIPT_PRIVATE_TO_MODULE",
          amountCents: 123456,
          date: "2026-10-06",
          reason: "NATURAL_MATCH",
          canKeepExisting: false,
        },
      ],
      nextCursor: null,
    });
    await prisma.user.update({
      where: { id: f.world.users.restricted.id },
      data: { allowedModules: JSON.stringify(["creditCards", "expenses"]) },
    });
    const missing = await fixture("receipt-missing", "RECEIPT");
    await prisma.receipt.delete({ where: { id: missing.candidateIds[0] } });
    const empty = await service.getCandidates(missing.auth, missing.row.id, {
      lineId: "line-create",
    });
    expect(empty).toEqual({ items: [], nextCursor: null });
    expect(
      await service.getCandidates(f.auth, f.row.id, { lineId: "line-create" }),
    ).toEqual(empty);
  });
});
