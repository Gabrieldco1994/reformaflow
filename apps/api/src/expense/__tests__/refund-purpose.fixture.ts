import { PrismaClient } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { RefundPurposeService } from "../refund-purpose.service";
import {
  resetTenant,
  seedPessoal,
  seedCardWithClosingDue,
} from "../../bank-account/__tests__/invoice-undo.fixtures";

export async function refundFixture(
  db: PrismaClient,
  prisma: PrismaService,
  tenantId: string,
) {
  const projectId = `${tenantId}-personal`;
  const targetProjectId = `${tenantId}-renovation`;
  const requester = { id: `${tenantId}-owner`, role: "OWNER" };
  await db.user.deleteMany({ where: { tenantId } });
  await resetTenant(db, tenantId);
  await seedPessoal(db, { tenantId, projectId });
  await db.user.create({
    data: {
      ...requester,
      tenantId,
      username: "owner",
      name: "Synthetic owner",
    },
  });
  await db.project.create({
    data: {
      id: targetProjectId,
      tenantId,
      type: "REFORMA",
      name: "Synthetic renovation",
    },
  });
  const card = await seedCardWithClosingDue(db, {
    tenantId,
    projectId,
    last4: "0704",
  });
  const batch = await db.creditCardStatementImport.create({
    data: {
      tenantId,
      cardId: card.id,
      source: "CSV_GENERIC",
      periodLabel: "2026-09",
    },
  });
  const source = await db.expense.create({
    data: {
      tenantId,
      projectId,
      tipoDespesa: "MATERIAL_CONSTRUCAO",
      valor: -12345,
      valorTotal: -12345,
      quantidade: 1,
      formaPagamento: "A_VISTA",
      status: "PAGO",
      cardLast4: card.last4,
      importId: batch.id,
      externalId: "synthetic-refund",
      dataPagamento: new Date("2026-09-10T00:00:00Z"),
      dataCompra: new Date("2026-08-26T00:00:00Z"),
    },
  });
  const cfe = await db.cashFlowEntry.create({
    data: {
      tenantId,
      projectId,
      expenseId: source.id,
      valor: source.valorTotal,
      tipo: "DESPESA",
      data: source.dataPagamento!,
      categoria: source.tipoDespesa,
      formaPagamento: "CARTAO_CREDITO",
      status: "PAGO",
    },
  });
  const service = new RefundPurposeService(prisma);
  const request = async () => {
    const preview = await service.execute(
      tenantId,
      projectId,
      source.id,
      requester,
      {
        mode: "preview",
        targetProjectId,
        roomId: null,
      },
    );
    return {
      mode: "apply",
      targetProjectId,
      roomId: null,
      expectedRevision: preview.revision,
      expectedFingerprint: preview.fingerprint,
    };
  };
  const apply = async (body?: unknown) => {
    const result = await service.execute(
      tenantId,
      projectId,
      source.id,
      requester,
      body ?? (await request()),
    );
    if (result.mode !== "apply") throw new Error("Expected apply");
    return result;
  };
  const cleanup = async () => {
    await db.categoryBudget.deleteMany({ where: { tenantId } });
    await db.user.deleteMany({ where: { tenantId } });
    await resetTenant(db, tenantId);
  };
  return {
    tenantId,
    projectId,
    targetProjectId,
    requester,
    source,
    card,
    batch,
    cfe,
    service,
    request,
    apply,
    cleanup,
  };
}
