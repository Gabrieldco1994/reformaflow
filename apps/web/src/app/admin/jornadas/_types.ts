import type {
  JourneyDefinition,
  JourneyStepOverride,
  JourneyTriggerDefinition,
  JourneyTriggerType,
  ProjectType,
  ResolvedJourneyStep,
} from "@reformaflow/domain";

export interface EditorJourney {
  key: string;
  name: string;
  description: string;
  steps: ResolvedJourneyStep[];
  trigger: JourneyTriggerDefinition;
  startsWhen: JourneyTriggerType;
}

export type JourneyDraftPatch = Partial<
  Pick<EditorJourney, "name" | "description" | "trigger" | "startsWhen">
>;

export type JourneyStepPayload = JourneyStepOverride & { order: number };

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
  SCREEN_VISIT: "Visita a uma tela",
  ACTION: "Ação realizada",
};

export type JourneyDefinitionInput = JourneyDefinition;
