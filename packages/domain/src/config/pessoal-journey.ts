/**
 * PESSOAL journey catalog — passo único `funding` substituindo `bank` + `card`.
 * Fonte de verdade para o wizard de onboarding e o editor de Jornadas (/admin/jornadas).
 */

// ─── Tipos de runtime (transitório — não persistir) ──────────────────────────

export type FundingKind = 'bankAccount' | 'creditCard';
export type FundingOrigin = 'existing' | 'created';

export interface FundingSourceRef {
  kind: FundingKind;
  id: string;
  ownerProjectId: string;
  origin: FundingOrigin;
}

export interface OnboardingFunding {
  bankAccount: FundingSourceRef | null;
  creditCard: FundingSourceRef | null;
}

// ─── Catálogo de passos ───────────────────────────────────────────────────────

export interface FixedBranch {
  conditionLabel: string;
  ifTrue: string;
  ifFalse: string;
  rejoinsAt: string;
}

export interface JourneyStepDef {
  key: string;
  label: string;
  defaultSubtitle: string;
  alwaysAvailable: boolean;
  skippableByDefault: boolean;
  fixedBranch?: FixedBranch;
}

export const PESSOAL_JOURNEY_CATALOG: JourneyStepDef[] = [
  {
    key: 'funding',
    label: 'Contas & cartões',
    defaultSubtitle: 'Adicione um dos dois, ou os dois.',
    alwaysAvailable: true,
    skippableByDefault: true,
    fixedBranch: {
      conditionLabel: 'Há conta ou cartão?',
      ifTrue: 'A despesa oferece associação e a importação reutiliza a fonte.',
      ifFalse: 'A despesa é salva na Carteira e a importação fica sem fonte.',
      rejoinsAt: 'receipt',
    },
  },
  {
    key: 'expense',
    label: 'Despesa',
    defaultSubtitle: 'Registre um gasto recente.',
    alwaysAvailable: true,
    skippableByDefault: true,
  },
  {
    key: 'import',
    label: 'Importar',
    defaultSubtitle: 'Importe seus lançamentos de uma vez.',
    alwaysAvailable: true,
    skippableByDefault: true,
  },
  {
    key: 'receipt',
    label: 'Recebimento',
    defaultSubtitle: 'Registre uma entrada já realizada.',
    alwaysAvailable: true,
    skippableByDefault: true,
  },
];

// ─── Folding legado (bank + card → funding) ───────────────────────────────────

export interface StepOverride {
  key: string;
  order?: number;
  enabled?: boolean;
  skippable?: boolean;
  label?: string;
  subtitle?: string;
}

/**
 * Canonicaliza overrides persistidos: `funding` explícito vence; caso
 * contrário, sintetiza a partir de `bank`/`card` conforme a issue #320.
 * Regras:
 * - order = min(bank.order, card.order)
 * - enabled = bank.enabled || card.enabled
 * - skippable = bank.skippable && card.skippable
 * - label/subtitle: primeiro override não-vazio entre os habilitados (bank antes de card)
 * - linhas legadas (bank/card) são descartadas da saída
 */
export function foldLegacyStepOverrides(overrides: StepOverride[]): StepOverride[] {
  const hasFunding = overrides.some((o) => o.key === 'funding');
  if (hasFunding) {
    // funding explícito vence — descarta legados
    return overrides.filter((o) => o.key !== 'bank' && o.key !== 'card');
  }

  const bank = overrides.find((o) => o.key === 'bank');
  const card = overrides.find((o) => o.key === 'card');
  if (!bank && !card) return overrides;

  const rest = overrides.filter((o) => o.key !== 'bank' && o.key !== 'card');

  const bankOrder = bank?.order ?? Infinity;
  const cardOrder = card?.order ?? Infinity;
  const order = Math.min(bankOrder, cardOrder);

  // enabled: OR; skippable: AND (missing = defaults from catalog)
  const enabled = (bank?.enabled ?? false) || (card?.enabled ?? false);
  const skippable = (bank?.skippable ?? true) && (card?.skippable ?? true);

  // label/subtitle: first non-empty among enabled overrides, bank before card
  const preferred = [bank, card].find((o) => o?.enabled !== false && (o?.label || o?.subtitle));
  const label = preferred?.label;
  const subtitle = preferred?.subtitle;

  const synthesized: StepOverride = {
    key: 'funding',
    ...(isFinite(order) ? { order } : {}),
    enabled,
    skippable,
    ...(label ? { label } : {}),
    ...(subtitle ? { subtitle } : {}),
  };

  return [...rest, synthesized];
}
