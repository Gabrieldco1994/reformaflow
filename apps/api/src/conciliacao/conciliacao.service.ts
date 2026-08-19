import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  buildInstallments,
  isSinglePaymentForm,
  isNeutralExpenseType,
  ExpenseTypeLabels,
  LaborCategoryLabels,
  parsePaidParcelas,
  applyParcelaOverrides,
} from '@reformaflow/domain';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertRateioRequester,
  RateioRequester,
} from '../expense/rateio.types';
import { userCanAccessProject, userCanAccessProjectType } from '../common/access-rules';

type Tx = Prisma.TransactionClient;

const DUPLICATE_RATEIO_TARGET_MESSAGE = 'Despesa planejada duplicada no rateio.';
const SOURCE_ALREADY_RATEIO_TARGET_MESSAGE = 'A compra fonte já é alvo de outro rateio.';
const TARGET_ALREADY_RATEIO_SOURCE_MESSAGE = 'A despesa alvo já é fonte de outro rateio.';

export interface SettleParcelaInput {
  tenantId: string;
  sourceExpenseId: string;
  targetExpenseId: string;
  /** Parcela 0-based do ALVO a liquidar. */
  parcelaIndex: number;
  /** Valor real pago (centavos), vindo da fatura/conta. */
  realValor: number;
  /** Preenchido pelo settle com o índice EFETIVAMENTE liquidado (clampado). */
  _effective?: number;
}

export interface RateioItem {
  targetExpenseId: string;
  /** Centavos alocados a esta planejada. */
  allocation: number;
}

export interface RatearInput {
  tenantId: string;
  sourceExpenseId: string;
  allocations: RateioItem[];
}

/**
 * Conciliação cross-project por parcela.
 *
 * Liquida UMA parcela de uma despesa planejada (outro projeto) com o valor REAL
 * de uma despesa importada (PESSOAL). Não-destrutivo e reversível:
 *  - guarda snapshot do planejado (`plannedValor`/`plannedStatus`) por parcela;
 *  - o valor real substitui o planejado **apenas naquela parcela** no fluxo de caixa
 *    do alvo (o que faz os indicadores baseados em cashflow refletirem o real);
 *  - `Expense.valorTotal` do alvo permanece **imutável** (= planejado); o valor
 *    efetivo é derivado por `effectiveValorTotal` (domínio).
 *
 * Todos os métodos esperam ser chamados DENTRO de uma `$transaction` (recebem `tx`).
 */
@Injectable()
export class ConciliacaoService {
  constructor(private readonly prisma: PrismaService) {}

  /** Autoriza o projeto real de um alvo recebido fora dos params da rota. */
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

  private async authorizedTargets(
    tx: Tx,
    tenantId: string,
    targetExpenseIds: string[],
    requester: RateioRequester,
    error: (targetExpenseId: string) => Error,
    includeDeleted = false,
  ) {
    assertRateioRequester(requester);
    const ids = [...new Set(targetExpenseIds)];
    const targets =
      ids.length === 0
        ? []
        : includeDeleted
          ? (
              await Promise.all(
                ids.map((id) =>
                  typeof tx.expense.findUnique === 'function'
                    ? tx.expense.findUnique({
                        where: { id },
                        include: {
                          project: { select: { id: true, type: true, tenantId: true } },
                        },
                      })
                    : tx.expense.findFirst({
                        where: { id },
                        include: {
                          project: { select: { id: true, type: true, tenantId: true } },
                        },
                      }),
                ),
              )
            ).filter((target) => target !== null)
          : await tx.expense.findMany({
              where: {
                id: { in: ids },
                tenantId,
                deletedAt: null,
              },
              include: {
                project: { select: { id: true, type: true, tenantId: true } },
              },
            });
    const byId = new Map(targets.map((target) => [target.id, target]));
    for (const id of ids) {
      const target = byId.get(id);
      const project =
        target?.project ??
        (target
          ? await tx.project.findFirst({
              where: { id: target.projectId, tenantId },
              select: { id: true, type: true, tenantId: true },
            })
          : null);
      if (
        !target ||
        target.tenantId !== tenantId ||
        !project ||
        project.tenantId !== tenantId ||
        !this.canRequesterSeeProject(requester, project)
      ) {
        throw error(id);
      }
    }
    return byId;
  }

  async assertCanSettleTargets(
    tx: Tx,
    params: { tenantId: string; targetExpenseIds: string[] },
    requester: RateioRequester,
  ) {
    assertRateioRequester(requester);
    return this.authorizedTargets(
      tx,
      params.tenantId,
      params.targetExpenseIds,
      requester,
      () => new NotFoundException('Despesa alvo não encontrada'),
    );
  }

  async assertCanRatearTargets(
    tx: Tx,
    params: { tenantId: string; targetExpenseIds: string[] },
    requester: RateioRequester,
  ): Promise<void> {
    assertRateioRequester(requester);
    await this.authorizedTargets(
      tx,
      params.tenantId,
      params.targetExpenseIds,
      requester,
      (id) => new BadRequestException(`Despesa alvo ${id} não encontrada`),
    );
  }

  async assertCanMutateReceiptTargets(
    tx: Tx,
    params: { tenantId: string; targetReceiptIds: string[] },
    requester: RateioRequester,
  ): Promise<void> {
    assertRateioRequester(requester);
    const ids = [...new Set(params.targetReceiptIds)];
    const targets =
      ids.length === 0
        ? []
        : await tx.receipt.findMany({
            where: { id: { in: ids }, tenantId: params.tenantId, deletedAt: null },
            include: { project: { select: { id: true, type: true, tenantId: true } } },
          });
    const byId = new Map(targets.map((target) => [target.id, target]));
    for (const id of ids) {
      const target = byId.get(id);
      if (
        !target ||
        !target.project ||
        target.project.tenantId !== params.tenantId ||
        !this.canRequesterSeeProject(requester, target.project)
      ) {
        throw new NotFoundException('Recebimento alvo não encontrado');
      }
    }
  }

  async assertCanReverseSources(
    tx: Tx,
    params: { tenantId: string; sourceExpenseIds: string[] },
    requester: RateioRequester,
  ): Promise<void> {
    assertRateioRequester(requester, new NotFoundException('Despesa fonte não encontrada'));
    const sourceExpenseIds = [...new Set(params.sourceExpenseIds)];
    if (sourceExpenseIds.length === 0) return;
    const [sources, rateios, settlements] = await Promise.all([
      tx.expense.findMany({
        where: {
          id: { in: sourceExpenseIds },
          tenantId: params.tenantId,
          deletedAt: null,
        },
        select: { linkedExpenseId: true },
      }),
      tx.rateioAllocation.findMany({
        where: { tenantId: params.tenantId, sourceExpenseId: { in: sourceExpenseIds } },
        select: { targetExpenseId: true },
      }),
      tx.crossProjectSettlement.findMany({
        where: { tenantId: params.tenantId, sourceExpenseId: { in: sourceExpenseIds } },
        select: { targetExpenseId: true },
      }),
    ]);
    await this.authorizedTargets(
      tx,
      params.tenantId,
      [
        ...sources.flatMap((row) =>
          row.linkedExpenseId ? [row.linkedExpenseId] : [],
        ),
        ...rateios.map((row) => row.targetExpenseId),
        ...settlements.map((row) => row.targetExpenseId),
      ],
      requester,
      () => new NotFoundException('Despesa alvo não encontrada'),
      true,
    );
  }

  /**
   * Soft-delete de um espelho (source) DENTRO de uma transação. Como o
   * `$transaction` ignora o `$use` de soft-delete do Prisma, marcamos
   * `deletedAt` na mão — e, crucialmente, também soft-deletamos os
   * `cashFlowEntry` gerados pelo espelho, senão sobra uma entrada órfã (entry
   * viva com expense soft-deletado) que vaza para consumidores que não filtram
   * `expense.deletedAt` (ex.: notifications). Espelha o `remove()` canônico.
   */
  private async softDeleteMirror(tx: Tx, sourceExpenseId: string): Promise<void> {
    const now = new Date();
    await tx.expense.update({
      where: { id: sourceExpenseId },
      data: { deletedAt: now, linkedExpenseId: null },
    });
    await tx.cashFlowEntry.updateMany({
      where: { expenseId: sourceExpenseId, deletedAt: null },
      data: { deletedAt: now },
    });
  }

  /**
   * O ALVO (child fora do `:projectId` da rota) precisa estar na lente do
   * requisitante; requester ausente falha fechado. Missing/cross-tenant/
   * same-tenant-fora-do-escopo colapsam TODOS no mesmo 404 já existente para
   * "alvo não encontrado" — nunca um 403 que confirmaria a existência do alvo
   * a quem não pode vê-lo. A releitura acontece DENTRO desta mesma `tx`
   * (chamada só dentro de `$transaction`) — sem gap de TOCTOU entre checar e
   * escrever.
   */
  async settleTargetParcela(
    tx: Tx,
    input: SettleParcelaInput,
    requester: RateioRequester,
  ): Promise<void> {
    assertRateioRequester(requester);
    const { tenantId, sourceExpenseId, targetExpenseId, realValor } = input;

    const targets = await this.assertCanSettleTargets(
      tx,
      { tenantId, targetExpenseIds: [targetExpenseId] },
      requester,
    );
    const target = targets.get(targetExpenseId)!;

    const source = await tx.expense.findFirst({
      where: { id: sourceExpenseId, tenantId, deletedAt: null },
    });
    if (!source) throw new NotFoundException('Despesa fonte não encontrada');
    if (source.projectId === target.projectId) {
      throw new BadRequestException('Alvo deve estar em outro projeto');
    }

    // P5 — neutros nunca são conciliados (nunca viram espelho / cashflow).
    if (isNeutralExpenseType(target.tipoDespesa)) {
      throw new BadRequestException('Alvo neutro não pode ser conciliado');
    }
    // P5 (fonte) — o espelho é um pagamento REAL; se for neutro, não conta no
    // caixa PESSOAL e a quitação "some" (money-vanish). Bloqueia na origem.
    if (isNeutralExpenseType(source.tipoDespesa)) {
      throw new BadRequestException('Espelho neutro não pode conciliar uma parcela');
    }

    // E5 — mutex rateio×settle: uma compra rateada não pode ser conciliada por
    // parcela (simétrico ao guard de ratearSource). Desfaça o rateio antes.
    const rateioCount = await tx.rateioAllocation.count({
      where: { tenantId, sourceExpenseId },
    });
    if (rateioCount > 0) {
      throw new BadRequestException(
        'Esta compra já está rateada; desfaça o rateio antes de conciliar por parcela.',
      );
    }

    // E5 (simétrico) — o ALVO não pode já ser destino de um rateio. Se fosse,
    // `regenerateTargetCashflow` (que ignora RateioAllocation) sobrescreveria o
    // caixa rateado e criaria um 2º espelho ativo apontando ao mesmo alvo →
    // divergência/dupla contagem. Espelha o guard de ratearSource (:428-429).
    const targetRateioCount = await tx.rateioAllocation.count({
      where: { tenantId, targetExpenseId },
    });
    if (targetRateioCount > 0) {
      throw new BadRequestException(
        'Esta planejada já está rateada por uma compra; desfaça o rateio antes de conciliar por parcela.',
      );
    }

    const n = Math.max(1, target.quantidadeParcela ?? 1);
    const singlePayment = isSinglePaymentForm(target.formaPagamento);
    const parcelaIndex = singlePayment ? 0 : Math.min(Math.max(0, input.parcelaIndex | 0), n - 1);
    // Expõe o índice efetivamente liquidado (clampado) ao chamador (E2).
    input._effective = parcelaIndex;

    const plannedSlices = buildInstallments({
      valorTotal: target.valorTotal,
      formaPagamento: target.formaPagamento,
      dataPagamento: target.dataPagamento,
      quantidadeParcela: target.quantidadeParcela,
      dataInicioParcela: target.dataInicioParcela,
      installmentDateOverrides: target.installmentDateOverrides,
    });
    const plannedValor = plannedSlices[parcelaIndex]?.valor ?? target.valorTotal;

    const existingPaid = new Set(
      target.status === 'PAGO'
        ? Array.from({ length: n }, (_, i) => i)
        : parsePaidParcelas(target.paidParcelas, n),
    );
    const plannedStatus = existingPaid.has(parcelaIndex) ? 'PAGO' : 'PLANEJADO';

    // P1/P2 — idempotência do espelho (1 espelho ativo por target+parcela).
    // Se já existe um settlement nesta parcela apontando para OUTRA source, o
    // espelho antigo virou órfão → soft-delete + limpar o vínculo. Como
    // `$transaction` ignora o `$use` de soft-delete, setamos `deletedAt` na mão.
    // Duplo clique com a MESMA source → nada a desativar (só update de realValor).
    const existingSettlement = await tx.crossProjectSettlement.findUnique({
      where: { targetExpenseId_parcelaIndex: { targetExpenseId, parcelaIndex } },
    });
    if (
      existingSettlement?.sourceExpenseId &&
      existingSettlement.sourceExpenseId !== sourceExpenseId
    ) {
      await this.softDeleteMirror(tx, existingSettlement.sourceExpenseId);
    }

    // Snapshot só na criação; em re-import da mesma parcela, atualiza o valor real.
    await tx.crossProjectSettlement.upsert({
      where: { targetExpenseId_parcelaIndex: { targetExpenseId, parcelaIndex } },
      create: {
        tenantId,
        sourceExpenseId,
        targetExpenseId,
        parcelaIndex,
        realValor,
        plannedValor,
        plannedStatus,
      },
      update: { realValor, sourceExpenseId },
    });

    existingPaid.add(parcelaIndex);
    const allPaid = existingPaid.size >= n;
    const nextPaidParcelas =
      allPaid || existingPaid.size === 0
        ? null
        : JSON.stringify(Array.from(existingPaid).sort((a, b) => a - b));
    const nextStatus = allPaid ? 'PAGO' : 'PLANEJADO';

    await tx.expense.update({
      where: { id: target.id },
      data: { status: nextStatus, paidParcelas: nextPaidParcelas },
    });

    // A fonte vira "espelho" do alvo (dedupe no consolidado PESSOAL via linkedExpenseId).
    if (source.linkedExpenseId !== target.id) {
      await tx.expense.update({
        where: { id: source.id },
        data: { linkedExpenseId: target.id },
      });
    }

    await this.regenerateTargetCashflow(tx, targetExpenseId);
  }

  /**
   * Regenera o fluxo de caixa do alvo aplicando os valores reais nas parcelas
   * liquidadas (cross-project). Demais parcelas mantêm o valor planejado.
   */
  async regenerateTargetCashflow(tx: Tx, targetExpenseId: string): Promise<void> {
    const target = await tx.expense.findFirst({
      where: { id: targetExpenseId, deletedAt: null },
      include: { room: true },
    });
    if (!target) return;

    // Sempre limpa as entradas atuais antes de recriar.
    await tx.cashFlowEntry.updateMany({
      where: { expenseId: targetExpenseId, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    if (isNeutralExpenseType(target.tipoDespesa)) return;

    const settlements = await tx.crossProjectSettlement.findMany({
      where: { targetExpenseId },
    });

    const plannedSlices = buildInstallments({
      valorTotal: target.valorTotal,
      formaPagamento: target.formaPagamento,
      dataPagamento: target.dataPagamento,
      quantidadeParcela: target.quantidadeParcela,
      dataInicioParcela: target.dataInicioParcela,
      installmentDateOverrides: target.installmentDateOverrides,
    });
    const n = plannedSlices.length;

    const overrides = new Map<number, number>();
    for (const s of settlements) {
      if (s.parcelaIndex >= 0 && s.parcelaIndex < n) overrides.set(s.parcelaIndex, s.realValor);
    }
    const finalValues = applyParcelaOverrides(
      plannedSlices.map((s) => s.valor),
      overrides,
    );

    const singlePayment = isSinglePaymentForm(target.formaPagamento);
    const paidSet = new Set(
      target.status === 'PAGO'
        ? Array.from({ length: n }, (_, i) => i)
        : parsePaidParcelas(target.paidParcelas, n),
    );
    // Parcelas liquidadas cross-project também contam como pagas.
    for (const idx of overrides.keys()) paidSet.add(idx);

    const categoria =
      ExpenseTypeLabels[target.tipoDespesa as keyof typeof ExpenseTypeLabels] ?? target.tipoDespesa;
    const subcategoria = target.categoriaMaoDeObra
      ? LaborCategoryLabels[target.categoriaMaoDeObra as keyof typeof LaborCategoryLabels] ??
        target.categoriaMaoDeObra
      : null;
    const ambiente = target.room?.name ?? null;

    const entries = plannedSlices.map((slice, idx) => ({
      projectId: target.projectId,
      tenantId: target.tenantId,
      expenseId: target.id,
      tipo: 'DESPESA' as const,
      categoria,
      subcategoria,
      ambiente,
      status: paidSet.has(idx) ? 'PAGO' : 'PLANEJADO',
      valor: finalValues[idx]!,
      data: slice.data,
      formaPagamento: target.formaPagamento,
      parcela: singlePayment ? null : slice.parcela,
    }));

    if (entries.length > 0) await tx.cashFlowEntry.createMany({ data: entries });
  }

  /**
   * Desfaz TODAS as liquidações originadas por uma fonte, restaurando o planejado
   * dos alvos (snapshot) e limpando o vínculo (`linkedExpenseId`) da fonte.
   */
  async unsettleBySource(
    tx: Tx,
    params: { tenantId: string; sourceExpenseId: string },
    requester: RateioRequester,
  ): Promise<{ targets: string[] }> {
    assertRateioRequester(requester, new NotFoundException('Despesa fonte não encontrada'));
    const { tenantId, sourceExpenseId } = params;
    await this.assertCanReverseSources(
      tx,
      { tenantId, sourceExpenseIds: [sourceExpenseId] },
      requester,
    );
    const rows = await tx.crossProjectSettlement.findMany({
      where: { tenantId, sourceExpenseId },
    });
    if (rows.length === 0) return { targets: [] };

    const byTarget = new Map<string, typeof rows>();
    for (const r of rows) {
      const arr = byTarget.get(r.targetExpenseId) ?? [];
      arr.push(r);
      byTarget.set(r.targetExpenseId, arr);
    }

    const targets: string[] = [];
    for (const [targetExpenseId, group] of byTarget) {
      const target = await tx.expense.findFirst({
        where: { id: targetExpenseId, tenantId, deletedAt: null },
      });
      if (target) {
        const n = Math.max(1, target.quantidadeParcela ?? 1);
        const paidSet = new Set(
          target.status === 'PAGO'
            ? Array.from({ length: n }, (_, i) => i)
            : parsePaidParcelas(target.paidParcelas, n),
        );
        // Restaura só as parcelas cujo planejado era PLANEJADO (não "des-paga"
        // parcelas que já estavam pagas por outra via antes do vínculo).
        for (const r of group) {
          if (r.plannedStatus !== 'PAGO') paidSet.delete(r.parcelaIndex);
        }
        const nextPaidParcelas =
          paidSet.size === 0 || paidSet.size >= n
            ? null
            : JSON.stringify(Array.from(paidSet).sort((a, b) => a - b));
        const nextStatus = paidSet.size >= n ? 'PAGO' : 'PLANEJADO';
        await tx.expense.update({
          where: { id: target.id },
          data: { status: nextStatus, paidParcelas: nextPaidParcelas },
        });
      }

      await tx.crossProjectSettlement.deleteMany({
        where: { targetExpenseId, sourceExpenseId },
      });

      if (target) await this.regenerateTargetCashflow(tx, targetExpenseId);
      targets.push(targetExpenseId);
    }

    // P6 — o espelho existe só para representar a quitação; ao desconciliar ele
    // some (Σ espelhos ativos == Σ parcelas quitadas cross-project == 0).
    // Soft-delete do espelho E das suas entradas de caixa (sem órfã).
    await this.softDeleteMirror(tx, sourceExpenseId);

    return { targets };
  }

  // ─── Rateio: 1 compra (fonte) → N planejadas (alvos) ─────────────────────
  // Cada alvo herda o CRONOGRAMA da fonte escalado à sua alocação (ex.: compra
  // 10x e alocação de R$ 3.200 => 10 parcelas de R$ 320 nas datas da fonte).
  // O `valorTotal` do alvo permanece PLANEJADO (imutável); só o caixa é regerado.

  /**
   * Regenera o caixa de um alvo RATEADO: gera parcelas a partir do cronograma da
   * FONTE, com valor = alocação dividida em N, mantendo a categoria/ambiente do
   * ALVO. Status por parcela espelha as parcelas pagas da fonte.
   */
  async regenerateRateioTargetCashflow(tx: Tx, targetExpenseId: string): Promise<void> {
    const target = await tx.expense.findFirst({
      where: { id: targetExpenseId, deletedAt: null },
      include: { room: true },
    });
    if (!target) return;

    await tx.cashFlowEntry.updateMany({
      where: { expenseId: targetExpenseId, deletedAt: null },
      data: { deletedAt: new Date() },
    });

    if (isNeutralExpenseType(target.tipoDespesa)) return;

    const alloc = await tx.rateioAllocation.findFirst({
      where: { tenantId: target.tenantId, targetExpenseId },
    });
    if (!alloc) return; // sem rateio: o caller deve usar a regeneração planejada

    const source = await tx.expense.findFirst({
      where: { id: alloc.sourceExpenseId, tenantId: target.tenantId, deletedAt: null },
    });
    if (!source) return;

    const slices = buildInstallments({
      valorTotal: alloc.allocation,
      formaPagamento: source.formaPagamento,
      dataPagamento: source.dataPagamento,
      quantidadeParcela: source.quantidadeParcela,
      dataInicioParcela: source.dataInicioParcela,
      installmentDateOverrides: source.installmentDateOverrides,
    });
    const n = slices.length;
    const singlePayment = isSinglePaymentForm(source.formaPagamento);
    const paidSet = new Set(
      source.status === 'PAGO'
        ? Array.from({ length: n }, (_, i) => i)
        : parsePaidParcelas(source.paidParcelas, n),
    );

    const categoria =
      ExpenseTypeLabels[target.tipoDespesa as keyof typeof ExpenseTypeLabels] ?? target.tipoDespesa;
    const subcategoria = target.categoriaMaoDeObra
      ? LaborCategoryLabels[target.categoriaMaoDeObra as keyof typeof LaborCategoryLabels] ??
        target.categoriaMaoDeObra
      : null;
    const ambiente = target.room?.name ?? null;

    const entries = slices.map((slice, idx) => ({
      projectId: target.projectId,
      tenantId: target.tenantId,
      expenseId: target.id,
      tipo: 'DESPESA' as const,
      categoria,
      subcategoria,
      ambiente,
      status: paidSet.has(idx) ? 'PAGO' : 'PLANEJADO',
      valor: slice.valor,
      data: slice.data,
      formaPagamento: source.formaPagamento,
      parcela: singlePayment ? null : slice.parcela,
    }));
    if (entries.length > 0) await tx.cashFlowEntry.createMany({ data: entries });
  }

  /**
   * Rateia uma compra (fonte) entre várias planejadas (alvos cross-project).
   * Idempotente: limpa um rateio anterior da mesma fonte antes de aplicar.
   * Exige que a soma das alocações feche EXATAMENTE o total da compra (o dedupe
   * por espelho é tudo-ou-nada; sobra perderia dinheiro no consolidado).
   *
   * CADA alvo precisa estar na lente do requisitante; requester ausente falha
   * fechado. Missing/
   * cross-tenant/fora-do-escopo colapsam no MESMO 400 já usado para "alvo não
   * encontrado" (nunca 403 — não confirma existência a quem não pode ver).
   * Lido DENTRO desta `tx` (chamada só dentro de `$transaction`), sem gap de
   * TOCTOU entre o check e a escrita da alocação/atualização do alvo.
   */
  async ratearSource(
    tx: Tx,
    input: RatearInput,
    requester: RateioRequester,
  ): Promise<{ targets: string[] }> {
    assertRateioRequester(requester);
    const { tenantId, sourceExpenseId, allocations } = input;

    const source = await tx.expense.findFirst({
      where: { id: sourceExpenseId, tenantId, deletedAt: null },
    });
    if (!source) throw new NotFoundException('Despesa fonte não encontrada');
    if (allocations.length === 0) {
      throw new BadRequestException('Informe ao menos uma planejada para ratear');
    }

    const uniqueTargetIds = new Set<string>();
    for (const item of allocations) {
      if (uniqueTargetIds.has(item.targetExpenseId)) {
        throw new BadRequestException(DUPLICATE_RATEIO_TARGET_MESSAGE);
      }
      uniqueTargetIds.add(item.targetExpenseId);
    }

    const sourceAsTarget = await tx.rateioAllocation.findFirst({
      where: { tenantId, targetExpenseId: sourceExpenseId },
      select: { sourceExpenseId: true },
    });
    if (sourceAsTarget) {
      throw new BadRequestException(SOURCE_ALREADY_RATEIO_TARGET_MESSAGE);
    }

    // Mutex inverso: um alvo não pode ser fonte de outro rateio (A → B → C).
    const targetAsSource = await tx.rateioAllocation.findFirst({
      where: {
        tenantId,
        sourceExpenseId: { in: Array.from(uniqueTargetIds) },
      },
      select: { targetExpenseId: true },
    });
    if (targetAsSource) {
      throw new BadRequestException(TARGET_ALREADY_RATEIO_SOURCE_MESSAGE);
    }

    const conc = await tx.crossProjectSettlement.count({ where: { sourceExpenseId } });
    if (conc > 0) {
      throw new BadRequestException('Esta compra já está conciliada por parcela; desfaça antes de ratear.');
    }

    const total = allocations.reduce((s, a) => s + Math.round(a.allocation), 0);
    if (total !== source.valorTotal) {
      throw new BadRequestException(
        `A soma das alocações (${total}) deve fechar o total da compra (${source.valorTotal}).`,
      );
    }

    const currentRows = await tx.rateioAllocation.findMany({
      where: { tenantId, sourceExpenseId },
      select: { targetExpenseId: true },
    });
    const targetIds = [
      ...(source.linkedExpenseId ? [source.linkedExpenseId] : []),
      ...currentRows.map((row) => row.targetExpenseId),
      ...allocations.map((item) => item.targetExpenseId),
    ];
    const targetById = await this.authorizedTargets(
      tx,
      tenantId,
      targetIds,
      requester,
      (id) => new BadRequestException(`Despesa alvo ${id} não encontrada`),
    );
    const [targetSettlements, targetAllocations] = await Promise.all([
      tx.crossProjectSettlement.findMany({
        where: { tenantId, targetExpenseId: { in: [...uniqueTargetIds] } },
        select: { targetExpenseId: true },
      }),
      tx.rateioAllocation.findMany({
        where: { tenantId, targetExpenseId: { in: [...uniqueTargetIds] } },
        select: { targetExpenseId: true, sourceExpenseId: true },
      }),
    ]);
    const settledTargets = new Set(targetSettlements.map((row) => row.targetExpenseId));
    const allocationByTarget = new Map(
      targetAllocations.map((row) => [row.targetExpenseId, row]),
    );
    for (const item of allocations) {
      const allocation = Math.round(item.allocation);
      if (allocation <= 0) {
        throw new BadRequestException('Cada alocação deve ser maior que zero.');
      }
      const target = targetById.get(item.targetExpenseId)!;
      if (target.projectId === source.projectId) {
        throw new BadRequestException('O rateio liga a compra a planejadas de OUTRO projeto.');
      }
      if (isNeutralExpenseType(target.tipoDespesa)) {
        throw new BadRequestException('Não é possível ratear em uma despesa neutra.');
      }
      if (settledTargets.has(target.id)) {
        throw new BadRequestException('A planejada já está conciliada por parcela.');
      }
      const existing = allocationByTarget.get(target.id);
      if (existing && existing.sourceExpenseId !== sourceExpenseId) {
        throw new BadRequestException('A planejada já está rateada por outra compra.');
      }
    }

    // limpa rateio anterior somente depois de autorizar e validar o conjunto todo
    await this.unratearSource(tx, { tenantId, sourceExpenseId }, requester);

    const targets: string[] = [];
    for (const item of allocations) {
      const allocation = Math.round(item.allocation);
      const target = targetById.get(item.targetExpenseId)!;

      const isSourceParcelado = !isSinglePaymentForm(source.formaPagamento);
      await tx.rateioAllocation.upsert({
        where: { targetExpenseId: target.id },
        create: {
          tenantId,
          sourceExpenseId,
          targetExpenseId: target.id,
          allocation,
          plannedStatus: target.status,
          plannedPaid: target.paidParcelas,
          // Snapshot do CRONOGRAMA original do alvo, para o unratearSource restaurar
          // depois que o overwrite abaixo o alinhar ao cronograma da fonte.
          plannedValor: target.valor,
          plannedQuantidade: target.quantidade,
          plannedValorTotal: target.valorTotal,
          plannedForma: target.formaPagamento,
          plannedQtdParcela: target.quantidadeParcela,
          plannedDataInicio: target.dataInicioParcela,
          plannedDataPagamento: target.dataPagamento,
          plannedInstallmentDateOverrides: target.installmentDateOverrides,
        },
        update: { allocation, sourceExpenseId },
      });

      // Alinha o REGISTRO do alvo ao cronograma da FONTE: valor = alocação,
      // mesma forma/parcelas/datas da compra. Assim a despesa associada mostra
      // "Parcelado Nx" (ou à vista) coerente com o caixa, na lista e no consolidado.
      await tx.expense.update({
        where: { id: target.id },
        data: {
          status: source.status === 'PAGO' ? 'PAGO' : 'PLANEJADO',
          paidParcelas: null,
          valor: allocation,
          quantidade: 1,
          valorTotal: allocation,
          formaPagamento: source.formaPagamento,
          quantidadeParcela: isSourceParcelado ? source.quantidadeParcela : null,
          dataInicioParcela: isSourceParcelado ? source.dataInicioParcela : null,
          dataPagamento: isSourceParcelado ? null : source.dataPagamento,
          installmentDateOverrides: isSourceParcelado ? source.installmentDateOverrides : null,
        },
      });

      await this.regenerateRateioTargetCashflow(tx, target.id);
      targets.push(target.id);
    }

    // a fonte vira espelho (dedupe no consolidado; permanece no caixa PESSOAL).
    // Update incondicional: unratearSource pode ter limpado o vínculo no banco e
    // o `source` em memória está defasado — não dá pra confiar no valor antigo.
    const firstTarget = targets[0]!;
    await tx.expense.update({ where: { id: source.id }, data: { linkedExpenseId: firstTarget } });

    return { targets };
  }

  /**
   * Desfaz o rateio de uma fonte: restaura status/paidParcelas dos alvos
   * (snapshot), regenera o caixa PLANEJADO de cada alvo e limpa o espelho da
   * fonte. Reversível e seguro quando não há rateio (no-op).
   */
  async unratearSource(
    tx: Tx,
    params: { tenantId: string; sourceExpenseId: string },
    requester: RateioRequester,
  ): Promise<{ targets: string[] }> {
    assertRateioRequester(requester, new NotFoundException('Despesa fonte não encontrada'));
    const { tenantId, sourceExpenseId } = params;
    await this.assertCanReverseSources(
      tx,
      { tenantId, sourceExpenseIds: [sourceExpenseId] },
      requester,
    );
    const rows = await tx.rateioAllocation.findMany({ where: { tenantId, sourceExpenseId } });
    if (rows.length === 0) return { targets: [] };

    const targets: string[] = [];
    for (const r of rows) {
      const target = await tx.expense.findFirst({
        where: { id: r.targetExpenseId, tenantId, deletedAt: null },
      });
      if (target) {
        await tx.expense.update({
          where: { id: target.id },
          data: {
            status: r.plannedStatus,
            paidParcelas: r.plannedPaid,
            // Restaura o cronograma original do alvo (se houver snapshot — rateios
            // criados antes desta feature não têm, então mantemos o valor atual).
            ...(r.plannedValorTotal != null
              ? {
                  valor: r.plannedValor ?? r.plannedValorTotal,
                  quantidade: r.plannedQuantidade ?? 1,
                  valorTotal: r.plannedValorTotal,
                  formaPagamento: r.plannedForma ?? 'A_VISTA',
                  quantidadeParcela: r.plannedQtdParcela,
                  dataInicioParcela: r.plannedDataInicio,
                  dataPagamento: r.plannedDataPagamento,
                  installmentDateOverrides: r.plannedInstallmentDateOverrides,
                }
              : {}),
          },
        });
      }
      await tx.rateioAllocation.delete({ where: { targetExpenseId: r.targetExpenseId } });
      // regen planejada (sem rateio nem settlements → caixa volta ao planejado)
      if (target) await this.regenerateTargetCashflow(tx, r.targetExpenseId);
      targets.push(r.targetExpenseId);
    }

    await tx.expense.update({ where: { id: sourceExpenseId }, data: { linkedExpenseId: null } });
    return { targets };
  }

  /**
   * Reverte QUALQUER vínculo cross-project originado por uma despesa-fonte, seja
   * conciliação por parcela (`CrossProjectSettlement`) ou rateio
   * (`RateioAllocation`). Usado pelo "desfazer importação": uma despesa criada
   * por um import pode ter sido, depois, vinculada/rateada manualmente — desfazer
   * o import sem reverter isso deixaria o alvo (outro projeto) quitado/rateado
   * apontando para uma fonte soft-deletada (órfão).
   *
   * Mutex garantido por `settleTargetParcela`/`ratearSource` (uma fonte nunca tem
   * os dois ao mesmo tempo), mas checamos ambos por segurança.
   */
  async reverseSourceLinks(
    tx: Tx,
    params: { tenantId: string; sourceExpenseId: string },
    requester: RateioRequester,
  ): Promise<{ mode: 'rateio' | 'settlement' | 'none'; targets: string[] }> {
    assertRateioRequester(requester, new NotFoundException('Despesa fonte não encontrada'));
    const { tenantId, sourceExpenseId } = params;
    await this.assertCanReverseSources(
      tx,
      { tenantId, sourceExpenseIds: [sourceExpenseId] },
      requester,
    );

    const rateioCount = await tx.rateioAllocation.count({
      where: { tenantId, sourceExpenseId },
    });
    if (rateioCount > 0) {
      const { targets } = await this.unratearSource(
        tx,
        { tenantId, sourceExpenseId },
        requester,
      );
      return { mode: 'rateio', targets };
    }

    const settlementCount = await tx.crossProjectSettlement.count({ where: { sourceExpenseId } });
    if (settlementCount > 0) {
      const { targets } = await this.unsettleBySource(
        tx,
        { tenantId, sourceExpenseId },
        requester,
      );
      return { mode: 'settlement', targets };
    }

    return { mode: 'none', targets: [] };
  }
}
