import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateReceiptDto } from './dto/create-receipt.dto';
import { UpdateReceiptDto } from './dto/update-receipt.dto';
import {
  CashFlowType,
  ExpenseStatus,
  ExpenseType,
  PaymentForm,
  ReceiptStatus,
  ReceiptType,
  toCents,
} from '@reformaflow/domain';
import {
  parseBankStatementBuffers,
  type BankSourceHint,
} from '../bank-account/parsers';
import {
  parseStatementBuffers,
  type SourceHint as CardSourceHint,
} from '../credit-card/parsers';
import type { NormalizedTx, ParseResult } from '../credit-card/parsers/types';
import { categorize } from '../credit-card/categorizer';
import {
  MerchantClassifierService,
  MERCHANT_TO_EXPENSE_TYPE,
} from '../merchant-classifier/merchant-classifier.service';
import {
  RECEIPT_IMPORT_ACTION_SKIP,
  RECEIPT_IMPORT_DOCUMENT_TYPE_BANK,
  RECEIPT_IMPORT_DOCUMENT_TYPE_CARD,
  validateReceiptImportDecisions,
  type ReceiptImportDecision,
  type ReceiptImportDocumentType,
  type ReceiptImportSource,
} from './dto/import-receipt.dto';

const PESSOAL_CATEGORY_MAP: Record<string, string> = MERCHANT_TO_EXPENSE_TYPE;
const DEFAULT_IMPORT_SOURCE = 'AUTO';
const RECEIPT_IMPORT_SEED_PREFIX = 'receipts-import';
const WALLET_ORIGIN = 'none';
const MAX_IMPORT_TEXT_LENGTH = 200;
const CARD_INVOICE_PAYMENT_PATTERN =
  /PAGAMENTO\s+EFETUADO|PAGAMENTO\s+PIX|PGTO\s+FAT|FATURA\s+PAG/i;
const PREVIEW_EXPENSE_TYPE = 'expense';
const PREVIEW_RECEIPT_TYPE = 'receipt';
const IMPORT_OUTCOME_DUPLICATE = 'duplicate';
const IMPORT_OUTCOME_EXPENSE = 'expense';
const IMPORT_OUTCOME_RECEIPT = 'receipt';

type ExternalIdLookupClient = Pick<Prisma.TransactionClient, '$queryRaw'>;
type ReceiptImportOutcome =
  | { kind: typeof IMPORT_OUTCOME_DUPLICATE }
  | { kind: typeof IMPORT_OUTCOME_EXPENSE; id: string }
  | { kind: typeof IMPORT_OUTCOME_RECEIPT; id: string };

export interface ReceiptImportPreviewRow {
  externalId: string;
  date: string;
  description: string;
  amountCents: number;
  type: typeof PREVIEW_EXPENSE_TYPE | typeof PREVIEW_RECEIPT_TYPE;
  status: ExpenseStatus | ReceiptStatus;
  duplicate: boolean;
  willImport: boolean;
}

export interface ReceiptImportError {
  error: string;
}

export interface ReceiptImportPreviewResult {
  source: ParseResult['source'];
  periodLabel?: string;
  total: number;
  totalAmountCents: number;
  duplicated: number;
  preview: ReceiptImportPreviewRow[];
}

export interface ReceiptImportCommitResult {
  source: ParseResult['source'];
  periodLabel?: string;
  count: number;
  expensesInserted: number;
  receiptsInserted: number;
  duplicated: number;
  skipped: number;
  failed: number;
  expenseIds: string[];
  receiptIds: string[];
}

@Injectable()
export class ReceiptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly merchantClassifier: MerchantClassifierService,
  ) {}

  async create(tenantId: string, projectId: string, dto: CreateReceiptDto) {
    const project = await this.validateProject(tenantId, projectId);
    const defaultBankLast4 = await this.resolveDefaultBankLast4ForProject(
      tenantId,
      projectId,
      project.type,
    );

    return this.prisma.$transaction(async (tx) => {
      const receipt = await tx.receipt.create({
        data: {
          projectId,
          tenantId,
          valor: toCents(dto.valor),
          data: new Date(dto.data),
          tipo: dto.tipo,
          status: dto.status,
          descricao: dto.descricao?.trim() || null,
          bankLast4: defaultBankLast4 ?? undefined,
        },
      });

      await tx.cashFlowEntry.create({
        data: {
          projectId,
          tenantId,
          receiptId: receipt.id,
          valor: receipt.valor,
          tipo: 'RECEBIMENTO',
          data: receipt.data,
          categoria: receipt.tipo,
          status: receipt.status,
        },
      });

      return receipt;
    });
  }

  async findAllByProject(tenantId: string, projectId: string) {
    await this.validateProject(tenantId, projectId);
    return this.prisma.receipt.findMany({
      where: { projectId, tenantId },
      orderBy: { data: 'desc' },
    });
  }

  async update(
    tenantId: string,
    projectId: string,
    id: string,
    dto: UpdateReceiptDto,
  ) {
    const project = await this.validateProject(tenantId, projectId);

    const existing = await this.prisma.receipt.findFirst({
      where: { id, projectId, tenantId },
    });
    if (!existing) throw new NotFoundException('Recebimento não encontrado');
    // Associação explícita de conta (ação "Associar conta" das pendências) tem
    // prioridade; senão mantém o auto-backfill p/ a conta primária quando vazio.
    const explicitBankLast4 = dto.bankLast4;
    const shouldBackfillBankLast4 = !explicitBankLast4 && !existing.bankLast4;
    const defaultBankLast4 = shouldBackfillBankLast4
      ? await this.resolveDefaultBankLast4ForProject(
          tenantId,
          projectId,
          project.type,
        )
      : null;
    const resolvedBankLast4 = explicitBankLast4 ?? defaultBankLast4;

    return this.prisma.$transaction(async (tx) => {
      const receipt = await tx.receipt.update({
        where: { id },
        data: {
          ...(dto.valor !== undefined && { valor: toCents(dto.valor) }),
          ...(dto.data !== undefined && { data: new Date(dto.data) }),
          ...(dto.tipo !== undefined && { tipo: dto.tipo }),
          ...(dto.status !== undefined && { status: dto.status }),
          ...(dto.descricao !== undefined && {
            descricao: dto.descricao?.trim() || null,
          }),
          ...(resolvedBankLast4 ? { bankLast4: resolvedBankLast4 } : {}),
        },
      });

      await this.regenerateCashFlow(tx, receipt);

      return receipt;
    });
  }

  async remove(tenantId: string, projectId: string, id: string) {
    await this.validateProject(tenantId, projectId);

    const existing = await this.prisma.receipt.findFirst({
      where: { id, projectId, tenantId },
    });
    if (!existing) throw new NotFoundException('Recebimento não encontrado');

    return this.prisma.$transaction(async (tx) => {
      // Limpa pointers dangling de qualquer source linkado a este receipt
      await tx.receipt.updateMany({
        where: { tenantId, linkedReceiptId: id, deletedAt: null },
        data: { linkedReceiptId: null },
      });

      await tx.cashFlowEntry.updateMany({
        where: { receiptId: id, deletedAt: null },
        data: { deletedAt: new Date() },
      });

      await tx.receipt.update({
        where: { id },
        data: { deletedAt: new Date() },
      });

      return { deleted: true };
    });
  }

  /**
   * Link a receipt retroactively to a bank account.
   * - Validates receipt belongs to the project
   * - Updates receipt.accountId and receipt.bankLast4
   * - Sets origin='account' to mark as explicitly linked
   * - Idempotent: if already linked to same account, returns without error
   */
  async linkAccount(
    tenantId: string,
    projectId: string,
    receiptId: string,
    accountId: string,
  ) {
    // Validate project exists
    await this.validateProject(tenantId, projectId);

    // Fetch the receipt (verify it belongs to this project)
    const receipt = await this.prisma.receipt.findFirst({
      where: { id: receiptId, projectId, tenantId },
    });
    if (!receipt) throw new NotFoundException('Recebimento não encontrado');

    // Fetch the bank account (verify it exists and belongs to this project)
    const account = await this.prisma.bankAccount.findFirst({
      where: { id: accountId, projectId, tenantId, deletedAt: null },
      select: { last4: true },
    });
    if (!account) throw new NotFoundException('Conta bancária não encontrada');

    // Idempotency: if already linked to same account, return as-is
    if (receipt.accountId === accountId) {
      return receipt;
    }

    // Update receipt: link account, set bankLast4, mark origin as 'account'
    return this.prisma.receipt.update({
      where: { id: receiptId },
      data: {
        accountId,
        bankLast4: account.last4,
        origin: 'account',
      },
    });
  }

  private async regenerateCashFlow(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    receipt: {
      id: string;
      projectId: string;
      tenantId: string;
      valor: number;
      data: Date;
      tipo: string;
      status: string;
    },
  ) {
    // Soft-delete existing cash flow entries for this receipt
    await tx.cashFlowEntry.updateMany({
      where: { receiptId: receipt.id, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    // Create new cash flow entry
    await tx.cashFlowEntry.create({
      data: {
        projectId: receipt.projectId,
        tenantId: receipt.tenantId,
        receiptId: receipt.id,
        valor: receipt.valor,
        tipo: 'RECEBIMENTO',
        data: receipt.data,
        categoria: receipt.tipo,
        status: receipt.status,
      },
    });
  }

  private async findExistingExternalIds(
    tenantId: string,
    projectId: string,
    ids: string[],
    db: ExternalIdLookupClient = this.prisma,
  ): Promise<Set<string>> {
    if (ids.length === 0) return new Set();

    const [expenses, receipts] = await Promise.all([
      db.$queryRaw<{ external_id: string }[]>`
        SELECT external_id FROM expenses
        WHERE tenant_id = ${tenantId} AND project_id = ${projectId}
          AND external_id IN (${Prisma.join(ids)})
      `,
      db.$queryRaw<{ external_id: string }[]>`
        SELECT external_id FROM receipts
        WHERE tenant_id = ${tenantId} AND project_id = ${projectId}
          AND external_id IN (${Prisma.join(ids)})
      `,
    ]);

    const set = new Set<string>();
    for (const row of expenses) {
      if (row.external_id) set.add(row.external_id);
    }
    for (const row of receipts) {
      if (row.external_id) set.add(row.external_id);
    }
    return set;
  }

  private async parseImport(
    buffers: Buffer[],
    documentType: ReceiptImportDocumentType,
    source: ReceiptImportSource | undefined,
    password: string | undefined,
    fileName: string | undefined,
    projectId: string,
  ): Promise<ParseResult> {
    const seed = `${RECEIPT_IMPORT_SEED_PREFIX}:${projectId}:${documentType}`;
    if (documentType === RECEIPT_IMPORT_DOCUMENT_TYPE_CARD) {
      return parseStatementBuffers(
        buffers,
        seed,
        (source as CardSourceHint) ?? DEFAULT_IMPORT_SOURCE,
        fileName,
        password,
      );
    }
    return parseBankStatementBuffers(
      buffers,
      seed,
      (source as BankSourceHint) ?? DEFAULT_IMPORT_SOURCE,
      fileName,
      password,
    );
  }

  private isIgnoredImportRow(
    transaction: NormalizedTx,
    documentType: ReceiptImportDocumentType,
  ): boolean {
    return (
      transaction.amountCents === 0 ||
      (documentType === RECEIPT_IMPORT_DOCUMENT_TYPE_CARD &&
        CARD_INVOICE_PAYMENT_PATTERN.test(transaction.merchant))
    );
  }

  private previewType(
    transaction: NormalizedTx,
    documentType: ReceiptImportDocumentType,
  ): typeof PREVIEW_EXPENSE_TYPE | typeof PREVIEW_RECEIPT_TYPE {
    return documentType === RECEIPT_IMPORT_DOCUMENT_TYPE_BANK &&
      transaction.amountCents < 0
      ? PREVIEW_RECEIPT_TYPE
      : PREVIEW_EXPENSE_TYPE;
  }

  private previewStatus(
    transaction: NormalizedTx,
    documentType: ReceiptImportDocumentType,
  ): ExpenseStatus | ReceiptStatus {
    if (documentType === RECEIPT_IMPORT_DOCUMENT_TYPE_BANK) {
      return transaction.amountCents < 0
        ? ReceiptStatus.EM_CAIXA
        : ExpenseStatus.PAGO;
    }
    return transaction.amountCents < 0
      ? ExpenseStatus.PAGO
      : ExpenseStatus.PLANEJADO;
  }

  async previewImport(
    tenantId: string,
    projectId: string,
    buffers: Buffer[],
    documentType: ReceiptImportDocumentType,
    source?: ReceiptImportSource,
    periodLabelOverride?: string,
    password?: string,
    fileName?: string,
  ): Promise<ReceiptImportPreviewResult | ReceiptImportError> {
    await this.validateProject(tenantId, projectId);
    const parsed = await this.parseImport(
      buffers,
      documentType,
      source,
      password,
      fileName,
      projectId,
    );
    if (parsed.error) return { error: parsed.error };

    const ids = parsed.transactions.map((t) => t.externalId);
    const existing = await this.findExistingExternalIds(
      tenantId,
      projectId,
      ids,
    );
    const preview: ReceiptImportPreviewRow[] = parsed.transactions.map(
      (transaction) => {
        const duplicate = existing.has(transaction.externalId);
        return {
          externalId: transaction.externalId,
          date: transaction.date.toISOString().slice(0, 10),
          description: transaction.merchant,
          amountCents: transaction.amountCents,
          type: this.previewType(transaction, documentType),
          status: this.previewStatus(transaction, documentType),
          duplicate,
          willImport:
            !duplicate && !this.isIgnoredImportRow(transaction, documentType),
        };
      },
    );

    return {
      source: parsed.source,
      periodLabel: periodLabelOverride ?? parsed.periodLabel,
      total: preview.length,
      totalAmountCents: parsed.totalAmountCents,
      duplicated: preview.filter((p) => p.duplicate).length,
      preview,
    };
  }

  async commitImport(
    tenantId: string,
    projectId: string,
    buffers: Buffer[],
    documentType: ReceiptImportDocumentType,
    source: ReceiptImportSource | undefined,
    periodLabelOverride: string | undefined,
    password: string | undefined,
    decisions: ReceiptImportDecision[] | undefined,
    createdByUserId: string | null,
    fileName?: string,
  ): Promise<ReceiptImportCommitResult | ReceiptImportError> {
    const validatedDecisions = validateReceiptImportDecisions(decisions) ?? [];
    await this.validateProject(tenantId, projectId);
    const parsed = await this.parseImport(
      buffers,
      documentType,
      source,
      password,
      fileName,
      projectId,
    );
    if (parsed.error) return { error: parsed.error };

    const ids = parsed.transactions.map((t) => t.externalId);
    const existing = await this.findExistingExternalIds(
      tenantId,
      projectId,
      ids,
    );
    const decisionByExternalId = new Map(
      validatedDecisions.map((decision) => [decision.externalId, decision]),
    );

    let expensesInserted = 0;
    let receiptsInserted = 0;
    let duplicated = 0;
    let skipped = 0;
    let failed = 0;
    const expenseIds: string[] = [];
    const receiptIds: string[] = [];

    for (const transaction of parsed.transactions) {
      if (existing.has(transaction.externalId)) {
        duplicated++;
        continue;
      }

      const decision = decisionByExternalId.get(transaction.externalId);
      if (
        decision?.action === RECEIPT_IMPORT_ACTION_SKIP ||
        this.isIgnoredImportRow(transaction, documentType)
      ) {
        skipped++;
        continue;
      }

      const adjustedTransaction: NormalizedTx = {
        ...transaction,
        amountCents: decision?.overrides?.valorCents ?? transaction.amountCents,
      };
      if (adjustedTransaction.amountCents === 0) {
        skipped++;
        continue;
      }

      try {
        const outcome = await this.createImportedWalletRow(
          tenantId,
          projectId,
          documentType,
          adjustedTransaction,
          decision,
          createdByUserId,
        );
        existing.add(transaction.externalId);

        if (outcome.kind === IMPORT_OUTCOME_DUPLICATE) {
          duplicated++;
        } else if (outcome.kind === IMPORT_OUTCOME_EXPENSE) {
          expensesInserted++;
          expenseIds.push(outcome.id);
        } else {
          receiptsInserted++;
          receiptIds.push(outcome.id);
        }
      } catch {
        failed++;
      }
    }

    return {
      source: parsed.source,
      periodLabel: periodLabelOverride ?? parsed.periodLabel,
      count: expensesInserted + receiptsInserted,
      expensesInserted,
      receiptsInserted,
      duplicated,
      skipped,
      failed,
      expenseIds,
      receiptIds,
    };
  }

  private async createImportedWalletRow(
    tenantId: string,
    projectId: string,
    documentType: ReceiptImportDocumentType,
    transaction: NormalizedTx,
    decision: ReceiptImportDecision | undefined,
    createdByUserId: string | null,
  ): Promise<ReceiptImportOutcome> {
    if (
      documentType === RECEIPT_IMPORT_DOCUMENT_TYPE_BANK &&
      transaction.amountCents < 0
    ) {
      return this.createImportedWalletReceipt(
        tenantId,
        projectId,
        transaction,
        decision,
      );
    }

    const categoryOverride = decision?.overrides?.category;
    const manualExpenseType = categoryOverride
      ? null
      : await this.merchantClassifier.manualExpenseType(
          transaction.merchant,
          tenantId,
        );
    const expenseType =
      categoryOverride ??
      manualExpenseType ??
      PESSOAL_CATEGORY_MAP[categorize(transaction.merchant)] ??
      ExpenseType.OUTROS;
    const isRefund =
      documentType === RECEIPT_IMPORT_DOCUMENT_TYPE_CARD &&
      transaction.amountCents < 0;
    const status = isRefund
      ? ExpenseStatus.PAGO
      : documentType === RECEIPT_IMPORT_DOCUMENT_TYPE_CARD
        ? ExpenseStatus.PLANEJADO
        : ExpenseStatus.PAGO;
    const defaultTitle = isRefund
      ? `Estorno: ${transaction.merchant}`
      : transaction.merchant;
    const title = (decision?.overrides?.titulo ?? defaultTitle).slice(
      0,
      MAX_IMPORT_TEXT_LENGTH,
    );
    const supplier = (
      decision?.overrides?.titulo ?? transaction.merchant
    ).slice(0, MAX_IMPORT_TEXT_LENGTH);

    return this.prisma.$transaction(async (db) => {
      const existing = await this.findExistingExternalIds(
        tenantId,
        projectId,
        [transaction.externalId],
        db,
      );
      if (existing.has(transaction.externalId)) {
        return { kind: IMPORT_OUTCOME_DUPLICATE };
      }

      const expense = await db.expense.create({
        data: {
          tenantId,
          projectId,
          tipoDespesa: expenseType,
          titulo: title,
          fornecedor: supplier,
          valor: transaction.amountCents,
          quantidade: 1,
          valorTotal: transaction.amountCents,
          formaPagamento: PaymentForm.A_VISTA,
          dataPagamento: transaction.date,
          dataCompra: transaction.date,
          status,
          importId: null,
          externalId: transaction.externalId,
          cardLast4: null,
          bankLast4: null,
          accountId: null,
          origin: WALLET_ORIGIN,
          linkedExpenseId: null,
          createdByUserId,
        },
      });
      await db.cashFlowEntry.create({
        data: {
          tenantId,
          projectId,
          expenseId: expense.id,
          valor: transaction.amountCents,
          tipo: CashFlowType.DESPESA,
          categoria: expenseType,
          data: transaction.date,
          status,
        },
      });
      return { kind: IMPORT_OUTCOME_EXPENSE, id: expense.id };
    });
  }

  private async createImportedWalletReceipt(
    tenantId: string,
    projectId: string,
    transaction: NormalizedTx,
    decision: ReceiptImportDecision | undefined,
  ): Promise<ReceiptImportOutcome> {
    const value = Math.abs(transaction.amountCents);
    const receiptType = decision?.overrides?.category ?? ReceiptType.OUTROS;
    const description = (
      decision?.overrides?.titulo ?? transaction.merchant
    ).slice(0, MAX_IMPORT_TEXT_LENGTH);

    return this.prisma.$transaction(async (db) => {
      const existing = await this.findExistingExternalIds(
        tenantId,
        projectId,
        [transaction.externalId],
        db,
      );
      if (existing.has(transaction.externalId)) {
        return { kind: IMPORT_OUTCOME_DUPLICATE };
      }

      const receipt = await db.receipt.create({
        data: {
          tenantId,
          projectId,
          valor: value,
          data: transaction.date,
          tipo: receiptType,
          status: ReceiptStatus.EM_CAIXA,
          descricao: description,
          importId: null,
          externalId: transaction.externalId,
          bankLast4: null,
          accountId: null,
          origin: WALLET_ORIGIN,
          linkedReceiptId: null,
        },
      });
      await db.cashFlowEntry.create({
        data: {
          tenantId,
          projectId,
          receiptId: receipt.id,
          valor: value,
          tipo: CashFlowType.RECEBIMENTO,
          categoria: receiptType,
          data: transaction.date,
          status: ReceiptStatus.EM_CAIXA,
        },
      });
      return { kind: IMPORT_OUTCOME_RECEIPT, id: receipt.id };
    });
  }

  private async validateProject(tenantId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, tenantId },
      select: { id: true, type: true },
    });
    if (!project) throw new NotFoundException('Projeto não encontrado');
    return project;
  }

  private async resolveDefaultBankLast4ForProject(
    tenantId: string,
    projectId: string,
    projectType: string,
  ): Promise<string | null> {
    if (projectType !== 'PESSOAL') return null;

    const accounts = await this.prisma.bankAccount.findMany({
      where: { tenantId, projectId, deletedAt: null },
      select: {
        last4: true,
        openingBalanceCents: true,
        openingBalanceDate: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (accounts.length === 0) return null;

    // Mesma âncora do §10 (pickPrimaryBankAccount): receita sem banco explícito é
    // atribuída à conta primária (a que tem saldo inicial configurado), senão à primeira.
    const anchored = accounts.find(
      (a) => a.openingBalanceDate != null || a.openingBalanceCents !== 0,
    );
    return anchored?.last4 ?? accounts.find((a) => !!a.last4)?.last4 ?? null;
  }
}
