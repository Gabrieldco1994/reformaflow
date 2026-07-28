import type { ProjectType } from "@reformaflow/domain";
import {
  resolveJourneyPlan,
  type JourneyPlan,
  type PersistedJourney,
} from "@reformaflow/domain";
import { api } from "@/lib/api";

export interface EligibleJourneyStep {
  stepKey: string;
  order: number;
  experience: "SUMMARY" | "FULL";
  label: string;
  subtitle: string | null;
  skippable: boolean;
  enabled?: boolean;
  conditionKey?: string | null;
  conditionUnmetBehavior?: "SKIP" | "BLOCK";
  targetProjectType?: ProjectType | null;
  blocked?: boolean;
  route?: string;
}

export interface EligibleJourney {
  journeyId?: string;
  key: string;
  name: string;
  triggerId?: string;
  repeatPolicy: string;
  dismissPolicy?: string;
  crossProject?: boolean;
  active?: boolean;
  targetScope?: "ALL_PROJECTS" | "PROJECT_TYPE" | "PROJECT";
  targetProjectType?: ProjectType | null;
  targetProjectId?: string | null;
  allowCrossProjectNavigation?: boolean;
  triggers?: PersistedJourney["triggers"];
  steps: EligibleJourneyStep[];
}

export interface RuntimeJourney extends EligibleJourney {
  journeyId: string;
  triggerId: string;
  dismissPolicy: string;
  crossProject: boolean;
  plan: JourneyPlan;
  steps: EligibleJourneyStep[];
}

export interface JourneyProject {
  id: string;
  name: string;
  type: ProjectType;
}

export interface JourneyEligibilityContext {
  triggerType:
    | "SIGNUP_COMPLETED"
    | "PROJECT_CREATED"
    | "SCREEN_VISIT"
    | "ACTION";
  device: "web" | "mobile";
  projectId?: string;
  projectType?: ProjectType;
  screenKey?: string;
  actionKey?: string;
}

export async function getEligibleJourneys(
  context: JourneyEligibilityContext,
): Promise<EligibleJourney[]> {
  const params = new URLSearchParams({
    triggerType: context.triggerType,
    device: context.device,
  });
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined && key !== "triggerType" && key !== "device") {
      params.set(key, String(value));
    }
  }
  return api.get<EligibleJourney[]>(`/journeys/eligible?${params.toString()}`);
}

export function normalizeJourney(journey: EligibleJourney): RuntimeJourney {
  const persisted: PersistedJourney = {
    key: journey.key,
    name: journey.name,
    active: journey.active ?? true,
    targetScope: journey.targetScope ?? "ALL_PROJECTS",
    targetProjectType: journey.targetProjectType ?? null,
    targetProjectId: journey.targetProjectId ?? null,
    repeatPolicy: journey.repeatPolicy as PersistedJourney["repeatPolicy"],
    allowCrossProjectNavigation:
      journey.allowCrossProjectNavigation ?? journey.crossProject ?? false,
    steps: journey.steps.map((step) => ({
      stepKey: step.stepKey,
      order: step.order,
      enabled: step.enabled ?? true,
      skippable: step.skippable,
      experience: step.experience,
      label: step.label,
      subtitle: step.subtitle,
      conditionKey: step.conditionKey ?? null,
      conditionUnmetBehavior: step.conditionUnmetBehavior ?? "SKIP",
      targetProjectType: step.targetProjectType ?? null,
    })),
    triggers: journey.triggers ?? [],
  };
  const plan = resolveJourneyPlan(persisted);
  // `PlannedJourneyStep` carrega só o que o domínio decide (quais passos rodam,
  // ordem, posição, blocked). Campos de transporte web — hoje `route`, usado
  // pela experiência FULL para navegar até a tela real — não existem no domínio
  // e precisam voltar do payload original, senão uma etapa FULL vira uma etapa
  // que não navega para lugar nenhum.
  const byKey = new Map(
    journey.steps.map((step) => [`${step.stepKey}#${step.order}`, step]),
  );
  return {
    ...journey,
    journeyId: journey.journeyId ?? journey.key,
    triggerId:
      journey.triggerId ?? journey.triggers?.[0]?.triggerType ?? journey.key,
    dismissPolicy: journey.dismissPolicy ?? "DISMISS_UNTIL_LOGIN",
    crossProject:
      journey.crossProject ?? journey.allowCrossProjectNavigation ?? false,
    plan,
    steps: plan.steps.map((step) => ({
      ...step,
      route: byKey.get(`${step.stepKey}#${step.order}`)?.route,
      label: step.label ?? step.stepKey,
      subtitle: step.subtitle,
    })),
  };
}

export async function completeJourney(
  journeyId: string,
  triggerId: string,
  projectId?: string,
): Promise<void> {
  await api.post(`/journeys/${journeyId}/complete`, { triggerId, projectId });
}

export async function listJourneyProjects(): Promise<JourneyProject[]> {
  return api.get<JourneyProject[]>("/projects");
}
