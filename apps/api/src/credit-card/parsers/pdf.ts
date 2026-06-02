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
  assignOrdinals,
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
 *
 * Exceção: parcelas N/M com N>1 e mês > due geralmente são **projeções futuras**
 * (parcelamentos vencendo em meses seguintes do mesmo ano da fatura).
 */
function resolveYearForTransaction(
  txMonth: number,
  due: { month: number; year: number } | undefined,
  fallbackYear: number,
  installmentCurrent?: number,
): number {
  if (!due) return fallbackYear;
  if (txMonth > due.month) {
    // Se é parcela N>1, provavelmente é projeção futura do mesmo ano da fatura
    if (installmentCurrent != null && installmentCurrent > 1) return due.year;
    return due.year - 1;
  }
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
// Marcadores de seção "futura" — após estes, paramos de ler transações
// (faturas listam parcelas futuras como projeção; commitImport gera essas automaticamente).
// Marcadores de seção "futura" — após estes, paramos de ler transações
// (faturas listam parcelas futuras como projeção; commitImport gera essas automaticamente).
// Mais permissivo: cobre Itaú, Nubank, Santander, Bradesco, BB, Caixa, C6, Inter, XP, etc.
const FUTURE_SECTION_RE = new RegExp(
  '^(?:\\s*)(' +
  [
    'pr[oó]xim[oa]s?\\s+(?:faturas?|compras?|lan[cç]amentos?|parcelas?|pagamentos?|m[eê]s|meses|vencimentos?|cobran[cç]as?)',
    'compras\\s+parceladas\\s+(?:futuras?|em\\s+aberto|a\\s+vencer|projetadas?)',
    'parcelas?\\s+(?:futuras?|a\\s+vencer|previstas?|em\\s+aberto|projetadas?|seguintes?)',
    'pagamentos?\\s+(?:futuros?|previstos?)(?:\\s+parcelados?)?',
    'pr[eé]\\s*-?\\s*fatura',
    'demonstrativo\\s+das\\s+compras\\s+parceladas',
    'resumo\\s+das\\s+parcelas?\\s+(?:a\\s+vencer|futuras?)',
    'fatura\\s+(?:posterior|seguinte|pr[oó]xima)',
    'lan[cç]amentos?\\s+(?:futuros?|previstos?|a\\s+vencer)',
    'compromissos?\\s+(?:futuros?|pr[oó]ximos?|a\\s+vencer)',
    'faturas?\\s+(?:seguintes?|pr[oó]ximas?|projetadas?)',
    'compras?\\s+a\\s+vencer',
    'demonstrativo\\s+de\\s+parcelamentos?',
    'previs[aã]o\\s+de\\s+(?:cobran[cç]as?|lan[cç]amentos?|parcelas?|pagamentos?)',
    'acompanhamento\\s+de\\s+compras\\s+parceladas',
    'saldo\\s+a\\s+vencer',
  ].join('|') +
  ')\\b',
  'i',
);

export function extractTransactionsFromText(
  text: string,
  fallbackYear: number,
  due?: { month: number; year: number },
): { current: NormalizedTx[]; future: NormalizedTx[] } {
  const current: NormalizedTx[] = [];
  const future: NormalizedTx[] = [];
  const lines = text.split(/\r?\n/);

  // Padrão tolerante: data no início, opcional "- " (estorno), valor no fim
  // Captura grupo 3 = sinal de estorno opcional, grupo 4 = valor absoluto
  const lineRe = /^\s*(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\s+(.+?)\s+(-\s+)?(?:R\$\s*)?(-?\d{1,3}(?:[.\s]\d{3})*(?:[,.]\d{2})|-?\d+[,.]\d{2})\s*$/;

  let inFutureSection = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // Detecta entrada em seção de futuro/projeção
    if (FUTURE_SECTION_RE.test(line)) {
      inFutureSection = true;
      continue;
    }

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

    // Detecta parcela ANTES de resolver o ano: parcelas N>1 ajudam a inferir ano correto
    const inst = detectInstallmentLoose(description);
    const merchant = inst.cleanMerchant || description;

    // Ano correto baseado no mês de vencimento (faturas mostram parcelas passadas)
    const txYear = resolveYearForTransaction(mm, due, fallbackYear, inst.current);
    const date = new Date(Date.UTC(txYear, mm - 1, dd));
    if (isNaN(date.getTime())) continue;

    const t: NormalizedTx = {
      externalId: '',
      date,
      merchant,
      amountCents,
      installmentCurrent: inst.current,
      installmentTotal: inst.total,
      isFuture: inFutureSection,
    };
    if (inFutureSection) future.push(t);
    else current.push(t);
  }

  function dedupAll(arr: NormalizedTx[], collapseSeries: boolean): NormalizedTx[] {
    // Dedup nível 1: chave exata (date + merchant + amount + installment).
    const dedup = new Map<string, NormalizedTx>();
    for (const t of arr) {
      const instKey = t.installmentCurrent != null ? `#${t.installmentCurrent}/${t.installmentTotal ?? '?'}` : '';
      const key = `${t.date.toISOString().slice(0, 10)}|${t.merchant.toLowerCase()}|${t.amountCents}${instKey}`;
      const existing = dedup.get(key);
      if (!existing) {
        dedup.set(key, t);
        continue;
      }
      const existingInst = existing.installmentCurrent ?? Number.MAX_SAFE_INTEGER;
      const currentInst = t.installmentCurrent ?? Number.MAX_SAFE_INTEGER;
      if (currentInst < existingInst) dedup.set(key, t);
    }

    // Dedup nível 2: mesma série de parcelamento aparecendo duas vezes
    // (ex.: "POLO MARMORESS 1/3 R$ 2158,34" + "POLO MARMORESS 2/3 R$ 2158,33"
    // — 1 cent de diff por arredondamento). Mantém apenas a parcela menor.
    const bySeries = new Map<string, NormalizedTx>();
    const seriesCount = new Map<string, number>();
    for (const t of dedup.values()) {
      if (t.installmentCurrent == null || t.installmentTotal == null) continue;
      const k = `${t.date.toISOString().slice(0, 10)}|${t.merchant.toLowerCase()}|${t.installmentTotal}`;
      seriesCount.set(k, (seriesCount.get(k) ?? 0) + 1);
      const existing = bySeries.get(k);
      if (!existing) { bySeries.set(k, t); continue; }
      const diff = Math.abs(existing.amountCents - t.amountCents);
      const tol = Math.max(5, Math.round(Math.abs(existing.amountCents) * 0.01));
      if (diff <= tol) {
        const winner = (t.installmentCurrent ?? Infinity) < (existing.installmentCurrent ?? Infinity) ? t : existing;
        bySeries.set(k, winner);
      }
    }
    const result: NormalizedTx[] = [];
    for (const t of dedup.values()) {
      if (collapseSeries && t.installmentCurrent != null && t.installmentTotal != null) {
        const k = `${t.date.toISOString().slice(0, 10)}|${t.merchant.toLowerCase()}|${t.installmentTotal}`;
        if ((seriesCount.get(k) ?? 0) > 1) {
          if (bySeries.get(k) === t) result.push(t);
          continue;
        }
      }
      result.push(t);
    }
    return result.sort((a, b) => a.date.getTime() - b.date.getTime());
  }

  // Heurística adicional: se uma parcela N/M aparece em data > mês de vencimento
  // da fatura, e não há "1/M" da mesma série em `current`, é provavelmente uma
  // projeção futura (cobre casos onde a fatura não usa header reconhecido).
  // Esta heurística é CONSERVADORA: só move pra future se:
  //  - tem installmentCurrent > 1 e installmentTotal definidos
  //  - data > fim do mês de vencimento (parcelas futuras vencem em meses seguintes)
  //  - amount > 0 (despesa, não estorno)
  function applyFutureHeuristic(curArr: NormalizedTx[], futArr: NormalizedTx[]): {
    current: NormalizedTx[]; future: NormalizedTx[];
  } {
    if (!due) return { current: curArr, future: futArr };
    // Última data válida da fatura "atual": último dia do mês de vencimento.
    const dueMonthEnd = new Date(Date.UTC(due.year, due.month, 0));
    const movedToFuture: NormalizedTx[] = [];
    const remainingCurrent: NormalizedTx[] = [];
    for (const t of curArr) {
      const isFutureLike =
        t.installmentCurrent != null &&
        t.installmentTotal != null &&
        t.installmentCurrent > 1 &&
        t.amountCents > 0 &&
        t.date > dueMonthEnd;
      if (isFutureLike) {
        movedToFuture.push({ ...t, isFuture: true });
      } else {
        remainingCurrent.push(t);
      }
    }
    return {
      current: remainingCurrent,
      future: [...futArr, ...movedToFuture],
    };
  }

  const dedupedCurrent = dedupAll(current, true);
  const dedupedFuture = dedupAll(future, false);
  const adjusted = applyFutureHeuristic(dedupedCurrent, dedupedFuture);

  return {
    current: adjusted.current,
    future: adjusted.future,
  };
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
  const { current, future } = extractTransactionsFromText(text, year, due);

  const ordCurrent = assignOrdinals(current);
  for (let i = 0; i < current.length; i++) {
    current[i].externalId = makeExternalId({
      cardId,
      date: current[i].date,
      merchant: current[i].merchant,
      amountCents: current[i].amountCents,
      ordinal: ordCurrent[i]._ordinal,
    });
  }
  const ordFuture = assignOrdinals(future);
  for (let i = 0; i < future.length; i++) {
    // ID determinístico inclui parcela para evitar colisões com current
    future[i].externalId = makeExternalId({
      cardId,
      date: future[i].date,
      merchant: `${future[i].merchant}#FUT${future[i].installmentCurrent ?? 0}/${future[i].installmentTotal ?? 0}`,
      amountCents: future[i].amountCents,
      ordinal: ordFuture[i]._ordinal,
    });
  }

  // Telemetria suave: detecta cenários suspeitos onde MUITAS parcelas N>1 ainda
  // estão em `current` (provável fatura cujo header de "futuros" não foi reconhecido).
  // Apenas loga — não muda o resultado (a heurística aplyFutureHeuristic já tentou
  // remediar quando há mês de vencimento detectado).
  const nonFirstInstallments = current.filter(
    (t) => t.installmentCurrent != null && t.installmentCurrent > 1 && t.amountCents > 0,
  ).length;
  if (current.length > 0 && nonFirstInstallments / current.length > 0.4) {
    console.warn(
      `[pdf-parser] suspect: ${nonFirstInstallments}/${current.length} txs are non-first installments; ` +
      `due=${due ? `${due.month}/${due.year}` : 'unknown'} — fatura pode ter header de futuras não reconhecido.`,
    );
  }

  const totalAmountCents = current.reduce((s, t) => s + t.amountCents, 0);

  return {
    source: 'PDF',
    periodLabel: inferPeriodLabel(current),
    transactions: current,
    totalAmountCents,
    futureInstallments: future,
  };
}
