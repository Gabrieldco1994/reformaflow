import { describe, it, expect } from 'vitest';
import { buildPriceSchedule, buildSacSchedule } from '../src/calculations/loan-schedule';
import { applyPurchasePlan, type PurchasePlanBaselineMonth, type PurchasePlanItem } from '../src/calculations/purchase-plan';

function baseline12(saldoInicialCents: number, deltaMensalCents: number): PurchasePlanBaselineMonth[] {
  return Array.from({ length: 12 }, (_, i) => ({
    mes: `2026-${String(i + 1).padStart(2, '0')}`,
    saldoProjetadoCents: saldoInicialCents + deltaMensalCents * i,
  }));
}

describe('applyPurchasePlan — PARIDADE (coração do épico)', () => {
  it('parcela nº1 do item FINANCIAMENTO (PRICE) é igual à do gerador real usado por financing.service', () => {
    const principal = 100_000_00;
    const bps = 150;
    const parcelas = 24;
    const [expectedFirstRow] = buildPriceSchedule(principal, bps, parcelas);

    const item: PurchasePlanItem = {
      tipo: 'FINANCIAMENTO',
      valorCents: principal,
      mesInicio: '2026-01',
      incluido: true,
      parcelas,
      taxaJurosMensalBps: bps,
      sistema: 'PRICE',
    };
    const result = applyPurchasePlan(baseline12(0, 0), [item], 3);

    expect(result.meses[0]!.impactoPlanoCents).toBe(expectedFirstRow!.valorPrevisto);
  });

  it('parcela nº1 do item FINANCIAMENTO (SAC) é igual à do gerador real usado por financing.service', () => {
    const principal = 60_000_00;
    const bps = 90;
    const parcelas = 12;
    const [expectedFirstRow] = buildSacSchedule(principal, bps, parcelas);

    const item: PurchasePlanItem = {
      tipo: 'FINANCIAMENTO',
      valorCents: principal,
      mesInicio: '2026-01',
      incluido: true,
      parcelas,
      taxaJurosMensalBps: bps,
      sistema: 'SAC',
    };
    const result = applyPurchasePlan(baseline12(0, 0), [item], 3);

    expect(result.meses[0]!.impactoPlanoCents).toBe(expectedFirstRow!.valorPrevisto);
  });

  it('financiamento com entrada: mês 1 soma entrada + parcela nº1', () => {
    const principal = 90_000_00;
    const entrada = 10_000_00;
    const bps = 100;
    const parcelas = 10;
    const [expectedFirstRow] = buildPriceSchedule(principal - entrada, bps, parcelas);

    const item: PurchasePlanItem = {
      tipo: 'FINANCIAMENTO',
      valorCents: principal,
      entradaCents: entrada,
      mesInicio: '2026-01',
      incluido: true,
      parcelas,
      taxaJurosMensalBps: bps,
      sistema: 'PRICE',
    };
    const result = applyPurchasePlan(baseline12(0, 0), [item], 3);

    expect(result.meses[0]!.impactoPlanoCents).toBe(entrada + expectedFirstRow!.valorPrevisto);
  });
});

describe('applyPurchasePlan — à vista e parcelado', () => {
  it('à vista: hit único no mês, some do impacto nos meses seguintes só se não houver mais itens', () => {
    const item: PurchasePlanItem = {
      tipo: 'A_VISTA',
      valorCents: 5_000_00,
      mesInicio: '2026-02',
      incluido: true,
    };
    const result = applyPurchasePlan(baseline12(10_000_00, 0), [item], 3);

    expect(result.meses[0]!.impactoPlanoCents).toBe(0); // jan: antes do hit
    expect(result.meses[1]!.impactoPlanoCents).toBe(5_000_00); // fev: hit
    expect(result.meses[2]!.impactoPlanoCents).toBe(5_000_00); // mar: carrega (saldo acumulado)
  });

  it('parcelado N×: soma exata em centavos (sem perda de arredondamento)', () => {
    const item: PurchasePlanItem = {
      tipo: 'PARCELADO',
      valorCents: 1000, // 1000 / 3 = 333.33...
      mesInicio: '2026-01',
      incluido: true,
      parcelas: 3,
    };
    const result = applyPurchasePlan(baseline12(0, 0), [item], 3);

    const somaTotal = result.meses[2]!.impactoPlanoCents; // acumulado até o 3º mês = soma de todas
    expect(somaTotal).toBe(1000);
  });

  it('item com toggle OFF não afeta a série', () => {
    const item: PurchasePlanItem = {
      tipo: 'A_VISTA',
      valorCents: 5_000_00,
      mesInicio: '2026-01',
      incluido: false,
    };
    const result = applyPurchasePlan(baseline12(10_000_00, 0), [item], 3);

    expect(result.meses.every((m) => m.impactoPlanoCents === 0)).toBe(true);
    expect(result.meses.every((m) => m.saldoComPlanoCents === m.saldoProjetadoCents)).toBe(true);
  });
});

describe('applyPurchasePlan — veredito', () => {
  it('detecta o primeiro mês negativo e o menor saldo dentro do horizonte', () => {
    const item: PurchasePlanItem = {
      tipo: 'A_VISTA',
      valorCents: 15_000_00,
      mesInicio: '2026-02',
      incluido: true,
    };
    const result = applyPurchasePlan(baseline12(10_000_00, 0), [item], 6);

    expect(result.primeiroMesNegativo).toBe('2026-02');
    expect(result.menorSaldoCents).toBe(10_000_00 - 15_000_00);
  });

  it('sem mês negativo, primeiroMesNegativo é null', () => {
    const result = applyPurchasePlan(baseline12(100_000_00, 0), [], 3);
    expect(result.primeiroMesNegativo).toBeNull();
  });

  it('recalcula sem novo fetch ao trocar horizonte 3→6→12 sobre o mesmo baseline', () => {
    const item: PurchasePlanItem = {
      tipo: 'A_VISTA',
      valorCents: 1_000_00,
      mesInicio: '2026-05',
      incluido: true,
    };
    const baseline = baseline12(10_000_00, 0);

    const r3 = applyPurchasePlan(baseline, [item], 3);
    const r6 = applyPurchasePlan(baseline, [item], 6);
    const r12 = applyPurchasePlan(baseline, [item], 12);

    expect(r3.meses).toHaveLength(3);
    expect(r6.meses).toHaveLength(6);
    expect(r12.meses).toHaveLength(12);
    // mesmo baseline, mesmo item: os primeiros 3 meses são idênticos em qualquer horizonte
    expect(r6.meses.slice(0, 3)).toEqual(r3.meses);
    expect(r12.meses.slice(0, 6)).toEqual(r6.meses);
  });
});
