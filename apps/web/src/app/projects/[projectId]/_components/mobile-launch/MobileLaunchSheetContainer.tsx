'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CreditCard, Landmark } from 'lucide-react';
import { ExpenseType } from '@reformaflow/domain';
import { api } from '@/lib/api';
import { Modal } from '@/components/ui/modal';
import { useProject } from '@/contexts/project-context';
import { invalidateExpenseQueries } from '../../expenses/_hooks/useExpenseMutations';
import { getExpenseOptions } from '../../expenses/_types';
import { useVoiceExpense } from '../../expenses/_hooks/useVoiceExpense';
import { VoiceExpenseModal } from '../../expenses/_components/VoiceExpenseModal';
import ImportStatementModal from '../../credit-cards/_components/ImportStatementModal';
import ImportBankStatementModal from '../../bank-accounts/_components/ImportBankStatementModal';
import { currentMonthKey } from '../../conta/_lib';
import { ReceitaModal } from '../../conta/_components/ReceitaModal';
import type { AccountViewResponse, OriginItemsYearlyResponse } from '../../conta/_types';
import { MobileLaunchSheet } from './MobileLaunchSheet';
import { MobileLaunchModeSheet } from './MobileLaunchModeSheet';
import type { LaunchAccountOption, LaunchCardOption, LaunchPayload } from './types';

interface Props {
  projectId: string;
  open: boolean;
  onClose: () => void;
}

type CreatedExpense = { id: string };
type LaunchScreen = 'choose' | 'despesa' | 'planejar' | 'recebimento' | 'voz' | 'fatura' | 'extrato' | 'foto';

const cardLabel = (c: LaunchCardOption) =>
  [c.nickname || c.brand || 'Cartão', c.last4 ? `•${c.last4}` : null].filter(Boolean).join(' ');
const accountLabel = (a: LaunchAccountOption) =>
  [a.nickname || a.institution || 'Conta', a.last4 ? `•${a.last4}` : null].filter(Boolean).join(' ');

export function MobileLaunchSheetContainer({ projectId, open, onClose }: Props) {
  const queryClient = useQueryClient();
  const { projectType } = useProject();
  const month = currentMonthKey();
  const year = month.slice(0, 4);

  const [screen, setScreen] = useState<LaunchScreen>('choose');
  const [selectedCardId, setSelectedCardId] = useState<string | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);

  // Cada abertura do "+" recomeça na escolha de modo (critério de aceite).
  useEffect(() => {
    if (open) {
      setScreen('choose');
      setSelectedCardId(null);
      setSelectedAccountId(null);
    }
  }, [open]);

  // Origens só do PROJETO ATUAL: CreditCard/BankAccount têm projectId no schema,
  // então os endpoints /tenant/* (tenant-wide) traziam cartões/contas de outros
  // projetos. Os project-scoped retornam a entidade completa (id, nickname, last4,
  // closingDay, dueDay) — cada label vem do nickname da própria entidade.
  const { data: accounts = [] } = useQuery<LaunchAccountOption[]>({
    queryKey: ['project', projectId, 'bank-accounts'],
    queryFn: () => api.get(`/projects/${projectId}/bank-accounts`),
    enabled: open,
    staleTime: 60_000,
  });

  const { data: cards = [] } = useQuery<LaunchCardOption[]>({
    queryKey: ['project', projectId, 'credit-cards'],
    queryFn: () => api.get(`/projects/${projectId}/credit-cards`),
    enabled: open,
    staleTime: 60_000,
  });

  const { data: accountView } = useQuery<AccountViewResponse>({
    queryKey: ['account-view', projectId, month],
    queryFn: () => api.get(`/projects/${projectId}/monthly-overview/account-view?month=${month}`),
    enabled: open,
  });

  const { data: yearlyItems } = useQuery<OriginItemsYearlyResponse>({
    queryKey: ['origin-items-yearly', projectId, year, 'all'],
    queryFn: () => api.get(`/projects/${projectId}/monthly-overview/origin-items-yearly?year=${year}&kind=all`),
    enabled: open,
  });
  // Cartões/contas/projetos do tenant — usados pela IA de voz para auto-vincular
  // ("no Itaú", "no 5868", "para a reforma"). Mesmas queries do ExpensesView.
  const { data: tenantCards = [] } = useQuery<
    Array<{ id: string; last4: string; nickname?: string | null; brand?: string | null; closingDay?: number | null; dueDay?: number | null }>
  >({
    queryKey: ['tenant', 'credit-cards'],
    queryFn: () => api.get('/tenant/credit-cards'),
    enabled: open,
    staleTime: 60_000,
  });
  const { data: tenantAccounts = [] } = useQuery<
    Array<{ id: string; last4?: string | null; nickname?: string | null; institution?: string | null }>
  >({
    queryKey: ['tenant', 'bank-accounts'],
    queryFn: () => api.get('/tenant/bank-accounts'),
    enabled: open,
    staleTime: 60_000,
  });
  const { data: tenantProjects = [] } = useQuery<Array<{ id: string; name: string; type: string }>>({
    queryKey: ['tenant', 'projects'],
    queryFn: () => api.get('/projects'),
    enabled: open,
    staleTime: 60_000,
  });

  const tipoDespesaOptions = useMemo(() => getExpenseOptions(projectType), [projectType]);
  const allowedExpenseTypes = useMemo(
    () => tipoDespesaOptions.map((o) => o.value as ExpenseType),
    [tipoDespesaOptions],
  );
  const defaultExpenseType = (tipoDespesaOptions[0]?.value ?? ExpenseType.OUTROS) as ExpenseType;

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/projects/${projectId}/expenses/${id}`),
    onSuccess: () => {
      invalidateExpenseQueries(queryClient, projectId);
      queryClient.invalidateQueries({ queryKey: ['origin-items-yearly', projectId] });
      toast.success('Lançamento desfeito');
    },
    onError: (error: Error) => toast.error(`Não foi possível desfazer: ${error.message}`),
  });

  const createMutation = useMutation({
    mutationFn: (payload: LaunchPayload) => api.post<CreatedExpense>(`/projects/${projectId}/expenses`, payload),
    onSuccess: (created, variables) => {
      invalidateExpenseQueries(queryClient, projectId);
      queryClient.invalidateQueries({ queryKey: ['origin-items-yearly', projectId] });
      toast.success('Despesa lançada', {
        description: `${variables.titulo ?? 'Despesa'} · ${new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(variables.valor)}`,
        action: created?.id
          ? {
              label: 'Desfazer',
              onClick: () => deleteMutation.mutate(created.id),
            }
          : undefined,
      });
    },
    onError: (error: Error) => toast.error(`Erro ao lançar despesa: ${error.message}`),
  });
  const handleClose = useCallback(() => {
    setScreen('choose');
    setSelectedCardId(null);
    setSelectedAccountId(null);
    onClose();
  }, [onClose]);

  const handleImported = useCallback(() => {
    invalidateExpenseQueries(queryClient, projectId);
    queryClient.invalidateQueries({ queryKey: ['origin-items-yearly', projectId] });
    handleClose();
  }, [queryClient, projectId, handleClose]);

  const voice = useVoiceExpense({
    allowedExpenseTypes,
    defaultExpenseType,
    onCreate: (data, onSuccess) =>
      createMutation.mutate(data as LaunchPayload, {
        onSuccess: () => {
          onSuccess();
          handleClose();
        },
      }),
    cards: tenantCards,
    accounts: tenantAccounts,
    projects: tenantProjects,
    currentProjectId: projectId,
  });

  // Cartão/conta únicos → pula o "para qual?" e vai direto ao import (menos 1 toque).
  useEffect(() => {
    if (open && screen === 'fatura' && cards.length === 1) setSelectedCardId(cards[0].id);
  }, [open, screen, cards]);
  useEffect(() => {
    if (open && screen === 'extrato' && accounts.length === 1) setSelectedAccountId(accounts[0].id);
  }, [open, screen, accounts]);

  const recentDescriptions = useMemo(() => {
    const unique = new Set<string>();
    for (const item of yearlyItems?.items ?? []) {
      // Remove sufixo cru de parcela ("Sofá — parcela 4/10" → "Sofá") para o chip
      // não vazar "4/10" nem duplicar a mesma compra parcelada.
      const label = item.descricao?.replace(/\s*[—–-]?\s*(parcela\s*)?\d+\s*\/\s*\d+\s*$/i, '').trim();
      if (!label) continue;
      unique.add(label);
      if (unique.size >= 8) break;
    }
    return Array.from(unique);
  }, [yearlyItems]);

  return (
    <>
      <MobileLaunchModeSheet
        open={open && screen === 'choose'}
        onClose={handleClose}
        onPick={(mode) => setScreen(mode === 'foto' ? 'foto' : mode)}
        voiceSupported={voice.voiceSupported}
      />

      <MobileLaunchSheet
        open={open && screen === 'despesa'}
        onClose={handleClose}
        onLaunch={(payload) => createMutation.mutateAsync(payload).then(() => handleClose())}
        launching={createMutation.isPending}
        accounts={accounts}
        cards={cards}
        recentDescriptions={recentDescriptions}
        projectType={projectType}
        projectedBalanceCents={accountView?.sobraPrevista ?? null}
      />

      <MobileLaunchSheet
        open={open && screen === 'planejar'}
        mode="PLANEJAR"
        onClose={handleClose}
        onLaunch={(payload) => createMutation.mutateAsync(payload).then(() => handleClose())}
        launching={createMutation.isPending}
        accounts={accounts}
        cards={cards}
        recentDescriptions={recentDescriptions}
        projectType={projectType}
        projectedBalanceCents={accountView?.sobraPrevista ?? null}
      />

      <ReceitaModal
        open={open && screen === 'recebimento'}
        onClose={handleClose}
        projectId={projectId}
        defaultData={new Date().toISOString().slice(0, 10)}
      />

      <VoiceExpenseModal
        open={open && screen === 'voz'}
        onClose={() => {
          voice.closeVoiceModal();
          handleClose();
        }}
        voiceSupported={voice.voiceSupported}
        voiceListening={voice.voiceListening}
        voiceTranscript={voice.voiceTranscript}
        voiceError={voice.voiceError}
        voiceData={voice.voiceData}
        setVoiceData={voice.setVoiceData}
        voiceFornecedor={voice.voiceFornecedor}
        setVoiceFornecedor={voice.setVoiceFornecedor}
        voiceLinkedExpenseId={voice.voiceLinkedExpenseId}
        setVoiceLinkedExpenseId={voice.setVoiceLinkedExpenseId}
        voiceLinkedProject={voice.voiceLinkedProject}
        startVoiceCapture={voice.startVoiceCapture}
        clearVoiceTranscript={voice.clearVoiceTranscript}
        saveVoiceExpense={voice.saveVoiceExpense}
        saveDisabled={!voice.voiceData?.valor || createMutation.isPending}
        tipoDespesaOptions={tipoDespesaOptions}
        cards={tenantCards}
        accounts={tenantAccounts}
        currentProjectId={projectId}
      />

      {/* Sub-tela de foto: oferece fatura ou extrato */}
      {open && screen === 'foto' && (
        <Modal open onClose={handleClose} title="Como quer importar?">
          <div className="space-y-2">
            <button
              onClick={() => setScreen('fatura')}
              className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-left hover:border-orange-300 hover:bg-orange-50"
            >
              <CreditCard className="h-4 w-4 text-orange-500" />
              <span className="text-sm font-medium">Fatura de cartão</span>
            </button>
            <button
              onClick={() => setScreen('extrato')}
              className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-left hover:border-teal-300 hover:bg-teal-50"
            >
              <Landmark className="h-4 w-4 text-teal-500" />
              <span className="text-sm font-medium">Extrato bancário</span>
            </button>
          </div>
        </Modal>
      )}

      {open && screen === 'fatura' && !selectedCardId && (
        <Modal open onClose={handleClose} title="Para qual cartão é essa fatura?">
          {cards.length === 0 ? (
            <p className="text-sm text-gray-600">
              Nenhum cartão cadastrado. Cadastre em <strong>Cartões</strong> antes de importar a fatura.
            </p>
          ) : (
            <div className="space-y-2">
              {cards.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSelectedCardId(c.id)}
                  className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-left hover:border-orange-300 hover:bg-orange-50"
                >
                  <CreditCard className="h-4 w-4 text-orange-500" />
                  <span className="text-sm font-medium">{cardLabel(c)}</span>
                </button>
              ))}
            </div>
          )}
        </Modal>
      )}
      {open && screen === 'fatura' && selectedCardId && (
        <ImportStatementModal
          projectId={projectId}
          card={(cards.find((c) => c.id === selectedCardId) ?? { id: selectedCardId }) as never}
          onClose={handleClose}
          onCommitted={handleImported}
        />
      )}

      {open && screen === 'extrato' && !selectedAccountId && (
        <Modal open onClose={handleClose} title="Para qual conta é esse extrato?">
          {accounts.length === 0 ? (
            <p className="text-sm text-gray-600">
              Nenhuma conta cadastrada. Cadastre em <strong>Contas Bancárias</strong> antes de importar o extrato.
            </p>
          ) : (
            <div className="space-y-2">
              {accounts.map((a) => (
                <button
                  key={a.id}
                  onClick={() => setSelectedAccountId(a.id)}
                  className="flex min-h-11 w-full items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-left hover:border-teal-300 hover:bg-teal-50"
                >
                  <Landmark className="h-4 w-4 text-teal-500" />
                  <span className="text-sm font-medium">{accountLabel(a)}</span>
                </button>
              ))}
            </div>
          )}
        </Modal>
      )}
      {open && screen === 'extrato' && selectedAccountId && (
        <ImportBankStatementModal
          projectId={projectId}
          account={(accounts.find((a) => a.id === selectedAccountId) ?? { id: selectedAccountId }) as never}
          onClose={handleClose}
          onCommitted={handleImported}
        />
      )}
    </>
  );
}
