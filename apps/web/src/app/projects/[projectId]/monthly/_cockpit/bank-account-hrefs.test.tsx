import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MonthlyEntry, MonthlyOverviewResponse } from "../_types";
import CockpitTop from "./CockpitTop";
import SaldosWidget from "./SaldosWidget";

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
}));

vi.mock("@/lib/api", () => ({
  api: {
    get: (path: string) =>
      Promise.resolve(
        path.endsWith("/bank-accounts")
          ? [
              {
                id: "acc-a",
                institution: "ITAU",
                nickname: "Conta A",
                last4: "1111",
              },
            ]
          : [],
      ),
  },
}));

vi.mock("./derive", () => ({
  deriveCockpitTop: () => ({
    caixaValor: 0,
    caixaReal: false,
    caixaDelta: 0,
    caixaSpark: [],
    resultadoMes: 0,
    resultadoEntrou: 0,
    resultadoGastou: 0,
    resultadoDeltaPct: null,
    entrouMes: 0,
    saidaJaSaiu: 0,
    saidaVaiSair: 0,
    saidaTotal: 0,
    projecaoMes: 0,
    aReceberMes: 0,
    aPagarMes: 0,
    mesAtualKey: "2026-08",
    pctMesDecorrido: 0.5,
    projectionSource: "canonical",
    projectionDegraded: false,
  }),
  deriveMonth: vi.fn(),
  saldoProjetado: vi.fn(),
}));

vi.mock("../../_lib/runway-summary", () => ({
  deriveRunwayNarrative: () => null,
}));

describe("links canônicos de gestão bancária", () => {
  it("leva o banner de saldo inicial direto para /conta", () => {
    render(
      <CockpitTop
        data={{ mesAtual: "2026-08" } as MonthlyOverviewResponse}
        showRecs={false}
      />,
    );

    expect(
      screen.getByText("defina o saldo inicial").closest("a"),
    ).toHaveAttribute("href", "/projects/p1/conta?focus=openingBalance");
  });

  it('leva o link "ver" de Contas direto para /conta', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const entry = {
      tipo: "DESPESA",
      projectId: "p1",
      bankLast4: "1111",
      cardLast4: null,
      valor: 100,
      tipoDespesaCodigo: "MORADIA",
    } as MonthlyEntry;

    render(
      <QueryClientProvider client={client}>
        <SaldosWidget projectId="p1" entries={[entry]} eixo="competencia" />
      </QueryClientProvider>,
    );

    expect(await screen.findByRole("link", { name: "ver" })).toHaveAttribute(
      "href",
      "/projects/p1/conta",
    );
  });
});
