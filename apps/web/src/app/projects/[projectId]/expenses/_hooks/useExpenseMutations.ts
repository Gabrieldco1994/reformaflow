'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { Expense, ExpenseFormData } from '@/types';
import type { ExpenseType } from '@reformaflow/domain';
import { type InlineNewRow, makeEmptyNewRow } from '../_types';

/** True se a despesa tem ao menos uma parcela marcada como paga (paidParcelas). */
function hasAnyPaidParcela(raw: string | null | undefined, total: number): boolean {
  if (!raw) return false;
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return false;
    return arr.some((v) => {
      const i = Number(v);
      return Number.isInteger(i) && i >= 0 && i < total;
    });
  } catch {
    return false;
  }
}

interface UseExpenseMutationsParams {
  /** Projeto "dono" da tela (self). */
  projectId: string;
  /** Base consolidada (self + cross-project) para resolver projeto dono e estado de parcelas. */
  allExpensesPersonal: Expense[];
  defaultExpenseType: ExpenseType;
  /** Fecha o modal de formulário (create/update). */
  closeFormModal: () => void;
  setShowNewRow: (v: boolean) => void;
  setNewRow: (r: InlineNewRow) => void;
  setPayModalOpen: (v: boolean) => void;
}

/**
 * Encapsula todas as mutations de despesa (create/update/delete/pay, toggles,
 * edição rápida, bulk e conciliação) + as funções `invalidate` e
 * `resolveOwnerProjectId` que só elas usam. Extraído de ExpensesView para
 * reduzir o tamanho do componente sem mudar comportamento.
 */
export function useExpenseMutations({
  projectId,
  allExpensesPersonal,
  defaultExpenseType,
  closeFormModal,
  setShowNewRow,
  setNewRow,
  setPayModalOpen,
}: UseExpenseMutationsParams) {
  const queryClient = useQueryClient();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['expenses', projectId] });
    queryClient.invalidateQueries({ queryKey: ['dashboard', projectId] });
    queryClient.invalidateQueries({ queryKey: ['cash-flow', projectId] });
    queryClient.invalidateQueries({ queryKey: ['cross-project-expenses', projectId] });
    // Visão Conta / Visão Mês são caixa: qualquer mutação de despesa pode movê-las.
    queryClient.invalidateQueries({ queryKey: ['account-view', projectId] });
    queryClient.invalidateQueries({ queryKey: ['monthly-overview', projectId] });
  };

  // Na visão consolidada (PESSOAL) as despesas de outros projetos aparecem como itens.
  // Mutations (editar/excluir/status) precisam apontar para o projeto DONO da despesa,
  // senão a API responde "Despesa não encontrada".
  const resolveOwnerProjectId = (id: string) => {
    const exp = allExpensesPersonal.find((e) => e.id === id);
    return exp?.project?.id ?? exp?.projectId ?? projectId;
  };

  const createMutation = useMutation({
    mutationFn: (data: ExpenseFormData) => api.post(`/projects/${projectId}/expenses`, data),
    onSuccess: () => {
      toast.success('Despesa criada com sucesso');
      invalidate();
      closeFormModal();
      setShowNewRow(false);
      setNewRow(makeEmptyNewRow(defaultExpenseType));
    },
    onError: (e: Error) => {
      console.error('[expenses] create failed', e);
      toast.error(`Erro ao criar despesa: ${e.message}`);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: ExpenseFormData }) =>
      api.patch(`/projects/${resolveOwnerProjectId(id)}/expenses/${id}`, data),
    onSuccess: () => {
      toast.success('Despesa atualizada com sucesso');
      invalidate();
      closeFormModal();
    },
    onError: (e: Error) => {
      console.error('[expenses] update failed', e);
      toast.error(`Erro ao salvar despesa: ${e.message}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${resolveOwnerProjectId(id)}/expenses/${id}`),
    onSuccess: () => {
      toast.success('Despesa excluída com sucesso');
      invalidate();
    },
    onError: (e: Error) => {
      console.error('[expenses] delete failed', e);
      toast.error(`Erro ao excluir despesa: ${e.message}`);
    },
  });

  const payMutation = useMutation({
    mutationFn: (id: string) => api.post(`/projects/${projectId}/expenses/${id}/pay`, {}),
    onSuccess: () => {
      toast.success('Despesa marcada como paga');
      invalidate();
      setPayModalOpen(false);
    },
    onError: (e: Error) => {
      console.error('[expenses] pay failed', e);
      toast.error(`Erro ao pagar despesa: ${e.message}`);
    },
  });

  // Toggle rápido de status (PAGO ↔ PLANEJADO)
  const toggleStatusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'PAGO' | 'PLANEJADO' }) =>
      api.patch(`/projects/${resolveOwnerProjectId(id)}/expenses/${id}`, { status }),
    onSuccess: invalidate,
    onError: (e: Error) => {
      console.error('[expenses] toggle status failed', e);
      toast.error(`Erro ao alterar status: ${e.message}`);
    },
  });

  // Toggle de status de UMA parcela específica (quinzena/parcela individual)
  const toggleParcelaMutation = useMutation({
    mutationFn: ({ id, parcela, paid }: { id: string; parcela: number; paid: boolean }) =>
      api.patch(`/projects/${resolveOwnerProjectId(id)}/expenses/${id}/parcela`, { parcela, paid }),
    onSuccess: invalidate,
    onError: (e: Error) => {
      console.error('[expenses] toggle parcela failed', e);
      toast.error(`Erro ao alterar parcela: ${e.message}`);
    },
  });

  // Edição rápida (valor + data)
  const quickUpdateMutation = useMutation({
    mutationFn: ({ id, valorTotal, dataPagamento, quantidade }: { id: string; valorTotal: number; dataPagamento: string; quantidade: number }) => {
      const valorUnit = quantidade > 0 ? valorTotal / quantidade : valorTotal;
      // Parcelada planejada (sem parcela paga): mover também dataInicioParcela,
      // senão a 1ª parcela continua presa ao mês antigo na visão Mês. Com parcela
      // paga, só dataPagamento (não resetar paidParcelas).
      const exp = allExpensesPersonal.find((e) => e.id === id);
      const n = exp?.quantidadeParcela ?? 1;
      const isInstallment =
        (exp?.formaPagamento === 'PARCELADO' || exp?.formaPagamento === 'QUINZENAL') && n > 1;
      const hasPaidParcela = exp?.status === 'PAGO' || hasAnyPaidParcela(exp?.paidParcelas, n);
      return api.patch(`/projects/${resolveOwnerProjectId(id)}/expenses/${id}`, {
        valor: valorUnit,
        dataPagamento,
        ...(isInstallment && !hasPaidParcela ? { dataInicioParcela: dataPagamento } : {}),
      });
    },
    onSuccess: invalidate,
    onError: (e: Error) => {
      console.error('[expenses] quick update failed', e);
      toast.error(`Erro ao atualizar: ${e.message}`);
    },
  });

  // Troca rápida da categoria (tipo de despesa) direto na lista — igual ao toggle de status.
  const changeTipoMutation = useMutation({
    mutationFn: ({ id, tipoDespesa }: { id: string; tipoDespesa: string }) =>
      api.patch(`/projects/${resolveOwnerProjectId(id)}/expenses/${id}`, { tipoDespesa }),
    onSuccess: invalidate,
    onError: (e: Error) => {
      console.error('[expenses] change tipo failed', e);
      toast.error(`Erro ao alterar categoria: ${e.message}`);
    },
  });

  // Alteração de data em bulk: aplica a nova data às despesas selecionadas.
  // - À vista/avulsa: muda `dataPagamento`.
  // - Parcelada (3x etc.) SEM nenhuma parcela paga: muda também `dataInicioParcela`
  //   para mover de fato as parcelas (o backend reseta paidParcelas, mas como não
  //   há parcela paga, é no-op — regra de negócio preservada).
  // - Parcelada COM parcela(s) paga(s): só `dataPagamento`, para NÃO resetar o
  //   índice de parcelas pagas.
  const bulkDateMutation = useMutation({
    mutationFn: async ({ ids, dataPagamento }: { ids: string[]; dataPagamento: string }) => {
      // Sequencial de propósito: SQLite serializa escritas e PATCHs concorrentes
      // (Promise.all) podem disparar "database is locked" → 500.
      for (const id of ids) {
        const exp = allExpensesPersonal.find((e) => e.id === id);
        const n = exp?.quantidadeParcela ?? 1;
        const isInstallment =
          (exp?.formaPagamento === 'PARCELADO' || exp?.formaPagamento === 'QUINZENAL') && n > 1;
        const hasPaidParcela = exp?.status === 'PAGO' || hasAnyPaidParcela(exp?.paidParcelas, n);
        const payload: Record<string, string> =
          isInstallment && !hasPaidParcela
            ? { dataPagamento, dataInicioParcela: dataPagamento }
            : { dataPagamento };
        await api.patch(`/projects/${resolveOwnerProjectId(id)}/expenses/${id}`, payload);
      }
    },
    onSuccess: (_d, vars) => {
      invalidate();
      toast.success(`Data alterada em ${vars.ids.length} ${vars.ids.length === 1 ? 'despesa' : 'despesas'}`);
    },
    onError: (e: Error) => {
      console.error('[expenses] bulk date failed', e);
      toast.error(`Erro ao alterar data: ${e.message}`);
    },
  });

  const bulkPaidMutation = useMutation({
    mutationFn: async ({ ids }: { ids: string[] }) => {
      // Sequencial de propósito: SQLite serializa escritas e PATCHs concorrentes
      // (Promise.all) podem disparar "database is locked" → 500.
      // Despesas cross-project (alvo de OUTRO projeto exibido no PESSOAL) NÃO podem
      // ser marcadas PAGO em massa: isso as faz sumir da Visão Conta (não gera o
      // espelho/movimento). São puladas aqui; o usuário quita cada uma pelo modal.
      let skipped = 0;
      for (const id of ids) {
        const owner = resolveOwnerProjectId(id);
        if (owner !== projectId) {
          skipped += 1;
          continue;
        }
        await api.patch(`/projects/${owner}/expenses/${id}`, { status: 'PAGO' });
      }
      return { skipped, total: ids.length };
    },
    onSuccess: (res) => {
      invalidate();
      const done = res.total - res.skipped;
      if (done > 0) {
        toast.success(`${done} ${done === 1 ? 'despesa marcada' : 'despesas marcadas'} como pago`);
      }
      if (res.skipped > 0) {
        toast.info(
          `${res.skipped} despesa(s) de outro projeto foram ignoradas — quite cada uma pelo botão "Quitar".`,
        );
      }
    },
    onError: (e: Error) => {
      console.error('[expenses] bulk paid failed', e);
      toast.error(`Erro ao marcar como pago: ${e.message}`);
    },
  });

  // Conciliação cross-project por parcela (vínculo manual — Fase 6). Liquida a
  // parcela escolhida do alvo com o valor desta despesa.
  const conciliarMutation = useMutation({
    mutationFn: ({ sourceId, targetExpenseId, parcelaIndex }: { sourceId: string; targetExpenseId: string; parcelaIndex: number }) =>
      api.post(`/projects/${projectId}/expenses/${sourceId}/conciliar-parcela`, { targetExpenseId, parcelaIndex }),
    onSuccess: () => {
      invalidate();
      toast.success('Despesa conciliada com a parcela do outro projeto');
    },
    onError: (e: Error) => {
      console.error('[expenses] conciliar failed', e);
      toast.error(`Erro ao conciliar parcela: ${e.message}`);
    },
  });

  // Rateio: distribui UMA compra (fonte, PESSOAL) entre N planejadas de outro
  // projeto. A soma das alocações fecha o total da compra (Sobra = 0).
  const ratearMutation = useMutation({
    mutationFn: ({
      sourceId,
      allocations,
    }: {
      sourceId: string;
      allocations: { targetExpenseId: string; allocation: number }[];
    }) =>
      api.post(`/projects/${resolveOwnerProjectId(sourceId)}/expenses/${sourceId}/ratear`, {
        allocations,
      }),
    onSuccess: (_d, vars) => {
      invalidate();
      toast.success(`Compra rateada em ${vars.allocations.length} ${vars.allocations.length === 1 ? 'planejada' : 'planejadas'}`);
    },
    onError: (e: Error) => {
      console.error('[expenses] ratear failed', e);
      toast.error(`Erro ao ratear compra: ${e.message}`);
    },
  });

  const desratearMutation = useMutation({
    mutationFn: ({ sourceId }: { sourceId: string }) =>
      api.delete(`/projects/${resolveOwnerProjectId(sourceId)}/expenses/${sourceId}/ratear`),
    onSuccess: () => {
      invalidate();
      toast.success('Rateio desfeito');
    },
    onError: (e: Error) => {
      console.error('[expenses] desratear failed', e);
      toast.error(`Erro ao desfazer rateio: ${e.message}`);
    },
  });

  return {
    invalidate,
    resolveOwnerProjectId,
    createMutation,
    updateMutation,
    deleteMutation,
    payMutation,
    toggleStatusMutation,
    toggleParcelaMutation,
    quickUpdateMutation,
    changeTipoMutation,
    bulkDateMutation,
    bulkPaidMutation,
    conciliarMutation,
    ratearMutation,
    desratearMutation,
  };
}
