"use client";

import { CreditCard, TrendingDown, TrendingUp } from "lucide-react";
import { fmtMoney, fmtPct, mesCurto } from "./format";
import type { MariaInsight } from "../_lib/insights";

/**
 * Stories "Maria percebeu" (inovação #6). Renderiza insights JÁ calculados
 * por regra pura (`buildMariaStories`) — nenhuma chamada de IA nesta fase.
 * Mapa exaustivo por `kind`, nunca title-case de enum cru.
 */
const KIND_PRESENTATION: Record<
  MariaInsight["kind"],
  { label: string; tone: string; Icon: typeof TrendingUp }
> = {
  "categoria-alta": {
    label: "Gasto acima da média",
    tone: "text-[var(--ck-neg)]",
    Icon: TrendingUp,
  },
  "categoria-economia": {
    label: "Economia notada",
    tone: "text-[var(--ck-pos)]",
    Icon: TrendingDown,
  },
  "parcela-fim": {
    label: "Parcela termina",
    tone: "text-[var(--ck-accent)]",
    Icon: CreditCard,
  },
};

function cardTitle(insight: MariaInsight): string {
  switch (insight.kind) {
    case "categoria-alta":
    case "categoria-economia":
      return insight.categoria;
    case "parcela-fim":
      return insight.descricao;
  }
}

function cardDetail(insight: MariaInsight): string {
  switch (insight.kind) {
    case "categoria-alta":
    case "categoria-economia": {
      // Acima de 3× a média, o percentual vira ruído ("2113%") — troca por
      // múltiplo legível; abaixo disso o % continua sendo a leitura natural.
      const ratio = Math.abs(insight.deltaPct);
      const delta =
        ratio >= 3
          ? `${(ratio + 1).toFixed(0)}× a média`
          : `${fmtPct(ratio * 100)} vs. média`;
      return `${fmtMoney(insight.valorMes)} · ${delta} de ${fmtMoney(insight.valorMedia)}`;
    }
    case "parcela-fim": {
      const [, month] = insight.mes.split("-");
      const monthIndex = Number.parseInt(month ?? "1", 10) - 1;
      return `${fmtMoney(insight.valorLiberado)} livres a partir de ${mesCurto(monthIndex)}`;
    }
  }
}

export default function MariaStories({
  insights,
}: {
  insights: MariaInsight[];
}) {
  return (
    <section
      aria-label="Maria percebeu"
      className="minimal-card rounded-[18px] border border-[var(--ck-border)] bg-[var(--ck-surface)] p-4 shadow-lifeone-card"
    >
      <h2 className="text-base font-semibold text-[var(--ck-text)]">
        Maria percebeu
      </h2>

      {insights.length === 0 ? (
        <p className="mt-2 text-sm text-[var(--ck-muted)]">
          Nada fora do padrão este mês.
        </p>
      ) : (
        <div className="mt-3 flex gap-3 overflow-x-auto pb-1">
          {insights.map((insight, index) => {
            const presentation = KIND_PRESENTATION[insight.kind];
            const title = cardTitle(insight);
            return (
              <article
                key={`${insight.kind}-${index}`}
                role="article"
                aria-label={`${presentation.label}: ${title}`}
                data-kind={insight.kind}
                className="min-h-[44px] w-56 shrink-0 rounded-2xl border border-[var(--ck-border)] bg-[var(--ck-surface-2)] p-3"
              >
                <div className="flex items-center gap-1.5">
                  <presentation.Icon
                    className={`h-4 w-4 shrink-0 ${presentation.tone}`}
                  />
                  <p className="text-sm font-medium text-[var(--ck-muted)]">
                    {presentation.label}
                  </p>
                </div>
                <p className="mt-1 text-base font-semibold text-[var(--ck-text)]">
                  {title}
                </p>
                <p className="mt-1 text-sm text-[var(--ck-muted)]">
                  {cardDetail(insight)}
                </p>
                <a
                  href="#"
                  className="mt-2 flex min-h-[44px] items-center text-sm font-semibold text-[var(--ck-accent)]"
                >
                  Ver detalhes
                </a>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
