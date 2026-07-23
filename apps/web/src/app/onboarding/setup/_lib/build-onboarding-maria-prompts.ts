/**
 * Gera os prompts pré-formatados que a Maria recebe logo após a 1ª despesa do
 * onboarding. O primeiro chip é DERIVADO da categoria real que a pessoa acabou
 * de lançar (ex.: Mercado → "Quanto já gastei em Mercado este mês?"), os demais
 * são perguntas genéricas de caixa. As tools que respondem já existem
 * (get_expenses_by_category / get_financial_overview) — zero backend novo.
 */
export interface OnboardingMariaPromptInput {
  /** Valor do enum ExpenseType da despesa criada (ex.: 'SUPERMERCADO'). */
  tipoDespesa: string;
  /** Label legível da categoria (ex.: 'Supermercado'), vindo de getExpenseOptions. */
  categoriaLabel?: string | null;
}

export function buildOnboardingMariaPrompts({
  categoriaLabel,
}: OnboardingMariaPromptInput): string[] {
  const prompts: string[] = [];
  const categoria = categoriaLabel?.trim();

  if (categoria) {
    prompts.push(`Quanto já gastei em ${categoria} este mês?`);
  }
  prompts.push('Como está meu caixa este mês?');
  prompts.push('Onde meu dinheiro está indo?');

  return prompts;
}
