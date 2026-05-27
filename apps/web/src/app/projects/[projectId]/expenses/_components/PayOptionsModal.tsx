import { Mic } from 'lucide-react';
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
  plannedExpenses: Expense[];
  onPay: (id: string) => void;
  payDisabled: boolean;
}

export function PayOptionsModal({
  open,
  onClose,
  onOpenNewPaidForm,
  onOpenVoiceModal,
  plannedExpenses,
  onPay,
  payDisabled,
}: PayOptionsModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Pagar Despesa">
      <div className="space-y-4">
        <Button className="w-full" onClick={onOpenNewPaidForm}>Nova Despesa (já paga)</Button>
        <Button
          type="button"
          variant="secondary"
          className="w-full"
          onClick={onOpenVoiceModal}
        >
          <Mic className="w-4 h-4" /> Lançar por voz
        </Button>
        <div className="border-t pt-4">
          <p className="text-sm font-medium text-gray-700 mb-2">Pagar Despesa Planejada:</p>
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
