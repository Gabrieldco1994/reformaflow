'use client';

import Link from 'next/link';
import { formatCurrency, formatDateBR } from '@/lib/utils';
import { PROJECT_TYPE_LABELS, type UpcomingDueRow } from '../_types';

const TYPE_BADGE: Record<string, string> = {
  REFORMA: 'bg-orange-100 text-orange-700',
  CASA: 'bg-teal-100 text-teal-700',
  CARRO: 'bg-blue-100 text-blue-700',
  PESSOAL: 'bg-purple-100 text-purple-700',
  COMPRA: 'bg-pink-100 text-pink-700',
};

export function UpcomingTable({ rows }: { rows: UpcomingDueRow[] }) {
  if (rows.length === 0) {
    return (
      <section className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
        <h3 className="font-editorial italic text-base md:text-lg text-darc-velvet mb-2">Próximos vencimentos</h3>
        <p className="text-sm text-darc-velvet/60">Nenhum lançamento previsto.</p>
      </section>
    );
  }
  return (
    <section className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
      <h3 className="font-editorial italic text-base md:text-lg text-darc-velvet mb-3">Próximos vencimentos</h3>
      <div className="overflow-x-auto -mx-2">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[10px] tracking-[0.18em] uppercase text-darc-velvet/60 border-b border-darc-linen">
              <th className="px-2 py-2 font-medium">Data</th>
              <th className="px-2 py-2 font-medium">Projeto</th>
              <th className="px-2 py-2 font-medium">Descrição</th>
              <th className="px-2 py-2 font-medium text-right">Valor</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-darc-linen">
            {rows.map((r, i) => {
              const badge = TYPE_BADGE[r.projectType] ?? 'bg-gray-100 text-gray-700';
              const valorClass = r.tipo === 'DESPESA' ? 'text-darc-red' : 'text-emerald-700';
              return (
                <tr key={i} className="hover:bg-darc-linen/40">
                  <td className="px-2 py-2 text-darc-velvet whitespace-nowrap">{formatDateBR(r.data)}</td>
                  <td className="px-2 py-2">
                    <Link href={`/projects/${r.projectId}/dashboard`} className="inline-flex items-center gap-1.5">
                      <span className={`text-[10px] tracking-wider uppercase px-2 py-0.5 rounded-full font-medium ${badge}`}>
                        {PROJECT_TYPE_LABELS[r.projectType]}
                      </span>
                      <span className="text-xs text-darc-velvet/70 hover:underline">{r.projectName}</span>
                    </Link>
                  </td>
                  <td className="px-2 py-2 text-darc-velvet truncate max-w-[260px]">{r.descricao}</td>
                  <td className={`px-2 py-2 text-right font-semibold whitespace-nowrap ${valorClass}`}>
                    {r.tipo === 'DESPESA' ? '−' : '+'}{formatCurrency(r.valor / 100)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
