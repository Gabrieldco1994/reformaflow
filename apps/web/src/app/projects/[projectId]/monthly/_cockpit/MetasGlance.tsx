'use client';

import Link from 'next/link';
import { Target } from 'lucide-react';
import { tipoLabel } from '@/lib/expense-options';
import { metaProgressTone } from '../../metas/_lib/metaTone';
import { Card } from './ui';
import type { MetaProgress } from '../../metas/_components/MetaCategoriaCard';

const MAX_VISIVEIS = 4;

/**
 * Resumo "de relance" de metas por categoria na coluna principal do cockpit
 * desktop: até 4 categorias com o tom compartilhado (`metaProgressTone`,
 * mesmo helper usado em `MetaCategoriaCard`) + link para a tela completa.
 * Conjunto vazio tem call-to-action explícito — nunca um grid em branco.
 */
export function MetasGlance({ progress, projectId }: { progress: MetaProgress[]; projectId: string }) {
  if (progress.length === 0) {
    return (
      <Card title="Metas do mês">
        <div className="flex flex-col items-center gap-2 py-3 text-center">
          <Target className="h-5 w-5 text-[var(--ck-muted)]" />
          <p className="text-xs text-[var(--ck-muted)]">Nenhuma meta definida ainda para este mês.</p>
          <Link
            href={`/projects/${projectId}/metas`}
            className="text-xs font-semibold text-[var(--ck-accent)] hover:underline"
          >
            Criar metas
          </Link>
        </div>
      </Card>
    );
  }

  const visiveis = progress.slice(0, MAX_VISIVEIS);
  const restante = progress.length - visiveis.length;

  return (
    <Card title="Metas do mês">
      <ul className="space-y-2">
        {visiveis.map((item) => {
          const t = metaProgressTone(item.pct);
          return (
            <li key={item.tipoDespesa} className="flex items-center justify-between gap-2 text-xs">
              <span className="min-w-0 truncate text-[var(--ck-text)]">{tipoLabel(item.tipoDespesa)}</span>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${t.txt} bg-[var(--ck-surface-2)]`}>
                {item.pct}% · {t.label}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="mt-3 flex items-center justify-between gap-2">
        {restante > 0 ? (
          <span className="text-[11px] text-[var(--ck-muted)]">+{restante}</span>
        ) : (
          <span />
        )}
        <Link
          href={`/projects/${projectId}/metas`}
          className="text-xs font-semibold text-[var(--ck-accent)] hover:underline"
        >
          Ver metas
        </Link>
      </div>
    </Card>
  );
}
