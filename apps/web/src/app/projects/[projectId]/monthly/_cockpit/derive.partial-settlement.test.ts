import { expect, it } from "vitest";
import type { MonthlyEntry, MonthlyOverviewResponse } from "../_types";
import { buildExtratoDespesas, categoriasDoAno, deriveTotals } from "./derive";

const debit: MonthlyEntry = {
  id: "bank-source",
  data: "2026-09-10",
  tipo: "DESPESA",
  status: "PAGO",
  valor: 40_000,
  categoria: "Outros",
  subcategoria: null,
  formaPagamento: "PIX",
  projectId: "pessoal",
  projectName: "Pessoal",
  projectType: "PESSOAL",
  bankLast4: "1234",
};
const projection: MonthlyEntry = {
  ...debit,
  id: "target-paid",
  projectId: "obra",
  projectType: "REFORMA",
  bankLast4: null,
  isSettlementProjection: true,
};
const pending: MonthlyEntry = {
  ...projection,
  id: "target-pending",
  status: "PLANEJADO",
  data: "2026-10-10",
  isSettlementProjection: false,
};
const data: MonthlyOverviewResponse = {
  mesAtual: "2026-09",
  meses: [],
  mesAtualEntries: [],
  projetos: [],
  comparativo: {
    current: null,
    previous: null,
    deltaDespesas: 0,
    deltaDespesasPct: null,
    deltaRecebimentos: 0,
    deltaRecebimentosPct: null,
    deltaSaldo: 0,
  },
  entries: [debit, projection, pending],
};

it("consolidated cash counts the real source once plus the remaining amount", () => {
  expect(deriveTotals(data, false)).toMatchObject({
    saidasRealizadas: 40_000,
    saidasPlanejadas: 40_000,
  });
  expect(categoriasDoAno(data.entries!, 2026)[0].valor).toBe(80_000);
  expect(
    buildExtratoDespesas(data.entries!).itens.map((e) => e.id),
  ).not.toContain("target-paid");
});

it("PESSOAL-only keeps legacy mirrors and the entire bank debit, not just its allocation", () => {
  expect(
    deriveTotals({
      ...data,
      entries: [
        { ...debit, valor: 80_000 },
        projection,
        pending,
        { ...debit, id: "legacy", isEspelho: true, valor: 10_000 },
      ],
    }),
  ).toMatchObject({ saidasRealizadas: 90_000, saidasPlanejadas: 0 });
});
