import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateReminderDto, UpdateReminderDto } from './dto/reminder.dto';

@Injectable()
export class ReminderService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(tenantId: string, projectId: string) {
    return this.prisma.reminder.findMany({
      where: { tenantId, projectId },
      orderBy: { data: 'asc' },
    });
  }

  async findById(tenantId: string, projectId: string, id: string) {
    const reminder = await this.prisma.reminder.findFirst({
      where: { id, tenantId, projectId },
    });
    if (!reminder) throw new NotFoundException('Lembrete não encontrado');
    return reminder;
  }

  async create(tenantId: string, projectId: string, dto: CreateReminderDto) {
    return this.prisma.reminder.create({
      data: {
        tenantId,
        projectId,
        titulo: dto.titulo,
        descricao: dto.descricao,
        data: new Date(dto.data),
        recorrencia: dto.recorrencia ?? 'UNICA',
        status: dto.status ?? 'PENDENTE',
        prioridade: dto.prioridade ?? 'MEDIA',
      },
    });
  }

  async update(tenantId: string, projectId: string, id: string, dto: UpdateReminderDto) {
    await this.findById(tenantId, projectId, id);
    const data: Record<string, unknown> = {};
    if (dto.titulo !== undefined) data.titulo = dto.titulo;
    if (dto.descricao !== undefined) data.descricao = dto.descricao;
    if (dto.data !== undefined) data.data = new Date(dto.data);
    if (dto.recorrencia !== undefined) data.recorrencia = dto.recorrencia;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.prioridade !== undefined) data.prioridade = dto.prioridade;
    return this.prisma.reminder.update({ where: { id }, data });
  }

  async remove(tenantId: string, projectId: string, id: string) {
    await this.findById(tenantId, projectId, id);
    await this.prisma.reminder.delete({ where: { id } });
    return { deleted: true };
  }
}
