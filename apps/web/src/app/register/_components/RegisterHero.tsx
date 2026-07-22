import Image from 'next/image';

const BENEFITS = [
  'Veja se sobra ou falta dinheiro antes do mês acabar',
  'Sem limite de projetos e categorias para organizar sua vida',
  'Simule decisões e saiba o impacto antes de gastar',
];

export function RegisterHero() {
  return (
    <div className="flex flex-col lg:flex-1">
      <h2 className="order-1 text-[27px] font-bold leading-tight tracking-[-0.035em] text-lifeone-ink sm:text-[34px]">
        Saiba hoje se o mês fecha no azul.
      </h2>

      <div className="relative order-2 mx-auto mt-6 h-[280px] w-[129px] shrink-0 lg:order-3 lg:mx-0 lg:mt-8 lg:h-[608px] lg:w-[280px]">
        <Image
          src="/hero-cockpit-mobile.png"
          alt="Tela do Cockpit financeiro do LifeOne mostrando o caixa do dia e a projeção de fechamento do mês"
          fill
          sizes="(min-width: 1024px) 280px, 129px"
          className="rounded-[20px] border border-lifeone-hairline object-contain object-top shadow-lifeone-card lg:rounded-[28px]"
          priority
        />
      </div>

      <ul className="order-3 mt-5 space-y-3 lg:order-2">
        {BENEFITS.map((benefit) => (
          <li key={benefit} className="flex items-start gap-2.5 text-[14px] leading-relaxed text-lifeone-ink-2">
            <svg className="mt-0.5 h-5 w-5 shrink-0 text-lifeone-blue" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            {benefit}
          </li>
        ))}
      </ul>
    </div>
  );
}
