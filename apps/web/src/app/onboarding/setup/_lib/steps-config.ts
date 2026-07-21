import type { ComponentType } from 'react';
import { ProjectType } from '@reformaflow/domain';
import type { OnboardingStepProps } from '../_types';
import { BankAccountStep } from '../_components/steps/BankAccountStep';
import { CreditCardStep } from '../_components/steps/CreditCardStep';
import { QuickExpenseStep } from '../_components/steps/QuickExpenseStep';
import { QuickReceiptStep } from '../_components/steps/QuickReceiptStep';
import { RecurringBillStep } from '../_components/steps/RecurringBillStep';
import { CarInfoStep } from '../_components/steps/CarInfoStep';
import { PlantStep } from '../_components/steps/PlantStep';
import { ImportMassStep } from '../_components/steps/ImportMassStep';

export interface AnchorStepDef {
  /** stable id, also stepper-dot label key */
  key: string;
  /** stepper-dot short label */
  label: string;
  Component: ComponentType<OnboardingStepProps>;
}

/**
 * Config-driven per-type anchor-step list. The wizard shell renders
 * whichever step is active generically — it never branches on project type
 * beyond looking up this registry.
 */
export const ANCHOR_STEPS: Record<ProjectType, AnchorStepDef[]> = {
  [ProjectType.PESSOAL]: [
    { key: 'bank', label: 'Conta', Component: BankAccountStep },
    { key: 'card', label: 'Cartão', Component: CreditCardStep },
    { key: 'expense', label: 'Despesa', Component: QuickExpenseStep },
    { key: 'import', label: 'Importar', Component: ImportMassStep },
    { key: 'receipt', label: 'Recebimento', Component: QuickReceiptStep },
  ],
  [ProjectType.REFORMA]: [{ key: 'expense', label: 'Despesa', Component: QuickExpenseStep }],
  [ProjectType.COMPRA]: [{ key: 'expense', label: 'Despesa', Component: QuickExpenseStep }],
  [ProjectType.CASA]: [{ key: 'bill', label: 'Conta', Component: RecurringBillStep }],
  [ProjectType.CARRO]: [{ key: 'car', label: 'Veículo', Component: CarInfoStep }],
  [ProjectType.PLANTAS]: [{ key: 'plant', label: 'Planta', Component: PlantStep }],
};
