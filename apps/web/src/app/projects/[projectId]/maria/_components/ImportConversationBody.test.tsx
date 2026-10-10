import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ExpenseType, type ImportSessionViewV1 } from "@reformaflow/domain";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  currentLotFixture,
  declarationQuestionFixture,
  declarationViewFixture,
  declaredFactFixture,
} from "../_lib/import-workflow-fixtures";
import { ImportConversationBody } from "./ImportConversationBody";

const auth = vi.hoisted(() => ({
  user: { id: "actor-a" } as { id: string } | null,
}));
vi.mock("@/contexts/auth-context", () => ({ useAuth: () => auth }));
vi.mock("@/contexts/project-context", () => ({
  useProject: () => ({ projectId: "personal", projectType: "PESSOAL" }),
}));
vi.mock("@/components/agent/useSpeechRecognition", () => ({
  useSpeechRecognition: () => ({
    supported: false,
    listening: false,
    start: vi.fn(),
    stop: vi.fn(),
  }),
}));

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollIntoView",
);
const documents = {
  busy: false,
  error: null,
  analyze: vi.fn(),
  recover: vi.fn(),
} as never;

describe("ImportConversationBody guided CSV contract", () => {
  let client: QueryClient;
  let current: ImportSessionViewV1;
  let requests: Array<{
    path: string;
    method: string;
    body: Record<string, unknown> | null;
  }>;

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    auth.user = { id: "actor-a" };
    current = declarationViewFixture();
    current.questions = [
      {
        ...declarationQuestionFixture(),
        text: "RAW_TECHNICAL_QUESTION amountCents observation-first",
      },
      declarationQuestionFixture("twin"),
    ];
    requests = [];
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options?: RequestInit) => {
        const path = new URL(url).pathname;
        const method = options?.method ?? "GET";
        const body = options?.body
          ? (JSON.parse(String(options.body)) as Record<string, unknown>)
          : null;
        requests.push({ path, method, body });
        if (method === "GET") return response(current);
        throw new Error(`Unexpected request: ${method} ${path}`);
      }),
    );
  });

  afterEach(() => {
    client.clear();
    vi.unstubAllGlobals();
    if (scrollIntoViewDescriptor)
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollIntoView",
        scrollIntoViewDescriptor,
      );
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });

  function mount(after?: ReactNode) {
    return render(
      <QueryClientProvider client={client}>
        <ImportConversationBody sessionId="session-a" documents={documents} />
        {after}
      </QueryClientProvider>,
    );
  }

  it("renders one focused purchase with guided Portuguese copy, never raw server text", async () => {
    mount();
    expect(
      await screen.findByRole("heading", {
        name: "Qual é o total da compra?",
      }),
    ).toBeVisible();
    expect(screen.getByRole("region", { name: "Compra 1 de 2" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Compra 2 de 2" })).toBeNull();
    expect(document.body).not.toHaveTextContent("RAW_TECHNICAL_QUESTION");
    expect(document.body).not.toHaveTextContent("observation-first");
  });

  it("stores a declaration through the dedicated command and advances after reread", async () => {
    const fetchStub = vi.mocked(fetch);
    fetchStub.mockImplementation(
      async (input: RequestInfo | URL, options?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const method = options?.method ?? "GET";
        const body = options?.body
          ? (JSON.parse(String(options.body)) as Record<string, unknown>)
          : null;
        requests.push({ path, method, body });
        if (method === "GET") return response(current);
        if (path.endsWith("/declarations")) {
          current = {
            ...current,
            revision: 8,
            questions: [
              declarationQuestionFixture("first", "DECLARED"),
              declarationQuestionFixture("twin"),
            ],
            declaredFacts: [declaredFactFixture()],
          };
          return response({
            version: 1,
            requestId: body?.requestId,
            operation: "DECLARE",
            outcome: "APPLIED",
            revision: 8,
          });
        }
        throw new Error(`Unexpected request: ${method} ${path}`);
      },
    );
    const user = userEvent.setup();
    mount();
    const input = await screen.findByRole("textbox", {
      name: "Sua resposta",
    });
    await user.type(input, "206,96");
    await user.click(
      screen.getByRole("button", { name: "Conferir informação" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Guardar e continuar" }),
    );

    await screen.findByRole("region", { name: "Compra 2 de 2" });
    const declaration = requests.find(({ path }) =>
      path.endsWith("/declarations"),
    );
    expect(declaration?.body).toEqual({
      version: 1,
      requestId: expect.any(String),
      expectedRevision: 7,
      questionId: "oq_first_amount",
      answer: { kind: "KNOWN", value: 20696 },
    });
    expect(
      requests.some(
        ({ path, method }) => path === "/agent/chat" || method === "PATCH",
      ),
    ).toBe(false);
  });

  it("defers and reactivates one line with dedicated idempotent commands", async () => {
    const fetchStub = vi.mocked(fetch);
    fetchStub.mockImplementation(
      async (input: RequestInfo | URL, options?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const method = options?.method ?? "GET";
        const body = options?.body
          ? (JSON.parse(String(options.body)) as Record<string, unknown>)
          : null;
        requests.push({ path, method, body });
        if (method === "GET") return response(current);
        const operation = path.endsWith("/defer") ? "DEFER" : "REACTIVATE";
        if (!["DEFER", "REACTIVATE"].includes(operation))
          throw new Error(`Unexpected request: ${method} ${path}`);
        const lineId = String(body?.lineId);
        current = {
          ...current,
          revision: current.revision + 1,
          selectedLineIds:
            operation === "DEFER"
              ? current.selectedLineIds.filter((id) => id !== lineId)
              : [...current.selectedLineIds, lineId],
          lines: current.lines.map((line) =>
            line.id === lineId
              ? {
                  ...line,
                  decision:
                    operation === "DEFER"
                      ? ({ kind: "DEFER" } as const)
                      : ({ kind: "UNRESOLVED" } as const),
                }
              : line,
          ),
        };
        return response({
          version: 1,
          requestId: body?.requestId,
          operation,
          outcome: "APPLIED",
          revision: current.revision,
        });
      },
    );
    const user = userEvent.setup();
    mount();
    await screen.findByRole("region", { name: "Compra 1 de 2" });
    await user.click(screen.getByRole("button", { name: "Responder depois" }));

    await screen.findByRole("region", { name: "Compra 2 de 2" });
    const deferred = screen.getByText(
      "Compras para retomar depois",
    ).parentElement;
    expect(deferred).not.toBeNull();
    if (!deferred) throw new Error("Missing deferred list");
    await user.click(
      within(deferred).getByRole("button", { name: /Continuar compra/ }),
    );

    await waitFor(() =>
      expect(
        requests
          .filter(({ path }) => /\/(defer|reactivate)$/.test(path))
          .map(({ path }) => path),
      ).toEqual([
        "/import-sessions/session-a/defer",
        "/import-sessions/session-a/reactivate",
      ]),
    );
    for (const command of requests.filter(({ path }) =>
      /\/(defer|reactivate)$/.test(path),
    )) {
      expect(command.body).toMatchObject({
        version: 1,
        requestId: expect.any(String),
        lineId: "first",
      });
    }
  });

  it("reconciles a commit-before-abort only through Consultar, without replaying the write", async () => {
    let authoritativeApplications = 0;
    let receiptCreations = 0;
    const serverEvents: string[] = [];
    const fetchStub = vi.mocked(fetch);
    fetchStub.mockImplementation(
      async (input: RequestInfo | URL, options?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const method = options?.method ?? "GET";
        const body = options?.body
          ? (JSON.parse(String(options.body)) as Record<string, unknown>)
          : null;
        requests.push({ path, method, body });
        if (method === "GET") return response(current);
        if (!path.endsWith("/defer"))
          throw new Error(`Unexpected request: ${method} ${path}`);

        const lineId = String(body?.lineId);
        current = {
          ...current,
          revision: 8,
          selectedLineIds: current.selectedLineIds.filter(
            (id) => id !== lineId,
          ),
          lines: current.lines.map((line) =>
            line.id === lineId
              ? { ...line, decision: { kind: "DEFER" as const } }
              : line,
          ),
        };
        authoritativeApplications++;
        serverEvents.push("authoritative mutation revision 8");
        receiptCreations++;
        serverEvents.push("durable receipt revision 8");
        serverEvents.push("response connection reset");
        throw new TypeError("connection reset after authoritative commit");
      },
    );
    const user = userEvent.setup();
    mount();
    await screen.findByRole("region", { name: "Compra 1 de 2" });
    const requestOffset = requests.length;

    await user.click(screen.getByRole("button", { name: "Responder depois" }));

    const consult = await screen.findByRole("button", {
      name: "Consultar estado guardado",
    });
    expect(consult).toBeVisible();
    expect(consult).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Repetir esta tentativa" }),
    ).toBeNull();
    expect(serverEvents).toEqual([
      "authoritative mutation revision 8",
      "durable receipt revision 8",
      "response connection reset",
    ]);
    expect(authoritativeApplications).toBe(1);
    expect(receiptCreations).toBe(1);
    expect(current.revision).toBe(8);
    expect(current.selectedLineIds).not.toContain("first");

    await user.click(consult);

    await screen.findByRole("region", { name: "Compra 2 de 2" });
    const deferred = screen.getByText(
      "Compras para retomar depois",
    ).parentElement;
    expect(deferred).not.toBeNull();
    if (!deferred) throw new Error("Missing deferred list");
    expect(
      within(deferred).getByRole("button", {
        name: "Continuar compra 1 de 2",
      }),
    ).toBeEnabled();
    const commands = requests.filter(({ path }) => path.endsWith("/defer"));
    expect(commands).toHaveLength(1);
    expect(commands[0].body).toEqual({
      version: 1,
      requestId: expect.any(String),
      expectedRevision: 7,
      lineId: "first",
    });
    expect(
      requests
        .slice(requestOffset)
        .map(({ method, path }) => `${method} ${path}`),
    ).toEqual([
      "POST /import-sessions/session-a/defer",
      "GET /import-sessions/session-a",
    ]);
    expect(authoritativeApplications).toBe(1);
    expect(receiptCreations).toBe(1);
    expect(current.revision).toBe(8);
    expect(current.lines.find(({ id }) => id === "first")?.decision).toEqual({
      kind: "DEFER",
    });
    expect(
      requests.some(
        ({ path }) =>
          path === "/agent/chat" ||
          /\/(interpretations|confirmation-challenge|confirm|execute)$/.test(
            path,
          ),
      ),
    ).toBe(false);
  });

  it("offers the retained write only after Consultar proves the first defer was not applied", async () => {
    let deferAttempts = 0;
    let authoritativeApplications = 0;
    const fetchStub = vi.mocked(fetch);
    fetchStub.mockImplementation(
      async (input: RequestInfo | URL, options?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const method = options?.method ?? "GET";
        const body = options?.body
          ? (JSON.parse(String(options.body)) as Record<string, unknown>)
          : null;
        requests.push({ path, method, body });
        if (method === "GET") return response(current);
        if (!path.endsWith("/defer"))
          throw new Error(`Unexpected request: ${method} ${path}`);
        deferAttempts++;
        if (deferAttempts === 1)
          throw new TypeError("connection reset before commit");

        const lineId = String(body?.lineId);
        current = {
          ...current,
          revision: 8,
          selectedLineIds: current.selectedLineIds.filter(
            (id) => id !== lineId,
          ),
          lines: current.lines.map((line) =>
            line.id === lineId
              ? { ...line, decision: { kind: "DEFER" as const } }
              : line,
          ),
        };
        authoritativeApplications++;
        return response({
          version: 1,
          requestId: body?.requestId,
          operation: "DEFER",
          outcome: "APPLIED",
          revision: current.revision,
        });
      },
    );
    const user = userEvent.setup();
    mount();
    await screen.findByRole("region", { name: "Compra 1 de 2" });
    const requestOffset = requests.length;

    await user.click(screen.getByRole("button", { name: "Responder depois" }));

    const consult = await screen.findByRole("button", {
      name: "Consultar estado guardado",
    });
    expect(consult).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Repetir esta tentativa" }),
    ).toBeNull();
    await user.click(consult);

    const retry = await screen.findByRole("button", {
      name: "Repetir esta tentativa",
    });
    expect(retry).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "Consultar estado guardado" }),
    ).toBeNull();
    expect(authoritativeApplications).toBe(0);
    await user.click(retry);

    await screen.findByRole("region", { name: "Compra 2 de 2" });
    const commands = requests.filter(({ path }) => path.endsWith("/defer"));
    expect(commands).toHaveLength(2);
    expect(commands[1].body).toEqual(commands[0].body);
    expect(
      requests
        .slice(requestOffset)
        .map(({ method, path }) => `${method} ${path}`),
    ).toEqual([
      "POST /import-sessions/session-a/defer",
      "GET /import-sessions/session-a",
      "POST /import-sessions/session-a/defer",
      "GET /import-sessions/session-a",
    ]);
    expect(authoritativeApplications).toBe(1);
    expect(current.revision).toBe(8);
    expect(current.selectedLineIds).not.toContain("first");
    expect(
      requests.some(
        ({ path }) =>
          path === "/agent/chat" ||
          /\/(interpretations|confirmation-challenge|confirm|execute)$/.test(
            path,
          ),
      ),
    ).toBe(false);
  });

  it("moves focus to Consultar while a lost defer still requires authoritative verification", async () => {
    const fetchStub = vi.mocked(fetch);
    fetchStub.mockImplementation(
      async (input: RequestInfo | URL, options?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const method = options?.method ?? "GET";
        const body = options?.body
          ? (JSON.parse(String(options.body)) as Record<string, unknown>)
          : null;
        requests.push({ path, method, body });
        if (method === "GET") return response(current);
        if (path.endsWith("/defer"))
          throw new TypeError("connection reset before commit");
        throw new Error(`Unexpected request: ${method} ${path}`);
      },
    );
    const user = userEvent.setup();
    mount();
    await screen.findByRole("region", { name: "Compra 1 de 2" });

    await user.click(screen.getByRole("button", { name: "Responder depois" }));

    const consult = await screen.findByRole("button", {
      name: "Consultar estado guardado",
    });
    expect(consult).toBeEnabled();
    await waitFor(() => expect(consult).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).not.toBeDisabled();
  });

  it("announces RETRY_READY with exact status copy", async () => {
    const fetchStub = vi.mocked(fetch);
    fetchStub.mockImplementation(
      async (input: RequestInfo | URL, options?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const method = options?.method ?? "GET";
        const body = options?.body
          ? (JSON.parse(String(options.body)) as Record<string, unknown>)
          : null;
        requests.push({ path, method, body });
        if (method === "GET") return response(current);
        if (path.endsWith("/defer"))
          throw new TypeError("connection reset before commit");
        throw new Error(`Unexpected request: ${method} ${path}`);
      },
    );
    const user = userEvent.setup();
    mount();
    await screen.findByRole("region", { name: "Compra 1 de 2" });
    await user.click(screen.getByRole("button", { name: "Responder depois" }));
    await user.click(
      await screen.findByRole("button", {
        name: "Consultar estado guardado",
      }),
    );

    expect(await screen.findByRole("status")).toHaveTextContent(
      "A tentativa não foi guardada. Você pode repeti-la.",
    );
  });

  it("moves focus to Repetir only after the authoritative read proves no commit", async () => {
    const fetchStub = vi.mocked(fetch);
    fetchStub.mockImplementation(
      async (input: RequestInfo | URL, options?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const method = options?.method ?? "GET";
        const body = options?.body
          ? (JSON.parse(String(options.body)) as Record<string, unknown>)
          : null;
        requests.push({ path, method, body });
        if (method === "GET") return response(current);
        if (path.endsWith("/defer"))
          throw new TypeError("connection reset before commit");
        throw new Error(`Unexpected request: ${method} ${path}`);
      },
    );
    const user = userEvent.setup();
    mount();
    await screen.findByRole("region", { name: "Compra 1 de 2" });
    await user.click(screen.getByRole("button", { name: "Responder depois" }));
    await user.click(
      await screen.findByRole("button", {
        name: "Consultar estado guardado",
      }),
    );

    const retry = await screen.findByRole("button", {
      name: "Repetir esta tentativa",
    });
    expect(retry).toBeEnabled();
    await waitFor(() => expect(retry).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).not.toBeDisabled();
  });

  it("moves focus to the first enabled input when an applied defer reveals the next question", async () => {
    const fetchStub = vi.mocked(fetch);
    fetchStub.mockImplementation(
      async (input: RequestInfo | URL, options?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const method = options?.method ?? "GET";
        const body = options?.body
          ? (JSON.parse(String(options.body)) as Record<string, unknown>)
          : null;
        requests.push({ path, method, body });
        if (method === "GET") return response(current);
        if (!path.endsWith("/defer"))
          throw new Error(`Unexpected request: ${method} ${path}`);
        const lineId = String(body?.lineId);
        current = {
          ...current,
          revision: 8,
          selectedLineIds: current.selectedLineIds.filter(
            (id) => id !== lineId,
          ),
          lines: current.lines.map((line) =>
            line.id === lineId
              ? { ...line, decision: { kind: "DEFER" as const } }
              : line,
          ),
        };
        return response({
          version: 1,
          requestId: body?.requestId,
          operation: "DEFER",
          outcome: "APPLIED",
          revision: 8,
        });
      },
    );
    const user = userEvent.setup();
    mount();
    await screen.findByRole("region", { name: "Compra 1 de 2" });

    await user.click(screen.getByRole("button", { name: "Responder depois" }));

    await screen.findByRole("region", {
      name: "Compra 2 de 2",
    });
    const nextInput = screen.getByRole("textbox", {
      name: "Sua resposta",
    });
    expect(nextInput).toBeEnabled();
    await waitFor(() => expect(nextInput).toHaveFocus());
    expect(document.activeElement).not.toBe(document.body);
  });

  it("moves focus to review or the focusable up-to-date status when no next question remains", async () => {
    current = {
      ...current,
      questions: [current.questions[0]!],
      actions: ["RESOLVE", "PREPARE", "CANCEL"],
    };
    const fetchStub = vi.mocked(fetch);
    fetchStub.mockImplementation(
      async (input: RequestInfo | URL, options?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const method = options?.method ?? "GET";
        const body = options?.body
          ? (JSON.parse(String(options.body)) as Record<string, unknown>)
          : null;
        requests.push({ path, method, body });
        if (method === "GET") return response(current);
        if (!path.endsWith("/defer"))
          throw new Error(`Unexpected request: ${method} ${path}`);
        const lineId = String(body?.lineId);
        current = {
          ...current,
          revision: 8,
          selectedLineIds: current.selectedLineIds.filter(
            (id) => id !== lineId,
          ),
          lines: current.lines.map((line) =>
            line.id === lineId
              ? { ...line, decision: { kind: "DEFER" as const } }
              : line,
          ),
        };
        return response({
          version: 1,
          requestId: body?.requestId,
          operation: "DEFER",
          outcome: "APPLIED",
          revision: 8,
        });
      },
    );
    const user = userEvent.setup();
    mount();
    await screen.findByRole("region", { name: "Compra 1 de 2" });

    await user.click(screen.getByRole("button", { name: "Responder depois" }));

    const review = await screen.findByRole("button", {
      name: "Revisar compras prontas",
    });
    const upToDate = screen.getByRole("status");
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    expect(
      document.activeElement === review ||
        (document.activeElement === upToDate &&
          upToDate.getAttribute("tabindex") === "-1"),
    ).toBe(true);
    expect(document.activeElement).not.toBeDisabled();
  });

  it("focuses the changed-state alert and sends the next Tab to the first enabled control", async () => {
    const fetchStub = vi.mocked(fetch);
    fetchStub.mockImplementation(
      async (input: RequestInfo | URL, options?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const method = options?.method ?? "GET";
        const body = options?.body
          ? (JSON.parse(String(options.body)) as Record<string, unknown>)
          : null;
        requests.push({ path, method, body });
        if (method === "GET") return response(current);
        if (path.endsWith("/defer")) {
          current = { ...current, revision: 8 };
          throw new TypeError("connection reset while another write won");
        }
        throw new Error(`Unexpected request: ${method} ${path}`);
      },
    );
    const user = userEvent.setup();
    mount(<button type="button">Primeiro controle disponível</button>);
    await screen.findByRole("region", { name: "Compra 1 de 2" });
    await user.click(screen.getByRole("button", { name: "Responder depois" }));
    await user.click(
      await screen.findByRole("button", {
        name: "Consultar estado guardado",
      }),
    );

    const changed = await screen.findByRole("alert");
    expect(changed).toHaveTextContent(
      "A importação mudou. Confira o estado atual antes de tentar novamente.",
    );
    await waitFor(() => expect(changed).toHaveFocus());
    expect(changed).toHaveAttribute("tabindex", "-1");
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).not.toBeDisabled();

    await user.tab();
    expect(
      screen.getByRole("button", { name: "Primeiro controle disponível" }),
    ).toHaveFocus();
  });

  it("fails closed without changing hook order when a loaded session loses its private context", async () => {
    const fetchStub = vi.mocked(fetch);
    fetchStub.mockImplementation(
      async (input: RequestInfo | URL, options?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const method = options?.method ?? "GET";
        const body = options?.body
          ? (JSON.parse(String(options.body)) as Record<string, unknown>)
          : null;
        requests.push({ path, method, body });
        if (method === "GET") return response(current);
        if (path.endsWith("/defer"))
          return response({ message: "private" }, 403);
        throw new Error(`Unexpected request: ${method} ${path}`);
      },
    );
    const user = userEvent.setup();
    mount();
    await screen.findByRole("region", { name: "Compra 1 de 2" });

    await user.click(screen.getByRole("button", { name: "Responder depois" }));

    expect(await screen.findByRole("alert")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Responder depois" }),
    ).toBeNull();
    expect(
      requests.filter(
        ({ method, path }) => method === "POST" && path.endsWith("/defer"),
      ),
    ).toHaveLength(1);
  });

  it("opens only the ready current-lot projection before financial confirmation", async () => {
    current = {
      ...current,
      questions: [],
      actions: ["PREPARE", "CANCEL"],
    };
    const lot = currentLotFixture();
    const fetchStub = vi.mocked(fetch);
    fetchStub.mockImplementation(
      async (input: RequestInfo | URL, options?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const method = options?.method ?? "GET";
        const body = options?.body
          ? (JSON.parse(String(options.body)) as Record<string, unknown>)
          : null;
        requests.push({ path, method, body });
        if (path.endsWith("/current-lot/prepare"))
          return response({
            version: 1,
            requestId: body?.requestId,
            operation: "PREPARE_CURRENT_LOT",
            outcome: "CURRENT_LOT_READY",
            revision: 7,
          });
        if (path.endsWith("/current-lot")) return response(lot);
        return response(current);
      },
    );
    mount();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Revisar compras prontas",
      }),
    );

    expect(
      await screen.findByRole("heading", { name: "Revisão do lote" }),
    ).toBeVisible();
    expect(
      screen.getByText("Compra documental com descrição extensa"),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Confirmar compras deste lote" }),
    ).toBeEnabled();
    expect(
      requests.slice(1).map(({ method, path }) => `${method} ${path}`),
    ).toEqual([
      "POST /import-sessions/session-a/current-lot/prepare",
      "GET /import-sessions/session-a",
      "GET /import-sessions/session-a/current-lot",
    ]);
  });

  it("fails closed without an authenticated actor", () => {
    auth.user = null;
    mount();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Abra uma importação sob sua sessão autenticada",
    );
    expect(requests).toEqual([]);
  });

  it("hides a raw guided decision, prepares once, and focuses the server control", async () => {
    current = {
      ...current,
      questions: [
        {
          id: "stale-decision",
          lineIds: ["first"],
          field: "decision",
          text: "raw stale question",
        },
      ],
      guidedReview: {
        progress: "ANSWERING",
        focus: null,
        actions: ["CONTINUE_ANSWERING"],
      },
    };
    const focused: ImportSessionViewV1 = {
      ...current,
      revision: 8,
      questions: [
        {
          id: "question-decision",
          lineIds: ["first"],
          field: "decision",
          text: "internal",
        },
      ],
      guidedReview: {
        progress: "ANSWERING",
        actions: ["CONTINUE_ANSWERING"],
        focus: {
          questionId: "question-decision",
          lineId: "first",
          control: "DECISION",
          prompt: "O que deve acontecer com esta compra?",
          context: {
            title: "Compra importada",
            merchant: "Loja",
            amountCents: 10_000,
            purchaseDate: "2026-10-08",
          },
          options: [
            {
              label: "Criar conforme autorizado pelo servidor",
              answer: {
                kind: "DECISION",
                value: { kind: "CREATE", acceptNaturalDuplicate: false },
              },
            },
          ],
          purchaseOrdinal: 1,
          purchaseTotal: 2,
          questionOrdinal: 1,
          questionTotal: 4,
        },
      },
    };
    const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");
    let prepareRequestId = "";
    let releasePrepare!: () => void;
    const prepareResponse = new Promise<Response>((resolve) => {
      releasePrepare = () =>
        resolve(
          response({
            version: 1,
            requestId: prepareRequestId,
            operation: "PREPARE_CURRENT_LOT",
            outcome: "NEEDS_INPUT",
            revision: 8,
          }),
        );
    });
    vi.mocked(fetch).mockImplementation(
      async (input: RequestInfo | URL, options?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const method = options?.method ?? "GET";
        const body = options?.body
          ? (JSON.parse(String(options.body)) as Record<string, unknown>)
          : null;
        requests.push({ path, method, body });
        if (path.endsWith("/current-lot/prepare")) {
          current = focused;
          prepareRequestId = String(body?.requestId);
          return prepareResponse;
        }
        if (method === "GET") return response(current);
        throw new Error(`Unexpected request: ${method} ${path}`);
      },
    );
    const user = userEvent.setup();
    mount();

    const continueButton = await screen.findByRole("button", {
      name: "Continuar respondendo",
    });
    expect(continueButton).toBeEnabled();
    expect(continueButton).toHaveAttribute("aria-busy", "false");
    expect(
      screen.getByText(/Vamos preparar a próxima para você responder/),
    ).toBeVisible();
    expect(document.body).not.toHaveTextContent(
      "As respostas deste lote estão em dia",
    );

    await user.click(continueButton);
    await waitFor(() => expect(continueButton).toBeDisabled());
    expect(continueButton).toHaveAttribute("aria-busy", "true");
    expect(
      requests
        .filter(({ method }) => method === "POST")
        .map(({ path, body }) => ({ path, body })),
    ).toStrictEqual([
      {
        path: "/import-sessions/session-a/current-lot/prepare",
        body: {
          version: 1,
          requestId: expect.any(String),
          expectedRevision: 7,
        },
      },
    ]);
    releasePrepare();

    const firstControl = await screen.findByRole("radio", {
      name: "Criar conforme autorizado pelo servidor",
    });
    await waitFor(() => expect(firstControl).toHaveFocus());
    expect(
      screen.queryByRole("radio", { name: "Criar nova compra" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("radio", {
        name: "Criar mesmo parecendo repetida",
      }),
    ).not.toBeInTheDocument();
    expect(document.body).not.toHaveFocus();
    expect(
      focusSpy.mock.contexts.filter((context) => context === firstControl),
    ).toHaveLength(1);
    expect(focusSpy.mock.contexts).not.toContain(document.body);
    expect(
      requests.some(
        ({ path }) =>
          path === "/agent/chat" || path.endsWith("/interpretations"),
      ),
    ).toBe(false);
    focusSpy.mockRestore();
  });

  it("keeps a ready continuation in conversation instead of opening review", async () => {
    current = {
      ...current,
      questions: [
        {
          id: "stale-decision",
          lineIds: ["first"],
          field: "decision",
          text: "raw stale question",
        },
      ],
      guidedReview: {
        progress: "ANSWERING",
        focus: null,
        actions: ["CONTINUE_ANSWERING"],
      },
    };
    const ready: ImportSessionViewV1 = {
      ...current,
      revision: 8,
      guidedReview: {
        progress: "READY_WITH_PENDING",
        focus: null,
        actions: ["CONTINUE_ANSWERING", "REVIEW_READY"],
      },
    };
    vi.mocked(fetch).mockImplementation(
      async (input: RequestInfo | URL, options?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const method = options?.method ?? "GET";
        const body = options?.body
          ? (JSON.parse(String(options.body)) as Record<string, unknown>)
          : null;
        requests.push({ path, method, body });
        if (path.endsWith("/current-lot/prepare")) {
          current = ready;
          return response({
            version: 1,
            requestId: body?.requestId,
            operation: "PREPARE_CURRENT_LOT",
            outcome: "CURRENT_LOT_READY",
            revision: 8,
          });
        }
        if (path.endsWith("/current-lot"))
          throw new Error("Continue must not read the current lot");
        if (method === "GET") return response(current);
        throw new Error(`Unexpected request: ${method} ${path}`);
      },
    );
    const user = userEvent.setup();
    mount();

    await user.click(
      await screen.findByRole("button", { name: "Continuar respondendo" }),
    );

    expect(
      await screen.findByText("Já há compras prontas para revisar."),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Revisar as prontas agora" }),
    ).toBeVisible();
    expect(
      screen.getAllByRole("button", { name: "Continuar respondendo" }),
    ).toHaveLength(1);
    expect(
      screen.queryByRole("heading", { name: "Revisão do lote" }),
    ).not.toBeInTheDocument();
    expect(
      requests.slice(1).map(({ method, path }) => `${method} ${path}`),
    ).toEqual([
      "POST /import-sessions/session-a/current-lot/prepare",
      "GET /import-sessions/session-a",
    ]);
  });

  it("renders a selected documentary question ahead of raw guided questions when guided focus is null", async () => {
    current = {
      ...current,
      questions: [
        {
          id: "raw-guided-decision",
          lineIds: ["first"],
          field: "decision",
          text: "raw guided question",
        },
        ...current.questions,
      ],
      guidedReview: {
        progress: "ANSWERING",
        focus: null,
        actions: ["CONTINUE_ANSWERING"],
      },
    };

    mount();

    expect(
      await screen.findByRole("heading", {
        name: "Qual é o total da compra?",
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Continuar respondendo" }),
    ).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("raw guided question");
    expect(
      requests.filter(({ path }) => path.includes("/current-lot")),
    ).toHaveLength(0);
  });

  it("renders a generic non-guided question and continues only after it is exhausted", async () => {
    current = {
      ...current,
      questions: [
        {
          id: "raw-guided-decision",
          lineIds: ["first"],
          field: "decision",
          text: "raw guided question",
        },
        {
          id: "generic-amount",
          lineIds: ["first"],
          field: "amountCents",
          text: "raw generic question",
        },
      ],
      guidedReview: {
        progress: "ANSWERING",
        focus: null,
        actions: ["CONTINUE_ANSWERING"],
      },
    };
    vi.mocked(fetch).mockImplementation(
      async (input: RequestInfo | URL, options?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const method = options?.method ?? "GET";
        const body = options?.body
          ? (JSON.parse(String(options.body)) as Record<string, unknown>)
          : null;
        requests.push({ path, method, body });
        if (method === "GET") return response(current);
        if (path.endsWith("/resolutions")) {
          current = {
            ...current,
            revision: 8,
            questions: [current.questions[0]],
          };
          return response({
            version: 1,
            requestId: body?.requestId,
            operation: "RESOLVE",
            outcome: "APPLIED",
            revision: 8,
          });
        }
        throw new Error(`Unexpected request: ${method} ${path}`);
      },
    );
    const user = userEvent.setup();
    mount();

    const input = await screen.findByRole("textbox", {
      name: "Sua resposta",
    });
    expect(
      screen.getByRole("heading", { name: "Qual é o valor desta compra?" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Continuar respondendo" }),
    ).not.toBeInTheDocument();

    await user.type(input, "206,96");
    await user.click(
      screen.getByRole("button", { name: "Conferir informação" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Guardar informação" }),
    );

    expect(
      await screen.findByRole("button", { name: "Continuar respondendo" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Qual é o valor desta compra?" }),
    ).not.toBeInTheDocument();
    expect(
      requests.find(({ path }) => path.endsWith("/resolutions"))?.body,
    ).toEqual({
      version: 1,
      requestId: expect.any(String),
      expectedRevision: 7,
      questionId: "generic-amount",
      answer: { kind: "CENTS", value: 20696 },
    });
  });

  it("continues READY_WITH_PENDING on the server and focuses its first fresh control once", async () => {
    const user = userEvent.setup();
    const focusSpy = vi.spyOn(HTMLElement.prototype, "focus");
    current.questions = [
      {
        id: "question-decision",
        lineIds: ["first"],
        field: "decision",
        text: "internal",
      },
      {
        id: "question-targets",
        lineIds: ["first"],
        field: "targets",
        text: "internal",
      },
      {
        id: "question-type",
        lineIds: ["first"],
        field: "tipoDespesa",
        text: "internal",
      },
      {
        id: "question-labor",
        lineIds: ["first"],
        field: "categoriaMaoDeObra",
        text: "internal",
      },
    ];
    Object.assign(current, {
      guidedReview: {
        progress: "READY_WITH_PENDING",
        actions: ["REVIEW_READY", "CONTINUE_ANSWERING"],
        focus: {
          questionId: "question-type",
          lineId: "first",
          control: "EXPENSE_TYPE",
          prompt: "Qual é o tipo de despesa?",
          context: {
            title: "Compra importada",
            merchant: "Loja",
            amountCents: 10_000,
            purchaseDate: "2026-10-08",
          },
          options: [
            {
              label: "Material de construção",
              answer: {
                kind: "EXPENSE_TYPE",
                value: ExpenseType.MATERIAL_CONSTRUCAO,
              },
            },
          ],
          purchaseOrdinal: 1,
          purchaseTotal: 2,
          questionOrdinal: 3,
          questionTotal: 4,
        },
      },
    });
    vi.mocked(fetch).mockImplementation(
      async (input: RequestInfo | URL, options?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const method = options?.method ?? "GET";
        const body = options?.body
          ? (JSON.parse(String(options.body)) as Record<string, unknown>)
          : null;
        requests.push({ path, method, body });
        if (path.endsWith("/current-lot/continue")) {
          current = {
            ...current,
            revision: 8,
            guidedReview: {
              ...current.guidedReview!,
              progress: "ANSWERING",
              actions: ["CONTINUE_ANSWERING"],
            },
          };
          return response({
            version: 1,
            requestId: body?.requestId,
            operation: "CONTINUE_ANSWERING",
            outcome: "NEEDS_INPUT",
            revision: 8,
          });
        }
        if (method === "GET") return response(current);
        throw new Error(`Unexpected request: ${method} ${path}`);
      },
    );

    mount();

    expect(
      await screen.findByText("Já há compras prontas para revisar."),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Revisar as prontas agora" }),
    ).toBeVisible();
    expect(
      screen.getAllByRole("button", { name: "Continuar respondendo" }),
    ).toHaveLength(1);
    expect(
      screen.queryByRole("radio", { name: "Material de construção" }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Continuar respondendo" }),
    );
    const firstControl = screen.getByRole("radio", {
      name: "Material de construção",
    });
    expect(firstControl).toBeVisible();
    await waitFor(() => expect(firstControl).toHaveFocus());
    expect(document.body).not.toHaveFocus();
    expect(
      focusSpy.mock.contexts.filter((context) => context === firstControl),
    ).toHaveLength(1);
    expect(focusSpy.mock.contexts).not.toContain(document.body);
    expect(
      requests.filter(
        ({ method, path }) =>
          method === "POST" && path.endsWith("/current-lot/continue"),
      ),
    ).toHaveLength(1);
    expect(
      requests.some(({ path }) => path.endsWith("/current-lot/prepare")),
    ).toBe(false);
    expect(
      requests.some(
        ({ path }) =>
          path === "/agent/chat" || path.endsWith("/interpretations"),
      ),
    ).toBe(false);
    focusSpy.mockRestore();
  });
});
