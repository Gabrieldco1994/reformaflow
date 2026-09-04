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
  RECEIPT_IMPORT_ACTION_IMPORT,
  RECEIPT_IMPORT_ACTION_SKIP,
  RECEIPT_IMPORT_DOCUMENT_TYPE_BANK,
  RECEIPT_IMPORT_DOCUMENT_TYPE_CARD,
  validateReceiptImportDecisions,
  type ReceiptImportDecision,
  type ReceiptImportDocumentType,
  type ReceiptImportSource,
} from './dto/import-receipt.dto';
import {
  attachDedupeKeys,
  dedupeColumns,
  fileContentHash,
  findDedupeMatches,
  isDedupeUniqueViolation,
  keysFromTransactions,
  type DedupeMatches,
  type PossibleDuplicate,
} from '../import-dedupe/cross-origin-dedupe';

const PESSOAL_CATEGORY_MAP: Record<string, string> = MERCHANT_TO_EXPENSE_TYPE;

/**
 * (#659, espelha `credit-card.service.ts`) Categoria heurística local para uma
 * linha SEM hit confiável do classificador. `null` — não `'OUTROS'` — quando o
 * categorizador de keywords não casou nada (`categorize` devolve `'outros'` só
 * como fallback). Sem isso, `categoriaFonte` marcaria `'regex'` para uma linha
 * que ninguém classificou (finding F3 do PR-4/5).
 */
function localHeuristicCategory(merchant: string): string | null {
  const cat = categorize(merchant);
  if (cat === 'outros') return null;
  return PESSOAL_CATEGORY_MAP[cat] ?? null;
}

/** Overrides de categoria que NÃO viram regra MANUAL (mesma regra de bank/card). */
const NON_LEARNABLE_CATEGORY_OVERRIDES = new Set([
  'MOVIMENTACAO_INTERNA',
  'PAGAMENTO_FATURA_CARTAO',
]);
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
  | typeof IMPORT_OUTCOME_DUPLICATE
  | typeof IMPORT_OUTCOME_EXPENSE
  | typeof IMPORT_OUTCOME_RECEIPT;

export interface ReceiptImportPreviewRow {
  externalId: string;
  date: string;
  description: string;
  amountCents: number;
  type: typeof PREVIEW_EXPENSE_TYPE | typeof PREVIEW_RECEIPT_TYPE;
  status: ExpenseStatus | ReceiptStatus;
  duplicate: boolean;
  willImport: boolean;
  /**
   * (#659 Tier B) Linha cuja natural-key casa uma linha já existente de OUTRA
   * origem — pode ser a mesma transação ou não. NUNCA auto-skip: `willImport`
   * fica `false` e só `decisions:[{externalId, action:'import'}]` força a criação.
   */
  possibleDuplicate?: PossibleDuplicate;
  /**
   * (#659) Origem da categoria sugerida nesta linha de despesa. `regra` = regra
   * MANUAL do tenant/global; `ia` = classificação por IA acima do limiar;
   * `regex` = heurística local casou; `null` = sem sugestão confiável ou linha
   * que não recebe categoria (recebimento / pagamento de fatura).
   */
  categoriaFonte: 'regra' | 'ia' | 'regex' | null;
  /**
   * (#659) Categoria pré-selecionada para a linha de despesa (mesma resolução
   * do commit: hit confiável → tipo mapeado; senão heurística local; senão
   * `OUTROS`). `null` para recebimentos e pagamentos de fatura.
   */
  suggestedCategory: string | null;
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
  /** (#659 Tier B) linhas do preview com `possibleDuplicate` anexado. */
  possibleDuplicates: PossibleDuplicate[];
  /**
   * (#659) Estado da categorização automática em lote (mesmas semânticas de
   * `bank-account`/`credit-card`). Nunca bloqueia — `unavailable`/`error` só
   * pedem revisão das sugestões antes de confirmar.
   */
  classificationStatus: 'ok' | 'unavailable' | 'error';
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
  /**
   * (#659 Tier B) linhas não criadas por casarem natural-key de outra origem
   * sem decisão `action:'import'`. Auditável; não é `duplicated` (auto) nem `skipped` (usuário).
   */
  possibleDuplicates: PossibleDuplicate[];
  /**
   * (#659, AC#7 do #582 / #665) Overrides EXPLÍCITOS de categoria em linhas
   * efetivamente importadas como despesa viram regra MANUAL tenant-scoped.
   * Reportado separado do resultado da importação; efeito PÓS-persistência.
   */
  rulesLearned: number;
  rulesSkippedNoMapping: number;
  rulesLearnFailed: number;
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

  /**
   * (#659) Recheck de duplicata-forte DENTRO da $transaction de criação — o
   * pré-check externo não fecha a corrida entre canais. O índice único parcial
   * de `dedupe_key_strong` é o guard final (P2002 tratado no chamador).
   */
  private async strongDupInTx(
    db: ExternalIdLookupClient,
    tenantId: string,
    projectId: string,
    transaction: NormalizedTx,
  ): Promise<boolean> {
    const { strongDuplicates } = await findDedupeMatches(
      db,
      tenantId,
      projectId,
      keysFromTransactions([transaction]),
    );
    return strongDuplicates.has(transaction.externalId);
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

    attachDedupeKeys(parsed.transactions, {
      tenantId,
      projectId,
      fileContentHash: fileContentHash(buffers),
    });
    const dedupe = await findDedupeMatches(
      this.prisma,
      tenantId,
      projectId,
      keysFromTransactions(parsed.transactions),
    );

    // (#659) Uma única chamada de classificação para os merchants das linhas de
    // DESPESA do lote — nunca por transação. Recebimentos (crédito de extrato) e
    // pagamentos de fatura não recebem categoria, então ficam de fora.
    const expenseMerchants = [
      ...new Set(
        parsed.transactions
          .filter(
            (t) =>
              this.previewType(t, documentType) === PREVIEW_EXPENSE_TYPE &&
              !this.isIgnoredImportRow(t, documentType),
          )
          .map((t) => t.merchant),
      ),
    ];
    const importClassification =
      await this.merchantClassifier.classifyForImport(
        expenseMerchants,
        tenantId,
      );

    const preview: ReceiptImportPreviewRow[] = parsed.transactions.map(
      (transaction) => {
        const duplicate = dedupe.strongDuplicates.has(transaction.externalId);
        const possibleDuplicate = dedupe.possibleDuplicates.get(
          transaction.externalId,
        );
        const type = this.previewType(transaction, documentType);
        const ignored = this.isIgnoredImportRow(transaction, documentType);
        let categoriaFonte: ReceiptImportPreviewRow['categoriaFonte'] = null;
        let suggestedCategory: string | null = null;
        if (type === PREVIEW_EXPENSE_TYPE && !ignored) {
          const hit = importClassification.classifications.get(
            MerchantClassifierService.normalizeKey(transaction.merchant),
          );
          const localCat = localHeuristicCategory(transaction.merchant);
          categoriaFonte = hit ? hit.source : localCat != null ? 'regex' : null;
          suggestedCategory = hit
            ? (PESSOAL_CATEGORY_MAP[hit.category] ?? ExpenseType.OUTROS)
            : (localCat ?? ExpenseType.OUTROS);
        }
        return {
          externalId: transaction.externalId,
          date: transaction.date.toISOString().slice(0, 10),
          description: transaction.merchant,
          amountCents: transaction.amountCents,
          type,
          status: this.previewStatus(transaction, documentType),
          duplicate,
          possibleDuplicate,
          willImport: !duplicate && !ignored && !possibleDuplicate,
          categoriaFonte,
          suggestedCategory,
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
      possibleDuplicates: [...dedupe.possibleDuplicates.values()],
      classificationStatus: importClassification.status,
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

    attachDedupeKeys(parsed.transactions, {
      tenantId,
      projectId,
      fileContentHash: fileContentHash(buffers),
    });
    const dedupe = await findDedupeMatches(
      this.prisma,
      tenantId,
      projectId,
      keysFromTransactions(parsed.transactions),
    );
    const strongExisting = new Set(dedupe.strongDuplicates);
    const decisionByExternalId = new Map(
      validatedDecisions.map((decision) => [decision.externalId, decision]),
    );

    let expensesInserted = 0;
    let receiptsInserted = 0;
    let duplicated = 0;
    let skipped = 0;
    let failed = 0;
    // (#659 Tier B) linhas não criadas por casarem natural-key de outra origem.
    const possibleDuplicates: PossibleDuplicate[] = [];
    // (#659) Overrides EXPLÍCITOS de categoria em linhas efetivamente criadas
    // como despesa — viram regra MANUAL depois do loop, FORA de qualquer tx.
    const learnEntries: Array<{ merchant: string; expenseType: string }> = [];

    for (const transaction of parsed.transactions) {
      if (strongExisting.has(transaction.externalId)) {
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

      // (#659 Tier B) natural-key casou outra origem: só cria com action:'import'.
      const possibleDuplicate = dedupe.possibleDuplicates.get(
        transaction.externalId,
      );
      if (
        possibleDuplicate &&
        decision?.action !== RECEIPT_IMPORT_ACTION_IMPORT
      ) {
        possibleDuplicates.push(possibleDuplicate);
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
        strongExisting.add(transaction.externalId);

        if (outcome === IMPORT_OUTCOME_DUPLICATE) {
          duplicated++;
        } else if (outcome === IMPORT_OUTCOME_EXPENSE) {
          expensesInserted++;
          const categoryOverride = decision?.overrides?.category;
          if (
            categoryOverride &&
            !NON_LEARNABLE_CATEGORY_OVERRIDES.has(categoryOverride)
          ) {
            learnEntries.push({
              merchant: decision?.overrides?.titulo ?? transaction.merchant,
              expenseType: categoryOverride,
            });
          }
        } else {
          receiptsInserted++;
        }
      } catch (err) {
        if (isDedupeUniqueViolation(err)) {
          duplicated++;
          continue;
        }
        failed++;
      }
    }

    // (#659 / #665) Efeito PÓS-persistência, fora de qualquer $transaction:
    // cada override vira regra MANUAL tenant-scoped (nunca global, nunca toca
    // valor/sinal/status/caixa/projeto/vínculo/rateio/settlement).
    const {
      learned: rulesLearned,
      skippedNoMapping: rulesSkippedNoMapping,
      failed: rulesLearnFailed,
    } = await this.merchantClassifier.learnFromImportOverrides(
      learnEntries,
      tenantId,
    );

    return {
      source: parsed.source,
      periodLabel: periodLabelOverride ?? parsed.periodLabel,
      count: expensesInserted + receiptsInserted,
      expensesInserted,
      receiptsInserted,
      duplicated,
      skipped,
      failed,
      possibleDuplicates,
      rulesLearned,
      rulesSkippedNoMapping,
      rulesLearnFailed,
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
      if (await this.strongDupInTx(db, tenantId, projectId, transaction)) {
        return IMPORT_OUTCOME_DUPLICATE;
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
          ...dedupeColumns(transaction),
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
      return IMPORT_OUTCOME_EXPENSE;
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
      if (await this.strongDupInTx(db, tenantId, projectId, transaction)) {
        return IMPORT_OUTCOME_DUPLICATE;
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
          ...dedupeColumns(transaction),
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
      return IMPORT_OUTCOME_RECEIPT;
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
