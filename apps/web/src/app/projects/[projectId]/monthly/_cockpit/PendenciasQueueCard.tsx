'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { formatCurrency } from '@/lib/utils';
import { tipoLabel } from '@/lib/expense-options';
import { Modal } from '@/components/ui/modal';
import type { Expense } from '@/types';
import { getExpenseOptions } from '../../expenses/_types';
import { BulkLinkModal } from '../../expenses/_components/BulkLinkModal';
import { PagarFaturaDialog } from '../../conta/_components/PagarFaturaDialog';
import { QuitarParcelaModal } from '../../conta/_components/QuitarParcelaModal';
import { ReceitaModal, type ReceitaEditing } from '../../conta/_components/ReceitaModal';
import type { AccountViewResponse } from '../../conta/_types';

type QueueType =
  | 'SEM_CONTA'
  | 'SEM_CATEGORIA'
  | 'FATURA_NAO_PAGA'
  | 'PARCELA_FOREIGN_PENDENTE'
  | 'RECEBIMENTO_PREVISTO_ATRASADO';

type QueueItem = {
  id: string;
  tipo: QueueType;
  label: string;
  descricao: string;
  valor: number;
  data: string;
  expenseId?: string;
  receiptId?: string;
  cardLast4?: string;
  dueMonth?: string;
  foreignExpenseId?: string;
  parcelaIndex?: number;
  suggestionTipoDespesa?: string;
};

type QueueGroup = {
  tipo: QueueType;
  label: string;
  count: number;
  valorTotal: number;
  itens: QueueItem[];
};

type QueueResponse = {
  total: number;
  grupos: QueueGroup[];
};

type ConfirmUndoPayload = {
  expenseId: string;
  previousTipoDespesa: string;
  merchant: string;
};

export function PendenciasQueueCard({
  projectId,
  monthKey,
  projectType,
}: {
  projectId: string;
  monthKey: string;
  projectType: string;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [vincularExpenseId, setVincularExpenseId] = useState<string | null>(null);
  const [editReceita, setEditReceita] = useState<ReceitaEditing | null>(null);
  const [categoriaItem, setCategoriaItem] = useState<QueueItem | null>(null);
  const [categoriaEscolhida, setCategoriaEscolhida] = useState('');
  const [payCardLast4, setPayCardLast4] = useState<string | null>(null);
  const [quitar, setQuitar] = useState<{
    foreignExpenseId: string;
    parcelaIndex: number;
    valor: number;
    descricao: string;
    data: string;
  } | null>(null);

  const queueQueryKey = ['pendencias-financeiras', projectId, monthKey] as const;
  const { data, isLoading } = useQuery<QueueResponse>({
    queryKey: queueQueryKey,
    queryFn: async () => {
      const raw = await api.get(`/projects/${projectId}/pendencias/financeiras?month=${monthKey}`);
      if (
        raw &&
        typeof raw === 'object' &&
        typeof (raw as { total?: unknown }).total === 'number' &&
        Array.isArray((raw as { grupos?: unknown }).grupos)
      ) {
        return raw as QueueResponse;
      }
      return { total: 0, grupos: [] };
    },
    enabled: !!projectId && !!monthKey,
  });

  const { data: accountView } = useQuery<AccountViewResponse | null>({
    queryKey: ['account-view', projectId, monthKey],
    queryFn: async () => {
      const raw = await api.get(`/projects/${projectId}/monthly-overview/account-view?month=${monthKey}`);
      if (raw && typeof raw === 'object' && Array.isArray((raw as { cartoes?: unknown }).cartoes)) {
        return raw as AccountViewResponse;
      }
      return null;
    },
    enabled: !!projectId && !!monthKey,
  });

  const { data: vincularExpense } = useQuery<Expense | null>({
    queryKey: ['expense', projectId, vincularExpenseId],
    queryFn: () => api.get(`/projects/${projectId}/expenses/${vincularExpenseId}`),
    enabled: vincularExpenseId != null,
  });

  const selectedCard = useMemo(() => {
    const cartoes = accountView?.cartoes ?? [];
    return cartoes.find((card) => card.last4 === payCardLast4) ?? null;
  }, [accountView?.cartoes, payCardLast4]);
  const categoriaOptions = useMemo(() => getExpenseOptions(projectType), [projectType]);

  const refreshQueue = () => {
    queryClient.invalidateQueries({ queryKey: queueQueryKey });
    queryClient.invalidateQueries({ queryKey: ['expenses', projectId] });
    queryClient.invalidateQueries({ queryKey: ['account-view', projectId] });
  };

  const reopenQueue = () => {
    refreshQueue();
    setOpen(true);
  };

  const undoCategoriaMutation = useMutation({
    mutationFn: async (payload: ConfirmUndoPayload) => {
      await api.patch(`/projects/${projectId}/expenses/${payload.expenseId}`, {
        tipoDespesa: payload.previousTipoDespesa,
      });
      await api.post('/merchant-categories/remove-rule', { merchant: payload.merchant });
    },
    onSuccess: () => {
      toast.success('Regra removida e categoria revertida');
      refreshQueue();
    },
    onError: (error: Error) => {
      toast.error(`Não foi possível desfazer: ${error.message}`);
    },
  });

  const confirmCategoriaMutation = useMutation({
    mutationFn: async ({
      item,
      tipoDespesa,
    }: {
      item: QueueItem;
      tipoDespesa: string;
    }): Promise<ConfirmUndoPayload> => {
      if (!item.expenseId || !tipoDespesa) {
        throw new Error('Item sem dados para confirmação de categoria');
      }
      const expense = (await api.get(`/projects/${projectId}/expenses/${item.expenseId}`)) as {
        id: string;
        tipoDespesa?: string | null;
        fornecedor?: string | null;
        titulo?: string | null;
      };
      const merchant = (expense.fornecedor ?? expense.titulo ?? item.descricao ?? '').trim();
      if (!merchant) throw new Error('Fornecedor/título ausente para criar regra');
      const previousTipoDespesa = expense.tipoDespesa ?? 'OUTROS';
      await api.patch(`/projects/${projectId}/expenses/${item.expenseId}`, {
        tipoDespesa,
      });
      await api.post('/merchant-categories/confirm-rule', {
        merchant,
        tipoDespesa,
      });
      return { expenseId: item.expenseId, previousTipoDespesa, merchant };
    },
    onSuccess: (undoPayload, vars) => {
      refreshQueue();
      setCategoriaItem(null);
      setCategoriaEscolhida('');
      toast.success(`Regra criada: ${undoPayload.merchant} → ${tipoLabel(vars.tipoDespesa)} · desfazer`, {
        action: {
          label: 'Desfazer',
          onClick: () => undoCategoriaMutation.mutate(undoPayload),
        },
      });
    },
    onError: (error: Error) => {
      toast.error(`Não foi possível confirmar categoria: ${error.message}`);
    },
  });

  const handleItemAction = (item: QueueItem) => {
    if (item.tipo === 'SEM_CONTA' && item.foreignExpenseId && item.parcelaIndex != null) {
      setOpen(false);
      setQuitar({
        foreignExpenseId: item.foreignExpenseId,
        parcelaIndex: item.parcelaIndex,
        valor: item.valor,
        descricao: item.descricao,
        data: item.data.slice(0, 10),
      });
      return;
    }
    if (item.tipo === 'SEM_CONTA' && item.expenseId) {
      setOpen(false);
      setVincularExpenseId(item.expenseId);
      return;
    }
    if (item.tipo === 'SEM_CATEGORIA' && item.expenseId) {
      setOpen(false);
      const defaultCategoria =
        item.suggestionTipoDespesa && categoriaOptions.some((o) => o.value === item.suggestionTipoDespesa)
          ? item.suggestionTipoDespesa
          : (categoriaOptions[0]?.value ?? 'OUTROS');
      setCategoriaEscolhida(defaultCategoria);
      setCategoriaItem(item);
      return;
    }
    if (item.tipo === 'FATURA_NAO_PAGA' && item.cardLast4) {
      setOpen(false);
      setPayCardLast4(item.cardLast4);
      return;
    }
    if (
      item.tipo === 'PARCELA_FOREIGN_PENDENTE' &&
      item.foreignExpenseId &&
      item.parcelaIndex != null
    ) {
      setOpen(false);
      setQuitar({
        foreignExpenseId: item.foreignExpenseId,
        parcelaIndex: item.parcelaIndex,
        valor: item.valor,
        descricao: item.descricao,
        data: item.data.slice(0, 10),
      });
      return;
    }
    if (item.tipo === 'RECEBIMENTO_PREVISTO_ATRASADO' && item.receiptId) {
      setOpen(false);
      setEditReceita({
        id: item.receiptId,
        valor: item.valor,
        data: item.data,
        tipo: 'OUTROS',
        status: 'PREVISTO',
        descricao: item.descricao,
      });
    }
  };

  if (isLoading || !data || data.total === 0) return null;

  return (
    <>
      <div className="mb-4 rounded-2xl border border-[#FEC84B]/50 bg-[#FFFAEB] p-3 text-[#B54708] md:mb-5 md:p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.15em]">Precisa de você</p>
            <p className="text-sm font-semibold">
              {data.total} pendência{data.total === 1 ? '' : 's'} financeira{data.total === 1 ? '' : 's'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex min-h-[36px] items-center gap-1.5 rounded-xl border border-[#FDB022] bg-white px-3 text-xs font-semibold text-[#B54708] transition hover:bg-[#FFFAEB]"
          >
            <AlertTriangle className="h-3.5 w-3.5" />
            Resolver
          </button>
        </div>
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="Precisa de você" variant="sheet" size="sm">
        <div className="space-y-4 pb-2">
          {data.grupos.map((group) => (
            <section key={group.tipo} className="rounded-xl border border-lifeone-hairline bg-lifeone-card p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-sm font-semibold text-lifeone-ink">{group.label}</p>
                <p className="text-[11px] font-medium text-lifeone-ink-3">
                  {group.count} · {formatCurrency(group.valorTotal / 100)}
                </p>
              </div>
              <div className="space-y-2">
                {group.itens.map((item) => (
                  <div key={item.id} className="rounded-lg border border-lifeone-hairline px-2.5 py-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-medium text-lifeone-ink">{item.descricao}</p>
                        <p className="text-[11px] text-lifeone-ink-3">
                          {formatCurrency(item.valor / 100)} · {new Date(item.data).toLocaleDateString('pt-BR')}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleItemAction(item)}
                        className="shrink-0 rounded-lg border border-lifeone-hairline px-2 py-1 text-[11px] font-semibold text-lifeone-blue hover:border-lifeone-blue"
                      >
                        {item.label}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </Modal>

      <Modal
        open={categoriaItem != null}
        onClose={() => {
          setCategoriaItem(null);
          setCategoriaEscolhida('');
          reopenQueue();
        }}
        title="Escolher categoria"
        variant="sheet"
        size="sm"
      >
        {categoriaItem && (
          <div className="space-y-3 pb-2">
            <div className="rounded-xl border border-lifeone-hairline bg-lifeone-card p-3">
              <p className="truncate text-[13px] font-medium text-lifeone-ink">{categoriaItem.descricao}</p>
              <p className="text-[11px] text-lifeone-ink-3">
                {formatCurrency(categoriaItem.valor / 100)} · {new Date(categoriaItem.data).toLocaleDateString('pt-BR')}
              </p>
            </div>
            {categoriaItem.suggestionTipoDespesa && (
              <p className="text-[11px] text-lifeone-ink-3">
                Sugestão: <span className="font-semibold text-lifeone-ink">{tipoLabel(categoriaItem.suggestionTipoDespesa)}</span>
              </p>
            )}
            <label className="block space-y-1">
              <span className="text-[11px] font-semibold text-lifeone-ink-3">Categoria</span>
              <select
                value={categoriaEscolhida}
                onChange={(e) => setCategoriaEscolhida(e.target.value)}
                className="h-11 w-full rounded-xl border border-lifeone-hairline bg-lifeone-card px-3 text-sm text-lifeone-ink outline-none focus:border-lifeone-blue"
              >
                {categoriaOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={!categoriaEscolhida || confirmCategoriaMutation.isPending}
              onClick={() => confirmCategoriaMutation.mutate({ item: categoriaItem, tipoDespesa: categoriaEscolhida })}
              className="inline-flex min-h-[44px] w-full items-center justify-center rounded-xl bg-lifeone-blue px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              Confirmar categoria
            </button>
          </div>
        )}
      </Modal>

      <BulkLinkModal
        open={vincularExpense != null}
        onClose={() => {
          setVincularExpenseId(null);
          reopenQueue();
        }}
        portal
        currentProjectId={projectId}
        preselectedSources={vincularExpense ? [vincularExpense] : undefined}
      />

      <ReceitaModal
        open={editReceita != null}
        onClose={() => {
          setEditReceita(null);
          reopenQueue();
        }}
        projectId={projectId}
        editing={editReceita}
      />

      {selectedCard && accountView && (
        <PagarFaturaDialog
          projectId={projectId}
          card={selectedCard}
          contas={accountView.contas ?? []}
          onClose={() => {
            setPayCardLast4(null);
            reopenQueue();
          }}
        />
      )}

      {quitar && (
        <QuitarParcelaModal
          projectId={projectId}
          foreignExpenseId={quitar.foreignExpenseId}
          parcelaIndex={quitar.parcelaIndex}
          valorSugerido={quitar.valor}
          descricao={quitar.descricao}
          dataSugerida={quitar.data}
          onDone={() => {
            setQuitar(null);
            reopenQueue();
          }}
          onClose={() => {
            setQuitar(null);
            reopenQueue();
          }}
        />
      )}
    </>
  );
}
