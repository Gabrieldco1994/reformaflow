import { ExpenseType, PaymentForm, ExpenseStatus } from '../enums';

export interface VoiceMatchableCard {
  id: string;
  last4: string;
  nickname?: string | null;
  brand?: string | null;
  projectId?: string | null;
}

export interface VoiceMatchableAccount {
  id: string;
  last4?: string | null;
  nickname?: string | null;
  institution?: string | null;
  projectId?: string | null;
}

export interface VoiceMatchableProject {
  id: string;
  name: string;
  type: string;
}

export interface ParsedVoiceExpense {
  tipoDespesa: ExpenseType;
  valor: number | null;
  formaPagamento: PaymentForm;
  status: ExpenseStatus;
  dataReferencia: string;
  quantidadeParcela: number | null;
  titulo: string;
  /** ID do cartão detectado (last4, apelido ou marca). */
  creditCardId: string | null;
  /** ID da conta bancária detectada. */
  bankAccountId: string | null;
  /** ID do projeto destino para vínculo cross-project (ex: "para a reforma"). */
  linkedProjectId: string | null;
}

export interface ParseVoiceExpenseInput {
  transcript: string;
  allowedExpenseTypes: ExpenseType[];
  defaultExpenseType: ExpenseType;
  now?: Date;
  /** Cartões disponíveis no tenant — para vínculo automático ("no Itaú", "no 5868"). */
  cards?: VoiceMatchableCard[];
  /** Contas bancárias do tenant. */
  accounts?: VoiceMatchableAccount[];
  /** Projetos do tenant — para detectar cross-project ("para a reforma", "do carro"). */
  projects?: VoiceMatchableProject[];
  /** ID do projeto atual — usado para excluir auto-link cross para o próprio projeto. */
  currentProjectId?: string;
}

const KEYWORDS: Array<{ type: ExpenseType; keywords: string[] }> = [
  { type: ExpenseType.ALIMENTACAO, keywords: ['mercado', 'supermercado', 'restaurante', 'ifood', 'alimentacao'] },
  { type: ExpenseType.TRANSPORTE, keywords: ['uber', 'combustivel', 'gasolina', 'transporte', 'estacionamento'] },
  { type: ExpenseType.MORADIA, keywords: ['aluguel', 'condominio', 'moradia', 'luz', 'agua', 'internet'] },
  { type: ExpenseType.SAUDE, keywords: ['farmacia', 'medico', 'consulta', 'saude'] },
  { type: ExpenseType.LAZER, keywords: ['cinema', 'viagem', 'lazer', 'show'] },
  { type: ExpenseType.CARTAO_CREDITO, keywords: ['fatura', 'cartao'] },
  { type: ExpenseType.MAO_DE_OBRA, keywords: ['pedreiro', 'eletricista', 'encanador', 'mao de obra'] },
  { type: ExpenseType.MATERIAL_CONSTRUCAO, keywords: ['cimento', 'tinta', 'material', 'construcao'] },
];

function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function parseAmount(normalized: string): number | null {
  const match = normalized
    .replace(/\./g, '')
    .replace(',', '.')
    .match(/(?:r\$?\s*)?(\d+(?:\.\d{1,2})?)(?:\s*reais?)?/i);
  if (!match) return null;
  const amount = Number.parseFloat(match[1] ?? '');
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function parseDate(normalized: string, now: Date): string {
  if (normalized.includes('amanha')) return toIsoDate(addDays(now, 1));
  if (normalized.includes('ontem')) return toIsoDate(addDays(now, -1));
  if (normalized.includes('hoje')) return toIsoDate(now);

  const dayMatch = normalized.match(/\bdia\s+(\d{1,2})\b/);
  if (!dayMatch) return toIsoDate(now);

  const day = Number.parseInt(dayMatch[1] ?? '', 10);
  if (!Number.isFinite(day) || day < 1 || day > 31) return toIsoDate(now);

  const sameMonth = new Date(now.getFullYear(), now.getMonth(), day);
  if (sameMonth.getMonth() === now.getMonth() && sameMonth >= addDays(now, -1)) {
    return toIsoDate(sameMonth);
  }
  return toIsoDate(new Date(now.getFullYear(), now.getMonth() + 1, day));
}

function detectExpenseType(normalized: string, allowedTypes: ExpenseType[], fallback: ExpenseType): ExpenseType {
  for (const type of allowedTypes) {
    const labelToken = normalizeText(type.replaceAll('_', ' '));
    if (labelToken && normalized.includes(labelToken)) return type;
  }
  for (const entry of KEYWORDS) {
    if (!allowedTypes.includes(entry.type)) continue;
    if (entry.keywords.some((keyword) => normalized.includes(keyword))) return entry.type;
  }
  return fallback;
}

function detectPaymentForm(normalized: string): PaymentForm {
  if (normalized.includes('quinzen')) return PaymentForm.QUINZENAL;
  if (/\b\d{1,2}\s*x\b/.test(normalized)) return PaymentForm.PARCELADO;
  if (normalized.includes('parcel') || normalized.includes('cartao') || normalized.includes('credito')) {
    return PaymentForm.PARCELADO;
  }
  return PaymentForm.A_VISTA;
}

function detectStatus(normalized: string): ExpenseStatus {
  return normalized.includes('paguei') || normalized.includes('pago') || normalized.includes('foi pago')
    ? ExpenseStatus.PAGO
    : ExpenseStatus.PLANEJADO;
}

function parseInstallments(normalized: string, payment: PaymentForm): number | null {
  if (payment === PaymentForm.A_VISTA) return null;
  const match = normalized.match(/(\d{1,2})\s*x/);
  return Number.parseInt(match?.[1] ?? '1', 10) || 1;
}

/** Tokens curtos (≥4 letras) presentes em both, ignorando stopwords comuns. */
function tokenMatchScore(haystack: string, needle: string): number {
  if (!needle) return 0;
  const stop = new Set(['cartao', 'conta', 'banco', 'credito', 'debito', 'corrente', 'pessoal']);
  const tokens = needle.split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !stop.has(t));
  if (!tokens.length) return 0;
  let hits = 0;
  for (const t of tokens) if (haystack.includes(t)) hits++;
  return hits;
}

function detectCard(
  normalized: string,
  cards: VoiceMatchableCard[] | undefined,
): string | null {
  if (!cards?.length) return null;
  // 1) Match exato por last4 (4 dígitos no texto)
  const digitMatches = normalized.match(/\b\d{4}\b/g) ?? [];
  for (const digits of digitMatches) {
    const card = cards.find((c) => c.last4 === digits);
    if (card) return card.id;
  }
  // 2) Match por nickname/brand
  let best: { id: string; score: number } | null = null;
  for (const c of cards) {
    const tokens = [c.nickname, c.brand].filter(Boolean).map((s) => normalizeText(String(s)));
    const score = tokens.reduce((acc, t) => acc + tokenMatchScore(normalized, t), 0);
    if (score > 0 && (!best || score > best.score)) best = { id: c.id, score };
  }
  return best?.id ?? null;
}

function detectAccount(
  normalized: string,
  accounts: VoiceMatchableAccount[] | undefined,
): string | null {
  if (!accounts?.length) return null;
  // Heurística: só auto-detecta conta se a frase mencionar débito/pix/transferência/conta — evita
  // confundir com "cartão de crédito".
  const looksLikeAccount =
    /\b(debito|pix|transferencia|transferi|conta corrente|conta poupanca|deposit|saque)\b/.test(
      normalized,
    );
  // Mas se houver match exato por last4, respeita.
  const digitMatches = normalized.match(/\b\d{4}\b/g) ?? [];
  for (const digits of digitMatches) {
    const acc = accounts.find((a) => a.last4 === digits);
    if (acc) return acc.id;
  }
  if (!looksLikeAccount) return null;
  let best: { id: string; score: number } | null = null;
  for (const a of accounts) {
    const tokens = [a.nickname, a.institution].filter(Boolean).map((s) => normalizeText(String(s)));
    const score = tokens.reduce((acc, t) => acc + tokenMatchScore(normalized, t), 0);
    if (score > 0 && (!best || score > best.score)) best = { id: a.id, score };
  }
  return best?.id ?? null;
}

const PROJECT_TYPE_TOKENS: Record<string, string[]> = {
  REFORMA: ['reforma', 'obra'],
  CARRO: ['carro', 'veiculo', 'automovel'],
  CASA: ['casa', 'moradia', 'apartamento'],
  COMPRA: ['compra'],
  PESSOAL: ['pessoal'],
};

function detectLinkedProject(
  normalized: string,
  projects: VoiceMatchableProject[] | undefined,
  currentProjectId?: string,
): string | null {
  if (!projects?.length) return null;
  const candidates = projects.filter((p) => p.id !== currentProjectId);
  if (!candidates.length) return null;

  // 1) Match por nome do projeto (palavra significativa ≥4 chars)
  let best: { id: string; score: number } | null = null;
  for (const p of candidates) {
    const score = tokenMatchScore(normalized, normalizeText(p.name));
    if (score > 0 && (!best || score > best.score)) best = { id: p.id, score };
  }
  if (best) return best.id;

  // 2) Match por tipo ("para a reforma", "do carro"). Só auto-linka se houver
  // exatamente 1 projeto desse tipo entre os candidatos (evita ambiguidade).
  for (const [type, tokens] of Object.entries(PROJECT_TYPE_TOKENS)) {
    if (!tokens.some((t) => new RegExp(`\\b${t}\\b`).test(normalized))) continue;
    const ofType = candidates.filter((p) => p.type === type);
    if (ofType.length === 1) return ofType[0]!.id;
  }
  return null;
}

export function parseVoiceExpense(input: ParseVoiceExpenseInput): ParsedVoiceExpense {
  const normalized = normalizeText(input.transcript);
  const now = input.now ?? new Date();
  const formaPagamento = detectPaymentForm(normalized);

  return {
    tipoDespesa: detectExpenseType(normalized, input.allowedExpenseTypes, input.defaultExpenseType),
    valor: parseAmount(normalized),
    formaPagamento,
    status: detectStatus(normalized),
    dataReferencia: parseDate(normalized, now),
    quantidadeParcela: parseInstallments(normalized, formaPagamento),
    titulo: input.transcript.trim(),
    creditCardId: detectCard(normalized, input.cards),
    bankAccountId: detectAccount(normalized, input.accounts),
    linkedProjectId: detectLinkedProject(normalized, input.projects, input.currentProjectId),
  };
}
