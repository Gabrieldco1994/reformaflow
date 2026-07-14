import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ALL_MODULES,
  AuthProvider,
  type AuthUser,
  useAuth,
} from "./auth-context";

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ api: apiMocks }));

const user: AuthUser = {
  id: "u1",
  username: "maria",
  name: "Maria",
  role: "USER",
  tenantId: "t1",
  allowedProjectTypes: ["CASA"],
  allowedModules: [
    "dashboard",
    "expenses",
    "recurringBills",
    "maintenance",
    "reminders",
  ],
  allowedProjects: [],
};

type OnboardingAuth = ReturnType<typeof useAuth> & {
  register: (input: {
    tenantName: string;
    ownerName: string;
    username: string;
    password: string;
    confirmationPassword: string;
    objectives: string[];
  }) => Promise<AuthUser>;
  updateObjectives: (objectives: string[]) => Promise<AuthUser>;
};

function Probe() {
  const auth = useAuth() as OnboardingAuth;
  return (
    <>
      <output data-testid="user">{JSON.stringify(auth.user)}</output>
      <output data-testid="carro-access">
        {String(auth.hasProjectType("CARRO"))}
      </output>
      <output data-testid="register-contract">{typeof auth.register}</output>
      <output data-testid="objectives-contract">
        {typeof auth.updateObjectives}
      </output>
      {typeof auth.register === "function" && (
        <button
          onClick={() =>
            auth.register({
              tenantName: "Acme",
              ownerName: "Maria",
              username: "maria",
              password: "segredo",
              confirmationPassword: "segredo",
              objectives: ["CASA"],
            })
          }
        >
          Register
        </button>
      )}
      {typeof auth.updateObjectives === "function" && (
        <button onClick={() => auth.updateObjectives(["PLANTAS"])}>
          Update objectives
        </button>
      )}
    </>
  );
}

describe("ALL_MODULES finance entry", () => {
  it("labels the unchanged financialDashboard slug as Financeiro", () => {
    expect(
      ALL_MODULES.filter(({ slug }) => slug === "financialDashboard"),
    ).toEqual([{ slug: "financialDashboard", label: "Financeiro" }]);
  });
});

describe("AuthProvider SaaS session contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses explicit objective types instead of inferring a shared type from modules", async () => {
    apiMocks.get.mockResolvedValue(user);
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );

    await waitFor(() => expect(apiMocks.get).toHaveBeenCalledWith("/auth/me"));
    expect(screen.getByTestId("carro-access")).toHaveTextContent("false");
  });

  it("registers once and replaces the response with a fresh /auth/me session", async () => {
    const stale = { ...user, allowedProjectTypes: [], allowedModules: [] };
    const fresh = { ...user, allowedProjectTypes: ["CASA"] };
    apiMocks.get.mockResolvedValueOnce(null).mockResolvedValueOnce(fresh);
    apiMocks.post.mockResolvedValue({ user: stale });
    const browser = userEvent.setup();

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(apiMocks.get).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("register-contract")).toHaveTextContent(
      "function",
    );
    await browser.click(screen.getByRole("button", { name: "Register" }));

    await waitFor(() => expect(apiMocks.get).toHaveBeenCalledTimes(2));
    expect(apiMocks.post).toHaveBeenCalledTimes(1);
    expect(apiMocks.post).toHaveBeenCalledWith("/auth/register", {
      tenantName: "Acme",
      ownerName: "Maria",
      username: "maria",
      password: "segredo",
      confirmationPassword: "segredo",
      objectives: ["CASA"],
    });
    expect(screen.getByTestId("user")).toHaveTextContent(JSON.stringify(fresh));
  });

  it("updates objectives and refreshes authorization immediately", async () => {
    const fresh = {
      ...user,
      allowedProjectTypes: ["PLANTAS"],
      allowedModules: ["dashboard", "maintenance", "reminders", "plantsAi"],
    };
    apiMocks.get.mockResolvedValueOnce(user).mockResolvedValueOnce(fresh);
    apiMocks.patch.mockResolvedValue({ objectives: ["PLANTAS"] });
    const browser = userEvent.setup();

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(apiMocks.get).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("objectives-contract")).toHaveTextContent(
      "function",
    );
    await browser.click(
      screen.getByRole("button", { name: "Update objectives" }),
    );

    await waitFor(() => expect(apiMocks.get).toHaveBeenCalledTimes(2));
    expect(apiMocks.patch).toHaveBeenCalledTimes(1);
    expect(apiMocks.patch).toHaveBeenCalledWith("/auth/objectives", {
      objectives: ["PLANTAS"],
    });
    expect(screen.getByTestId("user")).toHaveTextContent(JSON.stringify(fresh));
  });
});
