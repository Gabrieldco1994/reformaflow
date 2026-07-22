import * as fs from 'fs';
import * as path from 'path';
import { parseBankStatementBuffers } from './parsers';
import { parseStatementBuffers } from '../credit-card/parsers';

/**
 * QA manual do dono: fatura Nubank real (CSV, parcelas 1/2, 2/4, 5/10)
 * importada pelo caminho "Extrato da conta" — reproduz o Bug A e confirma
 * que os três sinais de detectCardInvoiceWarning disparam para este arquivo.
 */
describe('CSV real do dono (Nubank fatura) via caminho de EXTRATO', () => {
  it('parseia como extrato e os sinais do warning disparam', async () => {
    const csvPath = path.join(__dirname, '__fixtures-nubank-real.csv');
    const buffer = fs.readFileSync(csvPath);

    const parsed = await parseBankStatementBuffers([buffer], 'acc-real-test', 'AUTO', 'Nubank_2026-08-01.csv');

    expect(parsed.transactions.length).toBe(12);

    const firstLine = buffer.toString('utf-8').replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0]?.trim().toLowerCase();
    const headerLooksLikeCardInvoice = firstLine === 'date,title,amount';
    const hasInstallmentMarkers = parsed.transactions.some((t) => (t.installmentTotal ?? 0) > 1);
    const total = parsed.transactions.length;
    const creditRatio = parsed.transactions.filter((t) => t.amountCents < 0).length / total;

    expect(headerLooksLikeCardInvoice).toBe(true);
    expect(hasInstallmentMarkers).toBe(true);
    // sinal >90% também confere: extrato inverte o sinal, então todo mundo vira crédito
    expect(creditRatio).toBeGreaterThan(0.9);

    // Parcelas específicas do CSV real (1/2, 2/4, 5/10) precisam ter sido detectadas
    const installments = parsed.transactions
      .map((t) => `${t.installmentCurrent}/${t.installmentTotal}`)
      .filter((s) => s !== 'undefined/undefined');
    expect(installments).toEqual(
      expect.arrayContaining(['1/2', '2/4', '5/10']),
    );
  });

  it('caminho CORRETO — como Fatura do cartão: 12 despesas com sinal certo e parcelas detectadas', async () => {
    const csvPath = path.join(__dirname, '__fixtures-nubank-real.csv');
    const buffer = fs.readFileSync(csvPath);

    const parsed = await parseStatementBuffers([buffer], 'card-real-test', 'AUTO', 'Nubank_2026-08-01.csv');

    expect(parsed.transactions.length).toBe(12);
    // Como fatura, toda transação é despesa (sinal positivo em amountCents) —
    // é o extrato que inverte (Bug A); a fatura em si nunca precisou de inversão.
    expect(parsed.transactions.every((t) => t.amountCents > 0)).toBe(true);

    const total = parsed.transactions
      .reduce((acc, t) => acc + t.amountCents, 0);
    expect(total).toBe(518277); // R$ 5.182,77 — bate com o valor citado pelo dono

    const installments = parsed.transactions
      .map((t) => `${t.installmentCurrent}/${t.installmentTotal}`)
      .filter((s) => s !== 'undefined/undefined');
    expect(installments).toEqual(
      expect.arrayContaining(['1/2', '2/4', '5/10']),
    );
  });
});
