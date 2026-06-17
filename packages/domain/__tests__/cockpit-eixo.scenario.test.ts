import { describe, it, expect } from 'vitest';
import {
  buildInstallments,
  caixaDateForCardPurchase,
  buildMonthlyOverview,
  PaymentForm,
  type MonthlyOverviewEntry,
} from '../src';

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

/**
 * Caso de teste na ÓTICA DO USUÁRIO (aceitação do toggle "Gastei / Vai sair").
 *
 * Cenário: o usuário comprou R$ 300,00 no cartão (fecha dia 28, vence dia 7),
 * parcelado em 3x, com a 1ª parcela em 15/jan/2026. As parcelas são geradas
 * como lançamentos mensais (competência): jan, fev, mar.
 *
 * - Eixo "Gastei" (competência): o usuário vê R$ 100,00 em jan, fev e mar.
 * - Eixo "Vai sair" (caixa): cada parcela é remapeada para o mês de VENCIMENTO
 *   da fatura → o usuário vê R$ 100,00 em fev, mar e abr.
 *
 * Compõe exatamente as funções de domínio que o cockpit usa para alimentar o
 * toggle, garantindo que a tela reprojeta de forma coerente.
 */
describe('Cockpit — toggle Gastei/Vai sair (ótica do usuário)', () => {
  const CARD = { last4: '1234', closingDay: 28, dueDay: 7 };

  // Lançamentos de parcela como o backend materializa (cada um com cardLast4).
  const parcelas = buildInstallments({
    valorTotal: 30000,
    formaPagamento: PaymentForm.PARCELADO,
    quantidadeParcela: 3,
    dataInicioParcela: utc(2026, 1, 15),
  });

  it('parcelas caem em jan/fev/mar (competência) com R$ 100,00 cada', () => {
    const entries: MonthlyOverviewEntry[] = parcelas.map((p) => ({
      tipo: 'DESPESA',
      valor: p.valor,
      status: 'PAGO',
      data: p.data,
      categoria: 'Compras / Varejo',
      projectOrigin: 'PESSOAL',
    }));
    const rows = buildMonthlyOverview(entries);
    const byMes = Object.fromEntries(rows.map((r) => [r.mes, r.totalDespesas]));
    expect(byMes['2026-01']).toBe(10000);
    expect(byMes['2026-02']).toBe(10000);
    expect(byMes['2026-03']).toBe(10000);
    expect(byMes['2026-04']).toBeUndefined();
  });

  it('no eixo "Vai sair" as parcelas migram para fev/mar/abr (vencimento)', () => {
    // Remapeia cada parcela para a data de caixa (vencimento da fatura do cartão).
    const entries: MonthlyOverviewEntry[] = parcelas.map((p) => ({
      tipo: 'DESPESA',
      valor: p.valor,
      status: 'PAGO',
      data: caixaDateForCardPurchase(p.data, CARD.closingDay, CARD.dueDay),
      categoria: 'Compras / Varejo',
      projectOrigin: 'PESSOAL',
    }));
    const rows = buildMonthlyOverview(entries);
    const byMes = Object.fromEntries(rows.map((r) => [r.mes, r.totalDespesas]));
    expect(byMes['2026-01']).toBeUndefined();
    expect(byMes['2026-02']).toBe(10000);
    expect(byMes['2026-03']).toBe(10000);
    expect(byMes['2026-04']).toBe(10000);
  });

  it('o total gasto é o mesmo nos dois eixos (R$ 300,00) — só muda QUANDO sai', () => {
    const totalCompetencia = parcelas.reduce((s, p) => s + p.valor, 0);
    const totalCaixa = parcelas
      .map((p) => ({ ...p, data: caixaDateForCardPurchase(p.data, CARD.closingDay, CARD.dueDay) }))
      .reduce((s, p) => s + p.valor, 0);
    expect(totalCompetencia).toBe(30000);
    expect(totalCaixa).toBe(30000);
  });
});
