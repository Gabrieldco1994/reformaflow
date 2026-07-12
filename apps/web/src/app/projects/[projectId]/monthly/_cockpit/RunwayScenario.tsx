'use client';

import { useState } from 'react';
import { applyScenario } from '../_lib/scenarios';
import { ProjecaoSaldo } from '../../conta/_components/ProjecaoSaldo';
import type { DreSaldoAcumuladoRow } from '../../dre/_types';

/**
 * "Vai dar até dez?" com valor livre — versão desktop do "E se...?" da Trilha 1.
 * Deforma client-side a série de runway (mesmo contrato `applyScenario` usado
 * no mobile), mantendo o mês corrente (índice 0) como âncora imutável, e
 * renderiza a mesma `ProjecaoSaldo` da Visão Conta, inalterada, com a série
 * deformada — sem recalcular nada novo, sem tocar `derive.ts`.
 *
 * `DreSaldoAcumuladoRow` já satisfaz `ScenarioPoint` (`mes`/`saldoProjetado`)
 * diretamente — sem normalização de campos.
 */
export function RunwayScenario({
  serie,
  currentMonth,
}: {
  serie: DreSaldoAcumuladoRow[];
  currentMonth: string;
}) {
  const [deltaReais, setDeltaReais] = useState('');

  // Mesmo filtro que `ProjecaoSaldo` aplica internamente: garante que o
  // índice 0 do array deformado seja o mês corrente, nunca um mês passado.
  const forward = serie.filter((row) => row.mes >= currentMonth);
  const deltaCentsPerMonth = -Math.round((Number(deltaReais) || 0) * 100);

  const deformedSerie = applyScenario(forward, deltaCentsPerMonth);

  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-[var(--ck-border)] bg-[var(--ck-surface)] p-3">
        <label
          htmlFor="runway-scenario-delta"
          className="flex flex-col gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--ck-muted)]"
        >
          E se eu gastar quanto a mais por mês?
          <input
            id="runway-scenario-delta"
            type="number"
            inputMode="decimal"
            step="50"
            value={deltaReais}
            onChange={(e) => setDeltaReais(e.target.value)}
            placeholder="0"
            className="min-h-[44px] rounded-lg border border-[var(--ck-border)] bg-[var(--ck-surface-2)] px-2.5 text-[15px] font-normal normal-case tracking-normal text-[var(--ck-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--ck-accent)]"
          />
        </label>
        <p className="mt-1.5 text-[11px] text-[var(--ck-muted)]">
          Valor positivo = gasto extra por mês; negativo = economia por mês.
        </p>
      </div>
      <ProjecaoSaldo serie={deformedSerie} currentMonth={currentMonth} />
    </div>
  );
}
