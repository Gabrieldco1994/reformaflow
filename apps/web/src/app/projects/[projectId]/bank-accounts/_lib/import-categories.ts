import { tipoLabel } from '@/lib/expense-options';

/**
 * Listas de categoria + rótulo compartilhadas pelos previews de importação
 * (extrato vinculado a conta e importação Carteira "sem conta"). MOVE puro de
 * `_components/BankPreviewTxRow.tsx` — listas byte-idênticas, `categoryLabel`
 * idêntica. Não alterar sem alinhar os dois consumidores.
 */

/**
 * Sentinelas de crédito do preview de extrato que não são `ExpenseType`
 * (`fastClassify` devolve uma delas para toda entrada). Só o rótulo — não é
 * taxonomia nova; `MOVIMENTACAO_INTERNA` já tem label em `ExpenseTypeLabels`.
 */
const LEGACY_CATEGORY_LABEL: Record<string, string> = { RECEITA: 'Receita' };

export function categoryLabel(value: string): string {
  return LEGACY_CATEGORY_LABEL[value] ?? tipoLabel(value);
}

export const DEBIT_CATEGORIES = [
  { value: 'MORADIA', label: 'Moradia' },
  { value: 'ALIMENTACAO', label: 'Alimentação' },
  { value: 'TRANSPORTE', label: 'Transporte' },
  { value: 'SAUDE', label: 'Saúde' },
  { value: 'EDUCACAO', label: 'Educação' },
  { value: 'LAZER', label: 'Lazer' },
  { value: 'BELEZA', label: 'Beleza' },
  { value: 'PETS', label: 'Pets' },
  { value: 'SUPERMERCADO', label: 'Supermercado' },
  { value: 'FAXINEIRA', label: 'Faxineira' },
  { value: 'AJUDA', label: 'Ajuda' },
  { value: 'REEMBOLSO_MEDICO', label: 'Reembolso Médico' },
  { value: 'ACADEMIA', label: 'Academia' },
  { value: 'ASSINATURAS', label: 'Assinaturas' },
  { value: 'INVESTIMENTOS', label: 'Investimentos' },
  { value: 'SEGUROS_PESSOAIS', label: 'Seguros' },
  { value: 'IMPREVISTOS', label: 'Imprevistos' },
  { value: 'PAGAMENTO_FATURA_CARTAO', label: 'Pagamento de fatura' },
  { value: 'OUTROS', label: 'Outros' },
];

export const CREDIT_CATEGORIES = [
  { value: 'SALARIO', label: 'Salário' },
  { value: 'BONUS', label: 'Bônus / 13º' },
  { value: 'FREELANCE', label: 'Freelance / PJ' },
  { value: 'RENDIMENTO_INVESTIMENTO', label: 'Rendimento' },
  { value: 'REEMBOLSO', label: 'Reembolso' },
  { value: 'TRANSFERENCIA', label: 'Transferência' },
  { value: 'OUTROS', label: 'Outros' },
];
