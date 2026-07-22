import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, FinancingInstallment } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UpsertFinancingDto, PayInstallmentDto } from './dto/financing.dto';

type FinancingDb = PrismaService | Prisma.TransactionClient;

interface ScheduleRow {
  valorPrevisto: number;
  saldoDevedorPrevisto: number;
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
  constructor(private readonly prisma: PrismaService) {}

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

      if (!existing) {
        const created = await tx.financing.create({
          data: { tenantId, projectId, ...baseData },
        });
        financingId = created.id;
        await tx.financingInstallment.createMany({
          data: schedule.map((row) => ({ ...row, financingId, projectId, tenantId })),
        });
      } else {
        financingId = existing.id;
        const paid = await tx.financingInstallment.findMany({
          where: { financingId, status: 'PAGO', deletedAt: null },
        });
        const maxPaidNumero = paid.reduce((max, p) => Math.max(max, p.numeroParcela), 0);
        if (dto.prazoMeses < maxPaidNumero) {
          throw new BadRequestException(
            `Prazo (${dto.prazoMeses}) não pode ser menor que a parcela ${maxPaidNumero}, já paga`,
          );
        }
        const paidNumeros = new Set(paid.map((p) => p.numeroParcela));

        await tx.financing.update({ where: { id: financingId }, data: baseData });
        await tx.financingInstallment.deleteMany({
          where: { financingId, status: 'PREVISTO' },
        });
        const toInsert = schedule.filter((row) => !paidNumeros.has(row.numeroParcela));
        if (toInsert.length > 0) {
          await tx.financingInstallment.createMany({
            data: toInsert.map((row) => ({ ...row, financingId, projectId, tenantId })),
          });
        }
      }

      return this.getWithSummary(tx, tenantId, projectId);
    });
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
