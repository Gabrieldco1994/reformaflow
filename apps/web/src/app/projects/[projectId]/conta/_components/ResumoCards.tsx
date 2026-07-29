'use client';

import { InfoHint } from '@/components/InfoHint';
import { KpiTile, type KpiTone } from '@/components/KpiTile';
import { formatCurrency } from '@/lib/utils';

type Tone = 'emerald' | 'slate' | 'amber' | 'rose';
export type ResumoQuickFilterKey = 'entrouMes' | 'saiuMes' | 'faltaPagarMes';
type SummaryKey = ResumoQuickFilterKey | 'sobraPrevista';
/** 'mes' = Visão Conta do mês (default, tela em produção); 'ano' = visão anual. */
export type ResumoPeriod = 'mes' | 'ano';

const TONE_MAP: Record<Tone, KpiTone> = {
  emerald: 'positive',
  slate: 'neutral',
  amber: 'alert',
  rose: 'negative',
};

const CARDS: Record<
  SummaryKey,
  { title: string; help: string; info: string; tone: Tone }
> = {
  entrouMes: {
    title: 'Entrou no mês',
    help: 'salário e tudo que você recebeu',
    info: 'Tudo que já entrou na conta neste mês (salário e outros recebimentos efetivados). Clique para filtrar as entradas abaixo.',
    tone: 'emerald',
  },
  saiuMes: {
    title: 'Saiu no mês',
    help: 'tudo que já foi pago até hoje',
    info: 'Tudo que já saiu da conta neste mês (pagamentos efetivados até hoje). Clique para filtrar as saídas abaixo.',
    tone: 'slate',
  },
  faltaPagarMes: {
    title: 'Ainda falta pagar',
    help: 'faturas e contas até o fim do mês',
    info: 'O que ainda vai sair até o fim do mês: faturas de cartão e contas em aberto. Clique para filtrar o que falta pagar.',
    tone: 'amber',
  },
  sobraPrevista: {
    title: 'Sobra prevista',
    help: 'saldo acumulado no fim do mês',
    info: 'Saldo projetado ACUMULADO no fim do mês: parte do caixa de hoje e vai somando, mês a mês, o que ainda entra menos o que falta pagar — carregando o que sobrou (ou faltou) dos meses anteriores. É o mesmo ponto do gráfico de projeção logo abaixo. Negativo = a conta fecha no vermelho.',
    tone: 'emerald',
  },
};

/**
 * Rótulos da visão ANUAL. Só os campos de FLUXO (entrou/saiu/falta pagar) viram
 * "no ano" — eles são a soma dos 12 meses. `sobraPrevista` anual mistura, DE
 * PROPÓSITO, o saldo PONTUAL de hoje com o fluxo do ano inteiro ("com o caixa de
 * hoje, eu atravesso o ano?"), então o rótulo diz isso na cara. O card de saldo
 * pontual (caixa/carteira) continua rotulado "hoje" nos dois períodos — saldo
 * pontual nunca é somado nem lido como fluxo do período.
 */
const CARDS_ANO: Record<SummaryKey, { title: string; help: string; info: string }> = {
  entrouMes: {
    title: 'Entrou no ano',
    help: 'soma dos 12 meses do ano',
    info: 'Tudo que entrou na conta no ano (soma dos 12 meses, mesma base da visão mensal). Clique para filtrar as entradas abaixo.',
  },
  saiuMes: {
    title: 'Saiu no ano',
    help: 'soma dos 12 meses do ano',
    info: 'Tudo que já saiu da conta no ano (soma dos 12 meses, mesma base da visão mensal). Clique para filtrar as saídas abaixo.',
  },
  faltaPagarMes: {
    title: 'Ainda falta pagar no ano',
    help: 'faturas e contas em aberto no ano',
    info: 'O que ainda vai sair até o fim do ano: faturas de cartão e contas em aberto dos 12 meses. Clique para filtrar o que falta pagar.',
  },
  sobraPrevista: {
    title: 'Sobra prevista no ano',
    help: 'com o caixa de hoje, atravessando o ano',
    info: 'Projeção do ano: parte do caixa de HOJE (saldo pontual) e desconta tudo que ainda falta pagar no ano, somando o que ainda está previsto entrar. Mistura saldo pontual com fluxo anual de propósito — a pergunta é "com o caixa de hoje, eu atravesso o ano?". Negativo = o ano fecha no vermelho.',
  },
};

const REALIZED_KEYS = ['entrouMes', 'saiuMes'] as const;
const PROJECTION_KEYS = ['faltaPagarMes', 'sobraPrevista'] as const;

export function ResumoCards({
  caixaHoje,
  carteiraHoje,
  entrouMes,
  saiuMes,
  faltaPagarMes,
  recebimentosPrevistosMes,
  sobraPrevista,
  saiuSemConta,
  activeQuickFilter,
  onQuickFilterSelect,
  period = 'mes',
}: {
  caixaHoje: number;
  carteiraHoje?: number;
  entrouMes: number;
  saiuMes: number;
  faltaPagarMes: number;
  recebimentosPrevistosMes: number;
  sobraPrevista: number;
  /** Centavos: soma das saídas realizadas do mês sem conta/cartão vinculado (Carteira). */
  saiuSemConta?: number;
  activeQuickFilter: ResumoQuickFilterKey | null;
  onQuickFilterSelect: (key: ResumoQuickFilterKey) => void;
  /** Rotula os fluxos como do mês (default) ou do ano. Saldo pontual é sempre "hoje". */
  period?: ResumoPeriod;
}) {
  const modoCarteira = caixaHoje === 0 && (carteiraHoje ?? 0) !== 0;

  const values: Record<SummaryKey, number> = {
    entrouMes,
    saiuMes,
    faltaPagarMes,
    sobraPrevista,
  };

  function renderTile(key: SummaryKey) {
    const base = CARDS[key];
    const card = period === 'ano' ? { ...base, ...CARDS_ANO[key] } : base;
    const value = values[key];
    const quickFilterKey = key === 'sobraPrevista' ? null : key;
    const tone =
      key === 'sobraPrevista'
        ? value < 0
          ? 'negative'
          : 'positive'
        : TONE_MAP[card.tone];

    return (
      <KpiTile
        key={key}
        variant="tinted"
        tone={tone}
        label={card.title}
        info={card.info}
        value={formatCurrency(value / 100)}
        context={card.help}
        className="xl:flex xl:min-h-full xl:flex-col xl:justify-between xl:p-4"
        mobileCompact
        active={quickFilterKey != null && activeQuickFilter === quickFilterKey}
        onClick={
          quickFilterKey ? () => onQuickFilterSelect(quickFilterKey) : undefined
        }
        extra={
          key === 'saiuMes' && (saiuSemConta ?? 0) > 0 ? (
            <p className="mt-1 text-[11px] font-semibold leading-3.5 text-lifeone-ink-3 md:text-[11px] md:leading-4">
              inclui {formatCurrency((saiuSemConta ?? 0) / 100)} sem conta vinculada
            </p>
          ) : key === 'sobraPrevista' && recebimentosPrevistosMes > 0 ? (
            // Fica no card da SOBRA porque é lá que essa entrada entra na conta
            // (a projeção já soma o que ainda está previsto entrar). No card
            // "Ainda falta pagar" ela lia como se a entrada fosse algo a sair.
            <p className="mt-1 text-[11px] font-semibold leading-3.5 opacity-80 md:text-[11px] md:leading-4">
              já conta {formatCurrency(recebimentosPrevistosMes / 100)} a entrar
            </p>
          ) : undefined
        }
      />
    );
  }

  return (
    <section className="grid gap-2 xl:grid-cols-12 xl:gap-4">
      <article className="rounded-2xl border border-lifeone-hairline bg-lifeone-card p-2.5 shadow-lifeone-card xl:col-span-4 xl:flex xl:min-h-full xl:flex-col xl:justify-between xl:rounded-3xl xl:p-6">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-lifeone-ink-3">
          {modoCarteira
            ? // Carteira também é saldo PONTUAL: na visão anual o rótulo precisa
              // dizer "hoje", senão o número é lido como fluxo do ano inteiro.
              period === 'ano'
              ? 'Carteira (dinheiro) hoje'
              : 'Carteira (dinheiro)'
            : 'Tenho na conta hoje'}
          <InfoHint
            text={
              modoCarteira
                ? 'Fluxo líquido de dinheiro em espécie: recebimentos já em mãos menos despesas já pagas em dinheiro. Sem conta bancária vinculada.'
                : 'O dinheiro disponível de verdade na conta agora, reconciliado com o banco. Compras no cartão só entram aqui quando a fatura é paga.'
            }
            className="text-lifeone-ink-3"
          />
        </p>
        <p className="mt-1 font-geist text-[22px] font-bold tabular-nums tracking-tight text-lifeone-ink xl:mt-2 xl:text-[34px]">
          {formatCurrency((modoCarteira ? (carteiraHoje ?? 0) : caixaHoje) / 100)}
        </p>
        <p className="mt-1 max-w-sm text-[11px] leading-3.5 text-lifeone-ink-3 xl:mt-2 xl:text-xs xl:leading-5">
          {modoCarteira
            ? period === 'ano'
              ? 'é o dinheiro em espécie que você tem hoje — não é a soma do ano'
              : 'resultado do que entrou e saiu em dinheiro/espécie neste período'
            : 'é o dinheiro disponível agora, de verdade, na sua conta'}
        </p>
      </article>

      <div className="space-y-2 xl:col-span-8 xl:grid xl:auto-rows-fr xl:grid-cols-4 xl:gap-4 xl:space-y-0">
        <section aria-label="Realizado" className="space-y-1 xl:contents">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-lifeone-ink-3 xl:hidden">
            Realizado
          </h2>
          <div className="grid grid-cols-2 gap-2 xl:contents">
            {REALIZED_KEYS.map(renderTile)}
          </div>
        </section>
        <section aria-label="Projeção" className="space-y-1 xl:contents">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-lifeone-ink-3 xl:hidden">
            Projeção
          </h2>
          <div className="grid grid-cols-2 gap-2 xl:contents">
            {PROJECTION_KEYS.map(renderTile)}
          </div>
        </section>
      </div>
    </section>
  );
}
