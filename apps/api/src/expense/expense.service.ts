import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { UpdateExpenseDto } from './dto/update-expense.dto';
import { ExpenseTypeLabels, LaborCategoryLabels, buildInstallments, PaymentForm } from '@reformaflow/domain';
import { Prisma } from '@prisma/client';

@Injectable()
export class ExpenseService {
  constructor(private readonly prisma: PrismaService) {}

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
        status: dto.status,
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

    const pageSize = Math.min(Math.max(opts.pageSize ?? 100, 10), 500);
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
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
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

  async findById(tenantId: string, projectId: string, id: string) {
    await this.validateProject(tenantId, projectId);

    const expense = await this.prisma.expense.findFirst({
      where: { id, projectId, tenantId, deletedAt: null },
      include: { room: true },
    });
    if (!expense) throw new NotFoundException('Despesa não encontrada');

    return expense;
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
        status: dto.status,
        cardLast4: links.cardLast4,
        bankLast4: links.bankLast4,
        linkedExpenseId: links.linkedExpenseId,
      },
      include: { room: true },
    });

    await this.regenerateCashFlow(expense.id);

    return expense;
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

  async remove(tenantId: string, projectId: string, id: string) {
    await this.validateProject(tenantId, projectId);

    const expense = await this.prisma.expense.findFirst({
      where: { id, projectId, tenantId, deletedAt: null },
    });
    if (!expense) throw new NotFoundException('Despesa não encontrada');

    const now = new Date();

    await this.prisma.$transaction([
      // Se esta despesa é alvo de algum link cross-project, limpa o ponteiro
      // dos sources para não deixar dangling reference.
      this.prisma.expense.updateMany({
        where: { tenantId, linkedExpenseId: id, deletedAt: null },
        data: { linkedExpenseId: null },
      }),
      this.prisma.cashFlowEntry.updateMany({
        where: { expenseId: id, deletedAt: null },
        data: { deletedAt: now },
      }),
      this.prisma.expense.update({
        where: { id },
        data: { deletedAt: now },
      }),
    ]);

    return { deleted: true };
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
    room: { name: string } | null;
  }) {
    const categoria = ExpenseTypeLabels[expense.tipoDespesa as keyof typeof ExpenseTypeLabels] ?? expense.tipoDespesa;
    const subcategoria = expense.categoriaMaoDeObra
      ? LaborCategoryLabels[expense.categoriaMaoDeObra as keyof typeof LaborCategoryLabels] ?? expense.categoriaMaoDeObra
      : null;
    const ambiente = expense.room?.name ?? null;
    const status = expense.status === 'PAGO' ? 'PAGO' : 'PLANEJADO';

    const installments = buildInstallments({
      valorTotal: expense.valorTotal,
      formaPagamento: expense.formaPagamento,
      dataPagamento: expense.dataPagamento,
      quantidadeParcela: expense.quantidadeParcela,
      dataInicioParcela: expense.dataInicioParcela,
    });

    const isAVista = expense.formaPagamento === PaymentForm.A_VISTA;

    return installments.map(({ parcela, valor, data }) => ({
      projectId: expense.projectId,
      tenantId: expense.tenantId,
      expenseId: expense.id,
      tipo: 'DESPESA',
      categoria,
      subcategoria,
      ambiente,
      status,
      valor,
      data,
      formaPagamento: expense.formaPagamento,
      parcela: isAVista ? null : parcela,
    }));
  }

  private async validateProject(tenantId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, tenantId },
    });
    if (!project) throw new NotFoundException('Projeto não encontrado');
  }
}
