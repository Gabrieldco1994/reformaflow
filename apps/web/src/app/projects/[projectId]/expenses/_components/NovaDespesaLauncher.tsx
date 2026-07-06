'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ExpenseType } from '@reformaflow/domain';
import { api } from '@/lib/api';
import type { Expense, ExpenseFormData } from '@/types';
import { getExpenseOptions } from '../_types';
import { PayOptionsModal } from './PayOptionsModal';
import { NovaDespesaWizard } from './NovaDespesaWizard';
import { RecorrenteWizard } from './RecorrenteWizard';
import { VoiceExpenseModal } from './VoiceExpenseModal';
import ImportLauncher from './ImportLauncher';
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
        importSlot={
          <ImportLauncher
            projectId={projectId}
            onImported={() => {
              setPayModalOpen(false);
              invalidate();
            }}
          />
        }
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
    </>
  );
}
