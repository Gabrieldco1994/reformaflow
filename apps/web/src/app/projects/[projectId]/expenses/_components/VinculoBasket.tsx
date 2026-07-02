'use client';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Trash2, Plus, X } from 'lucide-react';
import { isNeutralExpenseType } from '@reformaflow/domain';
import { api } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { formatCurrency } from '@/lib/utils';
import { tipoLabel } from '@/lib/expense-options';
import { reaisToCents, centsToReais } from '../_lib/money';
import { WizardFonteResumo } from './WizardFonteResumo';
import { LinkedExpenseFields } from './LinkedExpenseFields';
import type {
  BasketRow,
  WizardDraft,
  WizardAction,
} from '../_hooks/useNovaDespesaWizard';
import type { CrossExpenseLite, NewTargetDraft } from '../_types';

/** Despesa-alvo (cross-project) retornada pela busca. */
interface CrossExpense {
  id: string;
  titulo?: string | null;
  fornecedor?: string | null;
  tipoDespesa?: string | null;
  valorTotal: number; // centavos
  status: string;
  project?: { id: string; name: string; type: string } | null;
}

interface Props {
  /** Projeto DONO da compra-fonte (usado na busca cross-project e p/ filtrar). */
  projectId: string;
  draft: WizardDraft;
  basket: BasketRow[];
  totals: { totalFonteCents: number; sobraCents: number };
  canSave: boolean;
  dispatch: (action: WizardAction) => void;
  onConfirm: () => void;
  saving: boolean;
}

function mapToLite(exp: CrossExpense): CrossExpenseLite {
  return {
    id: exp.id,
    titulo: exp.titulo ?? exp.fornecedor ?? null,
    tipoDespesa: exp.tipoDespesa ?? null,
    valorTotal: exp.valorTotal,
    projectId: exp.project?.id,
    projectName: exp.project?.name ?? null,
  };
}

/**
 * Passo CESTO: distribui a compra-fonte entre despesas de OUTROS projetos —
 * mistura alvos EXISTENTES (busca cross-project) e NOVOS (LinkedExpenseFields).
 * Baseado na estética/mecânica do `RatearCompraModal` (busca + linhas + sobra),
 * porém para linhas mistas. NÃO altera o `RatearCompraModal`.
 */
export function VinculoBasket({
  projectId,
  draft,
  basket,
  totals,
  canSave,
  dispatch,
  onConfirm,
  saving,
}: Props) {
  const [search, setSearch] = useState('');
  const [projectFilter, setProjectFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [tipoFilter, setTipoFilter] = useState('');
  const [minReais, setMinReais] = useState('');
  const [maxReais, setMaxReais] = useState('');
  const [creatingNew, setCreatingNew] = useState(false);
  /** Buffer de string por linha p/ o input de alocação (reaisToCents no dispatch). */
  const [rawAlloc, setRawAlloc] = useState<Record<string, string>>({});

  const { totalFonteCents, sobraCents } = totals;
  const allocatedCents = totalFonteCents - sobraCents;

  const queryStr = useMemo(() => {
    const p = new URLSearchParams();
    p.set('limit', '30');
    if (search.trim()) p.set('search', search.trim());
    if (projectFilter) p.set('targetProjectId', projectFilter);
    if (statusFilter) p.set('status', statusFilter);
    return p.toString();
  }, [search, projectFilter, statusFilter]);

  const { data: crossExpenses = [], isFetching } = useQuery<CrossExpense[]>({
    queryKey: ['cross-project-expenses', projectId, 'basket', queryStr],
    queryFn: () => api.get(`/projects/${projectId}/expenses/cross-project?${queryStr}`),
    staleTime: 15_000,
  });

  // Filtros client-side (tipo / faixa de valor) + oculta candidatos inválidos:
  // neutros, do mesmo projeto da fonte e os já presentes no cesto.
  const minCents = reaisToCents(minReais);
  const maxCents = reaisToCents(maxReais);
  const inBasketIds = useMemo(
    () => new Set(basket.filter((r) => r.kind === 'EXISTING').map((r) => (r as { target: CrossExpenseLite }).target.id)),
    [basket],
  );
  const tipoOptions = useMemo(() => {
    const set = new Map<string, string>();
    for (const e of crossExpenses) {
      if (e.tipoDespesa) set.set(e.tipoDespesa, tipoLabel(e.tipoDespesa));
    }
    return [{ value: '', label: 'Todos os tipos' }, ...[...set].map(([value, label]) => ({ value, label }))];
  }, [crossExpenses]);

  const available = useMemo(
    () =>
      crossExpenses.filter((e) => {
        if (inBasketIds.has(e.id)) return false;
        if (e.project?.id === projectId) return false; // mesmo projeto da fonte
        if (isNeutralExpenseType(e.tipoDespesa)) return false; // neutras não vinculam
        if (tipoFilter && e.tipoDespesa !== tipoFilter) return false;
        if (minCents > 0 && e.valorTotal < minCents) return false;
        if (maxCents > 0 && e.valorTotal > maxCents) return false;
        return true;
      }),
    [crossExpenses, inBasketIds, projectId, tipoFilter, minCents, maxCents],
  );

  function addExisting(exp: CrossExpense) {
    dispatch({ type: 'BASKET_ADD_EXISTING', target: mapToLite(exp) });
    setSearch('');
  }

  function addNew(newDraft: NewTargetDraft) {
    dispatch({ type: 'BASKET_ADD_NEW', draft: newDraft });
    setCreatingNew(false);
  }

  function onAllocChange(row: BasketRow, raw: string) {
    setRawAlloc((p) => ({ ...p, [row.id]: raw }));
    dispatch({ type: 'BASKET_SET_ALLOC', id: row.id, cents: reaisToCents(raw) });
  }

  function onFill(row: BasketRow) {
    dispatch({ type: 'BASKET_FILL_REMAINING', id: row.id });
    setRawAlloc((p) => {
      const next = { ...p };
      delete next[row.id];
      return next;
    });
  }

  function allocValue(row: BasketRow): string {
    return rawAlloc[row.id] ?? (row.allocation ? centsToReais(row.allocation) : '');
  }

  function rowTitle(row: BasketRow): string {
    if (row.kind === 'EXISTING') {
      return row.target.titulo || tipoLabel(row.target.tipoDespesa ?? '') || 'Despesa';
    }
    return row.draft.titulo || tipoLabel(row.draft.tipoDespesa ?? '') || 'Nova despesa';
  }

  return (
    <div className="space-y-4">
      <WizardFonteResumo draft={draft} totalCents={totalFonteCents} />

      {/* Busca + filtros D5 */}
      <div className="space-y-2">
        <Input
          placeholder="Buscar despesa por título ou fornecedor…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="grid grid-cols-2 gap-2">
          <Select
            label=""
            name="statusFilter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            options={[
              { value: '', label: 'Qualquer status' },
              { value: 'PLANEJADO', label: 'Planejado' },
              { value: 'PAGO', label: 'Pago' },
            ]}
          />
          <Select
            label=""
            name="tipoFilter"
            value={tipoFilter}
            onChange={(e) => setTipoFilter(e.target.value)}
            options={tipoOptions}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Input
            placeholder="Valor mín. (R$)"
            inputMode="decimal"
            value={minReais}
            onChange={(e) => setMinReais(e.target.value)}
          />
          <Input
            placeholder="Valor máx. (R$)"
            inputMode="decimal"
            value={maxReais}
            onChange={(e) => setMaxReais(e.target.value)}
          />
        </div>
      </div>

      {/* Resultados da busca */}
      <div className="max-h-48 overflow-auto rounded border border-gray-200 bg-white text-sm shadow-sm">
        {isFetching && <div className="px-3 py-2 text-gray-500">Buscando…</div>}
        {!isFetching && available.length === 0 && (
          <div className="px-3 py-2 text-gray-500">Nenhuma despesa disponível.</div>
        )}
        {available.map((exp) => (
          <button
            key={exp.id}
            type="button"
            className="block w-full px-3 py-2 text-left hover:bg-blue-50 min-h-[44px]"
            onClick={() => addExisting(exp)}
          >
            <div className="truncate font-medium text-gray-900">
              {exp.titulo || exp.fornecedor || tipoLabel(exp.tipoDespesa ?? '') || '—'}
            </div>
            <div className="text-xs text-gray-500">
              {formatCurrency(exp.valorTotal / 100)} · {exp.status} · {exp.project?.name ?? '—'}
            </div>
          </button>
        ))}
      </div>

      {creatingNew ? (
        <LinkedExpenseFields
          currentProjectId={projectId}
          source={draft}
          onAdd={addNew}
          onCancel={() => setCreatingNew(false)}
        />
      ) : (
        <Button type="button" variant="secondary" className="w-full" onClick={() => setCreatingNew(true)}>
          <Plus className="h-4 w-4" /> Criar nova despesa
        </Button>
      )}

      {/* Linhas do cesto */}
      {basket.length > 0 && (
        <div className="space-y-2">
          {basket.map((row) => (
            <div
              key={row.id}
              className="flex items-center gap-2 rounded-lg border border-darc-linen px-2 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-darc-velvet">
                  {rowTitle(row)}
                  {row.kind === 'NEW' && (
                    <span className="ml-1 rounded bg-blue-100 px-1 text-[10px] font-semibold text-blue-700">
                      NOVA
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-darc-velvet/50">
                  {row.kind === 'EXISTING'
                    ? `orçado ${centsToReais(row.target.valorTotal ?? 0)} → real`
                    : `${row.draft.targetProjectId ? 'novo alvo' : ''} → real`}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-xs text-darc-velvet/50">R$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  aria-label={`Valor real de ${rowTitle(row)}`}
                  className="w-24 rounded border border-gray-300 px-2 py-1 text-right text-sm tabular-nums focus:border-blue-400 focus:outline-none"
                  value={allocValue(row)}
                  onChange={(e) => onAllocChange(row, e.target.value)}
                />
              </div>
              <button
                type="button"
                title="Preencher com a sobra"
                onClick={() => onFill(row)}
                className="rounded px-1.5 py-1 text-[11px] font-medium text-blue-700 hover:bg-blue-50"
              >
                sobra
              </button>
              <button
                type="button"
                title="Remover"
                onClick={() => dispatch({ type: 'BASKET_REMOVE', id: row.id })}
                className="rounded p-1 text-darc-velvet/30 hover:bg-red-50 hover:text-red-500"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Totais */}
      <div className="grid grid-cols-3 gap-2 rounded-xl border border-darc-linen bg-white px-3 py-2 text-center">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-darc-velvet/50">Total</p>
          <p className="text-sm font-semibold tabular-nums text-darc-velvet">
            {formatCurrency(totalFonteCents / 100)}
          </p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-darc-velvet/50">Alocado</p>
          <p className="text-sm font-semibold tabular-nums text-darc-velvet">
            {formatCurrency(allocatedCents / 100)}
          </p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-darc-velvet/50">Sobra</p>
          <p
            className={`text-sm font-semibold tabular-nums ${
              sobraCents === 0 ? 'text-emerald-600' : sobraCents < 0 ? 'text-red-600' : 'text-amber-600'
            }`}
          >
            {formatCurrency(sobraCents / 100)}
          </p>
        </div>
      </div>

      {sobraCents !== 0 && basket.length > 0 && (
        <p className="flex items-center gap-1 text-xs text-amber-700">
          <X className="h-3.5 w-3.5" />A soma precisa fechar o total da compra (sobra zero) para salvar.
        </p>
      )}

      <Button type="button" className="w-full" onClick={onConfirm} disabled={!canSave || saving}>
        {saving ? 'Salvando…' : `Realizar vínculo (${basket.length})`}
      </Button>
    </div>
  );
}
