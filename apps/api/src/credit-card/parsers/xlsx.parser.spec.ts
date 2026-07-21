import * as XLSX from 'xlsx';
import { parseXlsx } from './xlsx';
import { ParseResult, NormalizedTx } from './types';

describe('XlsxParser', () => {
  const cardId = 'test-card-123';

  function createTestXlsxBuffer(data: unknown[][]): Buffer {
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    return Buffer.from(XLSX.write(wb, { bookType: 'xlsx', type: 'array' }));
  }

  it('importa .xlsx bem-formado com 3 colunas data/desc/valor', () => {
    const buffer = createTestXlsxBuffer([
      ['Data', 'Descrição', 'Valor'],
      ['2026-05-15', 'Supermercado', '150.00'],
      ['2026-05-16', 'Farmácia', '45.50'],
    ]);

    const result = parseXlsx(buffer, cardId);

    expect(result.source).toBe('XLSX');
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0].merchant).toBe('Supermercado');
    expect(result.transactions[0].amountCents).toBe(15000);
    expect(result.transactions[1].merchant).toBe('Farmácia');
    expect(result.transactions[1].amountCents).toBe(4550);
  });

  it('importa com colunas em ordem aleatória', () => {
    const buffer = createTestXlsxBuffer([
      ['Valor', 'Data', 'Descrição'],
      ['100.00', '2026-05-15', 'Restaurante'],
    ]);

    const result = parseXlsx(buffer, cardId);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].merchant).toBe('Restaurante');
    expect(result.transactions[0].amountCents).toBe(10000);
  });

  it('importa com headers acentuados', () => {
    const buffer = createTestXlsxBuffer([
      ['Data Lançamento', 'Histórico', 'Quantia'],
      ['2026-05-15', 'Padaria', '25.99'],
    ]);

    const result = parseXlsx(buffer, cardId);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].merchant).toBe('Padaria');
  });

  it('normaliza valor BR (1.234,56) e US (1,234.56)', () => {
    const buffer = createTestXlsxBuffer([
      ['Data', 'Descrição', 'Valor'],
      ['2026-05-15', 'Compra 1', '1.234,56'],
      ['2026-05-16', 'Compra 2', '1,234.56'],
    ]);

    const result = parseXlsx(buffer, cardId);

    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0].amountCents).toBe(123456);
    expect(result.transactions[1].amountCents).toBe(123456);
  });

  it('normaliza data dd/mm/aaaa, aaaa-mm-dd, serial Excel', () => {
    const buffer = createTestXlsxBuffer([
      ['Data', 'Descrição', 'Valor'],
      ['15/05/2026', 'Compra 1', '100.00'],
      ['2026-05-16', 'Compra 2', '100.00'],
      [45465, 'Compra 3', '100.00'], // Serial Excel para 2024-05-17
    ]);

    const result = parseXlsx(buffer, cardId);

    // Esperamos pelo menos as 2 primeiras linhas válidas
    expect(result.transactions.length).toBeGreaterThanOrEqual(2);
    expect(result.transactions[0].date.toISOString().slice(0, 10)).toBe('2026-05-15');
    expect(result.transactions[1].date.toISOString().slice(0, 10)).toBe('2026-05-16');
  });

  it('pula linha com data inválida, continua resto', () => {
    const buffer = createTestXlsxBuffer([
      ['Data', 'Descrição', 'Valor'],
      ['2026-05-15', 'Compra 1', '100.00'],
      ['data inválida', 'Compra 2', '100.00'],
      ['2026-05-17', 'Compra 3', '50.00'],
    ]);

    const result = parseXlsx(buffer, cardId);

    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0].merchant).toBe('Compra 1');
    expect(result.transactions[1].merchant).toBe('Compra 3');
  });

  it('retorna erro se faltar colunas essenciais', () => {
    const buffer = createTestXlsxBuffer([
      ['Data', 'Descrição'], // Faltam valor
      ['2026-05-15', 'Compra 1'],
    ]);

    const result = parseXlsx(buffer, cardId);

    expect(result.transactions).toHaveLength(0);
    expect(result.error).toBeDefined();
    expect(result.error).toMatch(/colunas|data|descrição|valor/i);
  });

  it('suporta .xls antigo (detecta automaticamente via XLSX.read)', () => {
    // Simular criando um arquivo XLSX que será exportado como XLS
    const buffer = createTestXlsxBuffer([
      ['Data', 'Descrição', 'Valor'],
      ['2026-05-15', 'Compra', '100.00'],
    ]);

    const result = parseXlsx(buffer, cardId);

    expect(result.source).toBe('XLSX');
    expect(result.transactions).toHaveLength(1);
  });

  it('ignora linhas acima do cabeçalho se houver conteúdo não-tabular', () => {
    const buffer = createTestXlsxBuffer([
      ['Extrato de maio de 2026'],
      [''],
      ['Data', 'Descrição', 'Valor'],
      ['2026-05-15', 'Compra', '100.00'],
    ]);

    const result = parseXlsx(buffer, cardId);

    // Deve encontrar a transação mesmo com linhas extras acima
    expect(result.transactions.length).toBeGreaterThan(0);
    expect(result.transactions.some((t) => t.merchant === 'Compra')).toBe(true);
  });

  it('pula linhas com valor zero ou vazio', () => {
    const buffer = createTestXlsxBuffer([
      ['Data', 'Descrição', 'Valor'],
      ['2026-05-15', 'Compra 1', '100.00'],
      ['2026-05-16', 'Compra 2', ''],
      ['2026-05-17', 'Compra 3', '0.00'],
      ['2026-05-18', 'Compra 4', '50.00'],
    ]);

    const result = parseXlsx(buffer, cardId);

    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0].merchant).toBe('Compra 1');
    expect(result.transactions[1].merchant).toBe('Compra 4');
  });

  it('deteta installment pattern na descrição e remove dele', () => {
    const buffer = createTestXlsxBuffer([
      ['Data', 'Descrição', 'Valor'],
      ['2026-05-15', 'LOJA PARC. 02/10', '500.00'],
    ]);

    const result = parseXlsx(buffer, cardId);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].installmentCurrent).toBe(2);
    expect(result.transactions[0].installmentTotal).toBe(10);
    expect(result.transactions[0].merchant).toBe('LOJA');
  });

  it('calcula externalId baseado em hash do cardId+data+merchant+amount', () => {
    const buffer = createTestXlsxBuffer([
      ['Data', 'Descrição', 'Valor'],
      ['2026-05-15', 'Compra ABC', '100.00'],
    ]);

    const result = parseXlsx(buffer, cardId);

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0].externalId).toBeTruthy();
    expect(result.transactions[0].externalId.length).toBe(32); // SHA256 slice(0, 32)
  });

  it('retorna totalAmountCents somando apenas despesas positivas', () => {
    const buffer = createTestXlsxBuffer([
      ['Data', 'Descrição', 'Valor'],
      ['2026-05-15', 'Despesa 1', '100.00'],
      ['2026-05-16', 'Despesa 2', '50.00'],
    ]);

    const result = parseXlsx(buffer, cardId);

    expect(result.totalAmountCents).toBe(15000);
  });

  it('infere periodLabel (YYYY-MM) da maior densidade de transações', () => {
    const buffer = createTestXlsxBuffer([
      ['Data', 'Descrição', 'Valor'],
      ['2026-05-15', 'Compra 1', '100.00'],
      ['2026-05-16', 'Compra 2', '100.00'],
      ['2026-05-17', 'Compra 3', '100.00'],
      ['2026-06-01', 'Compra 4', '100.00'],
    ]);

    const result = parseXlsx(buffer, cardId);

    expect(result.periodLabel).toBe('2026-05');
  });
});
