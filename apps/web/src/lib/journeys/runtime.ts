import type { ProjectType } from "@reformaflow/domain";
import { api } from "@/lib/api";

export interface EligibleJourneyStep {
  stepKey: string;
  order: number;
  experience: "SUMMARY" | "FULL";
  label: string;
  subtitle: string | null;
  skippable: boolean;
  route?: string;
}

export interface EligibleJourney {
  journeyId: string;
  key: string;
  name: string;
  triggerId: string;
  repeatPolicy: string;
  dismissPolicy: string;
  crossProject: boolean;
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
