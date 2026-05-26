'use client';

import Link from 'next/link';
import { ChevronRight, Home, Car, Hammer, ShoppingBag, User } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';
import { getProjectBadgeColor, getProjectProgressColor } from '@/lib/project-colors';
import { PROJECT_TYPE_LABELS, type ProjectBreakdownRow, type ProjectType } from '../_types';

const ICONS: Record<ProjectType, typeof Home> = {
  CASA: Home,
  CARRO: Car,
  REFORMA: Hammer,
  COMPRA: ShoppingBag,
  PESSOAL: User,
};

export function ProjectsBreakdown({ rows }: { rows: ProjectBreakdownRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-6 text-center text-darc-velvet/60">
        Nenhum projeto encontrado.
      </div>
    );
  }

  return (
    <section className="rounded-2xl bg-white shadow-darc-soft border border-darc-linen p-4 md:p-5">
      <h2 className="font-editorial italic text-lg md:text-xl text-darc-velvet mb-4">Projetos</h2>
      <div className="space-y-2">
        {rows.map((p) => {
          const Icon = ICONS[p.type] ?? Home;
          const badgeColor = getProjectBadgeColor(p.type);
          const progressColor = getProjectProgressColor(p.type);
          const pct = Math.round(p.progresso * 100);
          return (
            <Link
              key={p.projectId}
              href={`/projects/${p.projectId}/dashboard`}
              className="flex items-center gap-3 p-3 rounded-xl hover:bg-darc-linen/40 transition-colors border border-transparent hover:border-darc-linen group"
            >
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${badgeColor}`}>
                <Icon className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2">
                  <p className="font-medium text-darc-velvet truncate">{p.name}</p>
                  <span className="text-[10px] tracking-[0.18em] uppercase text-darc-velvet/50">{PROJECT_TYPE_LABELS[p.type]}</span>
                </div>
                <div className="mt-1 flex items-center gap-3 text-xs">
                  <span className="text-darc-velvet/70">Pago: <strong className="text-darc-raspberry">{formatCurrency(p.gastoTotal / 100)}</strong></span>
                  {p.planejadoRestante > 0 && (
                    <span className="text-darc-velvet/70">Planejado: <strong>{formatCurrency(p.planejadoRestante / 100)}</strong></span>
                  )}
                  <span className="text-darc-velvet/40">·</span>
                  <span className="text-darc-velvet/70">{pct}%</span>
                </div>
                <div className="mt-2 h-1.5 bg-darc-linen rounded-full overflow-hidden">
                  <div className={progressColor} style={{ width: `${pct}%` }} />
                </div>
              </div>
              <ChevronRight className="w-5 h-5 text-darc-velvet/30 flex-shrink-0 group-hover:text-darc-velvet/60 transition-colors" />
            </Link>
          );
        })}
      </div>
    </section>
  );
}
