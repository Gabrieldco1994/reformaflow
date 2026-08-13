import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ConciliacaoService, RateioItem, SettleParcelaInput } from '../conciliacao/conciliacao.service';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { UpdateExpenseDto } from './dto/update-expense.dto';
import { CreateRecorrenteDto } from './dto/create-recorrente.dto';
import { ExpenseTypeLabels, LaborCategoryLabels, buildInstallments, buildRecurrenceDates, isRecurrenceFrequency, isSinglePaymentForm, isNeutralExpenseType, hasFeature, normalizeInstallmentDateOverrides, parseInstallmentDateOnlyUtc, parseInstallmentDateOverrides, setInstallmentDateOverride, PaymentForm, ProjectType, type RecurrenceFrequency } from '@reformaflow/domain';
import { RatearMixedDto } from './dto/ratear-mixed.dto';
import { Prisma } from '@prisma/client';
import { fastClassify } from '../bank-account/bank-account.service';
import { RateioDetalhe, RateioRequester } from './rateio.types';
import { userCanAccessProject, userCanAccessProjectType } from '../common/access-rules';

type ExpenseDb = PrismaService | Prisma.TransactionClient;
type RateioParticipation = 'source' | 'target' | null;

const RATEIO_PARTICIPANT_MUTATION_MESSAGE =
  'Esta despesa participa de um rateio. Altere valores, status, cronograma, recorrência ou vínculos pelo fluxo dedicado do rateio.';
const RATEIO_TARGET_DELETE_MESSAGE =
  'Esta despesa é alvo de rateio. Desfaça o rateio na compra fonte antes de removê-la.';
const SETTLEMENT_PARTICIPANT_MUTATION_MESSAGE =
  'Esta despesa participa de uma conciliação cross-project por parcela. Altere valores, status, cronograma ou vínculos pelo fluxo dedicado: Cartões/Contas → cartão ou conta → Vincular → Desvincular.';
const SETTLEMENT_TARGET_DELETE_MESSAGE =
  'Esta despesa é alvo de conciliação por parcela. Desvincule a fonte antes de removê-la: Cartões/Contas → cartão ou conta → Vincular → Desvincular.';

export interface UpdateInstallmentDateResult {
  id: string;
  parcela: number;
  data: string;
  isOverride: boolean;
  affectedProjectIds: string[];
}

@Injectable()
export class ExpenseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conciliacao: ConciliacaoService,
  ) {}

  /**
   * Resolve creditCardId/bankAccountId/linkedExpenseId em valores armazenáveis.
   * - creditCardId → cardLast4 (denormalizado)
   * - bankAccountId → bankLast4 + accountId (denormalizado + FK)
   * - linkedExpenseId → valida que pertence ao mesmo tenant e que NÃO é do projeto atual
   * Retorna { cardLast4?, bankLast4?, accountId?, linkedExpenseId? } com null explícito para "limpar".
   */
  private async resolveLinks(
    tenantId: string,
    currentProjectId: string,
    dto: Pick<CreateExpenseDto, 'creditCardId' | 'bankAccountId' | 'linkedExpenseId' | 'settlesInvoiceCardId' | 'settlesInvoiceDueMonth'>,
    db: ExpenseDb = this.prisma,
  ): Promise<{
    cardLast4?: string | null;
    bankLast4?: string | null;
    accountId?: string | null;
    linkedExpenseId?: string | null;
    settlesInvoiceKey?: string | null;
  }> {
    // Parallel queries for better performance
    const [cardRow, accRow, linkedRow, settlesCardRow] = await Promise.all([
      dto.creditCardId && dto.creditCardId !== null && dto.creditCardId !== ''
        ? db.creditCard.findFirst({
            where: { id: dto.creditCardId, tenantId, deletedAt: null },
            select: { last4: true },
          })
        : null,
      dto.bankAccountId && dto.bankAccountId !== null && dto.bankAccountId !== ''
        ? db.bankAccount.findFirst({
            where: { id: dto.bankAccountId, tenantId, deletedAt: null },
            select: { id: true, last4: true },
          })
        : null,
      dto.linkedExpenseId && dto.linkedExpenseId !== null && dto.linkedExpenseId !== ''
        ? db.expense.findFirst({
            where: { id: dto.linkedExpenseId, tenantId, deletedAt: null },
            select: { projectId: true },
          })
        : null,
      dto.settlesInvoiceCardId && dto.settlesInvoiceCardId !== null && dto.settlesInvoiceCardId !== ''
        ? db.creditCard.findFirst({
            where: { id: dto.settlesInvoiceCardId, tenantId, deletedAt: null },
            select: { last4: true },
          })
        : null,
    ]);

    const out: {
      cardLast4?: string | null;
      bankLast4?: string | null;
      accountId?: string | null;
      linkedExpenseId?: string | null;
      settlesInvoiceKey?: string | null;
    } = {};

    if (dto.creditCardId !== undefined) {
      if (!dto.creditCardId) {
        out.cardLast4 = null;
      } else if (!cardRow) {
        throw new BadRequestException('Cartão de crédito não encontrado neste tenant');
      } else {
        out.cardLast4 = cardRow.last4 ?? null;
      }
    }

    if (dto.bankAccountId !== undefined) {
      if (!dto.bankAccountId) {
        out.bankLast4 = null;
        out.accountId = null;
      } else if (!accRow) {
        throw new BadRequestException('Conta bancária não encontrada neste tenant');
      } else {
        out.bankLast4 = accRow.last4 ?? null;
        out.accountId = accRow.id;
      }
    }

    if (dto.linkedExpenseId !== undefined) {
      if (!dto.linkedExpenseId) {
        out.linkedExpenseId = null;
      } else if (!linkedRow) {
        throw new BadRequestException('Despesa vinculada não encontrada neste tenant');
      } else if (linkedRow.projectId === currentProjectId) {
        throw new BadRequestException('Vínculo cross-project requer despesa de outro projeto');
      } else {
        out.linkedExpenseId = dto.linkedExpenseId;
      }
    }

    if (dto.settlesInvoiceCardId !== undefined) {
      if (!dto.settlesInvoiceCardId) {
        out.settlesInvoiceKey = null;
      } else if (!settlesCardRow) {
        throw new BadRequestException('Cartão da fatura quitada não encontrado neste tenant');
      } else if (!dto.settlesInvoiceDueMonth) {
        throw new BadRequestException('Informe o mês de vencimento (settlesInvoiceDueMonth) da fatura quitada');
      } else {
        out.settlesInvoiceKey = `${settlesCardRow.last4}:${dto.settlesInvoiceDueMonth}`;
      }
    }

    return out;
  }

  async create(
    tenantId: string,
    projectId: string,
    dto: CreateExpenseDto,
    createdByUserId: string | null = null,
    tx?: Prisma.TransactionClient,
  ) {
    const db = tx ?? this.prisma;
    await this.validateProject(tenantId, projectId, db);

    const valorCents = Math.round(dto.valor * 100);
    const valorTotal = valorCents * dto.quantidade;

    const links = await this.resolveLinks(tenantId, projectId, dto, db);

    // Determine origin: 'import' if has card/bank link, else 'none'
    const origin =
      links.cardLast4 || links.bankLast4 ? 'import' : 'none';

    const expense = await db.expense.create({
      data: {
        projectId,
        tenantId,
        createdByUserId,
        tipoDespesa: dto.tipoDespesa,
        categoriaMaoDeObra: dto.categoriaMaoDeObra,
        roomId: dto.roomId,
        valor: valorCents,
        quantidade: dto.quantidade,
        valorTotal,
        titulo: dto.titulo,
        fornecedor: dto.fornecedor,
        link: dto.link,
        imageUrl: dto.imageUrl,
        formaPagamento: dto.formaPagamento,
        dataPagamento: dto.dataPagamento ? new Date(dto.dataPagamento) : null,
        quantidadeParcela: dto.quantidadeParcela,
        dataInicioParcela: dto.dataInicioParcela ? new Date(dto.dataInicioParcela) : null,
        dataCompra: dto.dataCompra ? new Date(dto.dataCompra) : null,
        status: dto.status,
        recorrente: dto.recorrente ?? false,
        recorrenciaFim: dto.recorrenciaFim ? new Date(dto.recorrenciaFim) : null,
        recurrenceKey: dto.recurrenceKey ?? null,
        cardLast4: links.cardLast4 ?? undefined,
        bankLast4: links.bankLast4 ?? undefined,
        accountId: links.accountId ?? undefined,
        origin,
        linkedExpenseId: links.linkedExpenseId ?? undefined,
        settlesInvoiceKey: links.settlesInvoiceKey ?? undefined,
      },
      include: { room: true },
    });

    try {
      await this.regenerateCashFlow(expense.id, tx);
    } catch (error) {
      if (tx) throw error;

      const deletedAt = new Date();
      await this.prisma.$transaction([
        this.prisma.cashFlowEntry.updateMany({
          where: { expenseId: expense.id, deletedAt: null },
          data: { deletedAt },
        }),
        this.prisma.expense.updateMany({
          where: { id: expense.id, tenantId, projectId, deletedAt: null },
          data: { deletedAt },
        }),
      ]);
      throw error;
    }

    return expense;
  }

  /**
   * Cria uma DESPESA RECORRENTE: materializa N despesas planejadas independentes
   * (uma por ocorrência) entre `dataInicio` e `dataFim`, na frequência escolhida
   * (MENSAL/QUINZENAL). Cada ocorrência é uma despesa À_VISTA/PLANEJADO normal —
   * reusa `create` (links de cartão/conta, cashflow, competência) e portanto entra
   * automaticamente em TODOS os KPIs, Visão Conta e cockpit, como qualquer despesa.
   * Editar o valor de uma ocorrência é um PATCH normal (cada uma é independente).
   *
   * Cross-project (`obraProjectId`): quando informado, cada ocorrência gera um PAR
   * vinculado — a despesa CANÔNICA no projeto de obra + o ESPELHO no PESSOAL (com
   * cartão/conta), ligados por `linkedExpenseId`, sem dupla contagem. Espelha o
   * padrão de `create_obra_expense`, repetido por ocorrência. Se qualquer criação
   * falhar, TODAS as já criadas são desfeitas (transação lógica).
   */
  async createRecorrente(
    tenantId: string,
    projectId: string,
    dto: CreateRecorrenteDto,
    createdByUserId: string | null = null,
  ) {
    await this.validateProject(tenantId, projectId);

    if (!isRecurrenceFrequency(dto.frequencia)) {
      throw new BadRequestException('Frequência inválida. Use MENSAL ou QUINZENAL.');
    }
    const inicio = new Date(dto.dataInicio);
    const fim = new Date(dto.dataFim);
    if (Number.isNaN(inicio.getTime()) || Number.isNaN(fim.getTime())) {
      throw new BadRequestException('Datas de recorrência inválidas.');
    }

    const dates = buildRecurrenceDates({
      inicio,
      fim,
      frequencia: dto.frequencia as RecurrenceFrequency,
    });
    if (dates.length === 0) {
      throw new BadRequestException('Período inválido: a data final é anterior à inicial.');
    }

    // Modo cross-project: valida o projeto de obra (deve existir, ser do tenant e
    // NÃO ser o próprio projeto pessoal informado na URL).
    const crossProject = dto.obraProjectId && dto.obraProjectId !== projectId;
    if (crossProject) {
      const obra = await this.prisma.project.findFirst({
        where: { id: dto.obraProjectId, tenantId, deletedAt: null },
        select: { id: true, type: true },
      });
      if (!obra) throw new BadRequestException('Projeto de obra não encontrado neste tenant.');
      if (obra.type === 'PESSOAL') {
        throw new BadRequestException('O projeto de obra não pode ser PESSOAL. Deixe em branco para recorrência pessoal.');
      }
    }

    const quantidade = dto.quantidade && dto.quantidade >= 1 ? dto.quantidade : 1;

    // Carimbo da série: identidade EXPLÍCITA da recorrência. Sem ele a série só
    // existiria como palpite (agrupar por título/cadência), e uma recorrência
    // curta ou renomeada desapareceria da tela de gestão.
    const recurrenceKey = `rec_${randomUUID()}`;

    // Rastreia TUDO que foi criado (projectId + id) para rollback total em falha.
    const createdRefs: Array<{ projectId: string; id: string }> = [];
    const rollback = async () => {
      for (const ref of createdRefs.reverse()) {
        await this.remove(tenantId, ref.projectId, ref.id).catch(() => undefined);
      }
    };

    try {
      for (const d of dates) {
        const iso = d.toISOString();

        if (crossProject) {
          // 1) Canônica na obra (sem meio de pagamento) — PLANEJADO.
          const canonico = await this.create(tenantId, dto.obraProjectId!, {
            tipoDespesa: dto.tipoDespesa,
            categoriaMaoDeObra: dto.categoriaMaoDeObra,
            roomId: dto.roomId,
            valor: dto.valor,
            quantidade,
            titulo: dto.titulo,
            fornecedor: dto.fornecedor,
            link: dto.link,
            imageUrl: dto.imageUrl,
            formaPagamento: 'A_VISTA',
            status: 'PLANEJADO',
            dataPagamento: iso,
            dataCompra: iso,
            recurrenceKey,
          } as CreateExpenseDto, createdByUserId);
          createdRefs.push({ projectId: dto.obraProjectId!, id: canonico.id });

          // 2) Espelho no PESSOAL (saída do caixa) vinculado à canônica.
          const espelho = await this.create(tenantId, projectId, {
            tipoDespesa: dto.tipoDespesa,
            categoriaMaoDeObra: dto.categoriaMaoDeObra,
            valor: dto.valor,
            quantidade,
            titulo: dto.titulo,
            fornecedor: dto.fornecedor,
            formaPagamento: 'A_VISTA',
            status: 'PLANEJADO',
            dataPagamento: iso,
            dataCompra: iso,
            creditCardId: dto.creditCardId,
            bankAccountId: dto.bankAccountId,
            linkedExpenseId: canonico.id,
            recurrenceKey,
          } as CreateExpenseDto, createdByUserId);
          createdRefs.push({ projectId: projectId, id: espelho.id });
        } else {
          const expense = await this.create(tenantId, projectId, {
            tipoDespesa: dto.tipoDespesa,
            categoriaMaoDeObra: dto.categoriaMaoDeObra,
            roomId: dto.roomId,
            valor: dto.valor,
            quantidade,
            titulo: dto.titulo,
            fornecedor: dto.fornecedor,
            link: dto.link,
            imageUrl: dto.imageUrl,
            formaPagamento: 'A_VISTA',
            status: 'PLANEJADO',
            dataPagamento: iso,
            dataCompra: iso,
            creditCardId: dto.creditCardId,
            bankAccountId: dto.bankAccountId,
            recurrenceKey,
          } as CreateExpenseDto, createdByUserId);
          createdRefs.push({ projectId: projectId, id: expense.id });
        }
      }
    } catch (e) {
      await rollback();
      throw e;
    }

    return {
      count: dates.length,
      crossProject: !!crossProject,
      frequencia: dto.frequencia,
      dataInicio: dto.dataInicio,
      dataFim: dto.dataFim,
      ids: createdRefs.map((r) => r.id),
    };
  }

  async findAll(
    tenantId: string,
    projectId: string,
    opts: { page?: number; pageSize?: number } = {},
  ) {
    await this.validateProject(tenantId, projectId);

    const pageSize = Math.min(Math.max(opts.pageSize ?? 100, 10), 2000);
    const page = Math.max(opts.page ?? 1, 1);
    const skip = (page - 1) * pageSize;

    const where: Prisma.ExpenseWhereInput = {
      projectId,
      tenantId,
      deletedAt: null,
      settledByExpenseId: null,
    };

    const [items, total] = await Promise.all([
      this.prisma.expense.findMany({
        where,
        include: { room: true },
        orderBy: { createdAt: 'desc' },
        take: pageSize,
        skip,
      }),
      this.prisma.expense.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.max(Math.ceil(total / pageSize), 1),
    };
  }

  async findPlanned(tenantId: string, projectId: string) {
    await this.validateProject(tenantId, projectId);

    return this.prisma.expense.findMany({
      where: {
        projectId,
        tenantId,
        deletedAt: null,
        status: 'PLANEJADO',
        settledByExpenseId: null,
      },
      include: { room: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Lista despesas de OUTROS projetos do mesmo tenant — base para o seletor
   * cross-project no formulário e para a aba "Outras despesas".
   * Suporta busca textual leve (titulo/fornecedor) e filtro por projectId.
   */
  async findCrossProject(
    tenantId: string,
    currentProjectId: string,
    opts: { search?: string; projectId?: string; status?: 'PLANEJADO' | 'PAGO'; limit?: number } = {},
  ) {
    await this.validateProject(tenantId, currentProjectId);
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 2000);
    const where: Prisma.ExpenseWhereInput = {
      tenantId,
      deletedAt: null,
      settledByExpenseId: null,
      NOT: { projectId: currentProjectId },
    };
    if (opts.projectId) where.projectId = opts.projectId;
    if (opts.status) where.status = opts.status;
    if (opts.search && opts.search.trim()) {
      const s = opts.search.trim();
      where.OR = [
        { titulo: { contains: s } },
        { fornecedor: { contains: s } },
      ];
    }
    return this.prisma.expense.findMany({
      where,
      include: {
        room: true,
        project: { select: { id: true, name: true, type: true } },
      },
      orderBy: [{ createdAt: 'desc' }],
      take: limit,
    });
  }

  /** Vincula esta despesa a uma despesa de outro projeto (cross-project). */
  async linkCrossProject(tenantId: string, projectId: string, id: string, targetExpenseId: string) {
    await this.validateProject(tenantId, projectId);
    const source = await this.prisma.expense.findFirst({
      where: { id, projectId, tenantId, deletedAt: null },
    });
    if (!source) throw new NotFoundException('Despesa não encontrada');
    // I1: esta rota dedicada reaponta `linkedExpenseId` do mesmo jeito que o
    // PATCH genérico — precisa da mesma guarda. Só bloqueia quando o alvo
    // EFETIVO mudaria (idempotência do mesmo alvo continua permitida).
    if (source.linkedExpenseId !== targetExpenseId) {
      await this.guardRateioParticipation(tenantId, id, false, false);
      await this.guardSettlementParticipation(tenantId, id, false, true);
    }
    const target = await this.prisma.expense.findFirst({
      where: { id: targetExpenseId, tenantId, deletedAt: null },
      select: { projectId: true },
    });
    if (!target) throw new BadRequestException('Despesa alvo não encontrada');
    if (target.projectId === projectId) {
      throw new BadRequestException('Vínculo cross-project requer despesa de outro projeto');
    }
    return this.prisma.expense.update({
      where: { id },
      data: { linkedExpenseId: targetExpenseId },
      include: { room: true },
    });
  }

  async unlinkCrossProject(tenantId: string, projectId: string, id: string) {
    await this.validateProject(tenantId, projectId);
    const source = await this.prisma.expense.findFirst({
      where: { id, projectId, tenantId, deletedAt: null },
    });
    if (!source) throw new NotFoundException('Despesa não encontrada');
    await this.guardRateioParticipation(tenantId, id, false, false);
    await this.guardSettlementParticipation(tenantId, id, false, true);
    return this.prisma.expense.update({
      where: { id },
      data: { linkedExpenseId: null },
      include: { room: true },
    });
  }

  /**
   * I1: uma fonte com ≥1 RateioAllocation deve manter `linkedExpenseId` != null —
   * é o único ponteiro que faz `monthly-overview.service.ts` deduplicá-la do
   * consolidado. Limpar/reapontar o vínculo enquanto o rateio existe conta a
   * compra em dobro (fonte + as N planejadas rateadas). Chamar ANTES de
   * qualquer escrita nos pontos de mutação (`update`, `unlinkCrossProject`).
   * A guarda também cobre alvos, para centralizar todas as mutações genéricas.
   */
  private async guardRateioParticipation(
    tenantId: string,
    expenseId: string,
    allowSource: boolean,
    allowTarget: boolean,
    db: ExpenseDb = this.prisma,
  ): Promise<RateioParticipation> {
    const rows = await db.rateioAllocation.findMany({
      where: {
        tenantId,
        OR: [{ sourceExpenseId: expenseId }, { targetExpenseId: expenseId }],
      },
      select: { sourceExpenseId: true, targetExpenseId: true },
    });
    const isSource = rows.some((row) => row.sourceExpenseId === expenseId);
    const isTarget = rows.some((row) => row.targetExpenseId === expenseId);
    if ((isSource && !allowSource) || (isTarget && !allowTarget)) {
      throw new BadRequestException(
        isTarget && allowSource ? RATEIO_TARGET_DELETE_MESSAGE : RATEIO_PARTICIPANT_MUTATION_MESSAGE,
      );
    }
    return isSource ? 'source' : isTarget ? 'target' : null;
  }

  /**
   * Espelho de `guardRateioParticipation`, mas para `CrossProjectSettlement`
   * (conciliação por parcela via 'Vincular transações'). Tabela e mensagens de
   * remediação são diferentes — mantido como função separada por design (não
   * mesclar). Nunca lança quando ambos os flags allow são true.
   */
  private async guardSettlementParticipation(
    tenantId: string,
    expenseId: string,
    allowSource: boolean,
    allowTarget: boolean,
    db: ExpenseDb = this.prisma,
  ): Promise<RateioParticipation> {
    const rows = await db.crossProjectSettlement.findMany({
      where: {
        tenantId,
        OR: [{ sourceExpenseId: expenseId }, { targetExpenseId: expenseId }],
      },
      select: { sourceExpenseId: true, targetExpenseId: true },
    });
    const isSource = rows.some((row) => row.sourceExpenseId === expenseId);
    const isTarget = rows.some((row) => row.targetExpenseId === expenseId);
    if ((isSource && !allowSource) || (isTarget && !allowTarget)) {
      throw new BadRequestException(
        isTarget && allowSource
          ? SETTLEMENT_TARGET_DELETE_MESSAGE
          : SETTLEMENT_PARTICIPANT_MUTATION_MESSAGE,
      );
    }
    return isSource ? 'source' : isTarget ? 'target' : null;
  }

  /**
   * Gêmeo em service do ProjectAccessGuard, aplicado por ALVO: o guard só
   * enxerga `params.projectId` (a fonte) — os projetos-alvo do rateio entram
   * por FK e nunca passaram por ele. Compõe EXATAMENTE as mesmas duas regras
   * do guard para não divergir. Fail-closed: sem requester, nada é visível.
   */
  private canRequesterSeeProject(
    requester: RateioRequester | undefined,
    project: { id: string; type: string } | null | undefined,
  ): boolean {
    if (!requester || !project) return false;
    return (
      userCanAccessProject(requester.role, requester.allowedProjects, project.id) &&
      userCanAccessProjectType(
        requester.role,
        requester.allowedProjectTypes,
        requester.allowedModules ?? [],
        project.type,
      )
    );
  }

  /**
   * Leitura canônica do rateio por uma âncora fonte ou alvo (issues #423/#428):
   * resolve SOURCE > TARGET > NONE e enumera TODAS as `RateioAllocation` da
   * fonte (não apenas o alvo apontado por `linkedExpenseId`, que é só o
   * primeiro), incluindo as de alvo soft-deletado — I4: o `$use` de soft-delete
   * não filtra `RateioAllocation` nem seu `include.target`.
   * Somente leitura (I7): nenhuma escrita, nenhuma transação.
   *
   * O guard global só valida o projeto da âncora. Ao abrir por um alvo, a fonte
   * também precisa estar na lente; falhas nessa resolução viram 404 genérico.
   * Demais alvos ATIVOS fora da lente (ou de outro tenant) viram contadores
   * ocultos, mas seus valores continuam em `rateadoCents`. Alvo removido é
   * avaliado ANTES da lente (I-F): removido é sempre `removed`, nunca `hidden`.
   */
  async getRateio(
    tenantId: string,
    projectId: string,
    id: string,
    requester: RateioRequester,
  ): Promise<RateioDetalhe> {
    const anchor = await this.prisma.expense.findFirst({
      where: { id, projectId, tenantId, deletedAt: null },
      include: { project: { select: { id: true, type: true, tenantId: true } } },
    });
    if (
      !anchor ||
      anchor.projectId !== projectId ||
      anchor.tenantId !== tenantId ||
      anchor.deletedAt !== null
    ) {
      throw new NotFoundException('Despesa não encontrada');
    }
    if (!anchor.project || anchor.project.tenantId !== tenantId) {
      // I-G na fonte: não confirma existência a um requester de outro tenant.
      throw new NotFoundException('Despesa não encontrada');
    }
    if (!this.canRequesterSeeProject(requester, anchor.project)) {
      // Defesa em profundidade: o guard global já deveria ter barrado isto,
      // mas o service não confia cegamente no caminho de entrada.
      throw new ForbiddenException('Sem permissao para acessar este projeto');
    }

    let source = anchor;
    let sourceExpenseId = anchor.id;
    let allocations = await this.prisma.rateioAllocation.findMany({
      where: { tenantId, sourceExpenseId: id },
      include: {
        target: {
          include: {
            project: { select: { id: true, name: true, type: true, tenantId: true } },
          },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { targetExpenseId: 'asc' }],
    });

    // SOURCE > TARGET > NONE: uma despesa que já é fonte canônica nunca é
    // reinterpretada como alvo, mesmo diante de dados legados incompatíveis.
    if (allocations.length === 0) {
      const targetMapping = await this.prisma.rateioAllocation.findFirst({
        where: { tenantId, targetExpenseId: anchor.id },
        select: { sourceExpenseId: true },
      });
      if (targetMapping) {
        const mappedSource = await this.prisma.expense.findFirst({
          where: {
            id: targetMapping.sourceExpenseId,
            tenantId,
            deletedAt: null,
            project: { tenantId, deletedAt: null },
          },
          include: { project: { select: { id: true, type: true, tenantId: true } } },
        });
        if (
          !mappedSource ||
          mappedSource.tenantId !== tenantId ||
          mappedSource.deletedAt !== null ||
          !mappedSource.project ||
          mappedSource.project.tenantId !== tenantId ||
          !this.canRequesterSeeProject(requester, mappedSource.project)
        ) {
          // Abrir por um alvo nunca confirma a existência nem a ACL da fonte.
          throw new NotFoundException('Despesa não encontrada');
        }

        source = mappedSource;
        sourceExpenseId = mappedSource.id;
        allocations = await this.prisma.rateioAllocation.findMany({
          where: { tenantId, sourceExpenseId },
          include: {
            target: {
              include: {
                project: { select: { id: true, name: true, type: true, tenantId: true } },
              },
            },
          },
          orderBy: [{ createdAt: 'asc' }, { targetExpenseId: 'asc' }],
        });
      }
    }

    // Reforça a ordem determinística em memória (createdAt asc, targetExpenseId
    // asc como desempate total) — não depende só do driver honrar o orderBy.
    allocations.sort((a, b) => {
      const byCreatedAt = a.createdAt.getTime() - b.createdAt.getTime();
      return byCreatedAt !== 0 ? byCreatedAt : a.targetExpenseId.localeCompare(b.targetExpenseId);
    });

    let removedTargetsCount = 0;
    let hiddenTargetsCount = 0;
    let hiddenAllocationCents = 0;
    const items: RateioDetalhe['items'] = [];
    for (const a of allocations) {
      if (a.target.deletedAt !== null) {
        // I-F: removido vence — nunca reclassificado como oculto (senão seu
        // valor entraria em rateadoCents e a sobra real desapareceria).
        removedTargetsCount += 1;
        continue;
      }
      const p = a.target.project;
      const sameTenant =
        a.tenantId === tenantId && a.target.tenantId === tenantId && p?.tenantId === tenantId;
      if (!sameTenant || !this.canRequesterSeeProject(requester, p)) {
        // I-G/I-E: corrupção cross-tenant ou alvo fora da lente — some do
        // payload individualmente, mas conta e soma continuam expostas.
        hiddenTargetsCount += 1;
        hiddenAllocationCents += a.allocation;
        continue;
      }
      items.push({
        targetExpenseId: a.targetExpenseId,
        titulo: a.target.titulo,
        fornecedor: a.target.fornecedor,
        projectId: a.target.project.id,
        projectName: a.target.project.name,
        projectType: a.target.project.type,
        allocationCents: a.allocation,
        plannedValorTotalCents: a.plannedValorTotal ?? null,
        status: a.target.status,
      });
    }

    const visibleCents = items.reduce((sum, i) => sum + i.allocationCents, 0);
    const rateadoCents = visibleCents + hiddenAllocationCents; // I-A/I-D
    const totalSourceCents = source.valorTotal;

    return {
      sourceExpenseId,
      rateado: allocations.length > 0,
      totalSourceCents,
      rateadoCents,
      sobraCents: totalSourceCents - rateadoCents,
      removedTargetsCount,
      hiddenTargetsCount,
      hiddenAllocationCents,
      items,
    };
  }


  /**
   * Concilia esta despesa (source, PESSOAL) com UMA parcela de uma despesa
   * planejada em outro projeto (Fase 6 — vínculo manual por parcela). Liquida a
   * parcela alvo com o valor REAL (default = valorTotal da source), de forma
   * não-destrutiva e reversível. Mantém o `linkedExpenseId` para dedupe.
   */
  async conciliarParcela(
    tenantId: string,
    projectId: string,
    sourceId: string,
    params: { targetExpenseId: string; parcelaIndex?: number; realValor?: number },
  ) {
    await this.validateProject(tenantId, projectId);
    const source = await this.prisma.expense.findFirst({
      where: { id: sourceId, projectId, tenantId, deletedAt: null },
    });
    if (!source) throw new NotFoundException('Despesa não encontrada');

    // P4 — o valor real da liquidação é o valorTotal do ESPELHO (source). O
    // espelho representa o pagamento efetivo daquela quitação; usar o valorTotal
    // faz o override do alvo CASAR com o que aparece no caixa PESSOAL (I10).
    // Quando o chamador informa realValor explícito, ele prevalece.
    const parcelaIndex = params.parcelaIndex ?? 0;
    const realValor = params.realValor ?? source.valorTotal;

    // O clamp do índice vive em settleTargetParcela; passamos o índice cru e
    // lemos de volta o índice EFETIVO (clampado) para o retorno (E2).
    const settleInput: SettleParcelaInput = {
      tenantId,
      sourceExpenseId: source.id,
      targetExpenseId: params.targetExpenseId,
      parcelaIndex,
      realValor,
    };

    await this.prisma.$transaction(async (tx) => {
      await this.conciliacao.settleTargetParcela(tx, settleInput);
    });

    return {
      ok: true,
      sourceId: source.id,
      targetId: params.targetExpenseId,
      parcelaIndex: settleInput._effective ?? parcelaIndex,
    };
  }

  /**
   * Desfaz a conciliação (todas as parcelas liquidadas por esta source),
   * restaurando o planejado do alvo e limpando o vínculo. Reversível.
   */
  async desconciliar(tenantId: string, projectId: string, sourceId: string) {
    await this.validateProject(tenantId, projectId);
    const source = await this.prisma.expense.findFirst({
      where: { id: sourceId, projectId, tenantId, deletedAt: null },
    });
    if (!source) throw new NotFoundException('Despesa não encontrada');

    await this.prisma.$transaction(async (tx) => {
      await this.conciliacao.reverseSourceLinks(tx, { tenantId, sourceExpenseId: source.id });
    });
    return { ok: true };
  }

  /**
   * Rateia ESTA compra (source, PESSOAL) entre várias despesas PLANEJADAS de
   * outro projeto (ex.: compra parcelada na Telhanorte distribuída entre itens
   * da reforma). Cada alvo recebe o cronograma da fonte escalado à sua alocação.
   * A soma das alocações deve fechar o total da compra (Sobra = 0).
   */
  async ratear(
    tenantId: string,
    projectId: string,
    sourceId: string,
    allocations: RateioItem[],
  ) {
    await this.validateProject(tenantId, projectId);
    const source = await this.prisma.expense.findFirst({
      where: { id: sourceId, projectId, tenantId, deletedAt: null },
    });
    if (!source) throw new NotFoundException('Despesa não encontrada');

    const result = await this.prisma.$transaction(async (tx) =>
      this.conciliacao.ratearSource(tx, {
        tenantId,
        sourceExpenseId: source.id,
        allocations,
      }),
    );
    return { ok: true, sourceId: source.id, ...result };
  }

  /**
   * Rateio "mixed": cria N alvos NOVOS nos projetos-destino e rateia a compra
   * (source) entre eles + alvos EXISTENTES, tudo numa ÚNICA transação atômica.
   * Se o `ratearSource` falhar (Sobra != 0, alvo neutro/já-rateado etc.), a
   * transação inteira faz rollback e nenhum alvo novo permanece órfão.
   *
   * Não reimplementa o rateio: apenas orquestra a criação dos alvos e delega ao
   * `ConciliacaoService.ratearSource`, que valida Sobra=0, regenera o cashflow
   * de cada alvo com o cronograma da fonte e seta o espelho (linkedExpenseId).
   */
  async ratearMixed(
    tenantId: string,
    projectId: string,
    sourceId: string,
    dto: RatearMixedDto,
    createdByUserId: string | null = null,
  ) {
    await this.validateProject(tenantId, projectId);
    const source = await this.prisma.expense.findFirst({
      where: { id: sourceId, projectId, tenantId, deletedAt: null },
    });
    if (!source) throw new NotFoundException('Despesa não encontrada');

    const newTargets = dto.newTargets ?? [];
    const existing = dto.existing ?? [];
    if (newTargets.length + existing.length === 0) {
      throw new BadRequestException('Nada a ratear: informe ao menos um alvo (novo ou existente).');
    }

    // Valida os projetos-destino dos alvos novos ANTES de abrir a transação:
    // pertencem ao tenant e possuem o módulo `expenses` (CASA/CARRO também têm;
    // rejeitamos apenas projetos genuinamente sem o módulo). Reads fora da tx;
    // as ESCRITAS (create + rateio) acontecem atômicas dentro dela.
    if (newTargets.length > 0) {
      const targetProjectIds = [...new Set(newTargets.map((t) => t.targetProjectId))];
      const projects = await this.prisma.project.findMany({
        where: { id: { in: targetProjectIds }, tenantId },
      });
      const byId = new Map(projects.map((p) => [p.id, p]));
      for (const pid of targetProjectIds) {
        const p = byId.get(pid);
        if (!p) throw new NotFoundException(`Projeto destino ${pid} não encontrado`);
        if (!hasFeature(p.type as ProjectType, 'expenses')) {
          throw new BadRequestException(
            `Projeto destino ${pid} não possui o módulo de despesas — não pode receber rateio.`,
          );
        }
      }
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // Re-read inside the transaction. A stale pre-transaction read allowed
      // two rapid requests to create two mirror sets for the same source.
      const sourceInTx = await tx.expense.findFirst({
        where: { id: source.id, tenantId, projectId, deletedAt: null },
        select: { id: true, linkedExpenseId: true },
      });
      if (!sourceInTx) throw new NotFoundException('Despesa não encontrada');
      if (sourceInTx.linkedExpenseId) {
        throw new BadRequestException('Esta despesa já está vinculada a outro projeto.');
      }

      const createdTargetIds: string[] = [];
      const allocations: RateioItem[] = existing.map((e) => ({
        targetExpenseId: e.targetExpenseId,
        allocation: e.allocation,
      }));

      for (const nt of newTargets) {
        const valorCents = Math.round(nt.valor * 100);
        const quantidade = nt.quantidade ?? 1;
        const valorTotal = valorCents * quantidade;

        const created = await tx.expense.create({
          data: {
            projectId: nt.targetProjectId,
            tenantId,
            createdByUserId,
            tipoDespesa: nt.tipoDespesa,
            categoriaMaoDeObra: nt.categoriaMaoDeObra,
            roomId: nt.roomId,
            valor: valorCents,
            quantidade,
            valorTotal,
            titulo: nt.titulo,
            fornecedor: nt.fornecedor,
            formaPagamento: nt.formaPagamento ?? PaymentForm.A_VISTA,
            // Herda o status da FONTE para coerência do espelho: fonte PAGO → alvo PAGO.
            status: nt.status ?? source.status,
          },
        });
        createdTargetIds.push(created.id);
        allocations.push({ targetExpenseId: created.id, allocation: nt.allocation });
      }

      // Delega ao rateio existente: valida Sobra=0, regenera cashflow dos alvos
      // (o cashflow base do alvo novo é gerado aqui, a partir do cronograma da
      // fonte) e seta o espelho. Roda sob o MESMO `tx` → atomicidade real.
      const rateio = await this.conciliacao.ratearSource(tx, {
        tenantId,
        sourceExpenseId: source.id,
        allocations,
      });

      return { createdTargetIds, targets: rateio.targets };
    });

    return { ok: true, sourceId: source.id, ...result };
  }

  /**
   * Desfaz o rateio desta compra: restaura o planejado de cada alvo e limpa o
   * espelho da fonte. Reversível e idempotente.
   */
  async desratear(tenantId: string, projectId: string, sourceId: string) {
    await this.validateProject(tenantId, projectId);
    const source = await this.prisma.expense.findFirst({
      where: { id: sourceId, projectId, tenantId, deletedAt: null },
    });
    if (!source) throw new NotFoundException('Despesa não encontrada');

    const result = await this.prisma.$transaction(async (tx) =>
      this.conciliacao.unratearSource(tx, { tenantId, sourceExpenseId: source.id }),
    );
    return { ok: true, sourceId: source.id, ...result };
  }

  async findById(tenantId: string, projectId: string, id: string) {
    await this.validateProject(tenantId, projectId);

    const expense = await this.prisma.expense.findFirst({
      where: { id, projectId, tenantId, deletedAt: null },
      include: { room: true },
    });
    if (!expense) throw new NotFoundException('Despesa não encontrada');

    return expense;
  }

  /**
   * Reclassifica despesas existentes do projeto rodando o `fastClassify` sobre o
   * `titulo` de cada uma. Só atualiza quando: (a) o tipo atual está na lista de
   * "genéricos" (OUTROS, COMPRAS_DEBITO, etc.) — para não sobrescrever escolhas
   * manuais do usuário; e (b) o classifier retorna um tipo novo, diferente.
   *
   * Útil após adicionar novas regras ao fastClassify ou para corrigir despesas
   * importadas em lote (ex.: reseed do master que veio tudo como COMPRAS_DEBITO).
   * Também atualiza o `categoria` dos CashFlowEntry vinculados para manter o
   * cockpit consistente.
   */
  async reclassifyByMerchant(
    tenantId: string,
    projectId: string,
    opts: { onlyGeneric?: boolean; dryRun?: boolean } = {},
  ) {
    await this.validateProject(tenantId, projectId);
    const onlyGeneric = opts.onlyGeneric ?? true;
    const dryRun = opts.dryRun ?? false;

    const GENERIC_TYPES = new Set(['OUTROS', 'COMPRAS_DEBITO', 'COMPRAS_VAREJO']);
    const where: Prisma.ExpenseWhereInput = {
      projectId,
      tenantId,
      deletedAt: null,
      settledByExpenseId: null,
      linkedExpenseId: null,
    };
    if (onlyGeneric) where.tipoDespesa = { in: Array.from(GENERIC_TYPES) };

    const items = await this.prisma.expense.findMany({
      where,
      select: { id: true, titulo: true, fornecedor: true, tipoDespesa: true },
    });

    const updates: Array<{ id: string; from: string; to: string; titulo: string | null }> = [];
    for (const e of items) {
      const merchant = (e.titulo ?? e.fornecedor ?? '').trim();
      if (!merchant) continue;
      const suggested = fastClassify(merchant);
      if (!suggested) continue;
      if (suggested === e.tipoDespesa) continue;
      // Não reclassifica para tipos neutros (espelho/transferência/mov interna)
      if (isNeutralExpenseType(suggested)) continue;
      updates.push({ id: e.id, from: e.tipoDespesa, to: suggested, titulo: e.titulo });
    }

    if (!dryRun && updates.length > 0) {
      // Em lotes para não estourar o pool de conexões. Atualiza Expense + CashFlowEntry.
      const CHUNK = 50;
      for (let i = 0; i < updates.length; i += CHUNK) {
        const chunk = updates.slice(i, i + CHUNK);
        await this.prisma.$transaction([
          ...chunk.map((u) =>
            this.prisma.expense.update({
              where: { id: u.id },
              data: { tipoDespesa: u.to },
            }),
          ),
          ...chunk.map((u) =>
            this.prisma.cashFlowEntry.updateMany({
              where: { expenseId: u.id, deletedAt: null },
              data: { categoria: u.to },
            }),
          ),
        ]);
      }
    }

    // Resumo por tipo destino (para o response)
    const byTo: Record<string, number> = {};
    for (const u of updates) byTo[u.to] = (byTo[u.to] ?? 0) + 1;

    return {
      candidates: items.length,
      reclassified: dryRun ? 0 : updates.length,
      dryRunChanges: dryRun ? updates.length : undefined,
      byTipoDespesa: byTo,
      samples: updates.slice(0, 10).map((u) => ({ titulo: u.titulo, from: u.from, to: u.to })),
      dryRun,
    };
  }

  async update(tenantId: string, projectId: string, id: string, dto: UpdateExpenseDto) {
    await this.validateProject(tenantId, projectId);

    const existing = await this.prisma.expense.findFirst({
      where: { id, projectId, tenantId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Despesa não encontrada');

    const valorCents = dto.valor !== undefined ? Math.round(dto.valor * 100) : existing.valor;
    const quantidade = dto.quantidade !== undefined ? dto.quantidade : existing.quantidade;
    const valorTotal = valorCents * quantidade;

    const links = await this.resolveLinks(tenantId, projectId, dto);
    const sameDate = (current: Date | null, incoming: string | null | undefined): boolean =>
      incoming === undefined ||
      (incoming === null ? current === null : current?.getTime() === new Date(incoming).getTime());
    const changedFormaPagamento =
      dto.formaPagamento !== undefined && dto.formaPagamento !== existing.formaPagamento;
    const changedDataPagamento = !sameDate(existing.dataPagamento, dto.dataPagamento);
    const changedQuantidadeParcela =
      dto.quantidadeParcela !== undefined &&
      (dto.quantidadeParcela ?? null) !== (existing.quantidadeParcela ?? null);
    const changedDataInicioParcela = !sameDate(
      existing.dataInicioParcela,
      dto.dataInicioParcela,
    );
    const changedStatus = dto.status !== undefined && dto.status !== existing.status;
    const changedValor = dto.valor !== undefined && valorCents !== existing.valor;
    const changedQuantidade =
      dto.quantidade !== undefined && dto.quantidade !== existing.quantidade;
    const changedRecorrente =
      dto.recorrente !== undefined && !!dto.recorrente !== existing.recorrente;
    const changedRecorrenciaFim = !sameDate(existing.recorrenciaFim, dto.recorrenciaFim);
    const changedRecurrenceKey =
      dto.recurrenceKey !== undefined &&
      (dto.recurrenceKey ?? null) !== (existing.recurrenceKey ?? null);
    const changedOwnership =
      (links.cardLast4 !== undefined && links.cardLast4 !== (existing.cardLast4 ?? null)) ||
      (links.bankLast4 !== undefined && links.bankLast4 !== (existing.bankLast4 ?? null)) ||
      (links.accountId !== undefined && links.accountId !== (existing.accountId ?? null)) ||
      (links.linkedExpenseId !== undefined &&
        links.linkedExpenseId !== (existing.linkedExpenseId ?? null)) ||
      (links.settlesInvoiceKey !== undefined &&
        links.settlesInvoiceKey !== (existing.settlesInvoiceKey ?? null));
    const changedToNeutralType =
      dto.tipoDespesa !== undefined &&
      dto.tipoDespesa !== existing.tipoDespesa &&
      isNeutralExpenseType(dto.tipoDespesa);
    const hasProtectedChange =
      changedFormaPagamento ||
      changedDataPagamento ||
      changedQuantidadeParcela ||
      changedDataInicioParcela ||
      changedStatus ||
      changedValor ||
      changedQuantidade ||
      changedRecorrente ||
      changedRecorrenciaFim ||
      changedRecurrenceKey ||
      changedOwnership ||
      changedToNeutralType;
    const rateioParticipation = await this.guardRateioParticipation(
      tenantId,
      id,
      !hasProtectedChange,
      !hasProtectedChange,
    );
    await this.guardSettlementParticipation(tenantId, id, !hasProtectedChange, !hasProtectedChange);

    const resultingFormaPagamento = dto.formaPagamento ?? existing.formaPagamento;
    const resultingQuantidadeParcela =
      dto.quantidadeParcela === undefined ? existing.quantidadeParcela : dto.quantidadeParcela;
    const resultingDataPagamento =
      dto.dataPagamento === undefined
        ? existing.dataPagamento
        : dto.dataPagamento === null ? null : new Date(dto.dataPagamento);
    const resultingDataInicioParcela =
      dto.dataInicioParcela === undefined
        ? existing.dataInicioParcela
        : dto.dataInicioParcela === null ? null : new Date(dto.dataInicioParcela);
    const shouldNormalizeInstallmentDateOverrides =
      changedFormaPagamento ||
      changedDataPagamento ||
      changedQuantidadeParcela ||
      changedDataInicioParcela;
    const installmentDateOverrides = shouldNormalizeInstallmentDateOverrides
      ? normalizeInstallmentDateOverrides({
          valorTotal,
          formaPagamento: resultingFormaPagamento,
          dataPagamento: resultingDataPagamento,
          quantidadeParcela: resultingQuantidadeParcela,
          dataInicioParcela: resultingDataInicioParcela,
          installmentDateOverrides: existing.installmentDateOverrides,
        })
      : undefined;

    // Mudanças em status agregado, forma, valor ou config de parcelamento
    // invalidam os índices de parcelas pagas — limpa para evitar estado stale.
    const resetPaidParcelas =
      changedStatus ||
      changedFormaPagamento ||
      changedQuantidadeParcela ||
      changedValor ||
      changedQuantidade ||
      changedDataInicioParcela;

    const expense = await this.prisma.expense.update({
      where: { id },
      data: {
        tipoDespesa: dto.tipoDespesa,
        categoriaMaoDeObra: dto.categoriaMaoDeObra,
        roomId: dto.roomId,
        valor: valorCents,
        quantidade,
        valorTotal,
        titulo: dto.titulo,
        fornecedor: dto.fornecedor,
        link: dto.link,
        imageUrl: dto.imageUrl,
        formaPagamento: dto.formaPagamento,
        dataPagamento:
          dto.dataPagamento === undefined
            ? undefined
            : dto.dataPagamento === null
              ? null
              : new Date(dto.dataPagamento),
        quantidadeParcela: dto.quantidadeParcela,
        dataInicioParcela:
          dto.dataInicioParcela === undefined
            ? undefined
            : dto.dataInicioParcela === null
              ? null
              : new Date(dto.dataInicioParcela),
        dataCompra:
          dto.dataCompra === undefined
            ? undefined
            : dto.dataCompra === null
              ? null
              : new Date(dto.dataCompra),
        status: dto.status,
        recorrente: dto.recorrente === undefined ? undefined : !!dto.recorrente,
        recorrenciaFim:
          dto.recorrenciaFim === undefined
            ? undefined
            : dto.recorrenciaFim === null
              ? null
              : new Date(dto.recorrenciaFim),
        ...(resetPaidParcelas ? { paidParcelas: null } : {}),
        ...(shouldNormalizeInstallmentDateOverrides ? { installmentDateOverrides } : {}),
        cardLast4: links.cardLast4,
        bankLast4: links.bankLast4,
        linkedExpenseId: links.linkedExpenseId,
        settlesInvoiceKey: links.settlesInvoiceKey,
      },
      include: { room: true },
    });

    await this.regenerateCashFlow(expense.id);

    // "Uma coisa só": se esta despesa faz parte de um par cross-project (canônico
    // na obra + espelho no PESSOAL, criado pelo fluxo de obra paga com caixa
    // pessoal), editar um lado deve refletir no outro. Propaga apenas campos da
    // COMPRA (data, valor, parcelas, status, tipo, título); campos por-lado (meio
    // de pagamento, sala, ponteiro de vínculo, anexos) NÃO são sincronizados.
    if (!rateioParticipation) {
      await this.syncLinkedObraPair(
        tenantId,
        id,
        dto,
        shouldNormalizeInstallmentDateOverrides,
      );
    }

    return expense;
  }

  async updateInstallmentDate(
    tenantId: string,
    projectId: string,
    id: string,
    parcela: number,
    data: string,
  ): Promise<UpdateInstallmentDateResult> {
    const parsedDate = parseInstallmentDateOnlyUtc(data);
    if (!parsedDate) throw new BadRequestException('Data de parcela inválida');

    return this.prisma.$transaction(async (tx) => {
      await this.validateProject(tenantId, projectId, tx);
      const expense = await tx.expense.findFirst({
        where: { id, projectId, tenantId, deletedAt: null },
        include: { room: true },
      });
      if (!expense) throw new NotFoundException('Despesa não encontrada');
      if (isSinglePaymentForm(expense.formaPagamento)) {
        throw new BadRequestException('Despesa não é parcelada/quinzenal');
      }
      const installmentCount = Math.max(expense.quantidadeParcela ?? 1, 1);
      if (!Number.isInteger(parcela) || parcela < 0 || parcela >= installmentCount) {
        throw new BadRequestException('Índice de parcela inválido');
      }

      const targetRateio = await tx.rateioAllocation.findFirst({
        where: { tenantId, targetExpenseId: expense.id },
      });
      if (targetRateio) {
        throw new BadRequestException(
          'Esta despesa é alvo de rateio. Edite a data na compra fonte do rateio.',
        );
      }

      const settlements = await tx.crossProjectSettlement.findMany({
        where: {
          tenantId,
          OR: [{ sourceExpenseId: expense.id }, { targetExpenseId: expense.id }],
        },
      });
      if (settlements.some((row) => row.sourceExpenseId === expense.id)) {
        throw new BadRequestException(
          'A fonte real conciliada não pode ter a data alterada aqui. Edite a parcela planejada alvo.',
        );
      }
      const isSettlementTarget = settlements.some(
        (row) => row.targetExpenseId === expense.id,
      );

      const nextOverrides = this.withInstallmentDate(expense, parcela, parsedDate);
      await tx.expense.update({
        where: { id: expense.id },
        data: { installmentDateOverrides: nextOverrides },
        include: { room: true },
      });
      const affectedProjectIds = new Set<string>([expense.projectId]);
      const result = (): UpdateInstallmentDateResult => ({
        id: expense.id,
        parcela,
        data: parsedDate.toISOString().slice(0, 10),
        isOverride: parseInstallmentDateOverrides(
          nextOverrides,
          installmentCount,
        ).has(parcela),
        affectedProjectIds: [...affectedProjectIds].sort(),
      });

      if (isSettlementTarget) {
        await this.conciliacao.regenerateTargetCashflow(tx, expense.id);
      } else {
        await this.regenerateCashFlow(expense.id, tx);
      }

      const sourceRateios = await tx.rateioAllocation.findMany({
        where: { tenantId, sourceExpenseId: expense.id },
        include: {
          target: {
            select: {
              id: true,
              projectId: true,
              tenantId: true,
              deletedAt: true,
            },
          },
        },
      });
      if (sourceRateios.length > 0) {
        for (const allocation of sourceRateios) {
          if (
            allocation.target.tenantId !== tenantId ||
            allocation.target.deletedAt
          ) {
            continue;
          }
          await tx.expense.update({
            where: { id: allocation.target.id },
            data: { installmentDateOverrides: nextOverrides },
          });
          affectedProjectIds.add(allocation.target.projectId);
          await this.conciliacao.regenerateRateioTargetCashflow(
            tx,
            allocation.target.id,
          );
        }
        return result();
      }

      if (!isSettlementTarget) {
        const counterpartIds = new Set<string>();
        if (expense.linkedExpenseId) counterpartIds.add(expense.linkedExpenseId);
        const mirrors = await tx.expense.findMany({
          where: { tenantId, linkedExpenseId: expense.id, deletedAt: null },
          select: { id: true },
        });
        for (const mirror of mirrors) counterpartIds.add(mirror.id);

        for (const counterpartId of counterpartIds) {
          const counterpartSettlements = await tx.crossProjectSettlement.findMany({
            where: {
              tenantId,
              OR: [
                { sourceExpenseId: counterpartId },
                { targetExpenseId: counterpartId },
              ],
            },
          });
          if (counterpartSettlements.length > 0) continue;
          const counterpart = await tx.expense.findFirst({
            where: { id: counterpartId, tenantId, deletedAt: null },
            include: { room: true },
          });
          if (!counterpart) continue;
          if (
            isSinglePaymentForm(counterpart.formaPagamento) ||
            parcela >= Math.max(counterpart.quantidadeParcela ?? 1, 1)
          ) {
            throw new BadRequestException('Par vinculado possui parcelamento incompatível');
          }
          const counterpartOverrides = this.withInstallmentDate(
            counterpart,
            parcela,
            parsedDate,
          );
          await tx.expense.update({
            where: { id: counterpart.id },
            data: { installmentDateOverrides: counterpartOverrides },
          });
          affectedProjectIds.add(counterpart.projectId);
          await this.regenerateCashFlow(counterpart.id, tx);
        }
      }

      return result();
    });
  }

  private withInstallmentDate(
    expense: {
      valorTotal: number;
      formaPagamento: string;
      dataPagamento: Date | null;
      quantidadeParcela: number | null;
      dataInicioParcela: Date | null;
      installmentDateOverrides: string | null;
    },
    parcela: number,
    data: Date,
  ): string | null {
    return setInstallmentDateOverride(
      {
        valorTotal: expense.valorTotal,
        formaPagamento: expense.formaPagamento,
        dataPagamento: expense.dataPagamento,
        quantidadeParcela: expense.quantidadeParcela,
        dataInicioParcela: expense.dataInicioParcela,
        installmentDateOverrides: expense.installmentDateOverrides,
      },
      parcela,
      data,
    );
  }

  private async syncLinkedObraPair(
    tenantId: string,
    sourceId: string,
    dto: UpdateExpenseDto,
    shouldSyncInstallmentDateOverrides: boolean,
  ) {
    const involvedInSettlement = async (expenseId: string) =>
      (await this.prisma.crossProjectSettlement.count({
        where: { tenantId, OR: [{ sourceExpenseId: expenseId }, { targetExpenseId: expenseId }] },
      })) > 0;

    // Pares de CONCILIAÇÃO (importação de fatura) têm unlink reversível próprio —
    // não sincronizamos para não interferir no fluxo de conciliação.
    if (await involvedInSettlement(sourceId)) return;

    const source = await this.prisma.expense.findFirst({
      where: { id: sourceId, tenantId, deletedAt: null },
      select: { id: true, linkedExpenseId: true, installmentDateOverrides: true },
    });
    if (!source) return;

    const counterpartIds = new Set<string>();
    if (source.linkedExpenseId) {
      const target = await this.prisma.expense.findFirst({
        where: { id: source.linkedExpenseId, tenantId, deletedAt: null },
        select: { id: true },
      });
      if (target && !(await involvedInSettlement(target.id))) counterpartIds.add(target.id);
    }
    const mirrors = await this.prisma.expense.findMany({
      where: { tenantId, linkedExpenseId: sourceId, deletedAt: null },
      select: { id: true },
    });
    for (const m of mirrors ?? []) {
      if (!(await involvedInSettlement(m.id))) counterpartIds.add(m.id);
    }
    if (counterpartIds.size === 0) return;

    const shared: Record<string, unknown> = {};
    if (shouldSyncInstallmentDateOverrides) {
      shared.installmentDateOverrides = source.installmentDateOverrides;
    }
    if (dto.tipoDespesa !== undefined) shared.tipoDespesa = dto.tipoDespesa;
    if (dto.categoriaMaoDeObra !== undefined) shared.categoriaMaoDeObra = dto.categoriaMaoDeObra;
    if (dto.titulo !== undefined) shared.titulo = dto.titulo;
    if (dto.fornecedor !== undefined) shared.fornecedor = dto.fornecedor;
    if (dto.formaPagamento !== undefined) shared.formaPagamento = dto.formaPagamento;
    if (dto.quantidadeParcela !== undefined) shared.quantidadeParcela = dto.quantidadeParcela;
    if (dto.status !== undefined) shared.status = dto.status;
    if (dto.dataPagamento !== undefined)
      shared.dataPagamento = dto.dataPagamento === null ? null : new Date(dto.dataPagamento);
    if (dto.dataInicioParcela !== undefined)
      shared.dataInicioParcela =
        dto.dataInicioParcela === null ? null : new Date(dto.dataInicioParcela);
    if (dto.dataCompra !== undefined)
      shared.dataCompra = dto.dataCompra === null ? null : new Date(dto.dataCompra);
    if (dto.recorrente !== undefined) shared.recorrente = !!dto.recorrente;
    if (dto.recorrenciaFim !== undefined)
      shared.recorrenciaFim = dto.recorrenciaFim === null ? null : new Date(dto.recorrenciaFim);

    const resetPaidParcelas =
      dto.status !== undefined ||
      dto.formaPagamento !== undefined ||
      dto.quantidadeParcela !== undefined ||
      dto.valor !== undefined ||
      dto.quantidade !== undefined ||
      dto.dataInicioParcela !== undefined;

    for (const cid of counterpartIds) {
      const cp = await this.prisma.expense.findUnique({
        where: { id: cid },
        select: { valor: true, quantidade: true },
      });
      if (!cp) continue;

      const data: Record<string, unknown> = { ...shared };
      if (dto.valor !== undefined) data.valor = Math.round(dto.valor * 100);
      if (dto.quantidade !== undefined) data.quantidade = dto.quantidade;
      const newValor = (data.valor as number | undefined) ?? cp.valor;
      const newQtd = (data.quantidade as number | undefined) ?? cp.quantidade;
      data.valorTotal = newValor * newQtd;
      if (resetPaidParcelas) data.paidParcelas = null;

      await this.prisma.expense.update({ where: { id: cid }, data });
      await this.regenerateCashFlow(cid);
    }
  }

  async payPlanned(tenantId: string, projectId: string, id: string, dto: UpdateExpenseDto) {
    await this.validateProject(tenantId, projectId);

    const planned = await this.prisma.expense.findFirst({
      where: { id, projectId, tenantId, deletedAt: null },
    });
    if (!planned) throw new NotFoundException('Despesa não encontrada');
    await this.guardRateioParticipation(tenantId, id, false, false);
    if (planned.status !== 'PLANEJADO') {
      throw new BadRequestException('Despesa não está planejada');
    }
    if (planned.settledByExpenseId) {
      throw new BadRequestException('Despesa já foi liquidada');
    }
    if (this.parsePaidParcelas(planned.paidParcelas, planned.quantidadeParcela ?? 1).length > 0) {
      throw new BadRequestException(
        'Despesa tem parcelas pagas individualmente. Quite as parcelas restantes pelo status de cada parcela.',
      );
    }

    const valorCents = dto.valor !== undefined ? Math.round(dto.valor * 100) : planned.valor;
    const quantidade = dto.quantidade !== undefined ? dto.quantidade : planned.quantidade;
    const valorTotal = valorCents * quantidade;

    return this.prisma.$transaction(async (tx) => {
      // Create paid expense clone
      const paidExpense = await tx.expense.create({
        data: {
          projectId,
          tenantId,
          createdByUserId: planned.createdByUserId ?? null,
          tipoDespesa: dto.tipoDespesa ?? planned.tipoDespesa,
          categoriaMaoDeObra: dto.categoriaMaoDeObra ?? planned.categoriaMaoDeObra,
          roomId: dto.roomId ?? planned.roomId,
          valor: valorCents,
          quantidade,
          valorTotal,
          titulo: dto.titulo ?? planned.titulo,
          fornecedor: dto.fornecedor ?? planned.fornecedor,
          link: dto.link ?? planned.link,
          imageUrl: dto.imageUrl ?? planned.imageUrl,
          formaPagamento: dto.formaPagamento ?? planned.formaPagamento,
          dataPagamento: dto.dataPagamento ? new Date(dto.dataPagamento) : planned.dataPagamento,
          quantidadeParcela: dto.quantidadeParcela ?? planned.quantidadeParcela,
          dataInicioParcela: dto.dataInicioParcela ? new Date(dto.dataInicioParcela) : planned.dataInicioParcela,
          installmentDateOverrides: normalizeInstallmentDateOverrides({
            valorTotal,
            formaPagamento: dto.formaPagamento ?? planned.formaPagamento,
            dataPagamento: dto.dataPagamento ? new Date(dto.dataPagamento) : planned.dataPagamento,
            quantidadeParcela: dto.quantidadeParcela ?? planned.quantidadeParcela,
            dataInicioParcela: dto.dataInicioParcela ? new Date(dto.dataInicioParcela) : planned.dataInicioParcela,
            installmentDateOverrides: planned.installmentDateOverrides,
          }),
          status: 'PAGO',
          plannedExpenseId: planned.id,
        },
        include: { room: true },
      });

      // Mark original as settled
      await tx.expense.update({
        where: { id: planned.id },
        data: { settledByExpenseId: paidExpense.id },
      });

      // Soft-delete cash flow entries from planned expense
      await tx.cashFlowEntry.updateMany({
        where: { expenseId: planned.id, deletedAt: null },
        data: { deletedAt: new Date() },
      });

      // Generate cash flow for the paid expense (outside transaction context)
      // We need to do it after transaction completes, so we'll inline it here
      const expense = await tx.expense.findUnique({
        where: { id: paidExpense.id },
        include: { room: true },
      });

      if (expense) {
        const entries = this.buildCashFlowEntries(expense);
        if (entries.length > 0) {
          await tx.cashFlowEntry.createMany({ data: entries });
        }
      }

      return paidExpense;
    });
  }

  /**
   * Marca uma despesa PLANEJADA como PAGA in-place (sem clone) e regenera seu
   * cashflow. Usado por fluxos que já têm sua própria despesa canônica e só
   * precisam sincronizar o espelho — hoje: financing.service::payInstallment
   * (#294, parcela paga direto pelo dashboard do financiamento).
   * Se a despesa já é alvo de um rateio (RateioAllocation), o caminho
   * PESSOAL→financiamento (#276) já governa seu status/cashflow — não sobrescreve.
   * SEMPRE roda dentro da `tx` do caller (regra 4: $transaction ignora o $use
   * de soft-delete, por isso o filtro `deletedAt: null` é explícito aqui).
   */
  async markPaidInPlace(
    tenantId: string,
    id: string,
    dataPagamento: Date,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const rateio = await tx.rateioAllocation.findUnique({ where: { targetExpenseId: id } });
    if (rateio) return;

    const expense = await tx.expense.findFirst({ where: { id, tenantId, deletedAt: null } });
    if (!expense) return;

    await tx.expense.update({ where: { id }, data: { status: 'PAGO', dataPagamento } });
    await this.regenerateCashFlow(id, tx);
  }

  /**
   * Marca/desmarca UMA parcela (0-based) de uma despesa PARCELADO/QUINZENAL como paga.
   * Não cria clone (diferente de payPlanned): mantém a despesa e ajusta `paidParcelas`
   * + regenera o fluxo de caixa com status por parcela. Quando todas as parcelas ficam
   * pagas, a despesa inteira vira status='PAGO' (e paidParcelas é limpo).
   */
  async setParcelaStatus(
    tenantId: string,
    projectId: string,
    id: string,
    parcela: number,
    paid: boolean,
  ) {
    await this.validateProject(tenantId, projectId);

    return this.prisma.$transaction(async (tx) => {
      const expense = await tx.expense.findFirst({
        where: { id, projectId, tenantId, deletedAt: null },
        include: { room: true },
      });
      if (!expense) throw new NotFoundException('Despesa não encontrada');
      await this.guardRateioParticipation(tenantId, id, false, false, tx);
      if (expense.settledByExpenseId) {
        throw new BadRequestException('Despesa já foi liquidada');
      }
      if (isSinglePaymentForm(expense.formaPagamento)) {
        throw new BadRequestException('Despesa não é parcelada/quinzenal');
      }
      const n = expense.quantidadeParcela ?? 1;
      if (n <= 1) {
        throw new BadRequestException('Despesa não possui múltiplas parcelas');
      }
      if (!Number.isInteger(parcela) || parcela < 0 || parcela >= n) {
        throw new BadRequestException('Índice de parcela inválido');
      }

      // Estado base: se a despesa estava PAGO, todas as parcelas eram pagas.
      const baseSet =
        expense.status === 'PAGO'
          ? new Set<number>(Array.from({ length: n }, (_, i) => i))
          : new Set<number>(this.parsePaidParcelas(expense.paidParcelas, n));

      if (paid) baseSet.add(parcela);
      else baseSet.delete(parcela);

      const allPaid = baseSet.size === n;
      const nextStatus = allPaid ? 'PAGO' : 'PLANEJADO';
      const nextPaidParcelas =
        allPaid || baseSet.size === 0
          ? null
          : JSON.stringify(Array.from(baseSet).sort((a, b) => a - b));

      const updated = await tx.expense.update({
        where: { id: expense.id },
        data: { status: nextStatus, paidParcelas: nextPaidParcelas },
        include: { room: true },
      });

      // Regenera o fluxo de caixa com o status por parcela atualizado.
      await tx.cashFlowEntry.updateMany({
        where: { expenseId: expense.id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      const entries = this.buildCashFlowEntries(updated);
      if (entries.length > 0) {
        await tx.cashFlowEntry.createMany({ data: entries });
      }

      return updated;
    });
  }

  async remove(tenantId: string, projectId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.validateProject(tenantId, projectId, tx);
      const expense = await tx.expense.findFirst({
        where: { id, projectId, tenantId, deletedAt: null },
      });
      if (!expense) throw new NotFoundException('Despesa não encontrada');

      const rateioParticipation = await this.guardRateioParticipation(
        tenantId,
        id,
        true,
        false,
        tx,
      );
      if (rateioParticipation === 'source') {
        await this.conciliacao.unratearSource(tx, { tenantId, sourceExpenseId: id });
        const now = new Date();
        // Mesma limpeza do caminho legado (linha ~1727): qualquer despesa não
        // relacionada ao rateio que aponte para esta fonte via `linkedExpenseId`
        // (vínculo cross-project comum) não pode ficar órfã apontando para uma
        // despesa soft-deletada.
        await tx.expense.updateMany({
          where: { tenantId, linkedExpenseId: id, deletedAt: null },
          data: { linkedExpenseId: null },
        });
        await tx.cashFlowEntry.updateMany({
          where: { expenseId: id, deletedAt: null },
          data: { deletedAt: now },
        });
        const deleted = await tx.expense.updateMany({
          where: { id, tenantId, deletedAt: null },
          data: { deletedAt: now, linkedExpenseId: null },
        });
        if (deleted.count !== 1) throw new NotFoundException('Despesa não encontrada');
        return { deleted: true, count: 1 };
      }

      const settlementParticipation = await this.guardSettlementParticipation(
        tenantId,
        id,
        true,
        false,
        tx,
      );
      if (settlementParticipation === 'source') {
        await this.conciliacao.unsettleBySource(tx, { tenantId, sourceExpenseId: id });
        // `unsettleBySource` já soft-deleta a própria source (via `softDeleteMirror`
        // interno) — não soft-deletar de novo aqui, só limpar vínculos órfãos de
        // entrada, espelhando a limpeza do ramo de rateio acima.
        await tx.expense.updateMany({
          where: { tenantId, linkedExpenseId: id, deletedAt: null },
          data: { linkedExpenseId: null },
        });
        return { deleted: true, count: 1 };
      }

      // Legado 1:1: par simples é removido junto; conciliações continuam isoladas.
      const ids = new Set<string>([id]);
      const involvedInSettlement = async (expenseId: string): Promise<boolean> =>
        (await tx.crossProjectSettlement.count({
          where: {
            tenantId,
            OR: [{ sourceExpenseId: expenseId }, { targetExpenseId: expenseId }],
          },
        })) > 0;

      // Cascade não pode arrastar um participante ativo de rateio (fonte ou
      // alvo de outro rateio não relacionado): um vínculo comum apontando para
      // dentro/fora de um rateio não pode apagar o rateio por tabela.
      // `guardRateioParticipation` com os dois lados permitidos só consulta
      // (nunca lança).
      const isRateioParticipant = async (expenseId: string): Promise<boolean> =>
        (await this.guardRateioParticipation(tenantId, expenseId, true, true, tx)) !== null;

      if (!(await involvedInSettlement(id))) {
        if (expense.linkedExpenseId) {
          const target = await tx.expense.findFirst({
            where: { id: expense.linkedExpenseId, tenantId, deletedAt: null },
            select: { id: true },
          });
          if (
            target &&
            !(await involvedInSettlement(target.id)) &&
            !(await isRateioParticipant(target.id))
          ) {
            ids.add(target.id);
          }
        }
        const mirrors = await tx.expense.findMany({
          where: { tenantId, linkedExpenseId: id, deletedAt: null },
          select: { id: true },
        });
        for (const mirror of mirrors) {
          if (
            !(await involvedInSettlement(mirror.id)) &&
            !(await isRateioParticipant(mirror.id))
          ) {
            ids.add(mirror.id);
          }
        }
      }

      const idArr = [...ids];
      const now = new Date();
      await tx.expense.updateMany({
        where: {
          tenantId,
          linkedExpenseId: { in: idArr },
          id: { notIn: idArr },
          deletedAt: null,
        },
        data: { linkedExpenseId: null },
      });
      await tx.cashFlowEntry.updateMany({
        where: { expenseId: { in: idArr }, deletedAt: null },
        data: { deletedAt: now },
      });
      await tx.expense.updateMany({
        where: { tenantId, id: { in: idArr }, deletedAt: null },
        data: { deletedAt: now },
      });
      return { deleted: true, count: idArr.length };
    });
  }

  private async regenerateCashFlow(
    expenseId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const db = tx ?? this.prisma;
    const expense = await db.expense.findUnique({
      where: { id: expenseId },
      include: { room: true },
    });
    if (!expense) return;

    const regenerate = async (transaction: Prisma.TransactionClient) => {
      // Alvo RATEADO: o caixa é derivado do cronograma da fonte, não do planejado
      // próprio. Editar o alvo não pode apagar/regenerar errado o caixa do rateio.
      const rateio = await transaction.rateioAllocation.findFirst({
        where: { tenantId: expense.tenantId, targetExpenseId: expenseId },
      });
      if (rateio) {
        await this.conciliacao.regenerateRateioTargetCashflow(
          transaction,
          expenseId,
        );
        return;
      }

      // Soft-delete existing entries
      await transaction.cashFlowEntry.updateMany({
        where: { expenseId, deletedAt: null },
        data: { deletedAt: new Date() },
      });

      // If settled by another expense, don't generate new entries
      if (expense.settledByExpenseId) return;

      const entries = this.buildCashFlowEntries(expense);
      if (entries.length > 0) {
        await transaction.cashFlowEntry.createMany({ data: entries });
      }
    };

    return tx ? regenerate(tx) : this.prisma.$transaction(regenerate);
  }

  private buildCashFlowEntries(expense: {
    id: string;
    projectId: string;
    tenantId: string;
    tipoDespesa: string;
    categoriaMaoDeObra: string | null;
    roomId: string | null;
    valorTotal: number;
    formaPagamento: string;
    dataPagamento: Date | null;
    quantidadeParcela: number | null;
    dataInicioParcela: Date | null;
    status: string;
    paidParcelas?: string | null;
    installmentDateOverrides?: string | null;
    cardLast4: string | null;
    bankLast4: string | null;
    room: { name: string } | null;
  }) {
    // Tipos "neutros" (transferência entre contas próprias, pagto de fatura)
    // não geram entradas de cashflow — não representam consumo/saldo real.
    const isCardOnlyNeutral =
      isNeutralExpenseType(expense.tipoDespesa) &&
      Boolean(expense.cardLast4) &&
      !expense.bankLast4;
    if (isNeutralExpenseType(expense.tipoDespesa) && !isCardOnlyNeutral) return [];

    const categoria = ExpenseTypeLabels[expense.tipoDespesa as keyof typeof ExpenseTypeLabels] ?? expense.tipoDespesa;
    const subcategoria = expense.categoriaMaoDeObra
      ? LaborCategoryLabels[expense.categoriaMaoDeObra as keyof typeof LaborCategoryLabels] ?? expense.categoriaMaoDeObra
      : null;
    const ambiente = expense.room?.name ?? null;
    const fullyPaid = expense.status === 'PAGO';

    const installments = buildInstallments({
      valorTotal: expense.valorTotal,
      formaPagamento: expense.formaPagamento,
      dataPagamento: expense.dataPagamento,
      quantidadeParcela: expense.quantidadeParcela,
      dataInicioParcela: expense.dataInicioParcela,
      installmentDateOverrides: expense.installmentDateOverrides,
    });

    const singlePayment = isSinglePaymentForm(expense.formaPagamento);
    // Parcelas pagas individualmente (status por parcela). Quando a despesa
    // inteira está PAGO, todas as parcelas entram como PAGO independentemente.
    const paidSet = singlePayment
      ? new Set<number>()
      : new Set(this.parsePaidParcelas(expense.paidParcelas, installments.length));

    return installments.map(({ parcela, valor, data }, idx) => ({
      projectId: expense.projectId,
      tenantId: expense.tenantId,
      expenseId: expense.id,
      tipo: 'DESPESA',
      categoria,
      subcategoria,
      ambiente,
      status: fullyPaid || paidSet.has(idx) ? 'PAGO' : 'PLANEJADO',
      valor,
      data,
      formaPagamento: expense.formaPagamento,
      parcela: singlePayment ? null : parcela,
    }));
  }

  /**
   * Normaliza o JSON de parcelas pagas: aceita só inteiros no range [0, n),
   * sem duplicados, ordenados. Nunca confia no formato bruto vindo do banco/cliente.
   */
  private parsePaidParcelas(raw: string | null | undefined, n: number): number[] {
    if (!raw) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    const set = new Set<number>();
    for (const v of parsed) {
      const i = Number(v);
      if (Number.isInteger(i) && i >= 0 && i < n) set.add(i);
    }
    return Array.from(set).sort((a, b) => a - b);
  }

  private async validateProject(
    tenantId: string,
    projectId: string,
    db: ExpenseDb = this.prisma,
  ) {
    const project = await db.project.findFirst({
      where: { id: projectId, tenantId, deletedAt: null },
    });
    if (!project) throw new NotFoundException('Projeto não encontrado');
  }
}
