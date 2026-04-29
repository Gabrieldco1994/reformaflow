import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { roomWorkTypeMatrix, workTypeCatalog } from '@reformaflow/domain';
import { WorkTypeCategory } from '@reformaflow/domain';

@Injectable()
export class ProjectService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cria projeto com seed automático de Rooms, WorkTypes e BudgetItems (87 itens)
   * Regra: cada novo projeto gera a matriz completa Ambiente × Tipo de Obra
   */
  async create(tenantId: string, dto: CreateProjectDto) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Criar projeto
      const project = await tx.project.create({
        data: {
          tenantId,
          name: dto.name,
          description: dto.description,
          totalBudget: dto.totalBudget ?? 0,
          startDate: dto.startDate ? new Date(dto.startDate) : null,
          endDate: dto.endDate ? new Date(dto.endDate) : null,
        },
      });

      // 2. Garantir WorkTypes existem (upsert global — compartilhados entre projetos)
      const workTypeMap = new Map<WorkTypeCategory, string>();
      for (const [category, name] of Object.entries(workTypeCatalog)) {
        const wt = await tx.workType.upsert({
          where: { name },
          update: {},
          create: { name, category },
        });
        workTypeMap.set(category as WorkTypeCategory, wt.id);
      }

      // 3. Criar Rooms e BudgetItems baseado na matriz da planilha
      for (let i = 0; i < roomWorkTypeMatrix.length; i++) {
        const roomSeed = roomWorkTypeMatrix[i]!;
        const room = await tx.room.create({
          data: {
            projectId: project.id,
            name: roomSeed.name,
            order: i,
          },
        });

        // Criar BudgetItems para cada WorkType do ambiente
        const budgetItemsData = roomSeed.workTypes.map((category) => ({
          projectId: project.id,
          roomId: room.id,
          workTypeId: workTypeMap.get(category)!,
          planned: 0,
        }));

        await tx.budgetItem.createMany({ data: budgetItemsData });
      }

      return this.findById(tenantId, project.id);
    });
  }

  async findAll(tenantId: string) {
    return this.prisma.project.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(tenantId: string, id: string) {
    const project = await this.prisma.project.findFirst({
      where: { id, tenantId },
      include: {
        rooms: { orderBy: { order: 'asc' } },
        _count: { select: { budgetItems: true, contractors: true, purchases: true } },
      },
    });

    if (!project) throw new NotFoundException('Projeto não encontrado');
    return project;
  }

  async update(tenantId: string, id: string, dto: UpdateProjectDto) {
    await this.findById(tenantId, id); // valida existência e tenant
    return this.prisma.project.update({
      where: { id },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.totalBudget !== undefined && { totalBudget: dto.totalBudget }),
        ...(dto.startDate !== undefined && { startDate: dto.startDate ? new Date(dto.startDate) : null }),
        ...(dto.endDate !== undefined && { endDate: dto.endDate ? new Date(dto.endDate) : null }),
      },
    });
  }

  async remove(tenantId: string, id: string) {
    await this.findById(tenantId, id);
    // Soft delete via Prisma middleware
    await this.prisma.project.delete({ where: { id } });
    return { deleted: true };
  }
}
