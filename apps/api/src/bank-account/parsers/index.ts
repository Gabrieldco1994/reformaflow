import { parseBankOfx } from './ofx';
import { parseBankCsv } from './csv';
import { parseBankPdfStatement, PdfPasswordRequiredError, PdfWrongPasswordError } from './pdf';
import type { ParseResult } from '../../credit-card/parsers/types';

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

export { PdfPasswordRequiredError, PdfWrongPasswordError };
export type { ParseResult } from '../../credit-card/parsers/types';
