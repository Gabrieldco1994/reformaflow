'use client';

import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { moneyGlance } from '@/lib/money';
import { Card } from './ui';
import type { DreMensal } from '../../dre/_types';

/**
 * Resumo "de relance" do DRE do mês na coluna principal do cockpit desktop:
 * competência (regime de competência) e conta corrente (caixa) lado a lado,
 * com link para a tela completa de DRE. Só extrai campos já prontos de
 * `DreMensal` — nenhum cálculo novo, nenhuma query própria (o dado chega
 * pronto de `page.tsx`, que já busca `dre-overview` para o `RunwayScenario`).
 */
export function DreGlance({ data, projectId }: { data: DreMensal; projectId: string }) {
  const competenciaTone = data.resultado >= 0 ? 'text-[var(--ck-pos)]' : 'text-[var(--ck-neg)]';
  const contaTone = data.contaCorrente.sobraPrevista >= 0 ? 'text-[var(--ck-pos)]' : 'text-[var(--ck-neg)]';

  return (
    <Card title="DRE do mês" hint={data.mes}>
      <div className="grid grid-cols-2 gap-3">
        <article
          aria-label="Competência"
          className={`rounded-xl border border-[var(--ck-border)] bg-[var(--ck-surface-2)] p-3 ${competenciaTone}`}
        >
          <p className="text-[10px] uppercase tracking-wider text-[var(--ck-muted)]">Competência</p>
          <p className="mt-1 font-geist tabular-nums text-lg font-bold">{moneyGlance(data.resultado)}</p>
        </article>
        <article
          aria-label="Conta corrente"
          className={`rounded-xl border border-[var(--ck-border)] bg-[var(--ck-surface-2)] p-3 ${contaTone}`}
        >
          <p className="text-[10px] uppercase tracking-wider text-[var(--ck-muted)]">Conta corrente</p>
          <p className="mt-1 font-geist tabular-nums text-lg font-bold">
            {moneyGlance(data.contaCorrente.sobraPrevista)}
          </p>
        </article>
      </div>
      <Link
        href={`/projects/${projectId}/dre`}
        className="mt-3 flex items-center justify-end gap-1 text-xs font-semibold text-[var(--ck-accent)] hover:underline"
      >
        Ver DRE completo <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </Card>
  );
}
