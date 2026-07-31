import type {
  PersistedJourney,
  PersistedJourneyStep,
  PersistedJourneyTrigger,
} from '../config/journey-plan';
import type { JourneyRepeatPolicy, JourneyTriggerType } from '../config/journey-catalog';

/**
 * Builders MÍNIMOS de fixture de Jornada (Etapa D do épico #338).
 *
 * Existem por causa de uma regra do plano: nenhum teste de fluxo pode codificar
 * quantidade, posição ou nome dos passos de uma jornada publicada. Trocar uma
 * jornada de 4 para 6 etapas, reordenar, desligar um passo ou trocar Resumida
 * por Completa NÃO pode quebrar um teste por expectativa antiga. Para isso, o
 * teste precisa CONSTRUIR a configuração que ele mesmo vai percorrer — daí os
 * builders — em vez de importar uma lista estática do catálogo default.
 *
 * Ficam em `src/testing/` (e não em `__tests__/`) porque são consumidos por
 * três runners diferentes: vitest no domínio, jest na API e vitest no web.
 * São dado puro: nenhum import de framework de teste.
 *
 * NÃO são exportados pelo barrel `@reformaflow/domain`: mantêm uma sequência
 * mutável de ids (`resetJourneyBuilderSequence`) e não são API de produção.
 * Os testes importam este módulo pelo caminho direto, cada pacote pelo caminho
 * que ele já usa para consumir o domínio:
 *
 *   - domínio: `../src/testing/journey-builders` (relativo);
 *   - web:     `@reformaflow/domain/testing/journey-builders` (fonte, como o
 *              alias do vitest e o `paths` do tsconfig já resolvem);
 *   - API:     `@reformaflow/domain/dist/testing/journey-builders` (compilado —
 *              `apps/api` fixa `rootDir: ./src` e importar `.ts` de fora dá
 *              TS6059).
 */

let seq = 0;

/** Reinicia o contador de ids autogerados — chame em `beforeEach` se precisar de ids estáveis. */
export function resetJourneyBuilderSequence(): void {
  seq = 0;
}

function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

export interface MakeStepOptions extends Partial<PersistedJourneyStep> {}

/**
 * Um passo persistido, com defaults de produto (habilitado, pulável, FULL).
 * `order` cai no índice implícito quando o chamador não se importa com ordem.
 */
export function makeStep(options: MakeStepOptions = {}): PersistedJourneyStep {
  const stepKey = options.stepKey ?? nextId('step');
  return {
    stepKey,
    order: options.order ?? 0,
    enabled: options.enabled ?? true,
    skippable: options.skippable ?? true,
    experience: options.experience ?? 'FULL',
    label: options.label ?? stepKey,
    subtitle: options.subtitle ?? null,
  };
}

/**
 * `count` passos sequenciais já ordenados. O ponto central da suíte dinâmica:
 * `makeSteps(4)` e `makeSteps(6)` produzem jornadas de tamanhos diferentes sem
 * que nenhum teste precise conhecer o número.
 */
export function makeSteps(count: number, decorate: (index: number) => MakeStepOptions = () => ({})): PersistedJourneyStep[] {
  return Array.from({ length: count }, (_, index) =>
    makeStep({ stepKey: `step-${index + 1}`, order: index, ...decorate(index) }),
  );
}

export interface MakeTriggerOptions extends Partial<PersistedJourneyTrigger> {}

export function makeTrigger(options: MakeTriggerOptions = {}): PersistedJourneyTrigger {
  const triggerType: JourneyTriggerType = options.triggerType ?? 'PROJECT_CREATED';
  return {
    triggerType,
    screenKey: options.screenKey ?? null,
    actionKey: options.actionKey ?? null,
    device: options.device ?? 'any',
    active: options.active ?? true,
  };
}

export interface MakeJourneyOptions extends Partial<Omit<PersistedJourney, 'steps' | 'triggers'>> {
  steps?: PersistedJourneyStep[];
  triggers?: PersistedJourneyTrigger[];
  /** Atalho: `stepCount: 6` gera 6 passos sequenciais sem montar o array à mão. */
  stepCount?: number;
}

export function makeJourney(options: MakeJourneyOptions = {}): PersistedJourney {
  const key = options.key ?? nextId('journey');
  const steps =
    options.steps ?? (typeof options.stepCount === 'number' ? makeSteps(options.stepCount) : makeSteps(1));

  const repeatPolicy: JourneyRepeatPolicy = options.repeatPolicy ?? 'ONCE_PER_USER';

  return {
    key,
    name: options.name ?? key,
    active: options.active ?? true,
    targetScope: options.targetScope ?? 'ALL_PROJECTS',
    targetProjectType: options.targetProjectType ?? null,
    targetProjectId: options.targetProjectId ?? null,
    repeatPolicy,
    allowCrossProjectNavigation: options.allowCrossProjectNavigation ?? false,
    steps,
    triggers: options.triggers ?? [makeTrigger()],
  };
}
