import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertCarInfoDto } from './dto/car-info.dto';

@Injectable()
export class CarInfoService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Valida que o projeto pertence ao tenant.
   * Falha com NotFoundException se o projeto não existir ou pertencer a outro tenant.
   */
  private async ensureProject(tenantId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, tenantId, deletedAt: null },
    });
    if (!project) throw new NotFoundException('Projeto não encontrado');
    return project;
  }

  async get(tenantId: string, projectId: string) {
    // Valida tenant ownership antes de ler carInfo
    await this.ensureProject(tenantId, projectId);

    return this.prisma.carInfo.findFirst({
      where: { projectId },
    });
  }

  async upsert(tenantId: string, projectId: string, dto: UpsertCarInfoDto) {
    // Valida tenant ownership antes de escrever
    await this.ensureProject(tenantId, projectId);

    return this.prisma.carInfo.upsert({
      where: { projectId },
      create: {
        tenantId,
        projectId,
        ...dto,
      },
      update: dto,
    });
  }
}
