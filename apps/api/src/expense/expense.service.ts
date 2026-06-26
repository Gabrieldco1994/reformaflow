import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConciliacaoService } from '../conciliacao/conciliacao.service';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { UpdateExpenseDto } from './dto/update-expense.dto';
import { ExpenseTypeLabels, LaborCategoryLabels, buildInstallments, isSinglePaymentForm, isNeutralExpenseType } from '@reformaflow/domain';
import { Prisma } from '@prisma/client';
import { fastClassify } from '../bank-account/bank-account.service';

@Injectable()
export class ExpenseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conciliacao: ConciliacaoService,
  ) {}

  /**
   * Resolve creditCardId/bankAccountId/linkedExpenseId em valores armazenáveis.
   * - creditCardId → cardLast4 (denormalizado)
   * - bankAccountId → bankLast4 (denormalizado)
   * - linkedExpenseId → valida que pertence ao mesmo tenant e que NÃO é do projeto atual
   * Retorna { cardLast4?, bankLast4?, linkedExpenseId? } com null explícito para "limpar".
   */
  private async resolveLinks(
    tenantId: string,
    currentProjectId: string,
    dto: Pick<CreateExpenseDto, 'creditCardId' | 'bankAccountId' | 'linkedExpenseId'>,
  ): Promise<{ cardLast4?: string | null; bankLast4?: string | null; linkedExpenseId?: string | null }> {
    // Parallel queries for better performance
    const [cardRow, accRow, linkedRow] = await Promise.all([
      dto.creditCardId && dto.creditCardId !== null && dto.creditCardId !== ''
        ? this.prisma.creditCard.findFirst({
            where: { id: dto.creditCardId, tenantId, deletedAt: null },
            select: { last4: true },
          })
        : null,
      dto.bankAccountId && dto.bankAccountId !== null && dto.bankAccountId !== ''
        ? this.prisma.bankAccount.findFirst({
            where: { id: dto.bankAccountId, tenantId, deletedAt: null },
            select: { last4: true },
          })
        : null,
      dto.linkedExpenseId && dto.linkedExpenseId !== null && dto.linkedExpenseId !== ''
        ? this.prisma.expense.findFirst({
            where: { id: dto.linkedExpenseId, tenantId, deletedAt: null },
            select: { projectId: true },
          })
        : null,
    ]);

    const out: { cardLast4?: string | null; bankLast4?: string | null; linkedExpenseId?: string | null } = {};

    if (dto.creditCardId !== undefined) {
      if (!dto.creditCardId) {
        out.cardLast4 = null;
      } else if (!cardRow) {
        throw new BadRequestException('Cartão de crédito não encontrado neste tenant');
      } else {
        out.cardLast4 = cardRow.last4 ?? null;
      }
    }

    if (dto.bankAccountId !== undefined) {
      if (!dto.bankAccountId) {
        out.bankLast4 = null;
      } else if (!accRow) {
        throw new BadRequestException('Conta bancária não encontrada neste tenant');
      } else {
        out.bankLast4 = accRow.last4 ?? null;
      }
    }

    if (dto.linkedExpenseId !== undefined) {
      if (!dto.linkedExpenseId) {
        out.linkedExpenseId = null;
      } else if (!linkedRow) {
        throw new BadRequestException('Despesa vinculada não encontrada neste tenant');
      } else if (linkedRow.projectId === currentProjectId) {
        throw new BadRequestException('Vínculo cross-project requer despesa de outro projeto');
      } else {
        out.linkedExpenseId = dto.linkedExpenseId;
      }
    }

    return out;
  }

  async create(tenantId: string, projectId: string, dto: CreateExpenseDto) {
    await this.validateProject(tenantId, projectId);

    const valorCents = Math.round(dto.valor * 100);
    const valorTotal = valorCents * dto.quantidade;

    const links = await this.resolveLinks(tenantId, projectId, dto);

    const expense = await this.prisma.expense.create({
      data: {
        projectId,
        tenantId,
        tipoDespesa: dto.tipoDespesa,
        categoriaMaoDeObra: dto.categoriaMaoDeObra,
        roomId: dto.roomId,
        valor: valorCents,
        quantidade: dto.quantidade,
        valorTotal,
        titulo: dto.titulo,
        fornecedor: dto.fornecedor,
        link: dto.link,
        imageUrl: dto.imageUrl,
        formaPagamento: dto.formaPagamento,
        dataPagamento: dto.dataPagamento ? new Date(dto.dataPagamento) : null,
        quantidadeParcela: dto.quantidadeParcela,
        dataInicioParcela: dto.dataInicioParcela ? new Date(dto.dataInicioParcela) : null,
        dataCompra: dto.dataCompra ? new Date(dto.dataCompra) : null,
        status: dto.status,
        recorrente: dto.recorrente ?? false,
        recorrenciaFim: dto.recorrenciaFim ? new Date(dto.recorrenciaFim) : null,
        cardLast4: links.cardLast4 ?? undefined,
        bankLast4: links.bankLast4 ?? undefined,
        linkedExpenseId: links.linkedExpenseId ?? undefined,
      },
      include: { room: true },
    });

    await this.regenerateCashFlow(expense.id);

    return expense;
  }

  async findAll(
    tenantId: string,
    projectId: string,
    opts: { page?: number; pageSize?: number } = {},
  ) {
    await this.validateProject(tenantId, projectId);

    const pageSize = Math.min(Math.max(opts.pageSize ?? 100, 10), 2000);
    const page = Math.max(opts.page ?? 1, 1);
    const skip = (page - 1) * pageSize;

    const where: Prisma.ExpenseWhereInput = {
      projectId,
      tenantId,
      deletedAt: null,
      settledByExpenseId: null,
    };

    const [items, total] = await Promise.all([
      this.prisma.expense.findMany({
        where,
        include: { room: true },
        orderBy: { createdAt: 'desc' },
        take: pageSize,
        skip,
      }),
      this.prisma.expense.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.max(Math.ceil(total / pageSize), 1),
    };
  }

  async findPlanned(tenantId: string, projectId: string) {
    await this.validateProject(tenantId, projectId);

    return this.prisma.expense.findMany({
      where: {
        projectId,
        tenantId,
        deletedAt: null,
        status: 'PLANEJADO',
        settledByExpenseId: null,
      },
      include: { room: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Lista despesas de OUTROS projetos do mesmo tenant — base para o seletor
   * cross-project no formulário e para a aba "Outras despesas".
   * Suporta busca textual leve (titulo/fornecedor) e filtro por projectId.
   */
  async findCrossProject(
    tenantId: string,
    currentProjectId: string,
    opts: { search?: string; projectId?: string; status?: 'PLANEJADO' | 'PAGO'; limit?: number } = {},
  ) {
    await this.validateProject(tenantId, currentProjectId);
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 2000);
    const where: Prisma.ExpenseWhereInput = {
      tenantId,
      deletedAt: null,
      settledByExpenseId: null,
      NOT: { projectId: currentProjectId },
    };
    if (opts.projectId) where.projectId = opts.projectId;
    if (opts.status) where.status = opts.status;
    if (opts.search && opts.search.trim()) {
      const s = opts.search.trim();
      where.OR = [
        { titulo: { contains: s } },
        { fornecedor: { contains: s } },
      ];
    }
    return this.prisma.expense.findMany({
      where,
      include: {
        room: true,
        project: { select: { id: true, name: true, type: true } },
      },
      orderBy: [{ createdAt: 'desc' }],
      take: limit,
    });
  }

  /** Vincula esta despesa a uma despesa de outro projeto (cross-project). */
  async linkCrossProject(tenantId: string, projectId: string, id: string, targetExpenseId: string) {
    await this.validateProject(tenantId, projectId);
    const source = await this.prisma.expense.findFirst({
      where: { id, projectId, tenantId, deletedAt: null },
    });
    if (!source) throw new NotFoundException('Despesa não encontrada');
    const target = await this.prisma.expense.findFirst({
      where: { id: targetExpenseId, tenantId, deletedAt: null },
      select: { projectId: true },
    });
    if (!target) throw new BadRequestException('Despesa alvo não encontrada');
    if (target.projectId === projectId) {
      throw new BadRequestException('Vínculo cross-project requer despesa de outro projeto');
    }
    return this.prisma.expense.update({
      where: { id },
      data: { linkedExpenseId: targetExpenseId },
      include: { room: true },
    });
  }

  async unlinkCrossProject(tenantId: string, projectId: string, id: string) {
    await this.validateProject(tenantId, projectId);
    const source = await this.prisma.expense.findFirst({
      where: { id, projectId, tenantId, deletedAt: null },
    });
    if (!source) throw new NotFoundException('Despesa não encontrada');
    return this.prisma.expense.update({
      where: { id },
      data: { linkedExpenseId: null },
      include: { room: true },
    });
  }

  /**
   * Concilia esta despesa (source, PESSOAL) com UMA parcela de uma despesa
   * planejada em outro projeto (Fase 6 — vínculo manual por parcela). Liquida a
   * parcela alvo com o valor REAL (default = valorTotal da source), de forma
   * não-destrutiva e reversível. Mantém o `linkedExpenseId` para dedupe.
   */
  async conciliarParcela(
    tenantId: string,
    projectId: string,
    sourceId: string,
    params: { targetExpenseId: string; parcelaIndex?: number; realValor?: number },
  ) {
    await this.validateProject(tenantId, projectId);
    const source = await this.prisma.expense.findFirst({
      where: { id: sourceId, projectId, tenantId, deletedAt: null },
    });
    if (!source) throw new NotFoundException('Despesa não encontrada');

    // Valor real da liquidação. Quando não informado pelo chamador, NÃO usar o
    // valorTotal da fonte (isso infla a parcela do alvo quando a fonte é
    // parcelada — bug histórico). Deriva o valor da PARCELA correspondente da
    // fonte: para pagamento único, é o próprio valorTotal (1 parcela); para
    // parcelada, é valorTotal/n da parcela `parcelaIndex`.
    const parcelaIndex = Math.max(0, params.parcelaIndex ?? 0);
    let realValor = params.realValor;
    if (realValor == null) {
      const sourceSlices = buildInstallments({
        valorTotal: source.valorTotal,
        formaPagamento: source.formaPagamento,
        dataPagamento: source.dataPagamento,
        quantidadeParcela: source.quantidadeParcela,
        dataInicioParcela: source.dataInicioParcela,
      });
      const slice = sourceSlices[Math.min(parcelaIndex, sourceSlices.length - 1)];
      realValor = slice?.valor ?? source.valorTotal;
    }

    await this.prisma.$transaction(async (tx) => {
      await this.conciliacao.settleTargetParcela(tx, {
        tenantId,
        sourceExpenseId: source.id,
        targetExpenseId: params.targetExpenseId,
        parcelaIndex,
        realValor,
      });
    });

    return { ok: true, sourceId: source.id, targetId: params.targetExpenseId, parcelaIndex };
  }

  /**
   * Desfaz a conciliação (todas as parcelas liquidadas por esta source),
   * restaurando o planejado do alvo e limpando o vínculo. Reversível.
   */
  async desconciliar(tenantId: string, projectId: string, sourceId: string) {
    await this.validateProject(tenantId, projectId);
    const source = await this.prisma.expense.findFirst({
      where: { id: sourceId, projectId, tenantId, deletedAt: null },
    });
    if (!source) throw new NotFoundException('Despesa não encontrada');
    if (!source.linkedExpenseId) return { ok: true, alreadyUnlinked: true };

    await this.prisma.$transaction(async (tx) => {
      await this.conciliacao.unsettleBySource(tx, { tenantId, sourceExpenseId: source.id });
    });
    return { ok: true };
  }

  async findById(tenantId: string, projectId: string, id: string) {
    await this.validateProject(tenantId, projectId);

    const expense = await this.prisma.expense.findFirst({
      where: { id, projectId, tenantId, deletedAt: null },
      include: { room: true },
    });
    if (!expense) throw new NotFoundException('Despesa não encontrada');

    return expense;
  }

  /**
   * Reclassifica despesas existentes do projeto rodando o `fastClassify` sobre o
   * `titulo` de cada uma. Só atualiza quando: (a) o tipo atual está na lista de
   * "genéricos" (OUTROS, COMPRAS_DEBITO, etc.) — para não sobrescrever escolhas
   * manuais do usuário; e (b) o classifier retorna um tipo novo, diferente.
   *
   * Útil após adicionar novas regras ao fastClassify ou para corrigir despesas
   * importadas em lote (ex.: reseed do master que veio tudo como COMPRAS_DEBITO).
   * Também atualiza o `categoria` dos CashFlowEntry vinculados para manter o
   * cockpit consistente.
   */
  async reclassifyByMerchant(
    tenantId: string,
    projectId: string,
    opts: { onlyGeneric?: boolean; dryRun?: boolean } = {},
  ) {
    await this.validateProject(tenantId, projectId);
    const onlyGeneric = opts.onlyGeneric ?? true;
    const dryRun = opts.dryRun ?? false;

    const GENERIC_TYPES = new Set(['OUTROS', 'COMPRAS_DEBITO', 'COMPRAS_VAREJO']);
    const where: Prisma.ExpenseWhereInput = {
      projectId,
      tenantId,
      deletedAt: null,
      settledByExpenseId: null,
      linkedExpenseId: null,
    };
    if (onlyGeneric) where.tipoDespesa = { in: Array.from(GENERIC_TYPES) };

    const items = await this.prisma.expense.findMany({
      where,
      select: { id: true, titulo: true, fornecedor: true, tipoDespesa: true },
    });

    const updates: Array<{ id: string; from: string; to: string; titulo: string | null }> = [];
    for (const e of items) {
      const merchant = (e.titulo ?? e.fornecedor ?? '').trim();
      if (!merchant) continue;
      const suggested = fastClassify(merchant);
      if (!suggested) continue;
      if (suggested === e.tipoDespesa) continue;
      // Não reclassifica para tipos neutros (espelho/transferência/mov interna)
      if (isNeutralExpenseType(suggested)) continue;
      updates.push({ id: e.id, from: e.tipoDespesa, to: suggested, titulo: e.titulo });
    }

    if (!dryRun && updates.length > 0) {
      // Em lotes para não estourar o pool de conexões. Atualiza Expense + CashFlowEntry.
      const CHUNK = 50;
      for (let i = 0; i < updates.length; i += CHUNK) {
        const chunk = updates.slice(i, i + CHUNK);
        await this.prisma.$transaction([
          ...chunk.map((u) =>
            this.prisma.expense.update({
              where: { id: u.id },
              data: { tipoDespesa: u.to },
            }),
          ),
          ...chunk.map((u) =>
            this.prisma.cashFlowEntry.updateMany({
              where: { expenseId: u.id, deletedAt: null },
              data: { categoria: u.to },
            }),
          ),
        ]);
      }
    }

    // Resumo por tipo destino (para o response)
    const byTo: Record<string, number> = {};
    for (const u of updates) byTo[u.to] = (byTo[u.to] ?? 0) + 1;

    return {
      candidates: items.length,
      reclassified: dryRun ? 0 : updates.length,
      dryRunChanges: dryRun ? updates.length : undefined,
      byTipoDespesa: byTo,
      samples: updates.slice(0, 10).map((u) => ({ titulo: u.titulo, from: u.from, to: u.to })),
      dryRun,
    };
  }

  async update(tenantId: string, projectId: string, id: string, dto: UpdateExpenseDto) {
    await this.validateProject(tenantId, projectId);

    const existing = await this.prisma.expense.findFirst({
      where: { id, projectId, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Despesa não encontrada');

    const valorCents = dto.valor !== undefined ? Math.round(dto.valor * 100) : existing.valor;
    const quantidade = dto.quantidade !== undefined ? dto.quantidade : existing.quantidade;
    const valorTotal = valorCents * quantidade;

    const links = await this.resolveLinks(tenantId, projectId, dto);

    // Mudanças em status agregado, forma, valor ou config de parcelamento
    // invalidam os índices de parcelas pagas — limpa para evitar estado stale.
    const resetPaidParcelas =
      dto.status !== undefined ||
      dto.formaPagamento !== undefined ||
      dto.quantidadeParcela !== undefined ||
      dto.valor !== undefined ||
      dto.quantidade !== undefined ||
      dto.dataInicioParcela !== undefined;

    const expense = await this.prisma.expense.update({
      where: { id },
      data: {
        tipoDespesa: dto.tipoDespesa,
        categoriaMaoDeObra: dto.categoriaMaoDeObra,
        roomId: dto.roomId,
        valor: valorCents,
        quantidade,
        valorTotal,
        titulo: dto.titulo,
        fornecedor: dto.fornecedor,
        link: dto.link,
        imageUrl: dto.imageUrl,
        formaPagamento: dto.formaPagamento,
        dataPagamento:
          dto.dataPagamento === undefined
            ? undefined
            : dto.dataPagamento === null
              ? null
              : new Date(dto.dataPagamento),
        quantidadeParcela: dto.quantidadeParcela,
        dataInicioParcela:
          dto.dataInicioParcela === undefined
            ? undefined
            : dto.dataInicioParcela === null
              ? null
              : new Date(dto.dataInicioParcela),
        dataCompra:
          dto.dataCompra === undefined
            ? undefined
            : dto.dataCompra === null
              ? null
              : new Date(dto.dataCompra),
        status: dto.status,
        recorrente: dto.recorrente === undefined ? undefined : !!dto.recorrente,
        recorrenciaFim:
          dto.recorrenciaFim === undefined
            ? undefined
            : dto.recorrenciaFim === null
              ? null
              : new Date(dto.recorrenciaFim),
        ...(resetPaidParcelas ? { paidParcelas: null } : {}),
        cardLast4: links.cardLast4,
        bankLast4: links.bankLast4,
        linkedExpenseId: links.linkedExpenseId,
      },
      include: { room: true },
    });

    await this.regenerateCashFlow(expense.id);

    // "Uma coisa só": se esta despesa faz parte de um par cross-project (canônico
    // na obra + espelho no PESSOAL, criado pelo fluxo de obra paga com caixa
    // pessoal), editar um lado deve refletir no outro. Propaga apenas campos da
    // COMPRA (data, valor, parcelas, status, tipo, título); campos por-lado (meio
    // de pagamento, sala, ponteiro de vínculo, anexos) NÃO são sincronizados.
    await this.syncLinkedObraPair(tenantId, id, dto);

    return expense;
  }

  private async syncLinkedObraPair(tenantId: string, sourceId: string, dto: UpdateExpenseDto) {
    const involvedInSettlement = async (expenseId: string) =>
      (await this.prisma.crossProjectSettlement.count({
        where: { tenantId, OR: [{ sourceExpenseId: expenseId }, { targetExpenseId: expenseId }] },
      })) > 0;

    // Pares de CONCILIAÇÃO (importação de fatura) têm unlink reversível próprio —
    // não sincronizamos para não interferir no fluxo de conciliação.
    if (await involvedInSettlement(sourceId)) return;

    const source = await this.prisma.expense.findFirst({
      where: { id: sourceId, tenantId, deletedAt: null },
      select: { id: true, linkedExpenseId: true },
    });
    if (!source) return;

    const counterpartIds = new Set<string>();
    if (source.linkedExpenseId) {
      const target = await this.prisma.expense.findFirst({
        where: { id: source.linkedExpenseId, tenantId, deletedAt: null },
        select: { id: true },
      });
      if (target && !(await involvedInSettlement(target.id))) counterpartIds.add(target.id);
    }
    const mirrors = await this.prisma.expense.findMany({
      where: { tenantId, linkedExpenseId: sourceId, deletedAt: null },
      select: { id: true },
    });
    for (const m of mirrors ?? []) {
      if (!(await involvedInSettlement(m.id))) counterpartIds.add(m.id);
    }
    if (counterpartIds.size === 0) return;

    const shared: Record<string, unknown> = {};
    if (dto.tipoDespesa !== undefined) shared.tipoDespesa = dto.tipoDespesa;
    if (dto.categoriaMaoDeObra !== undefined) shared.categoriaMaoDeObra = dto.categoriaMaoDeObra;
    if (dto.titulo !== undefined) shared.titulo = dto.titulo;
    if (dto.fornecedor !== undefined) shared.fornecedor = dto.fornecedor;
    if (dto.formaPagamento !== undefined) shared.formaPagamento = dto.formaPagamento;
    if (dto.quantidadeParcela !== undefined) shared.quantidadeParcela = dto.quantidadeParcela;
    if (dto.status !== undefined) shared.status = dto.status;
    if (dto.dataPagamento !== undefined)
      shared.dataPagamento = dto.dataPagamento === null ? null : new Date(dto.dataPagamento);
    if (dto.dataInicioParcela !== undefined)
      shared.dataInicioParcela =
        dto.dataInicioParcela === null ? null : new Date(dto.dataInicioParcela);
    if (dto.dataCompra !== undefined)
      shared.dataCompra = dto.dataCompra === null ? null : new Date(dto.dataCompra);
    if (dto.recorrente !== undefined) shared.recorrente = !!dto.recorrente;
    if (dto.recorrenciaFim !== undefined)
      shared.recorrenciaFim = dto.recorrenciaFim === null ? null : new Date(dto.recorrenciaFim);

    const resetPaidParcelas =
      dto.status !== undefined ||
      dto.formaPagamento !== undefined ||
      dto.quantidadeParcela !== undefined ||
      dto.valor !== undefined ||
      dto.quantidade !== undefined ||
      dto.dataInicioParcela !== undefined;

    for (const cid of counterpartIds) {
      const cp = await this.prisma.expense.findUnique({
        where: { id: cid },
        select: { valor: true, quantidade: true },
      });
      if (!cp) continue;

      const data: Record<string, unknown> = { ...shared };
      if (dto.valor !== undefined) data.valor = Math.round(dto.valor * 100);
      if (dto.quantidade !== undefined) data.quantidade = dto.quantidade;
      const newValor = (data.valor as number | undefined) ?? cp.valor;
      const newQtd = (data.quantidade as number | undefined) ?? cp.quantidade;
      data.valorTotal = newValor * newQtd;
      if (resetPaidParcelas) data.paidParcelas = null;

      await this.prisma.expense.update({ where: { id: cid }, data });
      await this.regenerateCashFlow(cid);
    }
  }

  async payPlanned(tenantId: string, projectId: string, id: string, dto: UpdateExpenseDto) {
    await this.validateProject(tenantId, projectId);

    const planned = await this.prisma.expense.findFirst({
      where: { id, projectId, tenantId, deletedAt: null },
    });
    if (!planned) throw new NotFoundException('Despesa não encontrada');
    if (planned.status !== 'PLANEJADO') {
      throw new BadRequestException('Despesa não está planejada');
    }
    if (planned.settledByExpenseId) {
      throw new BadRequestException('Despesa já foi liquidada');
    }
    if (this.parsePaidParcelas(planned.paidParcelas, planned.quantidadeParcela ?? 1).length > 0) {
      throw new BadRequestException(
        'Despesa tem parcelas pagas individualmente. Quite as parcelas restantes pelo status de cada parcela.',
      );
    }

    const valorCents = dto.valor !== undefined ? Math.round(dto.valor * 100) : planned.valor;
    const quantidade = dto.quantidade !== undefined ? dto.quantidade : planned.quantidade;
    const valorTotal = valorCents * quantidade;

    return this.prisma.$transaction(async (tx) => {
      // Create paid expense clone
      const paidExpense = await tx.expense.create({
        data: {
          projectId,
          tenantId,
          tipoDespesa: dto.tipoDespesa ?? planned.tipoDespesa,
          categoriaMaoDeObra: dto.categoriaMaoDeObra ?? planned.categoriaMaoDeObra,
          roomId: dto.roomId ?? planned.roomId,
          valor: valorCents,
          quantidade,
          valorTotal,
          titulo: dto.titulo ?? planned.titulo,
          fornecedor: dto.fornecedor ?? planned.fornecedor,
          link: dto.link ?? planned.link,
          imageUrl: dto.imageUrl ?? planned.imageUrl,
          formaPagamento: dto.formaPagamento ?? planned.formaPagamento,
          dataPagamento: dto.dataPagamento ? new Date(dto.dataPagamento) : planned.dataPagamento,
          quantidadeParcela: dto.quantidadeParcela ?? planned.quantidadeParcela,
          dataInicioParcela: dto.dataInicioParcela ? new Date(dto.dataInicioParcela) : planned.dataInicioParcela,
          status: 'PAGO',
          plannedExpenseId: planned.id,
        },
        include: { room: true },
      });

      // Mark original as settled
      await tx.expense.update({
        where: { id: planned.id },
        data: { settledByExpenseId: paidExpense.id },
      });

      // Soft-delete cash flow entries from planned expense
      await tx.cashFlowEntry.updateMany({
        where: { expenseId: planned.id, deletedAt: null },
        data: { deletedAt: new Date() },
      });

      // Generate cash flow for the paid expense (outside transaction context)
      // We need to do it after transaction completes, so we'll inline it here
      const expense = await tx.expense.findUnique({
        where: { id: paidExpense.id },
        include: { room: true },
      });

      if (expense) {
        const entries = this.buildCashFlowEntries(expense);
        if (entries.length > 0) {
          await tx.cashFlowEntry.createMany({ data: entries });
        }
      }

      return paidExpense;
    });
  }

  /**
   * Marca/desmarca UMA parcela (0-based) de uma despesa PARCELADO/QUINZENAL como paga.
   * Não cria clone (diferente de payPlanned): mantém a despesa e ajusta `paidParcelas`
   * + regenera o fluxo de caixa com status por parcela. Quando todas as parcelas ficam
   * pagas, a despesa inteira vira status='PAGO' (e paidParcelas é limpo).
   */
  async setParcelaStatus(
    tenantId: string,
    projectId: string,
    id: string,
    parcela: number,
    paid: boolean,
  ) {
    await this.validateProject(tenantId, projectId);

    return this.prisma.$transaction(async (tx) => {
      const expense = await tx.expense.findFirst({
        where: { id, projectId, tenantId, deletedAt: null },
        include: { room: true },
      });
      if (!expense) throw new NotFoundException('Despesa não encontrada');
      if (expense.settledByExpenseId) {
        throw new BadRequestException('Despesa já foi liquidada');
      }
      if (isSinglePaymentForm(expense.formaPagamento)) {
        throw new BadRequestException('Despesa não é parcelada/quinzenal');
      }
      const n = expense.quantidadeParcela ?? 1;
      if (n <= 1) {
        throw new BadRequestException('Despesa não possui múltiplas parcelas');
      }
      if (!Number.isInteger(parcela) || parcela < 0 || parcela >= n) {
        throw new BadRequestException('Índice de parcela inválido');
      }

      // Estado base: se a despesa estava PAGO, todas as parcelas eram pagas.
      const baseSet =
        expense.status === 'PAGO'
          ? new Set<number>(Array.from({ length: n }, (_, i) => i))
          : new Set<number>(this.parsePaidParcelas(expense.paidParcelas, n));

      if (paid) baseSet.add(parcela);
      else baseSet.delete(parcela);

      const allPaid = baseSet.size === n;
      const nextStatus = allPaid ? 'PAGO' : 'PLANEJADO';
      const nextPaidParcelas =
        allPaid || baseSet.size === 0
          ? null
          : JSON.stringify(Array.from(baseSet).sort((a, b) => a - b));

      const updated = await tx.expense.update({
        where: { id: expense.id },
        data: { status: nextStatus, paidParcelas: nextPaidParcelas },
        include: { room: true },
      });

      // Regenera o fluxo de caixa com o status por parcela atualizado.
      await tx.cashFlowEntry.updateMany({
        where: { expenseId: expense.id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      const entries = this.buildCashFlowEntries(updated);
      if (entries.length > 0) {
        await tx.cashFlowEntry.createMany({ data: entries });
      }

      return updated;
    });
  }

  async remove(tenantId: string, projectId: string, id: string) {
    await this.validateProject(tenantId, projectId);

    const expense = await this.prisma.expense.findFirst({
      where: { id, projectId, tenantId, deletedAt: null },
    });
    if (!expense) throw new NotFoundException('Despesa não encontrada');

    // "Uma coisa só": um vínculo cross-project criado pelo fluxo de obra paga com
    // caixa pessoal (canônico na obra + espelho no PESSOAL) deve ser excluído como
    // unidade — apagar um lado apaga o outro. EXCEÇÃO: vínculos de CONCILIAÇÃO
    // (importação de fatura) têm CrossProjectSettlement e unlink reversível; nesses
    // NÃO cascateamos (preserva o comportamento de restaurar o planejado).
    const ids = new Set<string>([id]);

    const involvedInSettlement = async (expenseId: string) =>
      (await this.prisma.crossProjectSettlement.count({
        where: { tenantId, OR: [{ sourceExpenseId: expenseId }, { targetExpenseId: expenseId }] },
      })) > 0;

    if (!(await involvedInSettlement(id))) {
      // Se esta é um espelho, inclui o canônico-alvo (se ele não for de conciliação).
      if (expense.linkedExpenseId) {
        const target = await this.prisma.expense.findFirst({
          where: { id: expense.linkedExpenseId, tenantId, deletedAt: null },
          select: { id: true },
        });
        if (target && !(await involvedInSettlement(target.id))) ids.add(target.id);
      }
      // Inclui os espelhos que apontam para esta (despesas-irmãs no PESSOAL).
      const mirrors = await this.prisma.expense.findMany({
        where: { tenantId, linkedExpenseId: id, deletedAt: null },
        select: { id: true },
      });
      for (const m of mirrors) {
        if (!(await involvedInSettlement(m.id))) ids.add(m.id);
      }
    }

    const idArr = [...ids];
    const now = new Date();

    await this.prisma.$transaction([
      // Limpa ponteiros pendentes de quaisquer OUTRAS despesas que apontem para as
      // que serão removidas (evita dangling reference).
      this.prisma.expense.updateMany({
        where: { tenantId, linkedExpenseId: { in: idArr }, id: { notIn: idArr }, deletedAt: null },
        data: { linkedExpenseId: null },
      }),
      this.prisma.cashFlowEntry.updateMany({
        where: { expenseId: { in: idArr }, deletedAt: null },
        data: { deletedAt: now },
      }),
      this.prisma.expense.updateMany({
        where: { id: { in: idArr }, deletedAt: null },
        data: { deletedAt: now },
      }),
    ]);

    return { deleted: true, count: idArr.length };
  }

  private async regenerateCashFlow(expenseId: string) {
    const expense = await this.prisma.expense.findUnique({
      where: { id: expenseId },
      include: { room: true },
    });
    if (!expense) return;

    return this.prisma.$transaction(async (tx) => {
      // Soft-delete existing entries
      await tx.cashFlowEntry.updateMany({
        where: { expenseId, deletedAt: null },
        data: { deletedAt: new Date() },
      });

      // If settled by another expense, don't generate new entries
      if (expense.settledByExpenseId) return;

      const entries = this.buildCashFlowEntries(expense);
      if (entries.length > 0) {
        await tx.cashFlowEntry.createMany({ data: entries });
      }
    });
  }

  private buildCashFlowEntries(expense: {
    id: string;
    projectId: string;
    tenantId: string;
    tipoDespesa: string;
    categoriaMaoDeObra: string | null;
    roomId: string | null;
    valorTotal: number;
    formaPagamento: string;
    dataPagamento: Date | null;
    quantidadeParcela: number | null;
    dataInicioParcela: Date | null;
    status: string;
    paidParcelas?: string | null;
    room: { name: string } | null;
  }) {
    // Tipos "neutros" (transferência entre contas próprias, pagto de fatura)
    // não geram entradas de cashflow — não representam consumo/saldo real.
    if (isNeutralExpenseType(expense.tipoDespesa)) return [];

    const categoria = ExpenseTypeLabels[expense.tipoDespesa as keyof typeof ExpenseTypeLabels] ?? expense.tipoDespesa;
    const subcategoria = expense.categoriaMaoDeObra
      ? LaborCategoryLabels[expense.categoriaMaoDeObra as keyof typeof LaborCategoryLabels] ?? expense.categoriaMaoDeObra
      : null;
    const ambiente = expense.room?.name ?? null;
    const fullyPaid = expense.status === 'PAGO';

    const installments = buildInstallments({
      valorTotal: expense.valorTotal,
      formaPagamento: expense.formaPagamento,
      dataPagamento: expense.dataPagamento,
      quantidadeParcela: expense.quantidadeParcela,
      dataInicioParcela: expense.dataInicioParcela,
    });

    const singlePayment = isSinglePaymentForm(expense.formaPagamento);
    // Parcelas pagas individualmente (status por parcela). Quando a despesa
    // inteira está PAGO, todas as parcelas entram como PAGO independentemente.
    const paidSet = singlePayment
      ? new Set<number>()
      : new Set(this.parsePaidParcelas(expense.paidParcelas, installments.length));

    return installments.map(({ parcela, valor, data }, idx) => ({
      projectId: expense.projectId,
      tenantId: expense.tenantId,
      expenseId: expense.id,
      tipo: 'DESPESA',
      categoria,
      subcategoria,
      ambiente,
      status: fullyPaid || paidSet.has(idx) ? 'PAGO' : 'PLANEJADO',
      valor,
      data,
      formaPagamento: expense.formaPagamento,
      parcela: singlePayment ? null : parcela,
    }));
  }

  /**
   * Normaliza o JSON de parcelas pagas: aceita só inteiros no range [0, n),
   * sem duplicados, ordenados. Nunca confia no formato bruto vindo do banco/cliente.
   */
  private parsePaidParcelas(raw: string | null | undefined, n: number): number[] {
    if (!raw) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const set = new Set<number>();
    for (const v of parsed) {
      const i = Number(v);
      if (Number.isInteger(i) && i >= 0 && i < n) set.add(i);
    }
    return Array.from(set).sort((a, b) => a - b);
  }

  private async validateProject(tenantId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, tenantId },
    });
    if (!project) throw new NotFoundException('Projeto não encontrado');
  }
}
