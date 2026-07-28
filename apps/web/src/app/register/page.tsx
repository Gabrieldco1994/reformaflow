import Link from 'next/link';
import { LifeOneLogo } from '@/components/LifeOneLogo';
import { RegisterHero } from './_components/RegisterHero';
import { RegisterForm } from './_components/RegisterForm';

export default function RegisterPage() {
  return (
    <main className="flex min-h-screen flex-col bg-lifeone-canvas px-4 py-6 font-geist sm:px-6 sm:py-10">
      <div className="mx-auto w-full max-w-md lg:my-auto lg:max-w-none lg:w-[clamp(960px,90vw,1280px)]">
        <header className="mb-6 flex items-center justify-between gap-4">
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

          Container ESTREITA (`clamp(960px, 90vw, 1280px)`, era 1560px).
          As tentativas anteriores alargaram o container achando que a
          sobra estava nas laterais da página — não estava: o vazio era
          DENTRO da coluna esquerda. Com 1560px a coluna do hero chegava a
          ~952px enquanto o texto dela é capado em 46ch (~430px), ou seja
          ~520px de buraco interno. Teto em 1280px mantém a coluna do hero
          próxima da largura que o texto realmente ocupa.
          Coluna do form: `clamp(440px, 36vw, 520px)` — proporção maior do
          total (36vw) justamente porque o container encolheu, com teto em
          520px pra não esticar demais os inputs.
          `lg:items-start` saiu de propósito: as duas colunas esticam pra
          mesma altura e o bloco de Confiança usa `lg:mt-auto` pra
          encostar no mesmo rodapé do card do form.
          Centragem vertical via `my-auto` no container (+ `flex flex-col`
          no main), NÃO `justify-center`: com justify-center o topo é
          cortado quando o conteúdo estoura a viewport.
        */}
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_clamp(440px,36vw,520px)] lg:gap-14">
          <div className="mb-5 lg:mb-0 lg:flex lg:flex-col lg:gap-7">
            <RegisterHero.Intro />
            <div className="hidden lg:block">
              <RegisterHero.Maria />
            </div>
            <div className="hidden lg:block">
              <RegisterHero.Benefits />
            </div>
            <div className="hidden lg:mt-auto lg:block">
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
