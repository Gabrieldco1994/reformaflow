'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';

type TipoOption = { value: string; label: string; group?: string };

// Tipos de recebimento do PESSOAL (mesma lista da página de Recebimentos).
const PESSOAL_TIPO_OPTIONS: TipoOption[] = [
  { value: 'SALARIO', label: 'Salário', group: 'Trabalho' },
  { value: 'ADIANTAMENTO_SALARIO', label: 'Adiantamento de Salário', group: 'Trabalho' },
  { value: 'DECIMO_TERCEIRO', label: '13º Salário', group: 'Trabalho' },
  { value: 'FERIAS', label: 'Férias', group: 'Trabalho' },
  { value: 'FREELANCE', label: 'Freelance', group: 'Trabalho' },
  { value: 'BONUS', label: 'Bônus', group: 'Trabalho' },
  { value: 'COMISSAO', label: 'Comissão', group: 'Trabalho' },
  { value: 'PENSAO', label: 'Pensão / Aposentadoria', group: 'Trabalho' },
  { value: 'DIVIDENDOS', label: 'Dividendos', group: 'Investimentos' },
  { value: 'JUROS_RENDA_FIXA', label: 'Juros de Renda Fixa', group: 'Investimentos' },
  { value: 'POUPANCA', label: 'Rend. Poupança', group: 'Investimentos' },
  { value: 'ACAO', label: 'Ação (Operação)', group: 'Investimentos' },
  { value: 'VENDA_ACAO', label: 'Venda de Ação', group: 'Investimentos' },
  { value: 'FII', label: 'Fundo Imobiliário', group: 'Investimentos' },
  { value: 'CRIPTO', label: 'Criptomoeda', group: 'Investimentos' },
  { value: 'RESGATE', label: 'Resgate', group: 'Investimentos' },
  { value: 'ALOCACAO_ORCAMENTO', label: '💰 Alocação de Orçamento', group: 'Transferências' },
  { value: 'ALUGUEL', label: 'Aluguel', group: 'Outros' },
  { value: 'REEMBOLSO', label: 'Reembolso', group: 'Outros' },
  { value: 'RESTITUICAO_IR', label: 'Restituição IR', group: 'Outros' },
  { value: 'VENDA_BEM', label: 'Venda de Bem', group: 'Outros' },
  { value: 'PRESENTE', label: 'Presente / Doação', group: 'Outros' },
  { value: 'OUTROS', label: 'Outros', group: 'Outros' },
];

const STATUS_OPTIONS = [
  { value: 'PREVISTO', label: 'Previsto' },
  { value: 'EM_CAIXA', label: 'Em Caixa' },
];

function renderTipoOptions() {
  const byGroup = new Map<string, TipoOption[]>();
  for (const o of PESSOAL_TIPO_OPTIONS) {
    const g = o.group ?? 'Outros';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(o);
  }
  return Array.from(byGroup.entries()).map(([group, opts]) => (
    <optgroup key={group} label={group}>
      {opts.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </optgroup>
  ));
}

/**
 * Modal auto-contido para criar uma Receita (RECEBIMENTO) direto da Visão Conta.
 * Reusa o backend de recebimentos (POST /projects/:id/receipts), que já gera a
 * CashFlowEntry correspondente. Invalida a query da Visão Conta ao salvar.
 */
export function NovaReceitaModal({
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

  const createMutation = useMutation({
    mutationFn: (data: { valor: number; data: string; tipo: string; status: string }) =>
      api.post(`/projects/${projectId}/receipts`, data),
    onSuccess: () => {
      toast.success('Recebimento criado');
      queryClient.invalidateQueries({ queryKey: ['account-view', projectId] });
      queryClient.invalidateQueries({ queryKey: ['receipts', projectId] });
      queryClient.invalidateQueries({ queryKey: ['dashboard', projectId] });
      queryClient.invalidateQueries({ queryKey: ['cash-flow', projectId] });
      onClose();
    },
    onError: (e: Error) => toast.error(`Erro ao criar recebimento: ${e.message}`),
  });

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    createMutation.mutate({
      valor: Number(form.get('valor')),
      data: form.get('data') as string,
      tipo: form.get('tipo') as string,
      status: form.get('status') as string,
    });
  }

  return (
    <Modal open={open} onClose={onClose} title="Nova Receita">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input label="Valor (R$)" name="valor" type="number" step="0.01" min="0" required />
        <Input label="Data" name="data" type="date" required defaultValue={defaultData ?? ''} />
        <div className="space-y-1">
          <label htmlFor="conta-receita-tipo" className="block text-sm font-medium text-gray-700">Tipo</label>
          <select
            id="conta-receita-tipo"
            name="tipo"
            required
            defaultValue="SALARIO"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
          >
            {renderTipoOptions()}
          </select>
        </div>
        <Select label="Status" name="status" options={STATUS_OPTIONS} required defaultValue="EM_CAIXA" />
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={createMutation.isPending}>Criar</Button>
        </div>
      </form>
    </Modal>
  );
}
