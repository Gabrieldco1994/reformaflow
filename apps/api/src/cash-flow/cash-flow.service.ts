import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCashFlowDto } from './dto/create-cash-flow.dto';
import { calculateRollingBalance } from '@reformaflow/domain';
import { CashFlowType } from '@reformaflow/domain';

@Injectable()
export class CashFlowService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, projectId: string, dto: CreateCashFlowDto) {
    await this.validateProject(tenantId, projectId);

    return this.prisma.cashFlowEntry.create({
      data: {
        projectId,
        roomId: dto.roomId,
        workTypeId: dto.workTypeId,
        plannedDate: new Date(dto.plannedDate),
        effectiveDate: dto.effectiveDate ? new Date(dto.effectiveDate) : null,
        description: dto.description,
        type: dto.type,
        amount: dto.amount,
        status: dto.effectiveDate ? 'EXECUTED' : 'FORECAST',
      },
    });
  }

  /**
   * Lista fluxo de caixa com saldo acumulado (rolling balance)
   * Regra da planilha: Entrada soma, Saída subtrai do saldo anterior
   */
  async findAllWithBalance(tenantId: string, projectId: string) {
    await this.validateProject(tenantId, projectId);

    const entries = await this.prisma.cashFlowEntry.findMany({
      where: { projectId },
      orderBy: { plannedDate: 'asc' },
      include: { room: true, workType: true },
    });

    const balances = calculateRollingBalance(
      entries.map((e) => ({
        type: e.type as CashFlowType,
        amount: e.amount,
      })),
    );

    return entries.map((entry, i) => ({
      ...entry,
      rollingBalance: balances[i],
    }));
  }

  async remove(tenantId: string, projectId: string, id: string) {
    await this.validateProject(tenantId, projectId);
    await this.prisma.cashFlowEntry.delete({ where: { id } });
    return { deleted: true };
  }

  private async validateProject(tenantId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, tenantId },
    });
    if (!project) throw new NotFoundException('Projeto não encontrado');
  }
}
