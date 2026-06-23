'use client';

import { formatCurrency } from '@/lib/utils';

const SMALL_CARDS: Array<{
  key: 'entrouMes' | 'saiuMes' | 'faltaPagarMes' | 'sobraPrevista' | 'devoCartaoTotal';
  title: string;
  help: string;
  tone: 'emerald' | 'slate' | 'amber';
  spanTwo?: boolean;
}> = [
  {
    key: 'entrouMes',
    title: 'Entrou no mês',
    help: 'salário e tudo que você recebeu',
    tone: 'emerald',
  },
  {
    key: 'saiuMes',
    title: 'Saiu no mês',
    help: 'tudo que já foi pago até hoje',
    tone: 'slate',
  },
  {
    key: 'faltaPagarMes',
    title: 'Ainda falta pagar',
    help: 'faturas e contas até o fim do mês',
    tone: 'amber',
  },
  {
    key: 'sobraPrevista',
    title: 'Sobra prevista',
    help: 'o que deve ficar na conta no dia 30',
    tone: 'emerald',
  },
  {
    key: 'devoCartaoTotal',
    title: 'Devo de cartão',
    help: 'soma das faturas em aberto',
    tone: 'slate',
    spanTwo: true,
  },
];

function toneClasses(tone: 'emerald' | 'slate' | 'amber') {
  if (tone === 'emerald') return 'text-emerald-700 bg-emerald-50 border-emerald-100';
  if (tone === 'amber') return 'text-amber-800 bg-amber-50 border-amber-100';
  return 'text-slate-800 bg-slate-50 border-slate-200';
}

export function ResumoCards({
  caixaHoje,
  entrouMes,
  saiuMes,
  faltaPagarMes,
  sobraPrevista,
  devoCartaoTotal,
}: {
  caixaHoje: number;
  entrouMes: number;
  saiuMes: number;
  faltaPagarMes: number;
  sobraPrevista: number;
  devoCartaoTotal: number;
}) {
  const values = {
    entrouMes,
    saiuMes,
    faltaPagarMes,
    sobraPrevista,
    devoCartaoTotal,
  };

  return (
    <section className="grid gap-3 xl:grid-cols-12 xl:gap-4">
      <article className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm xl:col-span-4 xl:flex xl:min-h-full xl:flex-col xl:justify-between xl:p-6">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          Tenho na conta hoje
        </p>
        <p className="mt-2 text-[26px] font-bold tracking-tight text-slate-950 xl:text-[34px]">
          {formatCurrency(caixaHoje / 100)}
        </p>
        <p className="mt-2 max-w-sm text-[11px] leading-4 text-slate-500 xl:text-xs xl:leading-5">
          é o dinheiro disponível agora, de verdade, na sua conta
        </p>
      </article>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:col-span-8 xl:auto-rows-fr xl:gap-4">
        {SMALL_CARDS.map((card) => (
          <article
            key={card.key}
            className={`rounded-2xl border p-3 shadow-sm xl:flex xl:min-h-full xl:flex-col xl:justify-between xl:p-4 ${toneClasses(card.tone)} ${
              card.spanTwo ? 'col-span-2 lg:col-span-1 xl:col-span-1' : ''
            }`}
          >
            <p className="text-[11px] font-semibold leading-4">{card.title}</p>
            <p className="mt-2 text-lg font-bold tracking-tight xl:text-[22px]">
              {formatCurrency(values[card.key] / 100)}
            </p>
            <p className="mt-2 text-[11px] leading-4 opacity-80 xl:text-xs xl:leading-5">{card.help}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
