import { ProjectType } from '../enums';
import {
  JOURNEY_CATALOG,
  onboardingJourneyKey,
  resolveJourneySteps,
  type JourneyStepDefinition,
  type JourneyStepOverride,
  type ResolvedJourneyStep,
} from './journey-catalog';

/**
 * ADAPTADOR DE COMPATIBILIDADE — jornada de onboarding sobre o catálogo
 * genérico (`journey-catalog.ts`).
 *
 * Por que este arquivo continua existindo em vez de tudo migrar direto pro
 * catálogo genérico: a API (`OnboardingJourneyService`) e o web
 * (`useJourney`) importam `ONBOARDING_JOURNEY_DEFAULTS` e `resolveJourney`
 * por tipo de projeto (`ProjectType`) — essa é a forma que os dois lados já
 * conhecem e persistem (`OnboardingJourneyStep.projectType`). O catálogo
 * genérico já modela essas mesmas jornadas por baixo (chave
 * `onboarding:<PROJECT_TYPE>`); este arquivo só reexpõe o formato antigo,
 * SEM duplicar dado — `ONBOARDING_JOURNEY_DEFAULTS[t]` é a MESMA referência
 * de array que `JOURNEY_CATALOG[onboardingJourneyKey(t)].steps`. Qualquer
 * alteração de passo/tela acontece em `journey-catalog.ts`.
 *
 * Divisão de responsabilidade:
 * - `journey-catalog.ts`: quais jornadas existem, seus passos e gatilhos.
 * - Este arquivo: fatia "onboarding por tipo de projeto" + a regra legada
 *   ponytail (expense-import desliga expense/import) que só faz sentido
 *   aqui, não no motor genérico.
 * - Banco (`OnboardingJourneyStep`): os overrides que o admin salvou.
 * - `steps-config.ts` (web): `key → Componente`. Nada de ordem/texto lá.
 */

/** Telas que o admin NÃO pode reordenar nem desligar (bookends do fluxo). */
export const ONBOARDING_FIXED_STEPS = ['project', 'done'] as const;

// ─── Tipos de runtime do passo `funding` (transitório — não persistir) ───────

export type FundingKind = 'bankAccount' | 'creditCard';
export type FundingOrigin = 'existing' | 'created';

export interface FundingSourceRef {
  kind: FundingKind;
  id: string;
  ownerProjectId: string;
  origin: FundingOrigin;
}

/** Estado transitório do passo `funding` — vive só no ciclo de vida do wizard. */
export interface OnboardingFunding {
  bankAccount: FundingSourceRef | null;
  creditCard: FundingSourceRef | null;
}

/** Alias de compatibilidade — mesmo shape de `JourneyStepDefinition`. */
export type JourneyStepDef = JourneyStepDefinition;

export type { JourneyStepOverride, ResolvedJourneyStep };

/**
 * Jornada padrão por tipo de projeto, na ordem em que nasce.
 * Derivada do catálogo genérico (`JOURNEY_CATALOG[onboardingJourneyKey(tipo)]`)
 * — mesma referência de array, sem cópia.
 */
export const ONBOARDING_JOURNEY_DEFAULTS: Record<ProjectType, JourneyStepDef[]> = Object.values(
  ProjectType,
).reduce(
  (acc, projectType) => {
    acc[projectType] = JOURNEY_CATALOG[onboardingJourneyKey(projectType)]?.steps ?? [];
    return acc;
  },
  {} as Record<ProjectType, JourneyStepDef[]>,
);

/**
 * Aplica os overrides do admin sobre o catálogo padrão de um tipo de projeto.
 * Delega a mecânica de resolução para `resolveJourneySteps` (genérica) e só
 * acrescenta a regra legada específica do onboarding PESSOAL.
 */
export function resolveJourney(
  projectType: ProjectType,
  overrides: JourneyStepOverride[] = [],
): ResolvedJourneyStep[] {
  const resolved = resolveJourneySteps(ONBOARDING_JOURNEY_DEFAULTS[projectType] ?? [], overrides);

  // ponytail: PESSOAL: se expense-import está habilitado, desabilita expense + import separados (evita redundância)
  if (projectType === ProjectType.PESSOAL) {
    const hasExpenseImport = resolved.some((s) => s.key === 'expense-import' && s.enabled);
    if (hasExpenseImport) {
      return resolved.map((s) =>
        (s.key === 'expense' || s.key === 'import') && s.enabled ? { ...s, enabled: false } : s,
      );
    }
  }

  return resolved;
}
