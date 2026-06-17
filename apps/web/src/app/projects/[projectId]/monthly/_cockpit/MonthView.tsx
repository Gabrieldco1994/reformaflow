'use client';

import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { Wallet, ArrowUpCircle, ArrowDownCircle, Target, SlidersHorizontal } from 'lucide-react';
import type { MonthlyOverviewResponse, MonthlyEntry } from '../_types';
import { KpiCard, Card } from './ui';
import { fmtMoney } from './format';
import { deriveMonth, buildSaldoSeries, saldoProjetado, buildComprometimentoFuturo } from './derive';
import Recomendacoes from './Recomendacoes';
import CategoriasBarras from './CategoriasBarras';
import SaudeFinanceira from './SaudeFinanceira';
import ComprometimentoFuturo from './ComprometimentoFuturo';

const SaldoMesChart = dynamic(() => import('./SaldoMesChart'), {
  ssr: false,
  loading: () => <div className="h-[280px] rounded-xl bg-[var(--ck-surface-2)] animate-pulse" />,
});

export default function MonthView({
  data,
  monthKey,
  entries,
}: {
  data: MonthlyOverviewResponse;
  monthKey?: string;
  entries?: MonthlyEntry[];
}) {
  const m = useMemo(() => deriveMonth(data, monthKey ?? data.mesAtual, entries), [data, monthKey, entries]);
  const [ritmo, setRitmo] = useState<number>(m.ritmoDiario);

  const serieEntries = entries ?? data.mesAtualEntries;
  const serie = useMemo(() => buildSaldoSeries(m, serieEntries, ritmo), [m, serieEntries, ritmo]);
  const projetado = useMemo(() => saldoProjetado(m, ritmo), [m, ritmo]);
  const comprometimento = useMemo(
    () => buildComprometimentoFuturo(data, monthKey ?? data.mesAtual, 12),
    [data, monthKey],
  );

  const projTone = projetado >= m.saldoInicial ? 'pos' : 'neg';
  const maxRitmo = Math.max(m.ritmoDiario * 3, 30000); // teto do slider (centavos/dia)

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label={m.caixaReal ? 'Caixa na conta' : 'Saldo atual'}
          value={fmtMoney(m.saldoAtual)}
          tone={m.saldoAtual >= 0 ? 'accent' : 'neg'}
          icon={<Wallet className="w-4 h-4" />}
          context={m.caixaReal
            ? `Reconciliado com o banco · começou o mês com ${fmtMoney(m.saldoInicial)}`
            : `Começou o mês com ${fmtMoney(m.saldoInicial)}`}
        />
        <KpiCard
          label="Gastei no mês"
          value={fmtMoney(m.gasteiRealizado)}
          tone="neg"
          icon={<ArrowDownCircle className="w-4 h-4" />}
          context={m.gasteiPlanejado > 0 ? `+ ${fmtMoney(m.gasteiPlanejado)} planejado` : 'só pagamentos efetivados'}
        />
        <KpiCard
          label="Entrou no mês"
          value={fmtMoney(m.entrouRealizado)}
          tone="pos"
          icon={<ArrowUpCircle className="w-4 h-4" />}
          context={m.entrouPrevisto > 0 ? `+ ${fmtMoney(m.entrouPrevisto)} previsto` : 'recebimentos efetivados'}
        />
        <KpiCard
          label="Saldo projetado (fim do mês)"
          value={fmtMoney(projetado)}
          tone={projTone}
          icon={<Target className="w-4 h-4" />}
          context={`no ritmo de ${fmtMoney(ritmo)}/dia`}
        />
      </div>

      <Card
        title={m.caixaReal ? 'Fluxo de caixa do mês' : 'Saldo ao longo do mês'}
        hint={m.caixaReal
          ? `começa no caixa real · inclui cartão (ainda não debitado)`
          : `dia ${m.hoje} de ${m.diasNoMes}`}
      >
        <SaldoMesChart serie={serie} hoje={m.hoje} />
        <div className="mt-4 rounded-xl border border-[var(--ck-border)] bg-[var(--ck-surface-2)] p-3">
          <div className="flex items-center justify-between gap-2 mb-2">
            <label className="text-[11px] uppercase tracking-wider text-[var(--ck-muted)] flex items-center gap-1.5">
              <SlidersHorizontal className="w-3.5 h-3.5" />
              Ritmo de gasto diário
            </label>
            <span className="text-sm font-mono tabular-nums text-[var(--ck-alert)]">{fmtMoney(ritmo)}/dia</span>
          </div>
          <input
            type="range"
            min={0}
            max={maxRitmo}
            step={500}
            value={Math.min(ritmo, maxRitmo)}
            onChange={(e) => setRitmo(Number(e.target.value))}
            className="w-full accent-[var(--ck-alert)]"
          />
          <div className="flex justify-between text-[10px] text-[var(--ck-muted)] mt-1">
            <span>R$ 0</span>
            <button
              type="button"
              onClick={() => setRitmo(m.ritmoDiario)}
              className="underline hover:text-[var(--ck-text)] transition-colors"
            >
              média atual ({fmtMoney(m.ritmoDiario)})
            </button>
            <span>{fmtMoney(maxRitmo)}</span>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Recomendacoes m={m} saldoProjetadoVal={projetado} />
        <div className="space-y-4">
          <ComprometimentoFuturo rows={comprometimento} />
          <CategoriasBarras categorias={m.categorias} hint="mês atual" />
          <SaudeFinanceira m={m} />
        </div>
      </div>
    </div>
  );
}
