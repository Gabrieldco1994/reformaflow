import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectType } from "@reformaflow/domain";
import { RegisterForm } from "./_components/RegisterForm";
import {
  JourneyRuntimeProvider,
  useJourneyRuntime,
} from "@/contexts/journey-runtime-context";

const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  refresh: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  notifyError: vi.fn(),
  user: null as { id: string } | null,
}));
vi.mock("sonner", () => ({ toast: { error: mocks.notifyError } }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/register",
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
}));
vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({
    user: mocks.user,
    loading: false,
    register: mocks.register,
    refresh: mocks.refresh,
  }),
}));
vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    api: { ...actual.api, get: mocks.get, post: mocks.post },
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  mocks.user = null;
  mocks.register.mockResolvedValue({ id: "user" });
  mocks.refresh.mockResolvedValue(undefined);
  mocks.post.mockResolvedValue({ id: "pessoal", type: "PESSOAL" });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
const journey = [
  {
    journeyId: "onboarding",
    key: "onboarding:pessoal",
    name: "Primeiros passos",
    triggerId: "created",
    repeatPolicy: "ONCE_PER_PROJECT",
    dismissPolicy: "DISMISS_UNTIL_LOGIN",
    crossProject: false,
    steps: [
      {
        stepKey: "conta",
        order: 0,
        experience: "FULL",
        label: "Conta",
        subtitle: null,
        skippable: false,
        slug: "conta",
      },
    ],
  },
];

it("delayed authenticated project-created handler is the sole signup navigation authority", async () => {
  let resolve!: (value: unknown) => void;
  const eligibility = new Promise((done) => {
    resolve = done;
  });
  mocks.get.mockImplementation((path: string) => {
    if (path === "/projects/pessoal")
      return Promise.resolve({ type: "PESSOAL" });
    const trigger = new URL(path, "http://localhost").searchParams.get(
      "triggerType",
    );
    return trigger === "PROJECT_CREATED" ? eligibility : Promise.resolve([]);
  });

  const content = () => (
    <JourneyRuntimeProvider>
      <main>
        <RegisterForm />
      </main>
    </JourneyRuntimeProvider>
  );
  const { rerender } = render(content());
  const browser = userEvent.setup();
  await browser.type(screen.getByLabelText("Seu nome"), "Maria");
  await browser.type(screen.getByLabelText("Email"), "maria@example.com");
  await browser.type(screen.getByLabelText("Senha"), "segredo123");
  await browser.click(
    screen.getByRole("checkbox", { name: /organizar minha vida financeira/i }),
  );
  await browser.click(
    screen.getByRole("button", { name: /criar minha conta/i }),
  );
  await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
  // register/refresh resolve while the submit closure still sees user=null.
  expect(mocks.replace).not.toHaveBeenCalled();
  act(() => {
    mocks.user = { id: "user" };
    rerender(content());
  });
  await waitFor(() =>
    expect(
      mocks.get.mock.calls.some(([path]) =>
        String(path).includes("PROJECT_CREATED"),
      ),
    ).toBe(true),
  );
  expect(mocks.push).not.toHaveBeenCalled();
  expect(mocks.replace).not.toHaveBeenCalled();
  await act(async () => {
    resolve(journey);
  });
  await waitFor(() =>
    expect(mocks.push).toHaveBeenCalledWith("/projects/pessoal/conta"),
  );
  expect(mocks.push).toHaveBeenCalledTimes(1);
  expect(mocks.replace).not.toHaveBeenCalled();
  expect(
    mocks.get.mock.calls.some(([path]) =>
      String(path).includes("SIGNUP_COMPLETED"),
    ),
  ).toBe(true);
});

function SignupProbe({ empty = false }: { empty?: boolean }) {
  const { completeSignup, active, next, error } = useJourneyRuntime();
  return (
    <>
      <button
        onClick={() =>
          void completeSignup(
            empty
              ? []
              : [
                  { id: "pessoal", type: ProjectType.PESSOAL },
                  { id: "casa", type: ProjectType.CASA },
                ],
            "user",
          )
        }
      >
        Finish signup
      </button>
      <button onClick={() => void next()}>Next journey</button>
      <output data-testid="active">{active?.projectId}</output>
      <output data-testid="error">{error}</output>
    </>
  );
}

it("keeps each objective's journey and the signup event without competing fallback", async () => {
  mocks.user = { id: "user" };
  mocks.get.mockImplementation((path: string) => {
    if (path.startsWith("/projects/"))
      return Promise.resolve({ type: "PESSOAL" });
    const trigger = new URL(path, "http://localhost").searchParams.get(
      "triggerType",
    );
    return Promise.resolve(trigger === "PROJECT_CREATED" ? journey : []);
  });
  render(
    <JourneyRuntimeProvider>
      <SignupProbe />
    </JourneyRuntimeProvider>,
  );
  await userEvent.setup().click(screen.getByText("Finish signup"));
  await waitFor(() =>
    expect(screen.getByTestId("active")).toHaveTextContent("pessoal"),
  );
  expect(mocks.replace).not.toHaveBeenCalled();
  await userEvent.setup().click(screen.getByText("Next journey"));
  await waitFor(() =>
    expect(mocks.push).toHaveBeenLastCalledWith("/projects/casa/conta"),
  );
  expect(
    mocks.get.mock.calls.some(([path]) =>
      String(path).includes("SIGNUP_COMPLETED"),
    ),
  ).toBe(true);
});

it.each([false, true])(
  "falls back once after eligibility, including no-created-project signup (%s)",
  async (empty) => {
    mocks.user = { id: "user" };
    let resolve!: (value: unknown[]) => void;
    const eligibility = new Promise<unknown[]>((done) => {
      resolve = done;
    });
    mocks.get.mockImplementation((path: string) =>
      path.startsWith("/projects/")
        ? Promise.resolve({ type: "PESSOAL" })
        : eligibility,
    );
    render(
      <JourneyRuntimeProvider>
        <SignupProbe empty={empty} />
      </JourneyRuntimeProvider>,
    );
    await userEvent.setup().click(screen.getByText("Finish signup"));
    expect(mocks.replace).not.toHaveBeenCalled();
    await act(async () => {
      resolve([]);
    });
    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith("/projects"),
    );
    expect(mocks.replace).toHaveBeenCalledOnce();
    expect(mocks.push).not.toHaveBeenCalled();
  },
);

it("late SCREEN_VISIT cannot override signup eligibility and project destination", async () => {
  mocks.user = { id: "user" };
  let resolveScreen!: (value: unknown) => void;
  let resolveCreated!: (value: unknown) => void;
  const screenEligibility = new Promise((done) => {
    resolveScreen = done;
  });
  const createdEligibility = new Promise((done) => {
    resolveCreated = done;
  });
  mocks.get.mockImplementation((path: string) => {
    if (path.startsWith("/projects/"))
      return Promise.resolve({ type: "PESSOAL" });
    const trigger = new URL(path, "http://localhost").searchParams.get(
      "triggerType",
    );
    if (trigger === "SCREEN_VISIT") return screenEligibility;
    return trigger === "PROJECT_CREATED"
      ? createdEligibility
      : Promise.resolve([]);
  });
  render(
    <JourneyRuntimeProvider>
      <SignupProbe />
    </JourneyRuntimeProvider>,
  );
  await waitFor(() =>
    expect(
      mocks.get.mock.calls.some(([path]) =>
        String(path).includes("SCREEN_VISIT"),
      ),
    ).toBe(true),
  );
  await userEvent.setup().click(screen.getByText("Finish signup"));
  await act(async () => {
    resolveCreated(journey);
  });
  await waitFor(() =>
    expect(mocks.push).toHaveBeenCalledWith("/projects/pessoal/conta"),
  );
  await act(async () => {
    resolveScreen([{ ...journey[0], key: "late-screen" }]);
  });
  expect(screen.getByTestId("active")).toHaveTextContent("pessoal");
  expect(mocks.push).toHaveBeenCalledOnce();
  expect(mocks.replace).not.toHaveBeenCalled();
});

it.each([
  "summary",
  "unavailable",
  "type-error",
  "object",
  "null-steps",
] as const)(
  "runtime owns hub fallback for %s journey eligibility",
  async (mode) => {
    mocks.user = { id: "user" };
    mocks.get.mockImplementation((path: string) => {
      if (path.startsWith("/projects/"))
        return Promise.resolve({ type: "PESSOAL" });
      const trigger = new URL(path, "http://localhost").searchParams.get(
        "triggerType",
      );

      if (trigger !== "PROJECT_CREATED") return Promise.resolve([]);
      if (mode === "unavailable")
        return Promise.reject(new Error("Unavailable"));
      if (mode === "type-error") return Promise.resolve(null);
      if (mode === "object") return Promise.resolve({});
      if (mode === "null-steps")
        return Promise.resolve([{ ...journey[0], steps: null }]);
      return Promise.resolve([
        {
          ...journey[0],
          steps: [{ ...journey[0].steps[0], experience: "SUMMARY" }],
        },
      ]);
    });
    render(
      <JourneyRuntimeProvider>
        <SignupProbe />
      </JourneyRuntimeProvider>,
    );
    await userEvent.setup().click(screen.getByText("Finish signup"));
    await waitFor(() =>
      expect(mocks.replace).toHaveBeenCalledWith("/projects"),
    );
    expect(mocks.replace).toHaveBeenCalledOnce();
    expect(mocks.push).not.toHaveBeenCalled();
    if (mode === "summary") {
      expect(screen.getByTestId("error")).toBeEmptyDOMElement();
    } else {
      expect(screen.getByTestId("error")).not.toBeEmptyDOMElement();
      expect(mocks.notifyError).toHaveBeenCalledWith(
        expect.stringMatching(/não foi possível.*jornada/i),
      );
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("[jornadas]"),
        expect.any(Error),
      );
      expect(screen.getByTestId("active")).toBeEmptyDOMElement();
    }
  },
);

it.each([
  ["resolve", null],
  ["reject", null],
  ["resolve", { id: "other-user" }],
  ["reject", { id: "other-user" }],
] as const)(
  "auth change discards late signup %s (%j) without navigation or notification",
  async (settlement, nextUser) => {
    mocks.user = { id: "user" };
    let resolve!: (value: unknown) => void;
    let reject!: (reason: unknown) => void;
    const eligibility = new Promise((done, fail) => {
      resolve = done;
      reject = fail;
    });
    mocks.get.mockImplementation((path: string) => {
      if (path.startsWith("/projects/"))
        return Promise.resolve({ type: "PESSOAL" });
      return new URL(path, "http://localhost").searchParams.get(
        "triggerType",
      ) === "PROJECT_CREATED"
        ? eligibility
        : Promise.resolve([]);
    });
    const content = () => (
      <JourneyRuntimeProvider>
        <SignupProbe />
      </JourneyRuntimeProvider>
    );
    const { rerender } = render(content());
    await userEvent.setup().click(screen.getByText("Finish signup"));
    act(() => {
      mocks.user = nextUser;
      rerender(content());
    });
    await act(async () => {
      if (settlement === "resolve") resolve(journey);
      else reject(new TypeError("Late failure"));
    });
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.notifyError).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    expect(screen.getByTestId("error")).toBeEmptyDOMElement();
    expect(screen.getByTestId("active")).toBeEmptyDOMElement();
  },
);

it("newer signup discards an older rejected generation", async () => {
  mocks.user = { id: "user" };
  let reject!: (reason: unknown) => void;
  const oldEligibility = new Promise((_, fail) => {
    reject = fail;
  });
  let createdReads = 0;
  mocks.get.mockImplementation((path: string) => {
    if (path.startsWith("/projects/"))
      return Promise.resolve({ type: "PESSOAL" });
    if (
      new URL(path, "http://localhost").searchParams.get("triggerType") !==
      "PROJECT_CREATED"
    )
      return Promise.resolve([]);
    return ++createdReads <= 2 ? oldEligibility : Promise.resolve(journey);
  });
  render(
    <JourneyRuntimeProvider>
      <SignupProbe />
    </JourneyRuntimeProvider>,
  );
  const browser = userEvent.setup();
  await browser.click(screen.getByText("Finish signup"));
  await browser.click(screen.getByText("Finish signup"));
  await waitFor(() =>
    expect(mocks.push).toHaveBeenCalledWith("/projects/pessoal/conta"),
  );
  await act(async () => {
    reject(new TypeError("Superseded"));
  });
  expect(mocks.notifyError).not.toHaveBeenCalled();
  expect(console.error).not.toHaveBeenCalled();
  expect(mocks.replace).not.toHaveBeenCalled();
  expect(screen.getByTestId("error")).toBeEmptyDOMElement();
  expect(screen.getByTestId("active")).toHaveTextContent("pessoal");
});

it("a submit callback retained before logout cannot enqueue for the next login", async () => {
  mocks.user = { id: "user" };
  mocks.get.mockResolvedValue([]);
  let retained!: ReturnType<typeof useJourneyRuntime>["completeSignup"];
  let current!: ReturnType<typeof useJourneyRuntime>["completeSignup"];
  function Capture() {
    const runtime = useJourneyRuntime();
    current = runtime.completeSignup;
    if (!retained) retained = runtime.completeSignup;
    return null;
  }
  const content = () => (
    <JourneyRuntimeProvider>
      <Capture />
    </JourneyRuntimeProvider>
  );
  const { rerender } = render(content());
  act(() => {
    mocks.user = null;
    rerender(content());
  });
  await act(async () => {
    await retained([{ id: "pessoal", type: ProjectType.PESSOAL }], "user");
  });
  act(() => {
    mocks.user = { id: "user" };
    rerender(content());
  });
  expect(
    mocks.get.mock.calls.some(([path]) =>
      String(path).includes("PROJECT_CREATED"),
    ),
  ).toBe(false);
  expect(mocks.push).not.toHaveBeenCalled();
  expect(mocks.replace).not.toHaveBeenCalled();
  expect(mocks.notifyError).not.toHaveBeenCalled();
  await act(async () => {
    await current([{ id: "fresh-project", type: ProjectType.PESSOAL }], "user");
  });
  expect(
    mocks.get.mock.calls.some(([path]) =>
      String(path).includes("projectId=fresh-project"),
    ),
  ).toBe(true);
  expect(mocks.replace).toHaveBeenCalledWith("/projects");
});

it("pre-auth pending signup cannot transfer to a different account", async () => {
  mocks.user = null;
  mocks.get.mockResolvedValue([]);
  const content = () => (
    <JourneyRuntimeProvider>
      <SignupProbe />
    </JourneyRuntimeProvider>
  );
  const { rerender } = render(content());
  await userEvent.setup().click(screen.getByText("Finish signup"));
  act(() => {
    mocks.user = { id: "other-user" };
    rerender(content());
  });
  expect(
    mocks.get.mock.calls.some(([path]) =>
      String(path).includes("PROJECT_CREATED"),
    ),
  ).toBe(false);
  expect(mocks.replace).not.toHaveBeenCalled();
  expect(mocks.push).not.toHaveBeenCalled();
  expect(mocks.notifyError).not.toHaveBeenCalled();
  expect(screen.getByTestId("active")).toBeEmptyDOMElement();
});
