'use client';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import { CreateLinkedExpenseModal, type LinkedExpenseDraft } from './CreateLinkedExpenseModal';

interface TenantCard {
  id: string;
  nickname?: string | null;
  brand: string;
  last4: string;
  project?: { id: string; name: string; type: string } | null;
}

interface TenantAccount {
  id: string;
  nickname?: string | null;
  institution: string;
  last4?: string | null;
  project?: { id: string; name: string; type: string } | null;
}

interface CrossExpense {
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
  projectId: string;
  /** Valor atual de cada campo (controlled). */
  value: {
    creditCardId: string;
    bankAccountId: string;
    linkedExpenseId: string;
  };
  /** Quando o usuário muda algum campo. */
  onChange: (next: Props['value']) => void;
  /** Disparado quando o usuário seleciona uma despesa cross-project (para herdar características). */
  onLinkSelected?: (exp: CrossExpense) => void;
  /** Hint do last4 atual da despesa em edição (para pré-selecionar cartão/conta sem ID). */
  initialCardLast4?: string | null;
  initialBankLast4?: string | null;
  initialLinkedExpenseId?: string | null;
  /** Resumo da despesa já vinculada (vinda do servidor) — exibe nome do projeto. */
  initialLinkedExpenseLabel?: string | null;
  /** Snapshot dos campos atuais do form pai — usado para pré-preencher o modal
   *  "Criar nova despesa em outro projeto e vincular". */
  baseDraft?: LinkedExpenseDraft;
}

/**
 * Seção "Vínculos" do formulário de despesa: cartão, conta bancária, e despesa
 * cross-project. Renderiza apenas selects/inputs (não envia ao servidor — o pai
 * consome `value` no submit).
 */
export function VinculosFields({
  projectId,
  value,
  onChange,
  onLinkSelected,
  initialCardLast4,
  initialBankLast4,
  initialLinkedExpenseId,
  initialLinkedExpenseLabel,
  baseDraft,
}: Props) {
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [createdLabel, setCreatedLabel] = useState<string | null>(null);
  const { data: cards = [] } = useQuery<TenantCard[]>({
    queryKey: ['tenant', 'credit-cards'],
    queryFn: () => api.get('/tenant/credit-cards'),
    staleTime: 60_000,
  });

  const { data: accounts = [] } = useQuery<TenantAccount[]>({
    queryKey: ['tenant', 'bank-accounts'],
    queryFn: () => api.get('/tenant/bank-accounts'),
    staleTime: 60_000,
  });

  // Pré-seleção por last4 quando temos somente o denormalizado (despesa antiga)
  useEffect(() => {
    if (!value.creditCardId && initialCardLast4 && cards.length) {
      const match = cards.find((c) => c.last4 === initialCardLast4);
      if (match) onChange({ ...value, creditCardId: match.id });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards.length, initialCardLast4]);

  useEffect(() => {
    if (!value.bankAccountId && initialBankLast4 && accounts.length) {
      const match = accounts.find((a) => a.last4 === initialBankLast4);
      if (match) onChange({ ...value, bankAccountId: match.id });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts.length, initialBankLast4]);

  useEffect(() => {
    if (initialLinkedExpenseId && !value.linkedExpenseId) {
      onChange({ ...value, linkedExpenseId: initialLinkedExpenseId });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialLinkedExpenseId]);

  const cardOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [{ value: '', label: 'Nenhum' }];
    for (const c of cards) {
      const proj = c.project?.name ? ` · ${c.project.name}` : '';
      opts.push({
        value: c.id,
        label: `${c.nickname || c.brand} ****${c.last4}${proj}`,
      });
    }
    return opts;
  }, [cards]);

  const accountOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [{ value: '', label: 'Nenhuma' }];
    for (const a of accounts) {
      const proj = a.project?.name ? ` · ${a.project.name}` : '';
      const tail = a.last4 ? ` ****${a.last4}` : '';
      opts.push({
        value: a.id,
        label: `${a.nickname || a.institution}${tail}${proj}`,
      });
    }
    return opts;
  }, [accounts]);

  // Cross-project search (lazy)
  const [search, setSearch] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const { data: crossExpenses = [], isFetching: searching } = useQuery<CrossExpense[]>({
    queryKey: ['cross-project-expenses', projectId, search],
    queryFn: () =>
      api.get(`/projects/${projectId}/expenses/cross-project?limit=20${search ? `&search=${encodeURIComponent(search)}` : ''}`),
    enabled: searchOpen,
    staleTime: 20_000,
  });

  const selectedCross = crossExpenses.find((e) => e.id === value.linkedExpenseId);
  const displayLabel = selectedCross
    ? `${selectedCross.titulo || selectedCross.fornecedor || '—'} · ${formatCurrency(selectedCross.valorTotal / 100)} · ${selectedCross.project?.name ?? ''}`
    : createdLabel ?? initialLinkedExpenseLabel ?? null;

  return (
    <div className="space-y-3 border-t pt-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Vínculos (opcional)</p>
      </div>

      <Select
        label="Pago no cartão"
        name="creditCardId"
        options={cardOptions}
        value={value.creditCardId}
        onChange={(e) => onChange({ ...value, creditCardId: e.target.value })}
      />

      <Select
        label="Pago pela conta"
        name="bankAccountId"
        options={accountOptions}
        value={value.bankAccountId}
        onChange={(e) => onChange({ ...value, bankAccountId: e.target.value })}
      />

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Vincular a despesa de outro projeto
        </label>
        {value.linkedExpenseId ? (
          <div className="flex items-center gap-2 rounded border border-blue-200 bg-blue-50 px-2 py-1.5 text-sm">
            <span className="flex-1 truncate text-blue-900">
              🔗 {displayLabel ?? value.linkedExpenseId}
            </span>
            <button
              type="button"
              className="text-xs text-blue-700 hover:underline"
              onClick={() => {
                onChange({ ...value, linkedExpenseId: '' });
                setCreatedLabel(null);
              }}
            >
              Remover
            </button>
          </div>
        ) : (
          <div>
            <Input
              placeholder="Buscar por título ou fornecedor (outros projetos)…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setSearchOpen(true);
              }}
              onFocus={() => setSearchOpen(true)}
            />
            {searchOpen && (
              <div className="mt-1 max-h-48 overflow-auto rounded border border-gray-200 bg-white text-sm shadow-sm">
                {searching && <div className="px-3 py-2 text-gray-500">Buscando…</div>}
                {!searching && crossExpenses.length === 0 && (
                  <div className="px-3 py-2 text-gray-500">
                    Nenhuma despesa encontrada nos outros projetos.
                    {' '}
                    <button
                      type="button"
                      className="font-medium text-blue-700 hover:underline"
                      onClick={() => {
                        setSearchOpen(false);
                        setCreateModalOpen(true);
                      }}
                    >
                      Criar nova em outro projeto →
                    </button>
                  </div>
                )}
                {crossExpenses.map((exp) => (
                  <button
                    key={exp.id}
                    type="button"
                    className="block w-full px-3 py-1.5 text-left hover:bg-orange-50"
                    onClick={() => {
                      onChange({ ...value, linkedExpenseId: exp.id });
                      onLinkSelected?.(exp);
                      setSearchOpen(false);
                      setSearch('');
                    }}
                  >
                    <div className="font-medium text-gray-900 truncate">
                      {exp.titulo || exp.fornecedor || '—'}
                    </div>
                    <div className="text-xs text-gray-500">
                      {formatCurrency(exp.valorTotal / 100)} · {exp.status} · {exp.project?.name ?? '—'}
                      {exp.dataPagamento ? ` · ${formatDateBR(exp.dataPagamento)}` : ''}
                    </div>
                  </button>
                ))}
              </div>
            )}
            <p className="mt-2 text-xs text-gray-500">
              Vincule esta despesa a outra de outro projeto (ex.: IPTU pago no Pessoal → atribuído à Casa) para
              evitar dupla contagem.
            </p>
            <button
              type="button"
              className="mt-2 w-full rounded-lg border border-blue-300 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700 hover:bg-blue-100 transition-colors"
              onClick={() => setCreateModalOpen(true)}
            >
              + Criar despesa em outro projeto e vincular
            </button>
          </div>
        )}
      </div>

      <CreateLinkedExpenseModal
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        currentProjectId={projectId}
        defaults={baseDraft ?? {}}
        onCreated={(exp) => {
          onChange({ ...value, linkedExpenseId: exp.id });
          setCreatedLabel(
            `${exp.titulo || exp.fornecedor || '—'} · ${formatCurrency(exp.valorTotal / 100)} · ${exp.project?.name ?? ''}`,
          );
          onLinkSelected?.(exp);
        }}
      />
    </div>
  );
}
