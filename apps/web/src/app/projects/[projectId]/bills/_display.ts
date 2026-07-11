import type { ProjectType } from '@reformaflow/domain';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import { getExpenseOptions } from '../expenses/_types';

export const BILL_CATEGORIES = [
  { value: 'LUZ', label: 'Luz' },
  { value: 'AGUA', label: 'Água' },
  { value: 'INTERNET', label: 'Internet' },
  { value: 'IPTU', label: 'IPTU' },
  { value: 'CONDOMINIO', label: 'Condomínio' },
  { value: 'FINANCIAMENTO', label: 'Financiamento' },
  { value: 'SEGURO', label: 'Seguro' },
  { value: 'GAS', label: 'Gás' },
  { value: 'TELEFONE', label: 'Telefone' },
  { value: 'STREAMING', label: 'Streaming' },
  { value: 'OUTRO', label: 'Outro' },
] as const;

export const BILL_FREQUENCIES = [
  { value: 'MENSAL', label: 'Mensal' },
  { value: 'BIMESTRAL', label: 'Bimestral' },
  { value: 'TRIMESTRAL', label: 'Trimestral' },
  { value: 'SEMESTRAL', label: 'Semestral' },
  { value: 'ANUAL', label: 'Anual' },
] as const;

export interface RecurringBillRow {
  id: string;
  nome: string;
  valor: number;
  categoria: string;
  frequencia: string;
  diaVencimento: number;
  status: 'ATIVO' | 'PAUSADO';
  ultimoPagamento?: string;
  proximoVencimento?: string;
  observacoes?: string;
}

const BILL_STATUS_DISPLAY = {
  ATIVO: {
    label: 'Ativa',
    actionLabel: 'Pausar',
    className: 'bg-green-100 text-green-700',
    active: true,
  },
  PAUSADO: {
    label: 'Pausada',
    actionLabel: 'Ativar',
    className: 'bg-gray-100 text-gray-500',
    active: false,
  },
} as const satisfies Record<RecurringBillRow['status'], object>;

export function getRecurringBillDisplay(bill: RecurringBillRow) {
  const status = BILL_STATUS_DISPLAY[bill.status];
  return {
    source: bill,
    name: bill.nome || '—',
    category:
      BILL_CATEGORIES.find((category) => category.value === bill.categoria)
        ?.label ?? bill.categoria,
    value: formatCurrency(bill.valor / 100),
    frequency:
      BILL_FREQUENCIES.find((frequency) => frequency.value === bill.frequencia)
        ?.label ?? bill.frequencia,
    dueDate: 'Dia ' + bill.diaVencimento,
    ...status,
  };
}

export interface AvulsaRow {
  id: string;
  tipoDespesa: string;
  titulo?: string | null;
  fornecedor?: string | null;
  valorTotal: number;
  status: 'PLANEJADO' | 'PAGO';
  formaPagamento: string;
  dataPagamento?: string | null;
  dataInicioParcela?: string | null;
  quantidadeParcela?: number | null;
}

const AVULSA_STATUS_DISPLAY = {
  PLANEJADO: {
    label: 'Planejado',
    className: 'bg-amber-100 text-amber-700',
  },
  PAGO: {
    label: 'Pago',
    className: 'bg-green-100 text-green-700',
  },
} as const satisfies Record<AvulsaRow['status'], object>;

export function getAvulsaDisplay(expense: AvulsaRow, projectType: ProjectType) {
  const referenceDate = expense.dataPagamento ?? expense.dataInicioParcela;
  const formattedDate = referenceDate ? formatDateBR(referenceDate) : '—';
  const status = AVULSA_STATUS_DISPLAY[expense.status];
  return {
    source: expense,
    date: formattedDate === '-' ? '—' : formattedDate,
    title: expense.titulo || expense.fornecedor || '—',
    category:
      getExpenseOptions(projectType).find(
        (option) => option.value === expense.tipoDespesa,
      )?.label ?? expense.tipoDespesa,
    value: formatCurrency((expense.valorTotal ?? 0) / 100),
    ...status,
  };
}
