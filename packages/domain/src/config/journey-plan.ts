import { ProjectType } from '../enums';
import type {
  JourneyRepeatPolicy,
  JourneyStepExperience,
  JourneyTriggerType,
} from './journey-catalog';

/**
 * MOTOR DE PLANO DE JORNADA (Etapa D do épico #338).
 *
 * Dada UMA jornada já persistida (a configuração que o admin salvou), decide
 * quais passos realmente rodam, em que ordem, e como o progresso é contado.
 * É o ÚNICO lugar onde essa regra existe: a API devolve a configuração crua em
 * `GET /journeys/eligible`, o executor web e os testes E2E chamam esta função.
 * Nenhum consumidor reimplementa "quais passos rodam" — a razão de o plano
 * exigir testes dirigidos por configuração é justamente essa: trocar uma
 * jornada de 4 para 6 etapas não pode exigir mudança de código em lugar nenhum.
 *
 * Fronteira: este arquivo NÃO decide QUAIS jornadas disparam (alvo, gatilho,
 * dispositivo, política de repetição, conclusões). Isso é do
 * `JourneysEligibilityService` na API, que tem tenant/usuário/banco em mãos.
 * Os campos de alvo/repetição aparecem aqui só porque fazem parte da jornada
 * persistida que trafega — nunca são reavaliados como regra de elegibilidade.
 */

export type JourneyTargetScope = 'ALL_PROJECTS' | 'PROJECT_TYPE' | 'PROJECT';

/** O que fazer quando a `conditionKey` da etapa não está satisfeita. */
export type JourneyConditionUnmetBehavior = 'SKIP' | 'BLOCK';

/** Um passo como está salvo no banco (`JourneyStep`), antes de qualquer regra. */
export interface PersistedJourneyStep {
  stepKey: string;
  order: number;
  enabled: boolean;
  skippable: boolean;
  experience: JourneyStepExperience;
  label: string | null;
  subtitle: string | null;
  /** `null` = etapa incondicional. */
  conditionKey: string | null;
  conditionUnmetBehavior: JourneyConditionUnmetBehavior;
  /** `null` = roda no projeto atual. Preenchido = etapa cross-project. */
  targetProjectType: ProjectType | null;
}

/** Um gatilho como está salvo no banco (`JourneyTrigger`), na parte que trafega. */
export interface PersistedJourneyTrigger {
  triggerType: JourneyTriggerType;
  screenKey: string | null;
  actionKey: string | null;
  device: 'web' | 'mobile' | 'any';
  active: boolean;
}

/** Uma jornada persistida inteira, como o executor a recebe. */
export interface PersistedJourney {
  key: string;
  name: string;
  active: boolean;
  targetScope: JourneyTargetScope;
  targetProjectType: ProjectType | null;
  targetProjectId: string | null;
  repeatPolicy: JourneyRepeatPolicy;
  allowCrossProjectNavigation: boolean;
  steps: PersistedJourneyStep[];
  triggers: PersistedJourneyTrigger[];
}

export interface JourneyPlanContext {
  /**
   * Condições satisfeitas AGORA. Chave ausente = NÃO satisfeita (fail-safe:
   * um runtime que ainda não sabe responder nunca "libera" uma etapa por
   * omissão).
   */
  conditions?: Record<string, boolean>;
  /**
   * `stepKey`s que o executor sabe renderizar. `undefined` = aceita tudo (o
   * caso da API, que não conhece componentes). Uma chave fora desta lista é
   * ignorada com aviso em vez de derrubar a jornada inteira.
   */
  knownStepKeys?: readonly string[];
  /** Tipo do projeto em que a jornada está rodando, quando há um. */
  currentProjectType?: ProjectType | null;
}

export type JourneyPlanWarningCode = 'UNKNOWN_STEP_KEY' | 'CROSS_PROJECT_NOT_ALLOWED';

export interface JourneyPlanWarning {
  code: JourneyPlanWarningCode;
  stepKey: string;
}

/** Um passo que de fato vai rodar, já posicionado dentro do plano. */
export interface PlannedJourneyStep {
  stepKey: string;
  order: number;
  /** 1-based dentro do plano — já descontando desligados/SKIPados. */
  position: number;
  skippable: boolean;
  experience: JourneyStepExperience;
  label: string | null;
  subtitle: string | null;
  targetProjectType: ProjectType | null;
  /** `true` = condição BLOCK não satisfeita: aparece, mas aguarda. */
  blocked: boolean;
}

export interface JourneyPlan {
  steps: PlannedJourneyStep[];
  /** Denominador do progresso. Sempre `steps.length` — nunca um literal. */
  total: number;
  warnings: JourneyPlanWarning[];
}

function isConditionMet(step: PersistedJourneyStep, ctx: JourneyPlanContext): boolean {
  if (!step.conditionKey) return true;
  return ctx.conditions?.[step.conditionKey] === true;
}

/**
 * Aplica, nesta ordem: desligados fora → chave órfã fora (aviso) →
 * cross-project proibido fora (aviso) → condição SKIP não satisfeita fora.
 * Só então numera as posições, para o denominador do progresso já nascer certo.
 */
export function resolveJourneyPlan(
  journey: PersistedJourney,
  ctx: JourneyPlanContext = {},
): JourneyPlan {
  const warnings: JourneyPlanWarning[] = [];
  const known = ctx.knownStepKeys ? new Set(ctx.knownStepKeys) : null;
  const currentProjectType = ctx.currentProjectType ?? null;

  const ordered = journey.steps
    .map((step, index) => ({ step, index }))
    .sort((a, b) => a.step.order - b.step.order || a.index - b.index);

  const steps: PlannedJourneyStep[] = [];

  for (const { step } of ordered) {
    if (!step.enabled) continue;

    if (known && !known.has(step.stepKey)) {
      warnings.push({ code: 'UNKNOWN_STEP_KEY', stepKey: step.stepKey });
      continue;
    }

    const isCross =
      step.targetProjectType !== null &&
      currentProjectType !== null &&
      step.targetProjectType !== currentProjectType;

    if (isCross && !journey.allowCrossProjectNavigation) {
      warnings.push({ code: 'CROSS_PROJECT_NOT_ALLOWED', stepKey: step.stepKey });
      continue;
    }

    const met = isConditionMet(step, ctx);
    if (!met && step.conditionUnmetBehavior === 'SKIP') continue;

    steps.push({
      stepKey: step.stepKey,
      order: step.order,
      position: steps.length + 1,
      skippable: step.skippable,
      experience: step.experience,
      label: step.label,
      subtitle: step.subtitle,
      targetProjectType: step.targetProjectType,
      blocked: !met,
    });
  }

  return { steps, total: steps.length, warnings };
}

export interface JourneyProgress {
  position: number;
  total: number;
  /** `position / total`, com 0 (nunca NaN) para plano vazio. */
  ratio: number;
}

export function journeyProgress(plan: JourneyPlan, index: number): JourneyProgress {
  if (plan.total === 0) return { position: 0, total: 0, ratio: 0 };
  const position = Math.min(Math.max(index + 1, 1), plan.total);
  return { position, total: plan.total, ratio: position / plan.total };
}

// ─── Fluxo (Voltar / Continuar / Pular / conclusão) ─────────────────────────
//
// Redutor puro, sem React e sem estado global: o executor web guarda
// `JourneyFlowState` onde quiser (sessionStorage, contexto) e os testes o
// percorrem sem montar componente nenhum.

export interface JourneyFlowState {
  index: number;
  done: boolean;
}

export type JourneyFlowAction = 'next' | 'back' | 'skip';

export function initialJourneyFlowState(plan: JourneyPlan): JourneyFlowState {
  return { index: 0, done: plan.total === 0 };
}

export function currentJourneyStep(
  plan: JourneyPlan,
  state: JourneyFlowState,
): PlannedJourneyStep | null {
  if (state.done) return null;
  return plan.steps[state.index] ?? null;
}

export function advanceJourneyFlow(
  plan: JourneyPlan,
  state: JourneyFlowState,
  action: JourneyFlowAction,
): JourneyFlowState {
  const current = currentJourneyStep(plan, state);
  if (!current) return state;

  if (action === 'back') {
    return state.index === 0 ? state : { index: state.index - 1, done: false };
  }

  // Pular só existe quando a etapa é pulável; etapa bloqueada só avança
  // por Pular (e ainda assim precisa ser pulável).
  if (action === 'skip' && !current.skippable) return state;
  if (action === 'next' && current.blocked) return state;

  const nextIndex = state.index + 1;
  return nextIndex >= plan.total
    ? { index: state.index, done: true }
    : { index: nextIndex, done: false };
}
