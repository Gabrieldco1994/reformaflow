import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { caixaMonthForCardPurchase, NEUTRAL_EXPENSE_TYPES, isSinglePaymentForm } from '@reformaflow/domain';

interface SettleCard {
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

interface EntryRow {
  id: string;
  expenseId: string;
  status: string;
  parcela: string | null;
  data: Date;
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
 *   1. Por VENCIMENTO (preferida quando o cartão tem closingDay/dueDay): liquida
 *      cada parcela/compra cuja fatura VENCE no mês do pagamento — derivado por
 *      `caixaMonthForCardPurchase` sobre a data de cada lançamento de caixa.
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
  }): Promise<{ settledExpenses: number; settledParcelas: number }> {
    const { tenantId, card, amountCents, paymentDate } = params;
    let settledExpenses = 0;
    let settledParcelas = 0;

    const neutral = Array.from(NEUTRAL_EXPENSE_TYPES);
    const hasDays = card.closingDay != null && card.dueDay != null;

    // ── Estratégia 1: por vencimento ──────────────────────────────
    if (hasDays) {
      const target = this.yearMonth(paymentDate);
      const purchases = (await this.prisma.expense.findMany({
        where: {
          tenantId,
          cardLast4: card.last4,
          deletedAt: null,
          tipoDespesa: { notIn: neutral },
        },
      })) as ExpenseRow[];

      for (const e of purchases) {
        const n = await this.settleByDueMonth(e, card, target);
        if (n > 0) {
          settledExpenses++;
          settledParcelas += n;
        }
      }
      if (settledParcelas > 0) return { settledExpenses, settledParcelas };
    }

    // ── Estratégia 2 (fallback): por fatura importada ─────────────
    const matchedImport = await this.findImportByTotal(tenantId, card.id, amountCents, paymentDate);
    if (matchedImport) {
      const purchases = (await this.prisma.expense.findMany({
        where: {
          tenantId,
          importId: matchedImport.id,
          cardLast4: card.last4,
          deletedAt: null,
          tipoDespesa: { notIn: neutral },
        },
      })) as ExpenseRow[];

      for (const e of purchases) {
        const n = await this.settleEarliestUnpaid(e);
        if (n > 0) {
          settledExpenses++;
          settledParcelas += n;
        }
      }
    }

    return { settledExpenses, settledParcelas };
  }

  private async settleByDueMonth(e: ExpenseRow, card: SettleCard, target: string): Promise<number> {
    const planned = (await this.prisma.cashFlowEntry.findMany({
      where: { expenseId: e.id, deletedAt: null, status: 'PLANEJADO' },
    })) as EntryRow[];

    const toPay = planned.filter(
      (en) => caixaMonthForCardPurchase(en.data, card.closingDay, card.dueDay) === target,
    );
    if (toPay.length === 0) return 0;

    for (const en of toPay) {
      await this.prisma.cashFlowEntry.update({ where: { id: en.id }, data: { status: 'PAGO' } });
    }
    await this.applyPaid(e, toPay);
    return toPay.length;
  }

  private async settleEarliestUnpaid(e: ExpenseRow): Promise<number> {
    const planned = (await this.prisma.cashFlowEntry.findMany({
      where: { expenseId: e.id, deletedAt: null, status: 'PLANEJADO' },
      orderBy: { data: 'asc' },
    })) as EntryRow[];
    if (planned.length === 0) return 0;

    const en = planned[0];
    await this.prisma.cashFlowEntry.update({ where: { id: en.id }, data: { status: 'PAGO' } });
    await this.applyPaid(e, [en]);
    return 1;
  }

  /**
   * Atualiza `paidParcelas`/`status` da despesa de acordo com os lançamentos
   * recém-marcados como PAGO.
   */
  private async applyPaid(e: ExpenseRow, paidEntries: EntryRow[]): Promise<void> {
    const n = e.quantidadeParcela ?? 1;

    // À vista / pagamento único: a despesa inteira é quitada.
    if (isSinglePaymentForm(e.formaPagamento) || n <= 1) {
      await this.prisma.expense.update({
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

    await this.prisma.expense.update({
      where: { id: e.id },
      data: { status: allPaid ? 'PAGO' : 'PLANEJADO', paidParcelas },
    });
  }

  private async findImportByTotal(
    tenantId: string,
    cardId: string,
    amountCents: number,
    paymentDate: Date,
  ): Promise<{ id: string } | null> {
    const since = new Date(paymentDate);
    since.setDate(since.getDate() - 75);
    const tolerance = 200; // ±R$ 2 (encargos podem variar)
    const found = await this.prisma.creditCardStatementImport.findFirst({
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
