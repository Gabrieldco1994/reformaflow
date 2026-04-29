import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMaterialPurchaseDto } from './dto/create-material-purchase.dto';

@Injectable()
export class MaterialPurchaseService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, projectId: string, dto: CreateMaterialPurchaseDto) {
    await this.validateProject(tenantId, projectId);

    const installments = dto.installments ?? 1;
    const installmentAmount = installments > 1
      ? dto.totalAmount / installments
      : dto.totalAmount;

    return this.prisma.materialPurchase.create({
      data: {
        projectId,
        roomId: dto.roomId,
        workTypeId: dto.workTypeId,
        date: new Date(dto.date),
        item: dto.item,
        store: dto.store,
        paymentMethod: dto.paymentMethod,
        totalAmount: dto.totalAmount,
        installments,
        installmentAmount,
        warrantyMonths: dto.warrantyMonths,
        hasInvoice: dto.hasInvoice ?? false,
        notes: dto.notes,
      },
      include: { room: true, workType: true },
    });
  }

  async findAllByProject(tenantId: string, projectId: string) {
    await this.validateProject(tenantId, projectId);
    return this.prisma.materialPurchase.findMany({
      where: { projectId },
      include: { room: true, workType: true },
      orderBy: { date: 'desc' },
    });
  }

  async remove(tenantId: string, projectId: string, id: string) {
    await this.validateProject(tenantId, projectId);
    await this.prisma.materialPurchase.delete({ where: { id } });
    return { deleted: true };
  }

  private async validateProject(tenantId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, tenantId },
    });
    if (!project) throw new NotFoundException('Projeto não encontrado');
  }
}
