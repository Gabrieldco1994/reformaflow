'use client';

import { formatCurrency } from '@/lib/utils';
import { InfoHint } from '@/components/InfoHint';

type Tone = 'emerald' | 'slate' | 'amber' | 'rose';
export type ResumoQuickFilterKey = 'entrouMes' | 'saiuMes' | 'faltaPagarMes';

const SMALL_CARDS: Array<{
  key: 'entrouMes' | 'saiuMes' | 'faltaPagarMes' | 'sobraPrevista';
  title: string;
  help: string;
  info: string;
  tone: Tone;
}> = [
  {
    key: 'entrouMes',
    title: 'Entrou no mês',
    help: 'salário e tudo que você recebeu',
    info: 'Tudo que já entrou na conta neste mês (salário e outros recebimentos efetivados). Clique para filtrar as entradas abaixo.',
    tone: 'emerald',
  },
  {
    key: 'saiuMes',
    title: 'Saiu no mês',
    help: 'tudo que já foi pago até hoje',
    info: 'Tudo que já saiu da conta neste mês (pagamentos efetivados até hoje). Clique para filtrar as saídas abaixo.',
    tone: 'slate',
  },
  {
    key: 'faltaPagarMes',
    title: 'Ainda falta pagar',
    help: 'faturas e contas até o fim do mês',
    info: 'O que ainda vai sair até o fim do mês: faturas de cartão e contas em aberto. Clique para filtrar o que falta pagar.',
    tone: 'amber',
  },
  {
    key: 'sobraPrevista',
    title: 'Sobra prevista',
    help: 'o que deve ficar na conta no dia 30',
    info: 'Previsão do saldo no fim do mês: o que tem hoje + o que ainda entra − o que ainda falta pagar. Negativo = a conta deve fechar no vermelho.',
    tone: 'emerald',
  },
];

function isQuickFilterKey(
  key: (typeof SMALL_CARDS)[number]['key'],
): key is ResumoQuickFilterKey {
  return key !== 'sobraPrevista';
}

function toneClasses(tone: Tone) {
  if (tone === 'emerald') return 'text-[#1E924A] bg-[#E3F6EA] border-[#BFE6CC]';
  if (tone === 'amber') return 'text-[#B5803A] bg-[#FBEBDC] border-[#EAD9C0]';
  if (tone === 'rose') return 'text-[#D92D20] bg-[#FCEBE9] border-[#F2C6C1]';
  return 'text-lifeone-ink bg-lifeone-surface border-lifeone-hairline';
}

export function ResumoCards({
  caixaHoje,
  entrouMes,
  saiuMes,
  faltaPagarMes,
  recebimentosPrevistosMes,
  sobraPrevista,
  activeQuickFilter,
  onQuickFilterSelect,
}: {
  caixaHoje: number;
  entrouMes: number;
  saiuMes: number;
  faltaPagarMes: number;
  recebimentosPrevistosMes: number;
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
      <article className="rounded-3xl border border-lifeone-hairline bg-lifeone-card p-4 shadow-lifeone-card xl:col-span-4 xl:flex xl:min-h-full xl:flex-col xl:justify-between xl:p-6">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-lifeone-ink-3">
          Tenho na conta hoje
          <InfoHint text="O dinheiro disponível de verdade na conta agora, reconciliado com o banco. Compras no cartão só entram aqui quando a fatura é paga." className="text-lifeone-ink-3" />
        </p>
        <p className="mt-2 text-[26px] font-bold tracking-tight text-lifeone-ink xl:text-[34px] font-geist tabular-nums">
          {formatCurrency(caixaHoje / 100)}
        </p>
        <p className="mt-2 max-w-sm text-[11px] leading-4 text-lifeone-ink-3 xl:text-xs xl:leading-5">
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
          const cardClass = `rounded-2xl border p-3 shadow-lifeone-card xl:flex xl:min-h-full xl:flex-col xl:justify-between xl:p-4 ${
            active ? 'ring-2 ring-lifeone-blue' : ''
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
                <p className="flex items-center gap-1 text-[11px] font-semibold leading-4">
                  {card.title}
                  <InfoHint text={card.info} />
                </p>
                <p className="mt-2 text-lg font-bold tracking-tight xl:text-[22px] font-geist tabular-nums">
                  {formatCurrency(value / 100)}
                </p>
                {card.key === 'entrouMes' && recebimentosPrevistosMes > 0 ? (
                  <p className="mt-1 text-[11px] font-semibold leading-4 text-[#B5803A]">
                    + {formatCurrency(recebimentosPrevistosMes / 100)} previsto ainda a entrar
                  </p>
                ) : null}
                <p className="mt-2 text-[11px] leading-4 opacity-80 xl:text-xs xl:leading-5">
                  {card.help}
                </p>
              </button>
            ) : (
              <article key={card.key} className={cardClass}>
                <p className="flex items-center gap-1 text-[11px] font-semibold leading-4">
                  {card.title}
                  <InfoHint text={card.info} />
                </p>
                <p className="mt-2 text-lg font-bold tracking-tight xl:text-[22px] font-geist tabular-nums">
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
