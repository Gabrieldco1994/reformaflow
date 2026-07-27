'use client';

import { SkipForward } from 'lucide-react';
import { CreatePlantModal } from '@/app/projects/[projectId]/plants/_components/CreatePlantModal';
import type { OnboardingStepProps } from '../../_types';

/**
 * Thin wrapper around `CreatePlantModal` (already self-contained: photo→AI
 * diagnosis→confirm/rename, or skip-photo→manual name) with an explicit
 * skip affordance alongside it, matching the single-tier skip pattern used
 * by `CreditCardStep`. `CreatePlantModal` reads `projectId` via `useProject()`
 * — the wizard shell wraps every anchor-step render in `<ProjectProvider>`
 * to satisfy that dependency.
 */
export function PlantStep({ onDone, onSkip, subtitle, canSkip = true }: OnboardingStepProps) {
  return (
    <section className="rounded-[18px] border border-lifeone-hairline bg-lifeone-card p-6 shadow-lifeone-card">
      <p className="mb-4 text-[12px] text-lifeone-ink-3">
        {subtitle || 'Cadastre sua primeira planta (nome, espécie, ambiente…).'}
      </p>
      <CreatePlantModal onClose={onSkip} onCreated={onDone} bare />

      {canSkip && (
        <div className="mt-3">
          <button
            onClick={onSkip}
            className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-4 py-3 text-[13px] font-medium text-lifeone-ink-2 hover:bg-lifeone-hairline/60 transition-colors"
          >
            <SkipForward className="h-3.5 w-3.5" /> Pular por agora
          </button>
        </div>
      )}
    </section>
  );
}
