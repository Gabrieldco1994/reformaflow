import { ProjectType } from '../enums';
import { getProjectNavModules, PROJECT_NAV } from './module-navigator';

/**
 * FUNDAÇÃO GENÉRICA DE JORNADAS (Etapa A do épico #338) — dado puro,
 * compartilhado entre a API (que persiste `Journey`/`JourneyTrigger`/
 * `JourneyStep`/`JourneyCompletion`) e o web (que renderiza os gatilhos).
 *
 * Este arquivo é o sucessor de `onboarding-journey.ts`: onde aquele descrevia
 * "a jornada de onboarding por tipo de projeto" com seu próprio catálogo,
 * este descreve N jornadas (`JourneyDefinition`), cada uma com sua própria
 * chave, passos ordenados (`JourneyStepDefinition`) e gatilhos
 * (`JourneyTriggerDefinition`). O onboarding legado é modelado aqui como as
 * primeiras entradas do catálogo (chave `onboardingJourneyKey(tipo)`), e
 * `onboarding-journey.ts` virou um adaptador fino sobre este catálogo — MESMA
 * referência de array (`ONBOARDING_JOURNEY_DEFAULTS[t] === JOURNEY_CATALOG[..].steps`),
 * nunca uma cópia. Fases futuras acrescentam jornadas novas ao catálogo (tours,
 * alertas, jornadas cross-project) sem tocar nas existentes.
 *
 * Além do catálogo por-jornada, este arquivo expõe os catálogos ESTÁVEIS que
 * o motor de gatilhos genérico (Etapa B+) vai consumir — ainda não ligados a
 * nenhum `JourneyTrigger` persistido nesta PR, mas já testados e prontos:
 * - `JOURNEY_TRIGGER_TYPES` — os 4 tipos de gatilho da Etapa A: pós-cadastro,
 *   pós-criação-de-projeto, visita a uma tela ou execução de uma ação segura.
 * - `JOURNEY_REPEAT_POLICIES` — quantas vezes a jornada pode disparar de novo.
 * - `JOURNEY_STEP_EXPERIENCES` — o quão intrusivo um passo é (resumido vs. completo).
 * - `JOURNEY_SAFE_ACTIONS` — o catálogo estável de tokens `data-journey-action`
 *   que um gatilho `ACTION` pode escutar. Nunca um seletor CSS cru — sempre um
 *   token semântico `substantivo.verbo`.
 * - `GENERIC_JOURNEY_SCREEN_CATALOG` — as telas (`PROJECT_NAV` slugs) que um
 *   gatilho `SCREEN_VISIT` pode mirar, por tipo de projeto. DERIVADO de
 *   `PROJECT_NAV`, nunca duplicado à mão — uma tela nova em `PROJECT_NAV` sem
 *   entrada aqui é pega por `findUncoveredNavRoutes()`.
 *
 * Convenção de chave de jornada: `onboarding:<PROJECT_TYPE>` para as legadas;
 * jornadas novas usam outro prefixo (`tour:`, `alert:` etc.) e podem ter
 * `targetProjectType: null` (jornada global, não amarrada a um tipo).
 */

// ─── Definição de UMA jornada (passos + gatilhos) ───────────────────────────

export interface JourneyStepDefinition {
  /** Id estável — casa com a chave do componente em `steps-config.ts` (web). */
  key: string;
  /** Rótulo curto usado na régua de progresso e no painel do admin. */
  label: string;
  /** Texto de apoio da tela (o admin pode sobrescrever). */
  defaultSubtitle: string;
  /**
   * `false` = a tela só aparece sob condição extra do runtime (ex.: a Maria
   * só existe se a despesa foi criada). O admin ainda pode desligá-la, mas
   * ligá-la não burla a condição.
   */
  alwaysAvailable: boolean;
  /** Default de "pode pular". O admin pode tornar a tela obrigatória. */
  skippableByDefault: boolean;
}

export interface JourneyTriggerDefinition {
  /** `null` = a jornada não é restrita a um tipo de projeto (global). */
  targetProjectType: ProjectType | null;
  /** `null` = não amarrada a um projeto específico (qualquer um do tipo). */
  targetProjectId: string | null;
  /** `true` = pode disparar a partir de um projeto e afetar/apontar para outro. */
  crossProject: boolean;
  device: JourneyDevice;
  /**
   * MESMO vocabulário que `JOURNEY_REPEAT_POLICIES` (abaixo) — o valor
   * persistido cru na coluna `JourneyTrigger.repeatPolicy`, nunca um
   * sinônimo.
   */
  repeatPolicy: JourneyRepeatPolicy;
  dismissPolicy: JourneyDismissPolicy;
}

export interface JourneyDefinition {
  /** Chave estável do catálogo — casa com `Journey.key` no banco. */
  key: string;
  name: string;
  description: string;
  steps: JourneyStepDefinition[];
  triggers: JourneyTriggerDefinition[];
}

// ─── Overrides do admin + resolução (mecânica genérica, compartilhada) ─────

/** Override vindo do banco. Campos ausentes caem no default do catálogo. */
export interface JourneyStepOverride {
  stepKey: string;
  order?: number | null;
  enabled?: boolean | null;
  skippable?: boolean | null;
  label?: string | null;
  subtitle?: string | null;
}

/** Um passo já com os overrides do admin aplicados. */
export interface ResolvedJourneyStep {
  key: string;
  label: string;
  subtitle: string;
  enabled: boolean;
  /** `false` = tela obrigatória: o wizard não oferece "pular". */
  skippable: boolean;
  alwaysAvailable: boolean;
}

function normalizeText(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Aplica os overrides do admin sobre os passos default de UMA jornada.
 * Mecânica compartilhada por todo consumidor de catálogo (onboarding hoje,
 * jornadas genéricas amanhã).
 *
 * Regras (existem para nenhuma jornada quebrar por causa de configuração):
 * 1. Passo sem override = default, visível. Config vazia ⇒ jornada padrão.
 * 2. Override órfão (passo que não existe mais no catálogo) é IGNORADO, não
 *    quebra — o admin pode ter salvo antes de um deploy remover a tela.
 * 3. A ordem é a do `order` salvo; empate ou ausência cai na ordem do catálogo.
 */
export function resolveJourneySteps(
  steps: JourneyStepDefinition[],
  overrides: JourneyStepOverride[] = [],
): ResolvedJourneyStep[] {
  const byKey = new Map(overrides.map((o) => [o.stepKey, o]));

  return steps
    .map((def, index) => {
      const override = byKey.get(def.key);
      return {
        step: {
          key: def.key,
          label: normalizeText(override?.label) ?? def.label,
          subtitle: normalizeText(override?.subtitle) ?? def.defaultSubtitle,
          enabled: override?.enabled ?? true,
          skippable: override?.skippable ?? def.skippableByDefault,
          alwaysAvailable: def.alwaysAvailable,
        },
        order: override?.order ?? index,
        index,
      };
    })
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map((entry) => entry.step);
}

// ─── Catálogo de passos do onboarding legado (dado puro, sem React) ─────────
//
// Mesmo conteúdo que existia em `onboarding-journey.ts` antes desta mudança —
// só mudou de casa para virar uma entrada do catálogo genérico.

const ONBOARDING_STEPS: Record<ProjectType, JourneyStepDefinition[]> = {
  [ProjectType.PESSOAL]: [
    {
      key: 'funding',
      label: 'Contas & cartões',
      defaultSubtitle:
        'Sem conta ou cartão, o Caixa mostra só o fluxo. Dá pra definir depois em Contas Bancárias e Cartões.',
      alwaysAvailable: true,
      skippableByDefault: true,
    },
    {
      key: 'expense',
      label: 'Despesa',
      defaultSubtitle: 'Lance um gasto de hoje para o app começar a te mostrar algo real.',
      alwaysAvailable: true,
      skippableByDefault: true,
    },
    {
      key: 'import',
      label: 'Importar',
      defaultSubtitle: 'Traga seu extrato ou fatura de uma vez em vez de digitar tudo.',
      alwaysAvailable: true,
      skippableByDefault: true,
      // ponytail: desabilitar este passo via API para unificar Despesa + Importar (via admin UI toggle)
    },
    {
      key: 'expense-import',
      label: 'Despesa + Importar',
      defaultSubtitle: 'Lance um gasto ou importe múltiplos em uma única tela.',
      alwaysAvailable: true,
      skippableByDefault: true,
    },
    {
      key: 'receipt',
      label: 'Recebimento',
      defaultSubtitle: 'Cadastre o que entra para a sobra do mês fazer sentido.',
      alwaysAvailable: true,
      skippableByDefault: true,
    },
    {
      key: 'maria-insight',
      label: 'Maria',
      defaultSubtitle: 'Pergunte à Maria sobre esse gasto.',
      alwaysAvailable: false,
      skippableByDefault: true,
    },
    {
      key: 'feedback',
      label: 'Feedback',
      defaultSubtitle: 'Como foi começar por aqui?',
      alwaysAvailable: true,
      skippableByDefault: true,
    },
  ],
  [ProjectType.REFORMA]: [
    {
      key: 'expense',
      label: 'Despesa',
      defaultSubtitle: 'Lance o primeiro gasto da obra.',
      alwaysAvailable: true,
      skippableByDefault: true,
    },
    {
      key: 'feedback',
      label: 'Feedback',
      defaultSubtitle: 'Como foi começar por aqui?',
      alwaysAvailable: true,
      skippableByDefault: true,
    },
  ],
  [ProjectType.COMPRA]: [
    {
      key: 'expense',
      label: 'Despesa',
      defaultSubtitle: 'Lance o primeiro gasto dessa compra.',
      alwaysAvailable: true,
      skippableByDefault: true,
    },
    {
      key: 'feedback',
      label: 'Feedback',
      defaultSubtitle: 'Como foi começar por aqui?',
      alwaysAvailable: true,
      skippableByDefault: true,
    },
  ],
  [ProjectType.CASA]: [
    {
      key: 'bill',
      label: 'Conta',
      defaultSubtitle: 'Cadastre uma conta que se repete todo mês (água, luz, condomínio…).',
      alwaysAvailable: true,
      skippableByDefault: true,
    },
    {
      key: 'feedback',
      label: 'Feedback',
      defaultSubtitle: 'Como foi começar por aqui?',
      alwaysAvailable: true,
      skippableByDefault: true,
    },
  ],
  [ProjectType.CARRO]: [
    {
      key: 'car',
      label: 'Veículo',
      defaultSubtitle: 'Dados do veículo (placa, modelo, ano…).',
      alwaysAvailable: true,
      skippableByDefault: true,
    },
    {
      key: 'feedback',
      label: 'Feedback',
      defaultSubtitle: 'Como foi começar por aqui?',
      alwaysAvailable: true,
      skippableByDefault: true,
    },
  ],
  [ProjectType.PLANTAS]: [
    {
      key: 'plant',
      label: 'Planta',
      defaultSubtitle: 'Cadastre sua primeira planta (nome, espécie, ambiente…).',
      alwaysAvailable: true,
      skippableByDefault: true,
    },
    {
      key: 'feedback',
      label: 'Feedback',
      defaultSubtitle: 'Como foi começar por aqui?',
      alwaysAvailable: true,
      skippableByDefault: true,
    },
  ],
};

/** Chave de catálogo da jornada de onboarding legada, por tipo de projeto. */
export function onboardingJourneyKey(projectType: ProjectType): string {
  return `onboarding:${projectType}`;
}

/** Trigger default do onboarding: dispara só para o próprio tipo de projeto. */
function onboardingTrigger(projectType: ProjectType): JourneyTriggerDefinition {
  return {
    targetProjectType: projectType,
    targetProjectId: null,
    crossProject: false,
    device: 'any',
    repeatPolicy: 'ONCE_PER_USER',
    dismissPolicy: 'DISMISS_UNTIL_LOGIN',
  };
}

/**
 * Catálogo GENÉRICO de jornadas, por chave. Hoje só contém as jornadas de
 * onboarding (uma por tipo de projeto); fases futuras acrescentam entradas
 * novas aqui sem mexer nas existentes.
 */
export const JOURNEY_CATALOG: Record<string, JourneyDefinition> = Object.values(
  ProjectType,
).reduce(
  (acc, projectType) => {
    const key = onboardingJourneyKey(projectType);
    acc[key] = {
      key,
      name: `Onboarding — ${projectType}`,
      description: 'Jornada guiada de primeiro uso, por tipo de projeto.',
      steps: ONBOARDING_STEPS[projectType],
      triggers: [onboardingTrigger(projectType)],
    };
    return acc;
  },
  {} as Record<string, JourneyDefinition>,
);

export function getJourneyDefinition(key: string): JourneyDefinition | undefined {
  return JOURNEY_CATALOG[key];
}

export function listJourneyKeys(): string[] {
  return Object.keys(JOURNEY_CATALOG);
}

// ─── Tipos de gatilho, política de repetição e experiência do passo ────────
//
// Catálogo estável para o motor de gatilhos genérico (Etapa B+). Distinto do
// `JourneyTriggerDefinition` acima (que descreve o gatilho ÚNICO e fixo do
// onboarding legado): estes são os valores possíveis que um `JourneyTrigger`
// persistido no banco pode assumir quando o motor genérico de disparo por
// evento entrar em operação.

export const JOURNEY_TRIGGER_TYPES = [
  'SIGNUP_COMPLETED',
  'PROJECT_CREATED',
  'SCREEN_VISIT',
  'ACTION',
] as const;

export type JourneyTriggerType = (typeof JOURNEY_TRIGGER_TYPES)[number];

export const JOURNEY_REPEAT_POLICIES = ['ONCE_PER_USER', 'ONCE_PER_PROJECT', 'ALWAYS'] as const;

export type JourneyRepeatPolicy = (typeof JOURNEY_REPEAT_POLICIES)[number];

/** `'any'` = a jornada dispara em qualquer dispositivo ("mobile" = navegador em tela pequena). */
export const JOURNEY_TRIGGER_DEVICES = ['web', 'mobile', 'any'] as const;

export type JourneyDevice = (typeof JOURNEY_TRIGGER_DEVICES)[number];

/**
 * O que fazer quando o usuário fecha a jornada antes de concluir.
 * `DISMISS_UNTIL_LOGIN` (padrão) = some até o próximo login; `REOPEN_NEXT_TRIGGER`
 * = volta a aparecer no próximo gatilho elegível.
 */
export const JOURNEY_DISMISS_POLICIES = ['DISMISS_UNTIL_LOGIN', 'REOPEN_NEXT_TRIGGER'] as const;

export type JourneyDismissPolicy = (typeof JOURNEY_DISMISS_POLICIES)[number];

/** Resumida (mostra só o essencial) vs. Completa (fluxo guiado inteiro). */
export const JOURNEY_STEP_EXPERIENCES = ['SUMMARY', 'FULL'] as const;

export type JourneyStepExperience = (typeof JOURNEY_STEP_EXPERIENCES)[number];

// ─── Catálogo de ações seguras (gatilho ACTION) ─────────────────────────────

/**
 * Tokens estáveis `data-journey-action` — o front marca um elemento com
 * `data-journey-action="expense.new"` e o motor de jornadas escuta ESSE
 * token, nunca um seletor CSS (classe/estrutura de DOM mudam sem aviso;
 * o token semântico não). Convenção: `substantivo.verbo`, minúsculo,
 * hífen para múltiplas palavras (ex.: `bank-account.new`).
 */
export const JOURNEY_SAFE_ACTIONS = [
  'project.new',
  'expense.new',
  'receipt.new',
  'bank-account.new',
  'credit-card.new',
  'recurring-bill.new',
  'maintenance.new',
  'reminder.new',
  'import.start',
  'feedback.submit',
] as const;

export type JourneySafeAction = (typeof JOURNEY_SAFE_ACTIONS)[number];

// ─── Catálogo de telas (gatilho SCREEN_VISIT), derivado de PROJECT_NAV ──────

/**
 * Telas elegíveis a gatilho `SCREEN_VISIT`, por tipo de projeto. Hoje é
 * exatamente o conjunto de slugs de `PROJECT_NAV[type]` — cada rota que o
 * usuário de fato navega já é candidata a receber uma jornada. Construído
 * uma vez a partir de `PROJECT_NAV`, nunca copiado à mão, para as duas
 * fontes nunca divergirem silenciosamente.
 */
export const GENERIC_JOURNEY_SCREEN_CATALOG: Record<ProjectType, string[]> = Object.values(
  ProjectType,
).reduce(
  (acc, type) => {
    acc[type] = getProjectNavModules(type).map((m) => m.slug);
    return acc;
  },
  {} as Record<ProjectType, string[]>,
);

/**
 * Telas elegíveis a `SCREEN_VISIT` de um tipo de projeto. Devolve uma cópia
 * defensiva (mutar o retorno nunca deve mutar o catálogo) — mesmo contrato de
 * `getProjectNavModules`.
 */
export function getJourneyScreenKeys(type: ProjectType): string[] {
  return [...(GENERIC_JOURNEY_SCREEN_CATALOG[type] ?? [])];
}

/**
 * Primitiva de regressão de cobertura: varre `PROJECT_NAV` inteiro e devolve
 * toda rota renderizada que NÃO tem entrada correspondente no catálogo de
 * jornadas, por tipo. Vazio = catálogo completo. Uma rota nova adicionada a
 * `PROJECT_NAV` sem entrada aqui aparece nesta lista — é o motivo pelo qual
 * `GENERIC_JOURNEY_SCREEN_CATALOG` deriva de `PROJECT_NAV` em vez de ser uma
 * cópia estática que fica velha.
 */
export function findUncoveredNavRoutes(): Array<{ type: ProjectType; slug: string }> {
  const uncovered: Array<{ type: ProjectType; slug: string }> = [];
  for (const type of Object.values(ProjectType)) {
    const catalogSlugs = new Set(getJourneyScreenKeys(type));
    for (const nav of PROJECT_NAV[type] ?? []) {
      if (!catalogSlugs.has(nav.slug)) {
        uncovered.push({ type, slug: nav.slug });
      }
    }
  }
  return uncovered;
}

// ─── Mapa stepKey → slug (Etapa Completa navega para a tela real) ──────────

/**
 * Slug de `PROJECT_NAV` para onde a experiência Completa navega, por
 * `stepKey`. NUNCA persistido — o banco só guarda `stepKey`; o slug vem
 * sempre daqui, resolvido pela API (`journeys-eligibility.service.ts`) e
 * composto pelo runtime web com o projeto ATIVO no momento da navegação
 * (`/projects/${projectId}/${slug}`), nunca assado por antecipação — é o que
 * faz cross-project funcionar por construção: se o usuário troca de projeto
 * no `ProjectPicker`, a composição usa o projeto novo, não o do momento da
 * elegibilidade.
 *
 * Ausência aqui = o passo não tem tela própria (composto, como `funding`, ou
 * não é uma página, como `feedback`/`maria-insight`) — ver
 * `JOURNEY_STEPS_WITHOUT_SLUG`. Etapa Completa é PROIBIDA para esses,
 * rejeitada na escrita (`journeys-admin.service.ts`), nunca degradada em
 * silêncio no runtime.
 */
export const JOURNEY_STEP_SLUGS: Partial<Record<string, string>> = {
  expense: 'expenses',
  import: 'expenses',
  'expense-import': 'expenses',
  receipt: 'receipts',
  bill: 'bills',
  car: 'car-info',
  plant: 'plants',
};

/**
 * `stepKey`s do catálogo deliberadamente sem tela própria — Etapa Completa
 * nunca é permitida para eles. Existe só para `findUnclassifiedStepKeys`
 * distinguir "esquecido" de "sem rota de propósito".
 */
export const JOURNEY_STEPS_WITHOUT_SLUG = new Set(['funding', 'maria-insight', 'feedback']);

export function hasJourneyStepSlug(stepKey: string): boolean {
  return stepKey in JOURNEY_STEP_SLUGS;
}

/**
 * Primitiva de regressão de cobertura: todo `stepKey` usado por QUALQUER
 * jornada do catálogo precisa estar classificado — com slug
 * (`JOURNEY_STEP_SLUGS`) ou explicitamente sem tela
 * (`JOURNEY_STEPS_WITHOUT_SLUG`). Vazio = catálogo completo. Um `stepKey`
 * novo sem entrada em nenhum dos dois aparece aqui — sem isso, a Etapa
 * Completa dele silenciosamente não navega para lugar nenhum.
 */
export function findUnclassifiedStepKeys(): string[] {
  const known = new Set(
    Object.values(JOURNEY_CATALOG).flatMap((j) => j.steps.map((s) => s.key)),
  );
  return [...known].filter(
    (key) => !(key in JOURNEY_STEP_SLUGS) && !JOURNEY_STEPS_WITHOUT_SLUG.has(key),
  );
}

/**
 * Primitiva de regressão de cobertura: todo slug em `JOURNEY_STEP_SLUGS`
 * precisa ser um slug REAL de `PROJECT_NAV` (de algum tipo de projeto) —
 * pega typo/rota removida antes de virar 404 em produção.
 */
export function findInvalidStepSlugs(): string[] {
  const allNavSlugs = new Set(
    Object.values(ProjectType).flatMap((type) => getProjectNavModules(type).map((m) => m.slug)),
  );
  return Object.entries(JOURNEY_STEP_SLUGS)
    .filter(([, slug]) => slug !== undefined && !allNavSlugs.has(slug))
    .map(([key]) => key);
}
