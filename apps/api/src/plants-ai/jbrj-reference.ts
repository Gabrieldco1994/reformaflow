import jbrjReferenceJson from './eval-fixtures/jbrj-common-names.json';
import {
  findExactJbrjReferenceEntry as findExactJbrjReferenceEntryInFixture,
  normalizeDiagnosisCommonNamesFromJbrj as normalizeDiagnosisCommonNamesFromJbrjInFixture,
  type JbrjReferenceFixture,
  type PlantDiagnosisLike,
} from './jbrj-reference-lib';

export { JBRJ_ATTRIBUTION, type JbrjReferenceEntry, type JbrjReferenceFixture } from './jbrj-reference-lib';

export const JBRJ_REFERENCE_FIXTURE = jbrjReferenceJson as JbrjReferenceFixture;

export function findExactJbrjReferenceEntry(
  scientificName: string,
  fixture: JbrjReferenceFixture = JBRJ_REFERENCE_FIXTURE,
) {
  return findExactJbrjReferenceEntryInFixture(scientificName, fixture);
}

export function normalizeDiagnosisCommonNamesFromJbrj<T extends PlantDiagnosisLike>(
  diagnosis: T,
  fixture: JbrjReferenceFixture = JBRJ_REFERENCE_FIXTURE,
): T {
  return normalizeDiagnosisCommonNamesFromJbrjInFixture(diagnosis, fixture);
}
