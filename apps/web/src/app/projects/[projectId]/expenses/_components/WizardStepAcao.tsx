'use client';
import { CalendarClock, Link2 } from 'lucide-react';
import { WizardFonteResumo } from './WizardFonteResumo';
import type { WizardDraft, WizardMode } from '../_hooks/useNovaDespesaWizard';

interface Props {
  draft: WizardDraft;
  mode: WizardMode;
  totalCents: number;
  onPlanejar: () => void;
  onVincular: () => void;
  saving: boolean;
}

/**
 * Passo 3 (AÇÃO): dois caminhos — registrar/planejar a despesa (save simples)
 * OU realizar vínculo de despesa (abre o cesto de vínculos, passo CESTO).
 */
export function WizardStepAcao({ draft, mode, totalCents, onPlanejar, onVincular, saving }: Props) {
  const registrarLabel = mode === 'PAGA' ? 'Registrar despesa' : 'Planejar despesa';
  return (
    <div className="space-y-4">
      <WizardFonteResumo draft={draft} totalCents={totalCents} />

      <p className="text-sm text-darc-velvet/70">Como você quer concluir esta despesa?</p>

      <div className="grid grid-cols-1 gap-3">
        <button
          type="button"
          onClick={onPlanejar}
          disabled={saving}
          className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-4 text-left transition-colors hover:bg-amber-100 disabled:opacity-60 min-h-[44px]"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-500 text-white">
            <CalendarClock className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-darc-velvet">
              📅 {registrarLabel}
            </span>
            <span className="block text-xs text-darc-velvet/60">
              Salvar esta despesa neste projeto, sem distribuir.
            </span>
          </span>
        </button>

        <button
          type="button"
          onClick={onVincular}
          disabled={saving}
          className="flex items-start gap-3 rounded-2xl border border-blue-200 bg-blue-50 px-4 py-4 text-left transition-colors hover:bg-blue-100 disabled:opacity-60 min-h-[44px]"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-500 text-white">
            <Link2 className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-darc-velvet">
              🔗 Realizar vínculo de despesa
            </span>
            <span className="block text-xs text-darc-velvet/60">
              Distribuir esta compra entre despesas de outros projetos.
            </span>
          </span>
        </button>
      </div>
    </div>
  );
}
