import { Injectable } from '@nestjs/common';
import { PESSOAL_JOURNEY_CATALOG, JourneyStepDef } from '@reformaflow/domain';

// Generic/default journey catalog for other project types
const GENERIC_JOURNEY_CATALOG: JourneyStepDef[] = [
  {
    key: 'bank',
    label: 'Conta Bancária',
    defaultSubtitle: 'Adicione uma conta.',
    alwaysAvailable: true,
    skippableByDefault: true,
  },
  {
    key: 'card',
    label: 'Cartão de Crédito',
    defaultSubtitle: 'Adicione um cartão.',
    alwaysAvailable: true,
    skippableByDefault: true,
  },
  {
    key: 'expense',
    label: 'Despesa',
    defaultSubtitle: 'Registre um gasto recente.',
    alwaysAvailable: true,
    skippableByDefault: true,
  },
  {
    key: 'import',
    label: 'Importar',
    defaultSubtitle: 'Importe seus lançamentos de uma vez.',
    alwaysAvailable: true,
    skippableByDefault: true,
  },
  {
    key: 'receipt',
    label: 'Recebimento',
    defaultSubtitle: 'Registre uma entrada já realizada.',
    alwaysAvailable: true,
    skippableByDefault: true,
  },
];

@Injectable()
export class OnboardingService {
  /**
   * Returns the journey catalog for a given project type.
   * - PESSOAL: uses dedicated catalog with 'funding' step (combining bank + card)
   * - Other types: use generic catalog with separate bank and card steps
   */
  getJourneyCatalog(projectType: string): { steps: JourneyStepDef[] } {
    if (projectType === 'PESSOAL') {
      return {
        steps: PESSOAL_JOURNEY_CATALOG,
      };
    }

    // Default/generic catalog for all other types (REFORMA, etc.)
    return {
      steps: GENERIC_JOURNEY_CATALOG,
    };
  }
}
