'use client';

import { useState } from 'react';
import { CalendarClock, Ellipsis, Link2, Plus } from 'lucide-react';
import { PlanoRecebimentosModal } from './PlanoRecebimentosModal';
import { Modal } from '@/components/ui/modal';

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
  const [moreOpen, setMoreOpen] = useState(false);

  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        onClick={onOpenLaunch}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-lifeone-hairline bg-lifeone-card px-3 py-2 text-sm font-semibold text-lifeone-ink transition hover:border-lifeone-blue"
      >
        <Plus className="h-4 w-4" /> Lançar
      </button>
      <button
        type="button"
        onClick={() => setMoreOpen(true)}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-lifeone-hairline bg-lifeone-card px-3 py-2 text-sm font-semibold text-lifeone-ink transition hover:border-lifeone-blue"
        aria-label="Mais ações"
        title="Mais ações"
      >
        <Ellipsis className="h-4 w-4" />
      </button>

      <Modal open={moreOpen} onClose={() => setMoreOpen(false)} title="Mais ações" variant="sheet" size="sm">
        <div className="flex flex-col gap-2 pb-2">
          <button
            type="button"
            onClick={() => {
              setMoreOpen(false);
              setPlanoOpen(true);
            }}
            className="inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-[#BFE6CC] bg-[#E3F6EA] px-3 py-2 text-sm font-semibold text-[#1E924A] transition hover:bg-[#D2EFDC]"
          >
            <CalendarClock className="h-4 w-4" /> Planejar recebimentos
          </button>
          <button
            type="button"
            onClick={() => {
              setMoreOpen(false);
              onVincularEmMassa();
            }}
            className="inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 transition hover:bg-gray-50"
          >
            <Link2 className="h-4 w-4" /> Vincular em massa
          </button>
        </div>
      </Modal>

      <PlanoRecebimentosModal
        open={planoOpen}
        onClose={() => setPlanoOpen(false)}
        projectId={projectId}
        defaultMonth={defaultMonth}
      />
    </div>
  );
}
