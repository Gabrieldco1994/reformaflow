import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  UpsertScheduleConfigDto,
  CreateScheduleStageDto,
  UpdateScheduleStageDto,
  CreateScheduleTaskDto,
  UpdateScheduleTaskDto,
  CreateScheduleHolidayDto,
  ImportScheduleDto,
} from './dto/schedule.dto';
import {
  recalculateAllTasks,
  calculateScheduleKPIs,
  sortScheduleByDate,
  type ScheduleDateConfig,
  type TaskForRecalc,
} from '@reformaflow/domain';

@Injectable()
export class ScheduleService {
  constructor(private prisma: PrismaService) {}

  // ─── Config ───────────────────────────────────────────
  async getConfig(projectId: string, tenantId: string) {
    return this.prisma.scheduleConfig.findFirst({
      where: { projectId, tenantId, deletedAt: null },
    });
  }

  async upsertConfig(projectId: string, tenantId: string, dto: UpsertScheduleConfigDto) {
    return this.prisma.scheduleConfig.upsert({
      where: { projectId },
      create: {
        projectId,
        tenantId,
        dataInicio: new Date(dto.dataInicio),
        trabalhaDiasUteis: dto.trabalhaDiasUteis ?? true,
        trabalhaSabados: dto.trabalhaSabados ?? false,
        linhaBaseData: dto.linhaBaseData ? new Date(dto.linhaBaseData) : null,
      },
      update: {
        dataInicio: new Date(dto.dataInicio),
        trabalhaDiasUteis: dto.trabalhaDiasUteis,
        trabalhaSabados: dto.trabalhaSabados,
        linhaBaseData: dto.linhaBaseData ? new Date(dto.linhaBaseData) : undefined,
      },
    });
  }

  // ─── Stages ───────────────────────────────────────────
  async getStages(projectId: string, tenantId: string) {
    return this.prisma.scheduleStage.findMany({
      where: { projectId, tenantId, deletedAt: null },
      include: { tasks: { where: { deletedAt: null }, orderBy: { ordem: 'asc' } } },
      orderBy: { ordem: 'asc' },
    });
  }

  async createStage(projectId: string, tenantId: string, dto: CreateScheduleStageDto) {
    return this.prisma.scheduleStage.create({
      data: { projectId, tenantId, nome: dto.nome, ordem: dto.ordem },
    });
  }

  async updateStage(id: string, dto: UpdateScheduleStageDto) {
    return this.prisma.scheduleStage.update({ where: { id }, data: dto });
  }

  async deleteStage(id: string) {
    return this.prisma.scheduleStage.delete({ where: { id } });
  }

  // ─── Tasks ────────────────────────────────────────────
  async getTasks(projectId: string, tenantId: string) {
    return this.prisma.scheduleTask.findMany({
      where: { projectId, tenantId, deletedAt: null },
      orderBy: { ordem: 'asc' },
    });
  }

  async createTask(projectId: string, tenantId: string, dto: CreateScheduleTaskDto) {
    const task = await this.prisma.scheduleTask.create({
      data: {
        projectId,
        tenantId,
        stageId: dto.stageId,
        numero: dto.numero,
        nome: dto.nome,
        duracao: dto.duracao ?? 1,
        dataInicio: dto.dataInicio ? new Date(dto.dataInicio) : null,
        predecessoras: dto.predecessoras ?? null,
        valorOrcado: dto.valorOrcado ?? null,
        custoReal: dto.custoReal ?? null,
        percentualConcluido: dto.percentualConcluido ?? 0,
        ordem: dto.ordem,
      },
    });
    await this.recalculateDates(projectId, tenantId);
    return task;
  }

  async updateTask(id: string, projectId: string, tenantId: string, dto: UpdateScheduleTaskDto) {
    const task = await this.prisma.scheduleTask.update({
      where: { id },
      data: {
        nome: dto.nome,
        duracao: dto.duracao,
        dataInicio: dto.dataInicio ? new Date(dto.dataInicio) : undefined,
        predecessoras: dto.predecessoras,
        valorOrcado: dto.valorOrcado,
        custoReal: dto.custoReal,
        percentualConcluido: dto.percentualConcluido,
        ordem: dto.ordem,
      },
    });
    await this.recalculateDates(projectId, tenantId);
    return task;
  }

  async deleteTask(id: string, projectId: string, tenantId: string) {
    await this.prisma.scheduleTask.delete({ where: { id } });
    await this.recalculateDates(projectId, tenantId);
  }

  // ─── Holidays ─────────────────────────────────────────
  async getHolidays(projectId: string, tenantId: string) {
    return this.prisma.scheduleHoliday.findMany({
      where: { projectId, tenantId, deletedAt: null },
      orderBy: { data: 'asc' },
    });
  }

  async createHoliday(projectId: string, tenantId: string, dto: CreateScheduleHolidayDto) {
    const holiday = await this.prisma.scheduleHoliday.create({
      data: { projectId, tenantId, nome: dto.nome, data: new Date(dto.data) },
    });
    await this.recalculateDates(projectId, tenantId);
    return holiday;
  }

  async deleteHoliday(id: string, projectId: string, tenantId: string) {
    await this.prisma.scheduleHoliday.delete({ where: { id } });
    await this.recalculateDates(projectId, tenantId);
  }

  // ─── Gantt (dados completos) ──────────────────────────
  async getGanttData(projectId: string, tenantId: string) {
    const [config, stages, holidays] = await Promise.all([
      this.getConfig(projectId, tenantId),
      this.getStages(projectId, tenantId),
      this.getHolidays(projectId, tenantId),
    ]);

    // Ordena cronologicamente (tarefas por data; etapas pela 1ª tarefa) em vez
    // da ordem de inserção — itens novos aparecem no lugar certo das datas/predecessoras.
    const sortedStages = sortScheduleByDate(stages);
    const allTasks = sortedStages.flatMap((s) => s.tasks);
    const kpis = calculateScheduleKPIs(allTasks);

    return { config, stages: sortedStages, holidays, kpis };
  }

  // ─── Import ───────────────────────────────────────────
  async importSchedule(projectId: string, tenantId: string, dto: ImportScheduleDto) {
    // Delete existing schedule data
    await this.prisma.scheduleTask.deleteMany({ where: { projectId } });
    await this.prisma.scheduleStage.deleteMany({ where: { projectId } });
    await this.prisma.scheduleHoliday.deleteMany({ where: { projectId } });

    // Create config
    await this.upsertConfig(projectId, tenantId, {
      dataInicio: dto.dataInicio,
      trabalhaDiasUteis: dto.trabalhaDiasUteis,
      trabalhaSabados: dto.trabalhaSabados,
    });

    // Create holidays
    if (dto.holidays) {
      for (const h of dto.holidays) {
        await this.prisma.scheduleHoliday.create({
          data: { projectId, tenantId, nome: h.nome, data: new Date(h.data) },
        });
      }
    }

    // Create stages and tasks
    let taskOrdem = 0;
    for (let i = 0; i < dto.stages.length; i++) {
      const stageDto = dto.stages[i];
      const stage = await this.prisma.scheduleStage.create({
        data: { projectId, tenantId, nome: stageDto.nome, ordem: i },
      });

      for (const taskDto of stageDto.tasks) {
        await this.prisma.scheduleTask.create({
          data: {
            projectId,
            tenantId,
            stageId: stage.id,
            numero: taskDto.numero,
            nome: taskDto.nome,
            duracao: taskDto.duracao,
            dataInicio: taskDto.dataInicio ? new Date(taskDto.dataInicio) : null,
            dataTermino: taskDto.dataTermino ? new Date(taskDto.dataTermino) : null,
            predecessoras: taskDto.predecessoras ?? null,
            valorOrcado: taskDto.valorOrcado ?? null,
            custoReal: taskDto.custoReal ?? null,
            percentualConcluido: taskDto.percentualConcluido ?? 0,
            ordem: taskOrdem++,
          },
        });
      }
    }

    // Recalculate dates
    await this.recalculateDates(projectId, tenantId);

    return this.getGanttData(projectId, tenantId);
  }

  // ─── Recálculo de Datas ───────────────────────────────
  private async recalculateDates(projectId: string, tenantId: string) {
    const config = await this.getConfig(projectId, tenantId);
    if (!config) return;

    const tasks = await this.getTasks(projectId, tenantId);
    const holidays = await this.getHolidays(projectId, tenantId);

    const dateConfig: ScheduleDateConfig = {
      trabalhaDiasUteis: config.trabalhaDiasUteis,
      trabalhaSabados: config.trabalhaSabados,
      feriados: holidays.map((h) => new Date(h.data)),
    };

    const tasksForRecalc: TaskForRecalc[] = tasks.map((t) => ({
      id: t.id,
      numero: t.numero,
      duracao: t.duracao,
      predecessoras: t.predecessoras ? JSON.parse(t.predecessoras) : [],
      dataInicio: t.dataInicio,
      dataTermino: t.dataTermino,
    }));

    const results = recalculateAllTasks(tasksForRecalc, config.dataInicio, dateConfig);

    // Batch update
    for (const r of results) {
      await this.prisma.scheduleTask.update({
        where: { id: r.id },
        data: { dataInicio: r.dataInicio, dataTermino: r.dataTermino },
      });
    }
  }
}
