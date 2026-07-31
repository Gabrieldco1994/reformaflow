/**
 * OCR de COMPROVANTE ÚNICO (cupom fiscal, print de PIX, foto de recibo) via
 * Gemini Vision — extrai UMA despesa, não uma lista.
 *
 * Distinto de `credit-card/parsers/image-ocr.ts`, que lê fatura/extrato e
 * devolve N lançamentos para conferência em lista. Aqui o usuário fotografa um
 * comprovante e confirma UMA despesa no mesmo modal que o fluxo de voz já usa
 * (valor, categoria e título editáveis antes de salvar).
 *
 * Nada é gravado por este módulo: ele só interpreta a imagem. Quem salva é o
 * fluxo normal de criação de despesa, depois da confirmação do usuário — mesma
 * garantia do caminho de voz.
 */
import { ImageOcrError } from '../credit-card/parsers/image-ocr';

const GEMINI_MODEL = 'gemini-2.5-flash';

/** Uma despesa lida do comprovante, ainda NÃO persistida. */
export interface ReceiptScanResult {
  /** Valor total em centavos. `null` = não identificado na imagem. */
  valorCents: number | null;
  /** Estabelecimento/recebedor, como impresso. */
  fornecedor: string | null;
  /** Descrição curta do que foi comprado. */
  descricao: string | null;
  /** 'YYYY-MM-DD'. `null` = não identificada (o front cai em hoje). */
  data: string | null;
}

const PROMPT = `Você recebe a foto de UM comprovante de pagamento brasileiro: cupom fiscal, recibo, print de PIX, print de transferência ou tela de confirmação de compra.

Extraia os dados desta ÚNICA transação e devolva SOMENTE JSON no formato:
{"valor": "123.45", "fornecedor": "nome do estabelecimento", "descricao": "o que foi comprado", "data": "AAAA-MM-DD"}

Regras:
- "valor": o valor TOTAL pago, com ponto como separador decimal. Se houver "TOTAL", "VALOR TOTAL" ou "VALOR PAGO", use esse — nunca o subtotal, nunca o troco, nunca uma parcela isolada.
- "fornecedor": o nome do estabelecimento (cupom) ou de quem recebeu (PIX/transferência).
- "descricao": resumo curto do que foi comprado. Se o comprovante listar vários itens, resuma (ex.: "compras de mercado"). Se não der para saber, use o nome do estabelecimento.
- "data": a data da transação impressa no comprovante.
- Campo que você NÃO conseguir ler com confiança: devolva null. NUNCA invente valor, data ou nome.
- Se a imagem não for um comprovante de pagamento, devolva todos os campos como null.`;

/** Centavos a partir do que a IA devolveu, tolerante a "1.234,56" e "1234.56". */
export function toCents(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw > 0 ? Math.round(raw * 100) : null;
  }
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/[^\d.,-]/g, '');
  if (!cleaned) return null;
  // "1.234,56" (pt-BR) → o último separador é o decimal; "1234.56" → ponto decimal.
  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  let normalized = cleaned;
  if (lastComma > lastDot) normalized = cleaned.replace(/\./g, '').replace(',', '.');
  else if (lastDot > lastComma) normalized = cleaned.replace(/,/g, '');
  const value = Number(normalized);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
}

export function toIsoDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  // Tolera "DD/MM/AAAA", formato da maioria dos cupons brasileiros.
  const br = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return null;
}

export function toText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null') return null;
  return trimmed.slice(0, 120);
}

/** Extrai o primeiro objeto JSON do texto, tolerando cercas de markdown. */
export function extractReceiptJson(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Converte o JSON cru da IA no resultado tipado. Separado para ser testável sem rede. */
export function normalizeReceiptScan(parsed: Record<string, unknown> | null): ReceiptScanResult {
  if (!parsed) return { valorCents: null, fornecedor: null, descricao: null, data: null };
  return {
    valorCents: toCents(parsed['valor']),
    fornecedor: toText(parsed['fornecedor']),
    descricao: toText(parsed['descricao']),
    data: toIsoDate(parsed['data']),
  };
}

/**
 * Lê um comprovante e devolve os campos de UMA despesa.
 *
 * O tratamento de erro espelha `imageToStatementRows`: `fetch` rejeita
 * (timeout/DNS/reset) SEM chegar ao `!response.ok`, e sem o try/catch isso
 * escapa como 500 puro. Foto de câmera é maior e mais lenta que print, e bate
 * nesse caminho com frequência bem maior do que os testes sugerem.
 */
export async function scanReceiptImage(
  buffer: Buffer,
  mimeType: string,
): Promise<ReceiptScanResult> {
  const apiKey = process.env['GEMINI_API_KEY'];
  if (!apiKey) {
    throw new ImageOcrError(
      'Leitura por imagem indisponível: a chave da IA (GEMINI_API_KEY) não está configurada no servidor.',
    );
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: PROMPT },
              { inline_data: { mime_type: mimeType, data: buffer.toString('base64') } },
            ],
          },
        ],
        // Um comprovante é resposta curta: 2K basta e reduz a espera.
        // (Os thinking tokens do 2.5-flash contam para este limite.)
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 2048,
          responseMimeType: 'application/json',
        },
      }),
      signal: AbortSignal.timeout(60000),
    });
  } catch (err) {
    const errName = (err as { name?: string })?.name;
    const isTimeout = errName === 'TimeoutError' || errName === 'AbortError';
    throw new ImageOcrError(
      isTimeout
        ? 'A leitura da foto demorou demais e foi cancelada. Tente novamente ou use uma foto mais leve.'
        : 'Não consegui me conectar ao serviço de leitura de imagem agora. Tente novamente em instantes.',
    );
  }

  if (!response.ok) {
    throw new ImageOcrError(
      `Não consegui ler a foto agora (IA retornou ${response.status}). Tente novamente em instantes.`,
    );
  }

  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new ImageOcrError('A IA retornou uma resposta inválida ao ler a foto. Tente novamente.');
  }

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  // Sem JSON válido devolvemos o resultado vazio em vez de lançar: o usuário
  // cai no modal com os campos em branco e digita — melhor que um erro que
  // descarta a foto e obriga a refazer tudo.
  return normalizeReceiptScan(extractReceiptJson(text));
}
