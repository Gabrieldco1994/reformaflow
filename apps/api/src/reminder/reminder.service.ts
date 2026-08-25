import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { monthlyDueDate } from '@reformaflow/domain';
import { PrismaService } from '../prisma/prisma.service';
import { CreateReminderDto, UpdateReminderDto } from './dto/reminder.dto';

// DIARIA/SEMANAL: soma de dias corridos é aritmética de calendário exata
// (nenhum mês tem comprimento variável em "dias"), não precisa de clamp.
const FIXED_DAY_RECURRENCES: Record<string, number> = {
  DIARIA: 1,
  SEMANAL: 7,
};

// MENSAL/ANUAL: "+30 dias"/"+365 dias" dá drift (pula fevereiro, desliza em
// ano bissexto). Usa `monthlyDueDate` (mesma aritmética do financiamento,
// packages/domain/src/calculations/loan-schedule.ts): mesmo dia-do-mês,
// clampado ao último dia do mês-alvo quando ele for mais curto. ANUAL é só
// MENSAL com passo de 12 meses (mesmo mês/dia todo ano, clamp cobre 29/02
// bissexto -> 28/02 em ano comum de graça).
const CYCLE_MONTHS: Record<string, number> = {
  MENSAL: 1,
  ANUAL: 12,
};

/**
 * Avança `base` para a próxima ocorrência da `recorrencia` que seja >= `now`.
 * Sempre avança pelo menos um ciclo. Se o lembrete ficou N ciclos sem ser
 * concluído (R2 — lembrete atrasado), continua avançando ciclo a ciclo até
 * a data resultante não ficar mais no passado, em vez de travar em
 * "base + 1 ciclo" (que ainda poderia estar atrás de `now`).
 *
 * Decisão de produto (documentada no PR): o "dia-base" usado a cada ciclo é
 * sempre o dia-do-mês de `base` (a `data` atual do lembrete no momento desta
 * chamada) — o modelo `Reminder` não guarda um "dia âncora" separado. Uma
 * cadeia de conclusões consecutivas em que o dia foi clampado (ex.: 31 -> 30
 * num mês de 30 dias) reparte da data já clampada na conclusão seguinte,
 * podendo perder o dia 31 original ao longo de várias conclusões. Aceitável
 * para este escopo: garante correção dentro de uma única chamada (sem
 * overshoot pro passado, sem `Invalid Date`), não uma cadeia longa sem
 * nenhum drift.
 *
 * Retorna `null` para recorrências não cíclicas (UNICA / desconhecida) — o
 * caller decide o que fazer (hoje: não avança, só marca CONCLUIDO).
 */
function advanceRecurrence(base: Date, recorrencia: string, now: Date): Date | null {
  const fixedDays = FIXED_DAY_RECURRENCES[recorrencia];
  if (fixedDays) {
    // UTC, não local: `setDate`/`getDate` usam o fuso do processo — em
    // TZ != UTC, uma `base` perto da virada de dia pode deslizar um dia
    // inteiro dependendo do fuso do runtime. `Date` já armazena um instante
    // absoluto; usar os acessores UTC evita esse drift sem depender de onde
    // o processo Node está rodando.
    const next = new Date(base);
    next.setUTCDate(next.getUTCDate() + fixedDays);
    while (next.getTime() < now.getTime()) {
      next.setUTCDate(next.getUTCDate() + fixedDays);
    }
    return next;
  }

  const cycleMonths = CYCLE_MONTHS[recorrencia];
  if (cycleMonths) {
    const day = base.getUTCDate();
    let offset = cycleMonths;
    let next = monthlyDueDate(base, offset, day);
    while (next.getTime() < now.getTime()) {
      offset += cycleMonths;
      next = monthlyDueDate(base, offset, day);
    }
    return next;
  }

  return null;
}

@Injectable()
export class ReminderService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(tenantId: string, projectId: string) {
    const reminders = await this.prisma.reminder.findMany({
      where: { tenantId, projectId },
      orderBy: { data: 'asc' },
      include: { plant: { select: { id: true, nome: true, deletedAt: true } } },
    });
    // O middleware de soft-delete ($use em prisma.service.ts) só intercepta a
    // ação de nível superior da query (aqui, `Reminder.findMany`) — ele NÃO
    // filtra relações trazidas via `include` na mesma query, porque essas não
    // passam por uma ação Prisma própria para o middleware interceptar
    // (confirmado empiricamente: uma Plant soft-deletada ainda volta no
    // include, com `deletedAt` preenchido). Se um Reminder vivo ainda aponta
    // pra uma Plant apagada, nulificamos aqui em vez de vazar a planta morta
    // pro consumidor de `findAll` — a UI não deve linkar pra uma planta que
    // não existe mais.
    return reminders.map((r) => ({
      ...r,
      plant: r.plant && !r.plant.deletedAt ? { id: r.plant.id, nome: r.plant.nome } : null,
    }));
  }

  async findById(tenantId: string, projectId: string, id: string) {
    const reminder = await this.prisma.reminder.findFirst({
      where: { id, tenantId, projectId },
    });
    if (!reminder) throw new NotFoundException('Lembrete não encontrado');
    return reminder;
  }

  async create(tenantId: string, projectId: string, dto: CreateReminderDto) {
    if (dto.plantId) {
      // Nunca confiar cegamente num plantId vindo do cliente — vetor de
      // vazamento cross-tenant se não validar tenantId+projectId (mesmo
      // padrão de plants-ai.service.ts:212).
      const plant = await this.prisma.plant.findFirst({
        where: { id: dto.plantId, tenantId, projectId },
      });
      if (!plant) throw new NotFoundException('Planta não encontrada');
    }
    return this.prisma.reminder.create({
      data: {
        tenantId,
        projectId,
        plantId: dto.plantId ?? null,
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
    if (existing.generatedBy === 'VEHICLE_DOCUMENT') {
      throw new ConflictException(
        'Este lembrete é gerenciado pelo documento do veículo',
      );
    }
    const data: Record<string, unknown> = {};
    if (dto.titulo !== undefined) data.titulo = dto.titulo;
    if (dto.descricao !== undefined) data.descricao = dto.descricao;
    if (dto.data !== undefined) data.data = new Date(dto.data);
    if (dto.recorrencia !== undefined) data.recorrencia = dto.recorrencia;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.prioridade !== undefined) data.prioridade = dto.prioridade;

    // Lembrete recorrente concluído: avança pra próxima data em vez de ficar
    // parado em CONCLUIDO — "Regar X" semanal precisa reaparecer sozinho.
    // A próxima ocorrência nunca fica no passado (R2), mesmo que o lembrete
    // tenha ficado vários ciclos sem ser concluído.
    const recorrencia = (dto.recorrencia ?? existing.recorrencia) as string;
    if (dto.status === 'CONCLUIDO') {
      const base = dto.data !== undefined ? new Date(dto.data) : existing.data;
      const next = advanceRecurrence(base, recorrencia, new Date());
      if (next) {
        data.data = next;
        data.status = 'PENDENTE';
      }
    }

    return this.prisma.reminder.update({ where: { id }, data });
  }

  async remove(tenantId: string, projectId: string, id: string) {
    const existing = await this.findById(tenantId, projectId, id);
    if (existing.generatedBy === 'VEHICLE_DOCUMENT') {
      throw new ConflictException(
        'Este lembrete é gerenciado pelo documento do veículo',
      );
    }
    await this.prisma.reminder.delete({ where: { id } });
    return { deleted: true };
  }
}
