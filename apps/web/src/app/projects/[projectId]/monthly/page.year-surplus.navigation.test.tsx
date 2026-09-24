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
import type { MonthlyOverviewResponse } from "./_types";
import CockpitPage from "./page";

const probes = vi.hoisted(() => ({
  header: vi.fn(),
  year: vi.fn(),
  month: vi.fn(),
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
