'use client';

import { Plus } from 'lucide-react';

export function ContaQuickActions({
  onOpenLaunch,
}: {
  onOpenLaunch: () => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        onClick={onOpenLaunch}
        className="hidden min-h-11 items-center gap-1.5 rounded-xl border border-lifeone-hairline bg-lifeone-card px-3 py-2 text-sm font-semibold text-lifeone-ink transition hover:border-lifeone-blue md:inline-flex"
      >
        <Plus className="h-4 w-4" /> Lançar
      </button>
    </div>
  );
}
