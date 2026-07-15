'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { centsToReaisInput, currencyInputToNumber, maskCurrencyInput } from '@/lib/currency-input';

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
  { value: 'TRANSFERENCIA_PROPRIA', label: 'Transferência própria', group: 'Transferências' },
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

function renderTipoOptions(extra?: TipoOption) {
  const byGroup = new Map<string, TipoOption[]>();
  for (const o of PESSOAL_TIPO_OPTIONS) {
    const g = o.group ?? 'Outros';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g)!.push(o);
  }
  const groups = Array.from(byGroup.entries()).map(([group, opts]) => (
    <optgroup key={group} label={group}>
      {opts.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </optgroup>
  ));
  // Tipo legado/desconhecido (fora da lista): expõe como opção avulsa para não
  // perder o valor ao editar.
  if (extra) {
    return [
      <option key={extra.value} value={extra.value}>{extra.label}</option>,
      ...groups,
    ];
  }
  return groups;
}

export interface ReceitaEditing {
  id: string;
  valor: number; // centavos
  data: string; // ISO
  tipo: string;
  status: string;
}

/**
 * Modal de Receita (RECEBIMENTO) para a Visão Conta — cria ou edita.
 * Reusa o backend de recebimentos (POST/PATCH /projects/:id/receipts), que já
 * gera/atualiza a CashFlowEntry. Invalida a Visão Conta ao salvar.
 */
export function ReceitaModal({
  open,
  onClose,
  projectId,
  editing,
  defaultData,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  /** Quando presente, abre em modo edição do recebimento. */
  editing?: ReceitaEditing | null;
  /** Data inicial (ISO YYYY-MM-DD) para novos lançamentos. */
  defaultData?: string;
}) {
  const queryClient = useQueryClient();
  const isEdit = !!editing;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['account-view', projectId] });
    queryClient.invalidateQueries({ queryKey: ['receipts', projectId] });
    queryClient.invalidateQueries({ queryKey: ['dashboard', projectId] });
    queryClient.invalidateQueries({ queryKey: ['cash-flow', projectId] });
  };

  const createMutation = useMutation({
    mutationFn: (data: { valor: number; data: string; tipo: string; status: string }) =>
      api.post(`/projects/${projectId}/receipts`, data),
    onSuccess: () => {
      toast.success('Recebimento criado');
      invalidate();
      onClose();
    },
    onError: (e: Error) => toast.error(`Erro ao criar recebimento: ${e.message}`),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { valor: number; data: string; tipo: string; status: string } }) =>
      api.patch(`/projects/${projectId}/receipts/${id}`, data),
    onSuccess: () => {
      toast.success('Recebimento atualizado');
      invalidate();
      onClose();
    },
    onError: (e: Error) => toast.error(`Erro ao salvar recebimento: ${e.message}`),
  });

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const payload = {
      valor: currencyInputToNumber(String(form.get('valor') ?? '')),
      data: form.get('data') as string,
      tipo: form.get('tipo') as string,
      status: form.get('status') as string,
    };
    if (isEdit && editing) {
      updateMutation.mutate({ id: editing.id, data: payload });
    } else {
      createMutation.mutate(payload);
    }
  }

  // O tipo vindo da Visão Conta chega normalizado (minúsculo); reverte para o
  // valor do enum (maiúsculo) para casar com as opções. Se ainda não existir na
  // lista, expõe como opção avulsa para preservar o valor original.
  const editingTipo = editing ? editing.tipo.toUpperCase() : 'SALARIO';
  const knownTipo = PESSOAL_TIPO_OPTIONS.some((o) => o.value === editingTipo);
  const extraTipo = isEdit && !knownTipo ? { value: editingTipo, label: editingTipo } : undefined;

  return (
    <Modal open={open} onClose={onClose} title={isEdit ? 'Editar Receita' : 'Nova Receita'}>
      <form key={editing?.id ?? 'new'} onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Valor (R$)"
          name="valor"
          type="text"
          inputMode="numeric"
          required
          defaultValue={editing ? centsToReaisInput(editing.valor) : ''}
          onChange={(e) => {
            e.currentTarget.value = maskCurrencyInput(e.currentTarget.value);
          }}
        />
        <Input
          label="Data"
          name="data"
          type="date"
          required
          defaultValue={editing?.data ? editing.data.slice(0, 10) : defaultData ?? ''}
        />
        <div className="space-y-1">
          <label htmlFor="conta-receita-tipo" className="block text-sm font-medium text-lifeone-ink-2">Tipo</label>
          <select
            id="conta-receita-tipo"
            name="tipo"
            required
            defaultValue={editingTipo}
            className="w-full rounded-lg border border-lifeone-hairline px-3 py-2 text-sm shadow-lifeone-card focus:border-lifeone-blue focus:ring-1 focus:ring-lifeone-blue"
          >
            {renderTipoOptions(extraTipo)}
          </select>
        </div>
        <Select label="Status" name="status" options={STATUS_OPTIONS} required defaultValue={editing?.status ?? 'EM_CAIXA'} />
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Cancelar</Button>
          <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
            {isEdit ? 'Salvar' : 'Criar'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
