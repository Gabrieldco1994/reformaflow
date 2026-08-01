/**
 * Catálogo centralizado de modos de lançamento.
 * Fonte única de verdade para rótulos, valores e metadados dos modos.
 * Importado por MobileLaunchModeSheet ("+") e QuickExpenseStep (onboarding).
 */

export type LaunchMode =
  | 'despesa'      // Teclado rápido
  | 'planejar'     // Despesa futura
  | 'recebimento'  // Registrar entrada
  | 'voz'          // Mãos livres
  | 'fatura'       // Foto de fatura de cartão
  | 'extrato'      // Foto de extrato bancário
  | 'foto';        // Foto — onboarding only (triggers photo picker)

export interface LaunchModeOption {
  value: LaunchMode;
  label: string;
  subtitle?: string;
}

/**
 * Catálogo completo de modos. Cada UI que precise rótulos/subtítulos
 * filtra este array conforme necessário.
 */
export const LAUNCH_MODES: LaunchModeOption[] = [
  {
    value: 'despesa',
    label: 'Despesa',
    subtitle: 'Teclado rápido — valor, origem e descrição',
  },
  {
    value: 'planejar',
    label: 'Planejar',
    subtitle: 'Despesa futura / a pagar',
  },
  {
    value: 'recebimento',
    label: 'Recebimento',
    subtitle: 'Registrar entrada de dinheiro',
  },
  {
    value: 'voz',
    label: 'Voz',
    subtitle: 'Fale a despesa — mãos livres',
  },
  {
    value: 'fatura',
    label: 'Foto da fatura',
    subtitle: 'Print/foto da fatura do cartão',
  },
  {
    value: 'extrato',
    label: 'Foto do extrato',
    subtitle: 'Print/foto do extrato da conta',
  },
  {
    value: 'foto',
    label: 'Foto',
    subtitle: 'Print ou foto de fatura / extrato',
  },
];

/**
 * Modos disponíveis no onboarding: despesa, voz, foto (sem recebimento, pois há QuickReceiptStep).
 */
export const ONBOARDING_MODES: LaunchModeOption[] = LAUNCH_MODES.filter(
  (m) => m.value === 'despesa' || m.value === 'voz' || m.value === 'foto'
);

/**
 * Modos principais do "+": despesa, planejar, recebimento, voz, foto.
 */
export const MOBILE_LAUNCH_MODES: LaunchModeOption[] = LAUNCH_MODES.filter(
  (m) => m.value !== 'fatura' && m.value !== 'extrato'
);

/**
 * Modos de foto (submenu): fatura, extrato.
 */
export const PHOTO_MODES: LaunchModeOption[] = LAUNCH_MODES.filter(
  (m) => m.value === 'fatura' || m.value === 'extrato'
);

/**
 * Convenience: busca rótulo por valor.
 */
export function getLaunchModeLabel(value: LaunchMode | string): string {
  return LAUNCH_MODES.find((m) => m.value === value)?.label ?? '';
}

/**
 * Convenience: busca subtítulo por valor.
 */
export function getLaunchModeSubtitle(value: LaunchMode | string): string | undefined {
  return LAUNCH_MODES.find((m) => m.value === value)?.subtitle;
}
