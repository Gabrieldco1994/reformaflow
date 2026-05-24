import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCreditCardDto, UpdateCreditCardDto } from './dto/credit-card.dto';
import { parseStatementBuffer, type SourceHint, type NormalizedTx, type ParseResult } from './parsers';

// Mapeamento de categorias do parser → ExpenseType pessoal
const PESSOAL_CATEGORY_MAP: Record<string, string> = {
  alimentação: 'ALIMENTACAO',
  transporte: 'TRANSPORTE',
  assinaturas: 'ASSINATURAS',
  viagem: 'LAZER',
  saúde: 'SAUDE',
  compras: 'OUTROS',
  educação: 'EDUCACAO',
  casa: 'MORADIA',
  outros: 'OUTROS',
};

import { categorize } from './categorizer';

@Injectable()
export class CreditCardService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── CRUD cartões ────────────────────────────────────────

  async listCards(tenantId: string, projectId: string) {
    await this.ensureProject(tenantId, projectId);
    return this.prisma.creditCard.findMany({
      where: { tenantId, projectId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });
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
    fileContent: string | Buffer,
    fileName: string | undefined,
    source: SourceHint,
    password?: string,
  ) {
    const card = await this.findCard(tenantId, projectId, cardId);
    const buf = typeof fileContent === 'string' ? Buffer.from(fileContent, 'utf-8') : fileContent;
    const parsed = await parseStatementBuffer(buf, card.id, source, fileName, password);
    const existing = await this.findExistingExternalIds(
      tenantId,
      projectId,
      parsed.transactions.map((t) => t.externalId),
    );

    const preview = parsed.transactions.map((tx) => ({
      ...tx,
      date: tx.date.toISOString().slice(0, 10),
      duplicate: existing.has(tx.externalId),
      suggestedCategory: PESSOAL_CATEGORY_MAP[categorize(tx.merchant)] ?? 'OUTROS',
    }));

    return {
      source: parsed.source,
      periodLabel: parsed.periodLabel,
      totalAmountCents: parsed.totalAmountCents,
      total: parsed.transactions.length,
      duplicated: preview.filter((p) => p.duplicate).length,
      inserted: 0, // ainda não inseriu
      preview,
    };
  }

  async commitImport(
    tenantId: string,
    projectId: string,
    cardId: string,
    fileContent: string | Buffer,
    fileName: string | undefined,
    source: SourceHint,
    periodLabelOverride?: string,
    password?: string,
  ) {
    const card = await this.findCard(tenantId, projectId, cardId);
    const buf = typeof fileContent === 'string' ? Buffer.from(fileContent, 'utf-8') : fileContent;
    const parsed = await parseStatementBuffer(buf, card.id, source, fileName, password);
    const periodLabel = periodLabelOverride ?? parsed.periodLabel ?? new Date().toISOString().slice(0, 7);

    const existingIds = await this.findExistingExternalIds(
      tenantId,
      projectId,
      parsed.transactions.map((t) => t.externalId),
    );

    const toInsert = parsed.transactions.filter((t) => !existingIds.has(t.externalId));
    const duplicated = parsed.transactions.length - toInsert.length;

    const importRecord = await this.prisma.creditCardStatementImport.create({
      data: {
        tenantId,
        cardId: card.id,
        periodLabel,
        source: parsed.source,
        fileName: fileName?.slice(0, 200),
        fileSize: buf.length,
        status: 'COMPLETED',
        inserted: toInsert.length,
        duplicated,
        totalAmountCents: parsed.totalAmountCents,
      },
    });

    let inserted = 0;
    let settled = 0;
    let skipped = 0;
    for (const tx of toInsert) {
      try {
        const result = await this.createExpenseFromTransaction(tenantId, projectId, card, tx, importRecord.id);
        if (result.settled) settled++;
        if (result.inserted) inserted++;
      } catch (err) {
        skipped++;
        // continua importando os demais; loga via console limpo (sem PII)
        console.warn(`[credit-card-import] tx skipped (${tx.externalId.slice(0, 8)}):`, (err as Error).message);
      }
    }

    await this.prisma.creditCardStatementImport.update({
      where: { id: importRecord.id },
      data: { inserted, skipped, duplicated: duplicated + settled, message: settled > 0 ? `${settled} parcela(s) liquidada(s)` : null },
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
      skipped,
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
        status: 'PLANEJADO',
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
        .filter((p) => {
          if (Math.abs(p.valorTotal - e.valorTotal) > tolerance) return false;
          const pDate = p.dataPagamento ?? p.dataInicioParcela ?? p.createdAt;
          return pDate >= minDate && pDate <= maxDate;
        })
        .slice(0, 5)
        .map((p) => ({
          expenseId: p.id,
          projectId: p.projectId,
          projectName: projectById.get(p.projectId)?.name ?? '',
          projectType: projectById.get(p.projectId)?.type ?? '',
          titulo: p.titulo,
          fornecedor: p.fornecedor,
          valor: p.valorTotal,
          data: (p.dataPagamento ?? p.dataInicioParcela ?? p.createdAt).toISOString(),
          deltaCents: e.valorTotal - p.valorTotal,
        }));

      return { expense: serializeExpense(e), suggestions: matches };
    });
  }

  /**
   * Vincula uma despesa importada (do cartão, no PESSOAL) a uma despesa
   * existente em outro projeto (planejada em REFORMA/CASA/CARRO).
   *
   * Efeitos:
   *  - A despesa alvo vira PAGO, com data igual à da fatura.
   *  - Os cashFlowEntries da alvo viram PAGO.
   *  - A despesa importada ganha linkedExpenseId apontando para a alvo.
   *  - A visão mensal (consolidada) filtrará entries com expense.linkedExpenseId
   *    para evitar dupla contagem.
   */
  async linkToExpense(
    tenantId: string,
    projectId: string,
    cardExpenseId: string,
    targetExpenseId: string,
  ) {
    const source = await this.prisma.expense.findFirst({
      where: { id: cardExpenseId, tenantId, projectId, deletedAt: null },
    });
    if (!source) throw new NotFoundException('Despesa importada não encontrada');
    if (!source.cardLast4) throw new BadRequestException('Despesa não foi importada de cartão');

    const target = await this.prisma.expense.findFirst({
      where: { id: targetExpenseId, tenantId, deletedAt: null },
    });
    if (!target) throw new NotFoundException('Despesa alvo não encontrada');
    if (target.status === 'PAGO') {
      throw new BadRequestException('Despesa alvo já está paga — desvincule antes de re-linkar');
    }
    if (target.projectId === projectId) {
      throw new BadRequestException('Alvo deve estar em outro projeto');
    }

    const paymentDate = source.dataPagamento ?? source.dataInicioParcela ?? source.createdAt;

    await this.prisma.$transaction([
      this.prisma.expense.update({
        where: { id: target.id },
        data: {
          status: 'PAGO',
          // Preserva a data planejada original do alvo; só registra dataPagamento se faltar
          dataPagamento: target.dataPagamento ?? target.dataInicioParcela ?? paymentDate,
        },
      }),
      this.prisma.cashFlowEntry.updateMany({
        where: {
          tenantId,
          expenseId: target.id,
          status: { in: ['PLANEJADO', 'PREVISTO'] },
          deletedAt: null,
        },
        // Mantém a data original do entry — só converte status para PAGO
        data: { status: 'PAGO' },
      }),
      this.prisma.expense.update({
        where: { id: source.id },
        data: { linkedExpenseId: target.id },
      }),
    ]);

    return { ok: true, sourceId: source.id, targetId: target.id, paymentDate };
  }

  /**
   * Desfaz o link entre uma despesa importada e a alvo.
   * NÃO reverte o status da alvo (ela pode ter outras razões para estar PAGA).
   */
  async unlinkExpense(tenantId: string, projectId: string, cardExpenseId: string) {
    const source = await this.prisma.expense.findFirst({
      where: { id: cardExpenseId, tenantId, projectId, deletedAt: null },
    });
    if (!source) throw new NotFoundException('Despesa não encontrada');
    if (!source.linkedExpenseId) return { ok: true, alreadyUnlinked: true };
    await this.prisma.expense.update({
      where: { id: source.id },
      data: { linkedExpenseId: null },
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
  ): Promise<{ inserted: boolean; settled: boolean }> {
    if (tx.amountCents <= 0) {
      // MVP: estornos ignorados (usuário lança manualmente quando precisar).
      throw new Error('estorno-ignorado');
    }

    const expenseType = PESSOAL_CATEGORY_MAP[categorize(tx.merchant)] ?? 'OUTROS';
    const total = tx.installmentTotal && tx.installmentTotal > 1 ? tx.installmentTotal : 1;
    const current = tx.installmentCurrent && tx.installmentCurrent >= 1 ? tx.installmentCurrent : 1;
    const remainingAfterCurrent = Math.max(0, total - current);

    // SERIES KEY: identifica de forma estável uma compra parcelada
    // (cartão + merchant normalizado + valor da parcela + total). Permite casar
    // parcelas futuras mesmo que a data varie entre faturas.
    const seriesKey = total > 1 ? buildSeriesKey(card.id, tx.merchant, tx.amountCents, total) : null;

    // 1) Tenta SETTLEMENT: se já temos uma Expense desta série com cashFlowEntry
    //    PLANEJADO/PREVISTO marcado para esta parcela current, só transformamos
    //    em PAGO em vez de duplicar.
    if (seriesKey) {
      const existing = await this.prisma.expense.findFirst({
        // cardLast4 evita colisão entre cartões diferentes do mesmo tenant
        // (mesma merchant + valor + total em 2 cartões diferentes não casam)
        where: { tenantId, projectId, seriesKey, cardLast4: card.last4, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      });
      if (existing) {
        const plannedEntry = await this.prisma.cashFlowEntry.findFirst({
          where: {
            tenantId,
            projectId,
            expenseId: existing.id,
            parcela: `${current}/${total}`,
            status: { in: ['PLANEJADO', 'PREVISTO'] },
            deletedAt: null,
          },
        });
        if (plannedEntry) {
          // Valida que o valor da fatura está próximo do planejado (±5% ou R$1)
          // Evita marcar como PAGO um entry que tenha valor muito diferente
          // (usuário pode ter editado, ou pode ser duplicidade espúria)
          const tolerance = Math.max(100, Math.round(plannedEntry.valor * 0.05));
          if (Math.abs(plannedEntry.valor - tx.amountCents) > tolerance) {
            // Valor diverge — não settle, cai no caminho normal de criação
          } else {
            await this.prisma.cashFlowEntry.update({
              where: { id: plannedEntry.id },
              data: { status: 'PAGO', data: tx.date, valor: tx.amountCents },
            });
            if (!existing.externalId) {
              await this.prisma.expense.update({
                where: { id: existing.id },
                data: { externalId: tx.externalId, importId },
              });
            }
            return { inserted: false, settled: true };
          }
        }
      }
    }

    // 2) Caminho normal: cria Expense + cashFlowEntries (atual PAGO + futuras PLANEJADO)
    const installmentLabel = total > 1 ? `${current}/${total}` : null;
    const titulo = `${tx.merchant}${installmentLabel ? ` (${installmentLabel})` : ''}`.slice(0, 200);

    const expense = await this.prisma.expense.create({
      data: {
        tenantId,
        projectId,
        tipoDespesa: expenseType,
        titulo,
        fornecedor: tx.merchant.slice(0, 200),
        valor: tx.amountCents,
        quantidade: 1,
        valorTotal: tx.amountCents,
        formaPagamento: total > 1 ? 'PARCELADO' : 'A_VISTA',
        dataPagamento: tx.date,
        quantidadeParcela: total > 1 ? total : null,
        dataInicioParcela: total > 1 ? tx.date : null,
        status: 'PAGO',
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
      categoria: expenseType,
      subcategoria: card.nickname,
      formaPagamento: 'CARTAO_CREDITO',
    };

    // Parcela atual — PAGO
    await this.prisma.cashFlowEntry.create({
      data: { ...baseCashFlow, data: tx.date, status: 'PAGO', parcela: installmentLabel },
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

    return { inserted: true, settled: false };
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
