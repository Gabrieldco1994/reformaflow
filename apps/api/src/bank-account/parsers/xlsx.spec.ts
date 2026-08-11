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

  it('não lê a data no fim da descrição como parcelamento', async () => {
    // O Itaú termina a descrição com o dia/mês da compra. "01/07" casava com o
    // padrão de parcela e virava "parcela 1 de 7": inventava um parcelamento,
    // reescrevia a descrição (perdendo o sufixo) e, com isso, mudava o
    // externalId — quebrando o dedup entre dois exports do mesmo período.
    // Intermitente de propósito no fixture: "08/07" (dia > mês) nunca casou.
    const sheet = XLSX.utils.aoa_to_sheet([
      ['data', 'lançamento', 'ag./origem', 'valor (R$)', 'saldos (R$)'],
      ['01/07/2026', 'PAY NA JA 01/07', '', -16.5],
      ['06/07/2026', 'PAY IFD M 04/07', '', -177.6],
      ['08/07/2026', 'PAY VILA  08/07', '', -54.0],
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Lançamentos');
    const buffer = Buffer.from(XLSX.write(workbook, { bookType: 'xls', type: 'array' }));

    const result = await parseBankStatementBuffer(buffer, 'account-1', 'AUTO', 'extrato.xls');

    expect(result.transactions.map((t) => t.merchant)).toEqual([
      'PAY NA JA 01/07',
      'PAY IFD M 04/07',
      'PAY VILA  08/07',
    ]);
    for (const t of result.transactions) {
      expect(t.installmentCurrent).toBeUndefined();
      expect(t.installmentTotal).toBeUndefined();
    }
  });
});
