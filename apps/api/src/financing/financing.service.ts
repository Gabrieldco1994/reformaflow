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

type FinancingDb = PrismaService | Prisma.TransactionClient;

interface ScheduleRow {
  valorPrevisto: number;
  saldoDevedorPrevisto: number;
}

/** Janela rolling de materialização: só parcelas com vencimento dentro dos
 * próximos N meses viram despesa PLANEJADA (nunca as 360 de uma vez). */
const ROLLING_WINDOW_MONTHS = 12;

/** Formata uma Date UTC como "YYYY-MM-DD" (mesmo formato aceito por CreateExpenseDto). */
function toDateOnlyString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Parses a strict "YYYY-MM-DD" string into a UTC midnight Date (timezone-safe). */
export function parseDateOnlyUtc(value: string): Date {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Days in a given UTC year/month (0-indexed month). */
function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/**
 * Due date for installment `offset` months after `anchor`'s year/month,
 * clamped to `day` (1-31 -> last day of the target month when shorter).
 */
export function monthlyDueDate(anchor: Date, offset: number, day: number): Date {
  const totalMonth = anchor.getUTCMonth() + offset;
  const year = anchor.getUTCFullYear() + Math.floor(totalMonth / 12);
  const month0 = ((totalMonth % 12) + 12) % 12;
  const clampedDay = Math.min(day, daysInMonth(year, month0));
  return new Date(Date.UTC(year, month0, clampedDay));
}

/**
 * Sistema PRICE (Tabela Price): prestação fixa.
 * P*r*(1+r)^n / ((1+r)^n - 1); r = bps/10000. Com r=0 divide o principal em
 * parcelas iguais (resto na última). A última parcela sempre zera o saldo,
 * absorvendo o desvio de arredondamento acumulado.
 */
export function buildPriceSchedule(
  principal: number,
  bps: number,
  n: number,
): ScheduleRow[] {
  const r = bps / 10000;
  const rows: ScheduleRow[] = [];

  if (r === 0) {
    const base = Math.floor(principal / n);
    const remainder = principal - base * n;
    let saldo = principal;
    for (let i = 1; i <= n; i++) {
      const valor = i === n ? base + remainder : base;
      saldo -= valor;
      rows.push({
        valorPrevisto: valor,
        saldoDevedorPrevisto: i === n ? 0 : Math.max(saldo, 0),
      });
    }
    return rows;
  }

  const prestacao = Math.round((principal * r) / (1 - Math.pow(1 + r, -n)));
  let saldo = principal;
  for (let i = 1; i <= n; i++) {
    const juros = Math.round(saldo * r);
    let principalPart = Math.min(prestacao - juros, saldo);
    let valorPrevisto = prestacao;
    if (i === n) {
      // Zera o saldo exatamente na última parcela, absorvendo o desvio de
      // arredondamento acumulado ao longo das parcelas anteriores.
      principalPart = saldo;
      valorPrevisto = principalPart + juros;
    }
    saldo = Math.max(saldo - principalPart, 0);
    rows.push({
      valorPrevisto,
      saldoDevedorPrevisto: i === n ? 0 : saldo,
    });
  }
  return rows;
}

/**
 * Sistema SAC: amortização de principal fixa (resto na última parcela),
 * juros incidem sobre o saldo devedor inicial de cada parcela — por isso a
 * prestação é decrescente.
 */
export function buildSacSchedule(
  principal: number,
  bps: number,
  n: number,
): ScheduleRow[] {
  const r = bps / 10000;
  const base = Math.floor(principal / n);
  const remainder = principal - base * n;
  let saldo = principal;
  const rows: ScheduleRow[] = [];
  for (let i = 1; i <= n; i++) {
    const amortizacao = i === n ? base + remainder : base;
    const juros = Math.round(saldo * r);
    saldo = Math.max(saldo - amortizacao, 0);
    rows.push({
      valorPrevisto: amortizacao + juros,
      saldoDevedorPrevisto: i === n ? 0 : saldo,
    });
  }
  return rows;
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
    const installment = await this.prisma.financingInstallment.findFirst({
      where: { id, tenantId, projectId, deletedAt: null },
    });
    if (!installment) throw new NotFoundException('Parcela não encontrada');

    return this.prisma.financingInstallment.update({
      where: { id },
      data: {
        status: 'PAGO',
        valorPago: dto.valorPago,
        dataPagamento: parseDateOnlyUtc(dto.dataPagamento),
      },
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
