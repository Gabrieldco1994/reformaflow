'use client';

import { useState } from 'react';
import { ChevronDown, ChevronUp, GitBranch, Lock, SkipForward, ToggleLeft, ToggleRight } from 'lucide-react';
import { PESSOAL_JOURNEY_CATALOG } from '@reformaflow/domain';
import type { JourneyStepDef } from '@reformaflow/domain';

/**
 * Editor de Jornadas — admin view (/admin/jornadas).
 * Mostra o catálogo PESSOAL com:
 * - Badge "Ramificação fixa" para steps com fixedBranch
 * - Visualização dos ramos Sim/Não e ponto de reencontro
 * - Controles editáveis: ordem, ligado/desligado, pulável
 * - Condição/ramos são read-only (fixedBranch é produto, não config)
 *
 * ponytail: sem persistência no backend — configuração estática por enquanto.
 * Adicionar PUT /admin/jornadas quando necessário.
 */

interface StepConfig {
  enabled: boolean;
  skippable: boolean;
  label: string;
  subtitle: string;
  order: number;
}

function initConfig(steps: JourneyStepDef[]): Record<string, StepConfig> {
  return Object.fromEntries(
    steps.map((s, i) => [
      s.key,
      {
        enabled: true,
        skippable: s.skippableByDefault,
        label: s.label,
        subtitle: s.defaultSubtitle,
        order: i,
      },
    ]),
  );
}

export default function AdminJornadasPage() {
  const [configs, setConfigs] = useState<Record<string, StepConfig>>(() =>
    initConfig(PESSOAL_JOURNEY_CATALOG),
  );
  const [expandedBranch, setExpandedBranch] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function update(key: string, patch: Partial<StepConfig>) {
    setConfigs((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
    setSaved(false);
  }

  function moveUp(key: string) {
    const keys = PESSOAL_JOURNEY_CATALOG.map((s) => s.key);
    const idx = keys.indexOf(key);
    if (idx <= 0) return;
    const prev = keys[idx - 1];
    setConfigs((c) => ({
      ...c,
      [key]: { ...c[key], order: c[prev].order },
      [prev]: { ...c[prev], order: c[key].order },
    }));
    setSaved(false);
  }

  function moveDown(key: string) {
    const keys = PESSOAL_JOURNEY_CATALOG.map((s) => s.key);
    const idx = keys.indexOf(key);
    if (idx >= keys.length - 1) return;
    const next = keys[idx + 1];
    setConfigs((c) => ({
      ...c,
      [key]: { ...c[key], order: c[next].order },
      [next]: { ...c[next], order: c[key].order },
    }));
    setSaved(false);
  }

  function handleSave() {
    // ponytail: persiste quando API de jornadas existir
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  const ordered = [...PESSOAL_JOURNEY_CATALOG].sort(
    (a, b) => (configs[a.key]?.order ?? 0) - (configs[b.key]?.order ?? 0),
  );

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-[22px] font-bold text-lifeone-ink">Editor de Jornadas</h1>
        <p className="text-[13px] text-lifeone-ink-3">
          Configure a sequência de onboarding PESSOAL. Ramificações fixas refletem lógica de produto e não podem ser editadas.
        </p>
      </div>

      <div className="space-y-3">
        {ordered.map((step, idx) => {
          const cfg = configs[step.key];
          const isFirst = idx === 0;
          const isLast = idx === ordered.length - 1;
          const branchOpen = expandedBranch === step.key;

          return (
            <div
              key={step.key}
              className={[
                'rounded-[14px] border bg-white shadow-sm transition-opacity',
                cfg.enabled ? 'border-lifeone-hairline' : 'border-lifeone-hairline opacity-50',
              ].join(' ')}
            >
              <div className="flex items-start gap-3 p-4">
                {/* Ordem */}
                <div className="flex shrink-0 flex-col gap-0.5">
                  <button
                    type="button"
                    disabled={isFirst}
                    onClick={() => moveUp(step.key)}
                    className="rounded p-0.5 text-lifeone-ink-4 hover:text-lifeone-ink disabled:opacity-30"
                    aria-label="Mover para cima"
                  >
                    <ChevronUp className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    disabled={isLast}
                    onClick={() => moveDown(step.key)}
                    className="rounded p-0.5 text-lifeone-ink-4 hover:text-lifeone-ink disabled:opacity-30"
                    aria-label="Mover para baixo"
                  >
                    <ChevronDown className="h-4 w-4" />
                  </button>
                </div>

                {/* Conteúdo */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[15px] font-semibold text-lifeone-ink">{cfg.label}</span>
                    {step.fixedBranch && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-lifeone-blue/10 px-2 py-0.5 text-[11px] font-medium text-lifeone-blue">
                        <GitBranch className="h-3 w-3" />
                        Ramificação fixa
                      </span>
                    )}
                    {!cfg.enabled && (
                      <span className="rounded-full bg-lifeone-surface px-2 py-0.5 text-[11px] text-lifeone-ink-3">
                        Desligado
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[12px] text-lifeone-ink-3 truncate">{cfg.subtitle}</p>

                  {/* Ramos do funding */}
                  {step.fixedBranch && (
                    <button
                      type="button"
                      onClick={() => setExpandedBranch(branchOpen ? null : step.key)}
                      className="mt-2 flex items-center gap-1 text-[12px] text-lifeone-blue hover:underline"
                    >
                      <GitBranch className="h-3.5 w-3.5" />
                      {branchOpen ? 'Ocultar ramificação' : 'Ver ramificação'}
                    </button>
                  )}

                  {branchOpen && step.fixedBranch && (
                    <div className="mt-3 rounded-[10px] border border-lifeone-hairline bg-lifeone-surface p-3 text-[12px]">
                      <div className="flex items-start gap-2 mb-2">
                        <Lock className="h-3.5 w-3.5 mt-0.5 shrink-0 text-lifeone-ink-3" />
                        <span className="font-medium text-lifeone-ink-2">{step.fixedBranch.conditionLabel}</span>
                      </div>
                      <div className="ml-5 space-y-1.5">
                        <div className="flex gap-2">
                          <span className="min-w-[24px] rounded bg-green-100 px-1 text-[11px] font-medium text-green-700 text-center">Sim</span>
                          <span className="text-lifeone-ink-2">{step.fixedBranch.ifTrue}</span>
                        </div>
                        <div className="flex gap-2">
                          <span className="min-w-[24px] rounded bg-lifeone-surface px-1 text-[11px] font-medium text-lifeone-ink-3 text-center">Não</span>
                          <span className="text-lifeone-ink-2">{step.fixedBranch.ifFalse}</span>
                        </div>
                        <div className="mt-2 flex items-center gap-1 text-lifeone-ink-3">
                          <span className="text-[11px]">Reencontro em:</span>
                          <span className="text-[11px] font-medium text-lifeone-ink">{step.fixedBranch.rejoinsAt}</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Controles */}
                <div className="flex shrink-0 flex-col items-end gap-2">
                  {/* Ligado/desligado */}
                  <button
                    type="button"
                    onClick={() => update(step.key, { enabled: !cfg.enabled })}
                    className="text-lifeone-ink-3 hover:text-lifeone-ink"
                    aria-label={cfg.enabled ? 'Desligar passo' : 'Ligar passo'}
                    title={cfg.enabled ? 'Ligado — clique para desligar' : 'Desligado — clique para ligar'}
                  >
                    {cfg.enabled
                      ? <ToggleRight className="h-5 w-5 text-lifeone-blue" />
                      : <ToggleLeft className="h-5 w-5" />}
                  </button>
                  {/* Pulável */}
                  <button
                    type="button"
                    onClick={() => update(step.key, { skippable: !cfg.skippable })}
                    className={[
                      'flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition-colors',
                      cfg.skippable
                        ? 'bg-lifeone-surface text-lifeone-ink-3 hover:bg-lifeone-hairline'
                        : 'bg-red-50 text-red-600 hover:bg-red-100',
                    ].join(' ')}
                    title={cfg.skippable ? 'Pulável — clique para tornar obrigatório' : 'Obrigatório — clique para tornar pulável'}
                  >
                    <SkipForward className="h-3 w-3" />
                    {cfg.skippable ? 'Pulável' : 'Obrigatório'}
                  </button>
                </div>
              </div>

              {/* Edição de texto */}
              <div className="border-t border-lifeone-hairline px-4 py-3 grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-lifeone-ink-3">Rótulo</label>
                  <input
                    value={cfg.label}
                    onChange={(e) => update(step.key, { label: e.target.value })}
                    className="min-h-9 w-full rounded-[8px] border border-lifeone-hairline bg-lifeone-surface px-3 py-1.5 text-[13px] focus:border-lifeone-blue focus:outline-none"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] font-medium text-lifeone-ink-3">Subtítulo</label>
                  <input
                    value={cfg.subtitle}
                    onChange={(e) => update(step.key, { subtitle: e.target.value })}
                    className="min-h-9 w-full rounded-[8px] border border-lifeone-hairline bg-lifeone-surface px-3 py-1.5 text-[13px] focus:border-lifeone-blue focus:outline-none"
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-6 flex justify-end">
        <button
          type="button"
          onClick={handleSave}
          className="min-h-11 rounded-[10px] bg-lifeone-blue px-6 py-2.5 text-[14px] font-semibold text-white hover:brightness-95 active:scale-[0.99]"
        >
          {saved ? 'Salvo ✓' : 'Salvar configurações'}
        </button>
      </div>

      <p className="mt-3 text-[11px] text-lifeone-ink-4 text-center">
        ponytail: persistência local até API de jornadas existir. Ramificação fixa nunca é enviada ao servidor.
      </p>
    </div>
  );
}
