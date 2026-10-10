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
import { viewFixture } from "../_lib/import-session-fixtures";

const navigation = vi.hoisted(() => ({
  replace: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ projectId: "personal-a" }),
  usePathname: () => "/projects/personal-a/maria",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: navigation.replace }),
}));
vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({
    user: { id: "actor-a" },
    hasModule: () => true,
  }),
}));
vi.mock("@/contexts/project-context", () => ({
  useProject: () => ({
    projectId: "personal-a",
    projectType: "PESSOAL",
    projectName: "Pessoal",
  }),
}));
vi.mock("@/components/agent/useFinancialAgent", () => ({
  useFinancialAgent: () => ({ messages: [], loading: false, send: vi.fn() }),
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
  useMariaOpening: () => ({ message: "Olá", loading: false }),
}));
vi.mock("../../_components/mobile-launch/MobileLaunchSheetContainer", () => ({
  MobileLaunchSheetContainer: () => null,
}));

const reply = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200 });
const attachmentId = "22222222-2222-4222-8222-222222222222";
const selectedCsv = () =>
  new File(["date,title,amount\n2026-10-01,Tinta,12.34\n"], "fatura.csv", {
    type: "text/csv",
  });
const scrollToDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollTo",
);

function documentaryView(
  revision: number,
  state?: "RESERVED" | "ATTACHED",
  materializedInSession = false,
): ImportSessionViewV1 {
  return viewFixture({
    id: "session-a",
    ownerProjectId: "personal-a",
    cardId: "card-a",
    revision,
    attachments: state
      ? [
          {
            id: attachmentId,
            fileName: "fatura.csv",
            declaredBytes: selectedCsv().size,
            state,
            canAnalyze: state === "ATTACHED" && !materializedInSession,
            materializedInSession,
          },
        ]
      : [],
    actions: materializedInSession
      ? ["RESOLVE", "CANCEL"]
      : state === "ATTACHED"
        ? ["ANALYZE", "CANCEL"]
        : ["UPLOAD", "CANCEL"],
  });
}

describe("Maria composer CSV intake contract", () => {
  let client: QueryClient;
  let entry: unknown;
  let latest: ImportSessionViewV1;
  let requests: Array<{ method: string; path: string; body: BodyInit | null }>;

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    entry = { version: 1, kind: "CARD_INVOICE", formats: ["CSV"] };
    latest = documentaryView(1);
    requests = [];
    navigation.replace.mockReset();
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
      .mockReturnValueOnce(attachmentId);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, options?: RequestInit) => {
        const path = new URL(String(input), "http://localhost:3001").pathname;
        const method = options?.method ?? "GET";
        if (method !== "GET")
          requests.push({ method, path, body: options?.body ?? null });
        if (method === "GET" && path === "/import-sessions")
          return reply({ items: [], nextCursor: null, entry });
        if (method === "GET" && path === "/tenant/credit-cards")
          return reply([
            {
              id: "card-a",
              nickname: "Cartão",
              last4: "1234",
              project: {
                id: "personal-a",
                name: "Pessoal",
                type: "PESSOAL",
              },
            },
          ]);
        if (method === "POST" && path === "/import-sessions") {
          latest = documentaryView(1);
          return reply(latest);
        }
        if (
          method === "POST" &&
          path === "/import-sessions/session-a/attachments"
        )
          return reply((latest = documentaryView(2, "RESERVED")));
        if (
          method === "PUT" &&
          path ===
            `/import-sessions/session-a/attachments/${attachmentId}/content`
        )
          return reply((latest = documentaryView(3, "ATTACHED")));
        if (
          method === "POST" &&
          path ===
            `/import-sessions/session-a/attachments/${attachmentId}/analyze`
        )
          return reply((latest = documentaryView(4, "ATTACHED", true)));
        if (method === "GET" && path === "/import-sessions/session-a")
          return reply(latest);
        throw new Error(`Unexpected request ${method} ${path}`);
      }),
    );
  });

  afterEach(() => {
    cleanup();
    client.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (scrollToDescriptor)
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollTo",
        scrollToDescriptor,
      );
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  });

  function mount() {
    return render(
      <QueryClientProvider client={client}>
        <MariaPage />
      </QueryClientProvider>,
    );
  }

  async function csvInput() {
    return screen.findByLabelText("Anexar CSV da fatura");
  }

  async function chooseCsv() {
    const input = await csvInput();
    const card = await screen.findByRole("combobox", {
      name: "Cartão da fatura",
    });
    fireEvent.change(input, { target: { files: [selectedCsv()] } });
    fireEvent.change(card, { target: { value: "card-a" } });
    return input;
  }

  function fileStatus() {
    return within(
      screen.getByRole("form", { name: "Documentos para análise" }),
    ).getByRole("status");
  }

  it("selecting_a_CSV_is_local_and_sends_zero_requests", async () => {
    mount();
    await csvInput();
    requests.length = 0;

    await chooseCsv();

    expect(requests).toEqual([]);
    expect(fileStatus()).toHaveTextContent(
      "Arquivo selecionado. Nada foi enviado.",
    );
  });

  it("consent starts create, reserve, upload, and analysis in transport order", async () => {
    mount();
    await chooseCsv();
    expect(requests).toEqual([]);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Analisar e guardar rascunho",
      }),
    );

    await waitFor(() => expect(requests).toHaveLength(4));
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /import-sessions",
      "POST /import-sessions/session-a/attachments",
      `PUT /import-sessions/session-a/attachments/${attachmentId}/content`,
      `POST /import-sessions/session-a/attachments/${attachmentId}/analyze`,
    ]);
  });

  it("accepts_only_dot_csv_and_text_csv", async () => {
    mount();

    expect(await csvInput()).toHaveAttribute("accept", ".csv,text/csv");
  });

  it("keeps_the_CSV_intake_as_the_final_content_of_the_generic_conversation", async () => {
    mount();

    const input = await csvInput();
    const intake = input.closest("section");
    const conversation = screen.getByRole("region", {
      name: "Conversa com Maria",
    });
    const dock = screen
      .getByPlaceholderText(/Pergunte ou lance/)
      .closest("form")?.parentElement;

    expect(intake).not.toBeNull();
    expect(conversation).toContainElement(intake);
    expect(conversation.lastElementChild).toBe(intake);
    expect(dock).not.toContainElement(intake);
  });

  it("keeps_errors_and_selected_file_status_accessible", async () => {
    mount();
    const input = await csvInput();
    fireEvent.change(input, {
      target: {
        files: [new File(["x"], "fatura.pdf", { type: "application/pdf" })],
      },
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/CSV/);

    fireEvent.change(input, { target: { files: [selectedCsv()] } });
    expect(fileStatus()).toHaveTextContent(
      "Arquivo selecionado. Nada foi enviado.",
    );
  });

  it("does_not_render_the_attachment_affordance_when_entry_is_UNAVAILABLE", async () => {
    entry = { version: 1, kind: "UNAVAILABLE", reason: "NOT_ENABLED" };
    mount();

    await act(async () => {
      await Promise.resolve();
    });
    expect(
      screen.queryByLabelText("Anexar CSV da fatura"),
    ).not.toBeInTheDocument();
  });
});
