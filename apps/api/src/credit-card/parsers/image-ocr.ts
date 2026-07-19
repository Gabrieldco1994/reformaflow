/**
 * OCR de extrato/fatura/comprovante a partir de IMAGEM (print, foto) via Gemini
 * Vision. Estratégia de máximo reuso: a IA apenas TRANSCREVE a imagem para o
 * MESMO formato de texto que os parsers de extrato/fatura já entendem
 * (`DD/MM/AAAA  descrição  valor`), e então reaproveitamos integralmente
 * `extractTransactionsFromText` (fatura) / `extractBankTransactionsFromText`
 * (extrato) — que já aplicam parcela "k/n", dedup, detecção de futuros, sinal,
 * e a classificação posterior (fastClassify/categorize/neutros) no preview.
 *
 * Convenção de sinal (igual ao que está IMPRESSO no documento):
 *  - Fatura de cartão: cobranças POSITIVAS; estornos/créditos com "-".
 *  - Extrato bancário: débitos NEGATIVOS ("-32,99"); créditos/receitas positivos.
 * Cada parser aplica sua própria normalização a partir desse sinal natural.
 */
import {
  assignOrdinals,
  inferPeriodLabel,
  makeExternalId,
  type NormalizedTx,
  type ParseResult,
} from './types';
import { extractTransactionsFromText } from './pdf';
import { extractBankTransactionsFromText } from '../../bank-account/parsers/pdf';

export type StatementKind = 'invoice' | 'statement';

export interface OcrStatementRow {
  /** 'YYYY-MM-DD' ou 'DD/MM/AAAA'. */
  date: string;
  /** Descrição do lançamento, incluindo a parcela "k/n" como aparece (faturas). */
  description: string;
  /** Valor em reais, com o sinal IMPRESSO no documento. */
  amount: number;
}

interface GeminiStatementResult {
  kind?: StatementKind;
  cardLast4?: string;
  rows: OcrStatementRow[];
}

const GEMINI_MODEL = 'gemini-2.5-flash';

/** Erro amigável para falhas de OCR de imagem (sem chave, erro da IA, etc.). */
export class ImageOcrError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageOcrError';
  }
}

// ─── Detecção de imagem por magic bytes ──────────────────────────────────────

export function detectImageMime(buf: Buffer): string | null {
  if (buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buf.length >= 12 &&
    buf.slice(0, 4).toString('ascii') === 'RIFF' &&
    buf.slice(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  if (buf.length >= 6) {
    const head = buf.slice(0, 6).toString('ascii');
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  }
  // HEIC/HEIF: "....ftypheic" / "ftypheif" / "ftypmif1"
  if (buf.length >= 12 && buf.slice(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.slice(8, 12).toString('ascii');
    if (['heic', 'heif', 'heix', 'mif1', 'hevc'].includes(brand)) return 'image/heic';
  }
  return null;
}

export function isImageBuffer(buf: Buffer): boolean {
  return detectImageMime(buf) !== null;
}

// ─── Rows → texto canônico de extrato (reuso dos parsers de texto) ───────────

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function todayBr(currentYear: number): string {
  const today = new Date();
  return `${pad2(today.getUTCDate())}/${pad2(today.getUTCMonth() + 1)}/${currentYear}`;
}

/**
 * ponytail: a IA "chuta" o ano quando ele não aparece impresso na imagem (ex.:
 * print de notificação de Pix), e esse chute é inconsistente entre chamadas
 * idênticas (observado: 2023, 2024, 2026 pro MESMO print). Por pedido
 * explícito do usuário, IGNORAMOS o ano que a IA reportou e sempre usamos o
 * ano vigente (mantendo dia/mês, que a IA lê corretamente da imagem). Se a
 * linha não tiver NENHUMA data reconhecível, cai na data de hoje inteira —
 * nunca descartamos a transação por falta de data.
 */
function normalizeDate(raw: string): string {
  const currentYear = new Date().getUTCFullYear();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw.trim());
  // "0000-00-00": placeholder pedido no prompt para notificações/prints sem
  // NENHUMA data (nem relativa "há 1h"), dia/mês inclusive — cai direto em hoje.
  if (iso && Number(iso[2]) >= 1 && Number(iso[3]) >= 1) {
    const [, , m, d] = iso;
    return `${pad2(Number(d))}/${pad2(Number(m))}/${currentYear}`;
  }
  const br = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(raw.trim());
  if (br && Number(br[1]) >= 1 && Number(br[2]) >= 1) {
    return `${pad2(Number(br[1]))}/${pad2(Number(br[2]))}/${currentYear}`;
  }
  return todayBr(currentYear);
}

function formatBrl(amount: number): string {
  const cents = Math.round(Math.abs(amount) * 100);
  const reais = Math.floor(cents / 100);
  const dec = pad2(cents % 100);
  const intStr = reais.toLocaleString('de-DE'); // milhar com ".", sem decimais
  const sign = amount < 0 ? '-' : '';
  return `${sign}${intStr},${dec}`;
}

export function rowsToStatementText(rows: OcrStatementRow[]): string {
  const lines: string[] = [];
  for (const row of rows) {
    const date = normalizeDate(row.date);
    const desc = (row.description ?? '').replace(/\s+/g, ' ').trim();
    if (!desc) continue;
    if (!Number.isFinite(row.amount)) continue;
    lines.push(`${date} ${desc} ${formatBrl(row.amount)}`);
  }
  return lines.join('\n');
}

// ─── Gemini Vision: imagem → rows ────────────────────────────────────────────

function buildPrompt(kind: StatementKind): string {
  const sourceLabel =
    kind === 'invoice'
      ? 'uma FATURA de cartão de crédito'
      : 'um EXTRATO bancário (conta corrente)';
  const signRule =
    kind === 'invoice'
      ? '- Valores de COMPRAS são POSITIVOS. Estornos/créditos/pagamentos recebidos são NEGATIVOS (sinal "-").'
      : '- DÉBITOS (saídas) são NEGATIVOS (ex.: -32.99). CRÉDITOS/RECEITAS (entradas, rendimentos, salário) são POSITIVOS.';
  return [
    `Você é um extrator preciso de transações financeiras. A imagem é ${sourceLabel}, mas` +
      ' pode vir em QUALQUER formato: tabela/lista tradicional, print do app do banco, OU um' +
      ' print de NOTIFICAÇÃO/PUSH avulsa (ex.: "Central de Notificações" do iOS/Android,' +
      ' banner do app, SMS) mostrando UMA ÚNICA transação em texto corrido (ex.: "Feito. Pix' +
      ' enviado. Você enviou R$ 143,10 para MARIA" com "há 1h" no lugar de uma data).',
    'Extraia TODAS as transações visíveis, mesmo que seja APENAS UMA e mesmo que não estejam' +
      ' em formato de tabela. NÃO retorne uma lista vazia só porque a imagem não parece um' +
      ' extrato tradicional — se houver QUALQUER menção a um valor em R$ associado a uma' +
      ' operação financeira (Pix, compra, pagamento, transferência, saque, recebimento), extraia-a.',
    'Para cada transação, retorne:',
    // ponytail: o ano que a IA retornar aqui é DESCARTADO por normalizeDate()
    // (sempre usamos o ano vigente do servidor) — pedimos dia/mês reais e
    // liberamos a IA de "adivinhar" o ano pra não gerar ruído/inconsistência.
    '- "date": data da transação no formato AAAA-MM-DD, com o DIA e MÊS exatamente como aparecem' +
      ' na imagem. Se o ano não aparecer, use "0000" como ano (será ignorado e substituído pelo' +
      ' ano vigente). Se a imagem só tiver uma referência RELATIVA (ex.: "há 1h", "agora",' +
      ' "hoje", "ontem") em vez de uma data explícita, use "0000-00-00" — a transação SEMPRE' +
      ' deve ser retornada mesmo sem data explícita.',
    '- "description": a descrição do lançamento EXATAMENTE como aparece, INCLUINDO o indicador de' +
      ' parcela no formato "k/NN" quando houver (ex.: "Samsung No Itau 18/21"). Em notificações' +
      ' avulsas, use o texto da operação (ex.: "Pix enviado para MARIA").',
    '- "amount": o valor em reais como número (use ponto decimal). ' + signRule,
    'NÃO invente linhas que não existem. NÃO inclua linhas de TOTAL, SALDO, LIMITE, cabeçalhos ou' +
      ' rodapés — mas SEMPRE inclua transações reais, mesmo vindas de um print de notificação avulsa.',
    'Se a imagem indicar os 4 últimos dígitos do cartão, inclua em "cardLast4".',
    'Responda SOMENTE com JSON no formato:',
    '{ "kind": "' + kind + '", "cardLast4": "1234", "rows": [ { "date": "2026-01-08", "description": "Samsung No Itau 18/21", "amount": 114.25 } ] }',
  ].join('\n');
}

function extractJson(text: string): GeminiStatementResult | null {
  let jsonStr = '';
  const block = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (block) {
    jsonStr = block[1].trim();
  } else {
    const match = text.match(/\{[\s\S]*"rows"[\s\S]*\}/);
    jsonStr = match ? match[0] : '';
  }
  if (!jsonStr) return null;
  jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1').replace(/[\u0000-\u001f]/g, ' ');
  try {
    return JSON.parse(jsonStr) as GeminiStatementResult;
  } catch {
    // Repara JSON truncado por MAX_TOKENS
    let repaired = jsonStr.replace(/,\s*[^}\]]*$/, '');
    const ob = (repaired.match(/\{/g) || []).length;
    const cb = (repaired.match(/\}/g) || []).length;
    const oq = (repaired.match(/\[/g) || []).length;
    const cq = (repaired.match(/\]/g) || []).length;
    for (let i = 0; i < oq - cq; i++) repaired += ']';
    for (let i = 0; i < ob - cb; i++) repaired += '}';
    try {
      return JSON.parse(repaired) as GeminiStatementResult;
    } catch {
      return null;
    }
  }
}

export async function imageToStatementRows(
  buffer: Buffer,
  mimeType: string,
  kind: StatementKind,
): Promise<GeminiStatementResult> {
  const apiKey = process.env['GEMINI_API_KEY'];
  if (!apiKey) {
    throw new ImageOcrError(
      'Leitura por imagem indisponível: a chave da IA (GEMINI_API_KEY) não está configurada no servidor.',
    );
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
  // ponytail: fetch() rejeita (timeout/DNS/reset) SEM nunca chegar ao
  // `!response.ok` abaixo — sem este try/catch esse erro genérico escapava
  // do ImageOcrError, driblava os catches específicos do controller e virava
  // um 500 puro pro usuário. Fotos reais de câmera (maiores/mais lentas que
  // um print) batem nisso com frequência bem maior que os testes com prints.
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: buildPrompt(kind) },
              { inline_data: { mime_type: mimeType, data: buffer.toString('base64') } },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 16384,
          responseMimeType: 'application/json',
        },
      }),
      signal: AbortSignal.timeout(90000),
    });
  } catch (err) {
    const errName = (err as { name?: string })?.name;
    const isTimeout = errName === 'TimeoutError' || errName === 'AbortError';
    throw new ImageOcrError(
      isTimeout
        ? 'A leitura da imagem demorou demais e foi cancelada. Tente novamente ou use uma foto mais leve.'
        : 'Não consegui me conectar ao serviço de leitura de imagem agora. Tente novamente em instantes.',
    );
  }

  if (!response.ok) {
    throw new ImageOcrError(
      `Não consegui ler a imagem agora (IA retornou ${response.status}). Tente novamente em instantes.`,
    );
  }

  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new ImageOcrError('A IA retornou uma resposta inválida ao ler a imagem. Tente novamente.');
  }
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const parsed = extractJson(text);
  if (!parsed || !Array.isArray(parsed.rows)) return { kind, rows: [] };
  return { kind, cardLast4: parsed.cardLast4, rows: parsed.rows };
}

// ─── Orquestração: imagem → ParseResult (reuso total dos parsers de texto) ───

function buildExternalIds(idForExternal: string, txs: NormalizedTx[]): NormalizedTx[] {
  const withOrd = assignOrdinals(txs);
  return withOrd.map((t) => ({
    externalId: makeExternalId({
      cardId: idForExternal,
      date: t.date,
      merchant: t.merchant,
      amountCents: t.amountCents,
      ordinal: t._ordinal,
    }),
    date: t.date,
    merchant: t.merchant,
    amountCents: t.amountCents,
    installmentCurrent: t.installmentCurrent,
    installmentTotal: t.installmentTotal,
    isFuture: t.isFuture,
  }));
}

/** Fatura de cartão a partir de imagem. */
export async function parseImageStatement(
  buffer: Buffer,
  mimeType: string,
  cardId: string,
): Promise<ParseResult> {
  const { rows } = await imageToStatementRows(buffer, mimeType, 'invoice');
  const text = rowsToStatementText(rows);
  const fallbackYear = new Date().getUTCFullYear();
  const { current, future } = extractTransactionsFromText(text, fallbackYear);

  const transactions = buildExternalIds(cardId, current);
  const futureInstallments = buildExternalIds(cardId, future);
  const totalAmountCents = transactions
    .filter((t) => t.amountCents > 0)
    .reduce((s, t) => s + t.amountCents, 0);

  return {
    source: 'IMAGE',
    periodLabel: inferPeriodLabel(transactions),
    transactions,
    totalAmountCents,
    futureInstallments,
  };
}

/** Extrato bancário a partir de imagem. */
export async function parseImageBankStatement(
  buffer: Buffer,
  mimeType: string,
  accountId: string,
): Promise<ParseResult> {
  const { rows } = await imageToStatementRows(buffer, mimeType, 'statement');
  const text = rowsToStatementText(rows);
  const fallbackYear = new Date().getUTCFullYear();
  const raw = extractBankTransactionsFromText(text, fallbackYear);

  const transactions = buildExternalIds(accountId, raw);
  const totalAmountCents = transactions
    .filter((t) => t.amountCents > 0)
    .reduce((s, t) => s + t.amountCents, 0);

  return {
    source: 'IMAGE',
    periodLabel: inferPeriodLabel(transactions),
    transactions,
    totalAmountCents,
  };
}
