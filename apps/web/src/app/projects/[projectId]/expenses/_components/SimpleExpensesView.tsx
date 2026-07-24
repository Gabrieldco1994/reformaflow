'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { useProject } from '@/contexts/project-context';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import type { Expense, ExpenseFormData, ExpensesPage } from '@/types';
import { getExpenseOptions } from '../_types';
import { SimpleExpenseRow } from './SimpleExpenseRow';
import { SimpleExpenseFormModal } from './SimpleExpenseFormModal';
import { invalidateExpenseQueries } from '../_hooks/useExpenseMutations';
import { effectiveDate } from '../_lib/grouping-by-month';

/**
 * Tela de despesas ENXUTA para CASA/CARRO (issue #292): lista simples no
 * padrão visual de MovimentacaoRow + criação/edição simples, sem import de
 * fatura/extrato e sem o wizard cross-project — ambos exclusivos da
 * complexidade do PESSOAL. O módulo `expenses` continua existindo (âncora
 * de vínculo/rateio feito a partir do PESSOAL — regras 14/15 — e fonte das
 * despesas de combustível do dashboard do CARRO, #289).
 */
export function SimpleExpensesView() {
  const { projectId: PROJECT_ID, projectType } = useProject();
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Expense | null>(null);

  const tipoDespesaOptions = useMemo(() => getExpenseOptions(projectType), [projectType]);
  const defaultTipoDespesa = tipoDespesaOptions[0]?.value ?? 'OUTROS';

  const { data: expensesPage, isLoading, isError } = useQuery<ExpensesPage>({
    queryKey: ['expenses', PROJECT_ID],
    queryFn: () => api.get(`/projects/${PROJECT_ID}/expenses?pageSize=2000`),
  });
  const expenses = expensesPage?.items ?? [];

  const sorted = useMemo(
    () =>
      [...expenses].sort((a, b) => {
        const da = effectiveDate(a) ?? '';
        const db = effectiveDate(b) ?? '';
        return da < db ? 1 : da > db ? -1 : 0;
      }),
    [expenses],
  );

  function invalidate() {
    invalidateExpenseQueries(queryClient, PROJECT_ID);
  }

  const createMutation = useMutation({
    mutationFn: (data: ExpenseFormData) => api.post(`/projects/${PROJECT_ID}/expenses`, data),
    onSuccess: () => {
      invalidate();
      setFormOpen(false);
      toast.success('Despesa criada.');
    },
    onError: () => toast.error('Falha ao criar despesa.'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: ExpenseFormData }) =>
      api.patch(`/projects/${PROJECT_ID}/expenses/${id}`, data),
    onSuccess: () => {
      invalidate();
      setFormOpen(false);
      setEditing(null);
      toast.success('Despesa atualizada.');
    },
    onError: () => toast.error('Falha ao atualizar despesa.'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${PROJECT_ID}/expenses/${id}`),
    onSuccess: () => {
      invalidate();
      setFormOpen(false);
      setEditing(null);
      toast.success('Despesa excluída.');
    },
    onError: () => toast.error('Falha ao excluir despesa.'),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.patch(`/projects/${PROJECT_ID}/expenses/${id}`, { status }),
    onSuccess: () => invalidate(),
    onError: () => toast.error('Falha ao atualizar status.'),
  });

  function openCreate() {
    setEditing(null);
    setFormOpen(true);
  }

  function openEdit(expense: Expense) {
    setEditing(expense);
    setFormOpen(true);
  }

  function handleSave(data: ExpenseFormData, editingId: string | null) {
    if (editingId) updateMutation.mutate({ id: editingId, data });
    else createMutation.mutate(data);
  }

  function handleToggleStatus(id: string, currentStatus: string) {
    toggleMutation.mutate({ id, status: currentStatus === 'PAGO' ? 'PLANEJADO' : 'PAGO' });
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-lifeone-ink-3">
          Despesas
        </p>
        <Button size="sm" onClick={openCreate} className="gap-1.5">
          <Plus className="h-4 w-4" /> Nova despesa
        </Button>
      </div>

      {isLoading && (
        <p className="px-1 text-sm text-lifeone-ink-3">Carregando despesas…</p>
      )}
      {isError && (
        <p className="px-1 text-sm text-[#D92D20]">Falha ao carregar despesas.</p>
      )}
      {!isLoading && !isError && sorted.length === 0 && (
        <div className="rounded-xl border border-dashed border-lifeone-hairline bg-lifeone-card px-4 py-8 text-center">
          <p className="text-sm text-lifeone-ink-3">Nenhuma despesa cadastrada ainda.</p>
        </div>
      )}

      <div className="space-y-2">
        {sorted.map((expense) => (
          <SimpleExpenseRow
            key={expense.id}
            expense={expense}
            onEdit={openEdit}
            onToggleStatus={handleToggleStatus}
            onDelete={(id) => deleteMutation.mutate(id)}
          />
        ))}
      </div>

      <SimpleExpenseFormModal
        open={formOpen}
        editing={editing}
        tipoDespesaOptions={tipoDespesaOptions}
        defaultTipoDespesa={defaultTipoDespesa}
        onClose={() => {
          setFormOpen(false);
          setEditing(null);
        }}
        onSave={handleSave}
        onDelete={(id) => deleteMutation.mutate(id)}
        saving={createMutation.isPending || updateMutation.isPending || deleteMutation.isPending}
      />
    </div>
  );
}
