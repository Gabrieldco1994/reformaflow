import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateReceiptDto } from './dto/create-receipt.dto';
import { UpdateReceiptDto } from './dto/update-receipt.dto';
import { toCents } from '@reformaflow/domain';

@Injectable()
export class ReceiptService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, projectId: string, dto: CreateReceiptDto) {
    await this.validateProject(tenantId, projectId);

    return this.prisma.$transaction(async (tx) => {
      const receipt = await tx.receipt.create({
        data: {
          projectId,
          tenantId,
          valor: toCents(dto.valor),
          data: new Date(dto.data),
          tipo: dto.tipo,
          status: dto.status,
        },
      });

      await tx.cashFlowEntry.create({
        data: {
          projectId,
          tenantId,
          receiptId: receipt.id,
          valor: receipt.valor,
          tipo: 'RECEBIMENTO',
          data: receipt.data,
          categoria: receipt.tipo,
          status: receipt.status,
        },
      });

      return receipt;
    });
  }

  async findAllByProject(tenantId: string, projectId: string) {
    await this.validateProject(tenantId, projectId);
    return this.prisma.receipt.findMany({
      where: { projectId, tenantId },
      orderBy: { data: 'desc' },
    });
  }

  async update(
    tenantId: string,
    projectId: string,
    id: string,
    dto: UpdateReceiptDto,
  ) {
    await this.validateProject(tenantId, projectId);

    const existing = await this.prisma.receipt.findFirst({
      where: { id, projectId, tenantId },
    });
    if (!existing) throw new NotFoundException('Recebimento não encontrado');

    return this.prisma.$transaction(async (tx) => {
      const receipt = await tx.receipt.update({
        where: { id },
        data: {
          ...(dto.valor !== undefined && { valor: toCents(dto.valor) }),
          ...(dto.data !== undefined && { data: new Date(dto.data) }),
          ...(dto.tipo !== undefined && { tipo: dto.tipo }),
          ...(dto.status !== undefined && { status: dto.status }),
        },
      });

      await this.regenerateCashFlow(tx, receipt);

      return receipt;
    });
  }

  async remove(tenantId: string, projectId: string, id: string) {
    await this.validateProject(tenantId, projectId);

    const existing = await this.prisma.receipt.findFirst({
      where: { id, projectId, tenantId },
    });
    if (!existing) throw new NotFoundException('Recebimento não encontrado');

    return this.prisma.$transaction(async (tx) => {
      await tx.cashFlowEntry.updateMany({
        where: { receiptId: id, deletedAt: null },
        data: { deletedAt: new Date() },
      });

      await tx.receipt.update({
        where: { id },
        data: { deletedAt: new Date() },
      });

      return { deleted: true };
    });
  }

  private async regenerateCashFlow(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    receipt: { id: string; projectId: string; tenantId: string; valor: number; data: Date; tipo: string; status: string },
  ) {
    // Soft-delete existing cash flow entries for this receipt
    await tx.cashFlowEntry.updateMany({
      where: { receiptId: receipt.id, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    // Create new cash flow entry
    await tx.cashFlowEntry.create({
      data: {
        projectId: receipt.projectId,
        tenantId: receipt.tenantId,
        receiptId: receipt.id,
        valor: receipt.valor,
        tipo: 'RECEBIMENTO',
        data: receipt.data,
        categoria: receipt.tipo,
        status: receipt.status,
      },
    });
  }

  private async validateProject(tenantId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, tenantId },
    });
    if (!project) throw new NotFoundException('Projeto não encontrado');
  }
}
