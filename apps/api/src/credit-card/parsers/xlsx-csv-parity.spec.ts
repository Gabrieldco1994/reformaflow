import * as XLSX from 'xlsx';
import { parseCsv } from './csv';
import { parseXlsx } from './xlsx';
import { ParseResult, NormalizedTx } from './types';

describe('Paridade CSV × XLSX', () => {
  const cardId = 'test-card-123';

  function createTestXlsxBuffer(data: unknown[][]): Buffer {
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    return Buffer.from(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }));
  }

  function createTestCsvContent(rows: string[][]): string {
    return rows.map((row) => row.map((cell) => {
      // Escapar células com vírgula ou aspas
      if (cell.includes(',') || cell.includes('"')) {
        return `"${cell.replace(/"/g, '""')}"`;
      }
      return cell;
    }).join(',')).join('\n');
  }

  it('importa mesmos dados de CSV e XLSX com mesmo resultado', () => {
    // Dados iguais em ambos formatos
    const data = [
      ['Data', 'Descrição', 'Valor'],
      ['2026-05-15', 'Supermercado', '150.00'],
      ['2026-05-16', 'Farmácia', '45.50'],
      ['2026-05-17', 'Restaurante', '89.90'],
    ];

    const csvContent = createTestCsvContent(data);
    const xlsxBuffer = createTestXlsxBuffer(data);

    const csvResult = parseCsv(csvContent, { cardId, source: 'CSV_GENERIC' });
    const xlsxResult = parseXlsx(xlsxBuffer, cardId);

    // Mesmo número de transações
    expect(xlsxResult.transactions).toHaveLength(csvResult.transactions.length);

    // Mesmos valores
    for (let i = 0; i < csvResult.transactions.length; i++) {
      const csv = csvResult.transactions[i];
      const xlsx = xlsxResult.transactions[i];
      expect(xlsx.date.getTime()).toBe(csv.date.getTime());
      expect(xlsx.merchant).toBe(csv.merchant);
      expect(xlsx.amountCents).toBe(csv.amountCents);
    }

    // Mesmo total
    expect(xlsxResult.totalAmountCents).toBe(csvResult.totalAmountCents);
  });

  it('detecta installments em ambos formatos', () => {
    const data = [
      ['Data', 'Descrição', 'Valor'],
      ['2026-05-15', 'LOJA PARC. 02/10', '500.00'],
    ];

    const csvContent = createTestCsvContent(data);
    const xlsxBuffer = createTestXlsxBuffer(data);

    const csvResult = parseCsv(csvContent, { cardId, source: 'CSV_GENERIC' });
    const xlsxResult = parseXlsx(xlsxBuffer, cardId);

    expect(csvResult.transactions[0].installmentCurrent).toBe(2);
    expect(csvResult.transactions[0].installmentTotal).toBe(10);
    expect(xlsxResult.transactions[0].installmentCurrent).toBe(2);
    expect(xlsxResult.transactions[0].installmentTotal).toBe(10);
  });

  it('normaliza valores BR de forma consistente em ambos formatos', () => {
    const data = [
      ['Data', 'Descrição', 'Valor'],
      ['2026-05-15', 'Compra BR', '1.234,56'],
      ['2026-05-16', 'Compra BR 2', '2.000,00'],
    ];

    const csvContent = createTestCsvContent(data);
    const xlsxBuffer = createTestXlsxBuffer(data);

    const csvResult = parseCsv(csvContent, { cardId, source: 'CSV_GENERIC' });
    const xlsxResult = parseXlsx(xlsxBuffer, cardId);

    // Ambos devem normalizar para o mesmo valor
    expect(xlsxResult.transactions[0].amountCents).toBe(csvResult.transactions[0].amountCents);
    expect(xlsxResult.transactions[1].amountCents).toBe(csvResult.transactions[1].amountCents);
  });

  it('processa transações na ordem do arquivo em ambos formatos', () => {
    const data = [
      ['Data', 'Descrição', 'Valor'],
      ['2026-05-17', 'Compra 3', '100.00'],
      ['2026-05-15', 'Compra 1', '100.00'],
      ['2026-05-16', 'Compra 2', '100.00'],
    ];

    const csvContent = createTestCsvContent(data);
    const xlsxBuffer = createTestXlsxBuffer(data);

    const csvResult = parseCsv(csvContent, { cardId, source: 'CSV_GENERIC' });
    const xlsxResult = parseXlsx(xlsxBuffer, cardId);

    // Ambos devem ter as transações na mesma ordem do arquivo (não ordenado)
    expect(xlsxResult.transactions.length).toBe(csvResult.transactions.length);
    for (let i = 0; i < csvResult.transactions.length; i++) {
      expect(xlsxResult.transactions[i].merchant).toBe(csvResult.transactions[i].merchant);
      expect(xlsxResult.transactions[i].date.getTime()).toBe(csvResult.transactions[i].date.getTime());
    }
  });

  it('ignora linhas vazias em ambos formatos', () => {
    const data = [
      ['Data', 'Descrição', 'Valor'],
      ['2026-05-15', 'Compra 1', '100.00'],
      ['', '', ''],
      ['2026-05-17', 'Compra 3', '100.00'],
    ];

    const csvContent = createTestCsvContent(data);
    const xlsxBuffer = createTestXlsxBuffer(data);

    const csvResult = parseCsv(csvContent, { cardId, source: 'CSV_GENERIC' });
    const xlsxResult = parseXlsx(xlsxBuffer, cardId);

    // Ambos ignoram a linha vazia
    expect(xlsxResult.transactions.length).toBe(csvResult.transactions.length);
    expect(xlsxResult.transactions).toHaveLength(2);
  });
});
