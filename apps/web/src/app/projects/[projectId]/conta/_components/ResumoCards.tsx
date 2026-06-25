'use client';

import { formatCurrency } from '@/lib/utils';

type Tone = 'emerald' | 'slate' | 'amber' | 'rose';
export type ResumoQuickFilterKey = 'entrouMes' | 'saiuMes' | 'faltaPagarMes';

const SMALL_CARDS: Array<{
  key: 'entrouMes' | 'saiuMes' | 'faltaPagarMes' | 'sobraPrevista';
  title: string;
  help: string;
  tone: Tone;
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
];

function isQuickFilterKey(
  key: (typeof SMALL_CARDS)[number]['key'],
): key is ResumoQuickFilterKey {
  return key !== 'sobraPrevista';
}

function toneClasses(tone: Tone) {
  if (tone === 'emerald') return 'text-emerald-700 bg-emerald-50 border-emerald-100';
  if (tone === 'amber') return 'text-amber-800 bg-amber-50 border-amber-100';
  if (tone === 'rose') return 'text-rose-700 bg-rose-50 border-rose-100';
  return 'text-slate-800 bg-slate-50 border-slate-200';
}

export function ResumoCards({
  caixaHoje,
  entrouMes,
  saiuMes,
  faltaPagarMes,
  sobraPrevista,
  activeQuickFilter,
  onQuickFilterSelect,
}: {
  caixaHoje: number;
  entrouMes: number;
  saiuMes: number;
  faltaPagarMes: number;
  sobraPrevista: number;
  activeQuickFilter: ResumoQuickFilterKey | null;
  onQuickFilterSelect: (key: ResumoQuickFilterKey) => void;
}) {
  const values = {
    entrouMes,
    saiuMes,
    faltaPagarMes,
    sobraPrevista,
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

      <div className="grid grid-cols-2 gap-3 xl:col-span-8 xl:auto-rows-fr xl:grid-cols-4 xl:gap-4">
        {SMALL_CARDS.map((card) => {
          const value = values[card.key];
          const tone = card.key === 'sobraPrevista' ? (value < 0 ? 'rose' : 'emerald') : card.tone;
          const quickFilterKey: ResumoQuickFilterKey | null = isQuickFilterKey(card.key)
            ? card.key
            : null;
          const filterable = quickFilterKey != null;
          const active = quickFilterKey != null && activeQuickFilter === quickFilterKey;
          const cardClass = `rounded-2xl border p-3 shadow-sm xl:flex xl:min-h-full xl:flex-col xl:justify-between xl:p-4 ${
            active ? 'ring-2 ring-orange-400' : ''
          } ${filterable ? 'cursor-pointer' : ''} ${toneClasses(tone)}`;
          return (
            filterable && quickFilterKey ? (
              <button
                key={card.key}
                type="button"
                onClick={() => onQuickFilterSelect(quickFilterKey)}
                aria-pressed={active}
                className={`${cardClass} text-left`}
              >
                <p className="text-[11px] font-semibold leading-4">{card.title}</p>
                <p className="mt-2 text-lg font-bold tracking-tight xl:text-[22px]">
                  {formatCurrency(value / 100)}
                </p>
                <p className="mt-2 text-[11px] leading-4 opacity-80 xl:text-xs xl:leading-5">
                  {card.help}
                </p>
              </button>
            ) : (
              <article key={card.key} className={cardClass}>
                <p className="text-[11px] font-semibold leading-4">{card.title}</p>
                <p className="mt-2 text-lg font-bold tracking-tight xl:text-[22px]">
                  {formatCurrency(value / 100)}
                </p>
                <p className="mt-2 text-[11px] leading-4 opacity-80 xl:text-xs xl:leading-5">
                  {card.help}
                </p>
              </article>
            )
          );
        })}
      </div>
    </section>
  );
}
