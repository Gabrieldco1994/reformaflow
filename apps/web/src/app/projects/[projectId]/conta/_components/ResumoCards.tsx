'use client';

import { formatCurrency } from '@/lib/utils';
import { InfoHint } from '@/components/InfoHint';
import { KpiTile, type KpiTone } from '@/components/KpiTile';

type Tone = 'emerald' | 'slate' | 'amber' | 'rose';
export type ResumoQuickFilterKey = 'entrouMes' | 'saiuMes' | 'faltaPagarMes';

/** Mapeia os tones legados da Visão Conta para o tone semântico do KpiTile. */
const TONE_MAP: Record<Tone, KpiTone> = {
  emerald: 'positive',
  slate: 'neutral',
  amber: 'alert',
  rose: 'negative',
};

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
    help: 'saldo acumulado no fim do mês',
    info: 'Saldo projetado ACUMULADO no fim do mês: parte do caixa de hoje e vai somando, mês a mês, o que ainda entra menos o que falta pagar — carregando o que sobrou (ou faltou) dos meses anteriores. É o mesmo ponto do gráfico de projeção logo abaixo. Negativo = a conta fecha no vermelho.',
    tone: 'emerald',
  },
];

function isQuickFilterKey(
  key: (typeof SMALL_CARDS)[number]['key'],
): key is ResumoQuickFilterKey {
  return key !== 'sobraPrevista';
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
          const tone: KpiTone = card.key === 'sobraPrevista'
            ? (value < 0 ? 'negative' : 'positive')
            : TONE_MAP[card.tone];
          const quickFilterKey: ResumoQuickFilterKey | null = isQuickFilterKey(card.key)
            ? card.key
            : null;
          const active = quickFilterKey != null && activeQuickFilter === quickFilterKey;
          return (
            <KpiTile
              key={card.key}
              variant="tinted"
              tone={tone}
              label={card.title}
              info={card.info}
              value={formatCurrency(value / 100)}
              context={card.help}
              className="xl:flex xl:min-h-full xl:flex-col xl:justify-between xl:p-4"
              active={active}
              onClick={quickFilterKey ? () => onQuickFilterSelect(quickFilterKey) : undefined}
              extra={
                card.key === 'entrouMes' && recebimentosPrevistosMes > 0 ? (
                  <p className="mt-1 text-[11px] font-semibold leading-4 text-[#B5803A]">
                    + {formatCurrency(recebimentosPrevistosMes / 100)} previsto ainda a entrar
                  </p>
                ) : undefined
              }
            />
          );
        })}
      </div>
    </section>
  );
}
