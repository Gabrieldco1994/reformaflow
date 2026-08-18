import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  caixaMonthForCardPurchase,
  addMonthsToMonthKey,
  invoiceMatchTolerance,
  NEUTRAL_EXPENSE_TYPES,
  isSinglePaymentForm,
} from '@reformaflow/domain';
import { userCanAccessProject, userCanAccessProjectType } from '../common/access-rules';
import {
  assertRateioRequester,
  type RateioRequester,
} from '../expense/rateio.types';

export interface SettleCard {
  id: string;
  last4: string;
  closingDay: number | null;
  dueDay: number | null;
}

interface ExpenseRow {
  id: string;
  tenantId: string;
  cardLast4: string | null;
  tipoDespesa: string;
  formaPagamento: string;
  quantidadeParcela: number | null;
  status: string;
  paidParcelas: string | null;
}

interface SettlementExpenseRow extends ExpenseRow {
  project: { id: string; type: string; tenantId: string } | null;
}

interface EntryRow {
  id: string;
  expenseId: string;
  status: string;
  parcela: string | null;
  data: Date;
  valor: number;
}

interface UnsettlePurchase {
  expense: ExpenseRow;
  entries: EntryRow[];
}

interface SettlePurchase {
  expense: SettlementExpenseRow;
  entries: EntryRow[];
}

const INVOICE_NOT_FOUND_MESSAGE = 'Fatura não encontrada';

export interface PreparedInvoiceUnsettlement {
  tenantId: string;
  card: SettleCard;
  dueMonth: string;
  purchases: UnsettlePurchase[];
}

/**
 * Liquidação automática de fatura de cartão (modelo de caixa real).
 *
 * Quando o PAGAMENTO de uma fatura de cartão aparece no extrato bancário, as
 * compras daquela fatura (que foram importadas como PLANEJADO) devem virar
 * PAGO. Esta é a contraparte do `createExpenseFromTransaction` do cartão, que
 * grava tudo como PLANEJADO até o pagamento efetivo.
 *
 * Estratégia (combo, decisão do usuário):
 *   1. Por VENCIMENTO (preferida quando o cartão tem closingDay/dueDay): decide
 *      QUAL fatura o pagamento quita e SÓ realiza quando o valor fecha a fatura.
 *      - O alvo é escolhido na MESMA janela `{payMonth, payMonth+1}` que o
 *        read-model (`assignImplicitPayments`): entre as faturas do cartão cujo
 *        vencimento (`caixaMonthForCardPurchase` sobre cada lançamento) cai nessa
 *        janela, escolhe a de total mais próximo do valor pago; empate → mês de
 *        vencimento mais antigo (idêntico ao `assignImplicitPayments`).
 *      - Pagamento PARCIAL (valor não fecha o total da fatura, dentro de
 *        `invoiceMatchTolerance` = `max(R$2,00; 0,5%)`) NÃO marca nenhuma compra
 *        como paga — nada é realizado até fechar o total.
 *      - Quando fecha, marca como PAGO apenas os lançamentos PLANEJADO daquele
 *        `dueMonth` (não do mês do PAGAMENTO).
 *   2. Fallback por FATURA IMPORTADA: se o cartão não tem dias configurados (ou
 *      nada casou por vencimento), procura uma importação de fatura com total ≈
 *      valor do pagamento e liquida a parcela em aberto mais antiga de cada
 *      compra daquela importação.
 *
 * Opera diretamente sobre os `cashFlowEntry` existentes (fonte de verdade das
 * datas/labels das parcelas) e mantém `Expense.paidParcelas`/`status`
 * coerentes — sem reconstruir o fluxo do zero (evita acoplar a engine de
 * despesas e dependências circulares).
 */
@Injectable()
export class CardInvoiceSettlementService {
  private readonly logger = new Logger(CardInvoiceSettlementService.name);

  constructor(private readonly prisma: PrismaService) {}

  async settleInvoice(params: {
    tenantId: string;
    card: SettleCard;
    amountCents: number;
    paymentDate: Date;
    requester: RateioRequester;
  }): Promise<{ settledExpenses: number; settledParcelas: number }> {
    assertRateioRequester(params.requester);
    const { tenantId, card, amountCents, paymentDate } = params;
    return this.prisma.$transaction(async (tx) => {
      await this.assertCanAccessCard({ tenantId, card, tx, requester: params.requester });
      const neutral = Array.from(NEUTRAL_EXPENSE_TYPES);
      const hasDays = card.closingDay != null && card.dueDay != null;

      // ── Estratégia 1: por vencimento, respeitando o VALOR pago ────
      if (hasDays) {
        const purchases = await tx.expense.findMany({
          where: {
            tenantId,
            cardLast4: card.last4,
            deletedAt: null,
            tipoDespesa: { notIn: neutral },
          },
          include: {
            project: { select: { id: true, type: true, tenantId: true } },
          },
        });

        const target = await this.resolveTargetDueMonth(
          tx,
          purchases,
          card,
          amountCents,
          paymentDate,
        );
        if (target) {
          const prepared = await this.prepareDueMonthSettlement(
            tx,
            tenantId,
            purchases,
            card,
            target,
            params.requester,
          );
          if (prepared.length > 0) {
            return this.applyPreparedSettlement(tx, prepared);
          }
        }
      }

      // ── Estratégia 2 (fallback): por fatura importada ───────────
      const matchedImport = await this.findImportByTotal(
        tx,
        tenantId,
        card.id,
        amountCents,
        paymentDate,
      );
      if (!matchedImport) return { settledExpenses: 0, settledParcelas: 0 };

      const purchases = await tx.expense.findMany({
        where: {
          tenantId,
          importId: matchedImport.id,
          cardLast4: card.last4,
          deletedAt: null,
          tipoDespesa: { notIn: neutral },
        },
        include: {
          project: { select: { id: true, type: true, tenantId: true } },
        },
      });
      const prepared = await this.prepareEarliestSettlement(
        tx,
        tenantId,
        purchases,
        params.requester,
      );
      return this.applyPreparedSettlement(tx, prepared);
    });
  }

  /**
   * Decide QUAL fatura o pagamento quita e se o valor a fecha.
   *
   * Espelha `assignImplicitPayments` do read-model: a janela de casamento é
   * `{payMonth, payMonth+1}` (uma fatura que vence dia 1 é paga no fim do mês
   * anterior), e entre as faturas candidatas escolhe a de total mais próximo do
   * valor pago (empate → vencimento mais antigo). Só devolve o `dueMonth` quando
   * o valor pago fecha o total da fatura dentro de `invoiceMatchTolerance`
   * (`max(R$2,00; 0,5%)`); pagamento parcial devolve `null` (nada é realizado).
   *
   * O total de cada fatura é a soma de TODOS os lançamentos daquele ciclo
   * (qualquer status), como em `buildCardInvoiceAggregates` — é o valor cobrado
   * pelo banco, contra o qual o pagamento é confrontado.
   */
  private async resolveTargetDueMonth(
    tx: Prisma.TransactionClient,
    purchases: SettlementExpenseRow[],
    card: SettleCard,
    amountCents: number,
    paymentDate: Date,
  ): Promise<string | null> {
    const payMonth = this.yearMonth(paymentDate);
    const windowMonths = new Set([payMonth, addMonthsToMonthKey(payMonth, 1)]);

    const totalByMonth = new Map<string, number>();
    for (const e of purchases) {
      const entries = (await tx.cashFlowEntry.findMany({
        where: { expenseId: e.id, deletedAt: null },
      })) as EntryRow[];
      for (const en of entries) {
        const dueMonth = caixaMonthForCardPurchase(en.data, card.closingDay, card.dueDay);
        if (!windowMonths.has(dueMonth)) continue;
        totalByMonth.set(dueMonth, (totalByMonth.get(dueMonth) ?? 0) + (en.valor ?? 0));
      }
    }

    let best: { dueMonth: string; total: number; diff: number } | null = null;
    for (const [dueMonth, total] of totalByMonth) {
      if (total <= 0) continue;
      const diff = Math.abs(total - amountCents);
      if (
        best == null ||
        diff < best.diff ||
        (diff === best.diff && dueMonth.localeCompare(best.dueMonth) < 0)
      ) {
        best = { dueMonth, total, diff };
      }
    }

    if (!best) return null;
    // Só realiza quando o valor pago FECHA a fatura (dentro da tolerância).
    if (best.diff > invoiceMatchTolerance(best.total)) return null;
    return best.dueMonth;
  }

  /**
   * Inverso de `settleInvoice` para uma fatura específica (`dueMonth`): volta
   * `CashFlowEntry.status` de PAGO para PLANEJADO e recomputa
   * `Expense.status`/`paidParcelas` das compras daquele ciclo.
   *
   * O preflight materializa cartão, projetos, compras e parcelas dentro da
   * transação do caller. A aplicação posterior usa somente esse snapshot.
   */
  async prepareUnsettleInvoice(params: {
    tenantId: string;
    card: SettleCard;
    dueMonth: string;
    tx: Prisma.TransactionClient;
    requester: RateioRequester;
  }): Promise<PreparedInvoiceUnsettlement> {
    assertRateioRequester(params.requester);
    const { tenantId, card, dueMonth, tx, requester } = params;
    await this.assertCanAccessCard({
      tenantId,
      card,
      tx,
      requester,
    });

    const neutral = Array.from(NEUTRAL_EXPENSE_TYPES);
    const purchases = await tx.expense.findMany({
      where: {
        tenantId,
        cardLast4: card.last4,
        deletedAt: null,
        tipoDespesa: { notIn: neutral },
      },
      include: {
        project: { select: { id: true, type: true, tenantId: true } },
      },
    });

    const prepared: UnsettlePurchase[] = [];
    for (const e of purchases) {
      const all = (await tx.cashFlowEntry.findMany({
        where: { expenseId: e.id, deletedAt: null },
      })) as EntryRow[];
      const entries = all.filter(
        (entry) =>
          entry.status === 'PAGO' &&
          caixaMonthForCardPurchase(entry.data, card.closingDay, card.dueDay) === dueMonth,
      );
      if (entries.length === 0) continue;
      if (
        !e.project ||
        e.project.tenantId !== tenantId ||
        !this.canRequesterSeeProject(requester, e.project)
      ) {
        throw new NotFoundException(INVOICE_NOT_FOUND_MESSAGE);
      }
      prepared.push({ expense: e as ExpenseRow, entries });
    }

    return { tenantId, card, dueMonth, purchases: prepared };
  }

  async assertCanAccessCard(params: {
    tenantId: string;
    card: SettleCard;
    tx: Prisma.TransactionClient;
    requester: RateioRequester;
  }): Promise<void> {
    assertRateioRequester(params.requester);
    const { tenantId, card, tx, requester } = params;
    const storedCard = await tx.creditCard.findFirst({
      where: {
        id: card.id,
        tenantId,
        last4: card.last4,
        deletedAt: null,
      },
      include: {
        project: { select: { id: true, type: true, tenantId: true } },
      },
    });
    if (
      !storedCard ||
      !storedCard.project ||
      storedCard.project.tenantId !== tenantId ||
      !this.canRequesterSeeProject(requester, storedCard.project)
    ) {
      throw new NotFoundException(INVOICE_NOT_FOUND_MESSAGE);
    }
  }

  async applyPreparedUnsettlement(
    tx: Prisma.TransactionClient,
    prepared: PreparedInvoiceUnsettlement,
    requester: RateioRequester,
  ): Promise<{ revertedExpenses: number; revertedParcelas: number }> {
    assertRateioRequester(requester);
    let revertedParcelas = 0;
    for (const purchase of prepared.purchases) {
      for (const entry of purchase.entries) {
        await tx.cashFlowEntry.update({
          where: { id: entry.id },
          data: { status: 'PLANEJADO' },
        });
      }
      await this.applyUnpaid(tx, purchase.expense, purchase.entries);
      revertedParcelas += purchase.entries.length;
    }
    return {
      revertedExpenses: prepared.purchases.length,
      revertedParcelas,
    };
  }

  async unsettleInvoice(params: {
    tenantId: string;
    card: SettleCard;
    dueMonth: string;
    tx: Prisma.TransactionClient;
    requester: RateioRequester;
  }): Promise<{ revertedExpenses: number; revertedParcelas: number }> {
    assertRateioRequester(params.requester);
    const prepared = await this.prepareUnsettleInvoice(params);
    return this.applyPreparedUnsettlement(params.tx, prepared, params.requester);
  }

  /**
   * Inverso de `applyPaid`: recomputa `paidParcelas`/`status` da despesa após
   * reverter `paidEntries` para PLANEJADO.
   */
  private async applyUnpaid(
    client: PrismaService | Prisma.TransactionClient,
    e: ExpenseRow,
    revertedEntries: EntryRow[],
  ): Promise<void> {
    const n = e.quantidadeParcela ?? 1;

    if (isSinglePaymentForm(e.formaPagamento) || n <= 1) {
      await client.expense.update({
        where: { id: e.id },
        data: { status: 'PLANEJADO', paidParcelas: null },
      });
      return;
    }

    // Reverte os índices desta chamada a partir do que estava marcado pago.
    const set =
      e.status === 'PAGO'
        ? new Set<number>(Array.from({ length: n }, (_, i) => i))
        : new Set<number>(this.parsePaid(e.paidParcelas, n));

    for (const en of revertedEntries) {
      const idx = this.parcelaIndex(en.parcela);
      if (idx != null) set.delete(idx);
    }

    // Confirma contra o que AINDA está PAGO no cashflow (fonte de verdade),
    // evitando divergência se `e.paidParcelas` estivesse desatualizado.
    const remainingPaid = (await client.cashFlowEntry.findMany({
      where: { expenseId: e.id, deletedAt: null, status: 'PAGO' },
    })) as EntryRow[];
    const remainingSet = new Set<number>();
    for (const en of remainingPaid) {
      const idx = this.parcelaIndex(en.parcela);
      if (idx != null && idx >= 0 && idx < n) remainingSet.add(idx);
    }

    const allPaid = remainingSet.size === n;
    const paidParcelas =
      allPaid || remainingSet.size === 0
        ? null
        : JSON.stringify(Array.from(remainingSet).sort((a, b) => a - b));

    await client.expense.update({
      where: { id: e.id },
      data: { status: allPaid ? 'PAGO' : 'PLANEJADO', paidParcelas },
    });
  }

  private canRequesterSeeProject(
    requester: RateioRequester,
    project: { id: string; type: string },
  ): boolean {
    return (
      userCanAccessProject(requester.role, requester.allowedProjects, project.id) &&
      userCanAccessProjectType(
        requester.role,
        requester.allowedProjectTypes,
        requester.allowedModules ?? [],
        project.type,
      )
    );
  }

  private assertCanSettlePurchase(
    tenantId: string,
    requester: RateioRequester,
    expense: SettlementExpenseRow,
  ): void {
    if (
      !expense.project ||
      expense.project.tenantId !== tenantId ||
      !this.canRequesterSeeProject(requester, expense.project)
    ) {
      throw new NotFoundException(INVOICE_NOT_FOUND_MESSAGE);
    }
  }

  private async prepareDueMonthSettlement(
    tx: Prisma.TransactionClient,
    tenantId: string,
    purchases: SettlementExpenseRow[],
    card: SettleCard,
    target: string,
    requester: RateioRequester,
  ): Promise<SettlePurchase[]> {
    const prepared: SettlePurchase[] = [];
    for (const expense of purchases) {
      const planned = (await tx.cashFlowEntry.findMany({
        where: { expenseId: expense.id, deletedAt: null, status: 'PLANEJADO' },
      })) as EntryRow[];
      const entries = planned.filter(
        (entry) =>
          caixaMonthForCardPurchase(entry.data, card.closingDay, card.dueDay) === target,
      );
      if (entries.length === 0) continue;
      this.assertCanSettlePurchase(tenantId, requester, expense);
      prepared.push({ expense, entries });
    }
    return prepared;
  }

  private async prepareEarliestSettlement(
    tx: Prisma.TransactionClient,
    tenantId: string,
    purchases: SettlementExpenseRow[],
    requester: RateioRequester,
  ): Promise<SettlePurchase[]> {
    const prepared: SettlePurchase[] = [];
    for (const expense of purchases) {
      const planned = (await tx.cashFlowEntry.findMany({
        where: { expenseId: expense.id, deletedAt: null, status: 'PLANEJADO' },
        orderBy: { data: 'asc' },
      })) as EntryRow[];
      if (planned.length === 0) continue;
      this.assertCanSettlePurchase(tenantId, requester, expense);
      prepared.push({ expense, entries: [planned[0]] });
    }
    return prepared;
  }

  private async applyPreparedSettlement(
    tx: Prisma.TransactionClient,
    prepared: SettlePurchase[],
  ): Promise<{ settledExpenses: number; settledParcelas: number }> {
    let settledParcelas = 0;
    for (const purchase of prepared) {
      for (const entry of purchase.entries) {
        await tx.cashFlowEntry.update({
          where: { id: entry.id },
          data: { status: 'PAGO' },
        });
      }
      await this.applyPaid(tx, purchase.expense, purchase.entries);
      settledParcelas += purchase.entries.length;
    }
    return {
      settledExpenses: prepared.length,
      settledParcelas,
    };
  }

  /**
   * Atualiza `paidParcelas`/`status` da despesa de acordo com os lançamentos
   * recém-marcados como PAGO.
   */
  private async applyPaid(
    client: Prisma.TransactionClient,
    e: ExpenseRow,
    paidEntries: EntryRow[],
  ): Promise<void> {
    const n = e.quantidadeParcela ?? 1;

    // À vista / pagamento único: a despesa inteira é quitada.
    if (isSinglePaymentForm(e.formaPagamento) || n <= 1) {
      await client.expense.update({
        where: { id: e.id },
        data: { status: 'PAGO', paidParcelas: null },
      });
      return;
    }

    const set =
      e.status === 'PAGO'
        ? new Set<number>(Array.from({ length: n }, (_, i) => i))
        : new Set<number>(this.parsePaid(e.paidParcelas, n));

    for (const en of paidEntries) {
      const idx = this.parcelaIndex(en.parcela);
      if (idx != null && idx >= 0 && idx < n) set.add(idx);
    }

    const allPaid = set.size === n;
    const paidParcelas =
      allPaid || set.size === 0 ? null : JSON.stringify(Array.from(set).sort((a, b) => a - b));

    await client.expense.update({
      where: { id: e.id },
      data: { status: allPaid ? 'PAGO' : 'PLANEJADO', paidParcelas },
    });
  }

  private async findImportByTotal(
    tx: Prisma.TransactionClient,
    tenantId: string,
    cardId: string,
    amountCents: number,
    paymentDate: Date,
  ): Promise<{ id: string } | null> {
    const since = new Date(paymentDate);
    since.setDate(since.getDate() - 75);
    const tolerance = 200; // ±R$ 2 (encargos podem variar)
    const found = await tx.creditCardStatementImport.findFirst({
      where: {
        cardId,
        tenantId,
        deletedAt: null,
        createdAt: { gte: since },
        totalAmountCents: { gte: amountCents - tolerance, lte: amountCents + tolerance },
      },
      orderBy: { createdAt: 'desc' },
    });
    return found ? { id: found.id } : null;
  }

  private yearMonth(date: Date): string {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  /** "k/n" → índice 0-based (k-1). null para à vista. */
  private parcelaIndex(label: string | null): number | null {
    if (!label) return null;
    const m = /^(\d+)\/(\d+)$/.exec(label.trim());
    if (!m) return null;
    return parseInt(m[1], 10) - 1;
  }

  private parsePaid(raw: string | null, n: number): number[] {
    if (!raw) return [];
    try {
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr
        .map((v) => Number(v))
        .filter((i) => Number.isInteger(i) && i >= 0 && i < n);
    } catch {
      return [];
    }
  }
}
