import { X } from 'lucide-react';
import { formaLabel, tipoLabel } from '@/lib/expense-options';
import type { ExpenseQueryState } from '../_lib/expense-query-state';

const VIEW_LABELS = { category: 'Categoria', month: 'Mês', project: 'Por projeto', general: 'Geral' } as const;
const STATUS_LABELS: Record<string, string> = { PLANEJADO: 'Planejado', PAGO: 'Pago' };
export function ActiveExpenseFilterChips({ state, onRemove, onClear }: { state: ExpenseQueryState; onRemove: (key: keyof ExpenseQueryState) => void; onClear: () => void }) {
  const chips: Array<[keyof ExpenseQueryState, string]> = [];
  if (state.q) chips.push(['q', `Busca: ${state.q}`]);
  if (state.tipoDespesa) chips.push(['tipoDespesa', tipoLabel(state.tipoDespesa)]);
  if (state.room) chips.push(['room', `Ambiente: ${state.room}`]);
  if (state.titulo) chips.push(['titulo', `Título: ${state.titulo}`]);
  if (state.fornecedor) chips.push(['fornecedor', `Fornecedor: ${state.fornecedor}`]);
  if (state.formaPagamento) chips.push(['formaPagamento', formaLabel(state.formaPagamento)]);
  if (state.status) chips.push(['status', STATUS_LABELS[state.status] ?? state.status]);
  if (state.view !== 'category') chips.push(['view', VIEW_LABELS[state.view]]);
  if (state.period) chips.push(['period', state.period]);
  if (state.rangeStart) chips.push(['rangeStart', `De ${state.rangeStart}`]);
  if (state.rangeEnd) chips.push(['rangeEnd', `Até ${state.rangeEnd}`]);
  if (state.origin) chips.push(['origin', `Origem: ${state.origin}`]);
  if (!chips.length) return null;
  return <div className="md:hidden flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">{chips.map(([key, text]) => <button key={key} type="button" onClick={() => onRemove(key)} className="flex min-h-[44px] shrink-0 items-center gap-1 rounded-full border border-darc-linen bg-white px-3 text-[11px] font-semibold text-darc-velvet">{text}<X className="h-3.5 w-3.5" /></button>)}<button type="button" onClick={onClear} className="min-h-[44px] shrink-0 px-2 text-[11px] font-semibold text-lifeone-blue">Limpar</button></div>;
}
