'use client';

import Link from 'next/link';
import { formatCurrency } from '@/lib/utils';
import type { SupplierRow } from '../_types';

export function TopSuppliers({ rows }: { rows: SupplierRow[] }) {
  if (rows.length === 0) {
    return (
      <section className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
        <h3 className="font-editorial italic text-base md:text-lg text-darc-velvet mb-2">Top fornecedores</h3>
        <p className="text-sm text-darc-velvet/60">Sem dados de fornecedor.</p>
      </section>
    );
  }
  const max = rows[0].total;
  return (
    <section className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
      <h3 className="font-editorial italic text-base md:text-lg text-darc-velvet mb-3">Top fornecedores</h3>
      <ul className="space-y-2">
        {rows.map((r) => {
          const pct = max > 0 ? (r.total / max) * 100 : 0;
          return (
            <li key={r.fornecedor} className="text-sm">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium text-darc-velvet truncate">{r.fornecedor}</span>
                <span className="text-darc-raspberry font-semibold whitespace-nowrap">{formatCurrency(r.total / 100)}</span>
              </div>
              <div className="mt-1 h-1.5 bg-darc-linen rounded-full overflow-hidden">
                <div className="h-full bg-darc-raspberry" style={{ width: `${pct}%` }} />
              </div>
              <div className="mt-1 flex items-center gap-1 text-[11px] text-darc-velvet/60">
                <span>{r.count} {r.count === 1 ? 'despesa' : 'despesas'}</span>
                <span className="text-darc-velvet/30">·</span>
                <span className="flex flex-wrap gap-1">
                  {r.projetos.map((p) => (
                    <Link
                      key={p.projectId}
                      href={`/projects/${p.projectId}/dashboard`}
                      className="text-darc-velvet/70 hover:underline"
                    >
                      {p.projectName}
                    </Link>
                  ))}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
