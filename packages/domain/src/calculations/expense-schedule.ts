import { parseInstallmentDateOnlyUtc } from './local-date-utc';

export interface ExpenseScheduleOccurrence {
  index: number;
  parcela: string | null;
  valor: number;
  data: string;
  invoiceDueMonth: string | null;
}

export interface ExpenseScheduleV1 {
  version: 1;
  occurrences: ExpenseScheduleOccurrence[];
}

export function isInvoiceDueMonth(value: unknown): value is string {
  return (
    typeof value === 'string' && /^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(value)
  );
}

export function parseExpenseSchedule(value: unknown): ExpenseScheduleV1 {
  const invalid = (): never => {
    throw new RangeError('Invalid expense schedule');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid();
  if (
    !('version' in value) ||
    value.version !== 1 ||
    !('occurrences' in value) ||
    !Array.isArray(value.occurrences) ||
    value.occurrences.length === 0 ||
    Object.keys(value).length !== 2 ||
    Object.keys(value).some((key) => key !== 'version' && key !== 'occurrences')
  )
    return invalid();

  let total = 0;
  const occurrences = Array.from(
    value.occurrences,
    (item: unknown, index): ExpenseScheduleOccurrence => {
      if (!item || typeof item !== 'object' || Array.isArray(item))
        return invalid();
      if (
        !('index' in item) ||
        item.index !== index ||
        !('parcela' in item) ||
        !(
          item.parcela === null ||
          (typeof item.parcela === 'string' && item.parcela.trim().length > 0)
        ) ||
        !('valor' in item) ||
        typeof item.valor !== 'number' ||
        !Number.isSafeInteger(item.valor) ||
        !('data' in item) ||
        typeof item.data !== 'string' ||
        !parseInstallmentDateOnlyUtc(item.data) ||
        !('invoiceDueMonth' in item) ||
        !(
          item.invoiceDueMonth === null ||
          isInvoiceDueMonth(item.invoiceDueMonth)
        ) ||
        Object.keys(item).length !== 5 ||
        Object.keys(item).some(
          (key) =>
            !['index', 'parcela', 'valor', 'data', 'invoiceDueMonth'].includes(
              key,
            ),
        )
      )
        return invalid();
      total += item.valor;
      if (!Number.isSafeInteger(total)) return invalid();
      return {
        index,
        parcela: item.parcela,
        valor: item.valor,
        data: item.data,
        invoiceDueMonth: item.invoiceDueMonth,
      };
    },
  );
  return { version: 1, occurrences };
}
