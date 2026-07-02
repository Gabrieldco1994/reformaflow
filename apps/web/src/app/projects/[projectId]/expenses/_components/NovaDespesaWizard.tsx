'use client';
import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, ArrowRight, Zap, CalendarClock } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { tipoLabel } from '@/lib/expense-options';
import { formatCurrency } from '@/lib/utils';
import type { Expense } from '@/types';
import {
  useNovaDespesaWizard,
  makeInitialWizardState,
  type WizardMode,
  type WizardDraft,
} from '../_hooks/useNovaDespesaWizard';
import { buildExpenseFormData, buildRatearMixedPayload } from '../_lib/wizardPayload';
import { WizardStepDados } from './WizardStepDados';
import { WizardStepPagamento } from './WizardStepPagamento';
import { WizardStepAcao } from './WizardStepAcao';
import { VinculoBasket } from './VinculoBasket';

interface Option {
  value: string;
  label: string;
}

interface Props {
  open: boolean;
  mode: WizardMode;
  projectId: string;
  projectType: string;
  allowRecorrente: boolean;
  tipoOptions: Option[];
  roomOptions: Option[];
  showRooms: boolean;
  plannedExpenses: Expense[];
  onPay: (id: string) => void;
  payDisabled: boolean;
  onClose: () => void;
  onCreated?: () => void;
}

type PagaChoice = null | 'NOVA' | 'PLANEJADA';

const STEP_LABELS: Record<string, string> = {
  DADOS: 'Dados',
  PAGAMENTO: 'Pagamento',
  ACAO: 'Ação',
  CESTO: 'Vínculo',
};

/**
 * Shell do stepper "+Nova despesa". Orquestra os passos DADOS→PAGAMENTO→AÇÃO e,
 * no caminho de vínculo, o CESTO. Quando `mode==='PAGA'`, exibe primeiro um
 * garfo: "Nova despesa paga" (segue o wizard) OU "Pagar despesa planejada"
 * (lista as planejadas e liquida via `onPay`).
 */
export function NovaDespesaWizard({
  open,
  mode,
  projectId,
  projectType,
  allowRecorrente,
  tipoOptions,
  roomOptions,
  showRooms,
  plannedExpenses,
  onPay,
  payDisabled,
  onClose,
  onCreated,
}: Props) {
  const queryClient = useQueryClient();
  const { state, dispatch, guards, totals } = useNovaDespesaWizard(makeInitialWizardState(mode));
  const [saving, setSaving] = useState(false);
  const [pagaChoice, setPagaChoice] = useState<PagaChoice>(null);
  const [plannedSearch, setPlannedSearch] = useState('');

  const isReforma = projectType === 'REFORMA';
  const patch = (p: Partial<WizardDraft>) => dispatch({ type: 'SET_DRAFT', patch: p });

  // Reinicia o wizard sempre que abrir (ou trocar de modo).
  useEffect(() => {
    if (open) {
      dispatch({ type: 'START', mode });
      setPagaChoice(null);
      setPlannedSearch('');
      setSaving(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode]);

  function invalidateAll() {
    for (const key of ['expenses', 'cash-flow', 'dashboard', 'cross-project-expenses']) {
      queryClient.invalidateQueries({ queryKey: [key, projectId] });
    }
  }

  async function handlePlanejar() {
    if (saving) return;
    setSaving(true);
    try {
      const data = buildExpenseFormData(state.draft, { mode, allowRecorrente });
      await api.post(`/projects/${projectId}/expenses`, data);
      toast.success(mode === 'PAGA' ? 'Despesa registrada' : 'Despesa planejada');
      invalidateAll();
      onCreated?.();
      onClose();
    } catch (e) {
      toast.error(`Erro ao salvar: ${e instanceof Error ? e.message : 'desconhecido'}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleConfirmBasket() {
    if (saving) return;
    setSaving(true);
    try {
      const data = buildExpenseFormData(state.draft, { mode, allowRecorrente });
      const created = await api.post<{ id: string }>(`/projects/${projectId}/expenses`, data);
      // Sempre via ratear-mixed: regenera o caixa de cada alvo com o cronograma
      // da fonte escalado à alocação (respeita parcelas/datas/competência). O
      // /link puro só espelha e NÃO ajustaria o valor real do alvo.
      await api.post(
        `/projects/${projectId}/expenses/${created.id}/ratear-mixed`,
        buildRatearMixedPayload(state.basket),
      );
      toast.success('Vínculo realizado');
      invalidateAll();
      onCreated?.();
      onClose();
    } catch (e) {
      toast.error(`Erro ao vincular: ${e instanceof Error ? e.message : 'desconhecido'}`);
    } finally {
      setSaving(false);
    }
  }

  const filteredPlanned = useMemo(() => {
    const q = plannedSearch.trim().toLowerCase();
    if (!q) return plannedExpenses;
    return plannedExpenses.filter((exp) => {
      const hay = `${exp.titulo ?? ''} ${exp.fornecedor ?? ''} ${tipoLabel(exp.tipoDespesa)}`.toLowerCase();
      return hay.includes(q);
    });
  }, [plannedExpenses, plannedSearch]);

  if (!open) return null;

  // ── Garfo "Despesa paga": escolha inicial (NOVA vs PLANEJADA) ────────────────
  const showFork = mode === 'PAGA' && pagaChoice === null;
  const showPlannedList = mode === 'PAGA' && pagaChoice === 'PLANEJADA';
  const title = showPlannedList ? 'Pagar despesa planejada' : 'Nova despesa';

  return (
    <Modal open={open} onClose={onClose} title={title} size="lg">
      {showFork ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <button
            type="button"
            onClick={() => setPagaChoice('NOVA')}
            className="flex items-start gap-3 rounded-2xl border border-orange-200 bg-orange-50 px-4 py-4 text-left transition-colors hover:bg-orange-100 min-h-[44px]"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-orange-500 text-white">
              <Zap className="h-5 w-5" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-darc-velvet">Nova despesa paga</span>
              <span className="block text-xs text-darc-velvet/60">Registrar uma despesa que já saiu.</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => setPagaChoice('PLANEJADA')}
            className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-left transition-colors hover:bg-amber-100 min-h-[44px]"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-500 text-white">
              <CalendarClock className="h-5 w-5" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-darc-velvet">Pagar despesa planejada</span>
              <span className="block text-xs text-darc-velvet/60">Marcar uma despesa futura como paga.</span>
            </span>
          </button>
        </div>
      ) : showPlannedList ? (
        <div className="space-y-3">
          <Input
            placeholder="Filtrar por título ou fornecedor…"
            value={plannedSearch}
            onChange={(e) => setPlannedSearch(e.target.value)}
          />
          {filteredPlanned.length === 0 ? (
            <p className="text-sm text-gray-400">Nenhuma despesa planejada encontrada.</p>
          ) : (
            <div className="max-h-80 space-y-2 overflow-y-auto">
              {filteredPlanned.map((exp) => (
                <button
                  key={exp.id}
                  type="button"
                  onClick={() => onPay(exp.id)}
                  disabled={payDisabled}
                  className="w-full rounded-lg border p-3 text-left transition-colors hover:border-green-300 hover:bg-green-50 disabled:opacity-60 min-h-[44px]"
                >
                  <div className="flex justify-between">
                    <span className="text-sm font-medium">{exp.titulo || tipoLabel(exp.tipoDespesa)}</span>
                    <span className="text-sm font-medium">{formatCurrency(exp.valorTotal / 100)}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-gray-500">
                    {exp.fornecedor ?? ''} {exp.room?.name ? `· ${exp.room.name}` : ''}
                  </p>
                </button>
              ))}
            </div>
          )}
          <div className="pt-1">
            <Button type="button" variant="secondary" onClick={() => setPagaChoice(null)}>
              <ArrowLeft className="h-4 w-4" /> Voltar
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Progresso */}
          <div className="flex items-center gap-1.5 text-xs font-medium text-darc-velvet/40">
            {['DADOS', 'PAGAMENTO', 'ACAO'].map((s, i) => (
              <span key={s} className="flex items-center gap-1.5">
                {i > 0 && <span>·</span>}
                <span className={state.step === s ? 'text-darc-maroon' : ''}>{STEP_LABELS[s]}</span>
              </span>
            ))}
          </div>

          {/* Corpo por passo */}
          {state.step === 'DADOS' && (
            <WizardStepDados
              draft={state.draft}
              patch={patch}
              tipoOptions={tipoOptions}
              roomOptions={roomOptions}
              showRooms={showRooms}
            />
          )}
          {state.step === 'PAGAMENTO' && (
            <WizardStepPagamento
              draft={state.draft}
              patch={patch}
              allowRecorrente={allowRecorrente}
              enabled={state.step === 'PAGAMENTO'}
            />
          )}
          {state.step === 'ACAO' && (
            <WizardStepAcao
              draft={state.draft}
              mode={mode}
              totalCents={totals.totalFonteCents}
              onPlanejar={handlePlanejar}
              onVincular={() => dispatch({ type: 'GO_BASKET' })}
              saving={saving}
            />
          )}
          {state.step === 'CESTO' && (
            <VinculoBasket
              projectId={projectId}
              draft={state.draft}
              basket={state.basket}
              totals={totals}
              canSave={guards.canSaveBasket()}
              dispatch={dispatch}
              onConfirm={handleConfirmBasket}
              saving={saving}
            />
          )}

          {/* Rodapé de navegação */}
          <div className="sticky bottom-0 flex items-center justify-between gap-2 border-t border-darc-linen bg-white pt-3">
            {state.step === 'DADOS' ? (
              <Button type="button" variant="secondary" onClick={onClose}>
                Cancelar
              </Button>
            ) : (
              <Button type="button" variant="secondary" onClick={() => dispatch({ type: 'BACK' })}>
                <ArrowLeft className="h-4 w-4" /> Voltar
              </Button>
            )}

            {(state.step === 'DADOS' || state.step === 'PAGAMENTO') && (
              <Button
                type="button"
                onClick={() => dispatch({ type: 'NEXT', isReforma })}
                disabled={
                  state.step === 'DADOS'
                    ? !guards.canAdvanceDados(isReforma)
                    : !guards.canAdvancePagamento()
                }
              >
                Avançar <ArrowRight className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
