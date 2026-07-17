import { ProjectType } from '../enums';
import { TYPE_MODULES, TypeModuleSlug } from './type-modules';

export const ONBOARDING_PROJECT_TYPES: readonly ProjectType[] = Object.freeze([
  ProjectType.REFORMA,
  ProjectType.COMPRA,
  ProjectType.CASA,
  ProjectType.CARRO,
  ProjectType.PESSOAL,
  ProjectType.PLANTAS,
]);

export interface ObjectiveAccess {
  allowedProjectTypes: ProjectType[];
  allowedModules: TypeModuleSlug[];
}

/** Derives a stable authorization snapshot exclusively from selected objectives. */
export function deriveObjectiveAccess(
  projectTypes: readonly ProjectType[],
): ObjectiveAccess {
  const selected = new Set(projectTypes);
  const allowedProjectTypes = ONBOARDING_PROJECT_TYPES.filter((type) =>
    selected.has(type),
  );
  const modules = new Set<TypeModuleSlug>();
  for (const type of allowedProjectTypes) {
    for (const module of TYPE_MODULES[type]) modules.add(module);
  }
  return { allowedProjectTypes, allowedModules: Array.from(modules) };
}
