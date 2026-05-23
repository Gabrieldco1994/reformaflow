import { ExpenseType, PaymentForm, ExpenseStatus } from '../enums';

export interface ParsedVoiceExpense {
  tipoDespesa: ExpenseType;
  valor: number | null;
  formaPagamento: PaymentForm;
  status: ExpenseStatus;
  dataReferencia: string;
  quantidadeParcela: number | null;
  titulo: string;
}

export interface ParseVoiceExpenseInput {
  transcript: string;
  allowedExpenseTypes: ExpenseType[];
  defaultExpenseType: ExpenseType;
  now?: Date;
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
  };
}
