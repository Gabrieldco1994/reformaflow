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
  /**
   * `false` = a tela nasce DESLIGADA (sem override do admin) — nunca
   * hardcoded fora do catálogo. Único uso hoje: `expense`/`import` em
   * PESSOAL nascem desligados porque `expense-import` já é a versão
   * unificada das duas (mostrar as três juntas faria a pessoa lançar a
   * mesma 1ª despesa três vezes seguidas). Ausente ⇒ `true` — a config é
   * DADO do catálogo, nunca uma regra escondida em código de consumidor
   * (bootstrap/adaptador legado só materializam o que este campo diz).
   */
  enabledByDefault?: boolean;
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
          enabled: override?.enabled ?? def.enabledByDefault ?? true,
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
      // Nasce desligado: `expense-import` (abaixo) já unifica esta tela +
      // `import`. Sem isto a pessoa veria as 3 seguidas pedindo a mesma 1ª
      // despesa. O admin pode religar em /admin/jornadas se quiser as
      // telas separadas.
      enabledByDefault: false,
    },
    {
      key: 'import',
      label: 'Importar',
      defaultSubtitle: 'Traga seu extrato ou fatura de uma vez em vez de digitar tudo.',
      alwaysAvailable: true,
      skippableByDefault: true,
      enabledByDefault: false,
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

/**
 * Trigger default do onboarding: dispara só para o próprio tipo de projeto.
 *
 * `repeatPolicy: 'ONCE_PER_PROJECT'` — não `ONCE_PER_USER` — reproduz a
 * semântica do shell legado, onde o gate era `Project.onboardedAt` (coluna
 * DO PROJETO, não do usuário). Um usuário com DUAS REFORMAs, por exemplo,
 * via onboarding nas duas; `ONCE_PER_USER` (chave `tenantId:userId:none`)
 * bloquearia a segunda depois da primeira conclusão — regressão real,
 * pega pelos testes de paridade da migração do shell (Fase B, Jornadas).
 */
function onboardingTrigger(projectType: ProjectType): JourneyTriggerDefinition {
  return {
    targetProjectType: projectType,
    targetProjectId: null,
    crossProject: false,
    device: 'any',
    repeatPolicy: 'ONCE_PER_PROJECT',
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
 * Todo `stepKey` usado por QUALQUER jornada do catálogo — a base do conjunto
 * "known" que a Etapa Completa e o motor de plano (`resolveJourneyPlan`)
 * usam para não silenciar uma etapa nova por engano. Bootstrap (`journey-
 * bootstrap.service.ts`) materializa exatamente a partir de `JOURNEY_CATALOG`,
 * então toda jornada persistida hoje tem seus `stepKey`s cobertos por
 * construção — nunca precisa de migration para "aprender" uma chave nova
 * daqui.
 */
export function listAllCatalogStepKeys(): string[] {
  return [...new Set(Object.values(JOURNEY_CATALOG).flatMap((j) => j.steps.map((s) => s.key)))];
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
 * Ausência aqui = o passo não tem tela própria (ex.: `feedback`/`maria-insight`) —
 * ver `JOURNEY_STEPS_WITHOUT_SLUG`. Etapa Completa é PROIBIDA para esses,
 * rejeitada na escrita (`journeys-admin.service.ts`), nunca degradada em
 * silêncio no runtime.
 */
export const JOURNEY_STEP_SLUGS: Partial<Record<string, string>> = {
  funding: 'conta',
  expense: 'expenses',
  import: 'expenses',
  'expense-import': 'expenses',
  receipt: 'receipts',
  bill: 'bills',
  car: 'car-info',
  plant: 'plants',
};

/**
 * Divergências de destino POR TIPO DE PROJETO — só o que difere de
 * `JOURNEY_STEP_SLUGS`. Base + override, nunca um mapa aninhado completo: um
 * `Record<ProjectType, Record<stepKey, slug>>` obrigaria a declarar cada
 * `stepKey` novo 6 vezes, cinco delas idênticas, e divergência por OMISSÃO
 * viraria o modo de falha padrão.
 *
 * ⚠️ POR QUE O PESSOAL DIVERGE — leia antes de "limpar" isto.
 *
 * NÃO é gambiarra. O U4 (#453, programa #436) remove `expenses`, `receipts`,
 * `credit-cards` e `bank-accounts` de `PROJECT_NAV[PESSOAL]`: no financeiro
 * pessoal essas telas foram absorvidas pelo hub `/conta`, e as rotas antigas
 * passam a SEMPRE redirecionar para lá. Mandar a jornada para `expenses` num
 * projeto PESSOAL faz o produto se contradizer — anuncia uma URL e entrega
 * outra.
 *
 * E `conta` faz o mesmo trabalho, não um trabalho parecido: o
 * `conta/_components/DespesaModal.tsx` reusa o MESMO `ExpenseFormModal` da
 * tela de despesas. O usuário consegue exatamente o que o painel da jornada
 * pede — só que na tela que continua existindo.
 *
 * INVARIANTE QUE ESTE MAPA NÃO PODE QUEBRAR (travada por teste em
 * `journey-step-slugs-per-type.test.ts`): um override REDIRECIONA, nunca
 * REMOVE. Todo valor aqui é uma tela real, e todo `stepKey` aqui já existe em
 * `JOURNEY_STEP_SLUGS`. É isso que permite a `hasJourneyStepSlug` — e portanto
 * a `assertFullExperienceHasSlug`, em `journeys-admin.service.ts` — continuar
 * type-agnostic: "esse passo tem tela própria?" dá a mesma resposta com e sem
 * tipo. E ela PRECISA continuar type-agnostic, porque naquele ponto o tipo não
 * existe: passos pertencem à JORNADA, e uma jornada pode ter 0..N gatilhos
 * mirando tipos diferentes (ou nenhum, quando é global).
 */
export const JOURNEY_STEP_SLUG_OVERRIDES: Partial<
  Record<ProjectType, Partial<Record<string, string>>>
> = {
  [ProjectType.PESSOAL]: {
    expense: 'conta',
    import: 'conta',
    'expense-import': 'conta',
    receipt: 'conta',
  },
};

/**
 * Destino da experiência Completa de um passo, no tipo de projeto em que a
 * jornada está rodando. ÚNICA forma correta de ler o mapa de slugs — ler
 * `JOURNEY_STEP_SLUGS[stepKey]` cru ignora os overrides e ressuscita o defeito.
 *
 * `projectType` ausente/`null` (ex.: `SIGNUP_COMPLETED`, que não tem projeto em
 * contexto) cai no mapa base — nunca em `undefined` novo, que faria uma etapa
 * Completa deixar de navegar.
 *
 * ⚠️ LIMITAÇÃO CONHECIDA E MEDIDA (não é descuido): o slug é resolvido no
 * servidor para o tipo do projeto do momento da ELEGIBILIDADE, mas o runtime
 * web compõe `/projects/${projectId}/${slug}` com o projeto ATIVO na hora de
 * navegar (`journey-runtime-context.tsx`). Numa jornada `crossProject` o
 * usuário pode trocar para um projeto de OUTRO tipo e receber um slug
 * resolvido para o tipo anterior. Hoje é inofensivo e foi conferido no banco:
 * as 6 triggers existentes têm `cross_project = 0` e não há nenhuma jornada
 * cross-project com passo FULL. Resolver de verdade exigiria a API devolver o
 * destino de todos os tipos para o runtime re-resolver na troca — PR inteira
 * para uma demanda que não existe. Se surgir a primeira jornada cross-project
 * com etapa Completa, este comentário é a dívida a pagar.
 */
export function resolveJourneyStepSlug(
  stepKey: string,
  projectType?: ProjectType | null,
): string | undefined {
  if (projectType) {
    const override = JOURNEY_STEP_SLUG_OVERRIDES[projectType]?.[stepKey];
    if (override !== undefined) return override;
  }
  return JOURNEY_STEP_SLUGS[stepKey];
}

/**
 * `stepKey`s do catálogo deliberadamente sem tela própria — Etapa Completa
 * nunca é permitida para eles. Existe só para `findUnclassifiedStepKeys`
 * distinguir "esquecido" de "sem rota de propósito".
 */
export const JOURNEY_STEPS_WITHOUT_SLUG = new Set(['maria-insight', 'feedback']);

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
  return listAllCatalogStepKeys().filter(
    (key) => !(key in JOURNEY_STEP_SLUGS) && !JOURNEY_STEPS_WITHOUT_SLUG.has(key),
  );
}

/**
 * Um destino inválido, já localizado: o passo `stepKey`, rodando num projeto
 * do tipo `type`, mandaria o usuário para `slug` — que não é rota daquele tipo.
 */
export interface InvalidStepSlug {
  type: ProjectType;
  stepKey: string;
  slug: string;
}

export interface StepSlugAuditOptions {
  /**
   * Substitui `PROJECT_NAV` só nos tipos informados (MESCLA, não troca): o
   * teste sobrescreve um tipo e os outros cinco seguem com o nav real. Existe
   * para a guarda ser testável contra um nav HIPOTÉTICO — provar que ela pega
   * o colapso de uma rota sem depender do estado atual da navegação nem
   * esperar a PR que o causa.
   */
  nav?: Partial<Record<ProjectType, ReadonlyArray<{ slug: string }>>>;
}

/**
 * `stepKey`s que podem rodar num projeto de tipo `type`: os passos de toda
 * jornada que mira esse tipo, mais os das jornadas globais
 * (`targetProjectType: null`, que valem para qualquer projeto).
 *
 * Este escopo é o que impede a auditoria de virar máquina de falso-positivo:
 * `bill -> bills` só existe no onboarding de CASA e NUNCA pode ser cobrado do
 * PESSOAL, que legitimamente não tem `bills` no nav.
 *
 * Uma jornada global é cobrada contra TODOS os tipos, e uma jornada sem
 * nenhum gatilho também. É escolha, não descuido: hoje não existe nenhuma das
 * duas (as 6 jornadas do catálogo miram um tipo cada), e se surgir uma global
 * com passo cujo slug só vale em alguns tipos, a auditoria vai gritar. Falso
 * positivo grita e alguém conserta; falso negativo é exatamente o que deixou
 * o PESSOAL quebrado com o CI verde.
 */
function listCatalogStepKeysForType(type: ProjectType): string[] {
  const keys = new Set<string>();
  for (const journey of Object.values(JOURNEY_CATALOG)) {
    const appliesToType =
      journey.triggers.length === 0 ||
      journey.triggers.some((t) => t.targetProjectType === null || t.targetProjectType === type);
    if (!appliesToType) continue;
    for (const step of journey.steps) keys.add(step.key);
  }
  return [...keys];
}

/**
 * Primitiva de regressão de cobertura: todo destino de passo precisa ser uma
 * rota REAL do tipo de projeto em que aquele passo roda. Vazio = catálogo são.
 *
 * ⚠️ ESTA GUARDA JÁ FALHOU EM SILÊNCIO — não a afrouxe de volta. A versão
 * anterior validava os slugs contra a UNIÃO de todos os tipos. Quando o U4
 * (#453) tirou `expenses` do `PROJECT_NAV[PESSOAL]`, a rota sobreviveu em
 * REFORMA e COMPRA, a união continuou contendo `expenses` e a guarda devolveu
 * `[]` com 4 passos do PESSOAL quicando para `/conta`. Guarda type-agnostic
 * para um problema per-type não protege ninguém: valide SEMPRE por tipo, e
 * resolva o destino por `resolveJourneyStepSlug(stepKey, type)` — nunca por
 * `JOURNEY_STEP_SLUGS[stepKey]` cru, que ignora os overrides.
 */
export function findInvalidStepSlugs(options: StepSlugAuditOptions = {}): InvalidStepSlug[] {
  const invalid: InvalidStepSlug[] = [];
  for (const type of Object.values(ProjectType)) {
    const navSlugs = new Set(
      (options.nav?.[type] ?? PROJECT_NAV[type] ?? []).map((m) => m.slug),
    );
    for (const stepKey of listCatalogStepKeysForType(type)) {
      const slug = resolveJourneyStepSlug(stepKey, type);
      if (slug !== undefined && !navSlugs.has(slug)) {
        invalid.push({ type, stepKey, slug });
      }
    }
  }
  return invalid;
}
