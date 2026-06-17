'use client';

export type Eixo = 'competencia' | 'caixa' | 'geral';

const OPTS: { key: Eixo; label: string; hint: string }[] = [
  { key: 'competencia', label: 'Gastei', hint: 'quando você comprou (competência)' },
  { key: 'caixa', label: 'Vai sair', hint: 'quando o dinheiro sai (vencimento da fatura do cartão)' },
  { key: 'geral', label: 'Geral', hint: 'extrato: todas as saídas do mês em ordem de data' },
];

/** Segmented control do eixo de tempo do cockpit: competência × caixa × extrato. */
export default function EixoToggle({
  eixo,
  onChange,
}: {
  eixo: Eixo;
  onChange: (e: Eixo) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Eixo de tempo"
      className="inline-flex rounded-xl border border-[var(--ck-border)] bg-[var(--ck-surface-2)] p-1"
    >
      {OPTS.map((o) => (
        <button
          key={o.key}
          type="button"
          title={o.hint}
          aria-pressed={eixo === o.key}
          onClick={() => onChange(o.key)}
          className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
            eixo === o.key
              ? 'bg-[var(--ck-accent)] text-[#06121a]'
              : 'text-[var(--ck-muted)] hover:text-[var(--ck-text)]'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
