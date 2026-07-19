'use client';

import { useState } from 'react';
import { ArrowDownCircle, ArrowUpCircle, CalendarClock, Link2 } from 'lucide-react';
import { NovaDespesaLauncher } from '../../expenses/_components/NovaDespesaLauncher';
import { PlanoRecebimentosModal } from './PlanoRecebimentosModal';

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

  return (
    <div className="flex flex-wrap gap-2">
      <NovaDespesaLauncher
        projectId={projectId}
        projectType="PESSOAL"
        onChanged={onInvalidate}
        trigger={(open) => (
          <button
            type="button"
            onClick={open}
            className="inline-flex items-center gap-1.5 rounded-xl border border-[#F2C6C1] bg-[#FCEBE9] px-3 py-2 text-sm font-semibold text-[#D92D20] transition hover:bg-[#F8DAD6]"
          >
            <ArrowDownCircle className="h-4 w-4" /> Nova Despesa
          </button>
        )}
      />
      <button
        type="button"
        onClick={onNovaReceita}
        className="inline-flex items-center gap-1.5 rounded-xl border border-[#BFE6CC] bg-[#E3F6EA] px-3 py-2 text-sm font-semibold text-[#1E924A] transition hover:bg-[#D2EFDC]"
      >
        <ArrowUpCircle className="h-4 w-4" /> Nova Receita
      </button>
      <button
        type="button"
        onClick={() => setPlanoOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-xl border border-[#BFE6CC] bg-[#E3F6EA] px-3 py-2 text-sm font-semibold text-[#1E924A] transition hover:bg-[#D2EFDC]"
      >
        <CalendarClock className="h-4 w-4" /> Planejar recebimentos
      </button>
      <button
        type="button"
        onClick={onVincularEmMassa}
        className="inline-flex items-center gap-1.5 rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-gray-700 transition hover:bg-gray-50"
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
