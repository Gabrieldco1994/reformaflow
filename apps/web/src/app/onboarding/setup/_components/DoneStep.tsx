'use client';

import { CheckCircle2 } from 'lucide-react';

/** Terminal step — extracted verbatim from the original PESSOAL-only wizard. */
export function DoneStep() {
  return (
    <section className="rounded-[18px] border border-lifeone-hairline bg-lifeone-card p-8 shadow-lifeone-card text-center">
      <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-[#E8F5EE]">
        <CheckCircle2 className="h-8 w-8 text-[#1E924A]" />
      </div>
      <h2 className="mt-4 text-[22px] font-bold text-lifeone-ink">Tudo pronto!</h2>
      <p className="mt-2 text-[14px] text-lifeone-ink-3">
        Seu Cockpit financeiro está configurado. Levando você para o guia de primeiros passos…
      </p>
      <div className="mt-4 flex justify-center">
        <div className="h-1 w-24 overflow-hidden rounded-full bg-lifeone-hairline">
          <div className="h-full animate-pulse rounded-full bg-lifeone-blue" style={{ width: '60%' }} />
        </div>
      </div>
    </section>
  );
}
