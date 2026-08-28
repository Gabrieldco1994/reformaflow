import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectType } from "@reformaflow/domain";
import BankAccountsSection from "./BankAccountsSection";
import ContaPage from "../page";

const apiGetMock = vi.fn();
const apiPatchMock = vi.fn();
const apiPostMock = vi.fn();
const apiDeleteMock = vi.fn();
const routerReplaceMock = vi.fn();
let searchQuery = "";
let hasBankAccountsModule = true;

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "p1" }),
  usePathname: () => "/projects/p1/conta",
  useRouter: () => ({ replace: routerReplaceMock }),
  useSearchParams: () => new URLSearchParams(searchQuery),
}));

vi.mock("@/contexts/project-context", () => ({
  useProject: () => ({
    projectId: "p1",
    projectType: "PESSOAL",
    projectName: "Pessoal",
  }),
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
    delete: (...args: unknown[]) => apiDeleteMock(...args),
  },
  ApiResponseError: class extends Error {},
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock(
  "@/app/projects/[projectId]/expenses/_components/NovaDespesaLauncher",
  () => ({ NovaDespesaLauncher: () => null }),
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

function renderSection(
  projectType: ProjectType = "PESSOAL" as ProjectType,
  onChanged = vi.fn(),
) {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <BankAccountsSection
        projectId="p1"
        projectType={projectType}
        onChanged={onChanged}
      />
    </QueryClientProvider>,
  );
}

describe("BankAccountsSection", () => {
  beforeEach(() => {
    searchQuery = "";
    hasBankAccountsModule = true;
    routerReplaceMock.mockReset();
    apiGetMock.mockReset().mockResolvedValue(ACCOUNTS);
    apiDeleteMock.mockReset().mockResolvedValue({ ok: true });
    apiPatchMock.mockReset().mockResolvedValue({});
    apiPostMock.mockReset().mockResolvedValue({
      bankAccount: ACCOUNTS[0],
      receiptsWithoutAccount: 0,
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
          onChanged={vi.fn()}
        />
      </QueryClientProvider>,
    );
    expect(
      screen.queryByRole("heading", { name: "Contas bancárias" }),
    ).not.toBeInTheDocument();
    expect(apiGetMock).not.toHaveBeenCalled();
  });

  it("mantém exatamente uma CTA canônica de nova conta", () => {
    const { container } = renderSection();

    expect(
      container.querySelectorAll('[data-journey-action="bank-account.new"]'),
    ).toHaveLength(1);
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
    searchQuery = "mes=2026-08&focus=openingBalance&quick=saiuMes&tag=a&tag=b";
    const onChanged = vi.fn();
    renderSection("PESSOAL" as ProjectType, onChanged);

    expect(
      await screen.findByText("Escolha a conta que deseja editar"),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Editar conta" }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Selecionar Conta B, final 2222" }),
    );
    expect(routerReplaceMock).toHaveBeenCalledWith(
      "/projects/p1/conta?mes=2026-08&focus=openingBalance&quick=saiuMes&tag=a&tag=b&accountId=acc-b",
      { scroll: false },
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
    expect(onChanged).toHaveBeenCalledTimes(1);
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

  const IMPORTS = [
    {
      id: "imp1",
      periodLabel: "2026-07",
      fileName: "extrato.ofx",
      source: "OFX",
      inserted: 4,
      duplicated: 0,
      totalAmountCents: 40000,
      createdAt: "2026-07-01T12:00:00.000Z",
      deletedAt: null,
    },
  ];
  const DETAIL = {
    importId: "imp1",
    periodLabel: "2026-07",
    fileName: "extrato.ofx",
    createdAt: "2026-07-01T12:00:00.000Z",
    alreadyUndone: false,
    totalAmountCents: 40000,
    impact: {
      expenses: 4,
      cashFlowEntries: 4,
      crossProjectLinks: 0,
      invoiceLiquidations: 1,
    },
  };

  function mockImportsFor(accountId: string) {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/projects/p1/bank-accounts") return Promise.resolve(ACCOUNTS);
      if (path === `/projects/p1/bank-accounts/${accountId}/imports`)
        return Promise.resolve(IMPORTS);
      if (path === `/projects/p1/bank-accounts/${accountId}/imports/imp1`)
        return Promise.resolve(DETAIL);
      return Promise.resolve([]);
    });
  }

  it("cada conta abre o próprio histórico de importações com o accountId correto", async () => {
    mockImportsFor("acc-b");
    renderSection();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Importações de Conta B, final 2222",
      }),
    );

    await waitFor(() =>
      expect(apiGetMock).toHaveBeenCalledWith(
        "/projects/p1/bank-accounts/acc-b/imports",
      ),
    );
    expect(apiGetMock).not.toHaveBeenCalledWith(
      "/projects/p1/bank-accounts/acc-a/imports",
    );
    expect(await screen.findByText(/2026-07 · extrato\.ofx/)).toBeInTheDocument();
  });

  it("desfazer uma importação invalida bank-accounts e chama onChanged", async () => {
    mockImportsFor("acc-a");
    const onChanged = vi.fn();
    renderSection("PESSOAL" as ProjectType, onChanged);
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Importações de Conta A, final 1111",
      }),
    );
    // #569 (blocker 10): a ação da lista tem nome acessível contextual.
    fireEvent.click(
      await screen.findByRole("button", {
        name: /^Desfazer importação 2026-07 · extrato\.ofx/,
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /^Desfazer importação$/i }),
    );

    await waitFor(() =>
      expect(apiDeleteMock).toHaveBeenCalledWith(
        "/projects/p1/bank-accounts/acc-a/imports/imp1",
      ),
    );
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["bank-accounts", "p1"],
    });
    expect(onChanged).toHaveBeenCalled();
  });

  it("sem módulo bankAccounts não expõe a ação Importações", () => {
    hasBankAccountsModule = false;
    renderSection();
    expect(screen.queryByRole("button", { name: /^Importações de/ })).toBeNull();
  });

  it("invalida todos os prefixes financeiros ao salvar pela página Conta", async () => {
    apiGetMock.mockImplementation((path: string) => {
      if (path === "/projects/p1/bank-accounts") {
        return Promise.resolve(ACCOUNTS);
      }
      return new Promise(() => undefined);
    });
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    render(
      <QueryClientProvider client={queryClient}>
        <ContaPage />
      </QueryClientProvider>,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Editar Conta A, final 1111",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() =>
      expect(apiPatchMock).toHaveBeenCalledWith(
        "/projects/p1/bank-accounts/acc-a",
        expect.any(Object),
      ),
    );
    for (const prefix of [
      "account-view",
      "account-view-yearly",
      "dre-overview",
      "monthly-overview",
    ]) {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: [prefix, "p1"],
      });
    }
  });
});
