import { useMemo, useState } from 'react';
import { Mic } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import {
  ExpenseType,
  PaymentForm,
  isSinglePaymentForm,
  type ExpenseStatus,
  type VoiceMatchableAccount,
  type VoiceMatchableCard,
  type VoiceMatchableProject,
} from '@reformaflow/domain';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Modal } from '@/components/ui/modal';
import { FORMA_PAGAMENTO_OPTIONS } from '@/lib/expense-options';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import { CreateLinkedExpenseModal } from './CreateLinkedExpenseModal';

interface ExpenseOption {
  value: string;
  label: string;
}

export interface VoiceExpenseData {
  tipoDespesa: ExpenseType;
  titulo: string;
  valor: number | null;
  formaPagamento: PaymentForm;
  quantidadeParcela: number | null;
  status: ExpenseStatus;
  dataReferencia: string;
  creditCardId: string | null;
  bankAccountId: string | null;
  linkedProjectId: string | null;
}

interface CrossExpenseLite {
  id: string;
  titulo?: string | null;
  fornecedor?: string | null;
  valorTotal: number;
  status: string;
  dataPagamento?: string | null;
  project?: { id: string; name: string; type: string } | null;
}

interface VoiceExpenseModalProps {
  open: boolean;
  onClose: () => void;
  voiceSupported: boolean;
  voiceListening: boolean;
  voiceTranscript: string;
  voiceError: string;
  voiceData: VoiceExpenseData | null;
  setVoiceData: (data: VoiceExpenseData) => void;
  voiceFornecedor: string;
  setVoiceFornecedor: (value: string) => void;
  /** ID da despesa cross-project vinculada (escolhida ou recém-criada). */
  voiceLinkedExpenseId: string;
  setVoiceLinkedExpenseId: (value: string) => void;
  startVoiceCapture: () => void;
  clearVoiceTranscript: () => void;
  saveVoiceExpense: () => void;
  saveDisabled: boolean;
  tipoDespesaOptions: ExpenseOption[];
  /** Cartões disponíveis no tenant (com auto-seleção via voz). */
  cards: VoiceMatchableCard[];
  /** Contas bancárias do tenant. */
  accounts: VoiceMatchableAccount[];
  /** Projeto detectado pela voz para vínculo cross-project. */
  voiceLinkedProject: VoiceMatchableProject | null;
  /** ID do projeto atual — usado para busca cross-project. */
  currentProjectId: string;
}

export function VoiceExpenseModal({
  open,
  onClose,
  voiceSupported,
  voiceListening,
  voiceTranscript,
  voiceError,
  voiceData,
  setVoiceData,
  voiceFornecedor,
  setVoiceFornecedor,
  voiceLinkedExpenseId,
  setVoiceLinkedExpenseId,
  startVoiceCapture,
  clearVoiceTranscript,
  saveVoiceExpense,
  saveDisabled,
  tipoDespesaOptions,
  cards,
  accounts,
  voiceLinkedProject,
  currentProjectId,
}: VoiceExpenseModalProps) {
  const [createLinkedOpen, setCreateLinkedOpen] = useState(false);
  const [linkedSearch, setLinkedSearch] = useState('');
  const [linkedSearchOpen, setLinkedSearchOpen] = useState(false);
  // Label exibido para a despesa cross-project escolhida (existente ou recém-criada).
  const [linkedLabel, setLinkedLabel] = useState<string | null>(null);

  const cardOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [{ value: '', label: 'Nenhum' }];
    for (const c of cards) {
      opts.push({ value: c.id, label: `${c.nickname || c.brand} ****${c.last4}` });
    }
    return opts;
  }, [cards]);

  const accountOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [{ value: '', label: 'Nenhuma' }];
    for (const a of accounts) {
      const tail = a.last4 ? ` ****${a.last4}` : '';
      opts.push({ value: a.id, label: `${a.nickname || a.institution}${tail}` });
    }
    return opts;
  }, [accounts]);

  // Busca cross-project quando o usuário quer vincular a uma existente
  const { data: crossResults = [], isFetching: searching } = useQuery<CrossExpenseLite[]>({
    queryKey: ['cross-project-expenses', currentProjectId, 'voice', linkedSearch],
    queryFn: () =>
      api.get(
        `/projects/${currentProjectId}/expenses/cross-project?limit=15${
          linkedSearch ? `&search=${encodeURIComponent(linkedSearch)}` : ''
        }`,
      ),
    enabled: linkedSearchOpen,
    staleTime: 20_000,
  });

  return (
    <Modal open={open} onClose={onClose} title="Lançar despesa por voz">
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          Fale uma frase como: <span className="font-medium">&quot;Gastei 85 reais no mercado no Itaú Personnalité para a reforma&quot;</span>.
          A IA tenta vincular automaticamente o cartão/conta e o projeto destino.
        </p>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            onClick={startVoiceCapture}
            disabled={!voiceSupported || voiceListening}
          >
            <Mic className="w-4 h-4" /> {voiceListening ? 'Ouvindo...' : 'Capturar voz'}
          </Button>
          {voiceTranscript && (
            <Button type="button" variant="secondary" onClick={clearVoiceTranscript}>
              Limpar
            </Button>
          )}
        </div>

        {!voiceSupported && (
          <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
            Seu navegador não suporta reconhecimento de voz. Use o lançamento manual.
          </p>
        )}

        {voiceTranscript && (
          <div className="rounded border bg-gray-50 px-3 py-2">
            <p className="text-xs text-gray-500 mb-1">Transcrição</p>
            <p className="text-sm text-gray-800">{voiceTranscript}</p>
          </div>
        )}

        {voiceError && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
            {voiceError}
          </p>
        )}

        {voiceData && (
          <div className="space-y-3 rounded border p-3">
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Revisar antes de salvar</p>
            <Select
              label="Tipo da Despesa"
              name="voiceTipoDespesa"
              options={tipoDespesaOptions}
              value={voiceData.tipoDespesa}
              onChange={(e) => setVoiceData({ ...voiceData, tipoDespesa: e.target.value as ExpenseType })}
            />
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Valor (R$)"
                name="voiceValor"
                type="number"
                step="0.01"
                min="0"
                value={voiceData.valor ? String(voiceData.valor) : ''}
                onChange={(e) =>
                  setVoiceData({
                    ...voiceData,
                    valor: e.target.value ? Number.parseFloat(e.target.value) : null,
                  })
                }
              />
              <Select
                label="Forma de Pagamento"
                name="voiceFormaPagamento"
                options={FORMA_PAGAMENTO_OPTIONS}
                value={voiceData.formaPagamento}
                onChange={(e) =>
                  setVoiceData({
                    ...voiceData,
                    formaPagamento: e.target.value as PaymentForm,
                    quantidadeParcela: isSinglePaymentForm(e.target.value)
                      ? null
                      : (voiceData.quantidadeParcela ?? 1),
                  })
                }
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Select
                label="Status"
                name="voiceStatus"
                options={[
                  { value: 'PLANEJADO', label: 'Planejado' },
                  { value: 'PAGO', label: 'Pago' },
                ]}
                value={voiceData.status}
                onChange={(e) => setVoiceData({ ...voiceData, status: e.target.value as ExpenseStatus })}
              />
              {isSinglePaymentForm(voiceData.formaPagamento) ? (
                <Input
                  label="Data do Pagamento"
                  name="voiceDataPagamento"
                  type="date"
                  value={voiceData.dataReferencia}
                  onChange={(e) => setVoiceData({ ...voiceData, dataReferencia: e.target.value })}
                />
              ) : (
                <Input
                  label="Qtd Parcelas"
                  name="voiceQuantidadeParcela"
                  type="number"
                  min="1"
                  value={String(voiceData.quantidadeParcela ?? 1)}
                  onChange={(e) =>
                    setVoiceData({
                      ...voiceData,
                      quantidadeParcela: Math.max(1, Number.parseInt(e.target.value || '1', 10)),
                    })
                  }
                />
              )}
            </div>
            {!isSinglePaymentForm(voiceData.formaPagamento) && (
              <Input
                label="Data de Início"
                name="voiceDataInicioParcela"
                type="date"
                value={voiceData.dataReferencia}
                onChange={(e) => setVoiceData({ ...voiceData, dataReferencia: e.target.value })}
              />
            )}
            <Input
              label="Título"
              name="voiceTitulo"
              value={voiceData.titulo}
              onChange={(e) => setVoiceData({ ...voiceData, titulo: e.target.value })}
            />
            <Input
              label="Fornecedor"
              name="voiceFornecedor"
              value={voiceFornecedor}
              onChange={(e) => setVoiceFornecedor(e.target.value)}
            />

            {/* ── Vínculos automáticos detectados pela voz ────────────── */}
            <div className="space-y-3 rounded border border-blue-100 bg-blue-50/40 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-blue-700">
                Vínculos (IA detectou pela voz)
              </p>

              <Select
                label="Pago no cartão"
                name="voiceCreditCardId"
                options={cardOptions}
                value={voiceData.creditCardId ?? ''}
                onChange={(e) =>
                  setVoiceData({ ...voiceData, creditCardId: e.target.value || null })
                }
              />

              <Select
                label="Pago pela conta"
                name="voiceBankAccountId"
                options={accountOptions}
                value={voiceData.bankAccountId ?? ''}
                onChange={(e) =>
                  setVoiceData({ ...voiceData, bankAccountId: e.target.value || null })
                }
              />

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Vincular a despesa de outro projeto
                </label>
                {voiceLinkedExpenseId ? (
                  <div className="flex items-center gap-2 rounded border border-blue-200 bg-blue-50 px-2 py-1.5 text-sm">
                    <span className="flex-1 truncate text-blue-900">
                      🔗 {linkedLabel ?? voiceLinkedExpenseId}
                    </span>
                    <button
                      type="button"
                      className="text-xs text-blue-700 hover:underline"
                      onClick={() => {
                        setVoiceLinkedExpenseId('');
                        setLinkedLabel(null);
                      }}
                    >
                      Remover
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {voiceLinkedProject && (
                      <div className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
                        🎯 IA detectou projeto destino:{' '}
                        <span className="font-semibold">{voiceLinkedProject.name}</span> ·{' '}
                        {voiceLinkedProject.type}
                      </div>
                    )}
                    <Input
                      placeholder="Buscar despesa existente em outro projeto…"
                      value={linkedSearch}
                      onChange={(e) => {
                        setLinkedSearch(e.target.value);
                        setLinkedSearchOpen(true);
                      }}
                      onFocus={() => setLinkedSearchOpen(true)}
                    />
                    {linkedSearchOpen && (
                      <div className="max-h-40 overflow-auto rounded border border-gray-200 bg-white text-sm shadow-sm">
                        {searching && <div className="px-3 py-2 text-gray-500">Buscando…</div>}
                        {!searching && crossResults.length === 0 && (
                          <div className="px-3 py-2 text-gray-500">Nenhuma despesa encontrada.</div>
                        )}
                        {crossResults.map((exp) => (
                          <button
                            key={exp.id}
                            type="button"
                            className="block w-full px-3 py-1.5 text-left hover:bg-orange-50"
                            onClick={() => {
                              setVoiceLinkedExpenseId(exp.id);
                              setLinkedLabel(
                                `${exp.titulo || exp.fornecedor || '—'} · ${formatCurrency(
                                  exp.valorTotal / 100,
                                )} · ${exp.project?.name ?? ''}`,
                              );
                              setLinkedSearchOpen(false);
                              setLinkedSearch('');
                            }}
                          >
                            <div className="font-medium text-gray-900 truncate">
                              {exp.titulo || exp.fornecedor || '—'}
                            </div>
                            <div className="text-xs text-gray-500">
                              {formatCurrency(exp.valorTotal / 100)} · {exp.status} ·{' '}
                              {exp.project?.name ?? '—'}
                              {exp.dataPagamento ? ` · ${formatDateBR(exp.dataPagamento)}` : ''}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                    <button
                      type="button"
                      className="text-xs font-medium text-blue-700 hover:underline"
                      onClick={() => setCreateLinkedOpen(true)}
                    >
                      + Criar nova despesa em outro projeto e vincular
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="button" onClick={saveVoiceExpense} disabled={saveDisabled}>
            Salvar despesa
          </Button>
        </div>
      </div>

      {voiceData && (
        <CreateLinkedExpenseModal
          open={createLinkedOpen}
          onClose={() => setCreateLinkedOpen(false)}
          currentProjectId={currentProjectId}
          defaults={{
            titulo: voiceData.titulo,
            fornecedor: voiceFornecedor,
            tipoDespesa: voiceData.tipoDespesa,
            valor: voiceData.valor != null ? String(voiceData.valor) : '',
            quantidade: '1',
            formaPagamento: voiceData.formaPagamento,
          }}
          onCreated={(exp) => {
            setVoiceLinkedExpenseId(exp.id);
            setLinkedLabel(
              `${exp.titulo || exp.fornecedor || '—'} · ${formatCurrency(exp.valorTotal / 100)} · ${
                exp.project?.name ?? ''
              }`,
            );
          }}
        />
      )}
    </Modal>
  );
}
