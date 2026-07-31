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

/**
 * Um passo como está salvo no banco (`JourneyStep`), antes de qualquer regra.
 *
 * NÃO tem `conditionKey`/`conditionUnmetBehavior`/`targetProjectType` (por
 * passo): o modelo Prisma `JourneyStep` nunca teve essas três colunas — eram
 * consumidas aqui mas nunca produzidas por nenhum escritor real, então
 * `SKIP`/`BLOCK`/`CROSS_PROJECT_NOT_ALLOWED` nunca disparavam em produção.
 * Removidas (não substituídas) até que uma fatia futura persista a condição
 * de verdade. `crossProject`/`allowCrossProjectNavigation` (nível de JORNADA,
 * não de passo) continuam vivos — ver `PersistedJourney` abaixo.
 */
export interface PersistedJourneyStep {
  stepKey: string;
  order: number;
  enabled: boolean;
  skippable: boolean;
  experience: JourneyStepExperience;
  label: string | null;
  subtitle: string | null;
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
   * `stepKey`s que o executor sabe renderizar. `undefined` = aceita tudo (o
   * caso da API, que não conhece componentes). Uma chave fora desta lista é
   * ignorada com aviso em vez de derrubar a jornada inteira.
   */
  knownStepKeys?: readonly string[];
}

export type JourneyPlanWarningCode = 'UNKNOWN_STEP_KEY';

export interface JourneyPlanWarning {
  code: JourneyPlanWarningCode;
  stepKey: string;
}

/**
 * Um passo que de fato vai rodar, já posicionado dentro do plano.
 *
 * `blocked` fica fixo em `false`: nada no plano bloqueia mais um passo (a
 * única fonte de bloqueio era a `conditionKey`/`conditionUnmetBehavior` por
 * passo, removida por nunca ter sido persistida — ver `PersistedJourneyStep`).
 * O campo continua aqui de propósito porque `journey-runtime-context.tsx`
 * (frente separada) já o lê para desabilitar "Continuar" — dívida deliberada,
 * documentada para follow-up quando aquela frente puder revisitar o contrato.
 */
export interface PlannedJourneyStep {
  stepKey: string;
  order: number;
  /** 1-based dentro do plano — já descontando desligados. */
  position: number;
  skippable: boolean;
  experience: JourneyStepExperience;
  label: string | null;
  subtitle: string | null;
  /** Sempre `false` hoje — ver comentário da interface. */
  blocked: boolean;
}

export interface JourneyPlan {
  steps: PlannedJourneyStep[];
  /** Denominador do progresso. Sempre `steps.length` — nunca um literal. */
  total: number;
  warnings: JourneyPlanWarning[];
}

/**
 * Aplica, nesta ordem: desligados fora → chave órfã fora (aviso). Só então
 * numera as posições, para o denominador do progresso já nascer certo.
 */
export function resolveJourneyPlan(
  journey: PersistedJourney,
  ctx: JourneyPlanContext = {},
): JourneyPlan {
  const warnings: JourneyPlanWarning[] = [];
  const known = ctx.knownStepKeys ? new Set(ctx.knownStepKeys) : null;

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

    steps.push({
      stepKey: step.stepKey,
      order: step.order,
      position: steps.length + 1,
      skippable: step.skippable,
      experience: step.experience,
      label: step.label,
      subtitle: step.subtitle,
      blocked: false,
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
