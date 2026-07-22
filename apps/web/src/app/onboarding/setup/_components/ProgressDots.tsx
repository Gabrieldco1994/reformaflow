'use client';

export interface ProgressDotsStep {
  key: string;
  label: string;
}

interface ProgressDotsProps {
  steps: ProgressDotsStep[];
  currentIndex: number;
}

/**
 * Progress indicator for the setup wizard: a slim progress bar + "Passo X de Y"
 * text. Replaces a per-step dots ruler that overflowed at 375-390px viewports
 * once a flow reached 7 steps (the "7" dot got clipped). A bar+label scales to
 * any step count without layout math, so it can't overflow regardless of how
 * many anchor steps a project type ends up with.
 */
export function ProgressDots({ steps, currentIndex }: ProgressDotsProps) {
  const total = steps.length;
  const current = Math.min(currentIndex + 1, total);
  const percent = total > 0 ? (current / total) * 100 : 0;

  return (
    <div className="mb-8" aria-label="Progresso do setup">
      <p className="mb-2 text-center text-[12px] font-semibold text-lifeone-ink-3">
        Passo {current} de {total}
      </p>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-lifeone-hairline">
        <div
          className="h-full rounded-full bg-lifeone-blue transition-[width]"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
