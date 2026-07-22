import Image from 'next/image';
import { Bot, Home, Lock, ShoppingBag } from 'lucide-react';

const BENEFITS = [
  'Veja se sobra ou falta dinheiro antes do mês acabar',
  'Sem limite de projetos e categorias para organizar sua vida',
  'Simule decisões e saiba o impacto antes de gastar',
];

function RegisterHeroIntro() {
  return (
    <div>
      <p className="text-[13px] font-semibold uppercase tracking-wide text-lifeone-blue">
        Para qualquer tipo de projeto
      </p>
      <h2 className="mt-2 text-[27px] font-bold leading-tight tracking-[-0.035em] text-lifeone-ink sm:text-[34px]">
        Controle, planeje tudo em um só app
      </h2>
      <p className="mt-3 text-[15px] leading-relaxed text-lifeone-ink-2">
        Dinheiro, reformas, manutenções, casa, carro, qualquer tipo de projeto num só lugar. Use a Maria,
        que te ajuda a controlar e planejar de forma inteligente.
      </p>
    </div>
  );
}

function RegisterHeroMaria() {
  return (
    <div className="rounded-2xl border border-lifeone-hairline bg-lifeone-card p-4 shadow-lifeone-card">
      <div className="flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-lifeone-blue text-white ring-4 ring-lifeone-info">
          <Bot className="h-5 w-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="text-[14px] leading-relaxed text-lifeone-ink">
            &ldquo;Se manter esse ritmo, o mês fecha com R$ 640 sobrando. Quer que eu reserve pra
            reforma?&rdquo;
          </p>
          <p className="mt-2 text-[12px] font-medium text-lifeone-ink-3">— Maria, sua copiloto no LifeOne</p>
        </div>
      </div>
    </div>
  );
}

function RegisterHeroBenefits() {
  return (
    <div>
      <ul className="space-y-3">
        {BENEFITS.map((benefit) => (
          <li key={benefit} className="flex items-start gap-2.5 text-[14px] leading-relaxed text-lifeone-ink-2">
            <svg className="mt-0.5 h-5 w-5 shrink-0 text-lifeone-blue" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            {benefit}
          </li>
        ))}
      </ul>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-type-casa-fill px-3 py-1 text-[12px] font-medium text-type-casa">
          <Home className="h-3.5 w-3.5" aria-hidden="true" />
          Casa
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-type-compra-fill px-3 py-1 text-[12px] font-medium text-type-compra">
          <ShoppingBag className="h-3.5 w-3.5" aria-hidden="true" />
          Compra
        </span>
      </div>
    </div>
  );
}

function RegisterHeroPhone() {
  return (
    <div className="relative mx-auto h-[280px] w-[129px] shrink-0 lg:mx-0 lg:h-[608px] lg:w-[280px]">
      <Image
        src="/hero-cockpit-mobile.png"
        alt="Tela do Cockpit financeiro do LifeOne mostrando o caixa do dia e a projeção de fechamento do mês"
        fill
        sizes="(min-width: 1024px) 280px, 129px"
        className="rounded-[20px] border border-lifeone-hairline object-contain object-top shadow-lifeone-card lg:rounded-[28px]"
        priority
      />
    </div>
  );
}

function RegisterHeroSocialProof() {
  return (
    <p className="text-center text-[13px] font-medium text-lifeone-ink-2 lg:text-left">
      +1.200 pessoas já usam a LifeOne.
    </p>
  );
}

function RegisterHeroTrust() {
  return (
    <div className="flex items-center justify-center gap-1.5 text-[12px] text-lifeone-ink-3 lg:justify-start">
      <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      Seus dados são privados e protegidos.
    </div>
  );
}

/** Composable pieces of the /register hero, ordered independently on mobile and desktop by the page. */
export const RegisterHero = {
  Intro: RegisterHeroIntro,
  Maria: RegisterHeroMaria,
  Benefits: RegisterHeroBenefits,
  Phone: RegisterHeroPhone,
  SocialProof: RegisterHeroSocialProof,
  Trust: RegisterHeroTrust,
};
