/**
 * Domain do Planejador de Compras (épico #271): função pura central que
 * projeta o impacto de um plano de compra (itens à vista/parcelado/
 * financiamento) sobre a projeção consolidada do PESSOAL.
 *
 * Zero fork: financiamento usa o MESMO gerador PRICE/SAC de
 * `loan-schedule.ts` que `financing.service` usa para financiamentos reais.
 * Parcelado usa o MESMO `buildInstallments` de `expense-installments.ts` que
 * despesas avulsas parceladas usam.
 */
import { buildInstallments } from './expense-installments';
import { buildPriceSchedule, buildSacSchedule, parseDateOnlyUtc } from './loan-schedule';
import { PaymentForm } from '../enums';

export type PurchasePlanItemType = 'A_VISTA' | 'PARCELADO' | 'FINANCIAMENTO';
export type PurchasePlanSistema = 'PRICE' | 'SAC';
export type PurchasePlanHorizonte = 3 | 6 | 12;

export interface PurchasePlanItem {
  tipo: PurchasePlanItemType;
  valorCents: number;
  /** "YYYY-MM" — mês em que o item começa a impactar o caixa. */
  mesInicio: string;
  /** Toggle OFF: item ignorado na série (critério de aceite do épico). */
  incluido: boolean;
  /** PARCELADO/FINANCIAMENTO */
  parcelas?: number;
  /** Só FINANCIAMENTO: abatido do principal, saída imediata em `mesInicio`. */
  entradaCents?: number;
  /** Só FINANCIAMENTO */
  taxaJurosMensalBps?: number;
  /** Só FINANCIAMENTO */
  sistema?: PurchasePlanSistema;
}

export interface PurchasePlanBaselineMonth {
  /** "YYYY-MM" */
  mes: string;
  /** Saldo acumulado projetado do PESSOAL para esse mês, SEM o plano de compra. */
  saldoProjetadoCents: number;
}

export interface PurchasePlanMonth {
  mes: string;
  saldoProjetadoCents: number;
  impactoPlanoCents: number;
  saldoComPlanoCents: number;
}

export interface PurchasePlanResult {
  meses: PurchasePlanMonth[];
  primeiroMesNegativo: string | null;
  menorSaldoCents: number;
  folgaMediaMensalCents: number;
}

function mesToUtcDate(mes: string): Date {
  return parseDateOnlyUtc(`${mes}-01`);
}

function addMonths(mes: string, offset: number): string {
  const d = mesToUtcDate(mes);
  const total = d.getUTCMonth() + offset;
  const year = d.getUTCFullYear() + Math.floor(total / 12);
  const month0 = ((total % 12) + 12) % 12;
  return `${year}-${String(month0 + 1).padStart(2, '0')}`;
}

/** Soma, por mês, o valor em centavos que um item tira do caixa. */
function itemImpactByMonth(item: PurchasePlanItem): Map<string, number> {
  const impact = new Map<string, number>();
  const add = (mes: string, cents: number) => {
    impact.set(mes, (impact.get(mes) ?? 0) + cents);
  };

  if (item.tipo === 'A_VISTA') {
    add(item.mesInicio, item.valorCents);
    return impact;
  }

  if (item.tipo === 'PARCELADO') {
    const n = Math.max(item.parcelas ?? 1, 1);
    const entries = buildInstallments({
      valorTotal: item.valorCents,
      formaPagamento: PaymentForm.PARCELADO,
      quantidadeParcela: n,
      dataInicioParcela: mesToUtcDate(item.mesInicio),
    });
    for (const entry of entries) {
      const mes = `${entry.data.getUTCFullYear()}-${String(entry.data.getUTCMonth() + 1).padStart(2, '0')}`;
      add(mes, entry.valor);
    }
    return impact;
  }

  // FINANCIAMENTO: entrada é saída imediata; o resto segue o cronograma
  // PRICE/SAC do MESMO gerador usado por financiamentos reais.
  const entrada = item.entradaCents ?? 0;
  if (entrada > 0) add(item.mesInicio, entrada);

  const principal = item.valorCents - entrada;
  const n = Math.max(item.parcelas ?? 1, 1);
  const bps = item.taxaJurosMensalBps ?? 0;
  const rows =
    item.sistema === 'SAC'
      ? buildSacSchedule(principal, bps, n)
      : buildPriceSchedule(principal, bps, n);

  for (let i = 0; i < rows.length; i++) {
    add(addMonths(item.mesInicio, i), rows[i]!.valorPrevisto);
  }
  return impact;
}

/**
 * Projeta `itens` (à vista/parcelado/financiamento) sobre `baselineMeses`
 * (projeção consolidada do PESSOAL já existente, sem o plano) e retorna o
 * veredito para o `horizonte` pedido (3, 6 ou 12 meses).
 *
 * `baselineMeses` deve ter pelo menos `horizonte` meses, em ordem
 * cronológica, a partir do mês corrente — a função não busca dados, só
 * recalcula sobre o array recebido (permite trocar 3→6→12 sem novo fetch).
 */
export function applyPurchasePlan(
  baselineMeses: PurchasePlanBaselineMonth[],
  itens: PurchasePlanItem[],
  horizonte: PurchasePlanHorizonte,
): PurchasePlanResult {
  const janela = baselineMeses.slice(0, horizonte);

  const impactByMonth = new Map<string, number>();
  for (const item of itens) {
    if (!item.incluido) continue;
    const itemImpact = itemImpactByMonth(item);
    for (const [mes, cents] of itemImpact) {
      impactByMonth.set(mes, (impactByMonth.get(mes) ?? 0) + cents);
    }
  }

  let cumulativeImpacto = 0;
  const meses: PurchasePlanMonth[] = janela.map((baseline) => {
    cumulativeImpacto += impactByMonth.get(baseline.mes) ?? 0;
    return {
      mes: baseline.mes,
      saldoProjetadoCents: baseline.saldoProjetadoCents,
      impactoPlanoCents: cumulativeImpacto,
      saldoComPlanoCents: baseline.saldoProjetadoCents - cumulativeImpacto,
    };
  });

  const primeiroMesNegativo = meses.find((m) => m.saldoComPlanoCents < 0)?.mes ?? null;
  const menorSaldoCents = meses.length
    ? Math.min(...meses.map((m) => m.saldoComPlanoCents))
    : 0;

  // ponytail: "folga média mensal" = média das variações mês-a-mês do saldo
  // COM plano (n-1 deltas; o 1º mês não tem "mês anterior" na janela e fica
  // de fora da média). Se o PO quiser incluir o delta do 1º mês contra o
  // saldo de entrada, é só passar esse valor como `baselineMeses[-1]`.
  let folgaMediaMensalCents = 0;
  if (meses.length > 1) {
    let somaDeltas = 0;
    for (let i = 1; i < meses.length; i++) {
      somaDeltas += meses[i]!.saldoComPlanoCents - meses[i - 1]!.saldoComPlanoCents;
    }
    folgaMediaMensalCents = Math.round(somaDeltas / (meses.length - 1));
  }

  return { meses, primeiroMesNegativo, menorSaldoCents, folgaMediaMensalCents };
}
