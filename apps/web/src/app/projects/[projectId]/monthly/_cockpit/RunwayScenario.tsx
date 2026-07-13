'use client';

import { ProjecaoSaldo } from '../../conta/_components/ProjecaoSaldo';
import type { DreSaldoAcumuladoRow } from '../../dre/_types';

/**
 * Wrapper desktop para "Vai dar até dez?": reaproveita a ProjecaoSaldo canônica
 * da Visão Conta sem o simulador "E se...".
 */
export function RunwayScenario({
  serie,
  currentMonth,
}: {
  serie: DreSaldoAcumuladoRow[];
  currentMonth: string;
}) {
  return <ProjecaoSaldo serie={serie} currentMonth={currentMonth} />;
}
