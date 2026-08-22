import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #490 D-A — CTA duplicado no estado vazio, gêmeo do `/credit-cards`.
 *
 * Sem nenhuma conta a tela mostrava DOIS botões "Nova conta": o do cabeçalho e
 * o do `EmptyState`. Mesma decisão: no vazio a CTA primária é a do `EmptyState`
 * (título + explicação), e o token `data-journey-action` acompanha a CTA viva.
 *
 * ─── QUAL RAMO DA GUARDA U4 ESTE ARQUIVO EXERCITA (#453 / #529) ───────────
 *
 * A guarda do PESSOAL tinha 3 casos; o #529 matou o terceiro e ela ficou com 2:
 *   1. sem `bankAccounts` → replace('/no-permission')
 *   2. com `bankAccounts` → replace('.../conta')   ← INCONDICIONAL
 *
 * Ou seja: em PESSOAL a página legada NÃO renderiza para perfil nenhum, e os
 * dois casos devolvem `null` antes de qualquer CTA. Este arquivo mede a CTA
 * ÚNICA do estado vazio (#490) — propriedade da TELA, que não depende do tipo
 * de projeto. Por isso a fixture passou de PESSOAL para REFORMA: ali
 * `hasNavRoute(REFORMA, 'conta')` é falso, `navCollapsed` nunca liga e a página
 * segue sendo alcançável. Trocou-se o tipo, preservou-se a propriedade.
 *
 * NÃO troque de volta para PESSOAL: o teste ficaria verde medindo uma tela
 * `null`. As âncoras `routerReplace).not.toHaveBeenCalled()` existem para isso
 * — se a guarda passar a disparar aqui, estes testes ficam VERMELHOS em vez de
 * contarem CTAs numa tela em branco. Os ramos da guarda em si são cobertos em
 * `e2e/u4-nav-redirect` (U4-10c/U4-10d).
 */
const accountsResponse: { value: unknown[] } = { value: [] };
const apiGet = vi.fn(async () => accountsResponse.value);
const routerReplace = vi.fn();
let projectType = "REFORMA";
let hasBankAccountsModule = true;
let searchQuery = "";

vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "project-1" }),
  useSearchParams: () => new URLSearchParams(searchQuery),
  useRouter: () => ({
    replace: routerReplace,
    push: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
  }),
}));

vi.mock("@/contexts/project-context", () => ({
  useProject: () => ({
    projectId: "project-1",
    projectType,
    projectName: "Reforma",
  }),
}));

// REFORMA não tem `conta` no nav ⇒ `navCollapsed` é falso ⇒ nenhum ramo da
// guarda dispara e a página renderiza. O módulo segue mockado porque a página
// o consulta; o que mudou foi o TIPO, não a permissão.
vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({
    hasModule: (slug: string) =>
      slug === "bankAccounts" && hasBankAccountsModule,
  }),
}));

vi.mock("@/lib/api", () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...(args as [])),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import BankAccountsPage from "./page";

function repeatedLabels() {
  const labels = screen
    .getAllByRole("button")
    .map((button) => (button.textContent ?? "").trim())
    .filter(Boolean);
  return labels.filter((label, index) => labels.indexOf(label) !== index);
}

describe("BankAccountsPage — CTA única no estado vazio (#490)", () => {
  beforeEach(() => {
    accountsResponse.value = [];
    projectType = "REFORMA";
    hasBankAccountsModule = true;
    searchQuery = "";
    apiGet.mockClear();
    routerReplace.mockClear();
  });

  it('não repete o rótulo "Nova conta" quando não há nenhuma conta', async () => {
    render(<BankAccountsPage />);
    expect(
      await screen.findByText("Nenhuma conta cadastrada"),
    ).toBeInTheDocument();

    expect(repeatedLabels()).toEqual([]);
    expect(screen.getAllByRole("button", { name: /Nova conta/ })).toHaveLength(
      1,
    );
    // Caso 3 da guarda U4: nada de redirect — a página legada é o que se mede.
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it("mantém o token de jornada bank-account.new exatamente uma vez no estado vazio", async () => {
    const { container } = render(<BankAccountsPage />);
    expect(
      await screen.findByText("Nenhuma conta cadastrada"),
    ).toBeInTheDocument();

    expect(
      container.querySelectorAll('[data-journey-action="bank-account.new"]'),
    ).toHaveLength(1);
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it("devolve a CTA do cabeçalho quando já existe conta", async () => {
    accountsResponse.value = [
      {
        id: "acc-1",
        last4: "9876",
        institution: "Itaú",
        nickname: "Conta",
        balanceCents: 1000,
      },
    ];
    const { container } = render(<BankAccountsPage />);
    expect(
      await screen.findByRole("button", { name: /Nova conta/ }),
    ).toBeInTheDocument();

    expect(repeatedLabels()).toEqual([]);
    expect(
      container.querySelectorAll('[data-journey-action="bank-account.new"]'),
    ).toHaveLength(1);
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it("redireciona o PESSOAL sem consultar a API da página legada", async () => {
    projectType = "PESSOAL";
    searchQuery = "focus=openingBalance&tag=a&tag=b";

    render(<BankAccountsPage />);

    await waitFor(() =>
      expect(routerReplace).toHaveBeenCalledWith(
        "/projects/project-1/conta?focus=openingBalance&tag=a&tag=b",
      ),
    );
    expect(apiGet).not.toHaveBeenCalled();
  });

  it("nega permissão sem consultar a API da página legada", async () => {
    projectType = "PESSOAL";
    hasBankAccountsModule = false;

    render(<BankAccountsPage />);

    await waitFor(() =>
      expect(routerReplace).toHaveBeenCalledWith("/no-permission"),
    );
    expect(apiGet).not.toHaveBeenCalled();
  });
});
