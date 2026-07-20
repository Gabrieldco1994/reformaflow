'use client';

import { useState } from 'react';
import { CalendarClock, Link2, Plus } from 'lucide-react';
import { PlanoRecebimentosModal } from './PlanoRecebimentosModal';

export function ContaQuickActions({
  projectId,
  defaultMonth,
  onOpenLaunch,
  onVincularEmMassa,
}: {
  projectId: string;
  defaultMonth: string;
  onOpenLaunch: () => void;
  onVincularEmMassa: () => void;
}) {
  const [planoOpen, setPlanoOpen] = useState(false);

  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        onClick={onOpenLaunch}
        className="hidden min-h-11 items-center gap-1.5 rounded-xl border border-lifeone-hairline bg-lifeone-card px-3 py-2 text-sm font-semibold text-lifeone-ink transition hover:border-lifeone-blue md:inline-flex"
      >
        <Plus className="h-4 w-4" /> Lançar
      </button>
      <button
        type="button"
        onClick={() => setPlanoOpen(true)}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-lifeone-hairline bg-lifeone-card px-3 py-2 text-sm font-semibold text-lifeone-ink transition hover:border-lifeone-blue"
      >
        <CalendarClock className="h-4 w-4" /> Planejar recebimentos
      </button>
      <button
        type="button"
        onClick={onVincularEmMassa}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-lifeone-hairline bg-lifeone-card px-3 py-2 text-sm font-semibold text-lifeone-ink transition hover:border-lifeone-blue"
      >
        <Link2 className="h-4 w-4" /> Vincular em massa
      </button>

      <PlanoRecebimentosModal
        open={planoOpen}
        onClose={() => setPlanoOpen(false)}
        projectId={projectId}
        defaultMonth={defaultMonth}
      />
    </div>
  );
}
