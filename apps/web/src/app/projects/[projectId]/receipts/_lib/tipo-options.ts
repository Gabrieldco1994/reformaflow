export type TipoOption = { value: string; label: string; group?: string };

export const DEFAULT_TIPO_OPTIONS: TipoOption[] = [
  { value: 'PAGAMENTO', label: 'Pagamento' },
  { value: 'BONUS', label: 'Bônus' },
  { value: 'VENDA_ACAO', label: 'Venda de Ação' },
  { value: 'ORCAMENTO_INICIAL', label: 'Orçamento Inicial' },
  { value: 'ALOCACAO_ORCAMENTO', label: '💰 Alocação de Orçamento' },
];

export const PESSOAL_TIPO_OPTIONS: TipoOption[] = [
  // Trabalho
  { value: 'SALARIO', label: 'Salário', group: 'Trabalho' },
  { value: 'ADIANTAMENTO_SALARIO', label: 'Adiantamento de Salário', group: 'Trabalho' },
  { value: 'DECIMO_TERCEIRO', label: '13º Salário', group: 'Trabalho' },
  { value: 'FERIAS', label: 'Férias', group: 'Trabalho' },
  { value: 'FREELANCE', label: 'Freelance', group: 'Trabalho' },
  { value: 'BONUS', label: 'Bônus', group: 'Trabalho' },
  { value: 'COMISSAO', label: 'Comissão', group: 'Trabalho' },
  { value: 'PENSAO', label: 'Pensão / Aposentadoria', group: 'Trabalho' },
  // Investimentos
  { value: 'DIVIDENDOS', label: 'Dividendos', group: 'Investimentos' },
  { value: 'JUROS_RENDA_FIXA', label: 'Juros de Renda Fixa', group: 'Investimentos' },
  { value: 'POUPANCA', label: 'Rend. Poupança', group: 'Investimentos' },
  { value: 'ACAO', label: 'Ação (Operação)', group: 'Investimentos' },
  { value: 'VENDA_ACAO', label: 'Venda de Ação', group: 'Investimentos' },
  { value: 'FII', label: 'Fundo Imobiliário', group: 'Investimentos' },
  { value: 'CRIPTO', label: 'Criptomoeda', group: 'Investimentos' },
  { value: 'RESGATE', label: 'Resgate', group: 'Investimentos' },
  // Transferências
  { value: 'ALOCACAO_ORCAMENTO', label: '💰 Alocação de Orçamento', group: 'Transferências' },
  { value: 'TRANSFERENCIA_PROPRIA', label: 'Transferência própria', group: 'Transferências' },
  // Outros
  { value: 'ALUGUEL', label: 'Aluguel', group: 'Outros' },
  { value: 'REEMBOLSO', label: 'Reembolso', group: 'Outros' },
  { value: 'RESTITUICAO_IR', label: 'Restituição IR', group: 'Outros' },
  { value: 'VENDA_BEM', label: 'Venda de Bem', group: 'Outros' },
  { value: 'PRESENTE', label: 'Presente / Doação', group: 'Outros' },
  { value: 'OUTROS', label: 'Outros', group: 'Outros' },
];

/** Mirrors the `getExpenseOptions(projectType)` pattern in `expenses/_types.ts`. */
export function getReceiptTipoOptions(projectType: string): TipoOption[] {
  return projectType === 'PESSOAL' ? PESSOAL_TIPO_OPTIONS : DEFAULT_TIPO_OPTIONS;
}
