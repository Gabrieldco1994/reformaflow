import {
  buildInstallments,
  type InstallmentEntry,
  type InstallmentInput,
} from '@reformaflow/domain';

export interface ExpenseInstallmentInput extends InstallmentInput {
  installmentDateOverrides?: string | null;
}

function parseInstallmentDateOverrides(raw?: string | null): Map<number, string> {
  const overrides = new Map<number, string>();
  if (!raw) return overrides;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return overrides;

    for (const [rawIndex, value] of Object.entries(parsed)) {
      const index = Number(rawIndex);
      if (
        Number.isInteger(index) &&
        index >= 0 &&
        typeof value === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(value)
      ) {
        overrides.set(index, value);
      }
    }
  } catch {
    // Dado legado/inválido não pode impedir a renderização do cronograma base.
  }

  return overrides;
}

/**
 * Adaptador web do cronograma canônico. Enquanto o campo chega serializado pela
 * API, aplica cada data efetiva sem recalcular índice, rótulo ou valor.
 */
export function buildExpenseInstallments(
  input: ExpenseInstallmentInput,
): InstallmentEntry[] {
  const installments = buildInstallments(input);
  const overrides = parseInstallmentDateOverrides(
    input.installmentDateOverrides,
  );

  return installments.map((installment, index) => {
    const data = overrides.get(index);
    return data
      ? { ...installment, data: new Date(`${data}T00:00:00.000Z`) }
      : installment;
  });
}
