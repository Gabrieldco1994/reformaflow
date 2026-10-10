import { createHash } from "node:crypto";
import {
  IMPORT_SESSION_LIMITS,
  IMPORT_SESSION_PRIMITIVES,
  parseInstallmentDateOnlyUtc,
} from "@reformaflow/domain";
import { computeImportOrdinals } from "./dedupe-key";

export type CardStatementDocumentInputV1 = Readonly<{
  version: 1;
  context: "CARD_INVOICE";
  format: "CSV" | "PDF";
  profile: "CSV_NUBANK" | "CSV_ITAU";
  bytes: Buffer;
}>;

export interface DocumentOccurrenceV1 {
  readonly reference: string;
  readonly sourceOrdinal: number;
  readonly section: "CURRENT" | "FUTURE" | "UNKNOWN";
  readonly raw: Readonly<{
    date: string | null;
    description: string | null;
    amount: string | null;
    installment: string | null;
  }>;
  readonly cycle: Readonly<{
    invoiceDueMonth: string;
    reference: string;
  }> | null;
  readonly dateOnly: string | null;
  readonly merchant: string | null;
  readonly amountCents: number | null;
  readonly amountMeaning: "TOTAL_PURCHASE" | "INSTALLMENT_CHARGE" | "UNKNOWN";
  readonly installmentCount: number | null;
  readonly installmentIndex: number | null;
  readonly fitId: string | null;
  /** Ordinal in the complete known-identity set, never in a selection. */
  readonly identityOrdinal: number | null;
}

export interface DocumentDiagnosticV1 {
  readonly reference: string | null;
  readonly code:
    | "UNREADABLE_ROW"
    | "UNKNOWN_DATE"
    | "UNKNOWN_AMOUNT_MEANING"
    | "UNSUPPORTED_CONTENT"
    | "INVALID_CALENDAR_DATE"
    | "AMBIGUOUS_CYCLE"
    | "OVERLONG_FIELD";
}

export interface DocumentExtractionV1 {
  readonly version: 1;
  readonly parserVersion:
    | "card-local-text-v1"
    | "card-local-pdf-v1"
    | "card-local-xls-v1"
    | "card-local-xlsx-v1";
  readonly documentKind: "INVOICE" | "BANK_STATEMENT" | "RECEIPT" | "UNKNOWN";
  readonly invoiceDueMonth: string | null;
  readonly metrics: Readonly<{
    pages: number;
    rows: number;
    expandedBytes: number;
    archiveEntries: number;
    imagePixels: number;
    frames: number;
  }>;
  readonly occurrences: readonly DocumentOccurrenceV1[];
  readonly diagnostics: readonly DocumentDiagnosticV1[];
}

export class DocumentExtractionError extends Error {
  constructor(
    readonly code:
      | "INVALID_INPUT"
      | "UNSUPPORTED_DOCUMENT"
      | "LIMIT_EXCEEDED"
      | "INVALID_RESULT",
  ) {
    super(code);
    this.name = "DocumentExtractionError";
  }
}

export interface NormalizedTx {
  externalId: string; // hash determinístico para dedup
  date: Date; // data da transação
  merchant: string; // descrição do estabelecimento
  amountCents: number; // positivo = despesa, negativo = estorno
  rawCategory?: string; // se a fonte enviar
  installmentCurrent?: number;
  installmentTotal?: number;
  isFuture?: boolean; // true = parcela/lançamento futuro (entrará como PLANEJADO)
  /**
   * (#659) FITID do OFX — id durável do banco para a transação. Alimenta
   * `bankRef` no `makeExternalId` (compat) E a `dedupeKeyStrong` cross-origin.
   * Só o parser OFX preenche; CSV/XLSX/PDF/foto não têm.
   */
  fitId?: string;
  /**
   * (#659) Chaves de dedupe cross-origin, computadas pelo SERVIÇO após o parse
   * (`import-dedupe/cross-origin-dedupe.ts` → `attachDedupeKeys`), nunca pelo
   * parser. `dedupeKeyStrong` = null só em linha histórica (sem fitId nem
   * fileContentHash). Independem do `seed` do canal — é o fix de #659.
   */
  dedupeKeyStrong?: string | null;
  dedupeKeyNatural?: string;
}

export interface ParseResult {
  source:
    | "OFX"
    | "CSV_NUBANK"
    | "CSV_ITAU"
    | "CSV_GENERIC"
    | "PDF"
    | "IMAGE"
    | "XLSX";
  transactions: NormalizedTx[];
  totalAmountCents: number;
  periodLabel?: string; // YYYY-MM da maior densidade
  /**
   * Mês de vencimento da fatura (YYYY-MM) lido DIRETAMENTE do arquivo — não
   * inferido das datas dos lançamentos. Faturas Itaú repetem a data da COMPRA
   * em toda parcela ("Parcela 2 de 10" continua datada de 22/06), então só este
   * campo diz em qual fatura a parcela está sendo cobrada de fato.
   */
  invoiceDueMonth?: string;
  futureInstallments?: NormalizedTx[]; // parcelas/lançamentos futuros (apenas informativo)
  error?: string; // erro durante parsing (ex.: arquivo vazio, formato inválido)
  /**
   * Linhas que TÊM data + descrição mas o parser NÃO conseguiu transformar em
   * lançamento (sem valor legível, valor zero, etc.) e que NÃO são linhas de
   * saldo. É a categoria de perda silenciosa que escondeu um salário: a linha
   * existe no arquivo, chega ao parser, mas some sem virar transação nem
   * duplicata. Reportada ao usuário para auditoria — nunca descartada em silêncio.
   */
  unparsedRows?: UnparsedRow[];
}

export interface UnparsedRow {
  rowIndex: number; // linha 1-based na planilha (para o usuário localizar)
  date: string; // data crua lida
  description: string; // descrição crua lida
  reason: "no-amount" | "unreadable";
}

/**
 * Adiciona uma transação ao mapa de merge, tratando colisão de externalId.
 *
 * IMAGE (fotos de página de extrato/fatura sobrepostas): colisão = a MESMA
 * transação capturada 2x por fotos que se sobrepõem → dedupe (mantém 1),
 * comportamento original e intencional.
 *
 * Outras fontes (XLSX/CSV/OFX/PDF): 2 arquivos são exports distintos, não
 * fotos manuais da mesma página. Uma colisão aqui quase sempre é 2 transações
 * REAIS e diferentes que coincidem em data+descrição+valor (o ordinal reinicia
 * por arquivo — ver assignOrdinals) — não é seguro presumir duplicata e
 * descartar (perda silenciosa de dinheiro). Mantém as duas, derivando um novo
 * externalId estável para a 2ª+ ocorrência (mesmo lote reimportado gera o
 * mesmo resultado, preservando idempotência).
 */
function addMerged(
  map: Map<string, NormalizedTx>,
  t: NormalizedTx,
  dedupeOnCollision: boolean,
) {
  if (!map.has(t.externalId)) {
    map.set(t.externalId, t);
    return;
  }
  if (dedupeOnCollision) return;
  let n = 1;
  let key = `${t.externalId}::merge${n}`;
  while (map.has(key)) {
    n++;
    key = `${t.externalId}::merge${n}`;
  }
  map.set(key, { ...t, externalId: key });
}

/**
 * Mescla vários ParseResult (ex.: upload de múltiplos arquivos/imagens de
 * fatura/extrato em lote) num único resultado e soma os totais. Preserva a
 * ordem por data. Ver `addMerged` para a regra de dedupe por fonte.
 */
export function mergeParseResults(results: ParseResult[]): ParseResult {
  if (results.length === 1) return results[0]!;

  const txByExt = new Map<string, NormalizedTx>();
  const futByExt = new Map<string, NormalizedTx>();
  let total = 0;
  const sources = new Set<string>();

  for (const r of results) {
    sources.add(r.source);
    const dedupeOnCollision = r.source === "IMAGE";
    for (const t of r.transactions) {
      addMerged(txByExt, t, dedupeOnCollision);
    }
    for (const t of r.futureInstallments ?? []) {
      addMerged(futByExt, t, dedupeOnCollision);
    }
  }

  const transactions = Array.from(txByExt.values()).sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );
  const futureInstallments = Array.from(futByExt.values()).sort(
    (a, b) => a.date.getTime() - b.date.getTime(),
  );
  total = transactions
    .filter((t) => t.amountCents > 0)
    .reduce((s, t) => s + t.amountCents, 0);

  return {
    source: sources.size === 1 ? results[0]!.source : "IMAGE",
    transactions,
    totalAmountCents: total,
    periodLabel: results.find((r) => r.periodLabel)?.periodLabel,
    futureInstallments,
  };
}

export function makeExternalId(parts: {
  cardId: string;
  date: Date;
  merchant: string;
  amountCents: number;
  bankRef?: string;
  ordinal?: number; // ordinal por bucket (date+merchant+amount) — diferencia
  // N transações idênticas no mesmo dia. Quando bankRef
  // é único, ordinal não é necessário (e é ignorado).
}): string {
  if (parts.bankRef) {
    return createHash("sha256")
      .update(`${parts.cardId}|${parts.bankRef}`)
      .digest("hex")
      .slice(0, 32);
  }
  const ord = parts.ordinal ?? 0;
  // BACKWARD COMPAT: ordinal=0 produz o MESMO hash do formato antigo
  // (sem campo ordinal). Isso garante que re-importar dados pré-fix
  // não duplique: linhas únicas continuam casando o externalId existente.
  // Apenas ordinal>0 (2ª, 3ª... ocorrência idêntica) entra no hash.
  const baseKey = `${parts.cardId}|${parts.date.toISOString().slice(0, 10)}|${parts.merchant.toLowerCase().trim()}|${parts.amountCents}`;
  const key = ord === 0 ? baseKey : `${baseKey}|${ord}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

/**
 * Atribui ordinais sequenciais a transações com mesmo bucket (date+merchant+amount).
 * Preserva a ordem original do arquivo — re-import do mesmo arquivo gera os mesmos
 * ordinais (idempotente). N linhas idênticas geram N externalIds distintos.
 *
 * Use depois de parsear o arquivo, ANTES de gerar os externalIds.
 */
export function assignOrdinals<
  T extends { date: Date; merchant: string; amountCents: number },
>(txs: T[]): (T & { _ordinal: number })[] {
  const counts = new Map<string, number>();
  return txs.map((t) => {
    const key = `${t.date.toISOString().slice(0, 10)}|${t.merchant.toLowerCase().trim()}|${t.amountCents}`;
    const next = counts.get(key) ?? 0;
    counts.set(key, next + 1);
    return Object.assign({}, t, { _ordinal: next });
  });
}

export function inferPeriodLabel(txs: NormalizedTx[]): string | undefined {
  if (txs.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const t of txs) {
    const key = `${t.date.getUTCFullYear()}-${String(t.date.getUTCMonth() + 1).padStart(2, "0")}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestN = -1;
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

/**
 * Detecta se uma descrição de transação contém informação de parcelamento.
 *
 * LIMITAÇÃO CONHECIDA (ambiguidade de desenho):
 *   Casos onde `current === total` E ambos <= 12 (ex: "12/12", "01/01", "06/06")
 *   são ambíguos: podem ser "última parcela de 12" ou "data no formato dia/mês
 *   onde dia coincide com mês". A estratégia atual é aceitar como parcela nestes
 *   casos porque última parcela com este padrão é mais frequente em faturas reais
 *   que data sozinha numa descrição de lançamento. Casos com leading zero tipo
 *   "03/07" (dia ≠ mês) ou "03/03" (dia == mês, mas sem leading zero) seguem
 *   rigorosos: "03/07" é rejeitado (data), "3/3" é aceito (parcela).
 *
 *   Contexto explícito (PARC, parênteses, palavra DE) supera essa ambiguidade e
 *   sempre funciona corretamente.
 */
export function detectInstallment(description: string): {
  current?: number;
  total?: number;
  cleanMerchant: string;
} {
  const { rawInstallment: _raw, ...result } = captureInstallment(description);
  return result;
}

function captureInstallment(
  description: string,
  documentary = false,
): {
  current?: number;
  total?: number;
  cleanMerchant: string;
  rawInstallment: string | null;
} {
  // Padrões: "PARC 02/10", "PARC. 2/10", "2/12 puro", "2 DE 10", "(2/10)"
  //
  // Contexto explícito (com palavra-chave ou padrão inequívoco):
  //   - "PARC 2/12" — palavra "PARC"
  //   - "(2/12)" — parênteses
  //   - "2 DE 12" — palavra "DE"
  // Validação: flexível (current >= 1, total > 1, current <= total, total <= 60)
  //
  // Contexto implícito (X/Y puro):
  //   - "2/12" isolado
  // Validação: rigorosa para evitar confundir data (ex.: 03/07 = 3 de julho) com parcela.
  // Uma data válida tem dia 1-31 e mês 1-12. Parcela sem contexto explícito só passa se
  // total > 12 (pois mês máximo é 12; um total > 12 é definitivamente parcelamento).
  const digits = documentary ? "(\\d+)" : "(\\d{1,2})";
  const patterns: Array<{ re: RegExp; hasContext: boolean }> = [
    {
      re: new RegExp(`\\bPARC\\.?\\s*${digits}\\s*\\/\\s*${digits}\\b`, "i"),
      hasContext: true,
    },
    { re: new RegExp(`\\(${digits}\\s*\\/\\s*${digits}\\)`), hasContext: true },
    {
      re: new RegExp(`\\b${digits}\\s*\\/\\s*${digits}\\b(?!\\d)`),
      hasContext: false,
    },
    {
      re: new RegExp(`\\b${digits}\\s*DE\\s*${digits}\\b`, "i"),
      hasContext: true,
    },
  ];

  for (const { re, hasContext } of patterns) {
    const m = description.match(re);
    if (m) {
      const currentStr = m[1];
      const totalStr = m[2];
      const current = parseInt(currentStr, 10);
      const total = parseInt(totalStr, 10);

      // Validação base: current >= 1, total > 1, current <= total
      if (
        !(
          Number.isSafeInteger(current) &&
          Number.isSafeInteger(total) &&
          current >= 1 &&
          total > 1 &&
          current <= total
        )
      )
        continue;

      // Se não tem contexto explícito (X/Y puro), evita confundir data com parcela:
      // Estratégia: rejeita SÓ se for claramente uma data (dia com leading zero + mês <= 12)
      // - "03/07" (data: 3 de julho): leading zero + total <= 12 + current != total → REJEITA ✓
      // - "03/03" (parcela 3 de 3, última): leading zero MAS current == total → ACEITA ✓
      // - "3/7" ou "3 de 7" (parcela: 3 de 7): sem leading zero, pode passar
      // - "1/3", "2/3" (parcela: 1-3): sem leading zero, deve passar
      // - "15/24" (parcela: 15 de 24): total > 12 → claramente parcela, passa
      if (
        !hasContext &&
        total <= 12 &&
        currentStr.length > 1 &&
        currentStr[0] === "0" &&
        current !== total
      ) {
        // Leading zero (ex: "03") com total <= 12 E não é última parcela (03/03, 06/06, etc.)
        // é típico de data, não parcela
        continue;
      }

      // Validação final: total <= 60 (limite razoável para parcelamento)
      if (!documentary && total > 60) continue;

      const cleanMerchant = description
        .replace(re, "")
        .replace(/\s+/g, " ")
        .trim();
      return {
        current,
        total,
        cleanMerchant: cleanMerchant || description.trim(),
        rawInstallment: m[0],
      };
    }
  }
  return { cleanMerchant: description.trim(), rawInstallment: null };
}

export function parseBrlMoney(raw: string): number {
  // "1.234,56" -> 123456; "-89.90" -> -8990; "89,90" -> 8990
  if (raw == null || raw === "") return 0;
  let s = String(raw)
    .replace(/[^\d,.\-]/g, "")
    .trim();
  if (!s || s === "-" || s === "." || s === ",") return 0;
  const negative = s.startsWith("-");
  s = s.replace(/^-/, "");
  if (s.includes(",") && s.includes(".")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (s.includes(",")) {
    s = s.replace(",", ".");
  }
  const n = parseFloat(s);
  if (!isFinite(n)) return 0;
  const cents = Math.round(n * 100);
  return negative ? -cents : cents;
}

export interface CardDocumentCapture {
  readonly reference: string;
  readonly date: string | null;
  readonly description: string | null;
  readonly amount: string | null;
  readonly fitId: string | null;
  readonly installment?: string | null;
  readonly section?: DocumentOccurrenceV1["section"];
  readonly cycle?: DocumentOccurrenceV1["cycle"];
  readonly amountMeaning?: DocumentOccurrenceV1["amountMeaning"];
  readonly diagnostics?: readonly DocumentDiagnosticV1["code"][];
}

function documentaryDate(raw: string | null): {
  dateOnly: string | null;
  code: "UNKNOWN_DATE" | "INVALID_CALENDAR_DATE" | null;
} {
  const value = raw?.trim() ?? "";
  let candidate: string | null = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    candidate = value;
  } else {
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
    if (match)
      candidate = `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
  }
  if (candidate === null) return { dateOnly: null, code: "UNKNOWN_DATE" };
  const date = parseInstallmentDateOnlyUtc(candidate);
  if (
    !date ||
    date.getUTCFullYear() < IMPORT_SESSION_PRIMITIVES.minYear ||
    date.getUTCFullYear() > IMPORT_SESSION_PRIMITIVES.maxYear
  ) {
    return { dateOnly: null, code: "INVALID_CALENDAR_DATE" };
  }
  return { dateOnly: candidate, code: null };
}

function documentaryMoney(raw: string | null): number | null {
  const token = raw?.trim() ?? null;
  if (
    token === null ||
    !/^(?:R\$\s*)?[+-]?(?:\d+(?:[.,]\d{1,2})?|\d{1,3}(?:\.\d{3})+,\d{1,2})$/.test(
      token,
    )
  )
    return null;
  const cents = parseBrlMoney(token);
  return Number.isSafeInteger(cents) &&
    cents >= IMPORT_SESSION_PRIMITIVES.minCents &&
    cents <= IMPORT_SESSION_PRIMITIVES.maxCents
    ? cents
    : null;
}

/** Shared documentary normalization; no legacy transaction or externalId is created. */
export function buildCardDocument(
  captures: readonly CardDocumentCapture[],
  _format: CardStatementDocumentInputV1["format"],
  documentKind: "INVOICE" | "UNKNOWN",
): DocumentExtractionV1 {
  if (captures.length > IMPORT_SESSION_LIMITS.parsedRowsPerFile)
    throw new DocumentExtractionError("LIMIT_EXCEEDED");
  const diagnostics: DocumentDiagnosticV1[] = [];
  const occurrences = captures.map(
    (capture, sourceOrdinal): DocumentOccurrenceV1 => {
      const report = (code: DocumentDiagnosticV1["code"]) =>
        diagnostics.push({ reference: capture.reference, code });
      for (const code of capture.diagnostics ?? []) report(code);
      const date = documentaryDate(capture.date);
      if (date.code) report(date.code);
      const amountCents = documentaryMoney(capture.amount);
      const described = captureInstallment(capture.description ?? "", true);
      const column = capture.installment?.trim()
        ? captureInstallment(capture.installment, true)
        : null;
      const conflict =
        column !== null &&
        (column.total === undefined ||
          (described.total !== undefined &&
            (described.total !== column.total ||
              described.current !== column.current)));
      const installment = column?.total === undefined ? described : column;
      if (conflict) report("UNSUPPORTED_CONTENT");
      const count = conflict ? undefined : installment.total;
      const index = conflict ? undefined : installment.current;
      let merchant: string | null =
        described.cleanMerchant.trim().normalize("NFC") || null;
      if (
        merchant !== null &&
        merchant.length > IMPORT_SESSION_PRIMITIVES.maxSupplierLength
      ) {
        merchant = null;
        report("OVERLONG_FIELD");
      }
      if (amountCents === null || merchant === null) report("UNREADABLE_ROW");
      const meaning = conflict
        ? "UNKNOWN"
        : (capture.amountMeaning ??
          (count === undefined ? "UNKNOWN" : "INSTALLMENT_CHARGE"));
      if (meaning === "UNKNOWN") report("UNKNOWN_AMOUNT_MEANING");
      const fitId = capture.fitId?.trim().normalize("NFC") ?? null;
      if (
        fitId !== null &&
        fitId.length > IMPORT_SESSION_PRIMITIVES.maxReferenceLength
      )
        throw new DocumentExtractionError("LIMIT_EXCEEDED");
      return {
        reference: capture.reference,
        sourceOrdinal,
        section: capture.section ?? "UNKNOWN",
        raw: {
          date: capture.date,
          description: capture.description,
          amount: capture.amount,
          installment:
            capture.installment === undefined || capture.installment === null
              ? described.rawInstallment
              : capture.installment,
        },
        cycle: capture.cycle ?? null,
        dateOnly: date.dateOnly,
        merchant,
        amountCents,
        amountMeaning: meaning,
        installmentCount: count ?? null,
        installmentIndex: index ?? null,
        fitId,
        identityOrdinal: null,
      };
    },
  );
  const identities = occurrences.flatMap((row) =>
    row.dateOnly !== null && row.merchant !== null && row.amountCents !== null
      ? [
          {
            date: new Date(`${row.dateOnly}T00:00:00.000Z`),
            merchant: row.merchant,
            amountCents: row.amountCents,
          },
        ]
      : [],
  );
  const ordinals = computeImportOrdinals(identities);
  let identityIndex = 0;
  return {
    version: 1,
    parserVersion: "card-local-text-v1",
    documentKind,
    invoiceDueMonth: null,
    metrics: {
      pages: 0,
      rows: captures.length,
      expandedBytes: 0,
      archiveEntries: 0,
      imagePixels: 0,
      frames: 0,
    },
    occurrences: occurrences.map((row) => ({
      ...row,
      identityOrdinal:
        row.dateOnly !== null &&
        row.merchant !== null &&
        row.amountCents !== null
          ? ordinals[identityIndex++]
          : null,
    })),
    diagnostics,
  };
}
