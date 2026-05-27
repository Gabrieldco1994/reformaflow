import {
  ExpenseType,
  ExpenseTypeLabels,
  LaborCategory,
  LaborCategoryLabels,
  PaymentForm,
  PaymentFormLabels,
} from '@reformaflow/domain';

export type OptionItem = { value: string; label: string };

export const FORMA_PAGAMENTO_OPTIONS: OptionItem[] = (
  Object.values(PaymentForm) as PaymentForm[]
).map((v) => ({ value: v, label: PaymentFormLabels[v] }));

export const CATEGORIA_MAO_DE_OBRA_OPTIONS: OptionItem[] = (
  Object.values(LaborCategory) as LaborCategory[]
).map((v) => ({ value: v, label: LaborCategoryLabels[v] }));

export const tipoLabel = (t: string): string =>
  ExpenseTypeLabels[t as ExpenseType] ?? t;

export const formaLabel = (f: string): string =>
  PaymentFormLabels[f as PaymentForm] ?? f;

export const catMaoLabel = (c: string): string =>
  LaborCategoryLabels[c as LaborCategory] ?? c;
