'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { ExpenseTypeLabels, getExpenseTypesForProject, isSinglePaymentForm, type ProjectType } from '@reformaflow/domain';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Modal } from '@/components/ui/modal';
import { FORMA_PAGAMENTO_OPTIONS } from '@/lib/expense-options';
import { formatCurrency } from '@/lib/utils';
import { AvulsasView } from './AvulsasView';
import type { AvulsaRow } from '../_display';

type Expense = AvulsaRow;

interface ExpensesPage {
  items: Expense[];
  total: number;
}

interface Props {
  projectId: string;
  projectType: ProjectType;
}

function toIsoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

interface DraftForm {
  id: string | null;
  tipoDespesa: string;
  titulo: string;
  fornecedor: string;
  valor: string;
  formaPagamento: string;
  status: 'PLANEJADO' | 'PAGO';
  dataPagamento: string;
  quantidadeParcela: string;
  dataInicioParcela: string;
}

function emptyDraft(defaultTipo: string): DraftForm {
  return {
    id: null,
    tipoDespesa: defaultTipo,
    titulo: '',
    fornecedor: '',
    valor: '',
    formaPagamento: 'A_VISTA',
    status: 'PAGO',
    dataPagamento: toIsoDate(new Date()),
    quantidadeParcela: '',
    dataInicioParcela: '',
  };
}

/**
 * Aba "Avulsas" da página /bills (projetos CASA/CARRO). Permite lançar despesas
 * pontuais (que não recorrem) usando o backend padrão de expenses. A página de
 * recorrências (RecurringBill) continua isolada — esta aba consome /expenses.
 */
export function AvulsasTab({ projectId, projectType }: Props) {
  const queryClient = useQueryClient();
  const tipoOptions = useMemo(
    () =>
      getExpenseTypesForProject(projectType).map((t) => ({
        value: t,
        label: ExpenseTypeLabels[t],
      })),
    [projectType],
  );
  const defaultTipo = tipoOptions[0]?.value ?? 'OUTROS';

  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<DraftForm>(() => emptyDraft(defaultTipo));

  // Filtro por mês corrente por padrão (YYYY-MM); pode ser ajustado.
  const [monthFilter, setMonthFilter] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });

  const { data: page, isLoading } = useQuery<ExpensesPage>({
    queryKey: ['expenses', projectId, 'bills-avulsas'],
    queryFn: () => api.get(`/projects/${projectId}/expenses?pageSize=2000`),
  });
  const all = page?.items ?? [];

  // Aplica filtro de mês olhando dataPagamento ou dataInicioParcela.
  const filtered = useMemo(() => {
    if (!monthFilter) return all;
    return all.filter((e) => {
      const ref = e.dataPagamento ?? e.dataInicioParcela ?? '';
      return ref.slice(0, 7) === monthFilter;
    });
  }, [all, monthFilter]);

  const totalDoMes = useMemo(
    () => filtered.reduce((sum, e) => sum + (e.valorTotal ?? 0), 0),
    [filtered],
  );

  const createMutation = useMutation({
    mutationFn: async (d: DraftForm) => {
      const valorNum = parseFloat(d.valor.replace(',', '.'));
      if (!valorNum || valorNum <= 0) throw new Error('Valor inválido');
      const payload: Record<string, unknown> = {
        tipoDespesa: d.tipoDespesa,
        valor: valorNum,
        quantidade: 1,
        titulo: d.titulo || undefined,
        fornecedor: d.fornecedor || undefined,
        formaPagamento: d.formaPagamento,
        status: d.status,
      };
      if (isSinglePaymentForm(d.formaPagamento) && d.dataPagamento) {
        payload.dataPagamento = d.dataPagamento;
      }
      if (d.formaPagamento === 'PARCELADO' || d.formaPagamento === 'QUINZENAL') {
        if (d.quantidadeParcela) payload.quantidadeParcela = parseInt(d.quantidadeParcela, 10);
        if (d.dataInicioParcela) payload.dataInicioParcela = d.dataInicioParcela;
      }
      if (d.id) return api.patch(`/projects/${projectId}/expenses/${d.id}`, payload);
      return api.post(`/projects/${projectId}/expenses`, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['expenses', projectId, 'bills-avulsas'] });
      setShowForm(false);
      setDraft(emptyDraft(defaultTipo));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${projectId}/expenses/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['expenses', projectId, 'bills-avulsas'] });
    },
  });

  function startEdit(e: Expense) {
    setDraft({
      id: e.id,
      tipoDespesa: e.tipoDespesa,
      titulo: e.titulo ?? '',
      fornecedor: e.fornecedor ?? '',
      valor: String((e.valorTotal ?? 0) / 100),
      formaPagamento: e.formaPagamento ?? 'A_VISTA',
      status: e.status,
      dataPagamento: e.dataPagamento?.slice(0, 10) ?? '',
      quantidadeParcela: e.quantidadeParcela ? String(e.quantidadeParcela) : '',
      dataInicioParcela: e.dataInicioParcela?.slice(0, 10) ?? '',
    });
    setShowForm(true);
  }

  // Lista de meses únicos derivados das despesas (para o seletor)
  const monthOptions = useMemo(() => {
    const set = new Set<string>();
    for (const e of all) {
      const ref = e.dataPagamento ?? e.dataInicioParcela;
      if (ref) set.add(ref.slice(0, 7));
    }
    set.add(monthFilter);
    return Array.from(set)
      .sort()
      .reverse()
      .map((m) => ({ value: m, label: m }));
  }, [all, monthFilter]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <p className="text-sm text-gray-500">
            Despesas avulsas (não recorrentes). Total do mês selecionado:{' '}
            <span className="font-semibold text-brand-700">{formatCurrency(totalDoMes / 100)}</span>
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <select
            value={monthFilter}
            onChange={(e) => setMonthFilter(e.target.value)}
            className="border rounded-lg px-3 py-1.5 text-sm"
          >
            <option value="">Todos</option>
            {monthOptions.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
          <Button
            onClick={() => {
              setDraft(emptyDraft(defaultTipo));
              setShowForm(true);
            }}
            className="flex items-center gap-2"
          >
            <Plus className="w-4 h-4" /> Nova despesa avulsa
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 bg-gray-50 rounded-xl border-2 border-dashed">
          <p className="text-4xl mb-4">🧾</p>
          <p className="text-gray-600">Nenhuma despesa avulsa neste período</p>
          <p className="text-gray-400 text-sm mt-1">
            Use o botão acima para lançar (ex.: conserto pontual, IPVA, etc).
          </p>
        </div>
      ) : (
        <AvulsasView
          expenses={filtered}
          projectType={projectType}
          onEdit={startEdit}
          onDelete={(id) => {
            if (confirm("Excluir esta despesa?")) deleteMutation.mutate(id);
          }}
        />
      )}

      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title={draft.id ? 'Editar despesa avulsa' : 'Nova despesa avulsa'}
      >
        <form
          onSubmit={(ev) => {
            ev.preventDefault();
            createMutation.mutate(draft);
          }}
          className="space-y-3"
        >
          <Select
            label="Categoria"
            name="tipoDespesa"
            options={tipoOptions}
            value={draft.tipoDespesa}
            onChange={(e) => setDraft({ ...draft, tipoDespesa: e.target.value })}
          />
          <Input
            label="Título"
            name="titulo"
            value={draft.titulo}
            onChange={(e) => setDraft({ ...draft, titulo: e.target.value })}
            placeholder="ex.: Conserto encanamento, IPVA 2026…"
          />
          <Input
            label="Fornecedor"
            name="fornecedor"
            value={draft.fornecedor}
            onChange={(e) => setDraft({ ...draft, fornecedor: e.target.value })}
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Valor (R$)"
              name="valor"
              type="number"
              step="0.01"
              min="0"
              required
              value={draft.valor}
              onChange={(e) => setDraft({ ...draft, valor: e.target.value })}
            />
            <Select
              label="Status"
              name="status"
              value={draft.status}
              options={[
                { value: 'PAGO', label: 'Pago' },
                { value: 'PLANEJADO', label: 'Planejado' },
              ]}
              onChange={(e) =>
                setDraft({ ...draft, status: e.target.value as 'PAGO' | 'PLANEJADO' })
              }
            />
          </div>
          <Select
            label="Forma de pagamento"
            name="formaPagamento"
            value={draft.formaPagamento}
            options={FORMA_PAGAMENTO_OPTIONS}
            onChange={(e) => setDraft({ ...draft, formaPagamento: e.target.value })}
          />
          {isSinglePaymentForm(draft.formaPagamento) && (
            <Input
              label="Data do pagamento"
              name="dataPagamento"
              type="date"
              value={draft.dataPagamento}
              onChange={(e) => setDraft({ ...draft, dataPagamento: e.target.value })}
            />
          )}
          {(draft.formaPagamento === 'PARCELADO' || draft.formaPagamento === 'QUINZENAL') && (
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Qtd parcelas"
                name="quantidadeParcela"
                type="number"
                min="1"
                value={draft.quantidadeParcela}
                onChange={(e) => setDraft({ ...draft, quantidadeParcela: e.target.value })}
              />
              <Input
                label="Data início parcela"
                name="dataInicioParcela"
                type="date"
                value={draft.dataInicioParcela}
                onChange={(e) => setDraft({ ...draft, dataInicioParcela: e.target.value })}
              />
            </div>
          )}
          {createMutation.error && (
            <div className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {(createMutation.error as Error).message || 'Erro ao salvar'}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="secondary" onClick={() => setShowForm(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? 'Salvando…' : draft.id ? 'Salvar' : 'Criar'}
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
