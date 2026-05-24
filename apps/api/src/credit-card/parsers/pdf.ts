/**
 * Parser PDF de fatura de cartão.
 *
 * Estratégia: extrai texto via pdf-parse (suporta senha) e aplica regex
 * tolerante para detectar linhas com data + descrição + valor.
 *
 * Suporta:
 *  - Faturas Itaú/Mastercard (DD/MM ... R$ 1.234,56)
 *  - Faturas Nubank exportadas em PDF (formato similar)
 *  - Padrões genéricos brasileiros com data DD/MM ou DD/MM/AAAA
 */
import { PDFParse } from 'pdf-parse';
import {
  type NormalizedTx,
  type ParseResult,
  detectInstallment,
  inferPeriodLabel,
  makeExternalId,
  parseBrlMoney,
} from './types';

export class PdfPasswordRequiredError extends Error {
  constructor() {
    super('PDF protegido por senha — informe a senha');
    this.name = 'PdfPasswordRequiredError';
  }
}

export class PdfWrongPasswordError extends Error {
  constructor() {
    super('Senha do PDF incorreta');
    this.name = 'PdfWrongPasswordError';
  }
}

const MONTHS_PT: Record<string, number> = {
  jan: 0, fev: 1, mar: 2, abr: 3, mai: 4, jun: 5,
  jul: 6, ago: 7, set: 8, out: 9, nov: 10, dez: 11,
};

function parseDateBR(s: string, fallbackYear?: number): Date | null {
  // Aceita DD/MM, DD/MM/YY, DD/MM/AAAA, DD MMM (jan, fev, etc.)
  let m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(s.trim());
  if (m) {
    const day = parseInt(m[1], 10);
    const month = parseInt(m[2], 10) - 1;
    let year = m[3] ? parseInt(m[3], 10) : (fallbackYear ?? new Date().getUTCFullYear());
    if (year < 100) year += 2000;
    return new Date(Date.UTC(year, month, day));
  }
  m = /^(\d{1,2})\s+(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)$/i.exec(s.trim());
  if (m) {
    const day = parseInt(m[1], 10);
    const month = MONTHS_PT[m[2].toLowerCase()];
    const year = fallbackYear ?? new Date().getUTCFullYear();
    return new Date(Date.UTC(year, month, day));
  }
  return null;
}

function inferDueDateFromText(text: string): { month: number; year: number } | undefined {
  // Procura "Vencimento DD/MM/AAAA" ou variantes; retorna mês (1-12) e ano da fatura
  const patterns = [
    /vencimento[:\s]*(\d{1,2})\/(\d{1,2})\/(\d{4})/i,
    /vencimento\s+em[:\s]*(\d{1,2})\/(\d{1,2})\/(\d{4})/i,
    /vence\s+em[:\s]*(\d{1,2})\/(\d{1,2})\/(\d{4})/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) {
      const month = parseInt(m[2], 10);
      const year = parseInt(m[3], 10);
      if (month >= 1 && month <= 12 && year > 2000 && year < 2100) {
        return { month, year };
      }
    }
  }
  return undefined;
}

function inferYearFromText(text: string): number | undefined {
  // Tenta extrair ano de contextos típicos de fatura
  const patterns = [
    /(?:vencimento|fechamento)[:\s]+\d{1,2}\/\d{1,2}\/(\d{4})/i,
    /(?:fatura\s+de|per[ií]odo[:\s]+\d{1,2}\/\d{1,2}\/(\d{4}))/i,
    /m[eê]s\s+de\s+\w+\/(\d{4})/i,
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

/**
 * Dado o mês de vencimento da fatura e o mês/dia de uma transação (sem ano),
 * retorna o ano correto considerando que faturas referenciam transações dos
 * últimos ~12 meses. Se o mês da transação > mês de vencimento, ela é do ano anterior.
 */
function resolveYearForTransaction(
  txMonth: number,
  due: { month: number; year: number } | undefined,
  fallbackYear: number,
): number {
  if (!due) return fallbackYear;
  if (txMonth > due.month) return due.year - 1;
  return due.year;
}

/**
 * Detecta parcela mesmo quando colada ao merchant (ex.: "WWW-CASASBAHIA-COM06/10").
 * Retorna { current, total, cleanMerchant }.
 */
function detectInstallmentLoose(description: string): { current?: number; total?: number; cleanMerchant: string } {
  const std = detectInstallment(description);
  if (std.current && std.total) return std;
  // Tenta padrão colado: letras seguidas de NN/NN no final ou meio
  const re = /([A-Za-z*])(\d{1,2})\s*\/\s*(\d{1,2})(?!\d)/;
  const m = re.exec(description);
  if (m) {
    const current = parseInt(m[2], 10);
    const total = parseInt(m[3], 10);
    if (current >= 1 && total > 1 && current <= total && total <= 60) {
      const cleaned = description
        .replace(re, m[1])
        .replace(/\s+/g, ' ')
        .trim();
      return { current, total, cleanMerchant: cleaned || description.trim() };
    }
  }
  return std;
}

/**
 * Extrai texto do PDF, opcionalmente com senha.
 */
export async function extractPdfText(buffer: Buffer, password?: string): Promise<string> {
  try {
    const parser = new PDFParse({ data: buffer, password: password || undefined });
    const result = await parser.getText();
    return result.text ?? '';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/no password/i.test(msg)) throw new PdfPasswordRequiredError();
    if (/incorrect password/i.test(msg)) throw new PdfWrongPasswordError();
    throw err;
  }
}

/**
 * Detecta linhas de transação no texto do PDF.
 * Heurística:
 *  - Cada linha começa com data DD/MM (ou DD/MM/AAAA)
 *  - Termina com valor monetário (R$ opcional, formato brasileiro)
 *  - Meio é descrição (estabelecimento)
 *  - Sinal de "-" antes do valor (com espaços) indica estorno (negativo)
 *  - Ano é inferido por mês: faturas mostram lançamentos passados (parcelas)
 */
function extractTransactionsFromText(
  text: string,
  fallbackYear: number,
  due?: { month: number; year: number },
): NormalizedTx[] {
  const tx: NormalizedTx[] = [];
  const lines = text.split(/\r?\n/);

  // Padrão tolerante: data no início, opcional "- " (estorno), valor no fim
  // Captura grupo 3 = sinal de estorno opcional, grupo 4 = valor absoluto
  const lineRe = /^\s*(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+(.+?)\s+(-\s+)?(?:R\$\s*)?(-?\d{1,3}(?:[.\s]\d{3})*(?:[,.]\d{2})|-?\d+[,.]\d{2})\s*$/;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // Skip linhas óbvias de cabeçalho/rodapé/totais/recibo bancário
    if (/^(total|subtotal|saldo|limite|vencimento|fechamento|p[aá]gina|fatura|período|cliente|cpf|cnpj|endere[çc]o|pagamento|nome\b|n[uú]mero|valor\s+do\s+documento|emiss[aã]o|postagem|previs[aã]o)/i.test(line)) continue;

    const m = lineRe.exec(line);
    if (!m) continue;

    // Validação: dia deve ser 1-31, mês 1-12
    const dateStr = m[1];
    const [dd, mm] = dateStr.split('/').map((s) => parseInt(s, 10));
    if (!(dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12)) continue;

    let description = m[2].trim().replace(/\s{2,}/g, ' ');
    // Rejeita descrições degeneradas (vazias, só "R$", só pontuação/números)
    if (description.length < 2) continue;
    if (!/[a-zA-Z]/.test(description)) continue;
    if (/^R\$?\s*$/i.test(description)) continue;

    // Sinal de estorno: " - VALOR" no fim significa débito negativo
    const isRefund = !!m[3];
    let amountCents = parseBrlMoney(m[4]);
    if (amountCents == null || amountCents === 0) continue;
    if (isRefund) amountCents = -Math.abs(amountCents);

    // Ano correto baseado no mês de vencimento (faturas mostram parcelas passadas)
    const txYear = resolveYearForTransaction(mm, due, fallbackYear);
    const date = new Date(Date.UTC(txYear, mm - 1, dd));
    if (isNaN(date.getTime())) continue;

    const inst = detectInstallmentLoose(description);
    const merchant = inst.cleanMerchant || description;

    tx.push({
      externalId: '',
      date,
      merchant,
      amountCents,
      installmentCurrent: inst.current,
      installmentTotal: inst.total,
    });
  }

  // Dedup: faturas listam parcelas atuais (cobradas) E parcelas futuras (planejamento).
  // Como o commitImport já gera futuras automaticamente, mantemos apenas a 1ª
  // ocorrência de cada (date + merchant + amountCents com sinal). Para parcelas,
  // prefere a menor (parcela atual = cobrada nesta fatura).
  const dedup = new Map<string, NormalizedTx>();
  for (const t of tx) {
    const key = `${t.date.toISOString().slice(0, 10)}|${t.merchant.toLowerCase()}|${t.amountCents}`;
    const existing = dedup.get(key);
    if (!existing) {
      dedup.set(key, t);
      continue;
    }
    const existingInst = existing.installmentCurrent ?? Number.MAX_SAFE_INTEGER;
    const currentInst = t.installmentCurrent ?? Number.MAX_SAFE_INTEGER;
    if (currentInst < existingInst) dedup.set(key, t);
  }
  return [...dedup.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
}

export async function parsePdfStatement(
  buffer: Buffer,
  cardId: string,
  password?: string,
  _fileName?: string,
): Promise<ParseResult> {
  const text = await extractPdfText(buffer, password);
  const due = inferDueDateFromText(text);
  const year = due?.year ?? inferYearFromText(text) ?? new Date().getUTCFullYear();
  const transactions = extractTransactionsFromText(text, year, due);

  for (const t of transactions) {
    t.externalId = makeExternalId({
      cardId,
      date: t.date,
      merchant: t.merchant,
      amountCents: t.amountCents,
    });
  }

  const totalAmountCents = transactions.reduce((s, t) => s + t.amountCents, 0);

  return {
    source: 'PDF',
    periodLabel: inferPeriodLabel(transactions),
    transactions,
    totalAmountCents,
  };
}
