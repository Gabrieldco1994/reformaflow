// FinancialItemCardV1 — contrato canônico do card financeiro (issue #452).
// Fonte única de verdade para backend e frontend.

/**
 * Shape padronizada de um item financeiro para renderização em card/detalhe.
 * Aditiva: estende as entries existentes sem substituir campos legados.
 */
export interface FinancialItemCardV1 {
  id: string;
  kind: 'expense' | 'receipt' | 'invoice';
  origin: string;
  originProjectId: string;
  originProjectName: string;
  purpose: string;
  purposeLabel: string;
  amountCents: number;
  date: string;
  status: string;
  title: string | null;
  supplier: string | null;
  installment: string | null;
  paymentForm: string | null;
  relationship: { cardLast4: string | null; bankLast4: string | null } | null;
  hasEvidence: boolean;
  actions: Array<{ actionId: string }>;
  isEspelho: boolean;
  isNeutral: boolean;
}

/** Keys banned from wire payloads — internal paths / import refs. */
const BANNED_KEY_RE = /^(url|path|filePath|fileUrl|fileName|importId)$/i;

/**
 * Runtime assertion that a value satisfies the FinancialItemCardV1 shape.
 * Throws on violation — designed for contract tests, not production hot-path.
 */
export function assertFinancialItemCardV1Shape(v: unknown): asserts v is FinancialItemCardV1 {
  if (v == null || typeof v !== 'object') {
    throw new Error('FinancialItemCardV1: value must be a non-null object');
  }

  const obj = v as Record<string, unknown>;

  // Required string fields
  for (const key of [
    'id', 'kind', 'origin', 'originProjectId', 'originProjectName',
    'purpose', 'purposeLabel', 'date', 'status',
  ] as const) {
    if (typeof obj[key] !== 'string') {
      throw new Error(`FinancialItemCardV1: "${key}" must be a string, got ${typeof obj[key]}`);
    }
  }

  // amountCents: integer >= 0
  if (typeof obj.amountCents !== 'number' || !Number.isInteger(obj.amountCents) || obj.amountCents < 0) {
    throw new Error(
      `FinancialItemCardV1: "amountCents" must be a non-negative integer, got ${String(obj.amountCents)}`,
    );
  }

  // Nullable string fields
  for (const key of ['title', 'supplier', 'installment', 'paymentForm'] as const) {
    if (obj[key] !== null && typeof obj[key] !== 'string') {
      throw new Error(`FinancialItemCardV1: "${key}" must be string | null`);
    }
  }

  // relationship
  if (obj.relationship !== null) {
    if (typeof obj.relationship !== 'object') {
      throw new Error('FinancialItemCardV1: "relationship" must be object | null');
    }
    const rel = obj.relationship as Record<string, unknown>;
    if ((rel.cardLast4 !== null && typeof rel.cardLast4 !== 'string') ||
        (rel.bankLast4 !== null && typeof rel.bankLast4 !== 'string')) {
      throw new Error('FinancialItemCardV1: relationship fields must be string | null');
    }
  }

  // hasEvidence: strict boolean
  if (typeof obj.hasEvidence !== 'boolean') {
    throw new Error(
      `FinancialItemCardV1: "hasEvidence" must be a boolean, got ${typeof obj.hasEvidence}`,
    );
  }

  // actions: array of {actionId: string}
  if (!Array.isArray(obj.actions)) {
    throw new Error('FinancialItemCardV1: "actions" must be an array');
  }
  for (const a of obj.actions) {
    if (a == null || typeof a !== 'object' || typeof (a as Record<string, unknown>).actionId !== 'string') {
      throw new Error('FinancialItemCardV1: each action must be { actionId: string }');
    }
  }

  // isEspelho, isNeutral: boolean
  for (const key of ['isEspelho', 'isNeutral'] as const) {
    if (typeof obj[key] !== 'boolean') {
      throw new Error(`FinancialItemCardV1: "${key}" must be a boolean`);
    }
  }

  // Banned keys (no internal paths/refs leak)
  for (const key of Object.keys(obj)) {
    if (BANNED_KEY_RE.test(key)) {
      throw new Error(`FinancialItemCardV1: banned key "${key}" must not appear in payload`);
    }
  }
}
