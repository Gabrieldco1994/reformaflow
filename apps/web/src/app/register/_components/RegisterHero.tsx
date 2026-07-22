import Image from 'next/image';

const BENEFITS = [
  'Veja se sobra ou falta dinheiro antes do mês acabar',
  'Sem limite de projetos e categorias para organizar sua vida',
  'Simule decisões e saiba o impacto antes de gastar',
];

export function RegisterHero() {
  return (
    <div className="lg:flex-1">
      <h2 className="text-[27px] font-bold leading-tight tracking-[-0.035em] text-lifeone-ink sm:text-[34px]">
        Saiba hoje se o mês fecha no azul.
      </h2>
      <ul className="mt-5 space-y-3">
        {BENEFITS.map((benefit) => (
          <li key={benefit} className="flex items-start gap-2.5 text-[14px] leading-relaxed text-lifeone-ink-2">
            <svg className="mt-0.5 h-5 w-5 shrink-0 text-lifeone-blue" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            {benefit}
          </li>
        ))}
      </ul>

      <div className="mt-8 hidden lg:block">
        <Image
          src="/hero-cockpit-mobile.png"
          alt="Tela do Cockpit financeiro do LifeOne mostrando o caixa do dia e a projeção de fechamento do mês"
          width={280}
          height={608}
          className="rounded-[28px] border border-lifeone-hairline shadow-lifeone-card"
          priority
        />
      </div>
    </div>
  );
}
