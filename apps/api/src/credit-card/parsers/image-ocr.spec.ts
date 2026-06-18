import {
  isImageBuffer,
  detectImageMime,
  rowsToStatementText,
  type OcrStatementRow,
} from './image-ocr';
import { extractTransactionsFromText } from './pdf';
import { extractBankTransactionsFromText } from '../../bank-account/parsers/pdf';

// Magic-byte signatures
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBP', 'ascii'),
]);
const PDF = Buffer.from('%PDF-1.4\n', 'ascii');
const TEXT = Buffer.from('02/01/2026 PAY 54624 -32,99', 'utf-8');

describe('detectImageMime / isImageBuffer', () => {
  it('detects PNG', () => {
    expect(detectImageMime(PNG)).toBe('image/png');
    expect(isImageBuffer(PNG)).toBe(true);
  });
  it('detects JPEG', () => {
    expect(detectImageMime(JPEG)).toBe('image/jpeg');
    expect(isImageBuffer(JPEG)).toBe(true);
  });
  it('detects WEBP', () => {
    expect(detectImageMime(WEBP)).toBe('image/webp');
    expect(isImageBuffer(WEBP)).toBe(true);
  });
  it('returns null/false for PDF and text', () => {
    expect(detectImageMime(PDF)).toBeNull();
    expect(isImageBuffer(PDF)).toBe(false);
    expect(detectImageMime(TEXT)).toBeNull();
    expect(isImageBuffer(TEXT)).toBe(false);
  });
});

describe('rowsToStatementText', () => {
  it('normalizes ISO dates to DD/MM/YYYY and formats BRL', () => {
    const rows: OcrStatementRow[] = [
      { date: '2026-01-08', description: 'Samsung No Itau 18/21', amount: 114.25 },
    ];
    expect(rowsToStatementText(rows)).toBe('08/01/2026 Samsung No Itau 18/21 114,25');
  });

  it('keeps DD/MM/YYYY dates and renders negative + thousands', () => {
    const rows: OcrStatementRow[] = [
      { date: '05/01/2026', description: 'PIX TRANSF FORMULA 05/01', amount: -392.25 },
      { date: '11/06/2026', description: 'Mercadolivre', amount: 1136.78 },
    ];
    const text = rowsToStatementText(rows);
    expect(text.split('\n')).toEqual([
      '05/01/2026 PIX TRANSF FORMULA 05/01 -392,25',
      '11/06/2026 Mercadolivre 1.136,78',
    ]);
  });
});

describe('end-to-end: OCR rows -> text -> card invoice parser', () => {
  it('extracts installments and positive (expense) amounts', () => {
    const rows: OcrStatementRow[] = [
      { date: '2026-01-08', description: 'Samsung No Itau 18/21', amount: 114.25 },
      { date: '2026-04-15', description: 'Sabor E Alegria 03/03', amount: 541.68 },
      { date: '2026-06-11', description: 'Uber Uber *trip Help.u', amount: 77.98 },
    ];
    const text = rowsToStatementText(rows);
    const { current } = extractTransactionsFromText(text, 2026);

    const samsung = current.find((t) => /samsung/i.test(t.merchant));
    expect(samsung).toBeDefined();
    expect(samsung!.amountCents).toBe(11425);
    expect(samsung!.installmentCurrent).toBe(18);
    expect(samsung!.installmentTotal).toBe(21);

    const sabor = current.find((t) => /sabor/i.test(t.merchant));
    expect(sabor!.installmentCurrent).toBe(3);
    expect(sabor!.installmentTotal).toBe(3);

    const uber = current.find((t) => /uber/i.test(t.merchant));
    expect(uber!.amountCents).toBe(7798);
    expect(uber!.installmentCurrent).toBeUndefined();
  });
});

describe('end-to-end: OCR rows -> text -> bank statement parser', () => {
  it('debits become positive expenses, income becomes credit', () => {
    const rows: OcrStatementRow[] = [
      { date: '05/01/2026', description: 'PIX QRS PIX Marketp 03/01', amount: -118.52 },
      { date: '05/01/2026', description: 'PAY MERCA 03/01', amount: -67.0 },
      { date: '05/01/2026', description: 'REND PAGO APLIC AUT MAIS', amount: 0.04 },
    ];
    const text = rowsToStatementText(rows);
    const txs = extractBankTransactionsFromText(text, 2026);

    const pix = txs.find((t) => /pix qrs/i.test(t.merchant));
    expect(pix!.amountCents).toBe(11852); // debit -> positive expense

    const pay = txs.find((t) => /pay merca/i.test(t.merchant));
    expect(pay!.amountCents).toBe(6700);

    const rend = txs.find((t) => /rend pago/i.test(t.merchant));
    expect(rend!.amountCents).toBe(-4); // income -> negative credit
  });
});
