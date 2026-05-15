import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateMaintenanceLogDto, UpdateMaintenanceLogDto } from './dto/maintenance.dto';

@Injectable()
export class MaintenanceService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(tenantId: string, projectId: string) {
    return this.prisma.maintenanceLog.findMany({
      where: { tenantId, projectId },
      orderBy: { dataRealizada: 'desc' },
    });
  }

  async findById(tenantId: string, projectId: string, id: string) {
    const log = await this.prisma.maintenanceLog.findFirst({
      where: { id, tenantId, projectId },
    });
    if (!log) throw new NotFoundException('Manutenção não encontrada');
    return log;
  }

  async create(tenantId: string, projectId: string, dto: CreateMaintenanceLogDto) {
    return this.prisma.maintenanceLog.create({
      data: {
        tenantId,
        projectId,
        tipo: dto.tipo,
        dataRealizada: new Date(dto.dataRealizada),
        dataProxima: dto.dataProxima ? new Date(dto.dataProxima) : null,
        quilometragem: dto.quilometragem,
        custo: dto.custo,
        fornecedor: dto.fornecedor,
        observacoes: dto.observacoes,
      },
    });
  }

  async update(tenantId: string, projectId: string, id: string, dto: UpdateMaintenanceLogDto) {
    await this.findById(tenantId, projectId, id);
    const data: Record<string, unknown> = {};
    if (dto.tipo !== undefined) data.tipo = dto.tipo;
    if (dto.dataRealizada !== undefined) data.dataRealizada = new Date(dto.dataRealizada);
    if (dto.dataProxima !== undefined) data.dataProxima = dto.dataProxima ? new Date(dto.dataProxima) : null;
    if (dto.quilometragem !== undefined) data.quilometragem = dto.quilometragem;
    if (dto.custo !== undefined) data.custo = dto.custo;
    if (dto.fornecedor !== undefined) data.fornecedor = dto.fornecedor;
    if (dto.observacoes !== undefined) data.observacoes = dto.observacoes;
    return this.prisma.maintenanceLog.update({ where: { id }, data });
  }

  async remove(tenantId: string, projectId: string, id: string) {
    await this.findById(tenantId, projectId, id);
    await this.prisma.maintenanceLog.delete({ where: { id } });
    return { deleted: true };
  }
}
