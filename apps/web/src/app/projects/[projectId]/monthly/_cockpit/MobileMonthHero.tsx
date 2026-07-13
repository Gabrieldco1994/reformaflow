"use client";

import { useState } from "react";
import { ArrowDownRight, ArrowUpRight, Target } from "lucide-react";
import { moneyDetail, moneyGlance } from "@/lib/money";
import type { CockpitTopDerived } from "./derive";

const HERO_STATE = {
  positive: {
    label: "Mês protegido",
    bar: "bg-[#4A9E78]",
    text: "text-[#4A9E78]",
    glow: "66,160,120",
  },
  attention: {
    label: "Acompanhe de perto",
    bar: "bg-[#E6A93F]",
    text: "text-[#E6A93F]",
    glow: "212,144,41",
  },
  negative: {
    label: "Mês pede ajuste",
    bar: "bg-[#D92D20]",
    text: "text-[#F2A196]",
    glow: "217,45,32",
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
  const saldoPrevisto = Math.max(0, top.saidaTotal - top.saidaJaSaiu);

  return (
    <section
      aria-label="Posição financeira do mês"
      className="relative overflow-hidden rounded-[18px] bg-gradient-to-br from-[#1D1B17] to-[#26231D] text-[#F6F3EE] shadow-lifeone-card"
    >
      <div
        aria-hidden
        className="pointer-events-none absolute -right-28 -top-40 h-[360px] w-[360px] rounded-full"
        style={{
          background: `radial-gradient(closest-side, rgba(${presentation.glow}, 0.26), transparent)`,
        }}
      />
      <div className={`h-1.5 w-full ${presentation.bar}`} aria-hidden />
      <div className="relative p-5">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold text-[#98938A]">
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
          className="mt-1 min-h-[44px] max-w-full text-left font-geist text-[44px] font-extrabold leading-none tracking-[-0.035em] text-[#F6F3EE]"
        >
          {exact ? moneyDetail(top.caixaValor) : moneyGlance(top.caixaValor)}
        </button>

        <p className="mt-3 max-w-[310px] text-[14.5px] leading-6 text-[#C9C4BB]">
          Se nada mudar, o mês fecha em{" "}
          <b className={state === "negative" ? "text-[#F2A196]" : "text-[#F6F3EE]"}>
            {moneyGlance(top.projecaoMes)}
          </b>
          . Faltam sair <b className="text-[#F6F3EE]">{moneyGlance(saldoPrevisto)}</b>.
        </p>

        <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/15">
          <div
            className={`h-full rounded-full ${presentation.bar}`}
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="mt-2 flex items-center justify-between gap-3 text-sm text-[#98938A]">
          <span>Hoje</span>
          <span className="font-semibold text-[#E8E4DC]">
            fim do mês {moneyGlance(top.projecaoMes)}
          </span>
        </div>

        <div className="mt-4 space-y-2 border-t border-white/15 pt-3">
          <div
            role="article"
            aria-label="Entrou"
            className="flex min-h-[44px] items-center justify-between gap-3 rounded-xl px-3 text-sm text-[#C9C4BB]"
          >
            <span className="flex items-center gap-2">
              <ArrowUpRight className="h-4 w-4 text-[#93D7B7]" />
              Entrou
            </span>
            <span className="font-geist text-[15px] font-bold tabular-nums text-[#93D7B7]">
              {moneyGlance(top.entrouMes)}
            </span>
          </div>
          <div
            role="article"
            aria-label="Saiu"
            className="flex min-h-[44px] items-center justify-between gap-3 rounded-xl px-3 text-sm text-[#C9C4BB]"
          >
            <span className="flex items-center gap-2">
              <ArrowDownRight className="h-4 w-4 text-[#F2A196]" />
              Saiu
            </span>
            <span className="font-geist text-[15px] font-bold tabular-nums text-[#F2A196]">
              {moneyGlance(top.saidaJaSaiu)}
            </span>
          </div>
          <div
            role="article"
            aria-label="Projeção"
            className="flex min-h-[44px] items-center justify-between gap-3 rounded-xl px-3 text-sm text-[#C9C4BB]"
          >
            <span className="flex items-center gap-2">
              <Target className="h-4 w-4 text-[#E8E4DC]" />
              Projeção
            </span>
            <span
              className={`font-geist text-[15px] font-bold tabular-nums ${
                top.projecaoMes >= 0 ? "text-[#E8E4DC]" : "text-[#F2A196]"
              }`}
            >
              {moneyGlance(top.projecaoMes)}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
