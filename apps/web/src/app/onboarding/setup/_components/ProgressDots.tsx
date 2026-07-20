'use client';

import { CheckCircle2 } from 'lucide-react';

export interface ProgressDotsStep {
  key: string;
  label: string;
}

interface ProgressDotsProps {
  steps: ProgressDotsStep[];
  currentIndex: number;
}

/** Stepper-dots progress indicator — extracted verbatim from the original PESSOAL-only wizard. */
export function ProgressDots({ steps, currentIndex }: ProgressDotsProps) {
  return (
    <div className="mb-8 flex items-center justify-center gap-2" aria-label="Progresso do setup">
      {steps.map((s, i) => (
        <div key={s.key} className="flex items-center gap-2">
          <div
            className={`flex h-8 w-8 items-center justify-center rounded-full text-[12px] font-bold transition-colors ${
              i < currentIndex
                ? 'bg-lifeone-blue text-white'
                : i === currentIndex
                  ? 'border-2 border-lifeone-blue bg-white text-lifeone-blue'
                  : 'border border-lifeone-hairline bg-lifeone-surface text-lifeone-ink-4'
            }`}
          >
            {i < currentIndex ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
          </div>
          {i < steps.length - 1 && (
            <div className={`h-0.5 w-6 sm:w-10 ${i < currentIndex ? 'bg-lifeone-blue' : 'bg-lifeone-hairline'}`} />
          )}
        </div>
      ))}
    </div>
  );
}
