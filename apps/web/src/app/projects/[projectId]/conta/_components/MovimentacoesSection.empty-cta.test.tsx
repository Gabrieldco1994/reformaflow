/**
 * #218 W5 — CTA "Novo lançamento" no vazio genuíno de MovimentacoesSection.
 * Gate: raw (saidas|entradas|comprasCartao) vazio + aba "tudo" + sem filtro
 * + onOpenLaunch. Trocar `&&`/`||`, tirar comprasCartao do gate, ou usar
 * `filtered` em vez do raw devem quebrar este arquivo.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MovimentacoesSection } from "./MovimentacoesSection";
import type { AccountViewResponse, AccountViewSaida } from "../_types";

vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn().mockResolvedValue([]),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

function makeSaida(
  overrides: Partial<AccountViewSaida> = {},
): AccountViewSaida {
  return {
    id: "exp-1",
    kind: "saida",
    descricao: "Mercado",
    data: "2026-06-15T00:00:00.000Z",
    forma: "pix",
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
    ...overrides,
  };
}

function makeResponse(
  overrides: Partial<AccountViewResponse> = {},
): AccountViewResponse {
  return {
    mesSelecionado: "2026-06",
    caixaHoje: 0,
    carteiraHoje: 0,
    entrouMes: 0,
    saiuMes: 0,
    faltaPagarMes: 0,
    recebimentosPrevistosMes: 0,
    sobraPrevista: 0,
    devoCartaoTotal: 0,
    cartoes: [],
    contas: [],
    saidas: [],
    comprasCartao: [],
    entradas: [],
    ticketMedio: {
      valor: 0,
      nCompras: 0,
      totalCompras: 0,
      serie6m: [],
      media6m: 0,
      deltaVsMediaPct: null,
    },
    ...overrides,
  };
}

function renderSection(
  data: AccountViewResponse,
  overrides: Partial<React.ComponentProps<typeof MovimentacoesSection>> = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
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
}

const ctaMatcher = { name: /Novo lançamento/ } as const;

describe("MovimentacoesSection — CTA de primeiro uso (#218)", () => {
  it('1) bruto vazio, aba "Tudo", sem filtros: mostra "Novo lançamento" e chama o callback ao clicar', () => {
    const onOpenLaunch = vi.fn();
    renderSection(makeResponse(), { onOpenLaunch });

    const cta = screen.getByRole("button", ctaMatcher);
    fireEvent.click(cta);
    fireEvent.click(cta);

    expect(onOpenLaunch).toHaveBeenCalledTimes(2);
  });

  it.each(["Saídas", "Entradas"])(
    '2) bruto vazio, mas aba "%s": NÃO mostra a CTA de primeiro uso',
    (tabLabel) => {
      renderSection(makeResponse(), { onOpenLaunch: vi.fn() });

      fireEvent.click(screen.getByRole("button", { name: tabLabel }));

      expect(screen.queryByRole("button", ctaMatcher)).not.toBeInTheDocument();
    },
  );

  it('3) bruto existe, mas aba "Entradas" filtra tudo: mensagem antiga, sem CTA de primeiro uso', () => {
    renderSection(makeResponse({ saidas: [makeSaida()] }), {
      onOpenLaunch: vi.fn(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Entradas" }));

    expect(
      screen.getByText("Nenhuma movimentação com esses filtros."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", ctaMatcher)).not.toBeInTheDocument();
  });

  it('4) busca ativa sem resultado: mantém "Limpar filtros", sem CTA de primeiro uso', () => {
    renderSection(makeResponse({ saidas: [makeSaida()] }), {
      onOpenLaunch: vi.fn(),
    });

    fireEvent.change(screen.getByPlaceholderText("Buscar por descrição…"), {
      target: { value: "zzz-inexistente" },
    });

    expect(
      screen.getByRole("button", { name: /Limpar filtros/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", ctaMatcher)).not.toBeInTheDocument();
  });

  it('5) aba "Saídas" com dados: preserva a lista filtrada normal (nem CTA, nem vazio)', () => {
    renderSection(makeResponse({ saidas: [makeSaida()] }), {
      onOpenLaunch: vi.fn(),
    });

    fireEvent.click(screen.getByRole("button", { name: "Saídas" }));

    expect(screen.getByText("Mercado")).toBeInTheDocument();
    expect(
      screen.queryByText("Nenhuma movimentação com esses filtros."),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", ctaMatcher)).not.toBeInTheDocument();
  });
});
