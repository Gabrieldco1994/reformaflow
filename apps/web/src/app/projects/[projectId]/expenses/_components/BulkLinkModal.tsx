'use client';
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, CheckSquare, Square } from 'lucide-react';
import { api } from '@/lib/api';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import type { Expense, ExpensesPage } from '@/types';
import { getExpenseOptions } from '../_types';
import { selectEligibleForBulkLink } from '../_lib/bulkLinkEligibility';
import { getBulkLinkTargetProjects, type BulkLinkTargetProject } from '../_lib/bulkLinkTargetOptions';
import { buildBulkLinkTargetPayload } from '../_lib/bulkLinkPayload';
import { filterBulkLinkSources } from '../_lib/bulkLinkSearchFilter';
import { useBulkLinkExecution } from '../_hooks/useBulkLinkExecution';
import { currentMonthKey, expandExpenseOccurrences } from '../_lib/grouping-by-month';

type SourceFilter = 'all' | 'card' | 'bank';

interface Props {
  open: boolean;
  onClose: () => void;
  currentProjectId: string;
  /**
   * Despesas pré-selecionadas pelo chamador (ex: seleção via checkbox na lista
   * de ExpensesView). Quando omitido, o modal busca e lista TODAS as despesas
   * elegíveis do projeto, com checkbox própria de seleção (ex: entrada pela
   * Visão Conta).
   */
  preselectedSources?: Expense[];
  /** Mês inicial do filtro no selfSelectMode (formato YYYY-MM). Padrão: mês atual. */
  defaultMonth?: string;
}

interface RowChoice {
  targetProjectId: string;
  tipoDespesa: string;
}

/**
 * Modal "Vincular em massa": para cada despesa PESSOAL solta selecionada,
 * cria UMA despesa espelhada (valor integral, sem split) em outro projeto via
 * `ratear-mixed` — reaproveitando o mesmo motor do vínculo unitário. Usuário
 * só escolhe projeto destino + categoria por linha; título/valor/data são
 * copiados automaticamente da fonte.
 */
export function BulkLinkModal({ open, onClose, currentProjectId, preselectedSources, defaultMonth }: Props) {
  const queryClient = useQueryClient();
  const selfSelectMode = preselectedSources === undefined;

  const [monthFilter, setMonthFilter] = useState(defaultMonth ?? currentMonthKey());
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');

  // Sync month when prop changes (e.g. user navigates months and reopens)
  useEffect(() => {
    if (defaultMonth) setMonthFilter(defaultMonth);
  }, [defaultMonth]);

  const { data: projects = [] } = useQuery<BulkLinkTargetProject[]>({
    queryKey: ['tenant', 'projects'],
    queryFn: () => api.get('/projects'),
    staleTime: 60_000,
    enabled: open,
  });

  const { data: expensesPage } = useQuery<ExpensesPage>({
    queryKey: ['expenses', currentProjectId],
    queryFn: () => api.get(`/projects/${currentProjectId}/expenses?pageSize=2000`),
    enabled: open && selfSelectMode,
    staleTime: 20_000,
  });

  const eligible = useMemo(() => {
    const base = selfSelectMode
      ? selectEligibleForBulkLink(expensesPage?.items ?? [])
      : (preselectedSources ?? []);
    if (!selfSelectMode) return base;
    return base.filter((e) => {
      // Usa expandExpenseOccurrences — mesma lógica do agrupamento mensal, cobre parcelado/quinzenal/recorrente
      const inMonth = expandExpenseOccurrences(e).some((occ) => occ.occDate.slice(0, 7) === monthFilter);
      if (!inMonth) return false;
      if (sourceFilter === 'card') return !!e.cardLast4;
      if (sourceFilter === 'bank') return !!e.bankLast4;
      return true;
    });
  }, [selfSelectMode, expensesPage, preselectedSources, monthFilter, sourceFilter]);

  const [pickedIds, setPickedIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!selfSelectMode) return;
    setPickedIds(new Set()); // ponytail: começa vazio, usuário seleciona o que quer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selfSelectMode, open]);

  const [searchQuery, setSearchQuery] = useState('');
  const visible = useMemo(
    () => (selfSelectMode ? filterBulkLinkSources(eligible, searchQuery) : eligible),
    [selfSelectMode, eligible, searchQuery],
  );

  const sources = selfSelectMode ? eligible.filter((e) => pickedIds.has(e.id)) : eligible;

  const targetProjects = useMemo(
    () => getBulkLinkTargetProjects(projects, currentProjectId),
    [projects, currentProjectId],
  );

  const [choices, setChoices] = useState<Record<string, RowChoice>>({});
  const [confirmed, setConfirmed] = useState(false);

  const executionRows = useMemo(
    () =>
      sources.map((s) => {
        const choice = choices[s.id];
        return {
          sourceId: s.id,
          projectId: currentProjectId,
          payload: buildBulkLinkTargetPayload(s, {
            targetProjectId: choice?.targetProjectId ?? '',
            tipoDespesa: choice?.tipoDespesa ?? '',
          }),
        };
      }),
    [sources, choices, currentProjectId],
  );

  const { rows, execute } = useBulkLinkExecution(executionRows);
  const allChosen =
    sources.length > 0 && sources.every((s) => choices[s.id]?.targetProjectId && choices[s.id]?.tipoDespesa);
  const allDone = confirmed && rows.length > 0 && rows.every((r) => r.status === 'success');

  function setChoice(id: string, patch: Partial<RowChoice>) {
    setChoices((prev) => ({
      ...prev,
      [id]: { targetProjectId: prev[id]?.targetProjectId ?? '', tipoDespesa: prev[id]?.tipoDespesa ?? '', ...patch },
    }));
  }

  function togglePicked(id: string) {
    setPickedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleConfirm() {
    setConfirmed(true);
    await execute();
  }

  function handleClose() {
    if (allDone) {
      for (const key of ['expenses', 'cash-flow', 'dashboard', 'cross-project-expenses', 'account-view', 'monthly-overview']) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
    }
    setChoices({});
    setConfirmed(false);
    setSearchQuery('');
    setPickedIds(new Set());
    setSourceFilter('all');
    onClose();
  }

  return (
    <Modal open={open} onClose={handleClose} title="Vincular em massa">
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          Cada despesa abaixo vira uma despesa vinculada (valor integral, sem rateio) no projeto
          destino escolhido. Título, valor e data são copiados automaticamente — escolha só o
          projeto e a categoria.
        </p>

        {selfSelectMode && (
          <div className="flex flex-col gap-2" aria-label="Filtros">
            <input
              type="month"
              value={monthFilter}
              onChange={(e) => { setMonthFilter(e.target.value); setPickedIds(new Set()); }}
              disabled={confirmed}
              className="rounded-md border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-darc-maroon disabled:opacity-50"
            />
            <div className="flex gap-1">
              {(['all', 'card', 'bank'] as SourceFilter[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  disabled={confirmed}
                  onClick={() => { setSourceFilter(f); setPickedIds(new Set()); }}
                  className={`rounded-full border px-3 py-0.5 text-xs font-medium transition-colors disabled:opacity-50 ${sourceFilter === f ? 'border-darc-maroon bg-darc-maroon text-white' : 'border-gray-300 text-gray-600 hover:border-gray-400'}`}
                >
                  {f === 'all' ? 'Todos' : f === 'card' ? 'Cartão' : 'Banco'}
                </button>
              ))}
            </div>
          </div>
        )}

        {eligible.length === 0 && (
          <p className="text-sm text-gray-500">Nenhuma despesa elegível encontrada.</p>
        )}

        {selfSelectMode && eligible.length > 0 && (
          <Input
            type="text"
            placeholder="Buscar por título ou fornecedor..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            disabled={confirmed}
          />
        )}

        {selfSelectMode && eligible.length > 0 && visible.length === 0 && (
          <p className="text-sm text-gray-500">Nenhuma despesa encontrada para "{searchQuery}".</p>
        )}

        <div className="max-h-96 space-y-2 overflow-y-auto">
          {visible.map((s) => {
            const picked = selfSelectMode ? pickedIds.has(s.id) : true;
            const choice = choices[s.id];
            const targetProject = targetProjects.find((p) => p.id === choice?.targetProjectId) ?? null;
            const tipoOptions = targetProject ? getExpenseOptions(targetProject.type) : [];
            const row = rows.find((r) => r.sourceId === s.id);
            return (
              <div
                key={s.id}
                className={`rounded-lg border p-3 space-y-2 ${picked ? 'border-gray-200' : 'border-gray-100 opacity-50'}`}
              >
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-2 font-medium text-gray-900 truncate">
                    {selfSelectMode && (
                      <button
                        type="button"
                        onClick={() => togglePicked(s.id)}
                        disabled={confirmed}
                        aria-label={picked ? 'Remover da seleção' : 'Incluir na seleção'}
                      >
                        {picked ? (
                          <CheckSquare className="w-4 h-4 text-darc-maroon" />
                        ) : (
                          <Square className="w-4 h-4 text-gray-400" />
                        )}
                      </button>
                    )}
                    {s.titulo || s.fornecedor || '—'}
                  </span>
                  <span className="text-gray-500">
                    {formatCurrency(s.valorTotal / 100)}
                    {s.dataCompra ? ` · ${formatDateBR(s.dataCompra)}` : ''}
                  </span>
                </div>
                {picked && (
                  <div className="grid grid-cols-2 gap-2">
                    <Select
                      label="Projeto destino"
                      name={`target-${s.id}`}
                      options={targetProjects.map((p) => ({ value: p.id, label: p.name }))}
                      value={choice?.targetProjectId ?? ''}
                      onChange={(e) =>
                        setChoice(s.id, { targetProjectId: e.target.value, tipoDespesa: '' })
                      }
                      disabled={confirmed}
                    />
                    <Select
                      label="Categoria"
                      name={`tipo-${s.id}`}
                      options={tipoOptions}
                      value={choice?.tipoDespesa ?? ''}
                      onChange={(e) => setChoice(s.id, { tipoDespesa: e.target.value })}
                      disabled={confirmed || !targetProject}
                    />
                  </div>
                )}
                {row?.status === 'success' && (
                  <p className="text-xs font-medium text-emerald-700">✓ vinculada</p>
                )}
                {row?.status === 'error' && (
                  <p className="text-xs font-medium text-red-700">✗ falhou — tente novamente</p>
                )}
              </div>
            );
          })}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={handleClose}>
            {allDone ? 'Fechar' : 'Cancelar'}
          </Button>
          {!allDone && (
            <Button
              type="button"
              onClick={handleConfirm}
              disabled={sources.length === 0 || !allChosen}
            >
              <Link2 className="w-4 h-4" /> Vincular {sources.length > 0 ? `(${sources.length})` : ''}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
