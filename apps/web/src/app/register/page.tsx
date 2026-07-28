import Link from 'next/link';
import { LifeOneLogo } from '@/components/LifeOneLogo';
import { RegisterHero } from './_components/RegisterHero';
import { RegisterForm } from './_components/RegisterForm';

export default function RegisterPage() {
  return (
    <main className="min-h-screen bg-lifeone-canvas px-4 py-8 font-geist sm:px-6 sm:py-12">
      <div className="mx-auto w-full max-w-md lg:max-w-4xl">
        <header className="mb-8 flex items-center justify-between gap-4">
          <LifeOneLogo compact />
          <Link href="/login" className="flex min-h-11 items-center rounded-[10px] border border-lifeone-hairline bg-white px-4 text-[13px] font-semibold text-lifeone-blue shadow-lifeone-card hover:bg-lifeone-blue/5">
            Entrar
          </Link>
        </header>

        {/*
          Intro renderiza 1x só (o próprio componente esconde a descrição
          longa abaixo de `lg`) — nada de duplicar o mesmo bloco pra
          mobile/desktop, senão os testes (jsdom não aplica media query)
          encontram o texto 2x.
          Maria/Benefícios/Confiança só aparecem no desktop, numa coluna
          flex independente (não é grid com row-span dividindo espaço com
          itens de 1 linha — isso é o que abria os buracos entre eles antes).
        */}
        <div className="lg:grid lg:grid-cols-[1fr_420px] lg:items-start lg:gap-10">
          <div className="mb-5 lg:mb-0 lg:flex lg:flex-col lg:gap-7">
            <RegisterHero.Intro />
            <div className="hidden lg:block">
              <RegisterHero.Maria />
            </div>
            <div className="hidden lg:block">
              <RegisterHero.Benefits />
            </div>
            <div className="hidden lg:block">
              <RegisterHero.Trust />
            </div>
          </div>

          <div>
            <RegisterForm />
            <p className="mt-3 text-center text-[11.5px] text-lifeone-ink-4">
              Ao criar a conta você concorda com os Termos e a Política de Privacidade.
            </p>
            <div className="mt-4">
              <RegisterHero.SocialProof />
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
