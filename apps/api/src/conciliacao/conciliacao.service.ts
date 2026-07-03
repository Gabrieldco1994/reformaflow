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

type Tx = Prisma.TransactionClient;

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

  async settleTargetParcela(tx: Tx, input: SettleParcelaInput): Promise<void> {
    const { tenantId, sourceExpenseId, targetExpenseId, realValor } = input;

    const target = await tx.expense.findFirst({
      where: { id: targetExpenseId, tenantId, deletedAt: null },
    });
    if (!target) throw new NotFoundException('Despesa alvo não encontrada');

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
    const rateioCount = await tx.rateioAllocation.count({ where: { sourceExpenseId } });
    if (rateioCount > 0) {
      throw new BadRequestException(
        'Esta compra já está rateada; desfaça o rateio antes de conciliar por parcela.',
      );
    }

    // E5 (simétrico) — o ALVO não pode já ser destino de um rateio. Se fosse,
    // `regenerateTargetCashflow` (que ignora RateioAllocation) sobrescreveria o
    // caixa rateado e criaria um 2º espelho ativo apontando ao mesmo alvo →
    // divergência/dupla contagem. Espelha o guard de ratearSource (:428-429).
    const targetRateioCount = await tx.rateioAllocation.count({ where: { targetExpenseId } });
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
  ): Promise<{ targets: string[] }> {
    const { tenantId, sourceExpenseId } = params;
    const rows = await tx.crossProjectSettlement.findMany({
      where: { tenantId, sourceExpenseId },
    });

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

    const alloc = await tx.rateioAllocation.findUnique({ where: { targetExpenseId } });
    if (!alloc) return; // sem rateio: o caller deve usar a regeneração planejada

    const source = await tx.expense.findFirst({
      where: { id: alloc.sourceExpenseId, deletedAt: null },
    });
    if (!source) return;

    const slices = buildInstallments({
      valorTotal: alloc.allocation,
      formaPagamento: source.formaPagamento,
      dataPagamento: source.dataPagamento,
      quantidadeParcela: source.quantidadeParcela,
      dataInicioParcela: source.dataInicioParcela,
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
   */
  async ratearSource(tx: Tx, input: RatearInput): Promise<{ targets: string[] }> {
    const { tenantId, sourceExpenseId, allocations } = input;

    const source = await tx.expense.findFirst({
      where: { id: sourceExpenseId, tenantId, deletedAt: null },
    });
    if (!source) throw new NotFoundException('Despesa fonte não encontrada');
    if (allocations.length === 0) {
      throw new BadRequestException('Informe ao menos uma planejada para ratear');
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

    // limpa rateio anterior desta fonte (snapshots ficam consistentes)
    await this.unratearSource(tx, { tenantId, sourceExpenseId });

    const targets: string[] = [];
    for (const item of allocations) {
      const allocation = Math.round(item.allocation);
      if (allocation <= 0) throw new BadRequestException('Cada alocação deve ser maior que zero.');

      const target = await tx.expense.findFirst({
        where: { id: item.targetExpenseId, tenantId, deletedAt: null },
      });
      if (!target) throw new BadRequestException(`Despesa alvo ${item.targetExpenseId} não encontrada`);
      if (target.projectId === source.projectId) {
        throw new BadRequestException('O rateio liga a compra a planejadas de OUTRO projeto.');
      }
      if (isNeutralExpenseType(target.tipoDespesa)) {
        throw new BadRequestException('Não é possível ratear em uma despesa neutra.');
      }
      const tConc = await tx.crossProjectSettlement.count({ where: { targetExpenseId: target.id } });
      if (tConc > 0) throw new BadRequestException('A planejada já está conciliada por parcela.');
      const existing = await tx.rateioAllocation.findUnique({ where: { targetExpenseId: target.id } });
      if (existing && existing.sourceExpenseId !== sourceExpenseId) {
        throw new BadRequestException('A planejada já está rateada por outra compra.');
      }

      await tx.rateioAllocation.upsert({
        where: { targetExpenseId: target.id },
        create: {
          tenantId,
          sourceExpenseId,
          targetExpenseId: target.id,
          allocation,
          plannedStatus: target.status,
          plannedPaid: target.paidParcelas,
        },
        update: { allocation, sourceExpenseId },
      });

      await tx.expense.update({
        where: { id: target.id },
        data: { status: source.status === 'PAGO' ? 'PAGO' : 'PLANEJADO', paidParcelas: null },
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
  ): Promise<{ targets: string[] }> {
    const { tenantId, sourceExpenseId } = params;
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
          data: { status: r.plannedStatus, paidParcelas: r.plannedPaid },
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
}
