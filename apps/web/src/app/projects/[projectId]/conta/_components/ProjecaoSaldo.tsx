'use client';

import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import { moneyGlance } from '@/lib/money';
import { tipoLabel } from '@/lib/expense-options';
import { InfoHint } from '@/components/InfoHint';
import { monthLabelShort, monthLabelLong } from '../_lib';
import type { DreSaldoAcumuladoRow } from '../../dre/_types';

function compactBRL(cents: number) {
  const reais = cents / 100;
  const abs = Math.abs(reais);
  if (abs >= 1000) return `${(reais / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}k`;
  return reais.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
}

function categoriaLabel(key: string) {
  if (key === '__fatura__') return 'Fatura de cartão';
  if (key === '__sem__') return 'Sem categoria';
  return tipoLabel(key);
}

type Categoria = { label: string; valor: number };
type ChartPoint = { mes: string; label: string; saldo: number; negativo: boolean; categorias: Categoria[] };

function SaldoTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: ChartPoint }> }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const totalCat = p.categorias.reduce((s, c) => s + c.valor, 0);
  return (
    <div className="min-w-[200px] rounded-xl border border-lifeone-hairline bg-lifeone-card px-3 py-2.5 text-xs shadow-lifeone-card">
      <p className="font-semibold text-lifeone-ink">{monthLabelLong(p.mes)}</p>
      <p className={p.negativo ? 'text-[#D92D20]' : 'text-[#1E924A]'}>
        saldo projetado · {formatCurrency(p.saldo / 100)}
      </p>
      {p.categorias.length > 0 && (
        <div className="mt-2 border-t border-lifeone-hairline pt-2">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-lifeone-ink-3">
            Saídas por categoria
          </p>
          <ul className="space-y-0.5">
            {p.categorias.map((c) => (
              <li key={c.label} className="flex items-center justify-between gap-4">
                <span className="truncate text-lifeone-ink-2">{c.label}</span>
                <span className="shrink-0 tabular-nums font-medium text-lifeone-ink">
                  {formatCurrency(c.valor / 100)}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-1 flex items-center justify-between gap-4 border-t border-lifeone-hairline pt-1">
            <span className="text-lifeone-ink-3">Total saídas</span>
            <span className="shrink-0 tabular-nums font-semibold text-lifeone-ink">
              {formatCurrency(totalCat / 100)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Runway de caixa: encadeia o saldo real de hoje mês a mês (saldo anterior +
 * receitas previstas − contas a pagar), reaproveitando a série já reconciliada
 * do `dre-overview` (eixo caixa §10: inclui parcelas cross-project, ignora
 * neutros/faturas já contadas). Diferente do card "Sobra prevista", que reseta
 * para o caixa de hoje a cada mês, aqui o saldo CARREGA de um mês para o outro —
 * é a visão que responde "vou ter dinheiro até dezembro?".
 */
export function ProjecaoSaldo({
  serie,
  currentMonth,
}: {
  serie: DreSaldoAcumuladoRow[];
  currentMonth: string;
}) {
  const forward = serie.filter((row) => row.mes >= currentMonth);
  if (forward.length < 2) return null;

  const chartData: ChartPoint[] = forward.map((row) => ({
    mes: row.mes,
    label: monthLabelShort(row.mes),
    saldo: row.saldoProjetado,
    negativo: row.saldoProjetado < 0,
    categorias: Object.entries(row.despesasPorCategoria ?? {})
      .map(([key, valor]) => ({ label: categoriaLabel(key), valor }))
      .sort((a, b) => b.valor - a.valor),
  }));

  const crossover = forward.find((row) => row.saldoProjetado < 0) ?? null;
  const lowest = forward.reduce((min, row) => (row.saldoProjetado < min.saldoProjetado ? row : min), forward[0]);
  const last = forward[forward.length - 1];

  return (
    <section className="rounded-3xl border border-lifeone-hairline bg-lifeone-card p-4 shadow-lifeone-card xl:p-6">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-lifeone-ink-3">
          Vai dar até {monthLabelShort(last.mes)}?
          <InfoHint
            text="Projeção do saldo real da conta, mês a mês: parte do que você tem hoje e vai descontando as contas a pagar e somando as receitas previstas, CARREGANDO o saldo de um mês para o outro. Inclui parcelas de outros projetos pagas por esta conta; ignora transferências internas e faturas já contadas nas compras."
            className="text-lifeone-ink-3"
          />
        </p>
      </div>

      {crossover ? (
        <div className="mt-3 flex items-start gap-2.5 rounded-2xl border border-[#F2C6C1] bg-[#FCEBE9] px-3.5 py-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[#D92D20]" />
          <div className="leading-snug">
            <p className="text-sm font-bold text-[#D92D20]">
              No ritmo atual, o saldo fica negativo em {monthLabelLong(crossover.mes)}.
            </p>
            <p className="mt-0.5 text-xs text-[#B5803A]">
              Pior ponto: <span className="font-semibold">{formatCurrency(lowest.saldoProjetado / 100)}</span> em{' '}
              {monthLabelLong(lowest.mes)} — é o quanto precisa entrar a mais (ou deixar de gastar) até lá.
            </p>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex items-start gap-2.5 rounded-2xl border border-[#BFE6CC] bg-[#E3F6EA] px-3.5 py-3">
          <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-[#1E924A]" />
          <div className="leading-snug">
            <p className="text-sm font-bold text-[#1E924A]">
              O saldo se mantém positivo até {monthLabelLong(last.mes)}.
            </p>
            <p className="mt-0.5 text-xs text-lifeone-ink-3">
              Menor ponto: <span className="font-semibold">{formatCurrency(lowest.saldoProjetado / 100)}</span> em{' '}
              {monthLabelLong(lowest.mes)}.
            </p>
          </div>
        </div>
      )}

      <div className="mt-4 h-56">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
            <defs>
              <linearGradient id="saldoPos" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#1E924A" stopOpacity={0.28} />
                <stop offset="100%" stopColor="#1E924A" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#EDE8DF" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#8A857C' }} axisLine={false} tickLine={false} />
            <YAxis
              tick={{ fontSize: 11, fill: '#8A857C' }}
              axisLine={false}
              tickLine={false}
              width={46}
              tickFormatter={(v: number) => compactBRL(v)}
            />
            <ReferenceLine y={0} stroke="#D92D20" strokeWidth={1} strokeDasharray="4 3" />
            <Tooltip content={<SaldoTooltip />} />
            <Area
              type="monotone"
              dataKey="saldo"
              stroke="#0F6B4D"
              strokeWidth={2.5}
              fill="url(#saldoPos)"
              dot={{ r: 3, fill: '#0F6B4D' }}
              activeDot={{ r: 5 }}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4 xl:grid-cols-6">
        {chartData.map((point) => (
          <div
            key={point.mes}
            className={`rounded-xl border px-2.5 py-2 text-center ${
              point.negativo ? 'border-[#F2C6C1] bg-[#FCEBE9]' : 'border-lifeone-hairline bg-lifeone-surface'
            }`}
          >
            <p className="text-[10px] font-semibold uppercase tracking-wide text-lifeone-ink-3">{point.label}</p>
            <p
              title={formatCurrency(point.saldo / 100)}
              className={`mt-0.5 whitespace-nowrap text-xs font-bold tabular-nums ${
                point.negativo ? 'text-[#D92D20]' : 'text-lifeone-ink'
              }`}
            >
              {/* sem o prefixo "R$": pill de ~66px no rail não comporta "−R$ 495 mil" */}
              {moneyGlance(point.saldo).replace('R$ ', '')}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
