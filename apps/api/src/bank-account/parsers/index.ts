import { parseBankOfx } from './ofx';
import { parseBankCsv } from './csv';
import { parseBankPdfStatement, PdfPasswordRequiredError, PdfWrongPasswordError } from './pdf';
import { detectImageMime, parseImageBankStatement } from '../../credit-card/parsers/image-ocr';
import { mergeParseResults, type ParseResult } from '../../credit-card/parsers/types';

export type BankSourceHint = 'OFX' | 'CSV_GENERIC' | 'PDF' | 'AUTO';

export function isPdfBuffer(buf: Buffer): boolean {
  return buf.length >= 5 && buf.slice(0, 5).toString('ascii') === '%PDF-';
}

export async function parseBankStatementBuffer(
  buffer: Buffer,
  accountId: string,
  hint: BankSourceHint = 'AUTO',
  fileName?: string,
  password?: string,
): Promise<ParseResult> {
  const imageMime = detectImageMime(buffer);
  if (imageMime) {
    return parseImageBankStatement(buffer, imageMime, accountId);
  }
  if (hint === 'PDF' || isPdfBuffer(buffer)) {
    return parseBankPdfStatement(buffer, accountId, password, fileName);
  }
  const content = buffer.toString('utf-8');
  const head = content.slice(0, 600).toUpperCase();
  if (hint === 'OFX' || head.includes('<OFX') || head.includes('OFXHEADER') || (fileName ?? '').toLowerCase().endsWith('.ofx')) {
    return parseBankOfx(content, accountId);
  }
  return parseBankCsv(content, accountId);
}

/**
 * Versão em lote: parseia N buffers (ex.: múltiplas imagens de extrato) e mescla
 * num único ParseResult, deduplicando por externalId.
 */
export async function parseBankStatementBuffers(
  buffers: Buffer[],
  accountId: string,
  hint: BankSourceHint = 'AUTO',
  fileName?: string,
  password?: string,
): Promise<ParseResult> {
  const results: ParseResult[] = [];
  for (const b of buffers) {
    results.push(await parseBankStatementBuffer(b, accountId, hint, fileName, password));
  }
  return mergeParseResults(results);
}

export { PdfPasswordRequiredError, PdfWrongPasswordError };
export { ImageOcrError } from '../../credit-card/parsers/image-ocr';
export type { ParseResult } from '../../credit-card/parsers/types';
