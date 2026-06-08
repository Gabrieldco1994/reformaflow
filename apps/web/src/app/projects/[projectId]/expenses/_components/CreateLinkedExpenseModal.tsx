'use client';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isSinglePaymentForm, hasFeature, ProjectType } from '@reformaflow/domain';
import { api } from '@/lib/api';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { CATEGORIA_MAO_DE_OBRA_OPTIONS, FORMA_PAGAMENTO_OPTIONS } from '@/lib/expense-options';
import { getExpenseOptions } from '../_types';

interface ProjectLite {
  id: string;
  name: string;
  type: string;
  rooms?: { id: string; name: string }[];
}

export interface LinkedExpenseDraft {
  titulo?: string;
  fornecedor?: string;
  tipoDespesa?: string;
  categoriaMaoDeObra?: string;
  valor?: string;
  quantidade?: string;
  formaPagamento?: string;
  dataPagamento?: string;
  quantidadeParcela?: string;
  dataInicioParcela?: string;
}

interface CreatedExpense {
  id: string;
  titulo?: string | null;
  fornecedor?: string | null;
  tipoDespesa?: string | null;
  categoriaMaoDeObra?: string | null;
  valorTotal: number;
  status: string;
  dataPagamento?: string | null;
  project?: { id: string; name: string; type: string } | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  currentProjectId: string;
  defaults: LinkedExpenseDraft;
  onCreated: (exp: CreatedExpense) => void;
}

/**
 * Modal para criar despesa em OUTRO projeto (cross-project) já vinculada à
 * despesa em edição. Pré-preenche com os campos do form pai; usuário escolhe
 * projeto destino e ajusta o que precisar (status normalmente PLANEJADO).
 *
 * Após sucesso, devolve o id da expense criada ao chamador (que então faz o
 * link unidirecional na despesa "filha").
 */
export function CreateLinkedExpenseModal({
  open,
  onClose,
  currentProjectId,
  defaults,
  onCreated,
}: Props) {
  const queryClient = useQueryClient();

  const { data: projects = [] } = useQuery<ProjectLite[]>({
    queryKey: ['tenant', 'projects'],
    queryFn: () => api.get('/projects'),
    staleTime: 60_000,
    enabled: open,
  });

  // Só projetos que têm o módulo de despesas (REFORMA/COMPRA/PESSOAL). CASA/CARRO usam
  // contas recorrentes/manutenção e a API rejeita POST /expenses com 403 — não podem ser alvo.
  const otherProjects = useMemo(
    () =>
      projects.filter(
        (p) => p.id !== currentProjectId && hasFeature(p.type as ProjectType, 'expenses'),
      ),
    [projects, currentProjectId],
  );

  const [targetProjectId, setTargetProjectId] = useState('');
  const [titulo, setTitulo] = useState('');
  const [fornecedor, setFornecedor] = useState('');
  const [tipoDespesa, setTipoDespesa] = useState('');
  const [categoriaMaoDeObra, setCategoriaMaoDeObra] = useState('');
  const [roomId, setRoomId] = useState('');
  const [valor, setValor] = useState('');
  const [quantidade, setQuantidade] = useState('1');
  const [formaPagamento, setFormaPagamento] = useState('A_VISTA');
  const [dataPagamento, setDataPagamento] = useState('');
  const [quantidadeParcela, setQuantidadeParcela] = useState('');
  const [dataInicioParcela, setDataInicioParcela] = useState('');
  const [status, setStatus] = useState<'PLANEJADO' | 'PAGO'>('PLANEJADO');
  const [error, setError] = useState<string | null>(null);

  // Reset / pré-preencher quando o modal abrir (apenas na transição fechado→aberto,
  // para não sobrescrever o que o usuário digitar enquanto edita).
  useEffect(() => {
    if (!open) return;
    setTitulo(defaults.titulo ?? '');
    setFornecedor(defaults.fornecedor ?? '');
    setTipoDespesa(defaults.tipoDespesa ?? '');
    setCategoriaMaoDeObra(defaults.categoriaMaoDeObra ?? '');
    setValor(defaults.valor ?? '');
    setQuantidade(defaults.quantidade ?? '1');
    setFormaPagamento(defaults.formaPagamento ?? 'A_VISTA');
    setDataPagamento(defaults.dataPagamento ?? '');
    setQuantidadeParcela(defaults.quantidadeParcela ?? '');
    setDataInicioParcela(defaults.dataInicioParcela ?? '');
    setStatus('PLANEJADO');
    setRoomId('');
    setTargetProjectId('');
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const targetProject = useMemo(
    () => otherProjects.find((p) => p.id === targetProjectId) ?? null,
    [otherProjects, targetProjectId],
  );

  const tipoOptions = useMemo(() => {
    if (!targetProject) return [];
    return getExpenseOptions(targetProject.type);
  }, [targetProject]);

  const showRooms = targetProject?.type === 'REFORMA';
  const showMaoDeObra = targetProject?.type === 'REFORMA' && tipoDespesa === 'MAO_DE_OBRA';

  const roomOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [{ value: '', label: '— Sem ambiente —' }];
    for (const r of targetProject?.rooms ?? []) {
      opts.push({ value: r.id, label: r.name });
    }
    return opts;
  }, [targetProject]);

  // Quando trocar o projeto destino, se o tipo atual não for válido lá, ajusta.
  useEffect(() => {
    if (!targetProject) return;
    if (tipoDespesa && !tipoOptions.some((o) => o.value === tipoDespesa)) {
      setTipoDespesa(tipoOptions[0]?.value ?? '');
    } else if (!tipoDespesa && tipoOptions.length > 0) {
      setTipoDespesa(tipoOptions[0].value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetProject?.id, tipoOptions]);

  const mutation = useMutation<CreatedExpense, Error, void>({
    mutationFn: async () => {
      if (!targetProjectId) throw new Error('Escolha o projeto destino');
      const valorNum = parseFloat(valor.replace(',', '.'));
      if (!valorNum || valorNum <= 0) throw new Error('Valor inválido');
      const qtdNum = parseInt(quantidade, 10) || 1;
      const payload: Record<string, unknown> = {
        tipoDespesa,
        valor: valorNum,
        quantidade: qtdNum,
        titulo: titulo || undefined,
        fornecedor: fornecedor || undefined,
        formaPagamento,
        status,
      };
      if (showMaoDeObra && categoriaMaoDeObra) payload.categoriaMaoDeObra = categoriaMaoDeObra;
      if (showRooms && roomId) payload.roomId = roomId;
      if (isSinglePaymentForm(formaPagamento) && dataPagamento) payload.dataPagamento = dataPagamento;
      if (formaPagamento === 'PARCELADO' || formaPagamento === 'QUINZENAL') {
        if (quantidadeParcela) payload.quantidadeParcela = parseInt(quantidadeParcela, 10);
        if (dataInicioParcela) payload.dataInicioParcela = dataInicioParcela;
      }
      return api.post(`/projects/${targetProjectId}/expenses`, payload);
    },
    onSuccess: (created) => {
      // Atualiza caches que dependem da nova despesa
      queryClient.invalidateQueries({ queryKey: ['expenses', targetProjectId] });
      queryClient.invalidateQueries({ queryKey: ['cross-project-expenses'] });
      onCreated(created);
      onClose();
    },
    onError: (e) => setError(e.message || 'Erro ao criar despesa'),
  });

  return (
    <Modal open={open} onClose={onClose} title="Criar despesa em outro projeto e vincular">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          mutation.mutate();
        }}
        className="space-y-3"
      >
        <Select
          label="Projeto destino"
          name="targetProjectId"
          required
          value={targetProjectId}
          onChange={(e) => setTargetProjectId(e.target.value)}
          options={[
            { value: '', label: 'Selecione…' },
            ...otherProjects.map((p) => ({ value: p.id, label: `${p.name} · ${p.type}` })),
          ]}
        />

        {otherProjects.length === 0 && (
          <p className="text-xs text-amber-600">
            Nenhum projeto com módulo de despesas para vincular. Projetos do tipo CASA/CARRO usam
            contas recorrentes e manutenção (não despesas).
          </p>
        )}
        {targetProject && (
          <>
            <Select
              label="Tipo da despesa"
              name="tipoDespesa"
              required
              value={tipoDespesa}
              onChange={(e) => setTipoDespesa(e.target.value)}
              options={tipoOptions}
            />

            {showMaoDeObra && (
              <Select
                label="Categoria Mão de Obra"
                name="categoriaMaoDeObra"
                value={categoriaMaoDeObra}
                onChange={(e) => setCategoriaMaoDeObra(e.target.value)}
                options={CATEGORIA_MAO_DE_OBRA_OPTIONS}
              />
            )}

            {showRooms && (
              <Select
                label="Ambiente"
                name="roomId"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                options={roomOptions}
              />
            )}

            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Valor (R$)"
                name="valor"
                type="number"
                step="0.01"
                min="0"
                required
                value={valor}
                onChange={(e) => setValor(e.target.value)}
              />
              <Input
                label="Quantidade"
                name="quantidade"
                type="number"
                min="1"
                required
                value={quantidade}
                onChange={(e) => setQuantidade(e.target.value)}
              />
            </div>

            <Input
              label="Título"
              name="titulo"
              value={titulo}
              onChange={(e) => setTitulo(e.target.value)}
            />
            <Input
              label="Fornecedor"
              name="fornecedor"
              value={fornecedor}
              onChange={(e) => setFornecedor(e.target.value)}
            />

            <div className="grid grid-cols-2 gap-3">
              <Select
                label="Forma de pagamento"
                name="formaPagamento"
                value={formaPagamento}
                onChange={(e) => setFormaPagamento(e.target.value)}
                options={FORMA_PAGAMENTO_OPTIONS}
              />
              <Select
                label="Status"
                name="status"
                value={status}
                onChange={(e) => setStatus(e.target.value as 'PLANEJADO' | 'PAGO')}
                options={[
                  { value: 'PLANEJADO', label: 'Planejado' },
                  { value: 'PAGO', label: 'Pago' },
                ]}
              />
            </div>

            {isSinglePaymentForm(formaPagamento) && (
              <Input
                label="Data do pagamento"
                name="dataPagamento"
                type="date"
                value={dataPagamento}
                onChange={(e) => setDataPagamento(e.target.value)}
              />
            )}

            {(formaPagamento === 'PARCELADO' || formaPagamento === 'QUINZENAL') && (
              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Qtd parcelas"
                  name="quantidadeParcela"
                  type="number"
                  min="1"
                  value={quantidadeParcela}
                  onChange={(e) => setQuantidadeParcela(e.target.value)}
                />
                <Input
                  label="Data início parcela"
                  name="dataInicioParcela"
                  type="date"
                  value={dataInicioParcela}
                  onChange={(e) => setDataInicioParcela(e.target.value)}
                />
              </div>
            )}
          </>
        )}

        {error && (
          <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={mutation.isPending || !targetProjectId}>
            {mutation.isPending ? 'Criando…' : 'Criar e vincular'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
