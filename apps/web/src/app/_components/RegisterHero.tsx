'use client';

import Image from 'next/image';

export function RegisterHero() {
  return (
    <section className="relative min-w-0 border-b border-lifeone-hairline p-5 sm:p-8 lg:border-b-0 lg:border-r bg-gradient-to-br from-lifeone-blue/5 via-lifeone-surface/50 to-lifeone-canvas">
      {/* Visual accent — fades on mobile, prominent on desktop */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none opacity-0 sm:opacity-5 lg:opacity-100">
        <div className="absolute -right-40 -top-40 w-80 h-80 bg-lifeone-blue rounded-full blur-3xl" />
      </div>

      <div className="relative z-10 flex flex-col h-full justify-between">
        {/* Headline Section */}
        <div>
          <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-lifeone-blue">Seu fluxo de caixa</p>
          <h1 className="mt-2 text-[27px] font-bold leading-tight tracking-[-0.035em] text-lifeone-ink sm:text-[34px]">
            Saiba hoje se o mês fecha no azul.
          </h1>
          <p className="mt-3 text-[14px] leading-relaxed text-lifeone-ink-3">
            Veja em tempo real se seu dinheiro é suficiente para os próximos 30 dias. Sem surpresas.
          </p>
        </div>

        {/* Screenshot - desktop only */}
        <div className="hidden lg:block mt-8">
          <div className="relative w-full max-w-[280px] rounded-[12px] overflow-hidden border border-lifeone-hairline shadow-lg">
            <Image
              src="/hero-cockpit-mobile.svg"
              alt="LifeOne - Cockpit mostrando Caixa hoje"
              width={280}
              height={600}
              priority
              className="w-full h-auto"
            />
          </div>
        </div>

        {/* Benefit highlights - mobile & desktop */}
        <div className="mt-6 space-y-3">
          <div className="flex gap-2 text-[13px] text-lifeone-ink-2">
            <span className="text-lifeone-blue font-bold flex-shrink-0">✓</span>
            <span>Saiba se sobra ou falta dinheiro</span>
          </div>
          <div className="flex gap-2 text-[13px] text-lifeone-ink-2">
            <span className="text-lifeone-blue font-bold flex-shrink-0">✓</span>
            <span>Planeje gastos com confiança</span>
          </div>
          <div className="flex gap-2 text-[13px] text-lifeone-ink-2">
            <span className="text-lifeone-blue font-bold flex-shrink-0">✓</span>
            <span>Simule cenários antes de decidir</span>
          </div>
        </div>
      </div>
    </section>
  );
}
