import type { ComponentProps } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type MobileCockpitHeader from "./_cockpit/MobileCockpitHeader";
import type YearView from "./_cockpit/YearView";
import type MonthView from "./_cockpit/MonthView";
import type YearCarryIncomeRow from "./_cockpit/YearCarryIncomeRow";
import type { MonthlyOverviewResponse } from "./_types";
import CockpitPage from "./page";

const probes = vi.hoisted(() => ({
  header: vi.fn(),
  year: vi.fn(),
  month: vi.fn(),
  carry: vi.fn(),
  replace: vi.fn(),
  search: new URLSearchParams(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "pessoal-a" }),
  usePathname: () => "/projects/pessoal-a/monthly",
  useRouter: () => ({ replace: probes.replace }),
  useSearchParams: () => probes.search,
}));
vi.mock("@/contexts/project-context", () => ({
  useProject: () => ({
    projectId: "pessoal-a",
    projectType: "PESSOAL",
    projectName: "Pessoal A",
  }),
}));
vi.mock("./_cockpit/MobileCockpitHeader", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./_cockpit/MobileCockpitHeader")>();
  return {
    default: (props: ComponentProps<typeof MobileCockpitHeader>) => {
      probes.header(props);
      return <actual.default {...props} />;
    },
  };
});
vi.mock("./_cockpit/YearView", () => ({
  default: (props: ComponentProps<typeof YearView>) => {
    probes.year(props);
    return null;
  },
}));
vi.mock("./_cockpit/MonthView", () => ({
  default: (props: ComponentProps<typeof MonthView>) => {
    probes.month(props);
    return null;
  },
}));
vi.mock("./_cockpit/YearCarryIncomeRow", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./_cockpit/YearCarryIncomeRow")>();
  return {
    default: (props: ComponentProps<typeof YearCarryIncomeRow>) => {
      probes.carry(props.entry);
      return <actual.default {...props} />;
    },
  };
});
vi.mock("./_cockpit/MobileMonthCockpit", () => ({ default: () => null }));
vi.mock("./_cockpit/ExtratoGeral", () => ({ default: () => null }));
vi.mock("./_cockpit/CockpitTop", () => ({ default: () => null }));
vi.mock("./_cockpit/SaldosWidget", () => ({ default: () => null }));
vi.mock("./_cockpit/ComprometimentoFuturo", () => ({ default: () => null }));
vi.mock("./_cockpit/PendenciasQueueCard", () => ({
  PendenciasQueueCard: () => null,
}));
vi.mock("../expenses/_components/NovaDespesaLauncher", () => ({
  NovaDespesaLauncher: () => null,
}));
vi.mock("../conta/_components/ProjecaoSaldo", () => ({
  ProjecaoSaldo: () => null,
}));

let client: QueryClient;
let data: MonthlyOverviewResponse;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2029-12-24T12:00:00.000Z"));
  window.localStorage.clear();
  data = {
    mesAtual: "2029-12",
    meses: [],
    mesAtualEntries: [],
    projetos: [],
    cards: [],
    entries: [
      {
        id: "last-source-receipt",
        data: "2029-12-01T00:00:00.000Z",
        tipo: "RECEBIMENTO",
        status: "PREVISTO",
        valor: 10_001,
        categoria: null,
        subcategoria: null,
        formaPagamento: null,
        projectId: "pessoal-a",
        projectName: "Pessoal A",
        projectType: "PESSOAL",
      },
    ],
    comparativo: {
      current: null,
      previous: null,
      deltaDespesas: 0,
      deltaDespesasPct: null,
      deltaRecebimentos: 0,
      deltaRecebimentosPct: null,
      deltaSaldo: 0,
    },
  };
  // Global application cache policy: navigation must not require synthetic writes.
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 60_000, gcTime: Infinity },
    },
  });
  client.setQueryData(["monthly-overview", "pessoal-a", null], data);
  vi.mocked(api.get).mockImplementation(async (path: string) =>
    /^\/projects\/pessoal-a\/monthly-overview(?:\?|$)/.test(path) ? data : [],
  );
});
afterEach(() => {
  cleanup();
  client.clear();
  window.localStorage.clear();
  vi.useRealTimers();
});

function renderPage() {
  return render(
    <QueryClientProvider client={client}>
      <CockpitPage />
    </QueryClientProvider>,
  );
}

describe("#707 actual cockpit future navigation", () => {
  it("refetches on return within the global 60-second cache and replaces January carry after a source edit", async () => {
    data.mesAtual = "2030-01";
    const initial = renderPage();
    await waitFor(() => expect(client.isFetching()).toBe(0));
    expect(probes.carry.mock.lastCall![0]).toMatchObject({
      sourceYear: 2029,
      valor: 10_001,
      status: "PREVISTO",
    });
    initial.unmount();

    data = {
      ...data,
      entries: [{ ...data.entries![0]!, valor: 4_001 }],
    };
    vi.setSystemTime(new Date("2029-12-24T12:00:01.000Z"));
    vi.mocked(api.get).mockClear();
    renderPage();

    await waitFor(() => {
      expect(api.get).toHaveBeenCalledWith(
        "/projects/pessoal-a/monthly-overview",
      );
      expect(probes.carry.mock.lastCall![0]).toMatchObject({
        sourceYear: 2029,
        valor: 4_001,
        status: "PREVISTO",
        id: null,
        bankLast4: null,
      });
    });
    expect(
      client.getQueryData(["monthly-overview", "pessoal-a", null]),
    ).toEqual(data);
    for (const write of [api.post, api.patch, api.put, api.delete]) {
      expect(write).not.toHaveBeenCalled();
    }
  });

  it("keeps January carry on the cash axis when the monthly view changes to Extrato", () => {
    data.mesAtual = "2030-01";
    data.cards = [
      { last4: "1234", nickname: "Card", closingDay: 20, dueDay: 25 },
    ];
    data.entries!.push({
      ...data.entries![0]!,
      id: "card-on-close",
      data: "2029-12-20T00:00:00.000Z",
      tipo: "DESPESA",
      status: "PLANEJADO",
      valor: 3_000,
      cardLast4: "1234",
    });
    const snapshot = structuredClone(data);
    renderPage();
    expect(probes.carry.mock.lastCall![0]).toMatchObject({
      sourceYear: 2029,
      valor: 10_001,
      data: "2030-01-01T00:00:00.000Z",
    });
    probes.carry.mockClear();
    fireEvent.click(screen.getAllByRole("button", { name: "Extrato" })[0]!);
    expect(probes.carry.mock.lastCall![0]).toMatchObject({
      sourceYear: 2029,
      valor: 10_001,
      data: "2030-01-01T00:00:00.000Z",
    });
    expect(data).toEqual(snapshot);
    expect(
      client.getQueryData(["monthly-overview", "pessoal-a", null]),
    ).toEqual(snapshot);
    for (const write of [api.post, api.patch, api.put, api.delete]) {
      expect(write).not.toHaveBeenCalled();
    }
  });

  it.each([
    { branch: "mobile", index: 0 },
    { branch: "desktop", index: 1 },
  ])(
    "$branch reaches the next January without a raw January transaction",
    async ({ index }) => {
      const snapshot = structuredClone(data);
      renderPage();
      fireEvent.click(
        screen.getAllByRole("button", { name: "Próximo mês" })[index]!,
      );
      const header = probes.header.mock.lastCall![0] as ComponentProps<
        typeof MobileCockpitHeader
      >;
      expect(header.monthKey).toBe("2030-01");
      await waitFor(() => {
        const month = probes.month.mock.lastCall![0] as ComponentProps<
          typeof MonthView
        >;
        expect(month.monthKey).toBe("2030-01");
        expect(month.entries).toEqual([]);
      });
      expect(probes.replace).toHaveBeenCalledWith(
        "/projects/pessoal-a/monthly?mes=2030-01",
        { scroll: false },
      );
      expect(data).toEqual(snapshot);
      expect(
        client.getQueryData(["monthly-overview", "pessoal-a", null]),
      ).toEqual(snapshot);
      expect(api.patch).not.toHaveBeenCalled();
      expect(api.post).not.toHaveBeenCalled();
      expect(api.put).not.toHaveBeenCalled();
      expect(api.delete).not.toHaveBeenCalled();
    },
  );

  it.each([
    { branch: "mobile", index: 0 },
    { branch: "desktop", index: 1 },
  ])(
    "$branch advances the year frontier on each selection without appending raw entries",
    ({ index }) => {
      const snapshot = structuredClone(data);
      renderPage();
      fireEvent.click(screen.getAllByRole("button", { name: "Ano" })[index]!);
      for (const [year, following] of [
        [2030, 2031],
        [2031, 2032],
        [2032, 2033],
      ]) {
        const before = probes.header.mock.lastCall![0] as ComponentProps<
          typeof MobileCockpitHeader
        >;
        expect(before.years).toContain(year);
        fireEvent.change(screen.getAllByRole("combobox")[index]!, {
          target: { value: String(year) },
        });
        const after = probes.header.mock.lastCall![0] as ComponentProps<
          typeof MobileCockpitHeader
        >;
        expect(after.year).toBe(year);
        expect(after.years).toContain(following);
        const annual = probes.year.mock.lastCall![0] as ComponentProps<
          typeof YearView
        >;
        expect(annual.year).toBe(year);
        expect(annual.data.entries).toEqual(snapshot.entries);
      }
      expect(data).toEqual(snapshot);
      expect(
        client.getQueryData(["monthly-overview", "pessoal-a", null]),
      ).toEqual(snapshot);
      expect(api.patch).not.toHaveBeenCalled();
      expect(api.post).not.toHaveBeenCalled();
      expect(api.put).not.toHaveBeenCalled();
      expect(api.delete).not.toHaveBeenCalled();
    },
  );
});
