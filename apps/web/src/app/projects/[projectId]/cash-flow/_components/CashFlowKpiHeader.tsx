'use client';

import { KpiTile } from '@/components/KpiTile';
import { moneyGlance } from '@/lib/money';
import type { CashFlowEntry } from '@/types';

type CashFlowKpiEntry = Pick<CashFlowEntry, 'tipo' | 'valor' | 'rollingBalance' | 'rollingBalanceRealizado'>;

type Props = {
  entries: CashFlowKpiEntry[];
  /** PESSOAL ⇒ headline é o caixa real do §10 (mesma fonte de /conta e /monthly). */
  isPessoal?: boolean;
  /** Caixa real hoje (§10 caixaHoje). Só usado quando isPessoal. */
  caixaReal?: number | null;
};

export function CashFlowKpiHeader({ entries, isPessoal = false, caixaReal = null }: Props) {
  const last = entries.at(-1);
  const saldoProjetado = last?.rollingBalance ?? 0;
  const saldoRealizado = last?.rollingBalanceRealizado ?? 0;
  const entradas = entries
    .filter((entry) => entry.tipo === 'RECEBIMENTO')
    .reduce((sum, entry) => sum + entry.valor, 0);
  const saidas = entries
    .filter((entry) => entry.tipo === 'DESPESA')
    .reduce((sum, entry) => sum + entry.valor, 0);

  // PESSOAL: o número da verdade é o caixa real do §10 (idêntico a /conta e /monthly).
  // Os rolling* daqui são somas desde zero e NÃO representam o saldo bancário.
  if (isPessoal) {
    // caixaReal null ⇒ §10 ainda carregando (para PESSOAL é sempre um número quando
    // resolve). Mostra "—" em vez de "R$ 0" para não exibir um saldo enganoso no flash.
    const carregando = caixaReal === null;
    const saldoConta = caixaReal ?? 0;
    return (
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div role="article" aria-label="Saldo em conta" className="min-w-0">
          <KpiTile
            variant="support"
            layer="glance"
            tone={carregando ? 'neutral' : saldoConta >= 0 ? 'positive' : 'negative'}
            label="Saldo em conta"
            info="Dinheiro disponível de verdade na conta hoje (§10), reconciliado — mesma fonte da Visão Conta e da Visão Geral."
            value={carregando ? '—' : moneyGlance(saldoConta)}
          />
        </div>
        <div role="article" aria-label="Entradas" className="min-w-0">
          <KpiTile variant="support" layer="glance" tone="positive" label="Entradas" value={moneyGlance(entradas)} />
        </div>
        <div role="article" aria-label="Saídas" className="min-w-0">
          <KpiTile variant="support" layer="glance" tone="negative" label="Saídas" value={moneyGlance(saidas)} />
        </div>
      </div>
    );
  }

  // Não-PESSOAL: fluxo orçamentário acumulado (desde zero). Rótulos evitam "saldo"
  // para não sugerir saldo bancário.
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
      <div role="article" aria-label="Fluxo projetado" className="min-w-0">
        <KpiTile
          variant="support"
          layer="glance"
          tone={saldoProjetado >= 0 ? 'neutral' : 'negative'}
          label="Fluxo projetado"
          info="Acumulado orçamentário desde zero, incluindo planejados e previstos. Não é saldo bancário."
          value={moneyGlance(saldoProjetado)}
        />
      </div>
      <div role="article" aria-label="Fluxo realizado" className="min-w-0">
        <KpiTile
          variant="support"
          layer="glance"
          tone={saldoRealizado >= 0 ? 'positive' : 'negative'}
          label="Fluxo realizado"
          info="Acumulado orçamentário desde zero, apenas PAGO e EM_CAIXA. Não é saldo bancário."
          value={moneyGlance(saldoRealizado)}
        />
      </div>
      <div role="article" aria-label="Entradas" className="min-w-0">
        <KpiTile variant="support" layer="glance" tone="positive" label="Entradas" value={moneyGlance(entradas)} />
      </div>
      <div role="article" aria-label="Saídas" className="min-w-0">
        <KpiTile variant="support" layer="glance" tone="negative" label="Saídas" value={moneyGlance(saidas)} />
      </div>
    </div>
  );
}
