'use client';

import { useState } from 'react';
import { ArrowRight, SkipForward } from 'lucide-react';
import { api } from '@/lib/api';
import { maskCurrencyInput, currencyInputToNumber } from '@/lib/currency-input';
import { getReceiptTipoOptions } from '@/app/projects/[projectId]/receipts/_lib/tipo-options';
import type { OnboardingStepProps } from '../../_types';

/**
 * Purpose-built quick-add receipt step — own local state, own POST call.
 * PESSOAL-only anchor (only caller in `ANCHOR_STEPS`).
 */
export function QuickReceiptStep({ projectId, projectType, onDone, onSkip }: OnboardingStepProps) {
  const options = getReceiptTipoOptions(projectType);
  const [tipo, setTipo] = useState(options[0]?.value ?? '');
  const [valor, setValor] = useState('');
  const [data, setData] = useState(() => new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = valor.trim().length > 0;

  async function handleSave() {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      await api.post(`/projects/${projectId}/receipts`, {
        valor: currencyInputToNumber(valor),
        data,
        tipo,
        status: 'PREVISTO',
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao salvar recebimento');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-[18px] border border-lifeone-hairline bg-lifeone-card p-6 shadow-lifeone-card">
      <h2 className="text-[18px] font-bold text-lifeone-ink">Seu primeiro recebimento</h2>
      <p className="text-[13px] text-lifeone-ink-3">Registre uma entrada esperada para começar a prever o caixa</p>

      <div className="mt-4 space-y-3">
        <div>
          <label htmlFor="qr-tipo" className="mb-1 block text-[12px] font-medium text-lifeone-ink-2">Tipo</label>
          <select
            id="qr-tipo"
            value={tipo}
            onChange={(e) => setTipo(e.target.value)}
            className="min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3 py-2.5 text-[14px]"
          >
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="qr-valor" className="mb-1 block text-[12px] font-medium text-lifeone-ink-2">Valor (R$)</label>
            <input
              id="qr-valor"
              value={valor}
              onChange={(e) => setValor(maskCurrencyInput(e.target.value))}
              placeholder="1.500,00"
              inputMode="numeric"
              className="min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3.5 py-2.5 text-[14px] font-mono placeholder:text-lifeone-ink-4 focus:border-lifeone-blue focus:outline-none focus:ring-2 focus:ring-lifeone-blue/25"
            />
          </div>
          <div>
            <label htmlFor="qr-data" className="mb-1 block text-[12px] font-medium text-lifeone-ink-2">Data</label>
            <input
              id="qr-data"
              type="date"
              value={data}
              onChange={(e) => setData(e.target.value)}
              className="min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3.5 py-2.5 text-[14px]"
            />
          </div>
        </div>
      </div>

      {error && <p className="mt-3 text-[13px] text-[#B42318]">{error}</p>}

      <div className="mt-5 flex flex-col gap-2">
        <button
          onClick={handleSave}
          disabled={!canSubmit || saving}
          className="flex min-h-11 w-full items-center justify-center gap-2 rounded-[10px] bg-lifeone-blue px-4 py-3 text-[14px] font-semibold text-white hover:brightness-95 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {saving ? 'Salvando…' : 'Criar e continuar'}
          {!saving && <ArrowRight className="h-4 w-4" />}
        </button>
        <button
          onClick={onSkip}
          className="flex min-h-11 w-full items-center justify-center gap-1.5 text-[13px] text-lifeone-ink-3 hover:text-lifeone-ink"
        >
          <SkipForward className="h-3.5 w-3.5" /> Pular por agora
        </button>
      </div>
    </section>
  );
}
