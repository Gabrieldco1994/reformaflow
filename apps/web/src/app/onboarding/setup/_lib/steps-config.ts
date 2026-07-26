import type { ComponentType } from 'react';
import type { OnboardingStepProps } from '../_types';
import { FundingStep } from '../_components/steps/FundingStep';
import { QuickExpenseStep } from '../_components/steps/QuickExpenseStep';
import { QuickReceiptStep } from '../_components/steps/QuickReceiptStep';
import { RecurringBillStep } from '../_components/steps/RecurringBillStep';
import { CarInfoStep } from '../_components/steps/CarInfoStep';
import { PlantStep } from '../_components/steps/PlantStep';
import { ImportMassStep } from '../_components/steps/ImportMassStep';

/**
 * Registro `key → Componente React` das telas do onboarding. SÓ isso: a ordem,
 * o rótulo, o texto de apoio e o "pode pular" vêm da jornada resolvida
 * (`ONBOARDING_JOURNEY_DEFAULTS`/`resolveJourney` em `@reformaflow/domain`,
 * com os overrides que o admin salvou). Uma chave sem componente aqui
 * simplesmente não é renderizada — o wizard não quebra.
 *
 * `maria-insight` e `feedback` não estão aqui porque têm props próprias
 * (contexto da despesa criada / envio de feedback) e são montados
 * explicitamente pelo shell.
 *
 * `funding` unifica conta bancária + cartão de crédito num único passo
 * (issue #320) — substitui os antigos `bank`/`card` separados.
 */
export const STEP_COMPONENTS: Record<string, ComponentType<OnboardingStepProps>> = {
  funding: FundingStep,
  expense: QuickExpenseStep,
  import: ImportMassStep,
  receipt: QuickReceiptStep,
  bill: RecurringBillStep,
  car: CarInfoStep,
  plant: PlantStep,
};
