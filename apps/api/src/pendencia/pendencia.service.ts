import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePendenciaDto, UpdatePendenciaDto, MovePendenciaDto } from './dto/pendencia.dto';

/** Denormalized chip-label shape returned to the client. */
export interface PendenciaDto {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: string;
  dueDate: Date | null;
  owner: string | null;
  roomId: string | null;
  roomName: string | null;
  scheduleTaskId: string | null;
  scheduleTaskNome: string | null;
  scheduleTaskNumero: number | null;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

const INCLUDE = {
  room: { select: { name: true } },
  scheduleTask: { select: { nome: true, numero: true } },
} as const;

@Injectable()
export class PendenciaService {
  constructor(private readonly prisma: PrismaService) {}

  private toDto(p: any): PendenciaDto {
    return {
      id: p.id,
      projectId: p.projectId,
      title: p.title,
      description: p.description ?? null,
      status: p.status,
      dueDate: p.dueDate ?? null,
      owner: p.owner ?? null,
      roomId: p.roomId ?? null,
      roomName: p.room?.name ?? null,
      scheduleTaskId: p.scheduleTaskId ?? null,
      scheduleTaskNome: p.scheduleTask?.nome ?? null,
      scheduleTaskNumero: p.scheduleTask?.numero ?? null,
      order: p.order,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    };
  }

  /**
   * Guards optional FK references against the OWNER project resolved from the
   * route — never trusts the client to send a matching projectId. A ref that
   * does not belong to (tenant, project) is rejected as a bad request.
   */
  private async assertRefsBelong(
    tenantId: string,
    projectId: string,
    roomId?: string | null,
    scheduleTaskId?: string | null,
  ): Promise<void> {
    if (roomId) {
      const room = await this.prisma.room.findFirst({
        where: { id: roomId, projectId },
      });
      if (!room) throw new BadRequestException('Ambiente inválido para este projeto');
    }
    if (scheduleTaskId) {
      const task = await this.prisma.scheduleTask.findFirst({
        where: { id: scheduleTaskId, projectId, tenantId },
      });
      if (!task) throw new BadRequestException('Tarefa de cronograma inválida para este projeto');
    }
  }

  async findAll(tenantId: string, projectId: string): Promise<PendenciaDto[]> {
    const rows = await this.prisma.pendencia.findMany({
      where: { tenantId, projectId },
      include: INCLUDE,
      orderBy: [{ status: 'asc' }, { order: 'asc' }, { id: 'asc' }],
    });
    return rows.map((r) => this.toDto(r));
  }

  async create(tenantId: string, projectId: string, dto: CreatePendenciaDto): Promise<PendenciaDto> {
    await this.assertRefsBelong(tenantId, projectId, dto.roomId, dto.scheduleTaskId);

    const last = await this.prisma.pendencia.findFirst({
      where: { tenantId, projectId },
      orderBy: { order: 'desc' },
      select: { order: true },
    });
    const nextOrder = (last?.order ?? -1) + 1;

    const created = await this.prisma.pendencia.create({
      data: {
        tenantId,
        projectId,
        title: dto.title,
        description: dto.description ?? null,
        status: dto.status ?? 'PENDENTE',
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
        owner: dto.owner ?? null,
        roomId: dto.roomId ?? null,
        scheduleTaskId: dto.scheduleTaskId ?? null,
        order: nextOrder,
      },
      include: INCLUDE,
    });
    return this.toDto(created);
  }

  private async findGuard(tenantId: string, projectId: string, id: string) {
    const found = await this.prisma.pendencia.findFirst({
      where: { id, tenantId, projectId },
    });
    if (!found) throw new NotFoundException('Pendência não encontrada');
    return found;
  }

  async update(tenantId: string, projectId: string, id: string, dto: UpdatePendenciaDto): Promise<PendenciaDto> {
    await this.findGuard(tenantId, projectId, id);
    await this.assertRefsBelong(tenantId, projectId, dto.roomId, dto.scheduleTaskId);

    const data: Record<string, unknown> = {};
    if (dto.title !== undefined) data.title = dto.title;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.dueDate !== undefined) data.dueDate = dto.dueDate ? new Date(dto.dueDate) : null;
    if (dto.owner !== undefined) data.owner = dto.owner;
    if (dto.roomId !== undefined) data.roomId = dto.roomId;
    if (dto.scheduleTaskId !== undefined) data.scheduleTaskId = dto.scheduleTaskId;
    if (dto.order !== undefined) data.order = dto.order;

    const updated = await this.prisma.pendencia.update({
      where: { id },
      data,
      include: INCLUDE,
    });
    return this.toDto(updated);
  }

  async move(tenantId: string, projectId: string, id: string, dto: MovePendenciaDto): Promise<PendenciaDto> {
    await this.findGuard(tenantId, projectId, id);
    const updated = await this.prisma.pendencia.update({
      where: { id },
      data: { status: dto.status, order: dto.order },
      include: INCLUDE,
    });
    return this.toDto(updated);
  }

  async remove(tenantId: string, projectId: string, id: string): Promise<{ deleted: boolean }> {
    await this.findGuard(tenantId, projectId, id);
    await this.prisma.pendencia.delete({ where: { id } });
    return { deleted: true };
  }
}
