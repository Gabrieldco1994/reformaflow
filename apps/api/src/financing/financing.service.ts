import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, FinancingInstallment } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ExpenseService } from '../expense/expense.service';
import { CreateExpenseDto } from '../expense/dto/create-expense.dto';
import { UpsertFinancingDto, PayInstallmentDto } from './dto/financing.dto';
import {
  buildPriceSchedule,
  buildSacSchedule,
  monthlyDueDate,
  parseDateOnlyUtc,
} from '@reformaflow/domain';

// Matemática pura de amortização mora em packages/domain (compartilhada com o
// Planejador de Compras, épico #271). Re-exportada aqui para manter o import
// existente em `financing.service.spec.ts` sem alterações.
export { buildPriceSchedule, buildSacSchedule, monthlyDueDate, parseDateOnlyUtc };

type FinancingDb = PrismaService | Prisma.TransactionClient;

/** Janela rolling de materialização: só parcelas com vencimento dentro dos
 * próximos N meses viram despesa PLANEJADA (nunca as 360 de uma vez). */
const ROLLING_WINDOW_MONTHS = 12;

/** Formata uma Date UTC como "YYYY-MM-DD" (mesmo formato aceito por CreateExpenseDto). */
function toDateOnlyString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

@Injectable()
export class FinancingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly expenseService: ExpenseService,
  ) {}

  async get(tenantId: string, projectId: string) {
    return this.getWithSummary(this.prisma, tenantId, projectId);
  }

  async upsert(tenantId: string, projectId: string, dto: UpsertFinancingDto) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.financing.findFirst({
        where: { projectId, tenantId, deletedAt: null },
      });

      const anchor = parseDateOnlyUtc(dto.dataPrimeiraParcela);
      const rows =
        dto.sistema === 'SAC'
          ? buildSacSchedule(dto.valorTotalFinanciado, dto.taxaJurosMensalBps, dto.prazoMeses)
          : buildPriceSchedule(dto.valorTotalFinanciado, dto.taxaJurosMensalBps, dto.prazoMeses);

      const schedule = rows.map((row, idx) => ({
        numeroParcela: idx + 1,
        dataVencimento: monthlyDueDate(anchor, idx, dto.diaVencimento),
        valorPrevisto: row.valorPrevisto,
        saldoDevedorPrevisto: row.saldoDevedorPrevisto,
      }));

      const baseData = {
        instituicao: dto.instituicao,
        sistema: dto.sistema,
        valorTotalFinanciado: dto.valorTotalFinanciado,
        taxaJurosMensalBps: dto.taxaJurosMensalBps,
        prazoMeses: dto.prazoMeses,
        dataPrimeiraParcela: anchor,
        diaVencimento: dto.diaVencimento,
        observacoes: dto.observacoes,
      };

      let financingId: string;
      let materializable: FinancingInstallment[];

      if (!existing) {
        const created = await tx.financing.create({
          data: { tenantId, projectId, ...baseData },
        });
        financingId = created.id;
        await tx.financingInstallment.createMany({
          data: schedule.map((row) => ({ ...row, financingId, projectId, tenantId })),
        });
        materializable = await tx.financingInstallment.findMany({
          where: { financingId, deletedAt: null },
          orderBy: { numeroParcela: 'asc' },
        });
      } else {
        financingId = existing.id;
        const current = await tx.financingInstallment.findMany({
          where: { financingId, deletedAt: null },
          orderBy: { numeroParcela: 'asc' },
        });

        const protectedNumeros = new Set<number>();
        for (const installment of current) {
          if (await this.isInstallmentProtected(tx, installment)) {
            protectedNumeros.add(installment.numeroParcela);
          }
        }
        const maxProtectedNumero = protectedNumeros.size > 0 ? Math.max(...protectedNumeros) : 0;
        if (dto.prazoMeses < maxProtectedNumero) {
          throw new BadRequestException(
            `Prazo (${dto.prazoMeses}) não pode ser menor que a parcela ${maxProtectedNumero}, já paga ou vinculada`,
          );
        }

        await tx.financing.update({ where: { id: financingId }, data: baseData });

        // Recalcula do zero as parcelas NÃO protegidas: as protegidas (pagas ou
        // vinculadas via rateio ao PESSOAL) preservam id/expenseId intocados.
        // Hard-delete (não soft): parcela PREVISTA nunca paga/vinculada não tem
        // valor de auditoria e o índice único (financingId, numeroParcela) colidiria
        // com um soft-delete (a linha continuaria existindo fisicamente).
        const toDiscard = current.filter((i) => !protectedNumeros.has(i.numeroParcela));
        await this.discardInstallments(tx, toDiscard);

        const toInsert = schedule.filter((row) => !protectedNumeros.has(row.numeroParcela));
        if (toInsert.length > 0) {
          await tx.financingInstallment.createMany({
            data: toInsert.map((row) => ({ ...row, financingId, projectId, tenantId })),
          });
        }

        materializable = await tx.financingInstallment.findMany({
          where: { financingId, deletedAt: null, expenseId: null },
          orderBy: { numeroParcela: 'asc' },
        });
      }

      await this.materializeWindow(tx, tenantId, projectId, materializable, dto.prazoMeses);

      return this.getWithSummary(tx, tenantId, projectId);
    });
  }

  async remove(tenantId: string, projectId: string) {
    return this.prisma.$transaction(async (tx) => {
      const financing = await tx.financing.findFirst({
        where: { projectId, tenantId, deletedAt: null },
        include: { installments: { where: { deletedAt: null } } },
      });
      if (!financing) throw new NotFoundException('Financiamento não encontrado');

      const now = new Date();
      for (const installment of financing.installments) {
        if (await this.isInstallmentProtected(tx, installment)) continue;
        if (installment.expenseId) {
          await tx.cashFlowEntry.updateMany({
            where: { expenseId: installment.expenseId, deletedAt: null },
            data: { deletedAt: now },
          });
          await tx.expense.updateMany({
            where: { id: installment.expenseId, deletedAt: null },
            data: { deletedAt: now },
          });
        }
        await tx.financingInstallment.update({
          where: { id: installment.id },
          data: { deletedAt: now },
        });
      }

      await tx.financing.update({ where: { id: financing.id }, data: { deletedAt: now } });
      return { deleted: true };
    });
  }

  /**
   * Uma parcela é PROTEGIDA (nunca tocada por edição/recálculo) quando já foi
   * paga diretamente (FinancingInstallment.status = PAGO) OU quando sua despesa
   * espelho está PAGA ou foi rateada a partir de uma compra do PESSOAL
   * (RateioAllocation.targetExpenseId aponta para ela — regras 14/15).
   */
  private async isInstallmentProtected(
    tx: Prisma.TransactionClient,
    installment: Pick<FinancingInstallment, 'status' | 'expenseId'>,
  ): Promise<boolean> {
    if (installment.status === 'PAGO') return true;
    if (!installment.expenseId) return false;

    const expense = await tx.expense.findUnique({
      where: { id: installment.expenseId },
      select: { status: true },
    });
    if (expense?.status === 'PAGO') return true;

    const rateio = await tx.rateioAllocation.findUnique({
      where: { targetExpenseId: installment.expenseId },
    });
    return !!rateio;
  }

  /** Descarta (hard-delete) parcelas efêmeras e suas despesas espelho (soft-delete). */
  private async discardInstallments(
    tx: Prisma.TransactionClient,
    installments: FinancingInstallment[],
  ) {
    if (installments.length === 0) return;
    const now = new Date();
    const expenseIds = installments
      .map((i) => i.expenseId)
      .filter((id): id is string => !!id);
    if (expenseIds.length > 0) {
      await tx.cashFlowEntry.updateMany({
        where: { expenseId: { in: expenseIds }, deletedAt: null },
        data: { deletedAt: now },
      });
      await tx.expense.updateMany({
        where: { id: { in: expenseIds }, deletedAt: null },
        data: { deletedAt: now },
      });
    }
    const ids = installments.map((i) => i.id);
    await tx.$executeRaw`DELETE FROM financing_installments WHERE id IN (${Prisma.join(ids)})`;
  }

  /**
   * Materializa (cria a despesa PLANEJADA espelho de) cada parcela sem
   * expenseId cujo vencimento esteja dentro da janela rolling de
   * ROLLING_WINDOW_MONTHS a partir de agora — nunca as 360 parcelas de uma vez.
   */
  private async materializeWindow(
    tx: Prisma.TransactionClient,
    tenantId: string,
    projectId: string,
    installments: FinancingInstallment[],
    prazoMeses: number,
  ) {
    const now = new Date();
    const horizonEnd = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + ROLLING_WINDOW_MONTHS, now.getUTCDate()),
    );

    for (const installment of installments) {
      if (installment.expenseId) continue;
      if (installment.dataVencimento > horizonEnd) continue;

      const dto: CreateExpenseDto = {
        tipoDespesa: 'FINANCIAMENTO',
        valor: installment.valorPrevisto / 100,
        quantidade: 1,
        titulo: `Parcela ${installment.numeroParcela}/${prazoMeses}`,
        formaPagamento: 'A_VISTA',
        dataPagamento: toDateOnlyString(installment.dataVencimento),
        status: 'PLANEJADO',
      } as CreateExpenseDto;

      const expense = await this.expenseService.create(tenantId, projectId, dto, null, tx);
      await tx.financingInstallment.update({
        where: { id: installment.id },
        data: { expenseId: expense.id },
      });
    }
  }

  async payInstallment(
    tenantId: string,
    projectId: string,
    id: string,
    dto: PayInstallmentDto,
  ) {
    if (dto.valorPago < 1) {
      throw new BadRequestException('Valor pago deve ser maior que zero');
    }

    return this.prisma.$transaction(async (tx) => {
      const installment = await tx.financingInstallment.findFirst({
        where: { id, tenantId, projectId, deletedAt: null },
      });
      if (!installment) throw new NotFoundException('Parcela não encontrada');

      const dataPagamento = parseDateOnlyUtc(dto.dataPagamento);
      const updated = await tx.financingInstallment.update({
        where: { id },
        data: { status: 'PAGO', valorPago: dto.valorPago, dataPagamento },
      });

      // Sincroniza a despesa espelho (#276): sem isso, marcar a parcela paga
      // aqui deixava o consolidado (faltaPagarMes/Contas Vencidas) desatualizado
      // (#294). Parcela fora da janela rolling (sem expenseId) não tem espelho
      // — nada a sincronizar, não é erro.
      if (installment.expenseId) {
        await this.expenseService.markPaidInPlace(tenantId, installment.expenseId, dataPagamento, tx);
      }

      return updated;
    });
  }

  private async getWithSummary(
    client: FinancingDb,
    tenantId: string,
    projectId: string,
  ) {
    const financing = await client.financing.findFirst({
      where: { projectId, tenantId, deletedAt: null },
      include: {
        installments: {
          where: { deletedAt: null },
          orderBy: { numeroParcela: 'asc' },
        },
      },
    });
    if (!financing) return null;

    const installments: FinancingInstallment[] = financing.installments;
    const paid = installments.filter((i) => i.status === 'PAGO');
    const valorPago = paid.reduce((sum, i) => sum + (i.valorPago ?? 0), 0);
    const paidNumbers = new Set(paid.map((installment) => installment.numeroParcela));
    let contiguousPaidCount = 0;
    for (const installment of installments) {
      if (!paidNumbers.has(installment.numeroParcela)) break;
      contiguousPaidCount += 1;
    }
    const currentSchedule =
      financing.sistema === 'SAC'
        ? buildSacSchedule(
            financing.valorTotalFinanciado,
            financing.taxaJurosMensalBps,
            financing.prazoMeses,
          )
        : buildPriceSchedule(
            financing.valorTotalFinanciado,
            financing.taxaJurosMensalBps,
            financing.prazoMeses,
          );
    const saldoDevedor = contiguousPaidCount > 0
      ? currentSchedule[contiguousPaidCount - 1].saldoDevedorPrevisto
      : financing.valorTotalFinanciado;
    const proximaParcela = installments.find((i) => i.status === 'PREVISTO') ?? null;
    const progresso = installments.length > 0 ? Math.round((paid.length / installments.length) * 100) : 0;

    return {
      ...financing,
      installments,
      summary: {
        valorPago,
        saldoDevedor,
        proximaParcela,
        progresso,
        totalParcelas: installments.length,
        parcelasPagas: paid.length,
      },
    };
  }
}
