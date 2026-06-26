import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ExpenseTypeLabels, NEUTRAL_EXPENSE_TYPES, buildInstallments, caixaMonthForCardPurchase } from '@reformaflow/domain';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';
import { CreateCreditCardDto, UpdateCreditCardDto } from './dto/credit-card.dto';
import { parseStatementBuffers, type SourceHint, type NormalizedTx, type ParseResult } from './parsers';

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

export interface ImportDecision {
  externalId: string;
  action?: 'create' | 'skip' | 'link';
  linkToExpenseId?: string;        // quando action='link'
  overrides?: {
    titulo?: string;
    valorCents?: number;
    category?: string;             // ExpenseType pessoal (ex.: 'MORADIA', 'ALIMENTACAO')
  };
}

@Injectable()
export class CreditCardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conciliacao: ConciliacaoService,
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
      },
    });

    const used = purchases.reduce((sum, expense) => {
      if (NEUTRAL_EXPENSE_TYPES.has(expense.tipoDespesa)) return sum;
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

  async createCard(tenantId: string, projectId: string, dto: CreateCreditCardDto) {
    await this.ensureProject(tenantId, projectId);
    const nickname = dto.nickname?.trim() || `${dto.brand} ****${dto.last4}`;
    return this.prisma.creditCard.create({
      data: { ...dto, nickname, tenantId, projectId },
    });
  }

  async updateCard(tenantId: string, projectId: string, id: string, dto: UpdateCreditCardDto) {
    await this.findCard(tenantId, projectId, id);
    const data: any = { ...dto };
    if (dto.nickname != null) {
      data.nickname = dto.nickname.trim() || undefined;
      if (!data.nickname) delete data.nickname;
    }
    await this.prisma.creditCard.update({ where: { id }, data });
    return this.findCard(tenantId, projectId, id);
  }

  async deleteCard(tenantId: string, projectId: string, id: string) {
    await this.findCard(tenantId, projectId, id);
    await this.prisma.creditCard.delete({ where: { id } });
    return { ok: true };
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
    password?: string,
  ) {
    const card = await this.findCard(tenantId, projectId, cardId);
    const buffers = toBuffers(fileContent);
    const parsed = await parseStatementBuffers(buffers, card.id, source, fileName, password);
    const existing = await this.findExistingExternalIds(
      tenantId,
      projectId,
      parsed.transactions.map((t) => t.externalId),
    );

    // Carrega despesas planejadas em outros projetos para cross-project match
    const otherProjects = await this.prisma.project.findMany({
      where: { tenantId, id: { not: projectId }, deletedAt: null },
      select: { id: true, name: true, type: true },
    });
    const projectById = new Map(otherProjects.map((p) => [p.id, p]));
    const planned = otherProjects.length > 0
      ? await this.prisma.expense.findMany({
          where: {
            tenantId,
            projectId: { in: otherProjects.map((p) => p.id) },
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

    function findMatches(tx: NormalizedTx) {
      if (planned.length === 0) return [];
      const txDate = tx.date;
      const minDate = new Date(txDate); minDate.setUTCDate(minDate.getUTCDate() - 10);
      const maxDate = new Date(txDate); maxDate.setUTCDate(maxDate.getUTCDate() + 10);
      const txCents = tx.amountCents;
      const tolerance = Math.max(100, Math.round(txCents * 0.05));
      const scored = planned
        .map((p) => {
          const slices = buildInstallments({
            valorTotal: p.valorTotal,
            formaPagamento: p.formaPagamento,
            dataPagamento: p.dataPagamento,
            quantidadeParcela: p.quantidadeParcela,
            dataInicioParcela: p.dataInicioParcela,
          });
          const fallbackDate = p.dataPagamento ?? p.dataInicioParcela ?? p.createdAt;
          const candidates = slices.length > 1
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
            installmentCurrent: slices.length > 1 && best.idx >= 0 ? best.idx + 1 : null,
            installmentTotal: slices.length > 1 ? slices.length : null,
          };
        })
        .filter((m): m is NonNullable<typeof m> => !!m)
        .sort((a, b) => Math.abs(a.deltaCents) - Math.abs(b.deltaCents));
      return scored.slice(0, 5);
    }

    const preview = parsed.transactions.map((tx) => ({
      ...tx,
      date: tx.date.toISOString().slice(0, 10),
      duplicate: existing.has(tx.externalId),
      suggestedCategory: PESSOAL_CATEGORY_MAP[categorize(tx.merchant)] ?? 'OUTROS',
      crossProjectMatches: findMatches(tx),
    }));

    const futureInstallments = (parsed.futureInstallments ?? []).map((tx) => ({
      ...tx,
      date: tx.date.toISOString().slice(0, 10),
      suggestedCategory: PESSOAL_CATEGORY_MAP[categorize(tx.merchant)] ?? 'OUTROS',
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
      futureInstallments,
    };
  }

  async commitImport(
    tenantId: string,
    projectId: string,
    cardId: string,
    fileContent: string | Buffer | Buffer[],
    fileName: string | undefined,
    source: SourceHint,
    periodLabelOverride?: string,
    password?: string,
    decisions?: ImportDecision[],
  ) {
    const card = await this.findCard(tenantId, projectId, cardId);
    const buffers = toBuffers(fileContent);
    const parsed = await parseStatementBuffers(buffers, card.id, source, fileName, password);
    const periodLabel = periodLabelOverride ?? parsed.periodLabel ?? new Date().toISOString().slice(0, 7);

    // Index decisions por externalId
    const decisionByExt = new Map<string, ImportDecision>();
    for (const d of decisions ?? []) {
      if (d?.externalId) decisionByExt.set(d.externalId, d);
    }

    const existingIds = await this.findExistingExternalIds(
      tenantId,
      projectId,
      parsed.transactions.map((t) => t.externalId),
    );

    // Filtra transações: pula as que tem decision=skip ou já existentes
    const toProcess = parsed.transactions.filter((t) => {
      const d = decisionByExt.get(t.externalId);
      if (d?.action === 'skip') return false;
      if (existingIds.has(t.externalId)) return false;
      return true;
    });
    const duplicated = parsed.transactions.length - toProcess.length - (decisions?.filter((d) => d?.action === 'skip').length ?? 0);
    const userSkipped = (decisions ?? []).filter((d) => d?.action === 'skip' && !existingIds.has(d.externalId)).length;

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
    for (const tx of toProcess) {
      const d = decisionByExt.get(tx.externalId);
      // Aplica overrides antes de criar
      const adjustedTx: NormalizedTx = {
        ...tx,
        merchant: d?.overrides?.titulo ?? tx.merchant,
        amountCents: d?.overrides?.valorCents ?? tx.amountCents,
      };
      try {
        const result = await this.createExpenseFromTransaction(
          tenantId,
          projectId,
          card,
          adjustedTx,
          importRecord.id,
          d?.overrides?.category,
        );
        if (result.settled) settled++;
        if (result.inserted) inserted++;

        // Aplica link cross-project se solicitado — liquida a parcela da fatura
        // (current) sobre a parcela correspondente do alvo, com o valor real.
        if (d?.action === 'link' && d.linkToExpenseId && result.expenseId) {
          try {
            const parcelaIndex = Math.max(0, (adjustedTx.installmentCurrent ?? 1) - 1);
            await this.linkToExpense(tenantId, projectId, result.expenseId, d.linkToExpenseId, {
              parcelaIndex,
              realValor: adjustedTx.amountCents,
            });
            linked++;
          } catch (linkErr) {
            console.warn(`[credit-card-import] link failed for ${tx.externalId.slice(0, 8)}:`, (linkErr as Error).message);
          }
        }
      } catch (err) {
        skipped++;
        console.warn(`[credit-card-import] tx skipped (${tx.externalId.slice(0, 8)}):`, (err as Error).message);
      }
    }

    await this.prisma.creditCardStatementImport.update({
      where: { id: importRecord.id },
      data: {
        inserted,
        skipped: skipped + userSkipped,
        duplicated: duplicated + settled,
        message: [
          settled > 0 ? `${settled} parcela(s) liquidada(s)` : null,
          linked > 0 ? `${linked} vinculada(s) a planejado` : null,
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
      duplicated,
      settled,
      skipped: skipped + userSkipped,
      linked,
    };
  }

  // ─── Links cross-project ─────────────────────────────────

  /**
   * Lista transações importadas do cartão (no projeto PESSOAL) + sugestões
   * de match em despesas planejadas de outros projetos (REFORMA/CASA/CARRO).
   * Critério: mesmo tenant, valor ≈ (±5%), data ±10 dias, status PLANEJADO.
   */
  async suggestLinks(tenantId: string, projectId: string, cardId: string) {
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

    const otherProjects = await this.prisma.project.findMany({
      where: { tenantId, id: { not: projectId }, deletedAt: null },
      select: { id: true, name: true, type: true },
    });
    if (otherProjects.length === 0) {
      return cardExpenses.map((e) => ({ expense: serializeExpense(e), suggestions: [] }));
    }

    const otherIds = otherProjects.map((p) => p.id);
    const planned = await this.prisma.expense.findMany({
      where: {
        tenantId,
        projectId: { in: otherIds },
        OR: [
          { status: 'PLANEJADO' },
          { status: 'PAGO', quantidadeParcela: { gt: 1 } },
        ],
        deletedAt: null,
      },
      take: 500,
      orderBy: { dataInicioParcela: 'desc' },
    });
    const projectById = new Map(otherProjects.map((p) => [p.id, p]));

    return cardExpenses.map((e) => {
      const baseDate = e.dataPagamento ?? e.dataInicioParcela ?? e.createdAt;
      const minDate = new Date(baseDate); minDate.setUTCDate(minDate.getUTCDate() - 10);
      const maxDate = new Date(baseDate); maxDate.setUTCDate(maxDate.getUTCDate() + 10);
      const tolerance = Math.max(100, Math.round(e.valorTotal * 0.05));

      const matches = planned
        .map((p) => {
          const slices = buildInstallments({
            valorTotal: p.valorTotal,
            formaPagamento: p.formaPagamento,
            dataPagamento: p.dataPagamento,
            quantidadeParcela: p.quantidadeParcela,
            dataInicioParcela: p.dataInicioParcela,
          });
          const fallbackDate = p.dataPagamento ?? p.dataInicioParcela ?? p.createdAt;
          const candidates = slices.length > 1
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
            installmentCurrent: slices.length > 1 && best.idx >= 0 ? best.idx + 1 : null,
            installmentTotal: slices.length > 1 ? slices.length : null,
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
   */
  async linkToExpense(
    tenantId: string,
    projectId: string,
    cardExpenseId: string,
    targetExpenseId: string,
    opts?: { parcelaIndex?: number; realValor?: number },
  ) {
    const source = await this.prisma.expense.findFirst({
      where: { id: cardExpenseId, tenantId, projectId, deletedAt: null },
    });
    if (!source) throw new NotFoundException('Despesa importada não encontrada');
    if (!source.cardLast4) throw new BadRequestException('Despesa não foi importada de cartão');

    const paymentDate = source.dataPagamento ?? source.dataInicioParcela ?? source.createdAt;
    const parcelaIndex = Math.max(0, opts?.parcelaIndex ?? 0);
    const realValor = opts?.realValor ?? source.valorTotal;

    await this.prisma.$transaction(async (tx) => {
      await this.conciliacao.settleTargetParcela(tx, {
        tenantId,
        sourceExpenseId: source.id,
        targetExpenseId,
        parcelaIndex,
        realValor,
      });
    });

    return { ok: true, sourceId: source.id, targetId: targetExpenseId, parcelaIndex, paymentDate };
  }

  /**
   * Desfaz o vínculo entre uma despesa importada e o alvo, restaurando o
   * planejado de TODAS as parcelas que esta fonte havia liquidado (reversível).
   */
  async unlinkExpense(tenantId: string, projectId: string, cardExpenseId: string) {
    const source = await this.prisma.expense.findFirst({
      where: { id: cardExpenseId, tenantId, projectId, deletedAt: null },
    });
    if (!source) throw new NotFoundException('Despesa não encontrada');
    if (!source.linkedExpenseId) return { ok: true, alreadyUnlinked: true };

    await this.prisma.$transaction(async (tx) => {
      await this.conciliacao.unsettleBySource(tx, { tenantId, sourceExpenseId: source.id });
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
    const rows = await this.prisma.expense.findMany({
      where: { tenantId, projectId, externalId: { in: ids }, deletedAt: null },
      select: { externalId: true },
    });
    return new Set(rows.map((r) => r.externalId).filter(Boolean) as string[]);
  }

  private async createExpenseFromTransaction(
    tenantId: string,
    projectId: string,
    card: { id: string; nickname: string; last4: string; institution: string },
    tx: NormalizedTx,
    importId: string,
    categoryOverride?: string,
  ): Promise<{ inserted: boolean; settled: boolean; expenseId?: string }> {
    if (tx.amountCents < 0) {
      // Pagamento da fatura ANTERIOR aparece nas faturas Itaú como linha negativa
      // ("PAGAMENTO EFETUADO", "Pagamento PIX"). Esses NÃO viram lançamento — a
      // própria liquidação da fatura é o que paga. Filtramos por texto.
      if (/PAGAMENTO\s+EFETUADO|PAGAMENTO\s+PIX|PGTO\s+FAT|FATURA\s+PAG/i.test(tx.merchant)) {
        throw new Error('pagamento-fatura-ignorado');
      }
      // Estorno/crédito real (refund, desconto, ajuste). Cria Expense com valor
      // NEGATIVO para abater do total da fatura — soma corretamente no cashflow.
      const expenseType = categoryOverride || (PESSOAL_CATEGORY_MAP[categorize(tx.merchant)] ?? 'OUTROS');
      const tituloEst = `Estorno: ${tx.merchant}`.slice(0, 200);
      const expEst = await this.prisma.expense.create({
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
          cardLast4: card.last4,
        },
      });
      await this.prisma.cashFlowEntry.create({
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
        },
      });
      return { inserted: true, settled: false, expenseId: expEst.id };
    }
    if (tx.amountCents === 0) {
      throw new Error('valor-zero');
    }

    const expenseType = categoryOverride || (PESSOAL_CATEGORY_MAP[categorize(tx.merchant)] ?? 'OUTROS');
    const total = tx.installmentTotal && tx.installmentTotal > 1 ? tx.installmentTotal : 1;
    const current = tx.installmentCurrent && tx.installmentCurrent >= 1 ? tx.installmentCurrent : 1;
    const remainingAfterCurrent = Math.max(0, total - current);

    // SERIES KEY: identifica de forma estável uma compra parcelada
    // (cartão + merchant normalizado + valor da parcela + total). Permite casar
    // parcelas futuras mesmo que a data varie entre faturas.
    const seriesKey = total > 1 ? buildSeriesKey(card.id, tx.merchant, tx.amountCents, total) : null;

    // 1) DEDUP de série parcelada: se já existe uma Expense desta série (criada
    //    a partir de uma fatura anterior, com todas as parcelas geradas como
    //    PLANEJADO), a reimportação de uma fatura seguinte NÃO cria duplicata nem
    //    marca a parcela como PAGA. No modelo de caixa real, quem liquida a
    //    parcela é o PAGAMENTO da fatura no extrato bancário (settleCardInvoice),
    //    não o reimport. Apenas vinculamos o externalId/importId se faltarem.
    if (seriesKey) {
      const existing = await this.prisma.expense.findFirst({
        // cardLast4 evita colisão entre cartões diferentes do mesmo tenant
        // (mesma merchant + valor + total em 2 cartões diferentes não casam)
        where: { tenantId, projectId, seriesKey, cardLast4: card.last4, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      });
      if (existing) {
        const anyEntry = await this.prisma.cashFlowEntry.findFirst({
          where: {
            tenantId,
            projectId,
            expenseId: existing.id,
            parcela: `${current}/${total}`,
            deletedAt: null,
          },
        });
        if (anyEntry) {
          // Parcela desta série já existe — dedup. Preserva rastreabilidade.
          if (!existing.externalId) {
            await this.prisma.expense.update({
              where: { id: existing.id },
              data: { externalId: tx.externalId, importId },
            });
          }
          return { inserted: false, settled: true, expenseId: existing.id };
        }
      }
    }

    // 2) Caminho normal: cria Expense + cashFlowEntries — TODAS as parcelas
    //    PLANEJADO. No modelo de caixa real, uma compra de cartão só vira PAGA
    //    quando o pagamento da respectiva fatura aparece no extrato bancário
    //    (settleCardInvoice). Até lá, é uma saída planejada.
    const installmentLabel = total > 1 ? `${current}/${total}` : null;
    const titulo = `${tx.merchant}${installmentLabel ? ` (${installmentLabel})` : ''}`.slice(0, 200);

    // O valor da linha (tx.amountCents) é o valor de UMA parcela. O total da
    // compra é parcela × nº de parcelas — gravamos esse total em valor/valorTotal
    // para que a derivação de parcelas no front (buildInstallments divide
    // valorTotal por quantidadeParcela) recomponha exatamente o valor da parcela.
    // Os cashFlowEntries continuam por parcela (tx.amountCents), sem dupla contagem.
    const valorCompra = total > 1 ? tx.amountCents * total : tx.amountCents;

    const expense = await this.prisma.expense.create({
      data: {
        tenantId,
        projectId,
        tipoDespesa: expenseType,
        titulo,
        fornecedor: tx.merchant.slice(0, 200),
        valor: valorCompra,
        quantidade: 1,
        valorTotal: valorCompra,
        formaPagamento: total > 1 ? 'PARCELADO' : 'A_VISTA',
        dataPagamento: tx.date,
        quantidadeParcela: total > 1 ? total : null,
        dataInicioParcela: total > 1 ? tx.date : null,
        status: 'PLANEJADO',
        importId,
        externalId: tx.externalId,
        seriesKey,
        cardLast4: card.last4,
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
    await this.prisma.cashFlowEntry.create({
      data: { ...baseCashFlow, data: tx.date, status: 'PLANEJADO', parcela: installmentLabel },
    });

    // Parcelas futuras — PLANEJADO, uma por mês subsequente
    for (let i = 1; i <= remainingAfterCurrent; i++) {
      const futureDate = addMonths(tx.date, i);
      await this.prisma.cashFlowEntry.create({
        data: {
          ...baseCashFlow,
          data: futureDate,
          status: 'PLANEJADO',
          parcela: `${current + i}/${total}`,
        },
      });
    }

    return { inserted: true, settled: false, expenseId: expense.id };
  }
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

/**
 * Normaliza o merchant + cardId + valor + total em uma chave estável para
 * identificar parcelas da mesma compra entre faturas diferentes.
 */
function buildSeriesKey(cardId: string, merchant: string, amountCents: number, total: number): string {
  const norm = (merchant || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `${cardId}|${norm}|${amountCents}|${total}`;
}

function serializeExpense(e: {
  id: string; titulo: string | null; fornecedor: string | null;
  valorTotal: number; dataPagamento: Date | null; dataInicioParcela: Date | null;
  createdAt: Date; status: string; cardLast4: string | null;
  formaPagamento: string; quantidadeParcela: number | null;
  linkedExpenseId: string | null; tipoDespesa: string; seriesKey: string | null;
}) {
  return {
    id: e.id,
    titulo: e.titulo,
    fornecedor: e.fornecedor,
    valor: e.valorTotal,
    data: (e.dataPagamento ?? e.dataInicioParcela ?? e.createdAt).toISOString(),
    status: e.status,
    cardLast4: e.cardLast4,
    formaPagamento: e.formaPagamento,
    quantidadeParcela: e.quantidadeParcela,
    linkedExpenseId: e.linkedExpenseId,
    tipoDespesa: e.tipoDespesa,
    seriesKey: e.seriesKey,
  };
}
