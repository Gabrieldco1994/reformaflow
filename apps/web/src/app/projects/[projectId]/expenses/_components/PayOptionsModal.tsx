import { Mic, Zap, CalendarClock, CalendarRange, CreditCard, Landmark, ArrowDownCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';

interface PayOptionsModalProps {
  open: boolean;
  onClose: () => void;
  onOpenNewPaidForm: () => void;
  onOpenVoiceModal: () => void;
  /** Abre o formulário detalhado em modo PLANEJAR (despesa futura). */
  onOpenPlanForm?: () => void;
  /** Abre a jornada de despesa recorrente (gera N despesas planejadas). */
  onOpenRecorrenteForm?: () => void;
  /** Abre o picker de cartão para importar fatura. */
  onImportCard?: () => void;
  /** Abre o picker de conta para importar extrato bancário. */
  onImportAccount?: () => void;
  /** Abre o formulário de novo recebimento. */
  onOpenNewReceiptForm?: () => void;
}

/**
 * Sheet único de lançamento ("Nova despesa"): consolida os caminhos de
 * entrada — rápido (já paga), planejar (futura), recorrente (repete no tempo),
 * por voz — e a importação.
 * O pagamento de despesas planejadas vive no wizard ("Despesa paga" →
 * "Pagar despesa planejada"), evitando duplicar a lista aqui.
 */
export function PayOptionsModal({
  open,
  onClose,
  onOpenNewPaidForm,
  onOpenVoiceModal,
  onOpenPlanForm,
  onOpenRecorrenteForm,
  onImportCard,
  onImportAccount,
  onOpenNewReceiptForm,
}: PayOptionsModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Novo lançamento">
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

          {onOpenRecorrenteForm && (
            <button
              type="button"
              onClick={onOpenRecorrenteForm}
              className="flex items-center gap-3 rounded-xl border border-purple-200 bg-purple-50 px-4 py-3 text-left transition-colors hover:bg-purple-100"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-purple-500 text-white">
                <CalendarRange className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-darc-velvet">Despesa recorrente</span>
                <span className="block text-[11px] text-darc-velvet/50">Repete no tempo — mensal / quinzenal</span>
              </span>
            </button>
          )}

          {onImportCard && (
            <button
              type="button"
              onClick={onImportCard}
              className="flex items-center gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-left transition-colors hover:bg-blue-100"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-500 text-white">
                <CreditCard className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-darc-velvet">Fatura de cartão</span>
                <span className="block text-[11px] text-darc-velvet/50">PDF, CSV/OFX ou 📷 foto</span>
              </span>
            </button>
          )}

          {onImportAccount && (
            <button
              type="button"
              onClick={onImportAccount}
              className="flex items-center gap-3 rounded-xl border border-teal-200 bg-teal-50 px-4 py-3 text-left transition-colors hover:bg-teal-100"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-teal-500 text-white">
                <Landmark className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-darc-velvet">Extrato bancário</span>
                <span className="block text-[11px] text-darc-velvet/50">OFX/CSV ou 📷 foto</span>
              </span>
            </button>
          )}

          {onOpenNewReceiptForm && (
            <button
              type="button"
              onClick={onOpenNewReceiptForm}
              className="flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-left transition-colors hover:bg-emerald-100"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
                <ArrowDownCircle className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-darc-velvet">Novo recebimento</span>
                <span className="block text-[11px] text-darc-velvet/50">Abrir formulário de receita</span>
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
        </div>
      </div>
    </Modal>
  );
}
