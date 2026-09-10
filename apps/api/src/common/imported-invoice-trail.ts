import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * #569 — guarda compartilhada (tx-aware) da trilha de liquidação por importação.
 *
 * Ponto único de leitura de `imported_invoice_liquidations` para os DOIS pontos
 * de mutação que podem regenerar o caixa de uma COMPRA carimbada
 * (`ExpenseService.guardImportedInvoiceTrail` e o rateio em
 * `ConciliacaoService.ratearSource`). Sem casts `as any`/`as unknown`: o seam
 * `ImportedTrailDb` é exatamente `PrismaService | Prisma.TransactionClient`, e
 * ambos expõem o delegate real e tipado — o `$use` roda inclusive dentro da tx.
 */
export type ImportedTrailDb = PrismaService | Prisma.TransactionClient;

/** Mensagem 409 canônica de "há trilha ativa; desfaça a importação primeiro". */
export const IMPORTED_INVOICE_TRAIL_CONFLICT_MESSAGE =
  'Compra liquidada por pagamento de fatura importado; desfaça a importação primeiro.';

/**
 * Quantos itens de liquidação por importação ATIVOS (`deleted_at IS NULL`) têm
 * `existing.id` como COMPRA (`purchase_expense_id`). Filtra por `tenantId`
 * (defesa em profundidade, Scar #498) e lê DENTRO da tx do caller.
 */
export async function countActivePurchaseTrail(
  db: ImportedTrailDb,
  tenantId: string,
  purchaseExpenseId: string,
): Promise<number> {
  return db.importedInvoiceLiquidation.count({
    where: { tenantId, purchaseExpenseId, deletedAt: null },
  });
}

/**
 * Dentre `expenseIds`, quais são COMPRA de uma liquidação por importação ATIVA.
 * Usado para blindar o CONJUNTO EFETIVO de participantes de um rateio (fonte +
 * alvos existentes/antigos desvinculados + alvos novos) ANTES da primeira
 * escrita: regenerar o caixa de qualquer um deles órfãozaria o claim.
 */
export async function findExpensesWithActivePurchaseTrail(
  db: ImportedTrailDb,
  tenantId: string,
  expenseIds: string[],
): Promise<Set<string>> {
  const ids = [...new Set(expenseIds)];
  if (ids.length === 0) return new Set();
  const rows = await db.importedInvoiceLiquidation.findMany({
    where: { tenantId, purchaseExpenseId: { in: ids }, deletedAt: null },
    select: { purchaseExpenseId: true },
  });
  return new Set(rows.map((row) => row.purchaseExpenseId));
}
