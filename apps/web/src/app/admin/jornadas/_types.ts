import type { ProjectType, ResolvedJourneyStep } from '@reformaflow/domain';

/** Jornada resolvida de cada tipo de projeto, como a API devolve. */
export type JourneyMap = Record<ProjectType, ResolvedJourneyStep[]>;

/** Item do corpo do PUT `/admin/onboarding/journeys/:projectType`. */
export interface JourneyStepPayload {
  stepKey: string;
  order: number;
  enabled: boolean;
  skippable: boolean;
  label?: string;
  subtitle?: string;
}

/** Cores/rótulos da barra de tipos — o mesmo vocabulário do resto do admin. */
export const PROJECT_TYPE_LABELS: Record<string, string> = {
  PESSOAL: 'Pessoal',
  REFORMA: 'Reforma',
  COMPRA: 'Compra',
  CASA: 'Casa',
  CARRO: 'Carro',
  PLANTAS: 'Plantas',
};
