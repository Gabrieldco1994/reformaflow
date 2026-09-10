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
import {
  userCanAccessProject,
  userCanAccessProjectModule,
  userCanAccessProjectType,
} from '../common/access-rules';
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
  importId: string | null;
  project: {
    id: string;
    type: string;
    tenantId: string;
    deletedAt: Date | null;
  } | null;
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

export interface PreparedInvoiceSettlement {
  purchases: SettlePurchase[];
  /** #569 — cartão da liquidação (para derivar `dueMonth` no `apply`). */
  card?: SettleCard;
}

/**
 * #569 — versão do protocolo do carimbo de undo de importação. O `undoImport` e
 * o `getImportDetail` recusam fail-closed (409) um carimbo cuja versão não
 * reconheçam (guarda de versão bidirecional degrau↔feature — design §3.3).
 */
export const INVOICE_UNDO_TRAIL_VERSION = 1;

/** Transição EFETIVA de uma parcela PLANEJADO→PAGO no `applyPreparedSettlement`. */
export interface FlippedEntry {
  cashFlowEntryId: string;
  purchaseExpenseId: string;
  prevStatus: string;
  valorCents: number;
  parcela: string | null;
  dueMonth: string;
}

export interface AppliedSettlement {
  settledExpenses: number;
  settledParcelas: number;
  flippedEntries: FlippedEntry[];
}

export interface RecordImportedLiquidationsArgs {
  tenantId: string;
  paymentExpenseId: string;
  importId: string;
  cardId: string;
  flippedEntries: FlippedEntry[];
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
    /** Ver `assertCanAccessCard.requiredModule` (#480 SEC-1). */
    requiredModule?: string;
  }): Promise<
    AppliedSettlement & { outcome: 'SETTLED' | 'NO_SETTLEMENT' }
  > {
    assertRateioRequester(params.requester);
    return this.prisma.$transaction(async (tx) => {
      const prepared = await this.prepareSettleInvoice({
        ...params,
        tx,
      });
      const applied = await this.applyPreparedSettlement(tx, prepared);
      return {
        ...applied,
        outcome:
          applied.flippedEntries.length > 0 ? 'SETTLED' : 'NO_SETTLEMENT',
      };
    });
  }

  /**
   * Materializa uma liquidação sem escrever. O caller deve preparar e aplicar no
   * mesmo `Prisma.TransactionClient`, para que pagamento e parcelas sejam uma
   * única transição atômica.
   *
   * Todos os projetos candidatos são autorizados antes da primeira leitura de
   * valores de parcelas/importações. Assim, nem o ranking por total observa
   * valores de compras que o requester não pode acessar.
   */
  async prepareSettleInvoice(params: {
    tenantId: string;
    card: SettleCard;
    amountCents: number;
    paymentDate: Date;
    tx: Prisma.TransactionClient;
    requester: RateioRequester;
    /** Ver `assertCanAccessCard.requiredModule` (#480 SEC-1). */
    requiredModule?: string;
  }): Promise<PreparedInvoiceSettlement> {
    assertRateioRequester(params.requester);
    const { tenantId, card, amountCents, paymentDate, tx, requester } = params;
    await this.assertCanAccessCard({
      tenantId,
      card,
      tx,
      requester,
      requiredModule: params.requiredModule,
    });

    const neutral = Array.from(NEUTRAL_EXPENSE_TYPES);
    const purchases = await tx.expense.findMany({
      where: {
        tenantId,
        cardLast4: card.last4,
        deletedAt: null,
        tipoDespesa: { notIn: neutral },
      },
      select: {
        id: true,
        tenantId: true,
        cardLast4: true,
        tipoDespesa: true,
        formaPagamento: true,
        quantidadeParcela: true,
        status: true,
        paidParcelas: true,
        importId: true,
        project: {
          select: { id: true, type: true, tenantId: true, deletedAt: true },
        },
      },
    });

    for (const purchase of purchases) {
      this.assertCanSettlePurchase(tenantId, requester, purchase);
    }

    // ── Estratégia 1: por vencimento, respeitando o VALOR pago ────
    const hasDays = card.closingDay != null && card.dueDay != null;
    if (hasDays) {
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
          purchases,
          card,
          target,
        );
        if (prepared.length > 0) return { purchases: prepared, card };
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
    if (!matchedImport) return { purchases: [], card };

    const importPurchases = purchases.filter(
      (purchase) => purchase.importId === matchedImport.id,
    );
    const prepared = await this.prepareEarliestSettlement(
      tx,
      importPurchases,
    );
    return { purchases: prepared, card };
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
      const candidates = entries
        .map((entry) => ({
          entry,
          dueMonth: caixaMonthForCardPurchase(entry.data, card.closingDay, card.dueDay),
        }))
        .filter(({ dueMonth }) => windowMonths.has(dueMonth));
      if (candidates.length === 0) continue;

      for (const { entry, dueMonth } of candidates) {
        totalByMonth.set(dueMonth, (totalByMonth.get(dueMonth) ?? 0) + (entry.valor ?? 0));
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
    notFoundMessage?: string;
    /** Ver `assertCanAccessCard.requiredModule` (#480 SEC-1). */
    requiredModule?: string;
  }): Promise<PreparedInvoiceUnsettlement> {
    assertRateioRequester(params.requester);
    const { tenantId, card, dueMonth, tx, requester } = params;
    await this.assertCanAccessCard({
      tenantId,
      card,
      tx,
      requester,
      notFoundMessage: params.notFoundMessage,
      requiredModule: params.requiredModule,
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
        project: {
          select: { id: true, type: true, tenantId: true, deletedAt: true },
        },
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
        e.project.deletedAt !== null ||
        !this.canRequesterSeeProject(requester, e.project)
      ) {
        throw new NotFoundException(
          params.notFoundMessage ?? INVOICE_NOT_FOUND_MESSAGE,
        );
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
    notFoundMessage?: string;
    /**
     * Módulo dono do recurso SEGUNDO O CALLER. A superfície de importação
     * passa `creditCards` (#480 SEC-1); callers cujo `@RequireModule` é outro
     * (cockpit `monthlyOverview`) omitem e ficam no gate histórico por tipo.
     */
    requiredModule?: string;
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
      select: {
        id: true,
        project: {
          select: { id: true, type: true, tenantId: true, deletedAt: true },
        },
      },
    });
    if (
      !storedCard ||
      !storedCard.project ||
      storedCard.project.tenantId !== tenantId ||
      storedCard.project.deletedAt !== null ||
      !this.canRequesterSeeCardProject(
        requester,
        storedCard.project,
        params.requiredModule,
      )
    ) {
      throw new NotFoundException(
        params.notFoundMessage ?? INVOICE_NOT_FOUND_MESSAGE,
      );
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
    /** Ver `assertCanAccessCard.requiredModule` (#480 SEC-1). */
    requiredModule?: string;
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

  /**
   * Gate genérico por TIPO, usado nas COMPRAS filhas de uma fatura já
   * autorizada por `canRequesterSeeCardProject`. Fica deliberadamente no gate
   * de tipo: liquidar/estornar uma fatura marca as compras dela por definição,
   * então exigir `expenses` aqui quebraria o fluxo legítimo de quem só tem
   * `creditCards`. A porta de entrada continua sendo o cartão (#480 SEC-1).
   */
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

  /**
   * O CARTÃO em si é recurso do módulo `creditCards`: quando o CALLER declara
   * esse módulo (`requiredModule`), alcançar o projeto dono por um módulo não
   * relacionado do mesmo tipo (ex.: `expenses` numa REFORMA) não autoriza a
   * fatura (#480 SEC-1).
   *
   * Sem `requiredModule` vale o gate HISTÓRICO por tipo. Isso é deliberado e
   * não é frouxidão: `assertCanAccessCard` não é só da importação — o cockpit
   * (`payInvoice`/`undoInvoicePayment`) entra por rotas
   * `@RequireModule('monthlyOverview')`. Exigir `creditCards` aqui, no fixo,
   * 404-aria uma feature já entregue para quem tem `allowedProjectTypes: []`
   * (nesse caso `reconcileUserModules` nunca faz back-fill de `creditCards` e
   * o tipo é derivado dos módulos) — menu aparece, API falha. Quem paga o
   * módulo é o dono da rota; mudar a exigência do cockpit é decisão de produto,
   * não de hotfix de disclosure.
   */
  private canRequesterSeeCardProject(
    requester: RateioRequester,
    project: { id: string; type: string },
    requiredModule?: string,
  ): boolean {
    if (requiredModule === undefined) {
      return this.canRequesterSeeProject(requester, project);
    }
    return (
      userCanAccessProject(requester.role, requester.allowedProjects, project.id) &&
      userCanAccessProjectModule(
        requester.role,
        requester.allowedProjectTypes,
        requester.allowedModules ?? [],
        project.type,
        requiredModule,
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
      expense.project.deletedAt !== null ||
      !this.canRequesterSeeProject(requester, expense.project)
    ) {
      throw new NotFoundException(INVOICE_NOT_FOUND_MESSAGE);
    }
  }

  private async prepareDueMonthSettlement(
    tx: Prisma.TransactionClient,
    purchases: SettlementExpenseRow[],
    card: SettleCard,
    target: string,
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
      prepared.push({ expense, entries });
    }
    return prepared;
  }

  private async prepareEarliestSettlement(
    tx: Prisma.TransactionClient,
    purchases: SettlementExpenseRow[],
  ): Promise<SettlePurchase[]> {
    const prepared: SettlePurchase[] = [];
    for (const expense of purchases) {
      const planned = (await tx.cashFlowEntry.findMany({
        where: { expenseId: expense.id, deletedAt: null, status: 'PLANEJADO' },
        orderBy: { data: 'asc' },
      })) as EntryRow[];
      if (planned.length === 0) continue;
      prepared.push({ expense, entries: [planned[0]] });
    }
    return prepared;
  }

  async applyPreparedSettlement(
    tx: Prisma.TransactionClient,
    prepared: PreparedInvoiceSettlement,
  ): Promise<AppliedSettlement> {
    const card = prepared.card ?? null;
    let settledParcelas = 0;
    let settledExpenses = 0;
    const flippedEntries: FlippedEntry[] = [];
    for (const purchase of prepared.purchases) {
      const flippedForPurchase: EntryRow[] = [];
      for (const entry of purchase.entries) {
        // Defensivo: `prepare*` já filtra PLANEJADO, mas nunca re-flipar um PAGO
        // (não seria uma transição real → não entra na trilha).
        if (entry.status === 'PAGO') continue;
        const prevStatus = entry.status;
        await tx.cashFlowEntry.update({
          where: { id: entry.id },
          data: { status: 'PAGO' },
        });
        flippedForPurchase.push(entry);
        flippedEntries.push({
          cashFlowEntryId: entry.id,
          purchaseExpenseId: purchase.expense.id,
          prevStatus,
          valorCents: entry.valor ?? 0,
          parcela: entry.parcela ?? null,
          dueMonth: caixaMonthForCardPurchase(
            entry.data,
            card?.closingDay ?? null,
            card?.dueDay ?? null,
          ),
        });
      }
      if (flippedForPurchase.length === 0) continue;
      await this.applyPaid(tx, purchase.expense, flippedForPurchase);
      settledParcelas += flippedForPurchase.length;
      settledExpenses += 1;
    }
    return { settledExpenses, settledParcelas, flippedEntries };
  }

  /**
   * #569 — grava a trilha da liquidação: 1 linha por `FlippedEntry`. Um `P2002`
   * no índice único parcial (parcela já reivindicada ativamente) **NÃO é
   * capturado** — propaga e faz a `$transaction` do lote inteiro dar rollback.
   */
  async recordImportedLiquidations(
    client: PrismaService | Prisma.TransactionClient,
    args: RecordImportedLiquidationsArgs,
  ): Promise<void> {
    for (const f of args.flippedEntries) {
      await client.importedInvoiceLiquidation.create({
        data: {
          tenantId: args.tenantId,
          paymentExpenseId: args.paymentExpenseId,
          importId: args.importId,
          purchaseExpenseId: f.purchaseExpenseId,
          cashFlowEntryId: f.cashFlowEntryId,
          cardId: args.cardId,
          prevStatus: f.prevStatus,
          entryValorCents: f.valorCents,
          parcela: f.parcela,
          dueMonth: f.dueMonth,
        },
      });
    }
  }

  /**
   * #569 — enumera as linhas ATIVAS de um lote (tenant-scoped). Consumido só
   * pelo `undoImport` via ledger (PR 2). O `$use` injeta `deletedAt: null`.
   */
  async prepareRevertImportedLiquidations(
    client: PrismaService | Prisma.TransactionClient,
    args: { tenantId: string; importId: string },
  ): Promise<
    Array<{
      id: string;
      paymentExpenseId: string;
      purchaseExpenseId: string;
      cashFlowEntryId: string;
      prevStatus: string;
      entryValorCents: number;
      parcela: string | null;
      dueMonth: string;
      cardId: string;
    }>
  > {
    return client.importedInvoiceLiquidation.findMany({
      where: { tenantId: args.tenantId, importId: args.importId, deletedAt: null },
      select: {
        id: true,
        paymentExpenseId: true,
        purchaseExpenseId: true,
        cashFlowEntryId: true,
        prevStatus: true,
        entryValorCents: true,
        parcela: true,
        dueMonth: true,
        cardId: true,
      },
    });
  }

  /**
   * #569 — reverte a trilha de um pagamento: restaura `status → prev_status` de
   * cada parcela ativa, recomputa `paidParcelas`/`status` da compra e
   * soft-deleta as linhas do ledger. Consumido só pelo `undoImport` (PR 2).
   */
  async applyRevertImportedLiquidations(
    client: PrismaService | Prisma.TransactionClient,
    args: { tenantId: string; paymentExpenseId: string },
  ): Promise<{ revertedParcelas: number }> {
    const rows = (await client.importedInvoiceLiquidation.findMany({
      where: {
        tenantId: args.tenantId,
        paymentExpenseId: args.paymentExpenseId,
        deletedAt: null,
      },
    })) as Array<{
      id: string;
      purchaseExpenseId: string;
      cashFlowEntryId: string;
      prevStatus: string;
    }>;
    const byPurchase = new Map<string, EntryRow[]>();
    for (const row of rows) {
      const entry = (await client.cashFlowEntry.findUnique({
        where: { id: row.cashFlowEntryId },
      })) as EntryRow | null;
      await client.cashFlowEntry.update({
        where: { id: row.cashFlowEntryId },
        data: { status: row.prevStatus },
      });
      if (entry) {
        const list = byPurchase.get(row.purchaseExpenseId) ?? [];
        list.push(entry);
        byPurchase.set(row.purchaseExpenseId, list);
      }
    }
    for (const [purchaseId, entries] of byPurchase) {
      const purchase = (await client.expense.findUnique({
        where: { id: purchaseId },
      })) as ExpenseRow | null;
      if (purchase) await this.applyUnpaid(client, purchase, entries);
    }
    await client.importedInvoiceLiquidation.updateMany({
      where: {
        tenantId: args.tenantId,
        paymentExpenseId: args.paymentExpenseId,
        deletedAt: null,
      },
      data: { deletedAt: new Date() },
    });
    return { revertedParcelas: rows.length };
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

  /**
   * #569 (degrau, §4 B2 — CORREÇÃO DO PLANO): resolve o(s) `dueMonth` que um
   * pagamento manual EFETIVAMENTE liquidaria, pela MESMA lógica de
   * `prepareSettleInvoice` (compras + total + data + valor, janela
   * `{payMonth, payMonth+1}` / fallback por fatura importada em 75d ±R$2) —
   * **nunca** por `caixaMonthForCardPurchase(paymentDate)`, que recebe data de
   * COMPRA e produziria o mês errado ao quitar uma fatura de mês anterior.
   * Read-only: não escreve, não exige `PLANEJADO` (funciona quando a importação
   * já deixou tudo PAGO). Consumido pelo pre-check `INVOICE_HAS_IMPORT_TRAIL`.
   */
  async resolveEffectiveDueMonths(params: {
    tenantId: string;
    card: SettleCard;
    amountCents: number;
    paymentDate: Date;
    tx: Prisma.TransactionClient;
  }): Promise<string[]> {
    const { tenantId, card, amountCents, paymentDate, tx } = params;
    const months = new Set<string>();
    const neutral = Array.from(NEUTRAL_EXPENSE_TYPES);
    // SEC-3 (#569): dois cartões do mesmo tenant podem compartilhar `last4`.
    // Filtrar só por `cardLast4` misturaria parcelas de OUTRO cartão e produziria
    // um `dueMonth` efetivo alheio ⇒ 409 falso num `payInvoice` legítimo.
    // Quando `card.id` está disponível, restringe às compras atribuíveis a ESTE
    // cartão via `importId` (padrão de `findImportByTotal`); compras legadas sem
    // vínculo de importação caem no fallback por `last4`.
    const cardImportIds = (
      await tx.creditCardStatementImport.findMany({
        where: { cardId: card.id, tenantId, deletedAt: null },
        select: { id: true },
      })
    ).map((i) => i.id);
    const purchases = (await tx.expense.findMany({
      where: {
        tenantId,
        cardLast4: card.last4,
        deletedAt: null,
        tipoDespesa: { notIn: neutral },
        OR: [{ importId: null }, { importId: { in: cardImportIds } }],
      },
      select: { id: true, importId: true },
    })) as Array<{ id: string; importId: string | null }>;

    // Precedência IDÊNTICA à de `prepareSettleInvoice`, REUSANDO a MESMA
    // preparação autorizada (sem uma segunda resolução paralela que duplicaria
    // ou uniria histórico):
    //   1. por VENCIMENTO — só é a fatura EFETIVA quando há parcela PLANEJADO a
    //      virar naquele `dueMonth` (espelha o `if (prepared.length > 0) return`
    //      de `prepareSettleInvoice`); sem PLANEJADO, cai no fallback, igual à
    //      preparação real (um alvo já PAGO não pode fixar o mês);
    //   2. FALLBACK por fatura importada — seleciona só a PRIMEIRA parcela
    //      PLANEJADO de cada compra (`prepareEarliestSettlement`), NUNCA todas as
    //      CFEs do histórico, que vazariam uma fatura anterior já liquidada e
    //      bloqueariam o pagamento legítimo seguinte;
    //   3. RECUPERAÇÃO — quando nada tem PLANEJADO a virar (fatura já integral-
    //      mente PAGA pela importação), o pagamento não faz flip, mas o pré-check
    //      ainda precisa da identidade da fatura que ele quitaria para barrar um
    //      duplicado. Vem do alvo por vencimento (quando resolvido) e do PRIMEIRO
    //      lançamento de cada compra da importação casada.
    const settlementRows = purchases as unknown as SettlementExpenseRow[];
    const collectMonths = (prepared: SettlePurchase[]): void => {
      for (const item of prepared) {
        for (const entry of item.entries) {
          months.add(
            caixaMonthForCardPurchase(entry.data, card.closingDay, card.dueDay),
          );
        }
      }
    };

    // ── Estratégia 1: por vencimento ────────────────────────────────
    let targetMonth: string | null = null;
    if (card.closingDay != null && card.dueDay != null) {
      targetMonth = await this.resolveTargetDueMonth(
        tx,
        settlementRows,
        card,
        amountCents,
        paymentDate,
      );
      if (targetMonth) {
        const prepared = await this.prepareDueMonthSettlement(
          tx,
          settlementRows,
          card,
          targetMonth,
        );
        if (prepared.length > 0) {
          collectMonths(prepared);
          return [...months];
        }
      }
    }

    // ── Estratégia 2 (fallback): por fatura importada ───────────────
    const matchedImport = await this.findImportByTotal(
      tx,
      tenantId,
      card.id,
      amountCents,
      paymentDate,
    );
    const importPurchases = matchedImport
      ? settlementRows.filter((p) => p.importId === matchedImport.id)
      : [];
    if (matchedImport) {
      const prepared = await this.prepareEarliestSettlement(tx, importPurchases);
      if (prepared.length > 0) {
        collectMonths(prepared);
        return [...months];
      }
    }

    // ── Recuperação de identidade: fatura já PAGA, sem parcela a virar ──
    if (targetMonth) months.add(targetMonth);
    for (const purchase of importPurchases) {
      const earliest = (await tx.cashFlowEntry.findFirst({
        where: { expenseId: purchase.id, deletedAt: null },
        orderBy: { data: 'asc' },
        select: { data: true },
      })) as { data: Date } | null;
      if (earliest) {
        months.add(
          caixaMonthForCardPurchase(earliest.data, card.closingDay, card.dueDay),
        );
      }
    }

    return [...months];
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
