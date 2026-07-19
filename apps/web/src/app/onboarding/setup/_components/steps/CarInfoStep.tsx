'use client';

import { useState } from 'react';
import { ArrowRight, SkipForward } from 'lucide-react';
import { api } from '@/lib/api';
import type { OnboardingStepProps } from '../../_types';

/**
 * Purpose-built quick-add car-info step — own local state, own PUT call
 * (`car-info` is 1:1 PUT+upsert per AGENTS.md rule #6). Requires at least
 * `marca` non-empty to enable "Criar e continuar" (an everything-empty
 * car-info record is not a useful anchor); everything-empty must go through
 * "Pular por agora" instead.
 */
export function CarInfoStep({ projectId, onDone, onSkip }: OnboardingStepProps) {
  const [marca, setMarca] = useState('');
  const [modelo, setModelo] = useState('');
  const [placa, setPlaca] = useState('');
  const [cor, setCor] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = marca.trim().length > 0;

  async function handleSave() {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      await api.put(`/projects/${projectId}/car-info`, {
        marca: marca.trim(),
        modelo: modelo.trim() || undefined,
        placa: placa.trim() ? placa.trim().toUpperCase() : undefined,
        cor: cor.trim() || undefined,
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao salvar dados do carro');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-[18px] border border-lifeone-hairline bg-lifeone-card p-6 shadow-lifeone-card">
      <h2 className="text-[18px] font-bold text-lifeone-ink">Dados do seu carro</h2>
      <p className="text-[13px] text-lifeone-ink-3">Comece com a marca — o resto você completa quando quiser</p>

      <div className="mt-4 space-y-3">
        <div>
          <label htmlFor="ci-marca" className="mb-1 block text-[12px] font-medium text-lifeone-ink-2">Marca</label>
          <input
            id="ci-marca"
            value={marca}
            onChange={(e) => setMarca(e.target.value)}
            placeholder="Ex: Toyota"
            className="min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3.5 py-2.5 text-[14px] placeholder:text-lifeone-ink-4 focus:border-lifeone-blue focus:outline-none focus:ring-2 focus:ring-lifeone-blue/25"
          />
        </div>
        <div>
          <label htmlFor="ci-modelo" className="mb-1 block text-[12px] font-medium text-lifeone-ink-2">Modelo (opcional)</label>
          <input
            id="ci-modelo"
            value={modelo}
            onChange={(e) => setModelo(e.target.value)}
            placeholder="Ex: Corolla XEi"
            className="min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3.5 py-2.5 text-[14px] placeholder:text-lifeone-ink-4 focus:border-lifeone-blue focus:outline-none focus:ring-2 focus:ring-lifeone-blue/25"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="ci-placa" className="mb-1 block text-[12px] font-medium text-lifeone-ink-2">Placa (opcional)</label>
            <input
              id="ci-placa"
              value={placa}
              onChange={(e) => setPlaca(e.target.value.toUpperCase())}
              placeholder="ABC1D23"
              maxLength={7}
              className="min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3.5 py-2.5 text-[14px] uppercase placeholder:text-lifeone-ink-4 focus:border-lifeone-blue focus:outline-none focus:ring-2 focus:ring-lifeone-blue/25"
            />
          </div>
          <div>
            <label htmlFor="ci-cor" className="mb-1 block text-[12px] font-medium text-lifeone-ink-2">Cor (opcional)</label>
            <input
              id="ci-cor"
              value={cor}
              onChange={(e) => setCor(e.target.value)}
              placeholder="Ex: Branco"
              className="min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3.5 py-2.5 text-[14px] placeholder:text-lifeone-ink-4 focus:border-lifeone-blue focus:outline-none focus:ring-2 focus:ring-lifeone-blue/25"
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
