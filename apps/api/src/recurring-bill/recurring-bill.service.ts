import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRecurringBillDto, UpdateRecurringBillDto } from './dto/recurring-bill.dto';

@Injectable()
export class RecurringBillService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(tenantId: string, projectId: string) {
    return this.prisma.recurringBill.findMany({
      where: { tenantId, projectId },
      orderBy: { diaVencimento: 'asc' },
    });
  }

  async findById(tenantId: string, projectId: string, id: string) {
    const bill = await this.prisma.recurringBill.findFirst({
      where: { id, tenantId, projectId },
    });
    if (!bill) throw new NotFoundException('Conta não encontrada');
    return bill;
  }

  async create(tenantId: string, projectId: string, dto: CreateRecurringBillDto) {
    return this.prisma.recurringBill.create({
      data: {
        tenantId,
        projectId,
        nome: dto.nome,
        valor: dto.valor,
        categoria: dto.categoria,
        frequencia: dto.frequencia ?? 'MENSAL',
        diaVencimento: dto.diaVencimento,
        status: dto.status ?? 'ATIVO',
        observacoes: dto.observacoes,
        proximoVencimento: this.calcNextDue(dto.diaVencimento),
      },
    });
  }

  async update(tenantId: string, projectId: string, id: string, dto: UpdateRecurringBillDto) {
    await this.findById(tenantId, projectId, id);
    const data: Record<string, unknown> = {};
    if (dto.nome !== undefined) data.nome = dto.nome;
    if (dto.valor !== undefined) data.valor = dto.valor;
    if (dto.categoria !== undefined) data.categoria = dto.categoria;
    if (dto.frequencia !== undefined) data.frequencia = dto.frequencia;
    if (dto.diaVencimento !== undefined) {
      data.diaVencimento = dto.diaVencimento;
      data.proximoVencimento = this.calcNextDue(dto.diaVencimento);
    }
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.observacoes !== undefined) data.observacoes = dto.observacoes;
    return this.prisma.recurringBill.update({ where: { id }, data });
  }

  async remove(tenantId: string, projectId: string, id: string) {
    await this.findById(tenantId, projectId, id);
    await this.prisma.recurringBill.delete({ where: { id } });
    return { deleted: true };
  }

  private calcNextDue(day: number): Date {
    const now = new Date();
    let next = new Date(now.getFullYear(), now.getMonth(), day);
    if (next <= now) next.setMonth(next.getMonth() + 1);
    return next;
  }
}
