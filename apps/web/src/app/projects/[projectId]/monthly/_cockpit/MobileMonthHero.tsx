"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowDownRight, ArrowUpRight, Target } from "lucide-react";
import { moneyDetail, moneyGlance } from "@/lib/money";
import type { CockpitTopDerived } from "./derive";

const HERO_STATE = {
  positive: {
    label: "Mês protegido",
    bar: "bg-[#16A34A]",
    text: "text-[#16A34A]",
  },
  attention: {
    label: "Acompanhe de perto",
    bar: "bg-[#9AA0A8]",
    text: "text-[#5B6068]",
  },
  negative: {
    label: "Mês pede ajuste",
    bar: "bg-[#EF4444]",
    text: "text-[#EF4444]",
  },
} as const;

type HeroState = keyof typeof HERO_STATE;

const scrollToRunway = () => {
  const element = document.getElementById("mobile-cockpit-runway");
  if (element) {
    element.scrollIntoView({ behavior: "smooth" });
  }
};

export default function MobileMonthHero({
  top,
  projectId,
}: {
  top: CockpitTopDerived;
  projectId: string;
}) {
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
      data-minimal-hero
      aria-label="Posição financeira do mês"
      className="overflow-hidden rounded-[28px] bg-white text-[#111214] shadow-[0_1px_2px_rgba(17,18,20,.03),0_12px_32px_rgba(17,18,20,.06)]"
    >
      <div className={`h-1.5 w-full ${presentation.bar}`} aria-hidden />
      <div className="p-5">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold text-[#5B6068]">
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
          className="mt-1 min-h-[44px] max-w-full text-left font-geist text-[40px] font-extrabold leading-none tracking-[-0.035em] text-[#111214] sm:text-[44px]"
        >
          {exact ? moneyDetail(top.caixaValor) : moneyGlance(top.caixaValor)}
        </button>

        <button
          type="button"
          onClick={scrollToRunway}
          className="-mx-3 mt-3 flex w-full min-h-[44px] items-center justify-start rounded-[6px] bg-white px-3 text-left font-normal leading-6 text-[#5B6068] hover:bg-[#F6F7F9]"
          aria-label="Rolar até projeção detalhada"
        >
          <span className="text-[14.5px]">
            Se nada mudar, o mês fecha em{" "}
            <b className={state === "negative" ? "text-[#EF4444]" : "text-[#111214]"}>
              {moneyGlance(top.projecaoMes)}
            </b>
            .
          </span>
        </button>

        <div className="mt-4 h-2 overflow-hidden rounded-full bg-[#EEF0F3]">
          <div
            className={`h-full rounded-full ${presentation.bar}`}
            style={{ width: `${progress}%` }}
          />
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-3 text-sm text-[#9AA0A8]">
          <span className="text-[#5B6068]">Hoje</span>
          <button
            type="button"
            onClick={scrollToRunway}
            className="-my-1.5 flex min-h-[44px] items-center font-semibold text-[#5B6068] hover:underline"
            aria-label="Rolar até projeção detalhada"
          >
            fim do mês
          </button>
        </div>

        <div className="mt-4 space-y-2 border-t border-[#E8EAEE] pt-3">
          <Link
            href={`/projects/${projectId}/conta?quick=entrouMes`}
            className="flex min-h-[44px] items-center justify-between gap-3 rounded-[14px] bg-[#F6F7F9] px-3 text-sm text-[#5B6068] hover:bg-[#EDEFF4] active:scale-[0.99]"
            aria-label="Ver entradas do mês"
          >
            <span className="flex items-center gap-2">
              <ArrowUpRight className="h-4 w-4 text-[#16A34A]" />
              Entrou
            </span>
            <span className="shrink-0 font-geist text-[15px] font-bold tabular-nums text-[#16A34A]">
              {moneyGlance(top.entrouMes)}
            </span>
          </Link>
          <Link
            href={`/projects/${projectId}/conta?quick=saiuMes`}
            className="flex min-h-[44px] items-center justify-between gap-3 rounded-[14px] bg-[#F6F7F9] px-3 text-sm text-[#5B6068] hover:bg-[#EDEFF4] active:scale-[0.99]"
            aria-label="Ver saídas do mês"
          >
            <span className="flex items-center gap-2">
              <ArrowDownRight className="h-4 w-4 text-[#EF4444]" />
              Saiu
            </span>
            <span className="shrink-0 font-geist text-[15px] font-bold tabular-nums text-[#EF4444]">
              {moneyGlance(top.saidaJaSaiu)}
            </span>
          </Link>
          <button
            type="button"
            onClick={() => {
              const element = document.getElementById("mobile-cockpit-runway");
              if (element) {
                element.scrollIntoView({ behavior: "smooth" });
              }
            }}
            className="w-full flex min-h-[44px] items-center justify-between gap-3 rounded-[14px] bg-[#F6F7F9] px-3 text-sm text-[#5B6068] hover:bg-[#EDEFF4] active:scale-[0.99]"
            aria-label="Rolar até projeção"
          >
            <span className="flex items-center gap-2">
              <Target className="h-4 w-4 text-[#5B6068]" />
              Projeção
            </span>
            <span
              className={`shrink-0 font-geist text-[15px] font-bold tabular-nums ${
                top.projecaoMes >= 0 ? "text-[#111214]" : "text-[#EF4444]"
              }`}
            >
              {moneyGlance(top.projecaoMes)}
            </span>
          </button>
        </div>
      </div>
    </section>
  );
}
