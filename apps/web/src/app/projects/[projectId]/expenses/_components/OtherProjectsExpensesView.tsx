'use client';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Link2, Unlink, ExternalLink, Search } from 'lucide-react';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import type { Expense } from '@/types';

interface CrossExpense {
  id: string;
  projectId: string;
  tipoDespesa: string;
  titulo?: string | null;
  fornecedor?: string | null;
  valorTotal: number;
  status: string;
  dataPagamento?: string | null;
  formaPagamento: string;
  project?: { id: string; name: string; type: string } | null;
}

interface Props {
  projectId: string;
  /** Despesas do projeto atual — para detectar quais já estão linkadas. */
  localExpenses: Expense[];
}

/**
 * Aba "Outras despesas": lista despesas dos outros projetos do tenant.
 * Permite:
 *  - filtrar por projeto/status/texto
 *  - ver quais já estão vinculadas a despesas locais
 *  - vincular uma despesa LOCAL existente a uma despesa REMOTA via modal de seleção
 *  - desvincular
 *  - abrir a despesa no projeto remoto
 */
export function OtherProjectsExpensesView({ projectId, localExpenses }: Props) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [filterProject, setFilterProject] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  const { data: cross = [], isLoading } = useQuery<CrossExpense[]>({
    queryKey: ['cross-project-expenses', projectId, 'view', search, filterProject, filterStatus],
    queryFn: () => {
      const qs: string[] = ['limit=200'];
      if (search.trim()) qs.push(`search=${encodeURIComponent(search.trim())}`);
      if (filterProject) qs.push(`targetProjectId=${filterProject}`);
      if (filterStatus) qs.push(`status=${filterStatus}`);
      return api.get(`/projects/${projectId}/expenses/cross-project?${qs.join('&')}`);
    },
    staleTime: 30_000,
  });

  // Mapa local: linkedExpenseId → expense daqui (mostra quais já são vinculadas)
  const localByLinkedId = useMemo(() => {
    const map = new Map<string, Expense>();
    for (const e of localExpenses) {
      if (e.linkedExpenseId) map.set(e.linkedExpenseId, e);
    }
    return map;
  }, [localExpenses]);

  const projectOptions = useMemo(() => {
    const seen = new Map<string, { id: string; name: string }>();
    for (const e of cross) {
      if (e.project?.id && !seen.has(e.project.id)) {
        seen.set(e.project.id, { id: e.project.id, name: e.project.name });
      }
    }
    return [
      { value: '', label: 'Todos os projetos' },
      ...Array.from(seen.values()).map((p) => ({ value: p.id, label: p.name })),
    ];
  }, [cross]);

  const [pickerOpen, setPickerOpen] = useState<{ targetId: string; targetLabel: string } | null>(null);

  const linkMutation = useMutation({
    mutationFn: ({ localId, targetId }: { localId: string; targetId: string }) =>
      api.post(`/projects/${projectId}/expenses/${localId}/link`, { targetExpenseId: targetId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['expenses', projectId] });
      queryClient.invalidateQueries({ queryKey: ['cross-project-expenses', projectId] });
      setPickerOpen(null);
    },
  });

  const unlinkMutation = useMutation({
    mutationFn: ({ localId }: { localId: string }) =>
      api.delete(`/projects/${projectId}/expenses/${localId}/link`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['expenses', projectId] });
      queryClient.invalidateQueries({ queryKey: ['cross-project-expenses', projectId] });
    },
  });

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-gray-200 bg-white p-3">
        <p className="text-sm text-gray-700">
          Despesas dos seus outros projetos. Você pode vincular uma despesa daqui a uma de outro
          projeto para evitar dupla contagem (ex.: pagou material da reforma com o cartão pessoal).
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <Input
            className="pl-7"
            placeholder="Buscar por título ou fornecedor…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select
          options={projectOptions}
          value={filterProject}
          onChange={(e) => setFilterProject(e.target.value)}
        />
        <Select
          options={[
            { value: '', label: 'Todos status' },
            { value: 'PLANEJADO', label: 'Planejado' },
            { value: 'PAGO', label: 'Pago' },
          ]}
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
        />
      </div>

      {isLoading ? (
        <div className="rounded-lg border bg-white p-6 text-center text-gray-500">Carregando…</div>
      ) : cross.length === 0 ? (
        <div className="rounded-lg border bg-white p-6 text-center text-gray-500">
          Nenhuma despesa nos outros projetos com esses filtros.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">Projeto</th>
                <th className="px-3 py-2 text-left">Despesa</th>
                <th className="px-3 py-2 text-right">Valor</th>
                <th className="px-3 py-2 text-left">Data</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Vínculo</th>
                <th className="px-3 py-2 text-right">Ações</th>
              </tr>
            </thead>
            <tbody>
              {cross.map((exp) => {
                const linkedLocal = localByLinkedId.get(exp.id);
                return (
                  <tr key={exp.id} className="border-t hover:bg-gray-50">
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium text-gray-700">
                        {exp.project?.name ?? '—'}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-gray-900 truncate max-w-xs">
                        {exp.titulo || exp.fornecedor || '—'}
                      </div>
                      {exp.fornecedor && exp.titulo && (
                        <div className="text-xs text-gray-500 truncate max-w-xs">{exp.fornecedor}</div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{formatCurrency(exp.valorTotal / 100)}</td>
                    <td className="px-3 py-2 text-gray-600">
                      {exp.dataPagamento ? formatDateBR(exp.dataPagamento) : '—'}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${
                          exp.status === 'PAGO' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'
                        }`}
                      >
                        {exp.status}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {linkedLocal ? (
                        <span className="inline-flex items-center gap-1 text-xs text-blue-700">
                          <Link2 className="w-3 h-3" /> {linkedLocal.titulo || linkedLocal.fornecedor || 'Despesa daqui'}
                        </span>
                      ) : (
                        <span className="text-xs text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex gap-1">
                        {linkedLocal ? (
                          <button
                            type="button"
                            className="rounded border border-red-200 px-2 py-0.5 text-xs text-red-700 hover:bg-red-50"
                            onClick={() => unlinkMutation.mutate({ localId: linkedLocal.id })}
                            disabled={unlinkMutation.isPending}
                          >
                            <Unlink className="inline w-3 h-3 mr-0.5" />
                            Desvincular
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="rounded border border-blue-200 px-2 py-0.5 text-xs text-blue-700 hover:bg-blue-50"
                            onClick={() =>
                              setPickerOpen({
                                targetId: exp.id,
                                targetLabel: `${exp.titulo || exp.fornecedor || '—'} · ${formatCurrency(exp.valorTotal / 100)}`,
                              })
                            }
                          >
                            <Link2 className="inline w-3 h-3 mr-0.5" />
                            Vincular
                          </button>
                        )}
                        {exp.project?.id && (
                          <a
                            href={`/projects/${exp.project.id}/expenses`}
                            target="_blank"
                            rel="noreferrer"
                            className="rounded border border-gray-200 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50"
                          >
                            <ExternalLink className="inline w-3 h-3" />
                          </a>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {pickerOpen && (
        <LocalPickerModal
          projectId={projectId}
          localExpenses={localExpenses}
          targetId={pickerOpen.targetId}
          targetLabel={pickerOpen.targetLabel}
          onClose={() => setPickerOpen(null)}
          onPick={(localId) => linkMutation.mutate({ localId, targetId: pickerOpen.targetId })}
          submitting={linkMutation.isPending}
        />
      )}
    </div>
  );
}

interface LocalPickerProps {
  projectId: string;
  localExpenses: Expense[];
  targetId: string;
  targetLabel: string;
  onPick: (localId: string) => void;
  onClose: () => void;
  submitting: boolean;
}

function LocalPickerModal({
  localExpenses,
  targetLabel,
  onPick,
  onClose,
  submitting,
}: LocalPickerProps) {
  const [text, setText] = useState('');
  const filtered = useMemo(() => {
    const q = text.trim().toLowerCase();
    const arr = localExpenses.filter((e) => !e.linkedExpenseId);
    if (!q) return arr.slice(0, 50);
    return arr
      .filter((e) =>
        (e.titulo ?? '').toLowerCase().includes(q) ||
        (e.fornecedor ?? '').toLowerCase().includes(q),
      )
      .slice(0, 50);
  }, [localExpenses, text]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b px-4 py-3">
          <h3 className="text-sm font-semibold text-gray-900">Vincular a despesa local</h3>
          <p className="mt-0.5 text-xs text-gray-500 truncate">Alvo: {targetLabel}</p>
        </div>
        <div className="space-y-2 p-4">
          <Input
            placeholder="Buscar nas despesas deste projeto…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <div className="max-h-64 overflow-auto rounded border border-gray-200 bg-white text-sm">
            {filtered.length === 0 && (
              <div className="px-3 py-2 text-gray-500">Nenhuma despesa daqui sem vínculo.</div>
            )}
            {filtered.map((e) => (
              <button
                key={e.id}
                type="button"
                className="block w-full px-3 py-1.5 text-left hover:bg-orange-50 disabled:opacity-50"
                disabled={submitting}
                onClick={() => onPick(e.id)}
              >
                <div className="font-medium text-gray-900 truncate">
                  {e.titulo || e.fornecedor || '—'}
                </div>
                <div className="text-xs text-gray-500">
                  {formatCurrency(e.valorTotal / 100)} · {e.status}
                </div>
              </button>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t px-4 py-3">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancelar
          </Button>
        </div>
      </div>
    </div>
  );
}
