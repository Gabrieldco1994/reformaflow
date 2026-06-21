import { Mic, Zap, CalendarClock } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { tipoLabel } from '@/lib/expense-options';
import { formatCurrency } from '@/lib/utils';
import type { Expense } from '@/types';

interface PayOptionsModalProps {
  open: boolean;
  onClose: () => void;
  onOpenNewPaidForm: () => void;
  onOpenVoiceModal: () => void;
  /** Abre o formulário detalhado em modo PLANEJAR (despesa futura). */
  onOpenPlanForm?: () => void;
  /** Slot para o acionador de importação (fatura/extrato). */
  importSlot?: ReactNode;
  plannedExpenses: Expense[];
  onPay: (id: string) => void;
  payDisabled: boolean;
}

/**
 * Sheet único de lançamento ("Nova despesa"): consolida os caminhos de
 * entrada — rápido (já paga), planejar (futura), por voz — e a lista de
 * despesas planejadas para marcar como pagas.
 */
export function PayOptionsModal({
  open,
  onClose,
  onOpenNewPaidForm,
  onOpenVoiceModal,
  onOpenPlanForm,
  importSlot,
  plannedExpenses,
  onPay,
  payDisabled,
}: PayOptionsModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Nova despesa">
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <button
            type="button"
            onClick={onOpenNewPaidForm}
            className="flex items-center gap-3 rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-left transition-colors hover:bg-orange-100"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-orange-500 text-white">
              <Zap className="h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-darc-velvet">Despesa paga</span>
              <span className="block text-[11px] text-darc-velvet/50">Já saiu — registrar agora</span>
            </span>
          </button>

          {onOpenPlanForm && (
            <button
              type="button"
              onClick={onOpenPlanForm}
              className="flex items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-left transition-colors hover:bg-amber-100"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-500 text-white">
                <CalendarClock className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-darc-velvet">Planejar</span>
                <span className="block text-[11px] text-darc-velvet/50">Despesa futura / a pagar</span>
              </span>
            </button>
          )}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            onClick={onOpenVoiceModal}
          >
            <Mic className="w-4 h-4" /> Lançar por voz
          </Button>
          {importSlot && <div className="w-full [&_button]:w-full">{importSlot}</div>}
        </div>
        <div className="border-t pt-4">
          <p className="text-sm font-medium text-gray-700 mb-2">Marcar planejada como paga:</p>
          {plannedExpenses.length === 0 ? (
            <p className="text-sm text-gray-400">Nenhuma despesa planejada encontrada.</p>
          ) : (
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {plannedExpenses.map((exp) => (
                <button
                  key={exp.id}
                  onClick={() => onPay(exp.id)}
                  className="w-full text-left p-3 border rounded-lg hover:bg-green-50 hover:border-green-300 transition-colors"
                  disabled={payDisabled}
                >
                  <div className="flex justify-between">
                    <span className="font-medium text-sm">{tipoLabel(exp.tipoDespesa)}</span>
                    <span className="text-sm font-medium">{formatCurrency(exp.valorTotal / 100)}</span>
                  </div>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {exp.fornecedor ?? ''} {exp.room?.name ? `· ${exp.room.name}` : ''}
                  </p>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
