"use client";

import { useMemo, useState } from "react";
import { ShoppingCart } from "lucide-react";
import type { CashFlowEntry } from "@/types";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import { ComprarAgoraModal } from "../../price-compare/_components/ComprarAgoraModal";
import {
  calculateCompraScenario,
  effectivePriceCents,
  isActiveCompraItem,
  priceMonitorScenarioId,
} from "../_lib/compra-scenario";
import type {
  CompraPriceMonitorItem,
  PayConfig,
  SimulationData,
} from "../_types";

interface CompraScenarioViewProps {
  projectId: string;
  data: SimulationData;
  cashFlowEntries: CashFlowEntry[];
  items: CompraPriceMonitorItem[];
  itemsLoading: boolean;
  itemsError: boolean;
  excludes: Set<string>;
  setExcludes: React.Dispatch<React.SetStateAction<Set<string>>>;
  payConfigs: Record<string, PayConfig>;
  setPayConfigs: React.Dispatch<
    React.SetStateAction<Record<string, PayConfig>>
  >;
  scheduleSave: () => void;
}

function monthLabel(month: string) {
  const [year, value] = month.split("-");
  const labels = [
    "Jan",
    "Fev",
    "Mar",
    "Abr",
    "Mai",
    "Jun",
    "Jul",
    "Ago",
    "Set",
    "Out",
    "Nov",
    "Dez",
  ];
  return `${labels[Number(value) - 1]}/${year.slice(2)}`;
}

export function CompraScenarioView({
  projectId,
  data,
  cashFlowEntries,
  items,
  itemsLoading,
  itemsError,
  excludes,
  setExcludes,
  payConfigs,
  setPayConfigs,
  scheduleSave,
}: CompraScenarioViewProps) {
  const [buyingItem, setBuyingItem] = useState<CompraPriceMonitorItem | null>(
    null,
  );
  const activeItems = useMemo(
    () => items.filter((item) => isActiveCompraItem(item)),
    [items],
  );
  const metrics = useMemo(
    () =>
      calculateCompraScenario({
        data,
        cashFlowEntries,
        items,
        excludes,
        payConfigs,
      }),
    [data, cashFlowEntries, items, excludes, payConfigs],
  );

  const updateConfig = (scenarioId: string, patch: Partial<PayConfig>) => {
    setPayConfigs((current) => {
      const existing = current[scenarioId] ?? {
        mode: "avista",
        parcelas: "1",
        inicio: metrics.monthList[0] || "",
        valor: "",
      };
      return {
        ...current,
        [scenarioId]: {
          ...existing,
          ...patch,
        },
      };
    });
    scheduleSave();
  };

  const toggleItem = (scenarioId: string) => {
    setExcludes((current) => {
      const next = new Set(current);
      if (next.has(scenarioId)) next.delete(scenarioId);
      else next.add(scenarioId);
      return next;
    });
    scheduleSave();
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[
          ["Total planejado", metrics.totalPlanejadoCents],
          ["Saldo projetado", metrics.saldoProjetadoCents],
          ["Impacto mensal dos produtos", metrics.impactoMensalCents],
        ].map(([label, value]) => (
          <div
            key={label}
            className="rounded-2xl border border-darc-linen bg-white p-4"
          >
            <p className="text-xs font-medium text-darc-velvet/65">{label}</p>
            <p className="mt-1 whitespace-nowrap text-xl font-bold text-darc-velvet">
              {formatCurrency(Number(value) / 100)}
            </p>
          </div>
        ))}
      </div>

      <section className="rounded-2xl border border-darc-linen bg-white p-4">
        <div>
          <h2 className="text-base font-semibold text-darc-velvet">
            Produtos monitorados neste cenário
          </h2>
          <p className="text-xs leading-5 text-darc-velvet/65">
            Inclua produtos e escolha quando o valor entra na projeção. Nada
            vira despesa real até você usar Comprar agora.
          </p>
        </div>

        {itemsLoading && (
          <p className="py-5 text-sm text-darc-velvet/60">
            Carregando produtos...
          </p>
        )}
        {itemsError && (
          <p className="py-5 text-sm text-red-700">
            Não foi possível carregar os produtos monitorados.
          </p>
        )}
        {!itemsLoading && !itemsError && activeItems.length === 0 && (
          <div className="mt-4 rounded-xl bg-darc-linen/30 p-4 text-sm text-darc-velvet/70">
            Nenhum produto ativo com preço disponível. Adicione itens em Preços
            para compará-los nos cenários.
          </div>
        )}

        <div className="mt-4 space-y-3">
          {activeItems.map((item) => {
            const scenarioId = priceMonitorScenarioId(item.id);
            const included = !excludes.has(scenarioId);
            const config = payConfigs[scenarioId] ?? {
              mode: "avista",
              parcelas: "1",
              inicio: metrics.monthList[0] || "",
              valor: "",
            };
            const priceCents = effectivePriceCents(item);

            return (
              <article
                key={item.id}
                className="rounded-xl border border-darc-linen p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-semibold text-darc-velvet">
                      {item.title}
                    </p>
                    <p className="mt-1 text-xs text-darc-velvet/60">
                      {priceCents != null
                        ? `Preço efetivo: ${formatCurrency(priceCents / 100)}`
                        : "Sem preço disponível"}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-pressed={included}
                    onClick={() => toggleItem(scenarioId)}
                    className={`min-h-11 shrink-0 rounded-lg px-3 text-xs font-semibold ${
                      included
                        ? "bg-green-100 text-green-800"
                        : "bg-gray-100 text-gray-600"
                    }`}
                  >
                    {included ? "Incluído" : "Excluído"}
                  </button>
                </div>

                {included && priceCents != null && (
                  <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <label className="text-xs font-medium text-darc-velvet/70">
                      Pagamento
                      <select
                        aria-label={`Pagamento de ${item.title}`}
                        value={config.mode}
                        onChange={(event) =>
                          updateConfig(scenarioId, {
                            mode: event.target.value,
                            parcelas:
                              event.target.value === "parcelado"
                                ? Number(config.parcelas) >= 2
                                  ? config.parcelas
                                  : "2"
                                : "1",
                          })
                        }
                        className="mt-1 min-h-11 w-full rounded-lg border border-darc-linen bg-white px-3 text-sm"
                      >
                        <option value="avista">À vista</option>
                        <option value="parcelado">Parcelado</option>
                      </select>
                    </label>

                    {config.mode === "parcelado" && (
                      <label className="text-xs font-medium text-darc-velvet/70">
                        Parcelas
                        <input
                          aria-label={`Parcelas de ${item.title}`}
                          type="number"
                          min={2}
                          max={12}
                          value={config.parcelas}
                          onChange={(event) =>
                            updateConfig(scenarioId, {
                              parcelas: event.target.value,
                            })
                          }
                          className="mt-1 min-h-11 w-full rounded-lg border border-darc-linen px-3 text-sm"
                        />
                      </label>
                    )}

                    <label className="text-xs font-medium text-darc-velvet/70">
                      Início
                      <select
                        aria-label={`Início de ${item.title}`}
                        value={config.inicio || metrics.monthList[0]}
                        onChange={(event) =>
                          updateConfig(scenarioId, {
                            inicio: event.target.value,
                          })
                        }
                        className="mt-1 min-h-11 w-full rounded-lg border border-darc-linen bg-white px-3 text-sm"
                      >
                        {metrics.monthList.map((month) => (
                          <option key={month} value={month}>
                            {monthLabel(month)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}

                {included && priceCents != null && (
                  <div className="mt-3 flex justify-end">
                    <Button
                      type="button"
                      className="min-h-11"
                      onClick={() => setBuyingItem(item)}
                    >
                      <ShoppingCart className="h-4 w-4" />
                      Comprar agora
                    </Button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>

      <ComprarAgoraModal
        item={buyingItem}
        projectId={projectId}
        onClose={() => setBuyingItem(null)}
      />
    </div>
  );
}
