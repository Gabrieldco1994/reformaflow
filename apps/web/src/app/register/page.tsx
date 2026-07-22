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
          Mobile: single column, natural DOM order (Intro -> Maria -> Form -> Benefits -> Phone -> Trust).
          Desktop: two independent columns via explicit grid placement (form fixed on the right).
        */}
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_420px] lg:auto-rows-min lg:items-start lg:gap-x-10 lg:gap-y-8">
          <div className="lg:col-start-1 lg:row-start-1">
            <RegisterHero.Intro />
          </div>

          <div className="lg:col-start-1 lg:row-start-2">
            <RegisterHero.Maria />
          </div>

          <div className="lg:col-start-2 lg:row-start-1 lg:row-span-5">
            <RegisterForm />
            <p className="mt-3 text-center text-[11.5px] text-lifeone-ink-4">
              Ao criar a conta você concorda com os Termos e a Política de Privacidade.
            </p>
            <div className="mt-4">
              <RegisterHero.SocialProof />
            </div>
          </div>

          <div className="lg:col-start-1 lg:row-start-3">
            <RegisterHero.Benefits />
          </div>

          <div className="lg:col-start-1 lg:row-start-4">
            <RegisterHero.Phone />
          </div>

          <div className="lg:col-start-1 lg:row-start-5">
            <RegisterHero.Trust />
          </div>
        </div>
      </div>
    </main>
  );
}
