"use client";

/**
 * Mini-hero capsule (inovação #5): faixa condensada que aparece FIXA no topo
 * assim que o usuário rola para além do herói grande (`HeroTimeTravel`),
 * repetindo o MESMO número canônico já mostrado na aside inferior "Resumo do
 * mês atual" — não é uma segunda fonte de verdade, só uma leitura de relance
 * enquanto o usuário navega o cockpit. Puramente apresentacional: a detecção
 * de scroll (posição/threshold) vive no componente pai; esta cápsula só
 * decide o que renderizar a partir do prop `visible`.
 */
export default function MiniHeroCapsule({
  visible,
  value,
  label = "Caixa hoje",
}: {
  visible: boolean;
  value: string;
  label?: string;
}) {
  return (
    <div
      role="status"
      aria-hidden={!visible}
      aria-label="Resumo rápido do caixa"
      data-testid="mini-hero-capsule"
      className={`pointer-events-none fixed inset-x-0 top-0 z-30 flex items-center justify-center gap-2 border-b border-[var(--ck-border)] bg-[var(--ck-surface)]/95 px-4 py-2 shadow-lifeone-hover backdrop-blur transition-transform duration-200 ${
        visible ? "translate-y-0" : "-translate-y-full"
      }`}
    >
      {visible && (
        <>
          <span className="min-h-[44px] leading-[44px] text-sm font-medium text-[var(--ck-muted)]">
            {label}
          </span>
          <span className="font-geist text-base font-bold tabular-nums text-[var(--ck-text)]">
            {value}
          </span>
        </>
      )}
    </div>
  );
}
