import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, type AuthUser, useAuth } from "./auth-context";

/**
 * #505 — a metade CLIENTE do portão de visibilidade.
 *
 * O conserto primário é a cunhagem honesta no servidor (`registerGuest` grava
 * papel sem acesso total + grants reais). Isto aqui é a segunda camada: o
 * cliente não pode conceder o aplicativo inteiro só porque o papel diz
 * "ADMIN". Sem ela, qualquer sessão em cache de versão antiga — ou qualquer
 * regressão futura na cunhagem — volta a vazar o menu completo.
 *
 * `isAdmin` é derivado UMA vez e alimenta os QUATRO predicados (`hasModule`,
 * `hasProjectType`, `hasProjectAccess`, `canCreateProjectType`), então o
 * `isGuest` entra nessa derivação única e não em quatro remendos.
 */

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMocks }));

function Probe() {
  const auth = useAuth();
  return (
    <>
      <output data-testid="is-admin">{String(auth.isAdmin)}</output>
      <output data-testid="mod-granted">
        {String(auth.hasModule("expenses"))}
      </output>
      <output data-testid="mod-ungranted">
        {String(auth.hasModule("financing"))}
      </output>
      <output data-testid="type-granted">
        {String(auth.hasProjectType("PESSOAL"))}
      </output>
      <output data-testid="type-ungranted">
        {String(auth.hasProjectType("CARRO"))}
      </output>
      <output data-testid="project-access">
        {String(auth.hasProjectAccess("p-outside"))}
      </output>
      <output data-testid="can-create-ungranted">
        {String(auth.canCreateProjectType("CARRO"))}
      </output>
    </>
  );
}

async function renderAs(sessionUser: AuthUser) {
  apiMocks.get.mockResolvedValue(sessionUser);
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  await waitFor(() => expect(apiMocks.get).toHaveBeenCalledWith("/auth/me"));
}

describe("#505 — convidado de demonstração não herda o aplicativo pelo papel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Sessão legada / defesa em profundidade: mesmo que algo volte a entregar
   * `role: 'ADMIN'` para um convidado, o cliente não pode abrir tudo.
   */
  const legacyGuest: AuthUser = {
    id: "g1",
    username: "guest_abc",
    name: "Convidado",
    role: "ADMIN",
    tenantId: "t-guest",
    isGuest: true,
    allowedProjectTypes: ["PESSOAL", "REFORMA"],
    allowedModules: ["dashboard", "expenses"],
    allowedProjects: ["p-demo"],
  };

  it("não é tratado como administrador", async () => {
    await renderAs(legacyGuest);
    expect(screen.getByTestId("is-admin")).toHaveTextContent("false");
  });

  it("enxerga o módulo concedido e SÓ ele", async () => {
    await renderAs(legacyGuest);
    expect(screen.getByTestId("mod-granted")).toHaveTextContent("true");
    expect(screen.getByTestId("mod-ungranted")).toHaveTextContent("false");
  });

  it("enxerga o tipo de projeto concedido e SÓ ele", async () => {
    await renderAs(legacyGuest);
    expect(screen.getByTestId("type-granted")).toHaveTextContent("true");
    expect(screen.getByTestId("type-ungranted")).toHaveTextContent("false");
  });

  it("não alcança projeto fora da própria lista, nem cria tipo não concedido", async () => {
    await renderAs(legacyGuest);
    expect(screen.getByTestId("project-access")).toHaveTextContent("false");
    expect(screen.getByTestId("can-create-ungranted")).toHaveTextContent(
      "false",
    );
  });
});

/**
 * #505 — trava de regressão das TRÊS contas reais de produção.
 *
 * Medido em produção (2026-08-20): 200 usuários, 0 convidados, 3 contas
 * ADMIN/OWNER com `allowedModules` vazio. Elas dependem do curto-circuito de
 * papel para enxergar qualquer coisa.
 *
 * A chave do convidado é `isGuest` — NUNCA "grants vazios". Se alguém trocar
 * uma pela outra, estas asserções apagam junto com o menu dessas contas.
 */
describe("#505 — ADMIN real sem grants continua enxergando tudo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const adminWithoutGrants: AuthUser = {
    id: "u-admin",
    username: "admin",
    name: "Admin Real",
    role: "ADMIN",
    tenantId: "t-1",
    isGuest: false,
    allowedProjectTypes: [],
    allowedModules: [],
    allowedProjects: [],
  };

  it("é administrador e enxerga módulo que não está em grant nenhum", async () => {
    await renderAs(adminWithoutGrants);
    expect(screen.getByTestId("is-admin")).toHaveTextContent("true");
    expect(screen.getByTestId("mod-ungranted")).toHaveTextContent("true");
  });

  it("alcança qualquer tipo e qualquer projeto", async () => {
    await renderAs(adminWithoutGrants);
    expect(screen.getByTestId("type-ungranted")).toHaveTextContent("true");
    expect(screen.getByTestId("project-access")).toHaveTextContent("true");
    expect(screen.getByTestId("can-create-ungranted")).toHaveTextContent(
      "true",
    );
  });

  /**
   * `isGuest` é opcional no tipo (sessão em cache de versão antiga não o
   * traz). Ausente NÃO pode significar convidado, ou toda sessão antiga de
   * administrador perde o menu no primeiro deploy.
   */
  it("sessão antiga sem o campo isGuest continua sendo administrador", async () => {
    const { isGuest: _omit, ...legacySession } = adminWithoutGrants;
    await renderAs(legacySession as AuthUser);
    expect(screen.getByTestId("is-admin")).toHaveTextContent("true");
  });
});
