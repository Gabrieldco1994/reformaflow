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
    projectTypes: string[];
  }, idempotencyKey: string) => Promise<AuthUser>;
  updateObjectives: (projectTypes: string[]) => Promise<void>;
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
              password: "segredo1",
              projectTypes: ["CASA"],
            }, "idem-1")
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
      <button onClick={() => auth.login("maria", "segredo1")}>
        Login with username
      </button>
      <button onClick={() => auth.login("Maria@Example.com", "segredo1")}>
        Login with email
      </button>
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

  it("registers once and installs the canonical response session", async () => {
    apiMocks.get.mockResolvedValueOnce(null);
    apiMocks.post.mockResolvedValue({ user });
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

    await waitFor(() => expect(apiMocks.post).toHaveBeenCalledTimes(1));
    expect(apiMocks.post).toHaveBeenCalledTimes(1);
    expect(apiMocks.post).toHaveBeenCalledWith(
      "/auth/register",
      {
        tenantName: "Acme",
        ownerName: "Maria",
        username: "maria",
        password: "segredo1",
        projectTypes: ["CASA"],
      },
      { headers: { "Idempotency-Key": "idem-1" } },
    );
    expect(screen.getByTestId("user")).toHaveTextContent(JSON.stringify(user));
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
      projectTypes: ["PLANTAS"],
    });
    expect(screen.getByTestId("user")).toHaveTextContent(JSON.stringify(fresh));
  });

  it("routes a plain identifier as username and an e-mail as email on login", async () => {
    apiMocks.get.mockResolvedValueOnce(null);
    apiMocks.post.mockResolvedValue({ user });
    const browser = userEvent.setup();

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    await waitFor(() => expect(apiMocks.get).toHaveBeenCalledTimes(1));

    await browser.click(screen.getByRole("button", { name: "Login with username" }));
    await waitFor(() => expect(apiMocks.post).toHaveBeenCalledWith("/auth/login", {
      username: "maria",
      password: "segredo1",
    }));

    await browser.click(screen.getByRole("button", { name: "Login with email" }));
    await waitFor(() => expect(apiMocks.post).toHaveBeenCalledWith("/auth/login", {
      email: "maria@example.com",
      password: "segredo1",
    }));
  });
});
