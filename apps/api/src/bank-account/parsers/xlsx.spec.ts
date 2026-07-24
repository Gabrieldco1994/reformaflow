import * as XLSX from 'xlsx';
import { parseBankStatementBuffer } from '.';

describe('Bank XLS parser', () => {
  it('normaliza crédito positivo e débito negativo do extrato Itaú', async () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ['Atualização:', '24/07/2026 às 19:05:02'],
      [],
      ['data', 'lançamento', 'ag./origem', 'valor (R$)', 'saldos (R$)'],
      ['15/07/2026', 'REMUNERACAO/SALARIO', '', 4130.31],
      ['15/07/2026', 'FATURA PAGA PERSONNALITE', '', -4998.25],
      ['15/07/2026', 'SALDO TOTAL DISPONÍVEL DIA', '', '', 57354.04],
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Lançamentos');
    const buffer = Buffer.from(XLSX.write(workbook, { bookType: 'xls', type: 'array' }));

    const result = await parseBankStatementBuffer(buffer, 'account-1', 'AUTO', 'extrato-itau.xls');

    expect(result.transactions.map(({ merchant, amountCents }) => ({ merchant, amountCents }))).toEqual([
      { merchant: 'REMUNERACAO/SALARIO', amountCents: -413031 },
      { merchant: 'FATURA PAGA PERSONNALITE', amountCents: 499825 },
    ]);
    expect(result.totalAmountCents).toBe(499825);
  });
});
