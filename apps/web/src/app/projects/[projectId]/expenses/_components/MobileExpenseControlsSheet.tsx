import { useEffect } from 'react';
import { Search, X } from 'lucide-react';
import { FORMA_PAGAMENTO_OPTIONS } from '@/lib/expense-options';
import type { ExpenseQueryState } from '../_lib/expense-query-state';

interface Option { value: string; label: string }
interface Props {
  open: boolean;
  draft: ExpenseQueryState;
  projectType: string | undefined;
  hasRooms: boolean;
  tipoOptions: Option[];
  onDraftChange: (draft: ExpenseQueryState) => void;
  onApply: (draft: ExpenseQueryState) => void;
  onOpenChange: (open: boolean) => void;
}
const VIEWS = [
  { value: 'category', label: 'Categoria' },
  { value: 'month', label: 'Mês' },
  { value: 'general', label: 'Geral' },
] as const;
const STATUS_OPTIONS = [
  { value: 'PLANEJADO', label: 'Planejado' },
  { value: 'PAGO', label: 'Pago' },
] as const;
const control = 'min-h-[44px] w-full rounded-xl border border-darc-linen bg-white px-3 text-sm text-darc-velvet focus:outline-none focus:ring-2 focus:ring-lifeone-blue';
const label = 'mb-1 block text-[11px] font-semibold text-darc-velvet/70';

export function MobileExpenseControlsSheet({ open, draft, projectType, hasRooms, tipoOptions, onDraftChange, onApply, onOpenChange }: Props) {
  const set = <K extends keyof ExpenseQueryState>(key: K, value: ExpenseQueryState[K]) => onDraftChange({ ...draft, [key]: value });
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onOpenChange(false); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onOpenChange]);
  if (!open) return null;
  const personal = projectType === 'PESSOAL';
  return (
    <div className="md:hidden">
      <button type="button" aria-label="Fechar filtros" onClick={() => onOpenChange(false)} className="fixed inset-0 z-40 bg-darc-velvet/60 backdrop-blur-sm" />
      <section role="dialog" aria-modal="true" aria-label="Filtros de despesas" className="fixed inset-x-0 bottom-0 z-50 flex max-h-[88dvh] flex-col rounded-t-[26px] bg-lifeone-surface shadow-lifeone-dialog">
        <header className="flex items-center justify-between border-b border-darc-linen px-5 py-3">
          <h2 className="font-geist text-lg font-semibold text-lifeone-ink">Filtrar despesas</h2>
          <button type="button" aria-label="Fechar" onClick={() => onOpenChange(false)} className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-darc-velvet/70"><X className="h-5 w-5" /></button>
        </header>
        <div className="space-y-4 overflow-y-auto px-5 py-4">
          <div><label htmlFor="expense-q" className={label}>Buscar despesas</label><div className="relative"><Search className="absolute left-3 top-3.5 h-4 w-4 text-darc-velvet/40" /><input id="expense-q" type="search" value={draft.q} onChange={(e) => set('q', e.target.value)} className={`${control} pl-9`} /></div></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label htmlFor="expense-type" className={label}>Tipo</label><select id="expense-type" value={draft.tipoDespesa} onChange={(e) => set('tipoDespesa', e.target.value)} className={control}><option value="">Todos</option>{tipoOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div>
            <div><label htmlFor="expense-payment" className={label}>Pagamento</label><select id="expense-payment" value={draft.formaPagamento} onChange={(e) => set('formaPagamento', e.target.value)} className={control}><option value="">Todos</option>{FORMA_PAGAMENTO_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div>
          </div>
          {hasRooms && <div><label htmlFor="expense-room" className={label}>Ambiente</label><input id="expense-room" value={draft.room} onChange={(e) => set('room', e.target.value)} className={control} /></div>}
          <div className="grid grid-cols-2 gap-3">
            <div><label htmlFor="expense-title" className={label}>Título</label><input id="expense-title" value={draft.titulo} onChange={(e) => set('titulo', e.target.value)} className={control} /></div>
            <div><label htmlFor="expense-vendor" className={label}>Fornecedor</label><input id="expense-vendor" value={draft.fornecedor} onChange={(e) => set('fornecedor', e.target.value)} className={control} /></div>
          </div>
          <div><label htmlFor="expense-status" className={label}>Status</label><select id="expense-status" value={draft.status} onChange={(e) => set('status', e.target.value)} className={control}><option value="">Todos</option>{STATUS_OPTIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div>
          <fieldset><legend className={label}>Visão</legend><div className="grid grid-cols-2 gap-2">{[...VIEWS, ...(personal ? [{ value: 'project' as const, label: 'Por projeto' }] : [])].map((item) => <label key={item.value} className="flex min-h-[44px] items-center gap-2 rounded-xl border border-darc-linen px-3 text-[11px] font-semibold"><input type="radio" name="expense-view" value={item.value} checked={draft.view === item.value} onChange={() => set('view', item.value)} />{item.label}</label>)}</div></fieldset>
          {personal && <div className="space-y-3"><div><label htmlFor="expense-period" className={label}>Período</label><input id="expense-period" type="month" value={draft.period === 'ALL' ? '' : draft.period} onChange={(e) => set('period', e.target.value)} className={control} /><button type="button" onClick={() => set('period', 'ALL')} className="mt-1 min-h-[44px] text-[11px] font-semibold text-lifeone-blue">Ano todo</button></div><div className="grid grid-cols-2 gap-3"><div><label htmlFor="expense-range-start" className={label}>Início</label><input id="expense-range-start" type="month" value={draft.rangeStart} onChange={(e) => set('rangeStart', e.target.value)} className={control} /></div><div><label htmlFor="expense-range-end" className={label}>Fim</label><input id="expense-range-end" type="month" value={draft.rangeEnd} onChange={(e) => set('rangeEnd', e.target.value)} className={control} /></div></div><div><label htmlFor="expense-origin" className={label}>Origem</label><input id="expense-origin" value={draft.origin} onChange={(e) => set('origin', e.target.value)} className={control} /></div></div>}
        </div>
        <footer className="safe-pb flex gap-3 border-t border-darc-linen bg-white px-5 pb-4 pt-3"><button type="button" onClick={() => onOpenChange(false)} className="min-h-[44px] flex-1 rounded-xl border border-darc-linen text-sm font-semibold text-darc-velvet">Cancelar</button><button type="button" onClick={() => onApply(draft)} className="min-h-[44px] flex-1 rounded-xl bg-orange-500 text-sm font-semibold text-white">Aplicar</button></footer>
      </section>
    </div>
  );
}
