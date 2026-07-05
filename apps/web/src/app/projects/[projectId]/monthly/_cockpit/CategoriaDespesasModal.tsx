'use client';

import { useMemo } from 'react';
import { CreditCard, Landmark } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import type { MonthlyEntry } from '../_types';
import { fmtMoneyExact, mesCurto } from './format';
import { despesasDaCategoriaAno } from './derive';

/**
 * Pop-up com as despesas consideradas para uma categoria no gráfico "Categorias
 * do ano". Já filtrado pela mesma base das barras (espelho/neutro fora) e pelo
 * modo Realizado / Realizado+planejado ativo no gráfico.
 */
export default function CategoriaDespesasModal({
  categoria,
  entries,
  year,
  statusMode,
  onClose,
}: {
  categoria: string | null;
  entries: MonthlyEntry[];
  year: number;
  statusMode: 'real' | 'realPlus';
  onClose: () => void;
}) {
  const itens = useMemo(
    () => (categoria ? despesasDaCategoriaAno(entries, year, categoria, statusMode) : []),
    [categoria, entries, year, statusMode],
  );
  const total = useMemo(() => itens.reduce((s, e) => s + e.valor, 0), [itens]);

  function dataCurta(iso: string): string {
    const dia = iso.slice(8, 10);
    const m0 = parseInt(iso.slice(5, 7), 10) - 1;
    return `${dia} ${mesCurto(m0)}`;
  }

  return (
    <Modal open={!!categoria} onClose={onClose} title={categoria ?? ''} size="lg" variant="auto">
      <div className="mb-4 flex items-baseline justify-between gap-2">
        <span className="text-xs text-gray-500">
          {itens.length} lançamento{itens.length === 1 ? '' : 's'} · {year} ·{' '}
          {statusMode === 'real' ? 'só pagas' : 'pagas + planejadas'}
        </span>
        <span className="font-geist tabular-nums text-lg font-bold text-gray-900">{fmtMoneyExact(total)}</span>
      </div>

      {itens.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-500">Nenhuma despesa nesta categoria.</p>
      ) : (
        <ul className="space-y-1.5">
          {itens.map((e) => (
            <li
              key={e.id}
              className="flex items-center gap-3 rounded-xl border border-gray-100 bg-gray-50 px-3 py-2"
            >
              <span className="w-12 shrink-0 text-[11px] font-geist tabular-nums text-gray-500">
                {dataCurta(e.data)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="truncate text-sm text-gray-900">
                    {e.subcategoria?.trim() || e.categoria || 'Despesa'}
                  </span>
                  {e.parcela && (
                    <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-geist tabular-nums text-gray-600">
                      {e.parcela}
                    </span>
                  )}
                  {e.projectType && e.projectType !== 'PESSOAL' && (
                    <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] text-gray-600">
                      {e.projectName || e.projectType}
                    </span>
                  )}
                </div>
                <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-gray-500">
                  {e.cardLast4 ? (
                    <><CreditCard className="w-3 h-3" /> cartão ••{e.cardLast4}</>
                  ) : (
                    <><Landmark className="w-3 h-3" /> conta/débito</>
                  )}
                </span>
              </div>
              <div className="shrink-0 text-right">
                <p className="font-geist tabular-nums text-sm font-semibold text-gray-900">
                  {fmtMoneyExact(e.valor)}
                </p>
                <p className="text-[10px] text-gray-400">
                  {e.status === 'PAGO' || e.status === 'EM_CAIXA' ? 'pago' : 'previsto'}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
