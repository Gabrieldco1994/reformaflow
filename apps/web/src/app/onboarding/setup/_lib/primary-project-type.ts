import { ProjectType } from '@reformaflow/domain';
import { OBJECTIVE_TYPES, type ObjectiveType } from '@/components/objectives/objective-options';

/**
 * Picks the single "primary" project type to enter a guided onboarding wizard
 * for at signup, when more than one objective was selected.
 * PESSOAL always wins (it's the anchor project of the whole app); otherwise
 * the first type in canonical `OBJECTIVE_TYPES` order among the selection.
 */
export function pickPrimaryProjectType(selected: ObjectiveType[]): ObjectiveType | null {
  if (selected.length === 0) return null;
  if (selected.includes(ProjectType.PESSOAL)) return ProjectType.PESSOAL;
  return OBJECTIVE_TYPES.find((t) => selected.includes(t)) ?? null;
}
