"use client";

import { useState } from "react";
import { ArrowDownRight, ArrowUpRight, Target } from "lucide-react";
import { moneyDetail, moneyGlance } from "@/lib/money";
import type { CockpitTopDerived } from "./derive";

const HERO_STATE = {
  positive: {
    label: "Mês protegido",
    bar: "bg-[var(--ck-pos)]",
    text: "text-[var(--ck-pos)]",
  },
  attention: {
    label: "Acompanhe de perto",
    bar: "bg-[var(--ck-alert)]",
    text: "text-[var(--ck-alert)]",
  },
  negative: {
    label: "Mês pede ajuste",
    bar: "bg-[var(--ck-neg)]",
    text: "text-[var(--ck-neg)]",
  },
} as const;

type HeroState = keyof typeof HERO_STATE;

export default function MobileMonthHero({ top }: { top: CockpitTopDerived }) {
  const [exact, setExact] = useState(false);
  const state: HeroState =
    top.projecaoMes < 0
      ? "negative"
      : top.projecaoMes < top.caixaValor
        ? "attention"
        : "positive";
  const presentation = HERO_STATE[state];
  const progress = Math.max(3, Math.min(100, top.pctMesDecorrido * 100));

  return (
    <section
      aria-label="Posição financeira do mês"
      className="overflow-hidden rounded-[18px] border border-[var(--ck-border)] bg-[var(--ck-surface)] shadow-lifeone-card"
    >
      <div className={`h-1.5 w-full ${presentation.bar}`} aria-hidden />
      <div className="p-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold text-[var(--ck-muted)]">
            {top.caixaReal ? "Caixa hoje" : "Resultado realizado"}
          </p>
          <span className={`text-sm font-semibold ${presentation.text}`}>
            {presentation.label}
          </span>
        </div>

        <button
          type="button"
          aria-label={exact ? "Ocultar valor exato" : "Mostrar valor exato"}
          aria-pressed={exact}
          onClick={() => setExact((current) => !current)}
          className="mt-1 min-h-[44px] max-w-full text-left font-geist text-[30px] font-bold leading-tight tracking-tight text-[var(--ck-text)]"
        >
          {exact ? moneyDetail(top.caixaValor) : moneyGlance(top.caixaValor)}
        </button>

        <div className="mt-3 h-2 overflow-hidden rounded-full bg-[var(--ck-surface-2)]">
          <div
            className={`h-full rounded-full ${presentation.bar}`}
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="mt-2 flex items-center justify-between gap-3 text-sm text-[var(--ck-muted)]">
          <span>Hoje</span>
          <span className="font-medium">
            fim do mês {moneyGlance(top.projecaoMes)}
          </span>
        </div>
      </div>

      {/* Linhas full-width: valor monetário nunca divide largura com outro
          elemento variável (3 tiles lado a lado quebravam "R$ 250 mil" em
          3 linhas a 375px). Rótulo à esquerda, valor à direita, sempre 1 linha. */}
      <div className="divide-y divide-[var(--ck-border)] border-t border-[var(--ck-border)] bg-[var(--ck-surface-2)] px-4">
        <div
          role="article"
          aria-label="Entrou"
          className="flex min-h-[44px] items-center justify-between gap-3 py-2.5"
        >
          <span className="flex items-center gap-2 text-sm font-medium text-[var(--ck-muted)]">
            <ArrowUpRight className="h-4 w-4 text-[var(--ck-pos)]" />
            Entrou
            <span className="text-xs font-normal">realizado</span>
          </span>
          <span className="whitespace-nowrap font-geist text-[15px] font-bold tabular-nums text-[var(--ck-pos)]">
            {moneyGlance(top.entrouMes)}
          </span>
        </div>
        <div
          role="article"
          aria-label="Saiu"
          className="flex min-h-[44px] items-center justify-between gap-3 py-2.5"
        >
          <span className="flex items-center gap-2 text-sm font-medium text-[var(--ck-muted)]">
            <ArrowDownRight className="h-4 w-4 text-[var(--ck-neg)]" />
            Saiu
            <span className="whitespace-nowrap text-xs font-normal">
              {moneyGlance(top.saidaJaSaiu)} realizado
            </span>
          </span>
          <span className="whitespace-nowrap font-geist text-[15px] font-bold tabular-nums text-[var(--ck-neg)]">
            {moneyGlance(top.saidaTotal)}
          </span>
        </div>
        <div
          role="article"
          aria-label="Projeção"
          className="flex min-h-[44px] items-center justify-between gap-3 py-2.5"
        >
          <span className="flex items-center gap-2 text-sm font-medium text-[var(--ck-muted)]">
            <Target className="h-4 w-4" />
            Projeção
            <span className="text-xs font-normal">fim do mês</span>
          </span>
          <span
            className={`whitespace-nowrap font-geist text-[15px] font-bold tabular-nums ${
              top.projecaoMes >= 0 ? "text-[var(--ck-pos)]" : "text-[var(--ck-neg)]"
            }`}
          >
            {moneyGlance(top.projecaoMes)}
          </span>
        </div>
      </div>
    </section>
  );
}
