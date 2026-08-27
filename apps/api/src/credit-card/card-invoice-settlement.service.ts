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

export type InvoiceSettlementStrategy =
  | 'DUE_MONTH'
  | 'IMPORTED_STATEMENT'
  | 'NONE';

export interface PreparedInvoiceSettlement {
  purchases: SettlePurchase[];
  /**
   * Como a liquidação resolveu a fatura alvo — issue #569:
   *  - `DUE_MONTH`: estratégia 1 (por vencimento) achou e fechou uma fatura;
   *  - `IMPORTED_STATEMENT`: fallback por fatura importada casou pelo total;
   *  - `NONE`: nada casou (`purchases` vazio).
   * O caller de importação (`bank-account.service`) grava isto no ledger
   * `ImportedCardInvoiceSettlement` do pagamento, junto dos ids EXATOS dos
   * `CashFlowEntry` que a aplicação de fato moveu PLANEJADO → PAGO.
   */
  strategy: InvoiceSettlementStrategy;
  /** "YYYY-MM" da fatura alvo quando `strategy === 'DUE_MONTH'` — SÓ auditoria. */
  targetDueMonth: string | null;
  /** `CreditCardStatementImport.id` casado quando `strategy === 'IMPORTED_STATEMENT'`. */
  matchedCardImportId: string | null;
}

/** Um `CashFlowEntry` que `applyPreparedSettlement` de fato moveu PLANEJADO → PAGO. */
export interface FlippedSettlementEntry {
  cashFlowEntryId: string;
  expenseId: string;
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
  }): Promise<{ settledExpenses: number; settledParcelas: number }> {
    assertRateioRequester(params.requester);
    return this.prisma.$transaction(async (tx) => {
      const prepared = await this.prepareSettleInvoice({
        ...params,
        tx,
      });
      const applied = await this.applyPreparedSettlement(tx, prepared);
      return {
        settledExpenses: applied.settledExpenses,
        settledParcelas: applied.settledParcelas,
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
        if (prepared.length > 0) {
          return {
            purchases: prepared,
            strategy: 'DUE_MONTH',
            targetDueMonth: target,
            matchedCardImportId: null,
          };
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
    if (!matchedImport) {
      return {
        purchases: [],
        strategy: 'NONE',
        targetDueMonth: null,
        matchedCardImportId: null,
      };
    }

    const importPurchases = purchases.filter(
      (purchase) => purchase.importId === matchedImport.id,
    );
    const prepared = await this.prepareEarliestSettlement(
      tx,
      importPurchases,
    );
    return {
      purchases: prepared,
      strategy: prepared.length > 0 ? 'IMPORTED_STATEMENT' : 'NONE',
      targetDueMonth: null,
      matchedCardImportId: prepared.length > 0 ? matchedImport.id : null,
    };
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

  /**
   * Autoriza um requester a MEXER nas compras de um projeto durante o undo de
   * importação (#569): o projeto tem que existir, ser do tenant, estar vivo e
   * ser visível ao requester pelo módulo do CARTÃO (mesma porta do #480 SEC-1).
   * Usado por `bank-account.undoImport` para o projeto do cartão e para todo
   * projeto dono de uma parcela registrada no ledger, ANTES da primeira escrita.
   */
  async assertCanAccessProject(params: {
    tenantId: string;
    projectId: string;
    tx: Prisma.TransactionClient;
    requester: RateioRequester;
    requiredModule?: string;
    notFoundMessage?: string;
  }): Promise<void> {
    assertRateioRequester(params.requester);
    const project = await params.tx.project.findFirst({
      where: { id: params.projectId, tenantId: params.tenantId, deletedAt: null },
      select: { id: true, type: true, tenantId: true, deletedAt: true },
    });
    if (
      !project ||
      project.tenantId !== params.tenantId ||
      project.deletedAt !== null ||
      !this.canRequesterSeeCardProject(
        params.requester,
        project,
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
  ): Promise<{
    settledExpenses: number;
    settledParcelas: number;
    flippedEntries: FlippedSettlementEntry[];
  }> {
    let settledParcelas = 0;
    let settledExpenses = 0;
    const flippedEntries: FlippedSettlementEntry[] = [];
    for (const purchase of prepared.purchases) {
      // #569: update CONDICIONAL. Uma parcela que já saiu de PLANEJADO entre o
      // prepare e o apply (outra corrida, edição concorrente) tem `count === 0`
      // e NÃO entra na recomputação da despesa nem no ledger — só as que este
      // pagamento de fato moveu contam.
      const flippedForPurchase: EntryRow[] = [];
      for (const entry of purchase.entries) {
        const { count } = await tx.cashFlowEntry.updateMany({
          where: {
            id: entry.id,
            tenantId: purchase.expense.tenantId,
            deletedAt: null,
            status: 'PLANEJADO',
          },
          data: { status: 'PAGO' },
        });
        if (count === 1) {
          flippedForPurchase.push(entry);
          flippedEntries.push({
            cashFlowEntryId: entry.id,
            expenseId: purchase.expense.id,
          });
        }
      }
      if (flippedForPurchase.length === 0) continue;
      await this.applyPaid(tx, purchase.expense, flippedForPurchase);
      settledExpenses += 1;
      settledParcelas += flippedForPurchase.length;
    }
    return { settledExpenses, settledParcelas, flippedEntries };
  }

  /**
   * Recomputa `Expense.status`/`paidParcelas` a partir da VERDADE do cashflow
   * (quais `CashFlowEntry` estão PAGO agora), sem depender de qual chamada mudou
   * o quê. Idempotente — usado por `undoImport` (#569) depois de liberar as
   * parcelas de um pagamento importado.
   */
  async recomputeExpensePaidState(
    client: Prisma.TransactionClient,
    expenseId: string,
  ): Promise<void> {
    const e = (await client.expense.findUnique({
      where: { id: expenseId },
      select: { id: true, formaPagamento: true, quantidadeParcela: true },
    })) as { id: string; formaPagamento: string; quantidadeParcela: number | null } | null;
    if (!e) return;
    const n = e.quantidadeParcela ?? 1;
    const paid = (await client.cashFlowEntry.findMany({
      where: { expenseId, deletedAt: null, status: 'PAGO' },
    })) as EntryRow[];

    if (isSinglePaymentForm(e.formaPagamento) || n <= 1) {
      await client.expense.update({
        where: { id: expenseId },
        data: { status: paid.length > 0 ? 'PAGO' : 'PLANEJADO', paidParcelas: null },
      });
      return;
    }

    const set = new Set<number>();
    for (const en of paid) {
      const idx = this.parcelaIndex(en.parcela);
      if (idx != null && idx >= 0 && idx < n) set.add(idx);
    }
    const allPaid = set.size === n;
    const paidParcelas =
      allPaid || set.size === 0
        ? null
        : JSON.stringify(Array.from(set).sort((a, b) => a - b));
    await client.expense.update({
      where: { id: expenseId },
      data: { status: allPaid ? 'PAGO' : 'PLANEJADO', paidParcelas },
    });
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
