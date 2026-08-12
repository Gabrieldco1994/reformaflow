import * as XLSX from 'xlsx';
import {
  assignOrdinals,
  inferPeriodLabel,
  makeExternalId,
  parseBrlMoney,
  type NormalizedTx,
  type ParseResult,
  type UnparsedRow,
} from '../../credit-card/parsers/types';
import { expandSheetRange } from '../../credit-card/parsers/xlsx-range';

/**
 * Parser Excel (.xlsx/.xls) para faturas e extratos.
 *
 * Heurística fuzzy para headers:
 * - Case-insensitive
 * - Remove acentos para matching
 * - Procura por palavras-chave: "data", "descrição", "valor"
 *
 * Normaliza:
 * - Valor: BR (1.234,56) e US (1,234.56)
 * - Data: dd/mm/aaaa, aaaa-mm-dd, serial Excel
 */

interface ParseOptions {
  cardId: string;
}

export function parseXlsx(buffer: Buffer, cardId: string): ParseResult {
  try {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    if (!workbook.SheetNames.length) {
      return {
        source: 'XLSX',
        transactions: [],
        totalAmountCents: 0,
        error: 'Arquivo Excel vazio',
      };
    }

    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    // Corrige `<dimension>` defasada ANTES de ler as linhas — senão o
    // sheet_to_json trunca contiguamente no range declarado (causa-raiz do
    // corte que engoliu lançamentos a partir de 24/07). Ver xlsx-range.ts.
    expandSheetRange(sheet);
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];

    if (!data.length) {
      return {
        source: 'XLSX',
        transactions: [],
        totalAmountCents: 0,
        error: 'Nenhuma linha no Excel',
      };
    }

    // Detecta índices das colunas essenciais
    const headerIdx = findHeaderRow(data);
    if (headerIdx === -1) {
      return {
        source: 'XLSX',
        transactions: [],
        totalAmountCents: 0,
        error: 'Não identifiquei as colunas de data, descrição e valor. Exporte como CSV ou OFX.',
      };
    }

    const headers = (data[headerIdx] ?? []) as string[];
    const colMap = mapColumns(headers);

    if (colMap.date === -1 || colMap.merchant === -1 || colMap.amount === -1) {
      return {
        source: 'XLSX',
        transactions: [],
        totalAmountCents: 0,
        error: 'Não identifiquei as colunas de data, descrição e valor. Exporte como CSV ou OFX.',
      };
    }

    const transactions: NormalizedTx[] = [];
    const unparsedRows: UnparsedRow[] = [];
    let totalAmountCents = 0;

    for (let i = headerIdx + 1; i < data.length; i++) {
      const row = data[i] ?? [];
      if (!Array.isArray(row) || row.length === 0) continue;

      const dateRaw = String(row[colMap.date] ?? '').trim();
      const descRaw = String(row[colMap.merchant] ?? '').trim();
      const amountRaw = String(row[colMap.amount] ?? '').trim();
      const categoryRaw = colMap.category !== -1 ? String(row[colMap.category] ?? '').trim() : undefined;

      // Linha de SALDO (checkpoint do dia), não é movimento. O valor mora numa
      // coluna "saldos" separada; se um saldo virasse lançamento o usuário
      // ganharia dinheiro fantasma. Detecta pela descrição ("SALDO ANTERIOR",
      // "SALDO TOTAL DISPONÍVEL DIA") e pula EXPLICITAMENTE — não confia só no
      // fato de a coluna de valor estar vazia (que era um skip incidental).
      if (isSaldoRow(descRaw)) continue;

      // Sem data legível = linha de preâmbulo/cabeçalho de seção → ignora em
      // silêncio (não é um movimento perdido).
      const date = dateRaw ? parseFlexibleDate(dateRaw) : null;
      if (!date) continue;

      // A partir daqui a linha TEM data válida. Se não produzir um valor, é um
      // movimento potencialmente perdido — registra em unparsedRows em vez de
      // sumir sem rastro (foi a categoria que escondeu o salário).
      if (!amountRaw) {
        if (descRaw) unparsedRows.push({ rowIndex: i + 1, date: dateRaw, description: descRaw, reason: 'no-amount' });
        continue;
      }

      const amountCents = -parseBrlMoney(amountRaw);
      if (amountCents === 0) {
        if (descRaw) unparsedRows.push({ rowIndex: i + 1, date: dateRaw, description: descRaw, reason: 'unreadable' });
        continue;
      }

      // NÃO aplica detectInstallment: extrato de conta corrente não tem
      // parcelamento, e a descrição do Itaú termina com a data da compra
      // ("PAY NA JA 01/07"), que era lida como "parcela 1 de 7". Além de
      // inventar um parcelamento inexistente, isso reescrevia a descrição
      // (virava "PAY NA JA") e mudava o externalId, quebrando a deduplicação
      // entre exports do mesmo período — a origem de 30 lançamentos
      // duplicados em produção. E era intermitente: só disparava quando o dia
      // era <= o mês ("08/07" escapava, "01/07" não).
      transactions.push({
        externalId: '', // preenchido abaixo após assignOrdinals
        date,
        merchant: descRaw || 'Lançamento',
        amountCents,
        rawCategory: categoryRaw || undefined,
      });
      if (amountCents > 0) totalAmountCents += amountCents;
    }

    // Atribui ordinal por bucket para diferenciar N linhas idênticas no mesmo dia.
    const withOrdinals = assignOrdinals(transactions);
    for (let i = 0; i < transactions.length; i++) {
      transactions[i].externalId = makeExternalId({
        cardId,
        date: transactions[i].date,
        merchant: transactions[i].merchant,
        amountCents: transactions[i].amountCents,
        ordinal: withOrdinals[i]._ordinal,
      });
    }

    return {
      source: 'XLSX',
      transactions,
      totalAmountCents,
      periodLabel: inferPeriodLabel(transactions),
      unparsedRows: unparsedRows.length ? unparsedRows : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      source: 'XLSX',
      transactions: [],
      totalAmountCents: 0,
      error: `Erro ao parsear Excel: ${message}`,
    };
  }
}

/**
 * Encontra a linha de cabeçalho procurando por palavras-chave.
 * Retorna o índice da primeira linha com headers, ou -1 se não encontrar.
 */
function findHeaderRow(data: unknown[][]): number {
  for (let i = 0; i < Math.min(data.length, 10); i++) {
    const row = data[i];
    if (!Array.isArray(row)) continue;
    // Array.from preenche buracos de array esparso (célula vazia antes de uma
    // preenchida) com undefined em vez de deixar o índice "furado" — .map()
    // preserva o furo e um acesso indexado posterior estoura (classe do bug do
    // PR #414). Aqui normalizamos por índice.
    const headers = Array.from(row, (cell) => String(cell ?? '').toLowerCase());
    if (hasHeaderKeywords(headers)) {
      return i;
    }
  }
  return -1;
}

/**
 * Verifica se uma linha contém keywords de header (data, descrição, valor).
 */
function hasHeaderKeywords(headers: string[]): boolean {
  const normalized = headers.map((h) => removeAccents(h));
  const hasData = normalized.some((h) => /data|date|dt/.test(h));
  const hasDesc = normalized.some((h) => /descri|historico|lancamento|memo|title/.test(h));
  const hasAmount = normalized.some((h) => /valor|amount|montante|quantia/.test(h));
  return hasData && hasDesc && hasAmount;
}

/**
 * Remove acentos de uma string para matching case-insensitive.
 */
function removeAccents(str: string): string {
  return String(str ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Uma linha de SALDO é um checkpoint do dia (saldo anterior, saldo total
 * disponível), NÃO um movimento. Detecta pela descrição ANCORADA no início
 * ("SALDO ANTERIOR", "SALDO TOTAL DISPONÍVEL DIA", "SALDO DO DIA") — resiliente
 * a mojibake de encoding ("SALDO TOTAL DISPONÃVEL DIA") porque casa só a
 * primeira palavra. Ancorar no início evita descartar um movimento real cuja
 * descrição apenas MENCIONE "saldo" no meio do texto.
 */
function isSaldoRow(description: string): boolean {
  return /^saldo\b/i.test(removeAccents(description).trim());
}

interface ColumnMap {
  date: number;
  merchant: number;
  amount: number;
  category: number;
}

/**
 * Mapeia colunas pelo header usando fuzzy matching.
 * Evita falsos positivos: prefere keywords mais específicas.
 */
function mapColumns(headers: string[]): ColumnMap {
  const normalized = Array.from(headers, (h) => removeAccents(String(h ?? '')));

  // Procura mais específica: prioritiza keywords únicos por coluna
  const findBest = (dateKeywords: string[], descKeywords: string[], amountKeywords: string[]): ColumnMap => {
    const scores: { date: number; merchant: number; amount: number } = {
      date: -1,
      merchant: -1,
      amount: -1,
    };

    for (let i = 0; i < normalized.length; i++) {
      const h = normalized[i];

      // Procura keywords de data
      for (const kw of dateKeywords) {
        if (h.includes(kw)) {
          if (scores.date === -1) scores.date = i;
          break;
        }
      }

      // Procura keywords de descrição
      // Evita "lancamento" se "data lancamento" está presente
      let foundDesc = false;
      for (const kw of descKeywords) {
        if (h.includes(kw)) {
          if (!h.includes('data')) { // Evita "data lancamento"
            if (scores.merchant === -1) scores.merchant = i;
            foundDesc = true;
            break;
          }
        }
      }

      // Procura keywords de valor — NUNCA casa a coluna de "saldo(s)". O valor
      // do movimento e o saldo do dia são colunas distintas; se a coluna de
      // valor apontasse para o saldo, saldos virariam lançamentos (dinheiro
      // fantasma) e os movimentos reais sumiriam. Exclusão explícita.
      if (!h.includes('saldo')) {
        for (const kw of amountKeywords) {
          if (h.includes(kw)) {
            if (scores.amount === -1) scores.amount = i;
            break;
          }
        }
      }
    }

    return {
      date: scores.date >= 0 ? scores.date : -1,
      merchant: scores.merchant >= 0 ? scores.merchant : -1,
      amount: scores.amount >= 0 ? scores.amount : -1,
      category: -1,
    };
  };

  const result = findBest(
    ['data', 'date', 'dt'],
    ['descri', 'historico', 'memo', 'title', 'estabelec', 'lancamento'],
    ['valor', 'amount', 'montante', 'quantia'],
  );

  // Se não encontrou, tenta category
  if (result.category === -1) {
    for (let i = 0; i < normalized.length; i++) {
      if (normalized[i].includes('categ') || normalized[i].includes('category')) {
        result.category = i;
        break;
      }
    }
  }

  return result;
}

/**
 * Parseia data em múltiplos formatos:
 * - ISO: 2026-05-12
 * - BR: 12/05/2026 ou 12/05/26
 * - Serial Excel: número inteiro representando dias desde 1900-01-01
 */
function parseFlexibleDate(raw: string): Date | null {
  const s = String(raw).trim();
  if (!s) return null;

  // Serial Excel (número)
  if (/^\d+$/.test(s)) {
    const serial = parseInt(s, 10);
    if (serial > 0 && serial < 100000) {
      // Excel serial: 1 = 1900-01-01 (com bug de 1900 sendo bissexto)
      // Ajustamos para JavaScript: 1 = 1900-01-01, mas -1 para compensar bug Excel
      const date = new Date(1900, 0, serial - 1);
      return date;
    }
  }

  // ISO: 2026-05-12
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  }

  // BR: 12/05/2026 ou 12/05/26
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    let y = parseInt(m[3], 10);
    if (y < 100) y += 2000;
    return new Date(Date.UTC(y, +m[2] - 1, +m[1]));
  }

  return null;
}
