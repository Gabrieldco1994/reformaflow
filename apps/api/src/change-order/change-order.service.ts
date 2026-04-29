import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateChangeOrderDto } from './dto/create-change-order.dto';
import { ApproveChangeOrderDto } from './dto/approve-change-order.dto';

@Injectable()
export class ChangeOrderService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, projectId: string, dto: CreateChangeOrderDto) {
    await this.validateProject(tenantId, projectId);

    return this.prisma.changeOrder.create({
      data: {
        projectId,
        roomId: dto.roomId,
        workTypeId: dto.workTypeId,
        date: new Date(dto.date),
        item: dto.item,
        reason: dto.reason,
        additionalAmount: dto.additionalAmount,
        notes: dto.notes,
      },
    });
  }

  async findAllByProject(tenantId: string, projectId: string) {
    await this.validateProject(tenantId, projectId);
    return this.prisma.changeOrder.findMany({
      where: { projectId },
      include: { room: true, workType: true },
      orderBy: { date: 'desc' },
    });
  }

  /**
   * Aprova aditivo e soma automaticamente ao Previsto do BudgetItem correspondente.
   * Regra: aditivos aprovados impactam o Previsto de (Ambiente + Tipo de Obra)
   */
  async approve(tenantId: string, projectId: string, id: string, dto: ApproveChangeOrderDto) {
    await this.validateProject(tenantId, projectId);

    const changeOrder = await this.prisma.changeOrder.findFirst({
      where: { id, projectId },
    });
    if (!changeOrder) throw new NotFoundException('Aditivo não encontrado');
    if (changeOrder.status !== 'PENDING') {
      throw new BadRequestException('Aditivo já processado');
    }

    return this.prisma.$transaction(async (tx) => {
      // Atualiza status do aditivo
      const updated = await tx.changeOrder.update({
        where: { id },
        data: {
          status: 'APPROVED',
          approvedBy: dto.approvedBy,
        },
      });

      // Se tem Room e WorkType, soma ao Previsto do BudgetItem correspondente
      if (changeOrder.roomId && changeOrder.workTypeId) {
        const budgetItem = await tx.budgetItem.findFirst({
          where: {
            projectId,
            roomId: changeOrder.roomId,
            workTypeId: changeOrder.workTypeId,
          },
        });

        if (budgetItem) {
          await tx.budgetItem.update({
            where: { id: budgetItem.id },
            data: { planned: budgetItem.planned + changeOrder.additionalAmount },
          });
        }
      }

      return updated;
    });
  }

  async reject(tenantId: string, projectId: string, id: string) {
    await this.validateProject(tenantId, projectId);
    return this.prisma.changeOrder.update({
      where: { id },
      data: { status: 'REJECTED' },
    });
  }

  private async validateProject(tenantId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, tenantId },
    });
    if (!project) throw new NotFoundException('Projeto não encontrado');
  }
}
