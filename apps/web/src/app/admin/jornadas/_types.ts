import type {
  JourneyRepeatPolicy,
  JourneyStepExperience,
  JourneyTriggerType,
  ProjectType,
  ResolvedJourneyStep,
} from "@reformaflow/domain";

/**
 * Modelo do editor — segue o modelo `Journey` descrito no plano (device,
 * targetScope, repeatPolicy, dismissPolicy e `allowCrossProjectNavigation`
 * no nível da jornada; `JourneyTrigger` só carrega tipo + chave). A API
 * desnormaliza esses mesmos campos por gatilho — o mapeamento mora no seam de
 * `_lib/journeys-api.ts` (`toApiShape`/`fromApiShape`), sem espalhar a decisão
 * pelos componentes.
 */

export type EditorDevice = "DESKTOP" | "MOBILE" | "BOTH";
export const DEVICE_OPTIONS: EditorDevice[] = ["BOTH", "DESKTOP", "MOBILE"];
export const DEVICE_LABELS: Record<EditorDevice, string> = {
  BOTH: "Desktop e mobile",
  DESKTOP: "Somente desktop",
  MOBILE: "Somente mobile",
};

export type EditorTargetScope = "ALL_PROJECTS" | "PROJECT_TYPE" | "PROJECT";
export const TARGET_SCOPE_OPTIONS: EditorTargetScope[] = [
  "ALL_PROJECTS",
  "PROJECT_TYPE",
  "PROJECT",
];
export const TARGET_SCOPE_LABELS: Record<EditorTargetScope, string> = {
  ALL_PROJECTS: "Todos os projetos",
  PROJECT_TYPE: "Um tipo de projeto",
  PROJECT: "Um projeto específico",
};

export type EditorDismissPolicy = "DISMISS_UNTIL_LOGIN" | "REOPEN_NEXT_TRIGGER";
export const DISMISS_POLICY_OPTIONS: EditorDismissPolicy[] = [
  "DISMISS_UNTIL_LOGIN",
  "REOPEN_NEXT_TRIGGER",
];
export const DISMISS_POLICY_LABELS: Record<EditorDismissPolicy, string> = {
  DISMISS_UNTIL_LOGIN: "Some até o próximo login",
  REOPEN_NEXT_TRIGGER: "Reabre no próximo gatilho",
};

export const REPEAT_POLICY_LABELS: Record<JourneyRepeatPolicy, string> = {
  ONCE_PER_USER: "Uma vez por usuário",
  ONCE_PER_PROJECT: "Uma vez por projeto",
  ALWAYS: "Sempre",
};

export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  PESSOAL: "Pessoal",
  REFORMA: "Reforma",
  COMPRA: "Compra",
  CASA: "Casa",
  CARRO: "Carro",
  PLANTAS: "Plantas",
};

export const TRIGGER_TYPE_LABELS: Record<JourneyTriggerType, string> = {
  SIGNUP_COMPLETED: "Cadastro concluído",
  PROJECT_CREATED: "Projeto criado",
  SCREEN_VISIT: "Acesso a uma tela",
  ACTION: "Clique em uma ação",
};

export const STEP_EXPERIENCE_LABELS: Record<JourneyStepExperience, string> = {
  SUMMARY: "Resumida",
  FULL: "Completa",
};

/** Um gatilho na trilha "Quando começa". `key` é o slug/ação do catálogo. */
export interface EditorTrigger {
  id: string;
  type: JourneyTriggerType;
  key: string | null;
}

/** Um passo da trilha, com o override do admin + o modo de experiência. */
export interface EditorStep extends ResolvedJourneyStep {
  experience: JourneyStepExperience;
}

export interface EditorJourney {
  /** Id da linha `Journey` — o `PUT /admin/journeys/:id` usa este campo
   * (o editor navega por `key`, que é a identidade estável do catálogo). */
  id: string;
  key: string;
  name: string;
  description: string;
  active: boolean;
  targetScope: EditorTargetScope;
  targetProjectType: ProjectType | null;
  targetProjectId: string | null;
  device: EditorDevice;
  allowCrossProjectNavigation: boolean;
  repeatPolicy: JourneyRepeatPolicy;
  dismissPolicy: EditorDismissPolicy;
  triggers: EditorTrigger[];
  steps: EditorStep[];
}

export type JourneyDraftPatch = Partial<
  Pick<
    EditorJourney,
    | "name"
    | "description"
    | "active"
    | "targetScope"
    | "targetProjectType"
    | "targetProjectId"
    | "device"
    | "allowCrossProjectNavigation"
    | "repeatPolicy"
    | "dismissPolicy"
    | "triggers"
  >
>;

export interface ProjectOption {
  id: string;
  name: string;
  type: string;
}
