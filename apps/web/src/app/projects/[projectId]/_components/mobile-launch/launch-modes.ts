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
    // Subtítulo lista SÓ o que o `accept` de ImportStatementModal realmente
    // aceita (.ofx/.csv/.txt/.pdf/.xlsx/.xls + imagem). Prometer um formato que
    // o seletor recusa é pior que um rótulo genérico: o usuário tenta e falha.
    label: 'Fatura do cartão',
    subtitle: 'PDF, CSV, OFX, XLS/XLSX, TXT ou foto',
  },
  {
    value: 'extrato',
    label: 'Extrato bancário',
    subtitle: 'PDF, CSV, OFX, XLS/XLSX, TXT ou foto',
  },
  {
    value: 'foto',
    label: 'Fatura / Extrato',
    subtitle: 'PDF, CSV, OFX, XLS/XLSX, TXT ou foto',
  },
];

/**
 * Modos disponíveis no onboarding: despesa, voz, foto (sem recebimento, pois há QuickReceiptStep).
 *
 * Os rótulos do onboarding são PRÓPRIOS, não herdados de `LAUNCH_MODES`, por
 * dois motivos concretos:
 *
 * 1. No painel da jornada já existe um botão **"Importar"**. Herdar o rótulo
 *    "Fatura / Extrato" do modo `foto` criava dois caminhos com o mesmo nome
 *    para funções diferentes na MESMA tela.
 * 2. O `accept` do modo `foto` no onboarding é `image/*` — só imagem. O
 *    subtítulo do menu "+" (que promete PDF/CSV/XLS) descreve os modos
 *    `fatura`/`extrato`, cujos modais aceitam esses formatos; aqui ele seria
 *    falso.
 */
const ONBOARDING_OVERRIDES: Partial<Record<LaunchMode, Pick<LaunchModeOption, 'label' | 'subtitle'>>> = {
  foto: { label: 'Foto', subtitle: 'Print ou foto do comprovante' },
};

export const ONBOARDING_MODES: LaunchModeOption[] = LAUNCH_MODES.filter(
  (m) => m.value === 'despesa' || m.value === 'voz' || m.value === 'foto'
).map((m) => ({ ...m, ...(ONBOARDING_OVERRIDES[m.value] ?? {}) }));

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
