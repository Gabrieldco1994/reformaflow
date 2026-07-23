import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { ExpenseType } from '@reformaflow/domain';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePendenciaDto, UpdatePendenciaDto, MovePendenciaDto } from './dto/pendencia.dto';
import { MonthlyOverviewService } from '../monthly-overview/monthly-overview.service';
import {
  MerchantClassifierService,
  MERCHANT_TO_EXPENSE_TYPE,
  type MerchantCategory,
} from '../merchant-classifier/merchant-classifier.service';

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

type FinancialQueueType =
  | 'SEM_CONTA'
  | 'SEM_CATEGORIA'
  | 'FATURA_NAO_PAGA'
  | 'PARCELA_FOREIGN_PENDENTE'
  | 'RECEBIMENTO_PREVISTO_ATRASADO'
  | 'RECEBIMENTO_SEM_CONTA';

export interface FinancialQueueItem {
  id: string;
  tipo: FinancialQueueType;
  label: string;
  descricao: string;
  valor: number;
  data: string;
  expenseId?: string;
  receiptId?: string;
  cardLast4?: string;
  dueMonth?: string;
  foreignExpenseId?: string;
  parcelaIndex?: number;
  suggestionTipoDespesa?: string;
}

export interface FinancialQueueGroup {
  tipo: FinancialQueueType;
  label: string;
  count: number;
  valorTotal: number;
  itens: FinancialQueueItem[];
}

export interface FinancialQueueResponse {
  total: number;
  grupos: FinancialQueueGroup[];
}

const INCLUDE = {
  room: { select: { name: true } },
  scheduleTask: { select: { nome: true, numero: true } },
} as const;

@Injectable()
export class PendenciaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly monthlyOverviewService: MonthlyOverviewService,
    private readonly merchantClassifierService: MerchantClassifierService,
  ) {}

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

  private static groupLabel(tipo: FinancialQueueType): string {
    if (tipo === 'SEM_CONTA') return 'Sem conta';
    if (tipo === 'SEM_CATEGORIA') return 'Sem categoria';
    if (tipo === 'FATURA_NAO_PAGA') return 'Fatura a vencer ou vencida';
    if (tipo === 'PARCELA_FOREIGN_PENDENTE') return 'Parcela cross-project pendente';
    if (tipo === 'RECEBIMENTO_SEM_CONTA') return 'Recebimento sem conta';
    return 'Recebimento previsto atrasado';
  }

  private static merchantCategoryToExpenseType(category: MerchantCategory): string {
    return MERCHANT_TO_EXPENSE_TYPE[category] ?? ExpenseType.OUTROS;
  }

  async findFinancialQueue(
    tenantId: string,
    projectId: string,
    month?: string,
  ): Promise<FinancialQueueResponse> {
    const accountView = await this.monthlyOverviewService.getAccountView(tenantId, projectId, month);

    const now = new Date();
    const sevenDays = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7);
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const semConta: FinancialQueueItem[] = accountView.saidas
      .filter((s) => !s.isInvoice && !s.cardLast4 && !s.bankLast4 && !!s.id)
      .sort((a, b) => b.valor - a.valor)
      .map((s) => ({
        id: `sem-conta-${s.id}`,
        tipo: 'SEM_CONTA',
        label: s.foreignExpenseId && s.parcelaIndex != null ? 'Quitar parcela' : 'Vincular origem',
        descricao: s.descricao,
        valor: s.valor,
        data: s.data,
        expenseId: s.id ?? undefined,
        foreignExpenseId: s.foreignExpenseId ?? undefined,
        parcelaIndex: s.parcelaIndex ?? undefined,
      }));

    const semCategoriaBase = accountView.saidas.filter(
      (s) => !s.isInvoice && !!s.id && s.tipoDespesa === ExpenseType.OUTROS,
    );
    const semCategoriaWithSuggestion: Array<FinancialQueueItem | null> = await Promise.all(
      semCategoriaBase.map(async (s) => {
        const cached = await this.merchantClassifierService.fromCache(s.descricao);
        if (!cached) return null;
        const suggested = PendenciaService.merchantCategoryToExpenseType(cached.category);
        if (suggested === ExpenseType.OUTROS) return null;
        return {
          id: `sem-categoria-${s.id}`,
          tipo: 'SEM_CATEGORIA' as const,
          label: 'Confirmar categoria',
          descricao: s.descricao,
          valor: s.valor,
          data: s.data,
          expenseId: s.id ?? undefined,
          suggestionTipoDespesa: suggested,
        } satisfies FinancialQueueItem;
      }),
    );
    const semCategoria = semCategoriaWithSuggestion
      .filter((item): item is FinancialQueueItem => item !== null)
      .sort((a, b) => b.valor - a.valor);

    const faturasNaoPagas: FinancialQueueItem[] = accountView.cartoes
      .filter((c) => c.status !== 'paga' && c.faturaPendente > 0)
      .filter((c) => {
        const dueDate = new Date(c.vencimento);
        return dueDate >= startToday && dueDate <= sevenDays;
      })
      .sort((a, b) => b.faturaPendente - a.faturaPendente)
      .map((c) => ({
        id: `fatura-${c.last4}-${c.dueMonth}`,
        tipo: 'FATURA_NAO_PAGA',
        label: 'Pagar fatura',
        descricao: `${c.nickname} ••${c.last4}`,
        valor: c.faturaPendente,
        data: c.vencimento,
        cardLast4: c.last4,
        dueMonth: c.dueMonth,
      }));

    const foreignPendentes: FinancialQueueItem[] = accountView.saidas
      .filter(
        (s) =>
          !s.isInvoice &&
          !s.realizado &&
          !!s.id &&
          !!s.foreignExpenseId &&
          s.parcelaIndex != null,
      )
      .sort((a, b) => b.valor - a.valor)
      .map((s) => ({
        id: `foreign-${s.id}`,
        tipo: 'PARCELA_FOREIGN_PENDENTE',
        label: 'Quitar parcela',
        descricao: s.descricao,
        valor: s.valor,
        data: s.data,
        expenseId: s.id ?? undefined,
        foreignExpenseId: s.foreignExpenseId ?? undefined,
        parcelaIndex: s.parcelaIndex ?? undefined,
      }));

    const recebimentosAtrasados: FinancialQueueItem[] = accountView.entradas
      .filter((r) => r.status === 'PREVISTO' && !!r.id && !!r.bankLast4)
      .filter((r) => new Date(r.data) < startToday)
      .sort((a, b) => b.valor - a.valor)
      .map((r) => ({
        id: `recebimento-${r.id}`,
        tipo: 'RECEBIMENTO_PREVISTO_ATRASADO',
        label: 'Atualizar recebimento',
        descricao: r.descricao,
        valor: r.valor,
        data: r.data,
        receiptId: r.id ?? undefined,
      }));

    // Recebimento sem conta corrente associada (nasce sem bankLast4, ex.: onboarding
    // pulou a conta). Precede o "atrasado" — primeiro associa a conta, depois atualiza.
    const recebimentosSemConta: FinancialQueueItem[] = accountView.entradas
      .filter((r) => !r.bankLast4 && !!r.id)
      .sort((a, b) => b.valor - a.valor)
      .map((r) => ({
        id: `recebimento-sem-conta-${r.id}`,
        tipo: 'RECEBIMENTO_SEM_CONTA',
        label: 'Associar conta',
        descricao: r.descricao,
        valor: r.valor,
        data: r.data,
        receiptId: r.id ?? undefined,
      }));

    const groups: Array<[FinancialQueueType, FinancialQueueItem[]]> = [
      ['SEM_CONTA', semConta],
      ['SEM_CATEGORIA', semCategoria],
      ['FATURA_NAO_PAGA', faturasNaoPagas],
      ['PARCELA_FOREIGN_PENDENTE', foreignPendentes],
      ['RECEBIMENTO_SEM_CONTA', recebimentosSemConta],
      ['RECEBIMENTO_PREVISTO_ATRASADO', recebimentosAtrasados],
    ];

    const grupos = groups
      .filter(([, itens]) => itens.length > 0)
      .map(([tipo, itens]) => ({
        tipo,
        label: PendenciaService.groupLabel(tipo),
        count: itens.length,
        valorTotal: itens.reduce((sum, item) => sum + item.valor, 0),
        itens,
      }));

    return {
      total: grupos.reduce((sum, group) => sum + group.count, 0),
      grupos,
    };
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
