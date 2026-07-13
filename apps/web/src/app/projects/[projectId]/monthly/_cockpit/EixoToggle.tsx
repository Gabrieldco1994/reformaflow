'use client';

import { List } from 'lucide-react';

export type Eixo = 'competencia' | 'caixa' | 'geral';

/**
 * Controle do cockpit na visão mensal: alterna entre o eixo de caixa padrão e
 * a visão de extrato cronológico.
 */
export default function EixoToggle({
  eixo,
  onChange,
}: {
  eixo: Eixo;
  onChange: (e: Eixo) => void;
}) {
  const extratoAtivo = eixo === 'geral';
  return (
    <div className="flex shrink-0 items-center gap-2">
      <button
        type="button"
        aria-pressed={!extratoAtivo}
        onClick={() => onChange('caixa')}
        className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium transition-colors ${
          !extratoAtivo
            ? 'border-[var(--ck-accent)] bg-[var(--ck-accent)] text-[#FFFFFF]'
            : 'border-[var(--ck-border)] bg-[var(--ck-surface-2)] text-[var(--ck-muted)] hover:text-[var(--ck-text)]'
        }`}
      >
        Caixa
      </button>

      <button
        type="button"
        title="Extrato: todas as saídas do mês em ordem de data"
        aria-pressed={extratoAtivo}
        onClick={() => onChange(extratoAtivo ? 'competencia' : 'geral')}
        className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium transition-colors ${
          extratoAtivo
            ? 'border-[var(--ck-accent)] bg-[var(--ck-accent)] text-[#FFFFFF]'
            : 'border-[var(--ck-border)] bg-[var(--ck-surface-2)] text-[var(--ck-muted)] hover:text-[var(--ck-text)]'
        }`}
      >
        <List className="w-3.5 h-3.5" />
        Extrato
      </button>
    </div>
  );
}
