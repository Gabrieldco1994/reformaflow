import {
  isImageBuffer,
  detectImageMime,
  rowsToStatementText,
  imageToStatementRows,
  ImageOcrError,
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
  // ponytail: fixa o "hoje" do servidor pra testar deterministicamente o
  // override de ano (não pode depender do ano real em que o teste roda).
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date(Date.UTC(2027, 2, 19))); // 19/03/2027
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('normalizes ISO dates to DD/MM/<ano vigente>, ignorando o ano que a IA reportou', () => {
    const rows: OcrStatementRow[] = [
      { date: '2026-01-08', description: 'Samsung No Itau 18/21', amount: 114.25 },
    ];
    expect(rowsToStatementText(rows)).toBe('08/01/2027 Samsung No Itau 18/21 114,25');
  });

  it('mantém dia/mês de datas DD/MM/AAAA mas sobrescreve o ano pelo vigente', () => {
    const rows: OcrStatementRow[] = [
      { date: '05/01/2026', description: 'PIX TRANSF FORMULA 05/01', amount: -392.25 },
      { date: '11/06/2020', description: 'Mercadolivre', amount: 1136.78 },
    ];
    const text = rowsToStatementText(rows);
    expect(text.split('\n')).toEqual([
      '05/01/2027 PIX TRANSF FORMULA 05/01 -392,25',
      '11/06/2027 Mercadolivre 1.136,78',
    ]);
  });

  it('usa a data de hoje inteira quando a linha não tem NENHUMA data reconhecível (não descarta a transação)', () => {
    const rows: OcrStatementRow[] = [
      { date: 'sem data visível', description: 'Pix enviado para Maria', amount: -143.1 },
    ];
    expect(rowsToStatementText(rows)).toBe('19/03/2027 Pix enviado para Maria -143,10');
  });

  it('usa a data de hoje quando a IA retorna o placeholder "0000-00-00" (print de notificação sem data, só "há 1h")', () => {
    const rows: OcrStatementRow[] = [
      { date: '0000-00-00', description: 'Pix enviado para MARIA', amount: -143.1 },
    ];
    expect(rowsToStatementText(rows)).toBe('19/03/2027 Pix enviado para MARIA -143,10');
  });
});

describe('end-to-end: OCR rows -> text -> card invoice parser', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date(Date.UTC(2026, 6, 1)));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

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

describe('imageToStatementRows: falhas de rede/timeout não devem virar 500', () => {
  const JPEG_BUF = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const originalFetch = global.fetch;
  const originalKey = process.env['GEMINI_API_KEY'];

  beforeEach(() => {
    process.env['GEMINI_API_KEY'] = 'test-key';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env['GEMINI_API_KEY'] = originalKey;
  });

  it('converte timeout do fetch (AbortSignal.timeout) em ImageOcrError amigável', async () => {
    global.fetch = (async () => {
      const err = new DOMException('The operation was aborted', 'TimeoutError');
      throw err;
    }) as any;

    await expect(imageToStatementRows(JPEG_BUF, 'image/jpeg', 'statement')).rejects.toThrow(ImageOcrError);
    await expect(imageToStatementRows(JPEG_BUF, 'image/jpeg', 'statement')).rejects.toThrow(/demorou demais/i);
  });

  it('converte falha genérica de rede (fetch failed) em ImageOcrError amigável', async () => {
    global.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as any;

    await expect(imageToStatementRows(JPEG_BUF, 'image/jpeg', 'statement')).rejects.toThrow(ImageOcrError);
    await expect(imageToStatementRows(JPEG_BUF, 'image/jpeg', 'statement')).rejects.toThrow(/não consegui me conectar/i);
  });

  it('converte JSON inválido no corpo da resposta em ImageOcrError', async () => {
    global.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    })) as any;

    await expect(imageToStatementRows(JPEG_BUF, 'image/jpeg', 'statement')).rejects.toThrow(ImageOcrError);
  });

  it('instrui a IA a extrair transação única de print de notificação/push (não só tabela de extrato)', async () => {
    let sentPrompt = '';
    global.fetch = (async (_url: string, init: any) => {
      sentPrompt = JSON.parse(init.body).contents[0].parts[0].text;
      return {
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text: '{"rows":[]}' }] } }] }),
      };
    }) as any;

    await imageToStatementRows(JPEG_BUF, 'image/jpeg', 'statement');

    expect(sentPrompt).toMatch(/notifica/i);
    expect(sentPrompt).toMatch(/APENAS UMA/);
    expect(sentPrompt).toMatch(/não retorne uma lista vazia/i);
  });
});

describe('end-to-end: OCR rows -> text -> bank statement parser', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date(Date.UTC(2026, 6, 1)));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

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
