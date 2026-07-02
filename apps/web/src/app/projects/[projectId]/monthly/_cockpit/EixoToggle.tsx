'use client';

import { List } from 'lucide-react';

export type Eixo = 'competencia' | 'caixa' | 'geral';

const AXES: { key: Eixo; label: string; hint: string }[] = [
  { key: 'competencia', label: 'Gastei', hint: 'quando você comprou (competência)' },
  { key: 'caixa', label: 'Vai sair', hint: 'quando o dinheiro sai (vencimento da fatura do cartão)' },
];

/**
 * Controle do eixo de tempo do cockpit. Dois eixos de tempo (Gastei × Vai sair)
 * num segmented control, mais um botão separado "Extrato" — que não é um eixo,
 * e sim outra visão (lista cronológica de tudo que saiu no mês).
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
      <div
        role="group"
        aria-label="Eixo de tempo"
        className="inline-flex rounded-xl border border-[var(--ck-border)] bg-[var(--ck-surface-2)] p-1"
      >
        {AXES.map((o) => (
          <button
            key={o.key}
            type="button"
            title={o.hint}
            aria-pressed={eixo === o.key}
            onClick={() => onChange(o.key)}
            className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
              eixo === o.key
                ? 'bg-[var(--ck-accent)] text-[#FFFFFF]'
                : 'text-[var(--ck-muted)] hover:text-[var(--ck-text)]'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>

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
