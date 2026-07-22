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

        <div className="lg:flex lg:items-center lg:gap-10">
          <RegisterHero />
          <div className="mt-6 lg:mt-0 lg:w-[420px] lg:shrink-0">
            <RegisterForm />
          </div>
        </div>
      </div>
    </main>
  );
}
