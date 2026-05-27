import { Filter, Search } from 'lucide-react';
import { FORMA_PAGAMENTO_OPTIONS } from '@/lib/expense-options';
import type { ExpenseFilters } from '../_hooks/useExpenseFilters';

interface ExpenseOption {
  value: string;
  label: string;
}

interface ExpenseFiltersBarProps {
  searchText: string;
  onSearchTextChange: (value: string) => void;
  showFilters: boolean;
  onToggleFilters: () => void;
  filters: ExpenseFilters;
  updateFilter: (key: keyof ExpenseFilters, value: string) => void;
  clearFilters: () => void;
  hasActiveFilters: boolean;
  showRooms: boolean;
  tipoDespesaOptions: ExpenseOption[];
}

export function ExpenseFiltersBar({
  searchText,
  onSearchTextChange,
  showFilters,
  onToggleFilters,
  filters,
  updateFilter,
  clearFilters,
  hasActiveFilters,
  showRooms,
  tipoDespesaOptions,
}: ExpenseFiltersBarProps) {
  return (
    <>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Buscar despesas..."
            value={searchText}
            onChange={(e) => onSearchTextChange(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-300"
          />
        </div>
        <button
          onClick={onToggleFilters}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-sm border rounded-lg transition-colors ${
            showFilters || hasActiveFilters
              ? 'bg-blue-50 border-blue-300 text-blue-700'
              : 'border-gray-200 text-gray-600 hover:bg-gray-50'
          }`}
        >
          <Filter className="w-4 h-4" />
          Filtros
          {hasActiveFilters && (
            <span className="ml-1 bg-blue-600 text-white text-[10px] rounded-full w-4 h-4 flex items-center justify-center">
              {Object.values(filters).filter((v) => v !== '').length}
            </span>
          )}
        </button>
        {hasActiveFilters && (
          <button
            onClick={clearFilters}
            className="text-xs text-blue-600 hover:text-blue-800 px-2 py-1.5"
          >
            Limpar
          </button>
        )}
      </div>

      {showFilters && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 px-3 py-2 bg-gray-50 border rounded-lg">
          <div>
            <label className="text-[10px] font-medium text-gray-500 block mb-0.5">Tipo</label>
            <select value={filters.tipoDespesa} onChange={(e) => updateFilter('tipoDespesa', e.target.value)}
              className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-300">
              <option value="">Todos</option>
              {tipoDespesaOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          {showRooms && (
            <div>
              <label className="text-[10px] font-medium text-gray-500 block mb-0.5">Ambiente</label>
              <input type="text" placeholder="Filtrar..." value={filters.room}
                onChange={(e) => updateFilter('room', e.target.value)}
                className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300" />
            </div>
          )}
          <div>
            <label className="text-[10px] font-medium text-gray-500 block mb-0.5">Título</label>
            <input type="text" placeholder="Filtrar..." value={filters.titulo}
              onChange={(e) => updateFilter('titulo', e.target.value)}
              className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300" />
          </div>
          <div>
            <label className="text-[10px] font-medium text-gray-500 block mb-0.5">Fornecedor</label>
            <input type="text" placeholder="Filtrar..." value={filters.fornecedor}
              onChange={(e) => updateFilter('fornecedor', e.target.value)}
              className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-300" />
          </div>
          <div>
            <label className="text-[10px] font-medium text-gray-500 block mb-0.5">Pagamento</label>
            <select value={filters.formaPagamento} onChange={(e) => updateFilter('formaPagamento', e.target.value)}
              className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-300">
              <option value="">Todos</option>
              {FORMA_PAGAMENTO_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[10px] font-medium text-gray-500 block mb-0.5">Status</label>
            <select value={filters.status} onChange={(e) => updateFilter('status', e.target.value)}
              className="w-full border border-gray-200 rounded px-1.5 py-1 text-xs bg-white focus:outline-none focus:ring-1 focus:ring-blue-300">
              <option value="">Todos</option>
              <option value="PLANEJADO">Planejado</option>
              <option value="PAGO">Pago</option>
            </select>
          </div>
        </div>
      )}
    </>
  );
}
