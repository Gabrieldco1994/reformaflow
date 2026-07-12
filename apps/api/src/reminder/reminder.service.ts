import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateReminderDto, UpdateReminderDto } from './dto/reminder.dto';

// ponytail: avanço por contagem fixa de dias (semana=7, mês=30, ano=365) em vez de
// aritmética de calendário exata — upgrade se "todo dia 30" vs "todo mês" importar.
const RECURRENCE_DAYS: Record<string, number> = {
  DIARIA: 1,
  SEMANAL: 7,
  MENSAL: 30,
  ANUAL: 365,
};

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
    const existing = await this.findById(tenantId, projectId, id);
    const data: Record<string, unknown> = {};
    if (dto.titulo !== undefined) data.titulo = dto.titulo;
    if (dto.descricao !== undefined) data.descricao = dto.descricao;
    if (dto.data !== undefined) data.data = new Date(dto.data);
    if (dto.recorrencia !== undefined) data.recorrencia = dto.recorrencia;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.prioridade !== undefined) data.prioridade = dto.prioridade;

    // Lembrete recorrente concluído: avança pra próxima data em vez de ficar
    // parado em CONCLUIDO — "Regar X" semanal precisa reaparecer sozinho.
    const recorrencia = (dto.recorrencia ?? existing.recorrencia) as string;
    const days = RECURRENCE_DAYS[recorrencia];
    if (dto.status === 'CONCLUIDO' && days) {
      const base = dto.data !== undefined ? new Date(dto.data) : existing.data;
      const next = new Date(base);
      next.setDate(next.getDate() + days);
      data.data = next;
      data.status = 'PENDENTE';
    }

    return this.prisma.reminder.update({ where: { id }, data });
  }

  async remove(tenantId: string, projectId: string, id: string) {
    await this.findById(tenantId, projectId, id);
    await this.prisma.reminder.delete({ where: { id } });
    return { deleted: true };
  }
}
