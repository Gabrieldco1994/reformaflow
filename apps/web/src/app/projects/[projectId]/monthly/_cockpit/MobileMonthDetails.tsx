"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronDown, LockKeyhole } from "lucide-react";
import { moneyDetail } from "@/lib/money";
import CategoriasBarras from "./CategoriasBarras";
import type { MonthDerived } from "./derive";

function DisclosureButton({
  controls,
  expanded,
  onClick,
  title,
  summary,
}: {
  controls: string;
  expanded: boolean;
  onClick: () => void;
  title: string;
  summary: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={title}
      aria-controls={controls}
      aria-expanded={expanded}
      onClick={onClick}
      className="flex min-h-[56px] w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm"
    >
      <span>
        <span className="block font-semibold text-[var(--ck-text)]">
          {title}
        </span>
        <span className="mt-0.5 block text-sm text-[var(--ck-muted)]">
          {summary}
        </span>
      </span>
      <ChevronDown
        className={`h-5 w-5 shrink-0 text-[var(--ck-muted)] transition-transform motion-reduce:transition-none ${
          expanded ? "rotate-180" : ""
        }`}
      />
    </button>
  );
}

export default function MobileMonthDetails({
  month,
  isFutureMonth,
}: {
  month: MonthDerived;
  isFutureMonth: boolean;
}) {
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [upcomingOpen, setUpcomingOpen] = useState(false);
  const analysisId = `${useId()}-analysis`;
  const upcomingId = `${useId()}-upcoming`;
  const knownTotal = month.contasFuturas.reduce(
    (sum, account) => sum + account.valor,
    0,
  );

  return (
    <section
      aria-label="Detalhes do mês"
      className="overflow-hidden rounded-[18px] border border-[var(--ck-border)] bg-[var(--ck-surface)] shadow-lifeone-card"
    >
      {isFutureMonth && (
        <div
          role="note"
          aria-label="Mês futuro incompleto"
          className="flex gap-2 border-b border-[var(--ck-border)] bg-[var(--ck-alert)]/10 p-4 text-sm text-[var(--ck-alert)]"
        >
          <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            <strong className="block">Mês futuro incompleto</strong>
            Mostra somente saídas já conhecidas. Consulta somente leitura.
          </p>
        </div>
      )}

      <div className="divide-y divide-[var(--ck-border)]">
        <div>
          <DisclosureButton
            controls={analysisId}
            expanded={analysisOpen}
            onClick={() => setAnalysisOpen((open) => !open)}
            title="Análise do mês"
            summary="Categorias conhecidas e posição do período"
          />
          {analysisOpen && (
            <div
              id={analysisId}
              className="border-t border-[var(--ck-border)] p-3"
            >
              <div className="grid grid-cols-2 gap-2 pb-3">
                <div className="rounded-xl bg-[var(--ck-surface-2)] p-3">
                  <p className="text-sm text-[var(--ck-muted)]">
                    Entrou realizado
                  </p>
                  <p className="mt-1 font-geist text-base font-bold tabular-nums text-[var(--ck-pos)]">
                    {moneyDetail(month.entrouRealizado)}
                  </p>
                </div>
                <div className="rounded-xl bg-[var(--ck-surface-2)] p-3">
                  <p className="text-sm text-[var(--ck-muted)]">
                    Saiu realizado
                  </p>
                  <p className="mt-1 font-geist text-base font-bold tabular-nums text-[var(--ck-neg)]">
                    {moneyDetail(month.gasteiRealizado)}
                  </p>
                </div>
              </div>
              <CategoriasBarras
                categorias={month.categorias}
                title="Categorias conhecidas"
                hint="realizado + planejado"
              />
            </div>
          )}
        </div>

        <div>
          <DisclosureButton
            controls={upcomingId}
            expanded={upcomingOpen}
            onClick={() => setUpcomingOpen((open) => !open)}
            title="Próximas saídas conhecidas"
            summary={
              month.contasFuturas.length > 0 ? (
                <>
                  {month.contasFuturas.length} itens ·{" "}
                  <span>{moneyDetail(knownTotal)}</span>
                </>
              ) : (
                "Nenhuma saída conhecida"
              )
            }
          />
          {upcomingOpen && (
            <div
              id={upcomingId}
              className="border-t border-[var(--ck-border)] p-4"
            >
              <p className="mb-3 flex items-center gap-1.5 text-sm text-[var(--ck-muted)]">
                <LockKeyhole className="h-4 w-4" /> Somente leitura e pode estar
                incompleto
              </p>
              {month.contasFuturas.length === 0 ? (
                <p className="text-sm text-[var(--ck-muted)]">
                  Nenhuma saída planejada foi informada para este mês.
                </p>
              ) : (
                <ul className="space-y-2">
                  {month.contasFuturas.map((account, index) => (
                    <li
                      key={`${account.dia}-${account.nome}-${index}`}
                      className="flex items-center justify-between gap-3 rounded-xl bg-[var(--ck-surface-2)] p-3 text-sm"
                    >
                      <span className="min-w-0 truncate text-[var(--ck-text)]">
                        dia {account.dia} · {account.nome}
                      </span>
                      <span className="shrink-0 font-geist font-semibold tabular-nums text-[var(--ck-neg)]">
                        {moneyDetail(account.valor)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
