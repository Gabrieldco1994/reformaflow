'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ExpenseType } from '@reformaflow/domain';
import { CreditCard, Landmark, ChevronRight } from 'lucide-react';
import { api } from '@/lib/api';
import type { Expense, ExpenseFormData } from '@/types';
import { getExpenseOptions } from '../_types';
import { PayOptionsModal } from './PayOptionsModal';
import { NovaDespesaWizard } from './NovaDespesaWizard';
import { RecorrenteWizard } from './RecorrenteWizard';
import { VoiceExpenseModal } from './VoiceExpenseModal';
import { SemCartaoEmptyState } from '../../_components/SemCartaoEmptyState';
import ImportStatementModal from '../../credit-cards/_components/ImportStatementModal';
import ImportBankStatementModal from '../../bank-accounts/_components/ImportBankStatementModal';
import { ReceitaModal } from '../../conta/_components/ReceitaModal';
import { Modal } from '@/components/ui/modal';
import { useVoiceExpense } from '../_hooks/useVoiceExpense';

interface Props {
  projectId: string;
  projectType: string;
  /** Render do gatilho (botão). Recebe `open` para abrir o modal unificado. */
  trigger: (open: () => void) => ReactNode;
  /** Invalidação/refresh extra após qualquer lançamento (além das queries padrão). */
  onChanged?: () => void;
}

/**
 * Launcher unificado de "Nova despesa" — mesmo fluxo em qualquer tela (Despesas
 * e Visão Conta): Despesa paga · Planejar · Despesa recorrente · Lançar por voz ·
 * Importar. Auto-contido (faz suas próprias queries/mutations); o consumidor só
 * fornece o gatilho e um callback opcional de refresh.
 */
export function NovaDespesaLauncher({ projectId, projectType, trigger, onChanged }: Props) {
  const queryClient = useQueryClient();
  const isPersonal = projectType === 'PESSOAL';

  const tipoOptions = useMemo(() => getExpenseOptions(projectType), [projectType]);
  const allowedExpenseTypes = useMemo(
    () => tipoOptions.map((o) => o.value as ExpenseType),
    [tipoOptions],
  );
  const defaultExpenseType = (tipoOptions[0]?.value ?? ExpenseType.OUTROS) as ExpenseType;

  const [payModalOpen, setPayModalOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardMode, setWizardMode] = useState<'PLANEJAR' | 'PAGA'>('PAGA');
  const [recorrenteOpen, setRecorrenteOpen] = useState(false);
  const [receitaOpen, setReceitaOpen] = useState(false);
  const [importStep, setImportStep] = useState<null | 'pick-card' | 'pick-account'>(null);
  const [selectedCard, setSelectedCard] = useState<{ id: string; last4: string; nickname?: string | null } | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<{ id: string; last4?: string | null; nickname?: string | null; institution?: string | null } | null>(null);

  const invalidate = () => {
    for (const key of ['expenses', 'cash-flow', 'account-view', 'monthly-overview', 'dashboard', 'cross-project-expenses']) {
      queryClient.invalidateQueries({ queryKey: [key, projectId] });
    }
    onChanged?.();
  };

  const { data: plannedExpenses = [] } = useQuery<Expense[]>({
    queryKey: ['expenses', projectId, 'planned'],
    queryFn: () => api.get(`/projects/${projectId}/expenses/planned`),
    enabled: payModalOpen || wizardOpen,
  });

  const { data: tenantCards = [] } = useQuery<
    Array<{ id: string; last4: string; nickname?: string | null; brand?: string | null; closingDay?: number | null; dueDay?: number | null }>
  >({
    queryKey: ['tenant', 'credit-cards'],
    queryFn: () => api.get('/tenant/credit-cards'),
    staleTime: 60_000,
  });
  const { data: tenantAccounts = [] } = useQuery<
    Array<{ id: string; last4?: string | null; nickname?: string | null; institution?: string | null }>
  >({
    queryKey: ['tenant', 'bank-accounts'],
    queryFn: () => api.get('/tenant/bank-accounts'),
    staleTime: 60_000,
  });
  const { data: tenantProjects = [] } = useQuery<Array<{ id: string; name: string; type: string }>>({
    queryKey: ['tenant', 'projects'],
    queryFn: () => api.get('/projects'),
    staleTime: 60_000,
  });

  const { data: importCards = [], isFetching: loadingCards } = useQuery<Array<{ id: string; last4: string; nickname?: string | null; brand?: string | null }>>({
    queryKey: ['credit-cards', projectId],
    queryFn: () => api.get(`/projects/${projectId}/credit-cards`),
    enabled: importStep === 'pick-card',
    staleTime: 30_000,
  });
  const { data: importAccounts = [], isFetching: loadingAccounts } = useQuery<Array<{ id: string; last4?: string | null; nickname?: string | null; institution?: string | null }>>({
    queryKey: ['bank-accounts', projectId],
    queryFn: () => api.get(`/projects/${projectId}/bank-accounts`),
    enabled: importStep === 'pick-account',
    staleTime: 30_000,
  });

  const createMutation = useMutation({
    mutationFn: (data: ExpenseFormData) => api.post(`/projects/${projectId}/expenses`, data),
    onSuccess: () => {
      toast.success('Despesa criada com sucesso');
      invalidate();
    },
    onError: (e: Error) => toast.error(`Erro ao criar despesa: ${e.message}`),
  });

  const payMutation = useMutation({
    mutationFn: (id: string) => api.post(`/projects/${projectId}/expenses/${id}/pay`, {}),
    onSuccess: () => {
      toast.success('Despesa paga');
      invalidate();
      setWizardOpen(false);
    },
    onError: (e: Error) => toast.error(`Erro ao pagar despesa: ${e.message}`),
  });

  const voice = useVoiceExpense({
    allowedExpenseTypes,
    defaultExpenseType,
    onCreate: (data, onSuccess) => createMutation.mutate(data, { onSuccess }),
    cards: tenantCards,
    accounts: tenantAccounts,
    projects: tenantProjects,
    currentProjectId: projectId,
  });

  return (
    <>
      {trigger(() => setPayModalOpen(true))}

      <PayOptionsModal
        open={payModalOpen}
        onClose={() => setPayModalOpen(false)}
        onOpenNewPaidForm={() => {
          setPayModalOpen(false);
          setWizardMode('PAGA');
          setWizardOpen(true);
        }}
        onOpenPlanForm={() => {
          setPayModalOpen(false);
          setWizardMode('PLANEJAR');
          setWizardOpen(true);
        }}
        onOpenRecorrenteForm={isPersonal ? () => {
          setPayModalOpen(false);
          setRecorrenteOpen(true);
        } : undefined}
        onOpenVoiceModal={() => {
          setPayModalOpen(false);
          voice.openVoiceModal();
        }}
        onImportCard={() => { setPayModalOpen(false); setImportStep('pick-card'); }}
        onImportAccount={() => { setPayModalOpen(false); setImportStep('pick-account'); }}
        onOpenNewReceiptForm={isPersonal ? () => {
          setPayModalOpen(false);
          setReceitaOpen(true);
        } : undefined}
      />

      <NovaDespesaWizard
        open={wizardOpen}
        mode={wizardMode}
        projectId={projectId}
        projectType={projectType}
        allowRecorrente={false}
        tipoOptions={tipoOptions}
        roomOptions={[]}
        showRooms={false}
        plannedExpenses={plannedExpenses}
        onPay={(id) => payMutation.mutate(id)}
        payDisabled={payMutation.isPending}
        onClose={() => setWizardOpen(false)}
        onCreated={invalidate}
      />

      <RecorrenteWizard
        open={recorrenteOpen}
        projectId={projectId}
        tipoOptions={tipoOptions}
        onClose={() => setRecorrenteOpen(false)}
        onCreated={invalidate}
      />

      <ReceitaModal
        open={receitaOpen}
        onClose={() => setReceitaOpen(false)}
        projectId={projectId}
        defaultData={new Date().toISOString().slice(0, 10)}
      />

      <VoiceExpenseModal
        open={voice.voiceModalOpen}
        onClose={voice.closeVoiceModal}
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
        tipoDespesaOptions={tipoOptions}
        cards={tenantCards}
        accounts={tenantAccounts}
        currentProjectId={projectId}
      />

      {importStep === 'pick-card' && !selectedCard && (
        <Modal open onClose={() => setImportStep(null)} title="Para qual cartão é essa fatura?">
          {loadingCards && <p className="text-sm text-gray-500">Carregando cartões…</p>}
          {!loadingCards && importCards.length === 0 && (
            <SemCartaoEmptyState projectId={projectId} />
          )}
          {!loadingCards && importCards.length > 0 && (
            <div className="space-y-2">
              {importCards.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setSelectedCard(c)}
                  className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-gray-200 hover:border-orange-300 hover:bg-orange-50 text-left"
                >
                  <span className="flex items-center gap-2">
                    <CreditCard className="w-4 h-4 text-orange-500" />
                    <span className="text-sm font-medium">{c.nickname || c.brand} •••• {c.last4}</span>
                  </span>
                  <ChevronRight className="w-4 h-4 text-gray-400" />
                </button>
              ))}
            </div>
          )}
        </Modal>
      )}

      {importStep === 'pick-account' && !selectedAccount && (
        <Modal open onClose={() => setImportStep(null)} title="Para qual conta é esse extrato?">
          {loadingAccounts && <p className="text-sm text-gray-500">Carregando contas…</p>}
          {!loadingAccounts && importAccounts.length === 0 && (
            <p className="text-sm text-gray-600">
              Nenhuma conta cadastrada. Cadastre em <strong>Contas Bancárias</strong> antes de importar.
            </p>
          )}
          {!loadingAccounts && importAccounts.length > 0 && (
            <div className="space-y-2">
              {importAccounts.map((a) => (
                <button
                  key={a.id}
                  onClick={() => setSelectedAccount(a)}
                  className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-gray-200 hover:border-teal-300 hover:bg-teal-50 text-left"
                >
                  <span className="flex items-center gap-2">
                    <Landmark className="w-4 h-4 text-teal-500" />
                    <span className="text-sm font-medium">{a.nickname || a.institution}{a.last4 ? ` •••• ${a.last4}` : ''}</span>
                  </span>
                  <ChevronRight className="w-4 h-4 text-gray-400" />
                </button>
              ))}
            </div>
          )}
        </Modal>
      )}

      {selectedCard && (
        <ImportStatementModal
          projectId={projectId}
          card={selectedCard as any}
          onClose={() => { setSelectedCard(null); setImportStep(null); }}
          onCommitted={() => { setSelectedCard(null); setImportStep(null); invalidate(); }}
        />
      )}

      {selectedAccount && (
        <ImportBankStatementModal
          projectId={projectId}
          account={selectedAccount as any}
          onClose={() => { setSelectedAccount(null); setImportStep(null); }}
          onCommitted={() => { setSelectedAccount(null); setImportStep(null); invalidate(); }}
        />
      )}
    </>
  );
}
