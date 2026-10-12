import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ImportSessionViewV1 } from "@reformaflow/domain";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importRoot } from "../_lib/import-session-keys";
import type { ImportEntryAction } from "../_lib/import-entry-action";
import { MariaImportEntry } from "./MariaImportEntry";

const navigation = vi.hoisted(() => ({
  projectId: "proj-1",
  pathname: "/projects/proj-1/maria",
  search: "",
  push: vi.fn(),
  replace: vi.fn(),
}));
const actor = vi.hoisted(() => ({
  user: { id: "user-a" } as { id: string } | null,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(navigation.search),
  useRouter: () => ({ push: navigation.push, replace: navigation.replace }),
}));

vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({ user: actor.user, hasModule: () => true }),
}));

// Keep the real entry, hook, form, cache, and API client in this host test.
// Only the conversational response is synthetic; it supplies the typed action
// that the real chat body normally forwards after /agent/chat.
vi.mock("./MariaChatBody", () => ({
  MariaChatBody: ({
    intake,
    onImportEntryAction,
    importSessionId,
    documents,
  }: {
    intake?: ReactNode;
    onImportEntryAction?: (action: ImportEntryAction) => void;
    importSessionId?: string | null;
    documents?: {
      view: ImportSessionViewV1 | null;
      error: { message: string } | null;
      recover: () => Promise<void>;
    };
  }) => (
    <div>
      {onImportEntryAction && (
        <button
          type="button"
          onClick={() =>
            onImportEntryAction({
              version: 1,
              kind: "START_CARD_INVOICE_IMPORT",
              originChannel: "TEXT",
              formats: ["CSV"],
              suggestedCardId: null,
            })
          }
        >
          Nova importação
        </button>
      )}
      {importSessionId && (
        <output data-testid="active-session">{importSessionId}</output>
      )}
      {documents && (
        <output data-testid="document-state">
          {documents.view
            ? `revision=${documents.view.revision};${documents.view.attachments
                .map(
                  ({ fileName, materializedInSession }) =>
                    `${fileName}:${materializedInSession}`,
                )
                .join("|")}`
            : "empty"}
        </output>
      )}
      {documents?.error && (
        <button type="button" onClick={() => void documents.recover()}>
          Consultar estado dos documentos
        </button>
      )}
      {intake}
    </div>
  ),
}));

type CapturedRequest = {
  path: string;
  method: string;
  body: BodyInit | null | undefined;
  signal: AbortSignal | null | undefined;
  userId: string | null;
};

const reply = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const CARD = {
  id: "card-1",
  nickname: "Cartão sintético",
  last4: "1234",
  closingDay: 5,
  dueDay: 12,
  project: { id: "proj-1", name: "Pessoal" },
};
const CREATE_ID = "11111111-1111-4111-8111-111111111111";
const ATTACHMENT_A = "22222222-2222-4222-8222-222222222222";
const ATTACHMENT_B = "33333333-3333-4333-8333-333333333333";

let client: QueryClient;
let requests: CapturedRequest[];
let files: File[];
let entry: unknown;
let sessionRead: (id: string, request: CapturedRequest) => Promise<Response>;
let documentaryWrite: (
  path: string,
  options?: RequestInit,
) => Promise<Response>;

const writes = () => requests.filter(({ method }) => method !== "GET");
const sessionReads = (id = "sess-1") =>
  requests.filter(
    ({ path, method }) => method === "GET" && path === `/import-sessions/${id}`,
  );
const listReads = () =>
  requests.filter(
    ({ path, method }) => method === "GET" && path === "/import-sessions",
  );

function viewFixture(
  overrides: Partial<ImportSessionViewV1> = {},
): ImportSessionViewV1 {
  return {
    version: 1,
    id: "sess-1",
    ownerProjectId: "proj-1",
    cardId: "card-1",
    state: "DRAFT",
    revision: 3,
    expiresAt: "2026-10-04T12:00:00.000Z",
    attachments: [],
    searchComplete: true,
    proposal: null,
    confirmation: null,
    receipt: null,
    lines: [],
    selectedLineIds: [],
    questions: [],
    declaredFacts: [],
    reviewBlockers: [],
    actions: ["CANCEL"],
    ...overrides,
  };
}

function documentaryView(
  revision: number,
  states: Array<"RESERVED" | "ATTACHED">,
  analyzable = false,
  materialized = 0,
  exposeAnalyze = analyzable,
  id = "sess-1",
): ImportSessionViewV1 {
  return viewFixture({
    id,
    revision,
    attachments: states.map((state, index) => ({
      id: index === 0 ? ATTACHMENT_A : ATTACHMENT_B,
      fileName: files[index].name,
      declaredBytes: files[index].size,
      state,
      canAnalyze: analyzable && state === "ATTACHED" && index >= materialized,
      materializedInSession: index < materialized,
    })),
    actions: [
      ...(states.length ? (["UPLOAD"] as const) : []),
      "CANCEL",
      ...(exposeAnalyze ? (["ANALYZE"] as const) : []),
    ],
  });
}

function entryElement() {
  return (
    <QueryClientProvider client={client}>
      <MariaImportEntry projectId={navigation.projectId} />
    </QueryClientProvider>
  );
}

function mountEntry() {
  const mounted = render(entryElement());
  return {
    ...mounted,
    rerenderEntry: () => mounted.rerender(entryElement()),
  };
}

async function select(count = 1) {
  const mounted = mountEntry();
  fireEvent.click(
    await screen.findByRole("button", { name: "Nova importação" }),
  );
  const cards = await screen.findByRole("combobox", {
    name: "Cartão da fatura",
  });
  fireEvent.change(cards, { target: { value: "card-1" } });
  fireEvent.change(screen.getByLabelText("Selecionar arquivos"), {
    target: { files: files.slice(0, count) },
  });
  return mounted;
}

function consent() {
  fireEvent.click(
    screen.getByRole("button", { name: "Analisar e guardar rascunho" }),
  );
}

function adoptTarget(mounted: ReturnType<typeof mountEntry>) {
  const call = navigation.replace.mock.calls.at(-1);
  expect(call).toBeDefined();
  const url = new URL(String(call?.[0]), "http://localhost");
  expect(url.searchParams.getAll("importSessionId")).toEqual(["sess-1"]);
  navigation.search = url.searchParams.toString();
  mounted.rerenderEntry();
}

function expectNoFinancialWrites() {
  const isDocumentaryWrite = ({ path, method }: CapturedRequest) =>
    (method === "POST" && path === "/import-sessions") ||
    (method === "POST" &&
      /^\/import-sessions\/[^/]+\/attachments$/.test(path)) ||
    (method === "PUT" &&
      /^\/import-sessions\/[^/]+\/attachments\/[^/]+\/content$/.test(path)) ||
    (method === "POST" &&
      /^\/import-sessions\/[^/]+\/attachments\/[^/]+\/analyze$/.test(path));

  // In particular, confirmation/execution and every non-import financial
  // endpoint are outside this strictly documentary flow.
  expect(writes().filter((request) => !isDocumentaryWrite(request))).toEqual(
    [],
  );
}

beforeEach(() => {
  navigation.projectId = "proj-1";
  navigation.pathname = "/projects/proj-1/maria";
  navigation.search = "";
  navigation.push.mockReset();
  navigation.replace.mockReset();
  actor.user = { id: "user-a" };
  client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  requests = [];
  files = [
    new File(["data,valor\n01,12\n"], "private-statement-a.csv", {
      type: "text/csv",
    }),
    new File(["data,valor\n02,34\n"], "second-statement.csv", {
      type: "text/csv",
    }),
  ];
  entry = { kind: "CARD_INVOICE", formats: ["CSV"] };
  sessionRead = async (id) =>
    reply(viewFixture({ id: id === "other" ? "sess-1" : id }));
  documentaryWrite = async (path, options) => {
    throw new Error(`Unexpected documentary write ${options?.method} ${path}`);
  };
  vi.spyOn(crypto, "randomUUID")
    .mockReturnValueOnce(CREATE_ID)
    .mockReturnValueOnce(ATTACHMENT_A)
    .mockReturnValueOnce(ATTACHMENT_B);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const path = new URL(String(input), "http://localhost:3001").pathname;
      const method = options?.method ?? "GET";
      const request: CapturedRequest = {
        path,
        method,
        body: options?.body,
        signal: options?.signal,
        userId: actor.user?.id ?? null,
      };
      requests.push(request);
      if (method !== "GET") return documentaryWrite(path, options);
      if (path === "/import-sessions")
        return reply({
          items: [],
          nextCursor: null,
          entry,
        });
      if (path === "/tenant/credit-cards") return reply([CARD]);
      const session = path.match(/^\/import-sessions\/([^/]+)$/);
      if (session) return sessionRead(decodeURIComponent(session[1]), request);
      throw new Error(`Unexpected readonly request ${path}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Maria import adoption lifecycle", () => {
  it.each(["RESERVE", "PUT"] as const)(
    "keeps exact adoption alive while %s is in flight",
    async (phase) => {
      const pending = deferred<Response>();
      const write = vi
        .fn()
        .mockResolvedValueOnce(reply(documentaryView(3, [])));
      if (phase === "RESERVE") {
        write
          .mockImplementationOnce(() => pending.promise)
          .mockResolvedValueOnce(reply(documentaryView(8, ["ATTACHED"], true)))
          .mockResolvedValueOnce(
            reply(documentaryView(9, ["ATTACHED"], true, 1, false)),
          );
      } else {
        write
          .mockResolvedValueOnce(reply(documentaryView(7, ["RESERVED"])))
          .mockImplementationOnce(() => pending.promise)
          .mockResolvedValueOnce(
            reply(documentaryView(9, ["ATTACHED"], true, 1, false)),
          );
      }
      documentaryWrite = write;
      const mounted = await select(1);
      consent();
      await waitFor(() =>
        expect(writes()).toHaveLength(phase === "RESERVE" ? 2 : 3),
      );
      const signal = writes().at(-1)?.signal;
      expect(signal?.aborted).toBe(false);

      adoptTarget(mounted);
      expect(signal?.aborted).toBe(false);
      navigation.search = "";
      mounted.rerenderEntry();
      expect(signal?.aborted).toBe(false);
      navigation.search = "importSessionId=sess-1";
      mounted.rerenderEntry();
      mounted.rerenderEntry();
      expect(signal?.aborted).toBe(false);

      await act(async () => {
        pending.resolve(
          phase === "RESERVE"
            ? reply(documentaryView(7, ["RESERVED"]))
            : reply(documentaryView(8, ["ATTACHED"], true)),
        );
        await pending.promise;
      });
      await waitFor(() =>
        expect(screen.queryByText("Enviando documentos…")).toBeNull(),
      );
      expect(signal?.aborted).toBe(false);
      expect(writes()).toHaveLength(4);
      expectNoFinancialWrites();
    },
  );

  it("keeps a single-document ANALYZE alive on exact adoption and commits after settle", async () => {
    const pending = deferred<Response>();
    documentaryWrite = vi
      .fn()
      .mockResolvedValueOnce(reply(documentaryView(3, [])))
      .mockResolvedValueOnce(reply(documentaryView(7, ["RESERVED"])))
      .mockResolvedValueOnce(reply(documentaryView(11, ["ATTACHED"], true)))
      .mockImplementationOnce(() => pending.promise);
    const mounted = await select(1);
    consent();
    await waitFor(() =>
      expect(
        writes().filter(({ path }) => path.endsWith("/analyze")),
      ).toHaveLength(1),
    );
    const signal = writes().at(-1)?.signal;
    expect(signal?.aborted).toBe(false);

    adoptTarget(mounted);
    expect(signal?.aborted).toBe(false);
    mounted.rerenderEntry();
    navigation.search = "";
    mounted.rerenderEntry();
    expect(signal?.aborted).toBe(false);
    navigation.search = "importSessionId=sess-1";
    mounted.rerenderEntry();
    mounted.rerenderEntry();
    expect(signal?.aborted).toBe(false);

    await act(async () => {
      pending.resolve(reply(documentaryView(19, ["ATTACHED"], true, 1, false)));
      await pending.promise;
    });
    await waitFor(() =>
      expect(screen.queryByText("Enviando documentos…")).toBeNull(),
    );
    expect(signal?.aborted).toBe(false);
    expect(writes()).toHaveLength(4);
    expect(navigation.replace).toHaveBeenCalledTimes(1);
    expect(sessionReads()).toEqual([]);
    expect(
      client.getQueryData([...importRoot("user-a"), "workflow", "sess-1"]),
    ).toMatchObject({ revision: 19 });
    expectNoFinancialWrites();

    // Once the owning request settles, the source URL is no longer an adoption echo.
    navigation.search = "";
    mounted.rerenderEntry();
    await waitFor(() =>
      expect(screen.queryByTestId("active-session")).not.toBeInTheDocument(),
    );
  });

  it("keeps the second ANALYZE alive through repeated exact source/target snapshots without duplicate writes", async () => {
    const secondAnalyze = deferred<Response>();
    documentaryWrite = vi
      .fn()
      .mockResolvedValueOnce(reply(documentaryView(3, [])))
      .mockResolvedValueOnce(
        reply(documentaryView(7, ["RESERVED", "RESERVED"])),
      )
      .mockResolvedValueOnce(
        reply(documentaryView(11, ["ATTACHED", "RESERVED"], true, 0, false)),
      )
      .mockResolvedValueOnce(
        reply(documentaryView(19, ["ATTACHED", "ATTACHED"], true)),
      )
      .mockResolvedValueOnce(
        reply(documentaryView(29, ["ATTACHED", "ATTACHED"], true, 1)),
      )
      .mockImplementationOnce(() => secondAnalyze.promise);
    const mounted = await select(2);
    consent();
    await waitFor(() => expect(writes()).toHaveLength(6));
    const analyzes = writes().filter(({ path }) => path.endsWith("/analyze"));
    expect(analyzes.map(({ body }) => JSON.parse(String(body)))).toEqual([
      { expectedRevision: 19 },
      { expectedRevision: 29 },
    ]);
    const signal = analyzes[1].signal;
    expect(signal?.aborted).toBe(false);

    adoptTarget(mounted);
    mounted.rerenderEntry();
    navigation.search = "";
    mounted.rerenderEntry();
    expect(signal?.aborted).toBe(false);
    navigation.search = "importSessionId=sess-1";
    mounted.rerenderEntry();
    mounted.rerenderEntry();
    expect(signal?.aborted).toBe(false);

    await act(async () => {
      secondAnalyze.resolve(
        reply(documentaryView(41, ["ATTACHED", "ATTACHED"], true, 2, false)),
      );
      await secondAnalyze.promise;
    });
    await waitFor(() =>
      expect(screen.queryByText("Enviando documentos…")).toBeNull(),
    );
    expect(signal?.aborted).toBe(false);
    expect(writes()).toHaveLength(6);
    expect(
      writes().filter(({ path }) => path.endsWith("/analyze")),
    ).toHaveLength(2);
    expect(sessionReads()).toEqual([]);
    expect(
      client.getQueryData([...importRoot("user-a"), "workflow", "sess-1"]),
    ).toMatchObject({ revision: 41 });
    expectNoFinancialWrites();
  });

  it("aborts A after adoption on an A-to-B switch and fences A's late ANALYZE result", async () => {
    const lateAnalysis = deferred<Response>();
    documentaryWrite = vi
      .fn()
      .mockResolvedValueOnce(reply(documentaryView(3, [])))
      .mockResolvedValueOnce(reply(documentaryView(7, ["RESERVED"])))
      .mockResolvedValueOnce(reply(documentaryView(11, ["ATTACHED"], true)))
      .mockImplementationOnce(() => lateAnalysis.promise);
    sessionRead = async (_id, request) =>
      request.userId === "user-b"
        ? reply({ message: "Not found" }, 404)
        : reply(documentaryView(11, ["ATTACHED"], true));

    const mounted = await select(1);
    consent();
    await waitFor(() =>
      expect(
        writes().filter(({ path }) => path.endsWith("/analyze")),
      ).toHaveLength(1),
    );
    const signal = writes().at(-1)?.signal;
    adoptTarget(mounted);
    expect(signal?.aborted).toBe(false);
    expect(
      client.getQueryData([...importRoot("user-a"), "workflow", "sess-1"]),
    ).toMatchObject({ revision: 11 });

    actor.user = { id: "user-b" };
    mounted.rerenderEntry();
    expect(signal?.aborted).toBe(true);
    await waitFor(() =>
      expect(sessionReads().some(({ userId }) => userId === "user-b")).toBe(
        true,
      ),
    );

    await act(async () => {
      lateAnalysis.resolve(
        reply(documentaryView(19, ["ATTACHED"], true, 1, false)),
      );
      await lateAnalysis.promise;
    });
    await waitFor(() =>
      expect(
        client.getQueryData([...importRoot("user-a"), "workflow", "sess-1"]),
      ).toBeUndefined(),
    );
    expect(
      client.getQueryData([...importRoot("user-b"), "workflow", "sess-1"]),
    ).toBeUndefined();
    expect(screen.queryByTestId("document-state")).toBeNull();
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      "private-statement-a.csv",
    );
    expect(screen.queryByText("private-statement-a.csv")).toBeNull();
    expect(navigation.replace).toHaveBeenCalledTimes(1);
    expect(navigation.search).toBe("importSessionId=sess-1");
    expect(writes()).toHaveLength(4);
    expectNoFinancialWrites();
  });

  it.each(["late success", "late error"] as const)(
    "aborts ANALYZE on a non-exact external context and fences its %s",
    async (outcome) => {
      const lateAnalysis = deferred<Response>();
      documentaryWrite = vi
        .fn()
        .mockResolvedValueOnce(reply(documentaryView(3, [])))
        .mockResolvedValueOnce(reply(documentaryView(7, ["RESERVED"])))
        .mockResolvedValueOnce(reply(documentaryView(11, ["ATTACHED"], true)))
        .mockImplementationOnce(() => lateAnalysis.promise);
      sessionRead = async () => reply(documentaryView(11, ["ATTACHED"], true));
      const mounted = await select(1);
      consent();
      await waitFor(() =>
        expect(
          writes().filter(({ path }) => path.endsWith("/analyze")),
        ).toHaveLength(1),
      );
      const signal = writes().at(-1)?.signal;
      adoptTarget(mounted);
      expect(signal?.aborted).toBe(false);

      navigation.search = "importSessionId=sess-1&outside=1";
      mounted.rerenderEntry();
      expect(signal?.aborted).toBe(true);
      await waitFor(() => expect(sessionReads().length).toBeGreaterThan(0));
      if (outcome === "late success") {
        await act(async () => {
          lateAnalysis.resolve(
            reply(documentaryView(19, ["ATTACHED"], true, 1, false)),
          );
          await lateAnalysis.promise;
        });
      } else {
        await act(async () => {
          lateAnalysis.reject(new TypeError("late private analysis failure"));
          await lateAnalysis.promise.catch(() => undefined);
        });
      }
      await waitFor(() =>
        expect(
          client.getQueryData([...importRoot("user-a"), "workflow", "sess-1"]),
        ).toMatchObject({ revision: 11 }),
      );
      expect(screen.getByTestId("document-state")).toHaveTextContent(
        "revision=11",
      );
      expect(screen.queryByText(/late private analysis failure/)).toBeNull();
      expect(signal?.aborted).toBe(true);
      expect(writes()).toHaveLength(4);
      expect(navigation.replace).toHaveBeenCalledTimes(1);
      expect(navigation.search).toBe("importSessionId=sess-1&outside=1");
      expectNoFinancialWrites();
    },
  );

  it.each(["project", "session", "path", "navigation", "unmount"] as const)(
    "aborts and fences a late CREATE after external %s change",
    async (change) => {
      const pendingCreate = deferred<Response>();
      documentaryWrite = vi.fn(() => pendingCreate.promise);
      const mounted = await select(1);
      consent();
      await waitFor(() => expect(writes()).toHaveLength(1));
      const signal = writes()[0].signal;

      if (change === "project") {
        navigation.projectId = "proj-2";
        navigation.pathname = "/projects/proj-2/maria";
      }
      if (change === "session") {
        navigation.search = "importSessionId=other";
        sessionRead = async () => reply(viewFixture({ id: "sess-1" }));
      }
      if (change === "path") navigation.pathname = "/projects/proj-1/another";
      if (change === "navigation") navigation.search = "tab=external";
      if (change === "unmount") mounted.unmount();
      else mounted.rerenderEntry();
      expect(signal?.aborted).toBe(true);

      if (change === "session")
        await waitFor(() =>
          expect(sessionReads("other").length).toBeGreaterThan(0),
        );
      await act(async () => {
        pendingCreate.resolve(reply(documentaryView(3, [])));
        await pendingCreate.promise;
      });
      expect(writes()).toHaveLength(1);
      expect(navigation.replace).not.toHaveBeenCalled();
      expect(navigation.push).not.toHaveBeenCalled();
      expect(
        client.getQueryData([...importRoot("user-a"), "workflow", "sess-1"]),
      ).toBeUndefined();
      if (change !== "unmount")
        expect(screen.queryByTestId("active-session")).toBeNull();
      expectNoFinancialWrites();
    },
  );
});

describe("uncertain documentary writes", () => {
  it("requires a fresh list GET before an explicit retry after uncertain CREATE", async () => {
    const write = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("connection lost after CREATE"))
      .mockResolvedValueOnce(reply(documentaryView(3, [])))
      .mockResolvedValueOnce(reply(documentaryView(5, ["RESERVED"])))
      .mockResolvedValueOnce(reply(documentaryView(8, ["ATTACHED"], true)))
      .mockResolvedValueOnce(
        reply(documentaryView(9, ["ATTACHED"], true, 1, false)),
      );
    documentaryWrite = write;
    await select(1);
    consent();
    const recover = await screen.findByRole("button", {
      name: "Consultar estado dos documentos",
    });
    expect(writes()).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "Repetir esta tentativa" }),
    ).toBeNull();

    const readsBefore = listReads().length;
    fireEvent.click(recover);
    await waitFor(() => expect(listReads()).toHaveLength(readsBefore + 1));
    expect(writes()).toHaveLength(1);
    expect(navigation.replace).not.toHaveBeenCalled();

    fireEvent.click(
      await screen.findByRole("button", { name: "Repetir esta tentativa" }),
    );
    await waitFor(() => expect(writes()).toHaveLength(5));
    expect(writes()[1].body).toBe(writes()[0].body);
    expect(JSON.parse(String(writes()[2].body)).files[0].id).toBe(ATTACHMENT_A);
    expectNoFinancialWrites();
  });

  it.each(["RESERVE", "PUT"] as const)(
    "reads current state before explicitly retrying uncertain %s",
    async (phase) => {
      const lost = new TypeError("connection lost after accepted operation");
      const write = vi
        .fn()
        .mockResolvedValueOnce(reply(documentaryView(3, [])));
      if (phase === "RESERVE") {
        write.mockRejectedValueOnce(lost);
        write
          .mockResolvedValueOnce(reply(documentaryView(8, ["ATTACHED"], true)))
          .mockResolvedValueOnce(
            reply(documentaryView(9, ["ATTACHED"], true, 1, false)),
          );
      } else {
        write
          .mockResolvedValueOnce(reply(documentaryView(5, ["RESERVED"])))
          .mockRejectedValueOnce(lost)
          .mockResolvedValueOnce(
            reply(documentaryView(9, ["ATTACHED"], true, 1, false)),
          );
      }
      documentaryWrite = write;
      sessionRead = async () =>
        reply(
          phase === "RESERVE"
            ? documentaryView(5, ["RESERVED"])
            : documentaryView(7, ["ATTACHED"], true),
        );

      await select(1);
      consent();
      const recover = await screen.findByRole("button", {
        name: "Consultar estado dos documentos",
      });
      const writeCount = writes().length;
      const readCount = sessionReads().length;
      fireEvent.click(recover);
      await waitFor(() =>
        expect(sessionReads().length).toBeGreaterThan(readCount),
      );
      expect(writes()).toHaveLength(writeCount);

      fireEvent.click(
        await screen.findByRole("button", {
          name: "Retomar envio dos documentos",
        }),
      );
      await waitFor(() =>
        expect(writes()).toHaveLength(
          writeCount + (phase === "RESERVE" ? 2 : 1),
        ),
      );
      expect(writes().at(-1)?.path).toMatch(/\/analyze$/);
      expectNoFinancialWrites();
    },
  );

  it("retries an uncertain ANALYZE only after GET still shows it eligible", async () => {
    const lost = new TypeError("analysis response lost");
    const write = vi
      .fn()
      .mockResolvedValueOnce(reply(documentaryView(3, [])))
      .mockResolvedValueOnce(reply(documentaryView(5, ["RESERVED"])))
      .mockResolvedValueOnce(reply(documentaryView(8, ["ATTACHED"], true)))
      .mockRejectedValueOnce(lost)
      .mockResolvedValueOnce(
        reply(documentaryView(10, ["ATTACHED"], true, 1, false)),
      );
    documentaryWrite = write;
    sessionRead = async () => reply(documentaryView(9, ["ATTACHED"], true));
    const mounted = await select(1);
    consent();
    const recover = await screen.findByRole("button", {
      name: "Consultar estado dos documentos",
    });
    const analyzeWrites = () =>
      writes().filter(({ path }) => path.endsWith("/analyze"));
    expect(analyzeWrites()).toHaveLength(1);
    const readCount = sessionReads().length;
    fireEvent.click(recover);
    await waitFor(() =>
      expect(sessionReads().length).toBeGreaterThan(readCount),
    );
    expect(analyzeWrites()).toHaveLength(1);

    adoptTarget(mounted);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Retomar envio dos documentos",
      }),
    );
    await waitFor(() => expect(analyzeWrites()).toHaveLength(2));
    expect(analyzeWrites()[1].signal?.aborted).toBe(false);
    expectNoFinancialWrites();
  });

  it("does not POST again when GET proves the uncertain ANALYZE already materialized", async () => {
    const lost = new TypeError("analysis response lost");
    documentaryWrite = vi
      .fn()
      .mockResolvedValueOnce(reply(documentaryView(3, [])))
      .mockResolvedValueOnce(reply(documentaryView(5, ["RESERVED"])))
      .mockResolvedValueOnce(reply(documentaryView(8, ["ATTACHED"], true)))
      .mockRejectedValueOnce(lost);
    sessionRead = async () =>
      reply(documentaryView(9, ["ATTACHED"], false, 1, false));
    await select(1);
    consent();
    const recover = await screen.findByRole("button", {
      name: "Consultar estado dos documentos",
    });
    const writesBeforeRead = writes().length;
    const readsBefore = sessionReads().length;
    fireEvent.click(recover);
    await waitFor(() =>
      expect(sessionReads().length).toBeGreaterThan(readsBefore),
    );
    expect(writes()).toHaveLength(writesBeforeRead);
    expect(
      screen.queryByRole("button", {
        name: "Retomar envio dos documentos",
      }),
    ).toBeNull();
    expect(
      writes().filter(({ path }) => path.endsWith("/analyze")),
    ).toHaveLength(1);
    expectNoFinancialWrites();
  });
});
