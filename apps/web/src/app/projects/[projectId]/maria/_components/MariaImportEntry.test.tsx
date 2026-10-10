import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportSessionViewV1 } from "@reformaflow/domain";
import MariaPage from "../page";
import { summaryFixture, viewFixture } from "../_lib/import-session-fixtures";
import { importRoot } from "../_lib/import-session-keys";
import {
  appliedFixture,
  confirmedFixture,
  workflowFixture,
} from "../_lib/import-workflow-fixtures";

const navigation = vi.hoisted(() => ({
  projectId: "proj-1",
  search: "",
  push: vi.fn(),
  replace: vi.fn(),
}));
const actor = vi.hoisted(() => ({ user: { id: "user-a" } }));
const genericSend = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: navigation.projectId }),
  usePathname: () => `/projects/${navigation.projectId}/maria`,
  useSearchParams: () => new URLSearchParams(navigation.search),
  useRouter: () => ({ push: navigation.push, replace: navigation.replace }),
}));
vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({ user: actor.user, hasModule: () => true }),
}));
vi.mock("@/contexts/project-context", () => ({
  useProject: () => ({
    projectId: navigation.projectId,
    projectType: "PESSOAL",
    projectName: "Pessoal",
  }),
}));
vi.mock("@/components/agent/useFinancialAgent", () => ({
  useFinancialAgent: () => ({
    messages: [],
    loading: false,
    send: genericSend,
  }),
}));
vi.mock("@/components/agent/useSpeechRecognition", () => ({
  useSpeechRecognition: () => ({
    supported: false,
    listening: false,
    start: vi.fn(),
    stop: vi.fn(),
  }),
}));
vi.mock("@/lib/streaming-tts", () => ({
  isStreamingTtsSupported: () => false,
  streamSpeak: vi.fn(),
}));
vi.mock("../_hooks/useMariaOpening", () => ({
  useMariaOpening: () => ({ message: "Abertura genérica", loading: false }),
}));
vi.mock("../../_components/mobile-launch/MobileLaunchSheetContainer", () => ({
  MobileLaunchSheetContainer: () => null,
}));

const reply = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const scrollToDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollTo",
);
let client: QueryClient;
let sessionRead: () => Promise<Response>;
let resultRead: () => Promise<Response>;
let entry: unknown;
let documentaryWrite: (
  path: string,
  options?: RequestInit,
) => Promise<Response>;
let requests: Array<{
  path: string;
  method: string;
  body: BodyInit | null | undefined;
  signal: AbortSignal | null | undefined;
}>;
const writes = () => requests.filter(({ method }) => method !== "GET");
const sessionReads = () =>
  requests.filter(({ path }) => path === "/import-sessions/sess-1");
const resultReads = () =>
  requests.filter(({ path }) => path === "/import-sessions/sess-1/result");
function pageElement() {
  return (
    <QueryClientProvider client={client}>
      <MariaPage />
    </QueryClientProvider>
  );
}
function mountPage() {
  return render(pageElement());
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-08T22:10:00.000Z"));
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
  navigation.projectId = "proj-1";
  navigation.search = "";
  navigation.push.mockReset();
  navigation.replace.mockReset();
  actor.user = { id: "user-a" };
  genericSend.mockReset();
  sessionStorage.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  requests = [];
  entry = { version: 1, kind: "UNAVAILABLE", reason: "NOT_ENABLED" };
  documentaryWrite = async (path, options) => {
    throw new Error(`Unexpected documentary write ${options?.method} ${path}`);
  };
  sessionRead = async () =>
    reply(
      viewFixture({
        state: "NEEDS_INPUT",
        actions: ["RESOLVE", "CANCEL"],
      }),
    );
  resultRead = async () => {
    throw new Error("Unexpected result read");
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
      const path = new URL(String(input), "http://localhost:3001").pathname;
      const method = options?.method ?? "GET";
      requests.push({
        path,
        method,
        body: options?.body,
        signal: options?.signal,
      });
      if (method !== "GET") return documentaryWrite(path, options);
      if (path === "/import-sessions")
        return reply({
          items: [summaryFixture()],
          nextCursor: null,
          entry,
        });
      if (
        path === "/import-sessions/sess-1" ||
        path === "/import-sessions/other"
      )
        return sessionRead();
      if (path === "/import-sessions/sess-1/result") return resultRead();
      if (path === "/tenant/credit-cards")
        return reply([
          {
            id: "card-1",
            nickname: "Cartão sintético",
            last4: "1234",
            project: { id: "proj-1", name: "Pessoal", type: "PESSOAL" },
          },
        ]);
      if (path === "/projects")
        return reply([{ id: "proj-1", name: "Pessoal", type: "PESSOAL" }]);
      throw new Error(`Unexpected readonly request ${path}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (scrollToDescriptor)
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollTo",
      scrollToDescriptor,
    );
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
});

describe("public entry on the real MariaPage host", () => {
  const auditItem = {
    lineId: "audit-deferred",
    outcome: "DEFERRED" as const,
    reason: "USER_DEFERRED" as const,
    title: "Compra deixada para depois",
    amountCents: -45002,
  };

  function detailFixture(state: "READY" | "CONFIRMED" | "APPLIED") {
    const view =
      state === "APPLIED"
        ? appliedFixture()
        : state === "CONFIRMED"
          ? confirmedFixture()
          : workflowFixture();
    view.id = "sess-1";
    if (view.proposal) view.proposal.sessionId = "sess-1";
    if (view.receipt) view.receipt.sessionId = "sess-1";
    if (state === "APPLIED") {
      if (!view.proposal || !view.receipt)
        throw new Error("APPLIED fixture must carry proposal and receipt");
      Object.assign(view.proposal, {
        noWriteRows: [structuredClone(auditItem)],
        effects: {
          personalSourceCreates: 1,
          reformaTargetCreates: 1,
          expenseCreates: 2,
          cashFlowEntryCreates: 2,
          rateioAllocationCreates: 1,
          keptExistingCount: 0,
          deferredCount: 1,
          excludedCount: 0,
          ignoredCount: 0,
        },
      });
      view.receipt.auditItems = [structuredClone(auditItem)];
    }
    return view;
  }

  async function mountSelectedIntake() {
    entry = { version: 1, kind: "CARD_INVOICE", formats: ["CSV"] };
    const mounted = mountPage();
    const cards = await screen.findByRole("combobox", {
      name: "Cartão da fatura",
    });
    fireEvent.change(cards, { target: { value: "card-1" } });
    fireEvent.change(screen.getByLabelText("Anexar CSV da fatura"), {
      target: {
        files: [
          new File(["data,valor\n01,12\n"], "ephemeral.csv", {
            type: "text/csv",
          }),
        ],
      },
    });
    expect(cards).toHaveValue("card-1");
    expect(
      within(
        screen.getByRole("form", { name: "Documentos para análise" }),
      ).getByRole("status"),
    ).toHaveTextContent("Arquivo selecionado. Nada foi enviado.");
    return mounted;
  }

  async function expectSelectedCard(value: string) {
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Cartão da fatura" }),
      ).toHaveValue(value),
    );
  }

  it("reads one persisted APPLIED result before removing only the session query", async () => {
    const detail = detailFixture("APPLIED");
    const pending = deferred<Response>();
    sessionRead = async () => reply(detail);
    resultRead = () => pending.promise;
    const mounted = await mountSelectedIntake();

    navigation.search = "keep=1&importSessionId=sess-1";
    mounted.rerender(pageElement());
    await waitFor(() => expect(resultReads()).toHaveLength(1));
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
    expect(genericSend).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve(
        reply({
          state: "APPLIED",
          receipt: detail.receipt,
        }),
      );
    });
    await waitFor(() => expect(navigation.replace).toHaveBeenCalledTimes(1));
    expect(navigation.replace).toHaveBeenCalledWith(
      "/projects/proj-1/maria?keep=1",
    );
    expect(resultReads()).toHaveLength(1);
    expect(writes()).toEqual([]);
    expect(genericSend).not.toHaveBeenCalled();

    navigation.search = "keep=1";
    mounted.rerender(pageElement());
    await act(async () => {});
    await expectSelectedCard("");
    const intake = screen.getByRole("region", {
      name: "Importar fatura CSV",
    });
    const form = within(intake).getByRole("form", {
      name: "Documentos para análise",
    });
    expect(form).toHaveAttribute("aria-busy", "false");
    expect(within(form).getByLabelText("Anexar CSV da fatura")).toBeEnabled();
    expect(within(form).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(form).queryByText("ephemeral.csv")).not.toBeInTheDocument();
    expect(within(form).getByRole("status")).toHaveTextContent(
      "Nenhum arquivo selecionado.",
    );
    expect(resultReads()).toHaveLength(1);
    expect(navigation.replace).toHaveBeenCalledTimes(1);
    expect(writes()).toEqual([]);
    expect(genericSend).not.toHaveBeenCalled();
  });

  it("does not let a stale APPLIED result clean a newer URL generation", async () => {
    const detail = detailFixture("APPLIED");
    const pending = deferred<Response>();
    sessionRead = async () => reply(detail);
    resultRead = () => pending.promise;
    const mounted = await mountSelectedIntake();

    navigation.search = "keep=1&importSessionId=sess-1";
    mounted.rerender(pageElement());
    await waitFor(() => expect(resultReads()).toHaveLength(1));
    navigation.search = "keep=2";
    mounted.rerender(pageElement());
    await act(async () => {
      pending.resolve(reply({ state: "APPLIED", receipt: detail.receipt }));
    });

    expect(navigation.replace).not.toHaveBeenCalled();
    expect(resultReads()).toHaveLength(1);
    expect(writes()).toEqual([]);
    expect(genericSend).not.toHaveBeenCalled();
    await expectSelectedCard("card-1");
  });

  it.each([
    ["receipt null", async () => reply({ state: "APPLIED", receipt: null })],
    [
      "malformed",
      async () => reply({ state: "APPLIED", receipt: { items: [] } }),
    ],
    [
      "offline",
      async () => {
        throw new TypeError("Failed to fetch");
      },
    ],
    [
      "503",
      async () => reply({ statusCode: 503, message: "Unavailable" }, 503),
    ],
  ])(
    "does not clean or write when the APPLIED result is %s",
    async (_case, read) => {
      sessionRead = async () => reply(detailFixture("APPLIED"));
      resultRead = read;
      const mounted = await mountSelectedIntake();

      navigation.search = "keep=1&importSessionId=sess-1";
      mounted.rerender(pageElement());
      await waitFor(() => expect(resultReads()).toHaveLength(1));
      await waitFor(() =>
        expect(
          client.getQueryState([...importRoot("user-a"), "result", "sess-1"])
            ?.fetchStatus,
        ).toBe("idle"),
      );
      expect(navigation.replace).not.toHaveBeenCalled();
      expect(writes()).toEqual([]);
      expect(genericSend).not.toHaveBeenCalled();
      navigation.search = "keep=1";
      mounted.rerender(pageElement());
      await expectSelectedCard("card-1");
    },
  );

  it.each(["READY", "CONFIRMED"] as const)(
    "does not read a result, execute, or clean a %s detail",
    async (state) => {
      sessionRead = async () => reply(detailFixture(state));
      const mounted = await mountSelectedIntake();

      navigation.search = "keep=1&importSessionId=sess-1";
      mounted.rerender(pageElement());
      await waitFor(() => expect(sessionReads()).toHaveLength(1));
      await screen.findByRole("region", { name: "Conversa da importação" });
      expect(resultReads()).toEqual([]);
      expect(navigation.replace).not.toHaveBeenCalled();
      expect(writes()).toEqual([]);
      expect(genericSend).not.toHaveBeenCalled();
      navigation.search = "keep=1";
      mounted.rerender(pageElement());
      await expectSelectedCard("card-1");
    },
  );

  it("never_renders_Nova_importacao_and_uses_the_chat_composer_for_new_intake", async () => {
    entry = { version: 1, kind: "CARD_INVOICE", formats: ["CSV"] };
    mountPage();

    await screen.findByText("Abertura genérica");
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Nova importação" }) ??
          screen.queryByLabelText("Anexar CSV da fatura"),
      ).not.toBeNull(),
    );
    expect(
      screen.queryByRole("button", { name: "Nova importação" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Anexar CSV da fatura")).toBeInTheDocument();
  });

  it("public_maria_preserves_generic_chat_without_import_context and OFF keeps recovery", async () => {
    mountPage();
    expect(screen.getByText("Abertura genérica")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Analisar e guardar rascunho" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Importações da Maria" }),
    );
    await screen.findByTestId("import-session-row");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(writes()).toEqual([]);
    expect(genericSend).not.toHaveBeenCalled();
  });

  it("deep_link_requires_authorized_get_before_contextual_actions", async () => {
    const pending = deferred<Response>();
    sessionRead = () => pending.promise;
    navigation.search = "importSessionId=sess-1";
    mountPage();
    try {
      await waitFor(() => expect(sessionReads().length).toBeGreaterThan(0));
      expect(screen.queryByText("Abertura genérica")).toBeNull();
      expect(writes()).toEqual([]);
      await act(async () => {
        pending.resolve(reply(viewFixture()));
      });
      expect(
        await screen.findByRole("region", { name: "Conversa da importação" }),
      ).toBeInTheDocument();
      expect(genericSend).not.toHaveBeenCalled();
      expect(writes()).toEqual([]);
    } finally {
      await act(async () => {
        pending.resolve(reply(viewFixture()));
      });
    }
  });

  it.each([
    "importSessionId=",
    "importSessionId=bad%2Fid",
    "importSessionId=sess-1&importSessionId=sess-2",
  ])(
    "invalid deep-link does not silently fall back to generic: %s",
    async (search) => {
      navigation.search = search;
      mountPage();
      expect(await screen.findByRole("alert")).not.toHaveTextContent(/^$/);
      expect(screen.queryByText("Abertura genérica")).toBeNull();
      expect(sessionReads()).toEqual([]);
      expect(writes()).toEqual([]);
      expect(genericSend).not.toHaveBeenCalled();
    },
  );

  it("inaccessible deep-link never falls back to generic", async () => {
    navigation.search = "importSessionId=sess-1";
    sessionRead = async () =>
      reply({ statusCode: 404, message: "Not Found" }, 404);
    mountPage();
    await waitFor(() => expect(sessionReads().length).toBeGreaterThan(0));
    expect(await screen.findByRole("alert")).not.toHaveTextContent(/^$/);
    expect(screen.queryByText("Abertura genérica")).toBeNull();
    expect(writes()).toEqual([]);
    expect(genericSend).not.toHaveBeenCalled();
  });

  it("recovery_opens_the_authorized_session_in_public_maria", async () => {
    const resumed = viewFixture({
      state: "NEEDS_INPUT",
      actions: ["RESOLVE", "CANCEL"],
    });
    resumed.attachments[0].fileName = "Fatura da viagem para retomar.csv";
    sessionRead = async () => reply(resumed);
    mountPage();
    fireEvent.click(
      screen.getByRole("button", { name: "Importações da Maria" }),
    );
    fireEvent.click(await screen.findByTestId("import-session-row"));
    const dialog = screen.getByRole("dialog", { name: "Importações da Maria" });
    expect(
      await within(dialog).findByRole("button", {
        name: "Cancelar importação",
      }),
    ).toBeEnabled();
    const readsBeforeContinue = sessionReads().length;
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Continuar na Maria" }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => {
      const publications = [
        ...navigation.push.mock.calls,
        ...navigation.replace.mock.calls,
      ].map(([href]) => new URL(String(href), "http://localhost"));
      expect(
        publications.some(
          (url) =>
            url.pathname === "/projects/proj-1/maria" &&
            url.searchParams.getAll("importSessionId").length === 1 &&
            url.searchParams.get("importSessionId") === resumed.id,
        ),
      ).toBe(true);
    });
    await waitFor(() =>
      expect(sessionReads().length).toBeGreaterThan(readsBeforeContinue),
    );
    const conversation = await screen.findByRole("region", {
      name: "Conversa da importação",
    });
    expect(
      within(conversation).getByText("Fatura da viagem para retomar.csv"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Abertura genérica")).toBeNull();
    expect(writes()).toEqual([]);
    expect(genericSend).not.toHaveBeenCalled();
  });

  it("malformed availability is explicit while the real recovery remains usable", async () => {
    entry = { version: 1, kind: "CARD_INVOICE", formats: [] };
    mountPage();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Não foi possível verificar a disponibilidade de novas importações. Suas importações guardadas continuam disponíveis.",
    );
    expect(
      screen.queryByRole("button", { name: "Nova importação" }),
    ).toBeNull();
    expect(
      screen.queryByRole("combobox", { name: "Cartão da fatura" }),
    ).toBeNull();
    expect(screen.queryByLabelText("Anexar CSV da fatura")).toBeNull();
    expect(
      screen.queryByRole("button", {
        name: "Analisar e guardar rascunho",
      }),
    ).toBeNull();
    expect(
      requests.filter(({ path }) => path === "/import-sessions"),
    ).toHaveLength(1);
    expect(
      requests.filter(({ path }) => path === "/tenant/credit-cards"),
    ).toEqual([]);
    fireEvent.click(
      screen.getByRole("button", { name: "Importações da Maria" }),
    );
    expect(await screen.findByTestId("import-session-row")).toBeInTheDocument();
    expect(writes()).toEqual([]);
  });

  it.each([
    [
      "NOT_ENABLED",
      "Novas importações pela Maria não estão habilitadas neste momento.",
    ],
    [
      "RUNTIME_UNAVAILABLE",
      "A consulta de novas importações está temporariamente indisponível.",
    ],
    [
      "NO_QUALIFIED_FORMAT",
      "Nenhum formato de fatura está qualificado para uma nova importação.",
    ],
  ] as const)(
    "keeps recovery first and usable for unavailable reason %s",
    async (reason, copy) => {
      entry = { version: 1, kind: "UNAVAILABLE", reason };
      mountPage();

      const recovery = await screen.findByRole("button", {
        name: "Importações da Maria",
      });
      const notice = await screen.findByText(copy);
      expect(
        recovery.compareDocumentPosition(notice) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        screen.queryByRole("combobox", { name: "Cartão da fatura" }),
      ).toBeNull();
      expect(screen.queryByLabelText("Anexar CSV da fatura")).toBeNull();
      expect(
        screen.queryByRole("button", {
          name: "Analisar e guardar rascunho",
        }),
      ).toBeNull();
      expect(
        requests.filter(({ path }) => path === "/tenant/credit-cards"),
      ).toEqual([]);

      fireEvent.click(recovery);
      expect(
        await screen.findByTestId("import-session-row"),
      ).toBeInTheDocument();
      expect(writes()).toEqual([]);
    },
  );

  it("retries only runtime unavailability with the existing list GET", async () => {
    entry = {
      version: 1,
      kind: "UNAVAILABLE",
      reason: "RUNTIME_UNAVAILABLE",
    };
    mountPage();
    const retry = await screen.findByRole("button", {
      name: "Verificar novamente",
    });
    const before = requests.length;

    fireEvent.click(retry);

    await waitFor(() => expect(requests).toHaveLength(before + 1));
    expect(requests.slice(before)).toMatchObject([
      { method: "GET", path: "/import-sessions" },
    ]);
    expect(writes()).toEqual([]);
  });

  it.each(["NOT_ENABLED", "NO_QUALIFIED_FORMAT"] as const)(
    "does not offer an availability retry for %s",
    async (reason) => {
      entry = { version: 1, kind: "UNAVAILABLE", reason };
      mountPage();

      await screen.findByText(
        reason === "NOT_ENABLED"
          ? "Novas importações pela Maria não estão habilitadas neste momento."
          : "Nenhum formato de fatura está qualificado para uma nova importação.",
      );
      expect(
        screen.queryByRole("button", { name: "Verificar novamente" }),
      ).toBeNull();
    },
  );

  it("a later invalid entry revokes intake without removing recovery", async () => {
    entry = { version: 1, kind: "CARD_INVOICE", formats: ["CSV"] };
    mountPage();
    expect(await screen.findByLabelText("Anexar CSV da fatura")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Importações da Maria" }),
    );
    expect(await screen.findByTestId("import-session-row")).toBeInTheDocument();
    entry = { kind: "CARD_INVOICE", formats: [] };
    fireEvent.click(screen.getByRole("button", { name: "Concluídas" }));
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("alert")
          .some((alert) =>
            alert.textContent?.includes(
              "Não foi possível verificar a disponibilidade de novas importações.",
            ),
          ),
      ).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: "Em andamento" }));
    expect(await screen.findByTestId("import-session-row")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Nova importação" }),
    ).toBeNull();
    expect(writes()).toEqual([]);
  });

  describe("real intake wire, synthetic positive capability (not activation)", () => {
    const createId = "11111111-1111-4111-8111-111111111111";
    const refA = "22222222-2222-4222-8222-222222222222";
    const refB = "33333333-3333-4333-8333-333333333333";
    let files: File[];

    beforeEach(() => {
      entry = { version: 1, kind: "CARD_INVOICE", formats: ["CSV"] };
      files = [
        new File(["data,valor\n01,12\n"], "primeira.csv", { type: "text/csv" }),
        new File(["data,valor\n02,34\n"], "segunda.csv", { type: "text/csv" }),
      ];
      vi.spyOn(crypto, "randomUUID")
        .mockReturnValueOnce(createId)
        .mockReturnValueOnce(refA)
        .mockReturnValueOnce(refB);
    });

    function documentaryView(
      revision: number,
      states: Array<"RESERVED" | "ATTACHED">,
      analyzable = false,
      materialized = 0,
      exposeAnalyze = analyzable,
    ): ImportSessionViewV1 {
      return viewFixture({
        revision,
        attachments: states.map((state, index) => ({
          id: index === 0 ? refA : refB,
          fileName: files[index].name,
          declaredBytes: files[index].size,
          state,
          canAnalyze:
            analyzable && state === "ATTACHED" && index >= materialized,
          materializedInSession: index < materialized,
        })),
        actions: [
          ...(states.length ? (["UPLOAD"] as const) : []),
          "CANCEL",
          ...(exposeAnalyze ? ["ANALYZE" as const] : []),
        ],
      });
    }

    async function select(count = 1) {
      const mounted = mountPage();
      const cards = await screen.findByRole("combobox", {
        name: "Cartão da fatura",
      });
      expect(cards).toHaveValue("");
      expect(
        within(cards).getByRole("option", {
          name: /Cartão sintético.*Pessoal/,
        }),
      ).toBeInTheDocument();
      fireEvent.change(cards, { target: { value: "card-1" } });
      const picker = screen.getByLabelText("Anexar CSV da fatura");
      expect(picker).toHaveAttribute("accept", ".csv,text/csv");
      fireEvent.change(picker, { target: { files: files.slice(0, count) } });
      return mounted;
    }

    function consent() {
      fireEvent.click(
        screen.getByRole("button", { name: "Analisar e guardar rascunho" }),
      );
    }

    function echo(mounted: ReturnType<typeof mountPage>) {
      const call = navigation.replace.mock.calls.at(-1);
      expect(call).toBeDefined();
      const url = new URL(String(call?.[0]), "http://localhost");
      expect(url.searchParams.getAll("importSessionId")).toEqual(["sess-1"]);
      navigation.search = url.searchParams.toString();
      mounted.rerender(pageElement());
    }

    it("consent_is_the_first_remote_documentary_write", async () => {
      const pending = deferred<Response>();
      documentaryWrite = () => pending.promise;
      await select();
      expect(writes()).toEqual([]);
      fireEvent.click(
        screen.getByRole("button", { name: /Remover arquivo 1/ }),
      );
      expect(writes()).toEqual([]);
      fireEvent.change(screen.getByLabelText("Anexar CSV da fatura"), {
        target: { files: [files[0]] },
      });
      fireEvent.click(screen.getByRole("button", { name: "Cancelar seleção" }));
      expect(writes()).toEqual([]);
      fireEvent.change(screen.getByLabelText("Anexar CSV da fatura"), {
        target: { files: [files[0]] },
      });
      consent();
      consent();
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()[0]).toMatchObject({
        path: "/import-sessions",
        method: "POST",
      });
      expect(JSON.parse(String(writes()[0].body))).toEqual({
        version: 1,
        createRequestId: createId,
        cardId: "card-1",
        consentPolicyVersion: 1,
        consentAnalyze: true,
      });
      expect(
        screen.getByRole("combobox", { name: "Cartão da fatura" }),
      ).toBeDisabled();
    });

    it("create without UPLOAD adopts the id and continues through reserve and upload", async () => {
      const created = deferred<Response>();
      const reserved = deferred<Response>();
      let serverView = documentaryView(3, []);
      const write = vi
        .fn()
        .mockImplementationOnce(() => created.promise)
        .mockImplementationOnce(() => reserved.promise)
        .mockResolvedValueOnce(reply(documentaryView(8, ["ATTACHED"])));
      documentaryWrite = write;
      sessionRead = async () => reply(serverView);
      const mounted = await select();
      consent();
      await waitFor(() => expect(writes()).toHaveLength(1));
      await act(async () => created.resolve(reply(documentaryView(3, []))));
      await waitFor(() => expect(writes()).toHaveLength(2));
      expect(writes()[1].path).toBe("/import-sessions/sess-1/attachments");
      expect(JSON.parse(String(writes()[1].body))).toMatchObject({
        expectedRevision: 3,
        files: [
          {
            id: refA,
            fileName: files[0].name,
            declaredBytes: files[0].size,
            mime: "text/csv",
          },
        ],
      });
      echo(mounted);
      expect(writes()[1].signal?.aborted).toBe(false);
      serverView = documentaryView(5, ["RESERVED"]);
      await act(async () => reserved.resolve(reply(serverView)));
      await waitFor(() => expect(writes()).toHaveLength(3));
      expect(writes()[2]).toMatchObject({ method: "PUT", body: files[0] });
      expect(writes()[2].signal?.aborted).toBe(false);
      expect(await screen.findByText(files[0].name)).toBeInTheDocument();
      expect(write).toHaveBeenCalledTimes(3);
      expect(genericSend).not.toHaveBeenCalled();
    });

    it.each(["importSessionId=other", "importSessionId=sess-1&outside=1"])(
      "external navigation after adoption is not its exact URL echo: %s",
      async (search) => {
        const reserved = deferred<Response>();
        documentaryWrite = vi
          .fn()
          .mockResolvedValueOnce(reply(documentaryView(3, [])))
          .mockImplementationOnce(() => reserved.promise);
        const mounted = await select();
        consent();
        await waitFor(() => expect(writes()).toHaveLength(2));
        navigation.search = search;
        sessionRead = async () =>
          reply(
            viewFixture({ id: search.includes("other") ? "other" : "sess-1" }),
          );
        mounted.rerender(pageElement());
        expect(writes()[1].signal?.aborted).toBe(true);
        await act(async () =>
          reserved.resolve(reply(documentaryView(5, ["RESERVED"]))),
        );
        expect(writes()).toHaveLength(2);
        expect(navigation.replace).toHaveBeenCalledTimes(1);
      },
    );

    it.each(["user", "project", "session", "navigation", "unmount"] as const)(
      "external_context_change_fences_late_create_without_resurrection: %s",
      async (change) => {
        const pending = deferred<Response>();
        documentaryWrite = () => pending.promise;
        const mounted = await select();
        consent();
        await waitFor(() => expect(writes()).toHaveLength(1));
        if (change === "user") actor.user = { id: "user-b" };
        if (change === "project") navigation.projectId = "proj-2";
        if (change === "session") {
          navigation.search = "importSessionId=other";
          sessionRead = async () => reply(viewFixture({ id: "other" }));
        }
        if (change === "navigation") navigation.search = "tab=another";
        if (change === "unmount") mounted.unmount();
        else mounted.rerender(pageElement());
        expect(writes()[0].signal?.aborted).toBe(true);
        await act(async () => pending.resolve(reply(documentaryView(3, []))));
        expect(writes()).toHaveLength(1);
        expect(navigation.replace).not.toHaveBeenCalled();
        expect(navigation.push).not.toHaveBeenCalled();
      },
    );

    it("contextual_child_does_not_start_a_second_document_sequence", async () => {
      const upload = deferred<Response>();
      documentaryWrite = vi
        .fn()
        .mockResolvedValueOnce(reply(documentaryView(3, [])))
        .mockResolvedValueOnce(reply(documentaryView(5, ["RESERVED"])))
        .mockImplementationOnce(() => upload.promise);
      sessionRead = async () => reply(documentaryView(8, ["ATTACHED"]));
      const mounted = await select();
      consent();
      await waitFor(() => expect(writes()).toHaveLength(3));
      expect(sessionReads()).toHaveLength(1);
      echo(mounted);
      expect(
        await screen.findByRole("region", { name: "Conversa da importação" }),
      ).toBeInTheDocument();
      expect(sessionReads()).toHaveLength(1);
      await act(async () =>
        upload.resolve(reply(documentaryView(8, ["ATTACHED"]))),
      );
      await waitFor(() =>
        expect(screen.queryByText("Enviando documentos…")).toBeNull(),
      );
      expect(writes().map(({ path, method }) => `${method} ${path}`)).toEqual([
        "POST /import-sessions",
        "POST /import-sessions/sess-1/attachments",
        `PUT /import-sessions/sess-1/attachments/${refA}/content`,
      ]);
      expect(genericSend).not.toHaveBeenCalled();
    });

    it.each([false, true])(
      "sequential_transport_uses_real_bytes_and_latest_revision: ANALYZE eligible=%s",
      async (analyzable) => {
        const firstPut = deferred<Response>();
        const final = documentaryView(
          14,
          ["ATTACHED", "ATTACHED"],
          analyzable,
          analyzable ? 2 : 0,
        );
        documentaryWrite = vi
          .fn()
          .mockResolvedValueOnce(reply(documentaryView(3, [])))
          .mockResolvedValueOnce(
            reply(documentaryView(5, ["RESERVED", "RESERVED"])),
          )
          .mockImplementationOnce(() => firstPut.promise)
          .mockResolvedValueOnce(
            reply(documentaryView(11, ["ATTACHED", "ATTACHED"], analyzable)),
          )
          .mockResolvedValueOnce(
            reply(documentaryView(12, ["ATTACHED", "ATTACHED"], true, 1)),
          )
          .mockResolvedValueOnce(reply(final));
        sessionRead = async () =>
          reply(
            documentaryView(5, ["RESERVED", "RESERVED"], analyzable, 0, false),
          );
        await select(2);
        consent();
        await waitFor(() => expect(writes()).toHaveLength(3));
        expect(writes()[2].body).toBe(files[0]);
        expect(writes().filter(({ method }) => method === "PUT")).toHaveLength(
          1,
        );
        await act(async () =>
          firstPut.resolve(
            reply(
              documentaryView(
                8,
                ["ATTACHED", "RESERVED"],
                analyzable,
                0,
                false,
              ),
            ),
          ),
        );
        await waitFor(() => expect(writes()).toHaveLength(analyzable ? 6 : 4));
        expect(writes()[3].body).toBe(files[1]);
        for (const [index, literal] of [
          "data,valor\n01,12\n",
          "data,valor\n02,34\n",
        ].entries()) {
          const body = writes()[index + 2].body;
          if (!(body instanceof Blob))
            throw new Error("PUT must carry original binary Blob");
          const text = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsText(body);
          });
          expect(text).toBe(literal);
        }
        if (analyzable) {
          expect(JSON.parse(String(writes()[4].body))).toEqual({
            expectedRevision: 11,
          });
          expect(JSON.parse(String(writes()[5].body))).toEqual({
            expectedRevision: 12,
          });
        } else {
          expect(writes().some(({ path }) => path.endsWith("/analyze"))).toBe(
            false,
          );
          expect(
            await screen.findAllByText(
              "Análise indisponível para este documento no recorte atual.",
            ),
          ).toHaveLength(2);
        }
      },
    );

    it("keeps the current second ANALYZE alive across adopted URL reconciliation", async () => {
      const secondAnalyze = deferred<Response>();
      const final = documentaryView(
        41,
        ["ATTACHED", "ATTACHED"],
        true,
        2,
        false,
      );
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
      sessionRead = async () =>
        reply(documentaryView(7, ["RESERVED", "RESERVED"], true, 0, false));
      const mounted = await select(2);
      consent();
      await waitFor(() => expect(writes()).toHaveLength(6));
      expect(
        writes()
          .filter(({ path }) => path.endsWith("/analyze"))
          .map(({ body }) => JSON.parse(String(body))),
      ).toEqual([{ expectedRevision: 19 }, { expectedRevision: 29 }]);
      const signal = writes()[5].signal;
      expect(signal?.aborted).toBe(false);

      echo(mounted);
      expect(signal?.aborted).toBe(false);
      navigation.search = "";
      mounted.rerender(pageElement());
      expect(signal?.aborted).toBe(false);
      navigation.search = "importSessionId=sess-1";
      mounted.rerender(pageElement());

      await act(async () => secondAnalyze.resolve(reply(final)));
      await waitFor(() =>
        expect(screen.queryByText("Enviando documentos…")).toBeNull(),
      );
      expect(signal?.aborted).toBe(false);
      expect(writes()).toHaveLength(6);
      expect(sessionReads()).toHaveLength(1);
      await waitFor(() =>
        expect(
          client.getQueryData([...importRoot("user-a"), "workflow", "sess-1"]),
        ).toMatchObject({ revision: 41 }),
      );
    });

    it("uncertain_response_is_get_first_and_retry_keeps_identity: CREATE without ID", async () => {
      documentaryWrite = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("Connection lost after POST"))
        .mockResolvedValueOnce(reply(documentaryView(3, [])))
        .mockResolvedValueOnce(reply(documentaryView(5, ["RESERVED"])))
        .mockResolvedValueOnce(reply(documentaryView(8, ["ATTACHED"])));
      sessionRead = async () => reply(documentaryView(8, ["ATTACHED"]));
      await select();
      consent();
      const recover = await screen.findByRole("button", {
        name: /Consultar estado/,
      });
      expect(writes()).toHaveLength(1);
      expect(
        screen.queryByRole("button", { name: "Repetir esta tentativa" }),
      ).toBeNull();
      expect(navigation.replace).not.toHaveBeenCalled();
      const listBefore = requests.filter(
        ({ path, method }) => path === "/import-sessions" && method === "GET",
      ).length;
      fireEvent.click(recover);
      await waitFor(() =>
        expect(
          requests.filter(
            ({ path, method }) =>
              path === "/import-sessions" && method === "GET",
          ),
        ).toHaveLength(listBefore + 1),
      );
      expect(writes()).toHaveLength(1);
      expect(navigation.replace).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("region", { name: "Conversa da importação" }),
      ).toBeNull();
      fireEvent.click(
        await screen.findByRole("button", { name: "Repetir esta tentativa" }),
      );
      await waitFor(() => expect(writes()).toHaveLength(4));
      expect(writes()[1].body).toBe(writes()[0].body);
      expect(JSON.parse(String(writes()[2].body))).toMatchObject({
        files: [{ id: refA }],
      });
    });

    it.each(["RESERVE", "PUT", "ANALYZE"] as const)(
      "uncertain_response_is_get_first_and_retry_keeps_identity: %s with ID",
      async (phase) => {
        const lost = new TypeError("Connection lost after accepting operation");
        const write = vi
          .fn()
          .mockResolvedValueOnce(reply(documentaryView(3, [])));
        if (phase === "RESERVE") write.mockRejectedValueOnce(lost);
        else {
          write.mockResolvedValueOnce(reply(documentaryView(5, ["RESERVED"])));
          if (phase === "PUT") write.mockRejectedValueOnce(lost);
          else
            write
              .mockResolvedValueOnce(
                reply(documentaryView(8, ["ATTACHED"], true)),
              )
              .mockRejectedValueOnce(lost);
        }
        write.mockResolvedValueOnce(reply(documentaryView(8, ["ATTACHED"])));
        documentaryWrite = write;
        sessionRead = async () =>
          reply(
            phase === "RESERVE"
              ? documentaryView(5, ["RESERVED"])
              : documentaryView(
                  9,
                  ["ATTACHED"],
                  false,
                  phase === "ANALYZE" ? 1 : 0,
                ),
          );
        await select();
        consent();
        const recover = await screen.findByRole("button", {
          name: /Consultar estado/,
        });
        expect(
          screen.queryByRole("button", {
            name: "Retomar envio dos documentos",
          }),
        ).toBeNull();
        const count = writes().length;
        const reads = sessionReads().length;
        fireEvent.click(recover);
        await waitFor(() =>
          expect(sessionReads().length).toBeGreaterThan(reads),
        );
        await waitFor(() =>
          expect(
            screen.queryByRole("button", { name: /Consultar estado/ }),
          ).toBeNull(),
        );
        expect(writes()).toHaveLength(count);
        expect(navigation.replace).toHaveBeenCalled();
        if (phase === "RESERVE") {
          fireEvent.click(
            await screen.findByRole("button", {
              name: "Retomar envio dos documentos",
            }),
          );
          await waitFor(() => expect(writes()).toHaveLength(count + 1));
          expect(writes().at(-1)?.path).toBe(
            `/import-sessions/sess-1/attachments/${refA}/content`,
          );
        }
      },
    );
  });
});
