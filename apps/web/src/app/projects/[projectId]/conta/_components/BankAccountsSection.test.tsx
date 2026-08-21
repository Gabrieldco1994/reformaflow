import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectType } from "@reformaflow/domain";
import BankAccountsSection from "./BankAccountsSection";

const apiGetMock = vi.fn();
const apiPatchMock = vi.fn();
const apiPostMock = vi.fn();
const routerReplaceMock = vi.fn();
let searchQuery = "";
let hasBankAccountsModule = true;

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/p1/conta",
  useRouter: () => ({ replace: routerReplaceMock }),
  useSearchParams: () => new URLSearchParams(searchQuery),
}));

vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({
    hasModule: (module: string) =>
      module === "bankAccounts" && hasBankAccountsModule,
  }),
}));

vi.mock("@/lib/api", () => ({
  api: {
    get: (...args: unknown[]) => apiGetMock(...args),
    patch: (...args: unknown[]) => apiPatchMock(...args),
    post: (...args: unknown[]) => apiPostMock(...args),
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock(
  "@/app/projects/[projectId]/bank-accounts/_components/RecebimentosVinculadorModal",
  () => ({ default: () => <div data-testid="recebimentos-modal" /> }),
);

const ACCOUNTS = [
  {
    id: "acc-a",
    institution: "ITAU",
    nickname: "Conta A",
    last4: "1111",
    agency: "0001",
    accountNumber: "1-0",
    openingBalanceCents: 100,
    openingBalanceDate: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "acc-b",
    institution: "NUBANK",
    nickname: "Conta B",
    last4: "2222",
    agency: null,
    accountNumber: null,
    openingBalanceCents: 200,
    openingBalanceDate: "2026-02-01T00:00:00.000Z",
  },
];

let queryClient: QueryClient;

function renderSection(projectType: ProjectType = "PESSOAL" as ProjectType) {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <BankAccountsSection projectId="p1" projectType={projectType} />
    </QueryClientProvider>,
  );
}

describe("BankAccountsSection", () => {
  beforeEach(() => {
    searchQuery = "";
    hasBankAccountsModule = true;
    routerReplaceMock.mockReset();
    apiGetMock.mockReset().mockResolvedValue(ACCOUNTS);
    apiPatchMock.mockReset().mockResolvedValue({});
    apiPostMock.mockReset().mockResolvedValue({
      bankAccount: ACCOUNTS[0],
      receiptsWithoutAccount: [],
    });
  });

  afterEach(() => {
    queryClient?.clear();
  });

  it("não consulta nem renderiza sem capability ou módulo", () => {
    hasBankAccountsModule = false;
    const { rerender } = renderSection();
    expect(
      screen.queryByRole("heading", { name: "Contas bancárias" }),
    ).not.toBeInTheDocument();
    expect(apiGetMock).not.toHaveBeenCalled();

    hasBankAccountsModule = true;
    rerender(
      <QueryClientProvider client={queryClient}>
        <BankAccountsSection
          projectId="p1"
          projectType={"REFORMA" as ProjectType}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.queryByRole("heading", { name: "Contas bancárias" }),
    ).not.toBeInTheDocument();
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  it("com zero contas abre criação e, ao fechar, preserva as demais queries", async () => {
    searchQuery = "mes=2026-08&focus=openingBalance&quick=saiuMes&tag=a&tag=b";
    apiGetMock.mockResolvedValue([]);
    renderSection();

    expect(
      await screen.findByRole("heading", { name: "Nova conta bancária" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(routerReplaceMock).toHaveBeenCalledWith(
      "/projects/p1/conta?mes=2026-08&quick=saiuMes&tag=a&tag=b",
      { scroll: false },
    );
  });

  it("com uma conta e sem accountId abre exatamente essa conta", async () => {
    searchQuery = "focus=openingBalance";
    apiGetMock.mockResolvedValue([ACCOUNTS[0]]);
    renderSection();

    expect(
      await screen.findByRole("heading", { name: "Editar conta" }),
    ).toBeVisible();
    expect(screen.getByDisplayValue("1111")).toBeInTheDocument();
  });

  it("com múltiplas contas exige seleção e salva acc-b, nunca acc-a", async () => {
    searchQuery = "focus=openingBalance";
    renderSection();

    expect(
      await screen.findByText("Escolha a conta que deseja editar"),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Editar conta" }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Selecionar Conta B, final 2222" }),
    );
    expect(await screen.findByDisplayValue("2222")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() =>
      expect(apiPatchMock).toHaveBeenCalledWith(
        "/projects/p1/bank-accounts/acc-b",
        expect.any(Object),
      ),
    );
    expect(apiPatchMock).not.toHaveBeenCalledWith(
      "/projects/p1/bank-accounts/acc-a",
      expect.any(Object),
    );
  });

  it("accountId válido abre a conta exata e a limpeza remove apenas focus/accountId", async () => {
    searchQuery =
      "mes=2026-08&focus=openingBalance&accountId=acc-b&quick=saiuMes&item=item-1&tag=x&tag=y";
    renderSection();

    expect(await screen.findByDisplayValue("2222")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));

    expect(routerReplaceMock).toHaveBeenCalledWith(
      "/projects/p1/conta?mes=2026-08&quick=saiuMes&item=item-1&tag=x&tag=y",
      { scroll: false },
    );
  });

  it("accountId inválido mostra erro e lista, sem fallback para outra conta", async () => {
    searchQuery = "focus=openingBalance&accountId=removida";
    renderSection();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "A conta solicitada não foi encontrada",
    );
    expect(screen.getAllByText("Conta A").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Conta B").length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("heading", { name: "Editar conta" }),
    ).not.toBeInTheDocument();
  });

  it("erro no GET mostra retry e não é interpretado como zero contas", async () => {
    apiGetMock
      .mockRejectedValueOnce(new Error("falha de rede"))
      .mockResolvedValueOnce(ACCOUNTS);
    renderSection();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Não foi possível carregar as contas bancárias",
    );
    expect(
      screen.queryByRole("heading", { name: "Nova conta bancária" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(await screen.findByText("Conta A")).toBeVisible();
  });
});
