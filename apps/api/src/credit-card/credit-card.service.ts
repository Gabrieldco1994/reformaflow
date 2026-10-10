import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { assertNoRefundPurpose, cleanupRefundPurpose, reserveRefundWriter, rethrowRefundWriteConflict, REFUND_UNLINK_FIRST } from '../expense/refund-purpose.service';
import { currentInlineRequester } from '../bank-account/inline-expenses';
import { PrismaService } from '../prisma/prisma.service';
import { ExpenseTypeLabels, NEUTRAL_EXPENSE_TYPES, addMonthsToMonthKey, buildInstallments, caixaMonthForCardPurchase, isSinglePaymentForm, CARD_IMPORT_INVALID_DECISION, CARD_IMPORT_IGNORED_REASON, CARD_IMPORT_INVALID_SELECTION, CARD_IMPORT_LINE_OUTCOME, CARD_IMPORT_REVIEW_REASON, CARD_IMPORT_SELECTED_ROWS_CHANGED, isCardImportReviewFingerprint, type CardImportIgnoredReason, type CardImportLineResult, type CardImportReviewDecision, type CardImportReviewItem, type CardImportSkippedItem } from '@reformaflow/domain';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';
import { CreateCreditCardDto, UpdateCreditCardDto } from './dto/credit-card.dto';
import { parseStatementBuffers, type SourceHint, type NormalizedTx, type ParseResult } from './parsers';
import { MerchantClassifierService, MERCHANT_TO_EXPENSE_TYPE } from '../merchant-classifier/merchant-classifier.service';
import {
  assertRateioRequester,
  RateioRequester,
} from '../expense/rateio.types';
import {
  EXPENSE_MODULE,
  resolveAccessibleProjectScope,
  userCanAccessProject,
  userCanAccessProjectType,
} from '../common/access-rules';
import {
  attachDedupeKeys,
  dedupeColumns,
  fileContentHash,
  findDedupeMatches,
  isDedupeStrongUniqueViolation,
  keysFromTransactions,
  strongDupExists,
  type PossibleDuplicate,
} from '../import-dedupe/cross-origin-dedupe';

/** Normaliza a entrada (string legada, Buffer único ou array) para Buffer[]. */
function toBuffers(content: string | Buffer | Buffer[]): Buffer[] {
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [Buffer.from(content, 'utf-8')];
  return [content];
}

// Mapeamento de categorias do parser → ExpenseType pessoal
const PESSOAL_CATEGORY_MAP: Record<string, string> = {
  alimentação: 'ALIMENTACAO',
  transporte: 'TRANSPORTE',
  assinaturas: 'ASSINATURAS',
  viagem: 'LAZER',
  saúde: 'SAUDE',
  beleza: 'BELEZA',
  pets: 'PETS',
  compras: 'OUTROS',
  educação: 'EDUCACAO',
  casa: 'MORADIA',
  outros: 'OUTROS',
};

import { categorize } from './categorizer';
import { buildStoredExpenseInstallments, parseDocumentaryCycle, parseStoredExpenseSchedule, toPublicExpenseSchedule } from '../expense/documented-schedule';
import { DERIVED_SEQUENTIAL, DocumentaryCycle, StoredSourceScheduleV1 } from '../expense/documented-schedule.types';
import { buildSeriesKey, classifyCardImport, excludableSibling, occurrenceGroups, reviewFingerprint as reviewFingerprintOf, reviewItem, siblingPredicate, type OccurrenceGroups, type ReviewLine } from './card-purchase-identity';
import { CARD_IMPORT_LINE_CLASSIFICATION, classifyCardImportLine } from './card-import-line-policy';

const CREDIT_CARD_IMPORT_MAX_AMOUNT_CENTS = 2_147_483_647;

/**
 * (#582 F3) Categoria heurística local para uma transação de fatura SEM hit
 * confiável do classificador. `null` — não `'OUTROS'` — quando o categorizador
 * de keywords não casou nada (`categorize` devolve `'outros'` só como fallback,
 * nunca de match real). Sem isso, `categoriaFonte` marcaria `'regex'` para uma
 * linha que ninguém classificou.
 */
function localHeuristicCategory(merchant: string): string | null {
  const cat = categorize(merchant);
  if (cat === 'outros') return null;
  return PESSOAL_CATEGORY_MAP[cat] ?? null;
}

/** Resultado de criar (ou não) uma linha: `review`/`blocked` significam ZERO escrita. */
type CreateFromTransactionResult =
  | { inserted: boolean; settled: boolean; expenseId?: string; review?: undefined; blocked?: undefined; ignored?: undefined }
  | { inserted: false; settled: false; expenseId?: undefined; review: CardImportReviewItem; blocked?: undefined; ignored?: undefined }
  | { inserted: false; settled: false; expenseId?: undefined; review?: undefined; blocked: true; ignored?: undefined }
  // Política determinística (pagamento de fatura não é compra): terminal, sem escrita, nunca reexecutada.
  | { inserted: false; settled: false; expenseId?: undefined; review?: undefined; blocked?: undefined; ignored: true };

const BLOCKED_RESULT: CreateFromTransactionResult = { inserted: false, settled: false, blocked: true };
const IGNORED_RESULT: CreateFromTransactionResult = { inserted: false, settled: false, ignored: true };
// Sentinela interna: a série tem mais de uma raiz candidata; só a classificação pode responder.
const SERIES_AMBIGUOUS = 'SERIES_AMBIGUOUS' as const;
const reviewResult = (review: CardImportReviewItem): CreateFromTransactionResult => ({
  inserted: false,
  settled: false,
  review,
});

/**
 * Forma de parcelamento e identidade de compra de UMA linha. Fonte única de
 * `create` e `preview`: a impressão digital da revisão só bate se os dois lados
 * calcularem exatamente o mesmo.
 */
function importPurchaseOf(
  cardId: string,
  projectId: string,
  tx: NormalizedTx,
  invoiceDueMonth: string | undefined,
  documentaryCycle: DocumentaryCycle | undefined,
) {
  const total = tx.installmentTotal && tx.installmentTotal > 1 ? tx.installmentTotal : 1;
  const current = tx.installmentCurrent && tx.installmentCurrent >= 1 ? tx.installmentCurrent : 1;
  const seriesKey = total > 1 ? buildSeriesKey(cardId, tx.merchant, tx.amountCents, total) : null;
  const purchase = {
    cardId, projectId, merchant: tx.merchant, total, seriesKey,
    externalId: tx.externalId, dedupeKeyStrong: tx.dedupeKeyStrong ?? null,
  };
  const reviewLine: ReviewLine = {
    externalId: tx.externalId,
    cardId,
    projectId,
    seriesKey,
    merchant: tx.merchant,
    amountCents: tx.amountCents,
    total,
    current,
    date: tx.date,
    invoiceDueMonth: invoiceDueMonth ?? null,
    documentaryCycle: documentaryCycle ?? null,
  };
  return { total, current, seriesKey, purchase, reviewLine };
}

const IMPORT_DECISION_ACTIONS: ReadonlySet<string> = new Set(['create', 'skip', 'link', 'import']);
const MISSING_IDS_SAMPLE = 50;

function invalidDecision(message: string): BadRequestException {
  return new BadRequestException({ code: CARD_IMPORT_INVALID_DECISION, message });
}

/** Valida a forma das decisões ANTES de qualquer efeito (400 INVALID_DECISION). */
function validateImportDecisions(decisions: unknown): ImportDecision[] {
  if (decisions === undefined || decisions === null) return [];
  if (!Array.isArray(decisions)) throw invalidDecision('decisions deve ser uma lista');
  const seen = new Set<string>();
  for (const item of decisions as unknown[]) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalidDecision('cada decisão deve ser um objeto');
    const d = item as Record<string, unknown>;
    if (typeof d.externalId !== 'string' || d.externalId === '') throw invalidDecision('externalId da decisão é obrigatório');
    if (seen.has(d.externalId)) throw invalidDecision('externalId repetido nas decisões');
    seen.add(d.externalId);
    if (d.action !== undefined && (typeof d.action !== 'string' || !IMPORT_DECISION_ACTIONS.has(d.action))) {
      throw invalidDecision('action da decisão inválida');
    }
    if (d.reviewFingerprint !== undefined) {
      if (d.action !== 'import') throw invalidDecision('reviewFingerprint só vale com action "import"');
      if (!isCardImportReviewFingerprint(d.reviewFingerprint)) throw invalidDecision('reviewFingerprint inválido');
    }
  }
  return decisions as ImportDecision[];
}

/** Valida a forma de `selectedExternalIds` (400 INVALID_SELECTION); `undefined` = legado. */
function validateSelectedExternalIds(selected: unknown): Set<string> | undefined {
  if (selected === undefined) return undefined;
  const invalid = (message: string) => new BadRequestException({ code: CARD_IMPORT_INVALID_SELECTION, message });
  if (!Array.isArray(selected) || selected.length === 0) throw invalid('selectedExternalIds deve ser uma lista não vazia');
  const ids = new Set<string>();
  for (const id of selected as unknown[]) {
    if (typeof id !== 'string' || id === '') throw invalid('selectedExternalIds só aceita textos não vazios');
    if (ids.has(id)) throw invalid('selectedExternalIds tem itens repetidos');
    ids.add(id);
  }
  return ids;
}

export interface ImportDecision {
  externalId: string;
  // 'import' (#659) força uma linha marcada `possibleDuplicate` (Tier B) a ser criada.
  action?: 'create' | 'skip' | 'link' | 'import';
  linkToExpenseId?: string;        // quando action='link'
  /** Só com action='import': prende a escolha ao estado revisado (ver CardImportReviewItem). */
  reviewFingerprint?: CardImportReviewDecision['reviewFingerprint'];
  overrides?: {
    titulo?: string;
    valorCents?: number;
    category?: string;             // ExpenseType pessoal (ex.: 'MORADIA', 'ALIMENTACAO')
    documentaryCycle?: DocumentaryCycle;
  };
}

@Injectable()
export class CreditCardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conciliacao: ConciliacaoService,
    private readonly merchantClassifier: MerchantClassifierService,
  ) {}

  // ─── CRUD cartões ────────────────────────────────────────

  async listCards(tenantId: string, projectId: string) {
    await this.ensureProject(tenantId, projectId);
    const cards = await this.prisma.creditCard.findMany({
      where: { tenantId, projectId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return Promise.all(cards.map((card) => this.withLimitUsage(tenantId, projectId, card)));
  }

  /** Lista todos os cartões do tenant (independente de projeto). Útil para vínculos cross-project. */
  async listCardsTenant(tenantId: string, scope: string[] | null) {
    return this.prisma.creditCard.findMany({
      where: { tenantId, deletedAt: null, ...(scope ? { projectId: { in: scope } } : {}) },
      orderBy: [{ projectId: 'asc' }, { createdAt: 'asc' }],
      include: { project: { select: { id: true, name: true, type: true } } },
    });
  }

  private async withLimitUsage<T extends {
    last4: string;
    limitTotalCents: number | null;
    closingDay: number | null;
    dueDay: number | null;
  }>(tenantId: string, projectId: string, card: T) {
    if (card.limitTotalCents == null) return card;

    const { used: limitUsedCents, month: currentOpenInvoiceMonth } =
      await this.computeOpenInvoiceUsed(tenantId, projectId, card);
    const limitUsagePercent = card.limitTotalCents > 0
      ? Math.round((limitUsedCents / card.limitTotalCents) * 100)
      : (limitUsedCents > 0 ? 100 : 0);

    return {
      ...card,
      limitUsedCents,
      limitAvailableComputedCents: card.limitTotalCents - limitUsedCents,
      limitUsagePercent,
      currentOpenInvoiceMonth,
    };
  }

  /**
   * Fatura aberta (compras não-neutras cujo vencimento cai no próximo
   * fechamento >= hoje), independente de haver limite configurado.
   * Fonte única usada por withLimitUsage e por listOpenInvoices.
   */
  private async computeOpenInvoiceUsed(
    tenantId: string,
    projectId: string,
    card: { last4: string; closingDay: number | null; dueDay: number | null },
  ): Promise<{ used: number; month: string }> {
    const currentOpenInvoiceMonth = this.currentOpenInvoiceMonth(card);
    const neutral = Array.from(NEUTRAL_EXPENSE_TYPES);
    const purchases = await this.prisma.expense.findMany({
      where: {
        tenantId,
        projectId,
        cardLast4: card.last4,
        deletedAt: null,
        tipoDespesa: { notIn: neutral },
      },
      select: {
        valorTotal: true,
        tipoDespesa: true,
        dataPagamento: true,
        dataInicioParcela: true,
        createdAt: true,
        documentedSchedule: true,
        formaPagamento: true,
        quantidadeParcela: true,
        installmentDateOverrides: true,
      },
    });

    const used = purchases.reduce((sum, expense) => {
      if (NEUTRAL_EXPENSE_TYPES.has(expense.tipoDespesa)) return sum;
      const schedule = toPublicExpenseSchedule(parseStoredExpenseSchedule(expense.documentedSchedule));
      if (schedule) {
        return sum + buildInstallments({ ...expense, schedule }).reduce((total, occurrence) =>
          caixaMonthForCardPurchase(occurrence.data, card.closingDay, card.dueDay, occurrence.invoiceDueMonth) === currentOpenInvoiceMonth
            ? total + occurrence.valor : total, 0);
      }
      const purchaseDate = expense.dataPagamento ?? expense.dataInicioParcela ?? expense.createdAt;
      const invoiceMonth = caixaMonthForCardPurchase(purchaseDate, card.closingDay, card.dueDay);
      return invoiceMonth === currentOpenInvoiceMonth ? sum + expense.valorTotal : sum;
    }, 0);

    return { used, month: currentOpenInvoiceMonth };
  }

  /**
   * Fatura aberta de cada cartão do projeto, SEMPRE com o valor usado (mesmo
   * sem limite configurado). Usado por agregações de patrimônio/dívida.
   */
  async listOpenInvoices(tenantId: string, projectId: string) {
    await this.ensureProject(tenantId, projectId);
    const cards = await this.prisma.creditCard.findMany({
      where: { tenantId, projectId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, nickname: true, last4: true, limitTotalCents: true, closingDay: true, dueDay: true },
    });
    return Promise.all(
      cards.map(async (card) => {
        const { used, month } = await this.computeOpenInvoiceUsed(tenantId, projectId, card);
        return {
          id: card.id,
          nickname: card.nickname,
          last4: card.last4,
          limitTotalCents: card.limitTotalCents,
          openInvoiceUsedCents: used,
          openInvoiceMonth: month,
        };
      }),
    );
  }

  private currentOpenInvoiceMonth(card: { closingDay: number | null; dueDay: number | null }, today = new Date()): string {
    const year = today.getUTCFullYear();
    const month = today.getUTCMonth();
    if (card.closingDay == null || card.dueDay == null) {
      return this.formatYearMonth(year, month);
    }

    const todayStart = new Date(Date.UTC(year, month, today.getUTCDate()));
    const dueThisMonth = this.clampedUtcDate(year, month, card.dueDay);
    const target = dueThisMonth >= todayStart
      ? dueThisMonth
      : this.clampedUtcDate(year, month + 1, card.dueDay);
    return this.formatYearMonth(target.getUTCFullYear(), target.getUTCMonth());
  }

  private clampedUtcDate(year: number, monthIndex0: number, day: number): Date {
    const lastDay = new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, monthIndex0, Math.min(day, lastDay)));
  }

  private formatYearMonth(year: number, monthIndex0: number): string {
    const d = new Date(Date.UTC(year, monthIndex0, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  /**
   * B1a (#448): impede um SEGUNDO cartão ATIVO com o mesmo `last4` no mesmo
   * `{tenantId, projectId}` — cartões soft-deletados não contam (poderia ser um
   * reimport legítimo do mesmo final após remoção). `excludeId` exclui o
   * próprio registro num update (não é duplicata de si mesmo).
   *
   * ponytail: o check-then-create roda dentro de UMA `$transaction`
   * interativa, mas isso só fecha a corrida ENTRE `await`s de um único
   * processo Node — não há UNIQUE no schema, então duas instâncias da API (ou
   * dois workers) ainda podem intercalar e ambas passarem o check antes de
   * qualquer uma escrever. Teto honesto: 1 processo. Upgrade definitivo é um
   * índice único parcial `(tenant_id, project_id, last4) WHERE deleted_at IS
   * NULL` via migration (Postgres/SQLite ambos suportam índice parcial).
   */
  private async assertNoDuplicateCard(
    tx: Prisma.TransactionClient,
    tenantId: string,
    projectId: string,
    last4: string,
    excludeId?: string,
  ): Promise<void> {
    const duplicate = await tx.creditCard.findFirst({
      where: {
        tenantId,
        projectId,
        last4,
        deletedAt: null,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (duplicate) {
      throw new ConflictException('Já existe um cartão ativo com este final (últimos 4 dígitos) neste projeto.');
    }
  }

  async createCard(tenantId: string, projectId: string, dto: CreateCreditCardDto) {
    await this.ensureProject(tenantId, projectId);
    const nickname = dto.nickname?.trim() || `${dto.brand} ****${dto.last4}`;
    return this.prisma.$transaction(async (tx) => {
      await this.assertNoDuplicateCard(tx, tenantId, projectId, dto.last4);
      return tx.creditCard.create({
        data: { ...dto, nickname, tenantId, projectId },
      });
    });
  }

  async updateCard(tenantId: string, projectId: string, id: string, dto: UpdateCreditCardDto) {
    await this.findCard(tenantId, projectId, id);
    const data: any = { ...dto };
    if (dto.nickname != null) {
      data.nickname = dto.nickname.trim() || undefined;
      if (!data.nickname) delete data.nickname;
    }
    await this.prisma.$transaction(async (tx) => {
      if (['last4', 'institution', 'brand', 'closingDay', 'dueDay'].some(key => key in dto)) {
        await reserveRefundWriter(tx, tenantId);
        const current = await tx.creditCard.findFirst({ where: { id, tenantId, projectId, deletedAt: null } });
        if (!current) throw new NotFoundException('Cartão não encontrado');
        const identityKeys = ['last4', 'institution', 'brand', 'closingDay', 'dueDay'] as const;
        if (identityKeys.some(key => dto[key] !== undefined && dto[key] !== current[key]))
          await this.assertNoCardRefund(tx, tenantId, id);
      }
      if (dto.last4 !== undefined) {
        await this.assertNoDuplicateCard(tx, tenantId, projectId, dto.last4, id);
      }
      await tx.creditCard.update({ where: { id }, data });
    });
    return this.findCard(tenantId, projectId, id);
  }

  async deleteCard(tenantId: string, projectId: string, id: string) {
    await this.findCard(tenantId, projectId, id);
    await this.prisma.$transaction(async tx => {
      await reserveRefundWriter(tx, tenantId);
      await this.assertNoCardRefund(tx, tenantId, id);
      await tx.creditCard.delete({ where: { id } });
    });
    return { ok: true };
  }

  private async assertNoCardRefund(tx: Prisma.TransactionClient, tenantId: string, cardId: string) {
    const batches = await tx.creditCardStatementImport.findMany({
      where: { tenantId, cardId, deletedAt: { not: undefined } }, select: { id: true },
    });
    if (await tx.rateioAllocation.findFirst({ where: {
      tenantId, isRefundCredit: true, source: { tenantId, importId: { in: batches.map(row => row.id) } },
    } })) throw new ConflictException(REFUND_UNLINK_FIRST);
  }

  // ─── Imports ─────────────────────────────────────────────

  async listImports(tenantId: string, projectId: string, cardId: string) {
    await this.findCard(tenantId, projectId, cardId);
    return this.prisma.creditCardStatementImport.findMany({
      where: { tenantId, cardId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async previewImport(
    tenantId: string,
    projectId: string,
    cardId: string,
    fileContent: string | Buffer | Buffer[],
    fileName: string | undefined,
    source: SourceHint,
    password: string | undefined,
    requester: RateioRequester,
  ) {
    assertRateioRequester(requester);
    const card = await this.findCard(tenantId, projectId, cardId);
    const buffers = toBuffers(fileContent);
    const parsed = await parseStatementBuffers(buffers, card.id, source, fileName, password);
    // (#659) chaves de dedupe cross-origin — seed-free, antes de qualquer lookup.
    attachDedupeKeys(parsed.transactions, {
      tenantId,
      projectId,
      fileContentHash: fileContentHash(buffers),
    });
    // Resolve a lente antes de qualquer leitura/ranking de candidatos. A
    // transação mantém projetos e despesas no mesmo snapshot.
    const { otherProjects, planned } = await this.prisma.$transaction(async (tx) => {
      // Candidato é Expense: exige o módulo `expenses` no projeto candidato —
      // `creditCards` do MESMO tipo não vale (#480 SEC-1).
      const scope = await resolveAccessibleProjectScope(
        tx,
        tenantId,
        requester.role,
        requester.allowedProjects,
        requester.allowedProjectTypes,
        requester.allowedModules ?? [],
        EXPENSE_MODULE,
      );
      const projects = await tx.project.findMany({
        where: {
          tenantId,
          id: {
            not: projectId,
            ...(scope !== null ? { in: scope } : {}),
          },
          deletedAt: null,
        },
        select: { id: true, name: true, type: true },
      });
      const expenses = projects.length > 0
        ? await tx.expense.findMany({
          where: {
            tenantId,
            projectId: { in: projects.map((project) => project.id) },
            OR: [
              { status: 'PLANEJADO' },
              { status: 'PAGO', quantidadeParcela: { gt: 1 } },
            ],
            linkedExpenseId: null,
            deletedAt: null,
          },
          take: 1000,
          orderBy: { dataInicioParcela: 'desc' },
        })
        : [];
      return { otherProjects: projects, planned: expenses };
    });
    const projectById = new Map(otherProjects.map((p) => [p.id, p]));
    const dedupe = await findDedupeMatches(
      this.prisma,
      tenantId,
      projectId,
      keysFromTransactions(parsed.transactions),
    );

    function findMatches(tx: NormalizedTx) {
      if (planned.length === 0) return [];
      const txDate = tx.date;
      const minDate = new Date(txDate); minDate.setUTCDate(minDate.getUTCDate() - 10);
      const maxDate = new Date(txDate); maxDate.setUTCDate(maxDate.getUTCDate() + 10);
      const txCents = tx.amountCents;
      const tolerance = Math.max(100, Math.round(txCents * 0.05));
      const scored = planned
        .map((p) => {
          const slices = buildStoredExpenseInstallments(p);
          const fallbackDate = p.dataPagamento ?? p.dataInicioParcela ?? p.createdAt;
          const isInstallment = !isSinglePaymentForm(p.formaPagamento);
          const candidates = isInstallment
            ? slices.map((s, idx) => ({ idx, value: s.valor, date: s.data }))
            : [{ idx: -1, value: p.valorTotal, date: fallbackDate }];
          const valid = candidates.filter((c) => {
            if (Math.abs(c.value - txCents) > tolerance) return false;
            return c.date >= minDate && c.date <= maxDate;
          });
          if (valid.length === 0) return null;
          const best = valid.sort((a, b) => {
            const deltaA = Math.abs(a.value - txCents);
            const deltaB = Math.abs(b.value - txCents);
            if (deltaA !== deltaB) return deltaA - deltaB;
            return Math.abs(a.date.getTime() - txDate.getTime()) - Math.abs(b.date.getTime() - txDate.getTime());
          })[0];
          const proj = projectById.get(p.projectId);
          return {
            expenseId: p.id,
            projectId: p.projectId,
            projectName: proj?.name ?? '',
            projectType: proj?.type ?? '',
            titulo: p.titulo,
            fornecedor: p.fornecedor,
            valorCents: best.value,
            data: best.date.toISOString().slice(0, 10),
            deltaCents: txCents - best.value,
            installmentCurrent: isInstallment && best.idx >= 0 ? best.idx + 1 : null,
            installmentTotal: isInstallment ? slices.length : null,
          };
        })
        .filter((m): m is NonNullable<typeof m> => !!m)
        .sort((a, b) => Math.abs(a.deltaCents) - Math.abs(b.deltaCents));
      return scored.slice(0, 5);
    }

    // #582 PR-5: uma única chamada de classificação para os merchants de
    // TODAS as transações do lote (atuais + parcelas futuras) — nunca por
    // transação. `classifications` só carrega hits confiáveis (regra/ia);
    // ausência de chave = "sem hit confiável", cai na heurística local.
    const allMerchants = [
      ...parsed.transactions.map((t) => t.merchant),
      ...(parsed.futureInstallments ?? []).map((t) => t.merchant),
    ];
    const importClassification = await this.merchantClassifier.classifyForImport(
      [...new Set(allMerchants)],
      tenantId,
    );

    // (#582 F3) hit → fonte do classificador; sem hit, PIX PF nunca é
    // classificado (mesmo tratamento do extrato) e o heurístico local só marca
    // 'regex' quando de fato casou algo — senão `categoriaFonte: null`.
    const classifyTx = (tx: NormalizedTx) => {
      const hit = importClassification.classifications.get(
        MerchantClassifierService.normalizeKey(tx.merchant),
      );
      const isPixPf = MerchantClassifierService.isLikelyPixPessoaFisica(tx.merchant);
      const localCat = hit || isPixPf ? null : localHeuristicCategory(tx.merchant);
      return {
        suggestedCategory: hit
          ? MERCHANT_TO_EXPENSE_TYPE[hit.category]
          : (localCat ?? 'OUTROS'),
        categoriaFonte: hit ? hit.source : localCat != null ? 'regex' : null,
      };
    };

    // Todas as linhas lidas, antes de qualquer seleção: define quem é irmã de quem.
    const occurrences = occurrenceGroups(parsed.transactions);
    const preview = [];
    for (const tx of parsed.transactions) {
      const strong = dedupe.strongDuplicates.has(tx.externalId);
      const possibleDuplicate = dedupe.possibleDuplicates.get(tx.externalId);
      // Mesmo padrão e merchant ORIGINAL do commit; independe do Tier B; forte vence.
      const ignored: CardImportIgnoredReason | null =
        !strong &&
        classifyCardImportLine({ documentaryText: tx.merchant }) ===
          CARD_IMPORT_LINE_CLASSIFICATION.IGNORE_INVOICE_PAYMENT
          ? CARD_IMPORT_IGNORED_REASON.INVOICE_PAYMENT
          : null;
      const review = strong ? null : await this.previewReview(card.id, projectId, tenantId, tx, parsed.invoiceDueMonth, occurrences);
      const { dedupeKeyStrong: _dks, dedupeKeyNatural: _dkn, ...txPublic } = tx;
      preview.push({
        ...txPublic,
        date: tx.date.toISOString().slice(0, 10),
        duplicate: strong,
        possibleDuplicate,
        review,
        ignored,
        willImport: !strong && !possibleDuplicate && !review && !ignored,
        ...classifyTx(tx),
        crossProjectMatches: findMatches(tx),
      });
    }

    const futureInstallments = (parsed.futureInstallments ?? []).map((tx) => ({
      ...tx,
      date: tx.date.toISOString().slice(0, 10),
      ...classifyTx(tx),
      crossProjectMatches: findMatches(tx),
    }));

    return {
      source: parsed.source,
      periodLabel: parsed.periodLabel,
      totalAmountCents: parsed.totalAmountCents,
      total: parsed.transactions.length,
      duplicated: preview.filter((p) => p.duplicate).length,
      inserted: 0, // ainda não inseriu
      preview,
      possibleDuplicates: [...dedupe.possibleDuplicates.values()],
      futureInstallments,
      classificationStatus: importClassification.status,
    };
  }

  /**
   * Revisão que o commit exigiria para esta linha, só sobre o estado persistido
   * (o lote ainda não escreveu nada). `null` = nada a decidir OU a identidade
   * idêntica de série, que o commit reaproveita/decide sozinho.
   */
  private async previewReview(
    cardId: string,
    projectId: string,
    tenantId: string,
    tx: NormalizedTx,
    invoiceDueMonth: string | undefined,
    occurrences: OccurrenceGroups,
  ): Promise<CardImportReviewItem | null> {
    if (
      !Number.isSafeInteger(tx.amountCents) ||
      tx.amountCents <= 0 ||
      tx.amountCents > CREDIT_CARD_IMPORT_MAX_AMOUNT_CENTS ||
      classifyCardImportLine({ documentaryText: tx.merchant }) ===
        CARD_IMPORT_LINE_CLASSIFICATION.IGNORE_INVOICE_PAYMENT
    ) {
      return null;
    }
    const { purchase, reviewLine } = importPurchaseOf(cardId, projectId, tx, invoiceDueMonth, undefined);
    const admission = await classifyCardImport(this.prisma, tenantId, purchase, siblingPredicate(occurrences, reviewLine));
    if (admission.kind === 'REVIEW') return reviewItem(reviewLine, CARD_IMPORT_REVIEW_REASON.REQUIRED, admission);
    if (admission.kind === 'BLOCKED' && !admission.sameSeries) {
      return reviewItem(reviewLine, CARD_IMPORT_REVIEW_REASON.BLOCKED, null);
    }
    return null;
  }

  async commitImport(
    tenantId: string,
    projectId: string,
    cardId: string,
    fileContent: string | Buffer | Buffer[],
    fileName: string | undefined,
    source: SourceHint,
    periodLabelOverride: string | undefined,
    password: string | undefined,
    decisionsInput: unknown,
    createdByUserId: string | null,
    requester: RateioRequester,
    selectedExternalIds?: unknown,
  ) {
    assertRateioRequester(requester);
    // Forma inválida => 400 antes de qualquer leitura/efeito. Sem fallback.
    const decisions = validateImportDecisions(decisionsInput);
    const selected = validateSelectedExternalIds(selectedExternalIds);
    const card = await this.findCard(tenantId, projectId, cardId);
    const buffers = toBuffers(fileContent);
    const parsed = await parseStatementBuffers(buffers, card.id, source, fileName, password);
    attachDedupeKeys(parsed.transactions, {
      tenantId,
      projectId,
      fileContentHash: fileContentHash(buffers),
    });
    // Seleção da tentativa: confere pertencimento ANTES de dedupe, ACL de alvo e
    // importRecord — um ID que sumiu do documento não tem efeito nenhum (409).
    if (selected) {
      const parsedIds = new Set(parsed.transactions.map((t) => t.externalId));
      const missing = [...selected].filter((id) => !parsedIds.has(id));
      if (missing.length > 0) {
        // Corpo do contrato fechado: exatamente estas chaves, sem prosa.
        throw new ConflictException({
          code: CARD_IMPORT_SELECTED_ROWS_CHANGED,
          missingCount: missing.length,
          missingExternalIds: missing.slice(0, MISSING_IDS_SAMPLE),
        });
      }
    }
    // Linhas fora da seleção saem da rodada: sem dedupe, reuso, vínculo, carimbo,
    // Tier B ou revisão, e as decisões delas são ignoradas.
    const inRound = parsed.transactions.filter((t) => !selected || selected.has(t.externalId));
    // A irmandade vale para o documento inteiro, não só para as linhas desta rodada.
    const occurrences = occurrenceGroups(parsed.transactions);
    const notSelected = parsed.transactions.length - inRound.length;
    // `invoiceDueMonth` vem lido do próprio arquivo (linha "Vencimento") e tem
    // precedência sobre `periodLabel`, que é um palpite pela densidade das datas
    // dos lançamentos — palpite que erra em toda fatura Itaú, porque ela lista a
    // data da COMPRA (a de setembro do 5572 era inferida como julho).
    const periodLabel =
      periodLabelOverride ?? parsed.invoiceDueMonth ?? parsed.periodLabel ?? new Date().toISOString().slice(0, 7);

    // Index decisions por externalId
    const decisionByExt = new Map<string, ImportDecision>();
    for (const d of decisions) decisionByExt.set(d.externalId, d);
    // (#659) linhas Tier B que o usuário escolheu criar mesmo assim.
    const forcedImport = new Set(
      decisions.filter((d) => d.action === 'import').map((d) => d.externalId),
    );

    const dedupe = await findDedupeMatches(
      this.prisma,
      tenantId,
      projectId,
      keysFromTransactions(inRound),
    );
    const existingIds = dedupe.strongDuplicates;

    // (#659) Tier B sem decisão `import` → não cria, entra em `possibleDuplicates[]`.
    const possibleDuplicates: PossibleDuplicate[] = [];

    // Filtra transações: pula as que tem decision=skip, já existentes (strong) ou
    // possível-duplicata Tier B não forçada.
    const toProcess = inRound.filter((t) => {
      const d = decisionByExt.get(t.externalId);
      if (d?.action === 'skip') return false;
      if (existingIds.has(t.externalId)) return false;
      const pd = dedupe.possibleDuplicates.get(t.externalId);
      if (pd && !forcedImport.has(t.externalId)) {
        possibleDuplicates.push(pd);
        return false;
      }
      return true;
    });
    const processableDecisions = toProcess
      .map((transaction) => decisionByExt.get(transaction.externalId))
      .filter((decision): decision is ImportDecision => Boolean(decision));
    const targetExpenseIds = [
      ...new Set(
        processableDecisions
          .filter((decision) => decision.action === 'link')
          .map((decision) => decision.linkToExpenseId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    if (targetExpenseIds.length > 0) {
      await this.prisma.$transaction((tx) =>
        this.conciliacao.assertCanSettleTargets(
          tx,
          { tenantId, targetExpenseIds },
          requester,
        ),
      );
    }
    // manter em sincronia com bank-account.service.ts (commitImport: userSkipped / duplicatedItems / duplicated)
    // Conta linhas REAIS da rodada: id fantasma em `decisions` não vira skip.
    const userSkipped = inRound.filter((t) => decisionByExt.get(t.externalId)?.action === 'skip' && !existingIds.has(t.externalId)).length;
    // `duplicated` NÃO subtrai TODAS as decisions `skip`: uma linha que é
    // duplicata-contra-histórico (`existingIds.has`) E veio marcada `skip` já
    // saiu de `toProcess` pelas duas condições — subtraí-la de novo por
    // `decisions.filter(skip).length` a fazia sumir do relatório inteiro
    // (`total !== inserted + duplicated + skipped`). Só o skip de linha NOVA
    // (`userSkipped`) é balde à parte. (#568 M6a)
    const duplicated =
      inRound.length -
      toProcess.length -
      userSkipped -
      possibleDuplicates.length;
    // Lista auditável do que foi ignorado como duplicata (linhas, não só a contagem).
    // manter em sincronia com bank-account.service.ts (commitImport: userSkipped / duplicatedItems / duplicated)
    const duplicatedItems = inRound
      .filter((t) => {
        const d = decisionByExt.get(t.externalId);
        if (d?.action === 'skip' && !existingIds.has(t.externalId)) return false; // skip do usuário em linha nova, contado à parte
        return existingIds.has(t.externalId);
      })
      .map((t) => ({
        externalId: t.externalId,
        date: t.date,
        description: t.merchant,
        amountCents: t.amountCents,
        reason: 'duplicate' as const,
      }));

    const importRecord = await this.prisma.creditCardStatementImport.create({
      data: {
        tenantId,
        cardId: card.id,
        periodLabel,
        source: parsed.source,
        fileName: fileName?.slice(0, 200),
        fileSize: buffers.reduce((s, b) => s + b.length, 0),
        status: 'COMPLETED',
        inserted: toProcess.length,
        duplicated,
        totalAmountCents: parsed.totalAmountCents,
      },
    });

    let inserted = 0;
    let settled = 0;
    let skipped = 0;
    let linked = 0;
    // (#659) corrida cross-canal: o pré-check passou nos dois lados e o índice
    // único parcial de `dedupe_key_strong` pegou o 2º INSERT.
    let raceDuplicated = 0;
    const reviewRequired: CardImportReviewItem[] = [];
    const skippedItems: CardImportSkippedItem[] = [];
    // Desfecho por linha, preenchido pelo mesmo laço que alimenta os contadores.
    const outcomes = new Map<string, { outcome: CardImportLineResult['outcome']; linked?: true }>();
    const setOutcome = (externalId: string, outcome: CardImportLineResult['outcome'], linkedRow?: true) =>
      outcomes.set(externalId, linkedRow ? { outcome, linked: true } : { outcome });
    // AC#7 (#582): overrides explícitos de linhas efetivamente criadas — viram
    // regra MANUAL tenant-scoped depois do loop (fora de qualquer tx).
    const learnEntries: Array<{ merchant: string; expenseType: string }> = [];
    for (const tx of toProcess) {
      const d = decisionByExt.get(tx.externalId);
      // Aplica overrides antes de criar
      const adjustedTx: NormalizedTx = {
        ...tx,
        merchant: d?.overrides?.titulo ?? tx.merchant,
        amountCents: d?.overrides?.valorCents ?? tx.amountCents,
      };
      // (SEC-2 #659) recheck imediatamente antes do create — fecha a janela da
      // corrida cross-canal (Carteira-como-cartão dos mesmos bytes) sem depender
      // só do P2002. Confere expenses + receipts.
      if (await strongDupExists(this.prisma, tenantId, projectId, tx)) {
        raceDuplicated++;
        setOutcome(tx.externalId, CARD_IMPORT_LINE_OUTCOME.DUPLICATED);
        continue;
      }
      try {
        if (
          classifyCardImportLine({ documentaryText: tx.merchant }) ===
          CARD_IMPORT_LINE_CLASSIFICATION.IGNORE_INVOICE_PAYMENT
        ) {
          skipped++;
          setOutcome(tx.externalId, CARD_IMPORT_LINE_OUTCOME.SKIPPED);
          continue;
        }
        const documentaryCycle = d?.overrides?.documentaryCycle === undefined
          ? undefined : parseDocumentaryCycle(d.overrides.documentaryCycle);
        if (documentaryCycle && Math.sign(adjustedTx.amountCents) !== Math.sign(tx.amountCents)) {
          throw new BadRequestException('O ciclo documental não permite alterar o sinal da transação');
        }
        const result = await this.prisma.$transaction(async (db) => {
          // Final identity/series reads and every row write share the SQLite writer reservation.
          const locked = await db.$executeRaw`
            UPDATE credit_cards SET id = id WHERE id = ${card.id}
              AND tenant_id = ${tenantId} AND project_id = ${projectId} AND deleted_at IS NULL
          `;
          if (locked !== 1) throw new NotFoundException('Cartão não encontrado');
          const batch = await db.creditCardStatementImport.findFirst({
            where: { id: importRecord.id, tenantId, cardId: card.id, deletedAt: null, status: 'COMPLETED' },
          });
          if (!batch) throw new ConflictException('Importação indisponível');
          if (await strongDupExists(db, tenantId, projectId, tx)) {
            return { inserted: false, settled: false, duplicate: true, expenseId: undefined };
          }
          return { ...await this.createExpenseFromTransaction(
            db, tenantId, projectId, card, adjustedTx, importRecord.id,
            d?.overrides?.category, createdByUserId ?? requester.id ?? null,
            parsed.invoiceDueMonth, documentaryCycle,
            d?.action === 'import' ? d.reviewFingerprint : undefined,
            occurrences,
          ), duplicate: false };
        });
        if (result.duplicate) {
          raceDuplicated++;
          setOutcome(tx.externalId, CARD_IMPORT_LINE_OUTCOME.DUPLICATED);
          continue;
        }
        if (result.review) {
          reviewRequired.push(result.review);
          setOutcome(tx.externalId, CARD_IMPORT_LINE_OUTCOME.REVIEW_REQUIRED);
          continue;
        }
        if (result.ignored) {
          skipped++;
          setOutcome(tx.externalId, CARD_IMPORT_LINE_OUTCOME.SKIPPED);
          continue;
        }
        if (result.blocked) {
          skipped++;
          skippedItems.push({ externalId: tx.externalId, reason: CARD_IMPORT_REVIEW_REASON.BLOCKED });
          setOutcome(tx.externalId, CARD_IMPORT_LINE_OUTCOME.BLOCKED);
          continue;
        }
        if (result.settled) settled++;
        if (result.inserted) inserted++;
        setOutcome(tx.externalId, result.settled ? CARD_IMPORT_LINE_OUTCOME.REUSED : CARD_IMPORT_LINE_OUTCOME.CREATED);

        const catOverride = d?.overrides?.category;
        if (
          result.inserted &&
          result.expenseId &&
          catOverride &&
          catOverride !== 'MOVIMENTACAO_INTERNA' &&
          catOverride !== 'PAGAMENTO_FATURA_CARTAO'
        ) {
          learnEntries.push({ merchant: adjustedTx.merchant, expenseType: catOverride });
        }

        // Aplica link cross-project se solicitado — liquida a parcela da fatura
        // (current) sobre a parcela correspondente do alvo, com o valor real.
        if (d?.action === 'link' && d.linkToExpenseId && result.expenseId) {
          try {
            const parcelaIndex = Math.max(0, (adjustedTx.installmentCurrent ?? 1) - 1);
            await this.linkToExpense(tenantId, projectId, result.expenseId, d.linkToExpenseId, {
              parcelaIndex,
              realValor: adjustedTx.amountCents,
            }, requester);
            linked++;
            setOutcome(tx.externalId, result.settled ? CARD_IMPORT_LINE_OUTCOME.REUSED : CARD_IMPORT_LINE_OUTCOME.CREATED, true);
          } catch (linkErr) {
            console.warn(`[credit-card-import] link failed for ${tx.externalId.slice(0, 8)}:`, (linkErr as Error).message);
          }
        }
      } catch (err) {
        if (isDedupeStrongUniqueViolation(err)) {
          raceDuplicated++;
          setOutcome(tx.externalId, CARD_IMPORT_LINE_OUTCOME.DUPLICATED);
          continue;
        }
        skipped++;
        setOutcome(tx.externalId, CARD_IMPORT_LINE_OUTCOME.ERROR);
        console.warn(`[credit-card-import] tx skipped (${tx.externalId.slice(0, 8)}):`, (err as Error).message);
      }
    }

    const {
      learned: rulesLearned,
      skippedNoMapping: rulesSkippedNoMapping,
      failed: rulesLearnFailed,
    } = await this.merchantClassifier.learnFromImportOverrides(learnEntries, tenantId);

    const possibleIds = new Set(possibleDuplicates.map((pd) => pd.externalId));
    const lineResults: CardImportLineResult[] = parsed.transactions.map((t) => {
      const done = outcomes.get(t.externalId);
      if (done) return { externalId: t.externalId, ...done };
      let outcome: CardImportLineResult['outcome'];
      if (selected && !selected.has(t.externalId)) outcome = CARD_IMPORT_LINE_OUTCOME.NOT_SELECTED;
      else if (existingIds.has(t.externalId)) outcome = CARD_IMPORT_LINE_OUTCOME.DUPLICATED;
      else if (decisionByExt.get(t.externalId)?.action === 'skip') outcome = CARD_IMPORT_LINE_OUTCOME.SKIPPED;
      else if (possibleIds.has(t.externalId)) outcome = CARD_IMPORT_LINE_OUTCOME.POSSIBLE_DUPLICATE;
      else outcome = CARD_IMPORT_LINE_OUTCOME.ERROR;
      return { externalId: t.externalId, outcome };
    });

    await this.prisma.creditCardStatementImport.update({
      where: { id: importRecord.id },
      data: {
        inserted,
        // `skipped` do registro (sem DDL) também guarda o que ficou pendente/fora da rodada.
        skipped: skipped + userSkipped + reviewRequired.length + notSelected,
        duplicated: duplicated + settled + raceDuplicated,
        message: [
          settled > 0 ? `${settled} parcela(s) já existente(s) reaproveitada(s), sem pagamento` : null,
          linked > 0 ? `${linked} vinculada(s) a planejado` : null,
          reviewRequired.length > 0 ? `${reviewRequired.length} compra(s) aguardando revisão` : null,
          notSelected > 0 ? `${notSelected} não selecionada(s)` : null,
        ].filter(Boolean).join(' · ') || null,
      },
    });

    return {
      importId: importRecord.id,
      source: parsed.source,
      periodLabel,
      totalAmountCents: parsed.totalAmountCents,
      total: parsed.transactions.length,
      inserted,
      duplicated: duplicated + raceDuplicated,
      duplicatedItems,
      possibleDuplicates,
      settled,
      skipped: skipped + userSkipped,
      reviewRequired,
      skippedItems,
      notSelected,
      lineResults,
      linked,
      rulesLearned,
      rulesSkippedNoMapping,
      rulesLearnFailed,
    };
  }

  // ─── Desfazer importação ─────────────────────────────────

  /**
   * Detalhe de um lote de importação: o que ele criou e o que será revertido se
   * for desfeito. Alimenta o preview de impacto do "Desfazer importação".
   *
   * Distingue linhas CRIADAS pelo lote (`createdAt >= importRecord.createdAt`) de
   * linhas ADOTADAS — despesas de série pré-existentes que só tiveram
   * `externalId/importId` carimbados na dedup (`createdAt < importRecord.createdAt`):
   * as primeiras serão soft-deletadas; as segundas só terão o carimbo removido.
   */
  /**
   * #569-fix (achado #3, security-tenant-lens SEC-1) — ACL de LEITURA no MESMO
   * padrão já endurecido em `BankAccountService.getImportDetail`: `requester`
   * obrigatório, e as contagens agregadas cross-project (`crossProjectSettlements`/
   * `rateioAllocations`) filtradas pela visibilidade do projeto ALVO
   * (`targetExpenseId`) — nunca reveladas para quem não tem permissão de ver
   * aquele projeto.
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

  private async countCrossProjectRowsVisibleTo(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    model: { findMany: (args: any) => Promise<Array<{ targetExpenseId: string }>> },
    tenantId: string,
    sourceExpenseIds: string[],
    requester: RateioRequester,
  ): Promise<number> {
    const rows = await model.findMany({
      where: { sourceExpenseId: { in: sourceExpenseIds } },
      select: { targetExpenseId: true },
    });
    if (rows.length === 0) return 0;
    const targetIds = Array.from(new Set(rows.map((r) => r.targetExpenseId)));
    const targets = await this.prisma.expense.findMany({
      where: { id: { in: targetIds } },
      select: { id: true, project: { select: { id: true, type: true, tenantId: true, deletedAt: true } } },
    });
    const visibleTargetIds = new Set(
      targets
        .filter(
          (t) =>
            t.project &&
            t.project.tenantId === tenantId &&
            t.project.deletedAt === null &&
            this.canRequesterSeeProject(requester, t.project),
        )
        .map((t) => t.id),
    );
    return rows.filter((r) => visibleTargetIds.has(r.targetExpenseId)).length;
  }

  async getImportDetail(
    tenantId: string,
    projectId: string,
    cardId: string,
    importId: string,
    requester: RateioRequester,
  ) {
    assertRateioRequester(requester, new NotFoundException('Importação não encontrada'));
    const card = await this.findCard(tenantId, projectId, cardId);
    const importRecord = await this.prisma.creditCardStatementImport.findFirst({
      where: { id: importId, tenantId, cardId: card.id },
    });
    if (!importRecord) throw new NotFoundException('Importação não encontrada');

    const created = await this.prisma.expense.findMany({
      where: { tenantId, importId, deletedAt: null, createdAt: { gte: importRecord.createdAt } },
      select: { id: true, titulo: true, valorTotal: true, status: true, linkedExpenseId: true, documentedSchedule: true },
      orderBy: { createdAt: 'asc' },
    });
    const adoptedCount = await this.prisma.expense.count({
      where: { tenantId, importId, deletedAt: null, createdAt: { lt: importRecord.createdAt } },
    });
    const createdIds = created.map((e) => e.id);
    const cashFlowEntries = createdIds.length
      ? await this.prisma.cashFlowEntry.count({ where: { expenseId: { in: createdIds }, deletedAt: null } })
      : 0;
    const settlements = createdIds.length
      ? await this.countCrossProjectRowsVisibleTo(
          this.prisma.crossProjectSettlement,
          tenantId,
          createdIds,
          requester,
        )
      : 0;
    const rateios = createdIds.length
      ? await this.countCrossProjectRowsVisibleTo(
          this.prisma.rateioAllocation,
          tenantId,
          createdIds,
          requester,
        )
      : 0;

    return {
      importId: importRecord.id,
      periodLabel: importRecord.periodLabel,
      fileName: importRecord.fileName,
      createdAt: importRecord.createdAt,
      alreadyUndone: importRecord.deletedAt != null,
      totalAmountCents: created.reduce((s, e) => s + e.valorTotal, 0),
      impact: {
        expenses: created.length,
        cashFlowEntries,
        adoptedExpenses: adoptedCount,
        crossProjectSettlements: settlements,
        rateioAllocations: rateios,
        crossProjectLinks: settlements + rateios,
      },
      expenses: created.map((e) => ({
        id: e.id, titulo: e.titulo, valorTotal: e.valorTotal, status: e.status,
        linked: e.linkedExpenseId != null,
        documentedSchedule: e.documentedSchedule,
      })),
    };
  }

  /**
   * Desfaz um lote de importação de fatura de cartão. Transacional e idempotente:
   *  - reverte vínculos cross-project (conciliação por parcela ou rateio) para não
   *    deixar o alvo de outro projeto órfão apontando para uma fonte removida;
   *  - soft-delete de todas as despesas criadas pelo lote + suas entradas de caixa;
   *  - remove o carimbo (`externalId/importId`) das despesas de série apenas
   *    ADOTADAS na dedup (não as apaga — não foram criadas por este lote);
   *  - soft-delete do próprio registro de importação.
   *
   * Idempotente: desfazer um lote já desfeito retorna `alreadyUndone` sem efeito.
   */
  async undoImport(
    tenantId: string,
    projectId: string,
    cardId: string,
    importId: string,
    requester: RateioRequester,
  ) {
    assertRateioRequester(requester, new NotFoundException('Importação não encontrada'));
    const card = await this.findCard(tenantId, projectId, cardId);
    const importRecord = await this.prisma.creditCardStatementImport.findFirst({
      where: { id: importId, tenantId, cardId: card.id, deletedAt: { not: undefined } },
    });
    if (!importRecord) throw new NotFoundException('Importação não encontrada');
    if (importRecord.deletedAt) {
      return { ok: true, alreadyUndone: true, removedExpenses: 0, revertedSettlements: 0, unstamped: 0 };
    }

    const result = await this.prisma.$transaction(async (tx) => {
      await reserveRefundWriter(tx, tenantId);
      const locked = await tx.$executeRaw`
        UPDATE credit_cards SET id = id WHERE id = ${card.id}
          AND tenant_id = ${tenantId} AND project_id = ${projectId} AND deleted_at IS NULL
      `;
      if (locked !== 1) throw new NotFoundException('Cartão não encontrado');
      const currentImport = await tx.creditCardStatementImport.findFirst({
        where: { id: importId, tenantId, cardId: card.id, deletedAt: { not: undefined } },
      });
      if (!currentImport) throw new ConflictException('Importação indisponível');
      if (currentImport.deletedAt) return { alreadyUndone: true, removedExpenses: 0, revertedSettlements: 0, unstamped: 0 };
      const created = await tx.expense.findMany({
        where: { tenantId, importId, deletedAt: null, createdAt: { gte: currentImport.createdAt } },
        select: { id: true },
      });
      const adopted = await tx.expense.findMany({
        where: { tenantId, importId, deletedAt: null, createdAt: { lt: currentImport.createdAt } },
        select: { id: true },
      });
      const createdIds = created.map((e) => e.id);
      const now = new Date();
      const refundEdges = await tx.rateioAllocation.findMany({ where: {
        tenantId, isRefundCredit: true, source: { tenantId, importId },
      } });
      if (refundEdges.length) {
        const actor = await currentInlineRequester(tx, tenantId, requester);
        for (const edge of refundEdges) await cleanupRefundPurpose(tx, tenantId, edge.sourceExpenseId, actor);
      }

      await this.conciliacao.assertCanReverseSources(
        tx,
        { tenantId, sourceExpenseIds: createdIds },
        requester,
      );

      // 1) Soft-delete das entradas de caixa e das despesas criadas pelo lote.
      //    (Feito ANTES da reversão de vínculos para que uma falha na reversão
      //    faça o rollback destas deleções — garantia de atomicidade.)
      if (createdIds.length) {
        await tx.cashFlowEntry.updateMany({
          where: { expenseId: { in: createdIds }, deletedAt: null },
          data: { deletedAt: now },
        });
        await tx.expense.updateMany({
          where: { id: { in: createdIds }, deletedAt: null },
          data: { deletedAt: now },
        });
      }

      // 2) Reverte vínculos cross-project de cada fonte (restaura o alvo e apaga
      //    CrossProjectSettlement/RateioAllocation — sem órfão).
      let revertedSettlements = refundEdges.length;
      for (const id of createdIds) {
        const res = await this.conciliacao.reverseSourceLinks(
          tx,
          { tenantId, sourceExpenseId: id },
          requester,
        );
        if (res.mode !== 'none') revertedSettlements += res.targets.length;
      }

      // 3) Despesas apenas ADOTADAS na dedup: remove o carimbo, não apaga.
      for (const a of adopted) {
        await tx.expense.update({ where: { id: a.id }, data: { importId: null, externalId: null } });
      }

      // 4) Soft-delete do registro de importação.
      await tx.creditCardStatementImport.update({ where: { id: importId }, data: { deletedAt: now } });

      return { alreadyUndone: false, removedExpenses: createdIds.length, revertedSettlements, unstamped: adopted.length };
    }).catch(rethrowRefundWriteConflict);

    return { ok: true, ...result };
  }

  // ─── Links cross-project ─────────────────────────────────

  /**
   * Lista transações importadas do cartão (no projeto PESSOAL) + sugestões
   * de match em despesas planejadas de outros projetos (REFORMA/CASA/CARRO).
   * Critério: mesmo tenant e projeto candidato dentro do escopo autorizado do
   * solicitante; valor ≈ (±5%), data ±10 dias, status PLANEJADO.
   */
  async suggestLinks(
    tenantId: string,
    projectId: string,
    cardId: string,
    requester: RateioRequester,
  ) {
    assertRateioRequester(requester);
    const card = await this.findCard(tenantId, projectId, cardId);

    const cardExpenses = await this.prisma.expense.findMany({
      where: {
        tenantId,
        projectId,
        cardLast4: card.last4,
        linkedExpenseId: null,
        deletedAt: null,
      },
      orderBy: { dataPagamento: 'desc' },
      take: 100,
    });

    if (cardExpenses.length === 0) return [];

    const { otherProjects, planned } = await this.prisma.$transaction(async (tx) => {
      // Candidato é Expense: exige o módulo `expenses` no projeto candidato —
      // `creditCards` do MESMO tipo não vale (#480 SEC-1).
      const scope = await resolveAccessibleProjectScope(
        tx,
        tenantId,
        requester.role,
        requester.allowedProjects,
        requester.allowedProjectTypes,
        requester.allowedModules ?? [],
        EXPENSE_MODULE,
      );
      const projects = await tx.project.findMany({
        where: {
          tenantId,
          id: {
            not: projectId,
            ...(scope !== null ? { in: scope } : {}),
          },
          deletedAt: null,
        },
        select: { id: true, name: true, type: true },
      });
      const projectIds = projects.map((project) => project.id);
      const expenses = projectIds.length > 0
        ? await tx.expense.findMany({
            where: {
              tenantId,
              projectId: { in: projectIds },
              OR: [
                { status: 'PLANEJADO' },
                { status: 'PAGO', quantidadeParcela: { gt: 1 } },
              ],
              deletedAt: null,
            },
            take: 500,
            orderBy: { dataInicioParcela: 'desc' },
          })
        : [];
      return { otherProjects: projects, planned: expenses };
    });
    if (otherProjects.length === 0) {
      return cardExpenses.map((e) => ({ expense: serializeExpense(e), suggestions: [] }));
    }

    const projectById = new Map(otherProjects.map((p) => [p.id, p]));

    return cardExpenses.map((e) => {
      const baseDate = e.dataPagamento ?? e.dataInicioParcela ?? e.createdAt;
      const minDate = new Date(baseDate); minDate.setUTCDate(minDate.getUTCDate() - 10);
      const maxDate = new Date(baseDate); maxDate.setUTCDate(maxDate.getUTCDate() + 10);
      const tolerance = Math.max(100, Math.round(e.valorTotal * 0.05));

      const matches = planned
        .map((p) => {
          const slices = buildStoredExpenseInstallments(p);
          const fallbackDate = p.dataPagamento ?? p.dataInicioParcela ?? p.createdAt;
          const isInstallment = !isSinglePaymentForm(p.formaPagamento);
          const candidates = isInstallment
            ? slices.map((s, idx) => ({ idx, value: s.valor, date: s.data }))
            : [{ idx: -1, value: p.valorTotal, date: fallbackDate }];
          const valid = candidates.filter((c) => {
            if (Math.abs(c.value - e.valorTotal) > tolerance) return false;
            return c.date >= minDate && c.date <= maxDate;
          });
          if (valid.length === 0) return null;
          const best = valid.sort((a, b) => {
            const deltaA = Math.abs(a.value - e.valorTotal);
            const deltaB = Math.abs(b.value - e.valorTotal);
            if (deltaA !== deltaB) return deltaA - deltaB;
            return Math.abs(a.date.getTime() - baseDate.getTime()) - Math.abs(b.date.getTime() - baseDate.getTime());
          })[0];
          return {
            expenseId: p.id,
            projectId: p.projectId,
            projectName: projectById.get(p.projectId)?.name ?? '',
            projectType: projectById.get(p.projectId)?.type ?? '',
            titulo: p.titulo,
            fornecedor: p.fornecedor,
            valor: best.value,
            data: best.date.toISOString(),
            deltaCents: e.valorTotal - best.value,
            installmentCurrent: isInstallment && best.idx >= 0 ? best.idx + 1 : null,
            installmentTotal: isInstallment ? slices.length : null,
          };
        })
        .filter((m): m is NonNullable<typeof m> => !!m)
        .sort((a, b) => Math.abs(a.deltaCents) - Math.abs(b.deltaCents))
        .slice(0, 5);

      return { expense: serializeExpense(e), suggestions: matches };
    });
  }

  /**
   * Vincula uma despesa importada (do cartão, no PESSOAL) a UMA parcela de uma
   * despesa planejada em outro projeto (REFORMA/CASA/CARRO).
   *
   * Não-destrutivo / reversível (Conciliação por parcela):
   *  - liquida apenas a parcela `parcelaIndex` do alvo com o valor REAL da fatura;
   *  - guarda snapshot do planejado (em CrossProjectSettlement) p/ unlink;
   *  - a fonte recebe `linkedExpenseId` → alvo (dedupe no consolidado PESSOAL);
   *  - `Expense.valorTotal` do alvo permanece o planejado (valor efetivo é derivado).
   *
   * O requester é encaminhado ao preflight transacional do alvo.
   */
  async linkToExpense(
    tenantId: string,
    projectId: string,
    cardExpenseId: string,
    targetExpenseId: string,
    opts: { parcelaIndex?: number; realValor?: number } | undefined,
    requester: RateioRequester,
  ) {
    assertRateioRequester(requester);
    const source = await this.prisma.expense.findFirst({
      where: { id: cardExpenseId, tenantId, projectId, deletedAt: null },
    });
    if (!source) throw new NotFoundException('Despesa importada não encontrada');
    if (!source.cardLast4) throw new BadRequestException('Despesa não foi importada de cartão');

    const paymentDate = source.dataPagamento ?? source.dataInicioParcela ?? source.createdAt;
    const parcelaIndex = Math.max(0, opts?.parcelaIndex ?? 0);
    const realValor = opts?.realValor ?? source.valorTotal;

    await this.prisma.$transaction(async (tx) => {
      await this.conciliacao.settleTargetParcela(
        tx,
        {
          tenantId,
          sourceExpenseId: source.id,
          targetExpenseId,
          parcelaIndex,
          realValor,
        },
        requester,
      );
    });

    return { ok: true, sourceId: source.id, targetId: targetExpenseId, parcelaIndex, paymentDate };
  }

  /**
   * Desfaz o vínculo entre uma despesa importada e o alvo, restaurando o
   * planejado de TODAS as parcelas que esta fonte havia liquidado (reversível).
   */
  async unlinkExpense(
    tenantId: string,
    projectId: string,
    cardExpenseId: string,
    requester: RateioRequester,
  ) {
    assertRateioRequester(requester, new NotFoundException('Despesa não encontrada'));
    const source = await this.prisma.expense.findFirst({
      where: { id: cardExpenseId, tenantId, projectId, deletedAt: null },
    });
    if (!source) throw new NotFoundException('Despesa não encontrada');

    await this.prisma.$transaction(async (tx) => {
      await assertNoRefundPurpose(tx, tenantId, [cardExpenseId]);
      await this.conciliacao.reverseSourceLinks(
        tx,
        { tenantId, sourceExpenseId: source.id },
        requester,
      );
    });
    return { ok: true };
  }

  // ─── helpers ─────────────────────────────────────────────

  private async ensureProject(tenantId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, tenantId, deletedAt: null },
    });
    if (!project) throw new NotFoundException('Projeto não encontrado');
    return project;
  }

  private async findCard(tenantId: string, projectId: string, id: string) {
    const card = await this.prisma.creditCard.findFirst({
      where: { id, tenantId, projectId, deletedAt: null },
    });
    if (!card) throw new NotFoundException('Cartão não encontrado');
    return card;
  }

  private async findExistingExternalIds(
    tenantId: string,
    projectId: string,
    ids: string[],
  ): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    // $queryRaw (não findMany) de propósito: findMany passa pelo middleware de
    // soft-delete (prisma.service.ts) que força deletedAt=null, então uma linha
    // que o usuário excluiu deixaria de "existir" pro importador e reimportar a
    // mesma fatura a recriaria. O check de duplicidade precisa enxergar
    // deletadas também — exclusão é definitiva, não "esqueça que já importei"
    // (mesmo padrão do lado Conta, ver bank-account.service.ts). Fatura de
    // cartão só gera Expense (nunca Receipt), então não há tabela irmã aqui.
    const rows = await this.prisma.$queryRaw<{ external_id: string }[]>`
      SELECT external_id FROM expenses
      WHERE tenant_id = ${tenantId} AND project_id = ${projectId}
        AND external_id IN (${Prisma.join(ids)})
    `;
    const set = new Set<string>();
    for (const r of rows) if (r.external_id) set.add(r.external_id);
    return set;
  }

  /**
   * DEDUP de série parcelada: se já existe uma Expense DESTA série (mesma
   * seriesKey) com a ocorrência `current/total`, a reimportação não cria
   * duplicata nem marca a parcela como PAGA. Apenas vincula externalId/importId
   * se faltarem. Devolve `null` quando não há o que reaproveitar.
   */
  private async reuseExistingSeries(
    db: Prisma.TransactionClient,
    tenantId: string,
    projectId: string,
    card: { last4: string },
    tx: NormalizedTx,
    importId: string,
    seriesKey: string,
    current: number,
    total: number,
    isSibling: ((externalId: string) => boolean) | undefined,
    purchase: { seriesKey: string | null; externalId: string | null; dedupeKeyStrong: string | null },
    documentaryCycle?: DocumentaryCycle,
  ): Promise<CreateFromTransactionResult | typeof SERIES_AMBIGUOUS | null> {
    const roots = await db.expense.findMany({
      // cardLast4 evita colisão entre cartões diferentes do mesmo tenant
      where: { tenantId, projectId, seriesKey, cardLast4: card.last4, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { id: true, externalId: true, dedupeKeyStrong: true, deletedAt: true, seriesKey: true },
    });
    // Raiz criada por OUTRA linha do mesmo documento e ocorrência não é desta linha.
    const candidates = roots.filter((row) => !excludableSibling(row, purchase, isSibling));
    // Duas ou mais raízes candidatas: escolher a primeira seria arbitrário. Nada é escrito aqui.
    if (candidates.length >= 2) return SERIES_AMBIGUOUS;
    const existing = candidates[0];
    if (!existing) return null;
    const anyEntry = await db.cashFlowEntry.findFirst({
      where: {
        tenantId,
        projectId,
        expenseId: existing.id,
        parcela: `${current}/${total}`,
        deletedAt: null,
      },
    });
    if (!anyEntry) return null;
    if (documentaryCycle) throw new ConflictException('A ocorrência existente exige correção documental assistida');
    // Parcela desta série já existe — dedup. Preserva rastreabilidade.
    if (!existing.externalId) {
      await db.expense.update({
        where: { id: existing.id },
        data: { externalId: tx.externalId, importId, ...dedupeColumns(tx) },
      });
    }
    return { inserted: false, settled: true, expenseId: existing.id };
  }

  private async createExpenseFromTransaction(
    db: Prisma.TransactionClient,
    tenantId: string,
    projectId: string,
    card: { id: string; nickname: string; last4: string; institution: string },
    tx: NormalizedTx,
    importId: string,
    categoryOverride?: string,
    createdByUserId: string | null = null,
    invoiceDueMonth?: string,
    documentaryCycle?: DocumentaryCycle,
    reviewFingerprint?: string,
    occurrences?: OccurrenceGroups,
  ): Promise<CreateFromTransactionResult> {
    if (!Number.isSafeInteger(tx.amountCents) || Math.abs(tx.amountCents) > CREDIT_CARD_IMPORT_MAX_AMOUNT_CENTS || tx.amountCents === 0) {
      throw new BadRequestException('Valor de importação inválido');
    }
    if (documentaryCycle && !createdByUserId) throw new BadRequestException('Autoria documental obrigatória');
    if (tx.amountCents < 0) {
      // Pagamento da fatura ANTERIOR aparece nas faturas Itaú como linha negativa
      // ("PAGAMENTO EFETUADO", "Pagamento PIX"). Esses NÃO viram lançamento — a
      // própria liquidação da fatura é o que paga. Filtramos por texto.
      if (
        classifyCardImportLine({ documentaryText: tx.merchant }) ===
        CARD_IMPORT_LINE_CLASSIFICATION.IGNORE_INVOICE_PAYMENT
      )
        return IGNORED_RESULT;
      // Estorno/crédito real (refund, desconto, ajuste). Cria Expense com valor
      // NEGATIVO para abater do total da fatura — soma corretamente no cashflow.
      const manualExpenseType =
        categoryOverride ? null : await this.merchantClassifier.manualExpenseType(tx.merchant, tenantId);
      const expenseType =
        categoryOverride || manualExpenseType || (PESSOAL_CATEGORY_MAP[categorize(tx.merchant)] ?? 'OUTROS');
      const tituloEst = `Estorno: ${tx.merchant}`.slice(0, 200);
      const expEst = await db.expense.create({
        data: {
          tenantId,
          projectId,
          tipoDespesa: expenseType,
          titulo: tituloEst,
          fornecedor: tx.merchant.slice(0, 200),
          valor: tx.amountCents,                  // negativo
          quantidade: 1,
          valorTotal: tx.amountCents,             // negativo
          formaPagamento: 'A_VISTA',
          dataPagamento: tx.date,
          status: 'PAGO',
          importId,
          externalId: tx.externalId,
          ...dedupeColumns(tx),
          cardLast4: card.last4,
          createdByUserId,
        },
      });
      await db.cashFlowEntry.create({
        data: {
          tenantId,
          projectId,
          expenseId: expEst.id,
          valor: tx.amountCents,                  // negativo
          tipo: 'DESPESA',
          categoria: ExpenseTypeLabels[expenseType as keyof typeof ExpenseTypeLabels] ?? expenseType,
          subcategoria: card.nickname,
          formaPagamento: 'CARTAO_CREDITO',
          data: tx.date,
          status: 'PAGO',
          invoiceDueMonth: documentaryCycle?.invoiceDueMonth,
        },
      });
      if (documentaryCycle && createdByUserId) {
        await this.recordDocumentaryCycle(db, expEst, card.id, createdByUserId, documentaryCycle);
      }
      return { inserted: true, settled: false, expenseId: expEst.id };
    }
    if (tx.amountCents === 0) {
      throw new Error('valor-zero');
    }

    const manualExpenseType =
      categoryOverride ? null : await this.merchantClassifier.manualExpenseType(tx.merchant, tenantId);
    const expenseType =
      categoryOverride || manualExpenseType || (PESSOAL_CATEGORY_MAP[categorize(tx.merchant)] ?? 'OUTROS');
    const { total, current, seriesKey, purchase, reviewLine } =
      importPurchaseOf(card.id, projectId, tx, invoiceDueMonth, documentaryCycle);
    const remainingAfterCurrent = Math.max(0, total - current);
    // Parcelas que ESTA despesa representa: da atual até a última. As anteriores
    // já foram cobradas em faturas passadas e (se importadas) já existem — contar
    // a série inteira aqui inventaria dinheiro, porque o valorTotal passaria a
    // somar parcelas para as quais não se gera nenhum cashFlowEntry.
    const remainingCount = remainingAfterCurrent + 1;

    // ÂNCORA DA LINHA. `tx.date` significa coisas diferentes por emissor:
    //  - Nubank: a data DAQUELA parcela (muda a cada fatura) → já é a âncora;
    //  - Itaú: a data da COMPRA, repetida em toda parcela ("Parcela 2 de 10"
    //    continua 22/06) → ancorar por ela joga a linha meses para trás.
    //
    // Vale para TODA linha da fatura, não só para parcelas do meio da série: se
    // a fatura vence em setembro, tudo que ela cobra sai do caixa em setembro —
    // inclusive a compra à vista de 21/07 e a "Parcela 1 de 10" da mesma data.
    // Restringir a `current > 1` deixava justamente as compras recentes (as que
    // aparecem pela primeira vez) na fatura do mês errado.
    //
    // Só reancoramos para FRENTE: se a data da compra é posterior ao vencimento
    // (fatura em aberto, compra já do próximo ciclo), a data original é a
    // melhor informação disponível e é preservada.
    const anchorDate =
      !documentaryCycle && invoiceDueMonth && monthKeyOfUtc(tx.date) < invoiceDueMonth
        ? anchorToMonth(tx.date, invoiceDueMonth)
        : tx.date;

    // SERIES KEY: identifica de forma estável uma compra parcelada
    // (cartão + merchant normalizado + valor da parcela + total). Permite casar
    // parcelas futuras mesmo que a data varie entre faturas.

    // 1) DEDUP de série parcelada: se já existe uma Expense desta série (criada
    //    a partir de uma fatura anterior, com todas as parcelas geradas como
    //    PLANEJADO), a reimportação de uma fatura seguinte NÃO cria duplicata nem
    //    marca a parcela como PAGA. No modelo de caixa real, quem liquida a
    //    parcela é o PAGAMENTO da fatura no extrato bancário (settleCardInvoice),
    //    não o reimport. Apenas vinculamos o externalId/importId se faltarem.
    // A decisão de REVISÃO é avaliada ANTES de qualquer reuso/carimbo de série:
    // uma decisão vencida (ou negada) não pode ter efeito nenhum sobre o estado.
    // O mesmo predicado de irmandade vale para reuso, classificação e fingerprint (e a prévia).
    const isSibling = occurrences ? siblingPredicate(occurrences, reviewLine) : undefined;
    if (reviewFingerprint) {
      const admission = await classifyCardImport(db, tenantId, purchase, isSibling);
      if (admission.kind === 'BLOCKED' && !admission.sameSeries) return BLOCKED_RESULT;
      if (admission.kind === 'BLOCKED') return reviewResult(reviewItem(reviewLine, CARD_IMPORT_REVIEW_REASON.STALE, null));
      if (admission.kind === 'CLEAR') return reviewResult(reviewItem(reviewLine, CARD_IMPORT_REVIEW_REASON.STALE, null));
      if (reviewFingerprintOf(reviewLine, admission.roots) !== reviewFingerprint) {
        return reviewResult(reviewItem(reviewLine, CARD_IMPORT_REVIEW_REASON.STALE, admission));
      }
    } else {
      const reused = seriesKey
        ? await this.reuseExistingSeries(db, tenantId, projectId, card, tx, importId, seriesKey, current, total, isSibling, purchase, documentaryCycle)
        : null;
      if (reused && reused !== SERIES_AMBIGUOUS) return reused;
      const admission = await classifyCardImport(db, tenantId, purchase, isSibling);
      // Série ambígua (>=2 raízes candidatas) só pode virar REVISÃO; se o classificador
      // discordar, nunca cria: bloqueia.
      if (reused === SERIES_AMBIGUOUS && admission.kind !== 'REVIEW') return BLOCKED_RESULT;
      if (admission.kind === 'BLOCKED') return BLOCKED_RESULT;
      if (admission.kind === 'REVIEW') {
        return reviewResult(reviewItem(reviewLine, CARD_IMPORT_REVIEW_REASON.REQUIRED, admission));
      }
    }

    // 2) Caminho normal: cria Expense + cashFlowEntries — TODAS as parcelas
    //    PLANEJADO. No modelo de caixa real, uma compra de cartão só vira PAGA
    //    quando o pagamento da respectiva fatura aparece no extrato bancário
    //    (settleCardInvoice). Até lá, é uma saída planejada.
    const installmentLabel = total > 1 ? `${current}/${total}` : null;
    const titulo = `${tx.merchant}${installmentLabel ? ` (${installmentLabel})` : ''}`.slice(0, 200);

    // O valor da linha (tx.amountCents) é o valor de UMA parcela. O total desta
    // despesa é parcela × parcelas RESTANTES (da atual à última) — não × total da
    // compra: quando a fatura começa no meio da série ("2 de 10"), as parcelas
    // 1..1 já foram cobradas antes e não pertencem a este registro.
    const valorCompra = tx.amountCents * remainingCount;
    if (!Number.isSafeInteger(valorCompra) || valorCompra > CREDIT_CARD_IMPORT_MAX_AMOUNT_CENTS) {
      throw new BadRequestException('Total de importação inválido');
    }

    const expense = await db.expense.create({
      data: {
        tenantId,
        projectId,
        tipoDespesa: expenseType,
        titulo,
        fornecedor: tx.merchant.slice(0, 200),
        valor: valorCompra,
        quantidade: 1,
        valorTotal: valorCompra,
        formaPagamento: remainingCount > 1 ? 'PARCELADO' : 'A_VISTA',
        dataPagamento: anchorDate,
        quantidadeParcela: remainingCount > 1 ? remainingCount : null,
        dataInicioParcela: remainingCount > 1 ? anchorDate : null,
        // Competência: preserva a data REAL da compra mesmo quando o caixa da
        // parcela foi ancorado no mês da fatura.
        dataCompra: tx.date,
        status: 'PLANEJADO',
        importId,
        externalId: tx.externalId,
        ...dedupeColumns(tx),
        seriesKey,
        cardLast4: card.last4,
        createdByUserId,
      },
    });

    const baseCashFlow = {
      tenantId,
      projectId,
      expenseId: expense.id,
      valor: tx.amountCents,
      tipo: 'DESPESA' as const,
      categoria: ExpenseTypeLabels[expenseType as keyof typeof ExpenseTypeLabels] ?? expenseType,
      subcategoria: card.nickname,
      formaPagamento: 'CARTAO_CREDITO',
    };

    // Parcela atual — PLANEJADO (liquida no pagamento da fatura)
    await db.cashFlowEntry.create({
      data: { ...baseCashFlow, data: anchorDate, status: 'PLANEJADO', parcela: installmentLabel, invoiceDueMonth: documentaryCycle?.invoiceDueMonth },
    });

    // Parcelas futuras — PLANEJADO, uma por mês subsequente
    for (let i = 1; i <= remainingAfterCurrent; i++) {
      const futureDate = addMonths(anchorDate, i);
      await db.cashFlowEntry.create({
        data: {
          ...baseCashFlow,
          data: futureDate,
          status: 'PLANEJADO',
          parcela: `${current + i}/${total}`,
          // O ciclo documental do documento é o mês da parcela atual; cada
          // futura avança um mês por posição, não pelo número impresso.
          invoiceDueMonth: documentaryCycle
            ? addMonthsToMonthKey(documentaryCycle.invoiceDueMonth, i)
            : undefined,
        },
      });
    }
    if (documentaryCycle && createdByUserId) {
      await this.recordDocumentaryCycle(db, expense, card.id, createdByUserId, documentaryCycle);
    }

    return { inserted: true, settled: false, expenseId: expense.id };
  }

  private async recordDocumentaryCycle(
    db: Prisma.TransactionClient,
    expense: { id: string; tenantId: string; projectId: string; importId: string | null; externalId: string | null },
    cardId: string,
    actorUserId: string,
    cycle: DocumentaryCycle,
  ): Promise<void> {
    if (!expense.importId || !expense.externalId) throw new ConflictException('Origem documental ausente');
    const entries = await db.cashFlowEntry.findMany({
      where: { tenantId: expense.tenantId, expenseId: expense.id, deletedAt: null },
      orderBy: [{ data: 'asc' }, { id: 'asc' }],
    });
    const recordedAt = new Date().toISOString();
    const stored: StoredSourceScheduleV1 = {
      version: 1, kind: 'source', tenantId: expense.tenantId,
      sourceExpenseId: expense.id, sourceProjectId: expense.projectId,
      cardId, importId: expense.importId, externalId: expense.externalId,
      recordedByUserId: actorUserId, recordedAt, projections: [], lastOperation: null,
      occurrences: entries.map((entry, index) => ({
        index, parcela: entry.parcela, valor: entry.valor, data: entry.data.toISOString().slice(0, 10),
        invoiceDueMonth: entry.invoiceDueMonth, amountEvidence: null,
        cycleEvidence: index === 0
          ? { ...cycle.evidence, actorUserId, recordedAt }
          : {
              evidenceKind: DERIVED_SEQUENTIAL,
              derivedFrom: { index: 0, invoiceDueMonth: cycle.invoiceDueMonth },
              offset: index,
              actorUserId,
              recordedAt,
            },
      })),
    };
    const raw = JSON.stringify(stored);
    parseStoredExpenseSchedule(raw);
    await db.expense.update({ where: { id: expense.id }, data: { documentedSchedule: raw } });
  }
}

/**
 * Ano-mês (YYYY-MM) de uma data, em UTC.
 */
function monthKeyOfUtc(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Reposiciona uma data no mês `YYYY-MM` informado, preservando o dia (com clamp
 * para o último dia em meses curtos).
 */
function anchorToMonth(base: Date, yearMonth: string): Date {
  const m = /^(\d{4})-(\d{2})$/.exec(yearMonth);
  if (!m) return base;
  const year = Number(m[1]);
  const monthIdx = Number(m[2]) - 1;
  const day = base.getUTCDate();
  const lastDay = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, monthIdx, Math.min(day, lastDay)));
}

/**
 * Adiciona N meses a uma data em UTC, preservando o dia (com clamp para
 * o último dia do mês quando necessário).
 */
function addMonths(base: Date, months: number): Date {
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth();
  const d = base.getUTCDate();
  const target = new Date(Date.UTC(y, m + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target;
}

function serializeExpense(e: {
  id: string; titulo: string | null; fornecedor: string | null;
  valorTotal: number; dataPagamento: Date | null; dataInicioParcela: Date | null;
  createdAt: Date; status: string; cardLast4: string | null;
  formaPagamento: string; quantidadeParcela: number | null;
  linkedExpenseId: string | null; tipoDespesa: string; seriesKey: string | null;
  documentedSchedule?: string | null;
}) {
  return {
    id: e.id,
    titulo: e.titulo,
    fornecedor: e.fornecedor,
    valor: e.valorTotal,
    valorTotal: e.valorTotal,
    data: (e.dataPagamento ?? e.dataInicioParcela ?? e.createdAt).toISOString(),
    status: e.status,
    cardLast4: e.cardLast4,
    formaPagamento: e.formaPagamento,
    quantidadeParcela: e.quantidadeParcela,
    linkedExpenseId: e.linkedExpenseId,
    tipoDespesa: e.tipoDespesa,
    seriesKey: e.seriesKey,
    documentedSchedule: e.documentedSchedule,
  };
}
