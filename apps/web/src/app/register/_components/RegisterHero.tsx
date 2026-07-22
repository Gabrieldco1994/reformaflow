import Image from 'next/image';
import { Bot, Check, PiggyBank, Shield, Sparkles, Layers } from 'lucide-react';

const BENEFITS = [
  {
    icon: PiggyBank,
    tileClass: 'bg-lifeone-info text-lifeone-blue',
    title: 'Veja se sobra ou falta',
    description: 'O caixa do dia e a projeção de fechamento do mês, atualizados em tempo real.',
  },
  {
    icon: Sparkles,
    tileClass: 'bg-type-compra-fill text-type-compra',
    title: 'Simule antes de gastar',
    description: 'Teste uma decisão e veja o impacto no mês inteiro antes de tomá-la.',
  },
  {
    icon: Layers,
    tileClass: 'bg-type-casa-fill text-type-casa',
    title: 'Projetos ilimitados',
    description: 'Reforma, carro, casa, uma viagem — organize cada frente sem limite de categorias.',
  },
];

const TRUST_ITEMS = [
  { icon: Check, label: 'Sem cartão de crédito' },
  { icon: Check, label: 'Cancele quando quiser' },
  { icon: Shield, label: 'Seus dados são seus · LGPD' },
];

const AVATAR_COLORS = ['#0A6CF0', '#1E924A', '#C2691E', '#7A3FC2']; // type-pessoal, type-casa, type-reforma, type-compra

function RegisterHeroIntro() {
  return (
    <div>
      <p className="inline-flex items-center gap-1.5 rounded-full bg-lifeone-info px-3 py-1 text-[11px] font-bold uppercase tracking-[0.09em] text-lifeone-blue">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-lifeone-success" aria-hidden="true" />
        Comece grátis em 1 minuto
      </p>
      <h2 className="mt-3 text-[27px] font-bold leading-tight tracking-[-0.035em] text-lifeone-ink sm:text-[34px]">
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
    <ul className="space-y-4">
      {BENEFITS.map((benefit) => (
        <li key={benefit.title} className="flex items-start gap-3">
          <span className={`flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] ${benefit.tileClass}`}>
            <benefit.icon className="h-[19px] w-[19px]" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-[14px] font-bold leading-tight text-lifeone-ink">{benefit.title}</p>
            <p className="mt-0.5 text-[13.5px] leading-snug text-lifeone-ink-2">{benefit.description}</p>
          </div>
        </li>
      ))}
    </ul>
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
    <div className="flex items-center justify-center gap-2.5 lg:justify-start">
      <div className="flex shrink-0" aria-hidden="true">
        {AVATAR_COLORS.map((color, index) => (
          <span
            key={color}
            className="h-[26px] w-[26px] rounded-full border-2 border-white"
            style={{ backgroundColor: color, marginLeft: index === 0 ? 0 : -8 }}
          />
        ))}
      </div>
      <p className="text-[13px] font-medium text-lifeone-ink-2">
        Pessoas já organizam a vida financeira com a LifeOne.
      </p>
    </div>
  );
}

function RegisterHeroTrust() {
  return (
    <ul className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5 lg:justify-start">
      {TRUST_ITEMS.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5 text-[12px] text-lifeone-ink-3">
          <item.icon className="h-3.5 w-3.5 shrink-0 text-lifeone-success" aria-hidden="true" />
          {item.label}
        </li>
      ))}
    </ul>
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
