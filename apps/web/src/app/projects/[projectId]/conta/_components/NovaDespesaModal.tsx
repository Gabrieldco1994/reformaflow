'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { isSinglePaymentForm } from '@reformaflow/domain';
import { api } from '@/lib/api';
import type { ExpenseFormData } from '@/types';
import { ExpenseFormModal, type ExpenseFormVinculos } from '../../expenses/_components/ExpenseFormModal';
import { getExpenseOptions } from '../../expenses/_types';

const EMPTY_VINCULOS: ExpenseFormVinculos = {
  creditCardId: '',
  bankAccountId: '',
  linkedExpenseId: '',
  linkedParcelaIndex: null,
};

/**
 * Modal auto-contido para criar uma Despesa direto da Visão Conta. Reusa o
 * componente pronto `ExpenseFormModal` (mesma UI do "Geral"), segurando o estado
 * localmente e postando em /projects/:id/expenses. Invalida a Visão Conta ao salvar.
 *
 * Escopo: PESSOAL (a Visão Conta só existe para PESSOAL) — sem ambientes (rooms).
 */
export function NovaDespesaModal({
  open,
  onClose,
  projectId,
  defaultData,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  /** Data inicial (ISO YYYY-MM-DD) — usa o mês selecionado na tela. */
  defaultData?: string;
}) {
  const queryClient = useQueryClient();

  const tipoOptions = useMemo(() => getExpenseOptions('PESSOAL'), []);

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

  const valorTotal = useMemo(() => {
    const v = parseFloat(valor) || 0;
    const q = parseInt(quantidade) || 1;
    return v * q;
  }, [valor, quantidade]);

  // Reseta os campos a cada abertura (estado vive fora do Modal, que desmonta os
  // filhos ao fechar) — espelha o "Nova Despesa" do Geral, que sempre abre limpo.
  useEffect(() => {
    if (!open) return;
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
  }, [open, defaultData]);

  const createMutation = useMutation({
    mutationFn: (data: ExpenseFormData) => api.post(`/projects/${projectId}/expenses`, data),
    onSuccess: () => {
      toast.success('Despesa criada');
      queryClient.invalidateQueries({ queryKey: ['account-view', projectId] });
      queryClient.invalidateQueries({ queryKey: ['expenses', projectId] });
      queryClient.invalidateQueries({ queryKey: ['dashboard', projectId] });
      queryClient.invalidateQueries({ queryKey: ['cash-flow', projectId] });
      onClose();
    },
    onError: (e: Error) => toast.error(`Erro ao criar despesa: ${e.message}`),
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
      valor: Number(form.get('valor')),
      quantidade: Number(form.get('quantidade')),
      titulo: nullable('titulo'),
      fornecedor: nullable('fornecedor'),
      link: nullable('link'),
      imageUrl: nullable('imageUrl'),
      formaPagamento: form.get('formaPagamento') as string,
      status: 'PAGO',
    };
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
    data.linkedExpenseId = formVinculos.linkedExpenseId || null;
    createMutation.mutate(data);
  }

  return (
    <ExpenseFormModal
      open={open}
      onClose={onClose}
      onSubmit={handleSubmit}
      editing={null}
      formStatus="PAGO"
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
      isPending={createMutation.isPending}
    />
  );
}
