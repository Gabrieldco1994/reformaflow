/**
 * Visão Conta ANUAL na MovimentacoesSection (`mode="ano"`).
 *
 * Invariantes cobertos aqui:
 *  - "ano == soma dos 12 meses" para LISTAS: a lista anual renderiza exatamente
 *    os mesmos itens que as 12 listas mensais somadas (nada some, nada duplica).
 *  - "o mês não regride": o `mode` default continua agrupando por DIA, com os
 *    mesmos rótulos de sempre.
 *  - Regra de ouro 14: movimentação sem cartão/conta (Carteira) aparece na lista
 *    anual com o chip "Sem conta" clicável — nunca é filtrada para fora.
 *  - Saldos PONTUAIS não viram fluxo: o cabeçalho anual fala do ANO, e o filtro
 *    rápido também ("Entrou no ano", não "no mês").
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MovimentacoesSection } from "./MovimentacoesSection";
import type {
  AccountViewEntrada,
  AccountViewResponse,
  AccountViewSaida,
  AccountViewYearlyResponse,
} from "../_types";

vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn().mockResolvedValue([]),
    post: vi.fn().mockResolvedValue({}),
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  },
}));

const MESES = Array.from({ length: 12 }, (_, index) =>
  String(index + 1).padStart(2, "0"),
);

function saidasDoMes(mes: string): AccountViewSaida[] {
  return [
    {
      id: `conta-${mes}`,
      kind: "saida",
      descricao: `Mercado ${mes}`,
      data: `2026-${mes}-10T00:00:00.000Z`,
      forma: "debito",
      valor: 10_000,
      realizado: true,
      status: "PAGO",
      cardLast4: null,
      bankLast4: "1234",
      tipoDespesa: "MERCADO",
      isInvoice: false,
      editavel: true,
      dueMonth: null,
      projetoOrigem: null,
    },
    {
      // Carteira: sem cartão e sem conta (regra de ouro 14).
      id: `carteira-${mes}`,
      kind: "saida",
      descricao: `Feira ${mes}`,
      data: `2026-${mes}-11T00:00:00.000Z`,
      forma: "pix",
      valor: 5_000,
      realizado: true,
      status: "PAGO",
      cardLast4: null,
      bankLast4: null,
      tipoDespesa: "MERCADO",
      isInvoice: false,
      editavel: true,
      dueMonth: null,
      projetoOrigem: null,
    },
  ];
}

function entradasDoMes(mes: string): AccountViewEntrada[] {
  return [
    {
      id: `rec-${mes}`,
      kind: "entrada",
      descricao: `Salário ${mes}`,
      data: `2026-${mes}-05T00:00:00.000Z`,
      tipo: "salario",
      valor: 500_000,
      bankLast4: "1234",
      status: "EM_CAIXA",
    },
  ];
}

function mesResponse(mes: string): AccountViewResponse {
  return {
    mesSelecionado: `2026-${mes}`,
    caixaHoje: 1_000_000,
    carteiraHoje: 0,
    entrouMes: 500_000,
    saiuMes: 15_000,
    faltaPagarMes: 0,
    recebimentosPrevistosMes: 0,
    sobraPrevista: 1_000_000,
    devoCartaoTotal: 0,
    cartoes: [],
    contas: [{ last4: "1234", nome: "Conta corrente" }],
    saidas: saidasDoMes(mes),
    comprasCartao: [],
    entradas: entradasDoMes(mes),
    ticketMedio: {
      valor: 0,
      nCompras: 0,
      totalCompras: 0,
      serie6m: [],
      media6m: 0,
      deltaVsMediaPct: null,
    },
  };
}

function mesResponseComPlanejado(mes: string): AccountViewResponse {
  const base = mesResponse(mes);
  return {
    ...base,
    saidas: [
      ...base.saidas,
      {
        id: `planejado-${mes}`,
        kind: "saida",
        descricao: `Planejado ${mes}`,
        data: `2026-${mes}-25T00:00:00.000Z`,
        forma: "pix",
        valor: 7_000,
        realizado: false,
        status: "PLANEJADO",
        cardLast4: null,
        bankLast4: "1234",
        tipoDespesa: "MATERIAL_CONSTRUCAO",
        isInvoice: false,
        editavel: true,
        dueMonth: null,
        projetoOrigem: null,
      },
    ],
  };
}

/** Consolida os 12 meses como o backend (`getAccountViewYearly`) faz. */
function anoResponse(): AccountViewYearlyResponse {
  const meses = MESES.map(mesResponse);
  return {
    ...meses[0]!,
    mesSelecionado: "2026-01",
    entrouMes: meses.reduce((sum, m) => sum + m.entrouMes, 0),
    saiuMes: meses.reduce((sum, m) => sum + m.saiuMes, 0),
    saidas: meses
      .flatMap((m) => m.saidas)
      .sort((a, b) => b.data.localeCompare(a.data)),
    comprasCartao: [],
    entradas: meses
      .flatMap((m) => m.entradas)
      .sort((a, b) => b.data.localeCompare(a.data)),
    ticketMedio: {
      valor: 0,
      nCompras: 0,
      totalCompras: 0,
      serie12m: [],
      mediaAnual: 0,
      deltaVsMediaPct: null,
    },
  };
}

function renderSection(
  data: AccountViewResponse | AccountViewYearlyResponse,
  overrides: Partial<React.ComponentProps<typeof MovimentacoesSection>> = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={client}>
      <MovimentacoesSection
        data={data}
        projectId="proj-1"
        originFilter={null}
        onClearOrigin={vi.fn()}
        onPayInvoice={vi.fn()}
        onAdjustInvoice={vi.fn()}
        onSettleWithResidual={vi.fn()}
        onUndoPayment={vi.fn()}
        summaryQuickFilter={null}
        onClearSummaryQuickFilter={vi.fn()}
        {...overrides}
      />
    </QueryClientProvider>,
  );
  return utils;
}

/** Rótulos dos grupos renderizados (dia no mês, mês no ano). */
function gruposRenderizados() {
  return screen
    .getAllByRole("region", { name: /^Movimentações de / })
    .map((el) =>
      el.getAttribute("aria-label")!.replace("Movimentações de ", ""),
    );
}

function linhasRenderizadas() {
  return screen
    .getAllByRole("region", { name: /^Movimentações de / })
    .flatMap((group) =>
      within(group).getAllByText(/^(Mercado|Feira|Salário) \d{2}$/),
    )
    .map((el) => el.textContent);
}

describe("MovimentacoesSection — visão anual", () => {
  it("agrupa por MÊS e mostra os 12 grupos do ano", () => {
    renderSection(anoResponse(), { mode: "ano" });

    const grupos = gruposRenderizados();
    expect(grupos).toHaveLength(12);
    expect(grupos[0]).toContain("dezembro");
    expect(grupos[11]).toContain("janeiro");
  });

  it("INVARIANTE ano == soma dos 12 meses: a lista anual traz exatamente os itens das 12 listas mensais", () => {
    const porMes = MESES.map((mes) => {
      const { unmount } = renderSection(mesResponse(mes));
      const linhas = linhasRenderizadas();
      unmount();
      return linhas;
    });

    renderSection(anoResponse(), { mode: "ano" });
    const linhasDoAno = linhasRenderizadas();

    expect(linhasDoAno.slice().sort()).toEqual(porMes.flat().slice().sort());
    expect(linhasDoAno).toHaveLength(36);
  });

  it('regra de ouro 14: item de Carteira aparece no ano com o chip "Sem conta" clicável', () => {
    renderSection(anoResponse(), { mode: "ano" });

    const chips = screen.getAllByRole("button", { name: "Sem conta" });
    // 12 linhas de carteira (uma por mês) + o botão de filtro da toolbar.
    expect(chips.length).toBeGreaterThanOrEqual(12);
  });

  it('fala do ANO no cabeçalho e no filtro rápido — nunca "no mês"', () => {
    renderSection(anoResponse(), {
      mode: "ano",
      summaryQuickFilter: "entrouMes",
    });

    expect(screen.getByText("Movimentações do ano")).toBeInTheDocument();
    expect(
      screen.getByText(/Filtro rápido: Entrou no ano/),
    ).toBeInTheDocument();
    expect(screen.queryByText("Movimentações do mês")).not.toBeInTheDocument();
  });

  it("Saiu no mês mantém o total canônico: mostra pagos e planejados juntos", () => {
    renderSection(mesResponseComPlanejado("07"), {
      summaryQuickFilter: "saiuMes",
    });

    expect(screen.getByText(/Filtro rápido: Saiu no mês/)).toBeInTheDocument();
    expect(screen.getByText("Mercado 07")).toBeInTheDocument();
    expect(screen.getByText("A pagar")).toBeInTheDocument();
  });

  it("filtra por um mês do ano (clique na barra do gráfico) e permite limpar", () => {
    const onMonthFilterChange = vi.fn();
    renderSection(anoResponse(), {
      mode: "ano",
      monthFilter: "2026-03",
      onMonthFilterChange,
    });

    const grupos = gruposRenderizados();
    expect(grupos).toHaveLength(1);
    expect(grupos[0]).toContain("março");
    expect(linhasRenderizadas()).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: /limpar mês/i }));
    expect(onMonthFilterChange).toHaveBeenCalledWith(null);
  });
});

describe("MovimentacoesSection — o mês não regride", () => {
  it("sem `mode`, continua agrupando por DIA e com o cabeçalho do mês", () => {
    renderSection(mesResponse("07"));

    const grupos = gruposRenderizados();
    expect(grupos).toHaveLength(3);
    expect(grupos.join(" | ")).toContain("11");
    expect(screen.getByText("Movimentações do mês")).toBeInTheDocument();
    expect(screen.queryByText("Movimentações do ano")).not.toBeInTheDocument();
  });

  it('sem `mode`, o filtro rápido continua rotulado "no mês"', () => {
    renderSection(mesResponse("07"), { summaryQuickFilter: "saiuMes" });
    expect(screen.getByText(/Filtro rápido: Saiu no mês/)).toBeInTheDocument();
  });
});
