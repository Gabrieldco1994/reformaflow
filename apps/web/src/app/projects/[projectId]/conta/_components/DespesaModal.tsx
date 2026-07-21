'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { isSinglePaymentForm } from '@reformaflow/domain';
import { api } from '@/lib/api';
import { Modal } from '@/components/ui/modal';
import type { Expense, ExpenseFormData } from '@/types';
import { ExpenseFormModal, type ExpenseFormVinculos } from '../../expenses/_components/ExpenseFormModal';
import { RatearCompraModal } from '../../expenses/_components/RatearCompraModal';
import { invalidateExpenseQueries } from '../../expenses/_hooks/useExpenseMutations';
import { getExpenseOptions } from '../../expenses/_types';
import { centsToReaisInput, currencyInputToNumber } from '@/lib/currency-input';

const EMPTY_VINCULOS: ExpenseFormVinculos = {
  creditCardId: '',
  bankAccountId: '',
  linkedExpenseId: '',
  linkedParcelaIndex: null,
};

/**
 * Modal de Despesa para a Visão Conta — cria ou edita, reusando o componente
 * pronto `ExpenseFormModal` (mesma UI/edição do "Geral").
 *
 * - Criar: `editExpenseId` ausente → POST /projects/:id/expenses.
 * - Editar: `editExpenseId` presente → busca o objeto completo via
 *   GET /expenses/:id, popula o formulário e faz PATCH ao salvar.
 *
 * Sempre invalida a query da Visão Conta (account-view). Escopo PESSOAL (sem rooms).
 */
export function DespesaModal({
  open,
  onClose,
  projectId,
  editExpenseId,
  defaultData,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  /** Quando presente, o modal abre em modo edição da despesa correspondente. */
  editExpenseId?: string | null;
  /** Data inicial (ISO YYYY-MM-DD) para novos lançamentos. */
  defaultData?: string;
}) {
  const queryClient = useQueryClient();
  const isEdit = !!editExpenseId;

  const tipoOptions = useMemo(() => getExpenseOptions('PESSOAL'), []);

  const { data: editing = null } = useQuery<Expense | null>({
    queryKey: ['expense', projectId, editExpenseId],
    queryFn: () => api.get(`/projects/${projectId}/expenses/${editExpenseId}`),
    enabled: open && isEdit,
  });

  const [formStatus, setFormStatus] = useState<'PLANEJADO' | 'PAGO'>('PAGO');
  const [tipoDespesa, setTipoDespesa] = useState('');
  const [formaPagamento, setFormaPagamento] = useState('A_VISTA');
  const [valor, setValor] = useState('');
  const [quantidade, setQuantidade] = useState('1');
  const [titulo, setTitulo] = useState('');
  const [fornecedor, setFornecedor] = useState('');
  const [categoriaMaoDeObra, setCategoriaMaoDeObra] = useState('');
  const [dataPagamento, setDataPagamento] = useState(defaultData ?? '');
  const [dataInicioParcela, setDataInicioParcela] = useState(defaultData ?? '');
  const [formVinculos, setFormVinculos] = useState<ExpenseFormVinculos>(EMPTY_VINCULOS);
  // Id da despesa cujo estado já foi populado no formulário (modo edição). Garante
  // que o ExpenseFormModal só renderize depois da hidratação (sem flash de campos vazios).
  const [hydratedId, setHydratedId] = useState<string | null>(null);
  // Compra (PESSOAL) selecionada para ratear entre planejadas de outro projeto.
  const [ratearSource, setRatearSource] = useState<Expense | null>(null);

  const valorTotal = useMemo(() => {
    const v = currencyInputToNumber(valor) || 0;
    const q = parseInt(quantidade) || 1;
    return v * q;
  }, [valor, quantidade]);

  // Popula o formulário ao abrir: limpo (criar) ou a partir da despesa (editar).
  // Estado vive fora do Modal (que desmonta os filhos ao fechar), então
  // reinicializamos a cada abertura — espelhando openNewPaidForm/openEdit do Geral.
  useEffect(() => {
    if (!open) {
      setHydratedId(null);
      return;
    }
    if (isEdit) {
      if (!editing) return; // aguarda o fetch
      setFormStatus((editing.status as 'PLANEJADO' | 'PAGO') ?? 'PAGO');
      setTipoDespesa(editing.tipoDespesa);
      setFormaPagamento(editing.formaPagamento);
      setValor(editing.valor ? centsToReaisInput(editing.valor) : '');
      setQuantidade(String(editing.quantidade ?? 1));
      setTitulo(editing.titulo ?? '');
      setFornecedor(editing.fornecedor ?? '');
      setCategoriaMaoDeObra(editing.categoriaMaoDeObra ?? '');
      setDataPagamento(editing.dataPagamento?.slice(0, 10) ?? '');
      setDataInicioParcela(editing.dataInicioParcela?.slice(0, 10) ?? '');
      setFormVinculos({
        creditCardId: '',
        bankAccountId: '',
        linkedExpenseId: editing.linkedExpenseId ?? '',
        linkedParcelaIndex: null,
      });
      setHydratedId(editing.id);
    } else {
      setFormStatus('PAGO');
      setTipoDespesa('');
      setFormaPagamento('A_VISTA');
      setValor('');
      setQuantidade('1');
      setTitulo('');
      setFornecedor('');
      setCategoriaMaoDeObra('');
      setDataPagamento(defaultData ?? '');
      setDataInicioParcela(defaultData ?? '');
      setFormVinculos(EMPTY_VINCULOS);
    }
  }, [open, isEdit, editing, defaultData]);

  const invalidate = () => {
    invalidateExpenseQueries(queryClient, projectId);
  };

  const createMutation = useMutation({
    mutationFn: (data: ExpenseFormData) => api.post<{ id: string }>(`/projects/${projectId}/expenses`, data),
    onSuccess: () => {
      toast.success('Despesa criada');
      invalidate();
      onClose();
    },
    onError: (e: Error) => toast.error(`Erro ao criar despesa: ${e.message}`),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: ExpenseFormData }) =>
      api.patch(`/projects/${projectId}/expenses/${id}`, data),
    onSuccess: () => {
      toast.success('Despesa atualizada');
      invalidate();
      onClose();
    },
    onError: (e: Error) => toast.error(`Erro ao salvar despesa: ${e.message}`),
  });

  // Conciliação cross-project por parcela (vínculo manual — Fase 6): liquida a
  // parcela escolhida do alvo com o valor desta despesa. Espelha ExpensesView.
  const conciliarMutation = useMutation({
    mutationFn: ({ sourceId, targetExpenseId, parcelaIndex }: { sourceId: string; targetExpenseId: string; parcelaIndex: number }) =>
      api.post(`/projects/${projectId}/expenses/${sourceId}/conciliar-parcela`, { targetExpenseId, parcelaIndex }),
    onSuccess: () => {
      invalidateExpenseQueries(queryClient, projectId);
      toast.success('Despesa conciliada com a parcela do outro projeto');
    },
    onError: (e: Error) => toast.error(`Erro ao conciliar parcela: ${e.message}`),
  });

  // Rateio: distribui UMA compra (fonte, PESSOAL) entre N planejadas de outro
  // projeto. A soma das alocações fecha o total da compra. Não toca no motor
  // backend (ratearSource/unratearSource) — só reusa os endpoints.
  const ratearMutation = useMutation({
    mutationFn: ({ sourceId, allocations }: { sourceId: string; allocations: { targetExpenseId: string; allocation: number }[] }) =>
      api.post(`/projects/${projectId}/expenses/${sourceId}/ratear`, { allocations }),
    onSuccess: (_d, vars) => {
      invalidateExpenseQueries(queryClient, projectId);
      toast.success(`Compra rateada em ${vars.allocations.length} ${vars.allocations.length === 1 ? 'planejada' : 'planejadas'}`);
    },
    onError: (e: Error) => toast.error(`Erro ao ratear compra: ${e.message}`),
  });

  const desratearMutation = useMutation({
    mutationFn: ({ sourceId }: { sourceId: string }) =>
      api.delete(`/projects/${projectId}/expenses/${sourceId}/ratear`),
    onSuccess: () => {
      invalidateExpenseQueries(queryClient, projectId);
      toast.success('Rateio desfeito');
    },
    onError: (e: Error) => toast.error(`Erro ao desfazer rateio: ${e.message}`),
  });

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const nullable = (key: string) => {
      const v = form.get(key);
      if (v === null) return null;
      const trimmed = (v as string).trim();
      return trimmed === '' ? null : trimmed;
    };
    const data: ExpenseFormData = {
      tipoDespesa: form.get('tipoDespesa') as string,
      categoriaMaoDeObra: nullable('categoriaMaoDeObra'),
      roomId: null,
      valor: currencyInputToNumber(String(form.get('valor') ?? '')),
      quantidade: Number(form.get('quantidade')),
      titulo: nullable('titulo'),
      fornecedor: nullable('fornecedor'),
      link: nullable('link'),
      imageUrl: nullable('imageUrl'),
      formaPagamento: form.get('formaPagamento') as string,
      status: formStatus,
    };
    // Data da compra (competência) — independe da forma de pagamento. Vazio = null.
    data.dataCompra = nullable('dataCompra');
    const fp = data.formaPagamento;
    if (isSinglePaymentForm(fp)) {
      data.dataPagamento = nullable('dataPagamento');
      data.quantidadeParcela = null;
      data.dataInicioParcela = null;
      const isRec = form.get('recorrente') === 'on';
      data.recorrente = isRec;
      const fim = nullable('recorrenciaFim');
      data.recorrenciaFim = isRec && fim ? `${fim}-01` : null;
    } else if (fp === 'PARCELADO' || fp === 'QUINZENAL') {
      const q = Number(form.get('quantidadeParcela'));
      data.quantidadeParcela = q > 0 ? q : null;
      data.dataInicioParcela = nullable('dataInicioParcela');
      data.dataPagamento = null;
      data.recorrente = false;
      data.recorrenciaFim = null;
    }
    data.creditCardId = formVinculos.creditCardId || null;
    data.bankAccountId = formVinculos.bankAccountId || null;
    const linkedId = formVinculos.linkedExpenseId || null;
    const parcelaIdx = formVinculos.linkedParcelaIndex;
    // Quando o usuário escolheu uma PARCELA específica do alvo, a conciliação
    // (Fase 6) cuida de setar o vínculo + liquidar a parcela — então não enviamos
    // linkedExpenseId no payload (evita set duplicado/simples). Espelha ExpensesView.
    const useConciliacao = !!linkedId && parcelaIdx != null;
    data.linkedExpenseId = useConciliacao ? null : linkedId;

    const afterSave = (sourceId?: string) => {
      if (useConciliacao && linkedId && sourceId) {
        conciliarMutation.mutate({ sourceId, targetExpenseId: linkedId, parcelaIndex: parcelaIdx! });
      }
    };

    if (isEdit && editExpenseId) {
      updateMutation.mutate({ id: editExpenseId, data }, { onSuccess: () => afterSave(editExpenseId) });
    } else {
      createMutation.mutate(data, { onSuccess: (created) => afterSave(created?.id) });
    }
  }

  // Em modo edição, enquanto carrega/hidrata a despesa, mostra um placeholder no
  // modal — evita piscar o formulário com campos vazios.
  if (open && isEdit && hydratedId !== editExpenseId) {
    return (
      <Modal open={open} onClose={onClose} title="Editar Despesa">
        <div className="space-y-3 py-2">
          <div className="h-10 animate-pulse rounded-lg bg-lifeone-surface" />
          <div className="h-10 animate-pulse rounded-lg bg-lifeone-surface" />
          <div className="h-24 animate-pulse rounded-lg bg-lifeone-surface" />
        </div>
      </Modal>
    );
  }

  return (
    <>
      <ExpenseFormModal
        open={open}
        onClose={onClose}
        onSubmit={handleSubmit}
        editing={isEdit ? editing : null}
        formStatus={formStatus}
        allowRecorrente
        tipoDespesa={tipoDespesa}
        setTipoDespesa={setTipoDespesa}
        formaPagamento={formaPagamento}
        setFormaPagamento={setFormaPagamento}
        valor={valor}
        setValor={setValor}
        quantidade={quantidade}
        setQuantidade={setQuantidade}
        valorTotal={valorTotal}
        titulo={titulo}
        setTitulo={setTitulo}
        fornecedor={fornecedor}
        setFornecedor={setFornecedor}
        categoriaMaoDeObra={categoriaMaoDeObra}
        setCategoriaMaoDeObra={setCategoriaMaoDeObra}
        dataPagamento={dataPagamento}
        setDataPagamento={setDataPagamento}
        dataInicioParcela={dataInicioParcela}
        setDataInicioParcela={setDataInicioParcela}
        formVinculos={formVinculos}
        setFormVinculos={setFormVinculos}
        projectId={projectId}
        showRooms={false}
        tipoDespesaOptions={tipoOptions}
        roomOptions={[]}
        isPending={createMutation.isPending || updateMutation.isPending}
        onRatear={isEdit && editing ? () => { setRatearSource(editing); onClose(); } : undefined}
        linkedExpenseDraft={{
          titulo,
          fornecedor,
          tipoDespesa,
          categoriaMaoDeObra,
          valor,
          quantidade,
          formaPagamento,
          status: formStatus,
        }}
      />
      {ratearSource && (
        <RatearCompraModal
          open={!!ratearSource}
          onClose={() => setRatearSource(null)}
          source={ratearSource}
          ownerProjectId={projectId}
          isPending={ratearMutation.isPending || desratearMutation.isPending}
          onSubmit={(allocations) =>
            ratearMutation.mutate(
              { sourceId: ratearSource.id, allocations },
              { onSuccess: () => setRatearSource(null) },
            )
          }
          onDesratear={() =>
            desratearMutation.mutate(
              { sourceId: ratearSource.id },
              { onSuccess: () => setRatearSource(null) },
            )
          }
        />
      )}
    </>
  );
}
