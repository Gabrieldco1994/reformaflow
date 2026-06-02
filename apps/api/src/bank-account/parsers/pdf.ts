/**
 * Parser PDF de extrato bancário (Itaú formato padrão).
 *
 * Formato típico Itaú:
 *   DD/MM/YYYY DESCRIÇÃO -VALOR    (débito)
 *   DD/MM/YYYY DESCRIÇÃO  VALOR    (crédito)
 *   DD/MM/YYYY SALDO DO DIA VALOR  (skip)
 *
 * Reaproveita extractPdfText + erros de senha do parser de cartão.
 */
import {
  extractPdfText,
  PdfPasswordRequiredError,
  PdfWrongPasswordError,
} from '../../credit-card/parsers/pdf';
import {
  type NormalizedTx,
  type ParseResult,
  assignOrdinals,
  inferPeriodLabel,
  makeExternalId,
  parseBrlMoney,
} from '../../credit-card/parsers/types';

export { PdfPasswordRequiredError, PdfWrongPasswordError };

// Linhas que NÃO são transações (saldos, cabeçalhos, etc)
const SKIP_PATTERNS = [
  /^SALDO\b/i,
  /^TOTAL\b/i,
  /^LIMITE\b/i,
  /^EXTRATO\b/i,
  /^PER[ÍI]ODO\b/i,
  /^DATA\s+LAN[ÇC]AMENTOS/i,
  /^EMITIDO\b/i,
  /^AG[ÊE]NCIA\b/i,
];

function isSkipLine(description: string): boolean {
  const upper = description.toUpperCase().trim();
  if (upper.length < 2) return true;
  if (/^SALDO\s+DO\s+DIA/i.test(upper)) return true;
  for (const re of SKIP_PATTERNS) if (re.test(upper)) return true;
  return false;
}

/**
 * Detecta linhas de transação de extrato bancário.
 *
 * Tolerante a formatos:
 *   25/05/2026 PAY PAN P 23/05 -137,00
 *   15/05/2026 REMUNERACAO/SALARIO 12.390,93
 *   01/04 PIX TRANSF JOAO 01/04 -500,00
 */
function extractTransactionsFromText(
  text: string,
  fallbackYear: number,
): NormalizedTx[] {
  const tx: NormalizedTx[] = [];
  const lines = text.split(/\r?\n/);

  // data DD/MM ou DD/MM/AAAA, descrição, valor com sinal opcional
  // Captura: 1=data, 2=descrição, 3=valor (com sinal)
  const lineRe = /^\s*(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+(.+?)\s+(-?\d{1,3}(?:[.\s]\d{3})*[,.]\d{2})\s*$/;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const m = lineRe.exec(line);
    if (!m) continue;

    const dateStr = m[1];
    const parts = dateStr.split('/').map((s) => parseInt(s, 10));
    const dd = parts[0];
    const mm = parts[1];
    let yyyy = parts[2];
    if (!(dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12)) continue;
    if (yyyy == null || !Number.isFinite(yyyy)) yyyy = fallbackYear;
    if (yyyy < 100) yyyy += 2000;
    if (yyyy < 2000 || yyyy > 2100) continue;

    const description = m[2].replace(/\s{2,}/g, ' ').trim();
    if (isSkipLine(description)) continue;
    if (!/[a-zA-Z]/.test(description)) continue;

    const amountCents = parseBrlMoney(m[3]);
    if (amountCents === 0) continue;

    // Extrato bancário: NEGATIVO = débito (despesa), POSITIVO = crédito (receita)
    // Normalizamos para amountCents > 0 = despesa, amountCents < 0 = crédito
    const normalizedAmount = -amountCents;

    const date = new Date(Date.UTC(yyyy, mm - 1, dd));
    if (isNaN(date.getTime())) continue;

    tx.push({
      externalId: '',
      date,
      merchant: description,
      amountCents: normalizedAmount,
    });
  }

  // NÃO deduplica linhas idênticas — N transações iguais no mesmo dia (ex.: 3
  // cobranças de R$8,00 da mesma loja) são legítimas. A unicidade vem do
  // ordinal por bucket (assignOrdinals) → externalIds distintos.
  return tx.sort((a, b) => a.date.getTime() - b.date.getTime());
}

function inferYearFromText(text: string): number | undefined {
  // "período de visualização: 01/01/2026 até 30/06/2026"
  // "emitido em: 24/05/2026"
  const patterns = [
    /per[ií]odo[^0-9]+\d{1,2}\/\d{1,2}\/(\d{4})/i,
    /emitido[^0-9]+\d{1,2}\/\d{1,2}\/(\d{4})/i,
    /\b(20\d{2})\b/,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) {
      const y = parseInt(m[1], 10);
      if (Number.isFinite(y) && y > 2000 && y < 2100) return y;
    }
  }
  return undefined;
}

export async function parseBankPdfStatement(
  buffer: Buffer,
  accountId: string,
  password?: string,
  _fileName?: string,
): Promise<ParseResult> {
  const text = await extractPdfText(buffer, password);
  const fallbackYear = inferYearFromText(text) ?? new Date().getUTCFullYear();
  const raw = extractTransactionsFromText(text, fallbackYear);

  // Atribui ordinal por bucket (date+merchant+amount) para diferenciar N linhas
  // idênticas no mesmo dia (legítimas) sem reintroduzir duplicação em re-imports.
  const withOrdinals = assignOrdinals(raw);
  const transactions: NormalizedTx[] = withOrdinals.map((t) => ({
    externalId: makeExternalId({
      cardId: accountId,
      date: t.date,
      merchant: t.merchant,
      amountCents: t.amountCents,
      ordinal: t._ordinal,
    }),
    date: t.date,
    merchant: t.merchant,
    amountCents: t.amountCents,
  }));

  // Total: só soma débitos (positivos após normalização)
  const totalAmountCents = transactions
    .filter((t) => t.amountCents > 0)
    .reduce((s, t) => s + t.amountCents, 0);

  return {
    source: 'PDF',
    periodLabel: inferPeriodLabel(transactions),
    transactions,
    totalAmountCents,
  };
}
