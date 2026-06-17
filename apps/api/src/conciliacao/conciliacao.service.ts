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

    const n = Math.max(1, target.quantidadeParcela ?? 1);
    const singlePayment = isSinglePaymentForm(target.formaPagamento);
    const parcelaIndex = singlePayment ? 0 : Math.min(Math.max(0, input.parcelaIndex | 0), n - 1);

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

    await tx.expense.update({
      where: { id: sourceExpenseId },
      data: { linkedExpenseId: null },
    });

    return { targets };
  }
}
