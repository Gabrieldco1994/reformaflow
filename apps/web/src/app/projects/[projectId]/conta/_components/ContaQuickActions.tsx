'use client';

import { useRef, useState } from 'react';
import { ArrowDownCircle, ArrowUpCircle, CalendarClock, Ellipsis, Link2, Plus } from 'lucide-react';
import { NovaDespesaLauncher } from '../../expenses/_components/NovaDespesaLauncher';
import { PlanoRecebimentosModal } from './PlanoRecebimentosModal';
import { Modal } from '@/components/ui/modal';

export function ContaQuickActions({
  projectId,
  defaultMonth,
  onInvalidate,
  onNovaReceita,
  onVincularEmMassa,
}: {
  projectId: string;
  defaultMonth: string;
  onInvalidate: () => void;
  onNovaReceita: () => void;
  onVincularEmMassa: () => void;
}) {
  const [planoOpen, setPlanoOpen] = useState(false);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const openNovaDespesaRef = useRef<() => void>(() => undefined);

  return (
    <div className="flex flex-wrap gap-2">
      <NovaDespesaLauncher
        projectId={projectId}
        projectType="PESSOAL"
        onChanged={onInvalidate}
        trigger={(open) => {
          openNovaDespesaRef.current = open;
          return null;
        }}
      />
      <button
        type="button"
        onClick={() => setLaunchOpen(true)}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-lifeone-hairline bg-lifeone-card px-3 py-2 text-sm font-semibold text-lifeone-ink transition hover:border-lifeone-blue"
      >
        <Plus className="h-4 w-4" /> + Lançar
      </button>
      <button
        type="button"
        onClick={() => setMoreOpen(true)}
        className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-lifeone-hairline bg-lifeone-card px-3 py-2 text-sm font-semibold text-lifeone-ink transition hover:border-lifeone-blue"
        aria-label="Mais ações"
        title="Mais ações"
      >
        <Ellipsis className="h-4 w-4" /> ⋯
      </button>

      <Modal open={launchOpen} onClose={() => setLaunchOpen(false)} title="Lançar" variant="sheet" size="sm">
        <div className="flex flex-col gap-2 pb-2">
          <button
            type="button"
            onClick={() => {
              setLaunchOpen(false);
              openNovaDespesaRef.current();
            }}
            className="inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-[#F2C6C1] bg-[#FCEBE9] px-3 py-2 text-sm font-semibold text-[#D92D20] transition hover:bg-[#F8DAD6]"
          >
            <ArrowDownCircle className="h-4 w-4" /> Nova Despesa
          </button>
          <button
            type="button"
            onClick={() => {
              setLaunchOpen(false);
              onNovaReceita();
            }}
            className="inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-[#BFE6CC] bg-[#E3F6EA] px-3 py-2 text-sm font-semibold text-[#1E924A] transition hover:bg-[#D2EFDC]"
          >
            <ArrowUpCircle className="h-4 w-4" /> Nova Receita
          </button>
        </div>
      </Modal>

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
