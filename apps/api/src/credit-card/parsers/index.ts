import { parseOfx } from './ofx';
import { parseCsv } from './csv';
import { parsePdfStatement, PdfPasswordRequiredError, PdfWrongPasswordError } from './pdf';
import type { ParseResult } from './types';

export type SourceHint = 'OFX' | 'CSV_NUBANK' | 'CSV_ITAU' | 'CSV_GENERIC' | 'PDF' | 'AUTO';

export function isPdfBuffer(buf: Buffer): boolean {
  return buf.length >= 5 && buf.slice(0, 5).toString('ascii') === '%PDF-';
}

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
  if (hint === 'PDF' || isPdfBuffer(buffer)) {
    return parsePdfStatement(buffer, cardId, password, fileName);
  }
  return parseStatement(buffer.toString('utf-8'), cardId, hint, fileName);
}

function resolveSource(
  content: string,
  fileName: string | undefined,
  hint: SourceHint,
): 'OFX' | 'CSV_NUBANK' | 'CSV_ITAU' | 'CSV_GENERIC' {
  if (hint !== 'AUTO' && hint !== 'PDF') return hint;
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
