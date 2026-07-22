import { projectMonthlyExpenses } from "@reformaflow/domain";
import type { CashFlowEntry } from "@/types";
import type {
  CompraPriceMonitorItem,
  MonthlyRow,
  PayConfig,
  SimulationData,
} from "../_types";

export interface CompraScenarioMetrics {
  monthList: string[];
  monthlyExpenses: Record<string, number>;
  monthlyProductExpenses: Record<string, number>;
  totalPlanejadoCents: number;
  saldoProjetadoCents: number;
  impactoMensalCents: number;
  includedProductCount: number;
}

export function priceMonitorScenarioId(itemId: string) {
  return `pm_${itemId}`;
}

export function effectivePriceCents(
  item: CompraPriceMonitorItem,
): number | null {
  return (
    item.lastBestPriceCents ??
    (item.lastBestPrice != null
      ? Math.round(item.lastBestPrice * 100)
      : null) ??
    item.referencePriceCents ??
    null
  );
}

export function isActiveCompraItem(
  item: CompraPriceMonitorItem,
  now = new Date(),
): boolean {
  if (!item.isActive) return false;
  if (!item.monitoringEndDate) return true;
  return new Date(item.monitoringEndDate).getTime() > now.getTime();
}

export function compraMonthList(
  projection: MonthlyRow[],
  now = new Date(),
): string[] {
  if (projection.length > 0) {
    const months = Array.from(new Set(projection.map((row) => row.month))).sort();
    const [year, month] = months[0].split("-").map(Number);
    for (let index = months.length; index < 12; index++) {
      const date = new Date(year, month - 1 + index, 1);
      months.push(
        `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`,
      );
    }
    return months;
  }

  return Array.from({ length: 12 }, (_, index) => {
    const date = new Date(now.getFullYear(), now.getMonth() + index, 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  });
}

function cashFlowGroups(entries: CashFlowEntry[]) {
  const grouped = new Map<string, CashFlowEntry[]>();

  for (const entry of entries) {
    if (entry.tipo !== "DESPESA") continue;
    const groupId = entry.expenseId || entry.id;
    const current = grouped.get(groupId);
    if (current) current.push(entry);
    else grouped.set(groupId, [entry]);
  }

  return Array.from(grouped.entries()).map(([groupId, groupEntries]) => {
    const sortedEntries = [...groupEntries].sort((a, b) =>
      a.data.localeCompare(b.data),
    );
    return {
      groupId,
      totalValor: sortedEntries.reduce((sum, entry) => sum + entry.valor, 0),
      entries: sortedEntries.map((entry) => ({
        data: entry.data,
        valor: entry.valor,
      })),
      isMulti: sortedEntries.length > 1,
    };
  });
}

function projectionPayConfigs(payConfigs: Record<string, PayConfig>) {
  return Object.fromEntries(
    Object.entries(payConfigs).map(([id, config]) => [
      id,
      {
        mode:
          config.mode === "parcelado"
            ? ("parcelado" as const)
            : config.mode === "avista"
              ? ("avista" as const)
              : undefined,
        inicio: config.inicio,
        parcelas: config.parcelas,
        valor: config.valor,
      },
    ]),
  );
}

export function calculateCompraScenario({
  data,
  cashFlowEntries,
  items,
  excludes,
  payConfigs,
  now = new Date(),
}: {
  data: SimulationData;
  cashFlowEntries: CashFlowEntry[];
  items: CompraPriceMonitorItem[];
  excludes: Set<string>;
  payConfigs: Record<string, PayConfig>;
  now?: Date;
}): CompraScenarioMetrics {
  const monthList = compraMonthList(data.projecaoMensal, now);
  const groups = cashFlowGroups(cashFlowEntries);
  const activeItems = items.filter(
    (item) =>
      isActiveCompraItem(item, now) &&
      effectivePriceCents(item) != null &&
      !excludes.has(priceMonitorScenarioId(item.id)),
  );
  const productExtras = activeItems.map((item) => {
    const scenarioId = priceMonitorScenarioId(item.id);
    const config = payConfigs[scenarioId];
    return {
      valor: (effectivePriceCents(item) ?? 0) / 100,
      mode:
        config?.mode === "parcelado"
          ? ("parcelado" as const)
          : ("avista" as const),
      parcelas: config?.parcelas || "1",
      inicio: config?.inicio || monthList[0],
    };
  });

  const normalizedPayConfigs = projectionPayConfigs(payConfigs);
  const monthlyExpenses = projectMonthlyExpenses({
    monthList,
    groups,
    excludes,
    payConfigs: normalizedPayConfigs,
    extras: productExtras,
  });
  const monthlyProductExpenses = projectMonthlyExpenses({
    monthList,
    groups: [],
    excludes: new Set(),
    payConfigs: {},
    extras: productExtras,
  });
  const monthlyReceipts = Object.fromEntries(
    monthList.map((month) => [
      month,
      data.projecaoMensal.find((row) => row.month === month)?.recebimentos ?? 0,
    ]),
  );

  const totalPlanejadoCents = Object.values(monthlyExpenses).reduce(
    (sum, value) => sum + value,
    0,
  );
  const totalReceiptsCents = Object.values(monthlyReceipts).reduce(
    (sum, value) => sum + value,
    0,
  );

  return {
    monthList,
    monthlyExpenses,
    monthlyProductExpenses,
    totalPlanejadoCents,
    saldoProjetadoCents: totalReceiptsCents - totalPlanejadoCents,
    impactoMensalCents: Math.max(0, ...Object.values(monthlyProductExpenses)),
    includedProductCount: activeItems.length,
  };
}

export function parseCompraScenarioValues(values: Record<string, string>): {
  excludes: Set<string>;
  payConfigs: Record<string, PayConfig>;
} {
  const excludes = new Set<string>();
  const payConfigs: Record<string, PayConfig> = {};

  for (const [key, value] of Object.entries(values)) {
    if (key.startsWith("monthly_excl|") && value === "1") {
      excludes.add(key.slice(13));
      continue;
    }
    if (!key.startsWith("monthly_pay|")) continue;

    const rest = key.slice(12);
    const separator = rest.lastIndexOf("|");
    if (separator === -1) continue;
    const id = rest.slice(0, separator);
    const field = rest.slice(separator + 1);
    if (!payConfigs[id]) {
      payConfigs[id] = {
        mode: "avista",
        parcelas: "1",
        inicio: "",
        valor: "",
      };
    }
    if (field === "mode") payConfigs[id].mode = value;
    else if (field === "parcelas") payConfigs[id].parcelas = value;
    else if (field === "inicio") payConfigs[id].inicio = value;
    else if (field === "valor") payConfigs[id].valor = value;
  }

  return { excludes, payConfigs };
}
