import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { UpdateExpenseDto } from './dto/update-expense.dto';
import { ExpenseTypeLabels, LaborCategoryLabels } from '@reformaflow/domain';

@Injectable()
export class ExpenseService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, projectId: string, dto: CreateExpenseDto) {
    await this.validateProject(tenantId, projectId);

    const valorCents = Math.round(dto.valor * 100);
    const valorTotal = valorCents * dto.quantidade;

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
      },
      include: { room: true },
    });

    await this.regenerateCashFlow(expense.id);

    return expense;
  }

  async findAll(tenantId: string, projectId: string) {
    await this.validateProject(tenantId, projectId);

    return this.prisma.expense.findMany({
      where: {
        projectId,
        tenantId,
        deletedAt: null,
        settledByExpenseId: null,
      },
      include: { room: true },
      orderBy: { createdAt: 'desc' },
    });
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

    const baseEntry = {
      projectId: expense.projectId,
      tenantId: expense.tenantId,
      expenseId: expense.id,
      tipo: 'DESPESA',
      categoria,
      subcategoria,
      ambiente,
      status,
    };

    if (expense.formaPagamento === 'A_VISTA') {
      return [{
        ...baseEntry,
        valor: expense.valorTotal,
        data: expense.dataPagamento ?? new Date(),
        formaPagamento: 'A_VISTA',
        parcela: null,
      }];
    }

    const n = expense.quantidadeParcela ?? 1;
    const baseValue = Math.floor(expense.valorTotal / n);
    const remainder = expense.valorTotal - baseValue * n;
    const startDate = expense.dataInicioParcela ?? new Date();
    const isQuinzenal = expense.formaPagamento === 'QUINZENAL';

    const entries = [];
    for (let i = 0; i < n; i++) {
      const d = new Date(startDate);
      if (isQuinzenal) {
        d.setUTCDate(d.getUTCDate() + i * 15);
      } else {
        const targetMonth = d.getUTCMonth() + i;
        const targetDay = d.getUTCDate();
        d.setUTCDate(1);
        d.setUTCMonth(targetMonth);
        const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
        d.setUTCDate(Math.min(targetDay, lastDay));
      }

      entries.push({
        ...baseEntry,
        valor: i === n - 1 ? baseValue + remainder : baseValue,
        data: d,
        formaPagamento: expense.formaPagamento,
        parcela: `${i + 1}/${n}`,
      });
    }

    return entries;
  }

  private async validateProject(tenantId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, tenantId },
    });
    if (!project) throw new NotFoundException('Projeto não encontrado');
  }
}
