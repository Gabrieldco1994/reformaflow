import type { ProjectType } from '@reformaflow/domain';
import { getExpenseOptions } from '../_types';
import { FORMA_PAGAMENTO_OPTIONS } from '@/lib/expense-options';
import type { ExpenseViewMode } from '../_components/ExpenseViewToggle';

export interface ExpenseQueryState {
  q: string;
  tipoDespesa: string;
  room: string;
  titulo: string;
  fornecedor: string;
  formaPagamento: string;
  status: string;
  view: ExpenseViewMode;
  period: string;
  rangeStart: string;
  rangeEnd: string;
  origin: string;
}

export interface ExpenseQueryOptions {
  projectType: ProjectType | string | undefined;
  hasRooms: boolean;
  storedViewMode?: string | null;
  defaultViewMode?: ExpenseViewMode;
}

export const EXPENSE_QUERY_KEYS = [
  'q', 'tipoDespesa', 'room', 'titulo', 'fornecedor', 'formaPagamento',
  'status', 'view', 'period', 'rangeStart', 'rangeEnd', 'origin',
] as const satisfies readonly (keyof ExpenseQueryState)[];

const COMMON_VIEWS: ExpenseViewMode[] = ['category', 'month', 'general'];
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const ORIGIN = /^(?:card|account|CARTAO|EXTRATO):[^:]+$/;

function validView(value: string | null | undefined, personal: boolean): ExpenseViewMode | null {
  if (value === 'project') return personal ? value : null;
  return COMMON_VIEWS.includes(value as ExpenseViewMode) ? value as ExpenseViewMode : null;
}

function month(value: string | null, personal: boolean): string {
  return personal && value && MONTH.test(value) ? value : '';
}

function period(value: string | null, personal: boolean): string {
  return personal && value === 'ALL' ? 'ALL' : month(value, personal);
}

export function decodeExpenseQuery(params: URLSearchParams, options: ExpenseQueryOptions): ExpenseQueryState {
  const personal = options.projectType === 'PESSOAL';
  const tipos = new Set<string>(getExpenseOptions(options.projectType ?? '').map((item) => item.value));
  const formas = new Set<string>(FORMA_PAGAMENTO_OPTIONS.map((item) => item.value));
  const tipoDespesa = params.get('tipoDespesa') ?? '';
  const formaPagamento = params.get('formaPagamento') ?? '';
  const status = params.get('status') ?? '';
  const view = validView(params.get('view'), personal)
    ?? validView(options.storedViewMode, personal)
    ?? options.defaultViewMode
    ?? 'category';
  return {
    q: params.get('q') ?? '',
    tipoDespesa: tipos.has(tipoDespesa) ? tipoDespesa : '',
    room: options.hasRooms ? params.get('room') ?? '' : '',
    titulo: params.get('titulo') ?? '',
    fornecedor: params.get('fornecedor') ?? '',
    formaPagamento: formas.has(formaPagamento) ? formaPagamento : '',
    status: status === 'PLANEJADO' || status === 'PAGO' ? status : '',
    view,
    period: period(params.get('period'), personal),
    rangeStart: month(params.get('rangeStart'), personal),
    rangeEnd: month(params.get('rangeEnd'), personal),
    origin: personal && ORIGIN.test(params.get('origin') ?? '') ? params.get('origin')! : '',
  };
}

export function encodeExpenseQuery(current: URLSearchParams, state: ExpenseQueryState, options: ExpenseQueryOptions): URLSearchParams {
  const owned = new URLSearchParams();
  EXPENSE_QUERY_KEYS.forEach((key) => { if (state[key]) owned.set(key, state[key]); });
  const canonical = decodeExpenseQuery(owned, { ...options, storedViewMode: state.view });
  const next = new URLSearchParams();
  EXPENSE_QUERY_KEYS.forEach((key) => {
    const value = canonical[key];
    if (value || key === 'view') next.set(key, value);
  });
  const ownedKeys = new Set<string>(EXPENSE_QUERY_KEYS);
  current.forEach((value, key) => { if (!ownedKeys.has(key)) next.append(key, value); });
  return next;
}
