'use client';

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import { InfoHint } from '@/components/InfoHint';
import type { DreMensal, DreGroup, DreLine } from '../_types';
import { DreEixoMensal } from './DreMensalView';
import { DreIcon } from './DreIcon';
import { DreWaterfall, type WaterfallStep } from './DreWaterfall';

const SEM = {
  in: { ink: '#1D9E75', tint: '#E1F5EE', soft: '#BFE9DA' },
  out: { ink: '#D85A30', tint: '#FCEBEB', soft: '#F3D0D0' },
  save: { ink: '#BA7517', tint: '#FAEEDA', soft: '#EFD9B6' },
} as const;

function sum(items: Array<{ valor: number }>) {
  return items.reduce((s, i) => s + i.valor, 0);
}

function monthLong(mes: string) {
  const [year, month] = mes.split('-').map(Number);
  if (!year || !month) return mes;
  const d = new Date(Date.UTC(year, month - 1, 1));
  return new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
}

function deltaText(delta: number) {
  const rounded = Math.round(delta * 10) / 10;
  if (rounded === 0) return 'estável vs mês anterior';
  return `${rounded > 0 ? '↑' : '↓'} ${Math.abs(rounded).toLocaleString('pt-BR', {
    maximumFractionDigits: 1,
  })}% vs mês anterior`;
}

type SpineTerm = {
  key: string;
  label: string;
  value: number;
  sub: string;
  tone: 'in' | 'out' | 'save';
  info?: string;
};

/** Layout desktop do DRE mensal: espinha-equação + cascata + breakdown em 3 colunas. */
export function DreMensalDesktop({
  data,
  eixo,
  onChangeEixo,
}: {
  data: DreMensal;
  eixo: DreEixoMensal;
  onChangeEixo: (next: DreEixoMensal) => void;
}) {
  const competencia = eixo === 'competencia';

  const entradas = competencia ? data.entradas : data.entradasConta;
  const groups = competencia ? data.saidas : data.saidasCaixa;
  const totalEntradas = competencia ? data.totalEntrou : data.contaCorrente.entrouMes;
  const totalSaidas = groups.reduce((s, g) => s + sum(g.items), 0);
  const totalGuardado = sum(data.guardado);
  const receita = competencia ? data.receitaTotal : data.contaCorrente.entrouMes;
  const despesa = competencia ? data.despesaTotal : data.contaCorrente.despesaTotal;

  const numLancamentos = groups.reduce((s, g) => s + g.items.length, 0);

  // Espinha (equação) + operadores + cascata, por eixo.
  let terms: SpineTerm[];
  let operators: string[];
  let resultLabel: string;
  let resultValue: number;
  let resultSub: string;
  let waterfall: WaterfallStep[];
  let contextLine: string;

  if (competencia) {
    terms = [
      { key: 'in', label: 'entrou', value: totalEntradas, sub: `${entradas.length} fontes de receita`, tone: 'in' },
      { key: 'out', label: 'saiu', value: totalSaidas, sub: `${numLancamentos} lançamentos · ${groups.length} grupos`, tone: 'out' },
      { key: 'save', label: 'guardou', value: totalGuardado, sub: totalGuardado > 0 ? `${data.guardado.length} reservas` : 'nada reservado', tone: 'save' },
    ];
    operators = ['−', '−'];
    resultLabel = 'resultado';
    resultValue = data.resultado;
    resultSub = 'sobra livre do mês';
    waterfall = [
      { key: 'in', label: 'entrou', amount: totalEntradas, kind: 'in', isTotal: true },
      { key: 'out', label: 'saiu', amount: totalSaidas, kind: 'out' },
      { key: 'save', label: 'guardou', amount: totalGuardado, kind: 'save' },
      { key: 'res', label: 'resultado', amount: data.resultado, kind: 'result', isTotal: true },
    ];
    contextLine = deltaText(data.deltaVsMesAnterior);
  } else {
    const cc = data.contaCorrente;
    terms = [
      { key: 'hoje', label: 'tenho hoje', value: cc.caixaHoje, sub: 'na conta, de verdade', tone: cc.caixaHoje >= 0 ? 'in' : 'out', info: 'O dinheiro disponível de verdade na conta agora, reconciliado com o banco.' },
      { key: 'falta', label: 'falta pagar', value: cc.faltaPagarMes, sub: 'até o fim do mês', tone: 'out', info: 'O que ainda vai sair da conta até o fim do mês: faturas de cartão e contas em aberto.' },
      { key: 'prev', label: 'vão entrar', value: cc.recebimentosPrevistosMes, sub: 'recebimentos previstos', tone: 'in', info: 'O que ainda deve entrar na conta até o fim do mês (previstos, não confirmados).' },
    ];
    operators = ['−', '+'];
    resultLabel = 'sobra prevista';
    resultValue = cc.sobraPrevista;
    resultSub = 'saldo previsto no fim do mês';
    waterfall = [
      { key: 'hoje', label: 'tenho hoje', amount: cc.caixaHoje, kind: 'result', isTotal: true },
      { key: 'falta', label: 'falta pagar', amount: cc.faltaPagarMes, kind: 'out' },
      { key: 'prev', label: 'vão entrar', amount: cc.recebimentosPrevistosMes, kind: 'in' },
      { key: 'sobra', label: 'sobra prevista', amount: cc.sobraPrevista, kind: 'result', isTotal: true },
    ];
    contextLine =
      cc.sobraPrevista >= 0
        ? 'a conta deve fechar no azul'
        : 'atenção: a conta deve fechar no vermelho';
  }

  const positive = resultValue >= 0;
  const despesaPct = receita > 0 ? (despesa / receita) * 100 : 0;
  const margem = receita - despesa;

  return (
    <div className="space-y-4">
      {/* Toggle de eixo */}
      <div className="flex justify-end">
        <div className="inline-flex rounded-xl border border-lifeone-hairline bg-lifeone-surface p-0.5">
          <button
            type="button"
            onClick={() => onChangeEixo('competencia')}
            className={`h-9 rounded-lg px-4 text-[13px] font-semibold transition ${
              competencia ? 'bg-lifeone-card text-lifeone-ink shadow-lifeone-card' : 'text-lifeone-ink-3 hover:text-lifeone-ink-2'
            }`}
          >
            Competência
          </button>
          <button
            type="button"
            onClick={() => onChangeEixo('contaCorrente')}
            className={`h-9 rounded-lg px-4 text-[13px] font-semibold transition ${
              !competencia ? 'bg-lifeone-card text-lifeone-ink shadow-lifeone-card' : 'text-lifeone-ink-3 hover:text-lifeone-ink-2'
            }`}
          >
            Conta corrente
          </button>
        </div>
      </div>

      {/* Espinha-equação (hero) */}
      <section className="relative overflow-hidden rounded-[18px] border border-lifeone-hairline bg-lifeone-card px-6 py-5 shadow-lifeone-card">
        <span
          className="absolute inset-y-0 left-0 w-[5px]"
          style={{ background: `linear-gradient(180deg, ${SEM.in.ink}, ${SEM.save.ink} 55%, ${SEM.out.ink})` }}
        />
        <div className="mb-4 flex items-baseline justify-between gap-4 pl-2">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-lifeone-ink-3">
            {competencia ? `Resultado de ${monthLong(data.mes)} · por competência` : 'Situação da conta · caixa'}
          </p>
          <p className="text-[12.5px] text-lifeone-ink-2">
            {competencia && (
              <>
                margem de <b className="font-semibold text-lifeone-ink">{despesaPct > 0 ? (100 - despesaPct).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) : '0'}%</b> ·{' '}
              </>
            )}
            <span className={positive ? 'font-semibold text-[#1D9E75]' : 'font-semibold text-[#D85A30]'}>{contextLine}</span>
          </p>
        </div>

        <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr_auto_1.2fr] items-center gap-2 pl-2">
          {terms.map((term, i) => (
            <SpineTermCell key={term.key} term={term} op={i < operators.length ? operators[i] : undefined} />
          ))}
          <div className="text-center text-2xl font-normal text-lifeone-ink-4 select-none">=</div>
          <article
            className="rounded-2xl border px-4 py-3"
            style={{
              background: positive ? `linear-gradient(150deg, ${SEM.in.tint}, #EAF6F0)` : `linear-gradient(150deg, ${SEM.out.tint}, #FBEEE8)`,
              borderColor: positive ? SEM.in.soft : SEM.out.soft,
            }}
          >
            <p className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: positive ? SEM.in.ink : SEM.out.ink }}>
              {resultLabel}
            </p>
            <p className="mt-1.5 text-[38px] font-bold leading-none tracking-tight tabular-nums" style={{ color: positive ? SEM.in.ink : SEM.out.ink }}>
              {formatCurrency(resultValue / 100)}
            </p>
            <p className="mt-1.5 text-[11.5px]" style={{ color: positive ? '#3F7B64' : '#9A4A2C' }}>
              {resultSub}
            </p>
          </article>
        </div>
      </section>

      {/* Cascata + Receita × Despesa */}
      <div className="grid grid-cols-[1.42fr_1fr] gap-4">
        <section className="rounded-[18px] border border-lifeone-hairline bg-lifeone-card px-6 py-5 shadow-lifeone-card">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-lifeone-ink-3">
              Como {competencia ? 'o resultado' : 'a sobra'} se formou
            </p>
            <span className="text-[11.5px] text-lifeone-ink-4">cascata · passo a passo</span>
          </div>
          <div className="mt-3">
            <DreWaterfall steps={waterfall} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-4 text-[11.5px] text-lifeone-ink-3">
            <LegendDot color={SEM.in.ink} label="entra" />
            <LegendDot color={SEM.out.ink} label="sai" />
            {competencia && <LegendDot color={SEM.save.ink} label="guardado" />}
            <LegendDot color={positive ? '#0F6B4D' : '#B4441F'} label={competencia ? 'resultado' : 'saldo'} />
          </div>
        </section>

        <section className="rounded-[18px] border border-lifeone-hairline bg-lifeone-card px-6 py-5 shadow-lifeone-card">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-lifeone-ink-3">Receita × Despesa</p>
          <div className="mt-4 space-y-4">
            <ProportionBar label="receita" value={receita} pct={100} tone="in" />
            <ProportionBar label="despesa" value={despesa} pct={Math.min(100, despesaPct)} tone="out" />
          </div>
          <div className="mt-5 flex items-end justify-between border-t border-lifeone-hairline-3 pt-4">
            <div>
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-lifeone-ink-3">margem</p>
              <p className="mt-1 text-[19px] font-bold tabular-nums" style={{ color: margem >= 0 ? SEM.in.ink : SEM.out.ink }}>
                {formatCurrency(margem / 100)}
              </p>
            </div>
            <div className="text-right">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-lifeone-ink-3">despesa / receita</p>
              <p className="mt-1 text-[19px] font-bold tabular-nums" style={{ color: SEM.save.ink }}>
                {despesaPct.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%
              </p>
            </div>
          </div>
        </section>
      </div>

      {/* Breakdown em 3 colunas */}
      <section className="rounded-[18px] border border-lifeone-hairline bg-lifeone-card px-6 py-5 shadow-lifeone-card">
        <div className="grid grid-cols-[4fr_5fr_3fr] gap-6">
          <EntradasColumn entradas={entradas} total={totalEntradas} />
          <SaidasColumn groups={groups} total={totalSaidas} />
          <GuardadoColumn guardado={data.guardado} total={totalGuardado} monthLabel={monthLong(data.mes)} />
        </div>
      </section>
    </div>
  );
}

function SpineTermCell({ term, op }: { term: SpineTerm; op?: string }) {
  const sem = SEM[term.tone];
  return (
    <>
      <div className="px-1.5 py-1">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: '#8A857C' }}>
          <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: sem.ink }} />
          {term.label}
          {term.info && <InfoHint text={term.info} />}
        </p>
        <p className="mt-1.5 text-[27px] font-bold leading-none tracking-tight tabular-nums" style={{ color: sem.ink }}>
          {formatCurrency(term.value / 100)}
        </p>
        <p className="mt-1.5 text-[11.5px] text-lifeone-ink-3">{term.sub}</p>
      </div>
      {op && <div className="text-center text-[26px] font-normal text-lifeone-ink-4 select-none">{op}</div>}
    </>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: color }} />
      {label}
    </span>
  );
}

function ProportionBar({ label, value, pct, tone }: { label: string; value: number; pct: number; tone: 'in' | 'out' }) {
  const sem = SEM[tone];
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-[12.5px]">
        <span className="font-semibold text-lifeone-ink-2">{label}</span>
        <span className="font-bold tabular-nums" style={{ color: sem.ink }}>
          {formatCurrency(value / 100)}
        </span>
      </div>
      <div className="h-2.5 overflow-hidden rounded-full" style={{ background: sem.tint }}>
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: sem.ink }} />
      </div>
    </div>
  );
}

function EntradasColumn({ entradas, total }: { entradas: DreLine[]; total: number }) {
  return (
    <div>
      <div className="mb-3.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-lifeone-ink-3">
        o que entrou
        <span className="ml-auto text-[11px] font-bold normal-case tracking-normal" style={{ color: SEM.in.ink }}>
          {entradas.length}
        </span>
      </div>
      {entradas.map((line, i) => (
        <div key={`${line.label}-${i}`} className={`flex items-center gap-3 py-2.5 ${i > 0 ? 'border-t border-lifeone-hairline-3' : ''}`}>
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px]" style={{ background: SEM.in.tint, color: SEM.in.ink }}>
            <DreIcon name="wallet" className="h-3.5 w-3.5" />
          </span>
          <span className="flex-1 truncate text-[13.5px] font-medium text-lifeone-ink">{line.label}</span>
          <span className="text-[13.5px] font-bold tabular-nums" style={{ color: SEM.in.ink }}>
            {formatCurrency(line.valor / 100)}
          </span>
        </div>
      ))}
      <ColumnTotal label="total entradas" value={total} tone="in" />
    </div>
  );
}

function SaidasColumn({ groups, total }: { groups: DreGroup[]; total: number }) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const maxGroup = Math.max(1, ...groups.map((g) => sum(g.items)));
  return (
    <div>
      <div className="mb-3.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-lifeone-ink-3">
        o que você comprou
        <span className="ml-auto text-[11px] font-bold normal-case tracking-normal" style={{ color: SEM.out.ink }}>
          {groups.length} grupos
        </span>
      </div>
      {groups.map((group, i) => {
        const totalGrupo = sum(group.items);
        const open = !!expanded[group.group];
        return (
          <div key={`${group.group}-${i}`} className={`py-2.5 ${i > 0 ? 'border-t border-lifeone-hairline-3' : ''}`}>
            <button
              type="button"
              onClick={() => setExpanded((p) => ({ ...p, [group.group]: !p[group.group] }))}
              className="flex w-full items-center gap-3"
              aria-expanded={open}
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px]" style={{ background: SEM.out.tint, color: SEM.out.ink }}>
                <DreIcon name={group.icon} className="h-3.5 w-3.5" />
              </span>
              <span className="flex-1 text-left text-[13.5px] font-semibold text-lifeone-ink">
                {group.group}
                <span className="ml-1 text-[11px] font-medium text-lifeone-ink-4">· {group.items.length}</span>
              </span>
              <span className="text-[13.5px] font-bold tabular-nums" style={{ color: SEM.out.ink }}>
                {formatCurrency(totalGrupo / 100)}
              </span>
              <ChevronDown className={`h-3.5 w-3.5 text-lifeone-ink-4 transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
            <div className="ml-[39px] mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: SEM.out.tint }}>
              <div className="h-full rounded-full opacity-85" style={{ width: `${(totalGrupo / maxGroup) * 100}%`, background: SEM.out.ink }} />
            </div>
            {open && (
              <div className="ml-[39px] mt-2 space-y-1.5">
                {group.items.map((item, j) => (
                  <div key={`${item.label}-${j}`} className="flex items-center justify-between gap-3 text-[12px] text-lifeone-ink-2">
                    <span className="truncate">{item.label}</span>
                    <span className="font-semibold tabular-nums" style={{ color: SEM.out.ink }}>
                      {formatCurrency(item.valor / 100)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <ColumnTotal label="total saídas" value={total} tone="out" />
    </div>
  );
}

function GuardadoColumn({ guardado, total, monthLabel }: { guardado: DreLine[]; total: number; monthLabel: string }) {
  const mesCurto = monthLabel.split(' de ')[0];
  return (
    <div>
      <div className="mb-3.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-lifeone-ink-3">o que você guardou</div>
      {guardado.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-lifeone-hairline bg-lifeone-surface px-4 py-6 text-center text-[12.5px] leading-relaxed text-lifeone-ink-3">
          <DreIcon name="piggy-bank" className="mx-auto mb-2 h-6 w-6 text-lifeone-ink-4" />
          Nada reservado em {mesCurto}.<br />
          Todo o excedente ficou <b className="text-lifeone-ink-2">livre</b> no resultado.
        </div>
      ) : (
        guardado.map((line, i) => (
          <div key={`${line.label}-${i}`} className={`flex items-center gap-3 py-2.5 ${i > 0 ? 'border-t border-lifeone-hairline-3' : ''}`}>
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px]" style={{ background: SEM.save.tint, color: SEM.save.ink }}>
              <DreIcon name="piggy-bank" className="h-3.5 w-3.5" />
            </span>
            <span className="flex-1 truncate text-[13.5px] font-medium text-lifeone-ink">{line.label}</span>
            <span className="text-[13.5px] font-bold tabular-nums" style={{ color: SEM.save.ink }}>
              {formatCurrency(line.valor / 100)}
            </span>
          </div>
        ))
      )}
      <ColumnTotal label="total guardado" value={total} tone="save" />
    </div>
  );
}

function ColumnTotal({ label, value, tone }: { label: string; value: number; tone: 'in' | 'out' | 'save' }) {
  const sem = SEM[tone];
  return (
    <div
      className="mt-3.5 flex items-center justify-between rounded-xl px-3.5 py-3 text-[13px] font-bold"
      style={{ background: sem.tint, color: sem.ink }}
    >
      <span>{label}</span>
      <span className="tabular-nums">{formatCurrency(value / 100)}</span>
    </div>
  );
}
