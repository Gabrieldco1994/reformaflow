"use client";

/**
 * Mini-hero capsule (inovação #5): faixa condensada FIXA no topo que carrega o
 * número canônico do MÊS ATUAL — leitura de relance enquanto o usuário navega o
 * cockpit, nunca uma segunda fonte de verdade. Dois modos, decididos pelo pai:
 * - mês corrente: aparece por rolagem (`visible` dirigido por scroll);
 * - outro mês: fica SEMPRE visível e acrescenta o aviso "consultando <mês>"
 *   (absorve o papel da antiga aside "Resumo do mês atual", agora removida).
 * Puramente apresentacional: só decide o que renderizar a partir dos props.
 */
export default function MiniHeroCapsule({
  visible,
  value,
  label = "Caixa hoje",
  monthLabel,
  consultingLabel,
}: {
  visible: boolean;
  value: string;
  label?: string;
  /** Rótulo do mês atual (ex.: "Julho 2026"). */
  monthLabel?: string;
  /** Mês que o usuário está consultando, quando ≠ mês atual (ex.: "Junho 2026"). */
  consultingLabel?: string;
}) {
  return (
    <div
      role="status"
      aria-hidden={!visible}
      aria-label="Resumo rápido do caixa"
      data-testid="mini-hero-capsule"
      className={`pointer-events-none fixed inset-x-0 top-0 z-30 flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 border-b border-[var(--ck-border)] bg-[var(--ck-surface)]/95 px-4 py-2 shadow-lifeone-hover backdrop-blur transition-transform duration-200 ${
        visible ? "translate-y-0" : "-translate-y-full"
      }`}
    >
      {visible && (
        <>
          {monthLabel && (
            <span className="min-h-[44px] leading-[44px] text-sm font-semibold text-[var(--ck-text)]">
              {monthLabel}
            </span>
          )}
          <span className="text-sm font-medium text-[var(--ck-muted)]">
            {label}
          </span>
          <span className="font-geist text-base font-bold tabular-nums text-[var(--ck-text)]">
            {value}
          </span>
          {consultingLabel && (
            <span className="w-full text-center text-sm text-[var(--ck-muted)]">
              consultando {consultingLabel}
            </span>
          )}
        </>
      )}
    </div>
  );
}
