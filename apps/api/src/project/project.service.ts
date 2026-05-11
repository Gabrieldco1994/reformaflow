import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { defaultRooms } from '@reformaflow/domain';

@Injectable()
export class ProjectService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenantId: string, dto: CreateProjectDto) {
    return this.prisma.$transaction(async (tx) => {
      const project = await tx.project.create({
        data: {
          tenantId,
          name: dto.name,
          description: dto.description,
          startDate: dto.startDate ? new Date(dto.startDate) : null,
          endDate: dto.endDate ? new Date(dto.endDate) : null,
        },
      });

      // Criar ambientes padrão
      for (let i = 0; i < defaultRooms.length; i++) {
        await tx.room.create({
          data: {
            projectId: project.id,
            name: defaultRooms[i]!,
            order: i,
          },
        });
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
        _count: { select: { receipts: true, expenses: true, cashFlow: true } },
      },
    });

    if (!project) throw new NotFoundException('Projeto não encontrado');
    return project;
  }

  async update(tenantId: string, id: string, dto: UpdateProjectDto) {
    await this.findById(tenantId, id);
    return this.prisma.project.update({
      where: { id },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.startDate !== undefined && { startDate: dto.startDate ? new Date(dto.startDate) : null }),
        ...(dto.endDate !== undefined && { endDate: dto.endDate ? new Date(dto.endDate) : null }),
      },
    });
  }

  async remove(tenantId: string, id: string) {
    await this.findById(tenantId, id);
    await this.prisma.project.delete({ where: { id } });
    return { deleted: true };
  }
}
