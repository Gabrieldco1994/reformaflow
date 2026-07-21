import { parseOfx } from './ofx';
import { parseCsv } from './csv';
import { parsePdfStatement, PdfPasswordRequiredError, PdfWrongPasswordError } from './pdf';
import { detectImageMime, parseImageStatement } from './image-ocr';
import { mergeParseResults, type ParseResult } from './types';
import { isPdfBuffer, parseBuffersAndMerge } from '../../common/parsers/buffer-parser.util';
import { parseXlsx } from '../../bank-account/parsers/xlsx';

export type SourceHint = 'OFX' | 'CSV_NUBANK' | 'CSV_ITAU' | 'CSV_GENERIC' | 'PDF' | 'XLSX' | 'AUTO';

export function parseStatement(
  content: string,
  cardId: string,
  hint: SourceHint = 'AUTO',
  fileName?: string,
): ParseResult {
  const source = resolveSource(content, fileName, hint);
  if (source === 'OFX') return parseOfx(content, cardId);
  return parseCsv(content, { cardId, source });
}

/**
 * Variante que aceita Buffer e detecta PDF automaticamente.
 * Use esta quando o conteúdo pode ser binário (upload de fatura).
 */
export async function parseStatementBuffer(
  buffer: Buffer,
  cardId: string,
  hint: SourceHint = 'AUTO',
  fileName?: string,
  password?: string,
): Promise<ParseResult> {
  const imageMime = detectImageMime(buffer);
  if (imageMime) {
    return parseImageStatement(buffer, imageMime, cardId);
  }
  if (hint === 'PDF' || isPdfBuffer(buffer)) {
    return parsePdfStatement(buffer, cardId, password, fileName);
  }
  const isXlsx = hint === 'XLSX' || (fileName ?? '').toLowerCase().match(/\.(xlsx|xls)$/);
  if (isXlsx) {
    return parseXlsx(buffer, cardId);
  }
  return parseStatement(buffer.toString('utf-8'), cardId, hint, fileName);
}

/**
 * Versão em lote: parseia N buffers (ex.: múltiplas imagens de fatura) e mescla
 * num único ParseResult, deduplicando por externalId. Retrocompatível: 1 buffer
 * equivale a `parseStatementBuffer`.
 */
export async function parseStatementBuffers(
  buffers: Buffer[],
  cardId: string,
  hint: SourceHint = 'AUTO',
  fileName?: string,
  password?: string,
): Promise<ParseResult> {
  return parseBuffersAndMerge(
    buffers,
    (buffer) => parseStatementBuffer(buffer, cardId, hint, fileName, password),
    mergeParseResults,
  );
}

function resolveSource(
  content: string,
  fileName: string | undefined,
  hint: SourceHint,
): 'OFX' | 'CSV_NUBANK' | 'CSV_ITAU' | 'CSV_GENERIC' {
  // XLSX é binário, nunca via parseStatement (que recebe string)
  // Se hint for XLSX, é erro — não deve chegar aqui
  if (hint === 'XLSX' || hint === 'PDF') return 'CSV_GENERIC'; // fallback
  if (hint !== 'AUTO') return hint as any;
  const head = content.slice(0, 600).toUpperCase();
  if (head.includes('<OFX') || head.includes('OFXHEADER')) return 'OFX';
  const lower = (fileName ?? '').toLowerCase();
  if (lower.endsWith('.ofx')) return 'OFX';
  if (lower.includes('nubank')) return 'CSV_NUBANK';
  if (lower.includes('itau') || lower.includes('itaú')) return 'CSV_ITAU';
  // CSV genérico — usamos heurística: separador
  if (content.includes(';')) return 'CSV_ITAU';
  return 'CSV_NUBANK';
}

export * from './types';
export { parseOfx } from './ofx';
export { parseCsv } from './csv';
export { parsePdfStatement, PdfPasswordRequiredError, PdfWrongPasswordError } from './pdf';
export { ImageOcrError } from './image-ocr';
