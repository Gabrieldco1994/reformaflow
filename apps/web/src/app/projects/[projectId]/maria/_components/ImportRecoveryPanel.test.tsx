import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiResponseError, ApiTimeoutError } from "@/lib/api";
import {
  receiptFixture,
  summaryFixture,
  viewFixture,
} from "../_lib/import-session-fixtures";

const listImportSessions = vi.fn();
const getImportSession = vi.fn();
const getImportResult = vi.fn();
const cancelImportSession = vi.fn();
const apiGet = vi.fn();
vi.mock("../_lib/import-session-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../_lib/import-session-api")>()),
  listImportSessions: (...a: unknown[]) => listImportSessions(...a),
  getImportSession: (...a: unknown[]) => getImportSession(...a),
  getImportResult: (...a: unknown[]) => getImportResult(...a),
  cancelImportSession: (...a: unknown[]) => cancelImportSession(...a),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { get: (...a: unknown[]) => apiGet(...a) },
}));
let authUser: { id: string } | null = { id: "user-a" };
vi.mock("@/contexts/auth-context", () => ({
  useAuth: () => ({ user: authUser }),
}));

import { ImportRecoveryPanel } from "./ImportRecoveryPanel";

let client: QueryClient;
function renderPanel() {
  const utils = render(
    <QueryClientProvider client={client}>
      <ImportRecoveryPanel />
    </QueryClientProvider>,
  );
  return {
    ...utils,
    rerenderPanel: () =>
      utils.rerender(
        <QueryClientProvider client={client}>
          <ImportRecoveryPanel />
        </QueryClientProvider>,
      ),
  };
}
const http = (status: number, body: unknown) =>
  new ApiResponseError(`HTTP ${status}`, status, body);
const wire = (over: Record<string, unknown>) => ({
  code: "REVISION_CONFLICT",
  retryable: false,
  sessionId: "s",
  currentRevision: 4,
  reason: null,
  ...over,
});
const page = (items: unknown[], nextCursor: string | null = null) => ({
  page: { items, nextCursor },
  entry: {
    kind: "VALID",
    value: { version: 1, kind: "UNAVAILABLE", reason: "NOT_ENABLED" },
  },
});

beforeEach(() => {
  client = new QueryClient();
  authUser = { id: "user-a" };
  for (const fn of [
    listImportSessions,
    getImportSession,
    getImportResult,
    cancelImportSession,
    apiGet,
  ])
    fn.mockReset();
  apiGet.mockImplementation(async (path: string) =>
    path === "/tenant/credit-cards"
      ? [
          {
            id: "card-1",
            nickname: "Nubank",
            last4: "1234",
            project: { id: "proj-1", name: "Pessoal" },
          },
        ]
      : [
          { id: "proj-pessoal", name: "Pessoal", type: "PESSOAL" },
          { id: "proj-reforma", name: "Reforma da casa", type: "REFORMA" },
        ],
  );
});

describe("list", () => {
  it("exposes the list filters as labeled pressed toggle buttons", async () => {
    const user = userEvent.setup();
    listImportSessions.mockResolvedValue(page([]));
    renderPanel();

    const group = await screen.findByRole("group", {
      name: "Importações da Maria",
    });
    const active = within(group).getByRole("button", {
      name: "Em andamento",
    });
    const applied = within(group).getByRole("button", {
      name: "Concluídas",
    });
    expect(active).toHaveAttribute("aria-pressed", "true");
    expect(applied).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();

    applied.focus();
    await user.keyboard(" ");

    expect(active).toHaveAttribute("aria-pressed", "false");
    expect(applied).toHaveAttribute("aria-pressed", "true");
    expect(applied).toHaveFocus();
  });

  it("explains what lives here without promising the manual importers, and shows the generic empty copy on a fresh empty 200", async () => {
    listImportSessions.mockResolvedValue(page([]));
    renderPanel();
    expect(
      await screen.findByText("Nenhuma importação para retomar"),
    ).toBeInTheDocument();
    expect(screen.getByText(/guardadas pela Maria/i)).toBeInTheDocument();
    expect(
      screen.getByText(/extrato ou fatura.*não aparecem aqui/i),
    ).toBeInTheDocument();
    expect(listImportSessions).toHaveBeenCalledWith("active", null);
  });

  it("renders rows with state, catalog names and BRT dates, and only opens what the server lets it open", async () => {
    listImportSessions.mockResolvedValue(
      page([summaryFixture({ ownerProjectId: "proj-1" })]),
    );
    renderPanel();
    const row = await screen.findByTestId("import-session-row");
    expect(within(row).getByText("Rascunho guardado")).toBeInTheDocument();
    await waitFor(() =>
      expect(within(row).getByText(/Nubank/)).toBeInTheDocument(),
    );
    expect(within(row).getByText(/Pessoal/)).toBeInTheDocument();
    expect(
      within(row).getByText(/Guardada até 04\/10\/2026/),
    ).toBeInTheDocument();
    expect(
      within(row).queryByText(/sess-1|card-1|proj-1/),
    ).not.toBeInTheDocument();
  });

  it("switches to the applied list and loads it separately", async () => {
    listImportSessions.mockImplementation(async (scope: string) =>
      scope === "applied"
        ? page([
            summaryFixture({
              id: "done",
              state: "APPLIED",
              actions: ["READ_RESULT"],
              appliedAt: "2026-09-20T02:30:00.000Z",
              expiresAt: null,
            }),
          ])
        : page([]),
    );
    renderPanel();
    await screen.findByText("Nenhuma importação para retomar");
    fireEvent.click(screen.getByRole("button", { name: "Concluídas" }));
    const row = await screen.findByTestId("import-session-row");
    expect(within(row).getByText("Aplicada")).toBeInTheDocument();
    expect(
      within(row).getByText(/Aplicada em 19\/09\/2026 às 23:30/),
    ).toBeInTheDocument();
  });

  it.each([
    [
      "500",
      http(500, { statusCode: 500, message: "Internal server error" }),
      /Não foi possível consultar/,
    ],
    [
      "503",
      http(
        503,
        wire({
          code: "CAPABILITY_DISABLED",
          retryable: true,
          sessionId: null,
          currentRevision: null,
        }),
      ),
      /indisponível no momento/,
    ],
    ["timeout", new ApiTimeoutError(), /demorou/],
    ["offline", new TypeError("Failed to fetch"), /Sem conexão/],
  ])(
    "shows a visible error and retry for %s, never the empty copy",
    async (_name, failure, copy) => {
      listImportSessions.mockRejectedValueOnce(failure);
      renderPanel();
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(copy);
      expect(
        screen.queryByText("Nenhuma importação para retomar"),
      ).not.toBeInTheDocument();
      listImportSessions.mockResolvedValueOnce(page([]));
      fireEvent.click(
        within(alert).getByRole("button", { name: "Tentar de novo" }),
      );
      expect(
        await screen.findByText("Nenhuma importação para retomar"),
      ).toBeInTheDocument();
    },
  );

  it("keeps loaded rows but says they are stale when the next page fails, and restarts cleanly", async () => {
    listImportSessions
      .mockResolvedValueOnce(page([summaryFixture({ id: "a" })], "c1"))
      .mockRejectedValueOnce(http(400, { statusCode: 400, message: "x" }))
      .mockResolvedValueOnce(page([summaryFixture({ id: "z" })]));
    renderPanel();
    await screen.findByTestId("import-session-row");
    fireEvent.click(screen.getByRole("button", { name: "Ver mais" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/desatualizad/i);
    expect(screen.getAllByTestId("import-session-row")).toHaveLength(1);
    fireEvent.click(
      within(alert).getByRole("button", { name: "Recomeçar a lista" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
    expect(listImportSessions).toHaveBeenLastCalledWith("active", null);
  });
});

describe("detail and cancel", () => {
  async function openDetail(view = viewFixture()) {
    listImportSessions.mockResolvedValue(page([summaryFixture()]));
    getImportSession.mockResolvedValue(view);
    renderPanel();
    fireEvent.click(await screen.findByTestId("import-session-row"));
    await screen.findByRole("heading", { name: /Rascunho guardado/ });
  }

  it("reads the detail with a GET only and shows attachments/questions as inert text", async () => {
    await openDetail(
      viewFixture({
        attachments: [
          {
            id: "a",
            fileName: "<img src=x onerror=alert(1)>.pdf",
            declaredBytes: 10,
            state: "ATTACHED",
            materializedInSession: false,
            canAnalyze: false,
          },
        ],
        questions: [
          {
            id: "q",
            lineIds: [],
            field: "dataCompra",
            text: "Abra https://evil.example agora",
          },
        ],
      }),
    );
    expect(getImportSession).toHaveBeenCalledWith("sess-1");
    expect(
      screen.getByText("<img src=x onerror=alert(1)>.pdf"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Abra https://evil.example agora"),
    ).toBeInTheDocument();
    expect(document.querySelector("img, a[href]")).toBeNull();
    expect(screen.getByText(/não renova o prazo/i)).toBeInTheDocument();
  });

  it("has no financial confirm, upload or create control", async () => {
    await openDetail();
    expect(
      screen.queryByRole("button", {
        name: /confirmar (lote|importação)|aplicar|analisar|anexar/i,
      }),
    ).toBeNull();
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it("offers cancel only when the server lists CANCEL", async () => {
    await openDetail(viewFixture({ actions: [] }));
    expect(
      screen.queryByRole("button", { name: "Cancelar importação" }),
    ).toBeNull();
  });

  it("asks before cancelling, then sends expectedRevision once even on a double tap", async () => {
    await openDetail();
    fireEvent.click(
      screen.getByRole("button", { name: "Cancelar importação" }),
    );
    expect(cancelImportSession).not.toHaveBeenCalled();
    expect(screen.getByText(/não cria lançamentos/i)).toBeInTheDocument();
    let resolve: (value: unknown) => void = () => {};
    cancelImportSession.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const yes = screen.getByRole("button", { name: "Sim, cancelar" });
    fireEvent.click(yes);
    fireEvent.click(yes);
    expect(cancelImportSession).toHaveBeenCalledTimes(1);
    expect(cancelImportSession).toHaveBeenCalledWith("sess-1", 3);
    getImportSession.mockResolvedValue(
      viewFixture({ state: "CANCELLED", actions: [], expiresAt: null }),
    );
    await act(async () => {
      resolve(
        viewFixture({ state: "CANCELLED", actions: [], expiresAt: null }),
      );
    });
    expect(
      await screen.findByText("Importação cancelada."),
    ).toBeInTheDocument();
  });

  it("a lost cancel answer is unknown, not success, and the state is reloaded", async () => {
    await openDetail();
    fireEvent.click(
      screen.getByRole("button", { name: "Cancelar importação" }),
    );
    cancelImportSession.mockRejectedValueOnce(new ApiTimeoutError());
    const before = getImportSession.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Sim, cancelar" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/confirmar o cancelamento/i);
    expect(screen.queryByText("Importação cancelada.")).toBeNull();
    await waitFor(() =>
      expect(getImportSession.mock.calls.length).toBeGreaterThan(before),
    );
  });

  it("REVISION_CONFLICT reloads the session and says it changed", async () => {
    await openDetail();
    fireEvent.click(
      screen.getByRole("button", { name: "Cancelar importação" }),
    );
    cancelImportSession.mockRejectedValueOnce(http(409, wire({})));
    const before = getImportSession.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Sim, cancelar" }));
    expect(await screen.findByText(/mudou/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(getImportSession.mock.calls.length).toBeGreaterThan(before),
    );
  });

  it("ALREADY_APPLIED tries the result; a generic 404 there promises nothing and infers nothing", async () => {
    await openDetail();
    fireEvent.click(
      screen.getByRole("button", { name: "Cancelar importação" }),
    );
    cancelImportSession.mockRejectedValueOnce(
      http(409, wire({ code: "ALREADY_APPLIED" })),
    );
    getImportResult.mockRejectedValueOnce(
      http(404, { statusCode: 404, message: "Not Found" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Sim, cancelar" }));
    const alert = await screen.findByRole("alert");
    expect(getImportResult).toHaveBeenCalledWith("sess-1");
    expect(alert).toHaveTextContent(/já foi aplicada/i);
    expect(alert).toHaveTextContent(/não foi possível abrir o comprovante/i);
    expect(alert.textContent).not.toMatch(/projeto|permiss|acesso/i);
    expect(
      screen.queryByRole("button", { name: "Cancelar importação" }),
    ).toBeNull();
  });
});

describe("receipt and continuation", () => {
  async function openReceipt(receipt = receiptFixture()) {
    listImportSessions.mockImplementation(async (scope: string) =>
      scope === "applied"
        ? page([
            summaryFixture({
              id: "sess-9",
              state: "APPLIED",
              actions: ["READ_RESULT"],
              appliedAt: receipt.appliedAt,
              expiresAt: null,
            }),
          ])
        : page([]),
    );
    getImportResult.mockResolvedValue({ state: "APPLIED", receipt });
    renderPanel();
    await screen.findByText("Nenhuma importação para retomar");
    fireEvent.click(screen.getByRole("button", { name: "Concluídas" }));
    fireEvent.click(await screen.findByTestId("import-session-row"));
    await screen.findByRole("heading", { name: "Comprovante da importação" });
  }

  it("prints the approved snapshot: cents, date-only, BRT instant, catalog names, keep-existing copy", async () => {
    await openReceipt();
    const lines = await screen.findAllByTestId("receipt-line");
    expect(lines).toHaveLength(2);
    expect(
      within(lines[0]).getByText("Geladeira Frost Free"),
    ).toBeInTheDocument();
    expect(within(lines[0]).getByText("R$ 123.456,78")).toBeInTheDocument();
    expect(within(lines[0]).getByText(/20\/09\/2026/)).toBeInTheDocument();
    await waitFor(() =>
      expect(within(lines[0]).getByText(/Reforma da casa/)).toBeInTheDocument(),
    );
    expect(
      within(lines[0]).getByText(/^Projeto$|Projeto\b/),
    ).toBeInTheDocument();
    expect(
      within(lines[1]).getByText("Compra já existente (mantida)"),
    ).toBeInTheDocument();
    expect(screen.getByText(/19\/09\/2026 às 23:30/)).toBeInTheDocument();
    expect(screen.getByText("-R$ 61.728,39")).toBeInTheDocument();
    expect(screen.queryByText(/proj-oculto|exp-1|alloc-1/)).toBeNull();
  });

  it("opens the continuation draft through a GET of the session, and never creates", async () => {
    await openReceipt(receiptFixture({ continuationSessionId: "sess-next" }));
    getImportSession.mockResolvedValue(
      viewFixture({ id: "sess-next", state: "DRAFT" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Ver rascunho restante" }),
    );
    await screen.findByRole("heading", { name: /Rascunho guardado/ });
    expect(getImportSession).toHaveBeenCalledWith("sess-next");
  });

  it("has no continuation button when nothing was deferred", async () => {
    await openReceipt();
    expect(
      screen.queryByRole("button", { name: "Ver rascunho restante" }),
    ).toBeNull();
  });

  it("refuses an incoherent receipt instead of rendering a partial one", async () => {
    const bad = receiptFixture();
    bad.items = bad.items.slice(0, 1);
    listImportSessions.mockImplementation(async (scope: string) =>
      scope === "applied"
        ? page([
            summaryFixture({
              id: "sess-9",
              state: "APPLIED",
              actions: ["READ_RESULT"],
              expiresAt: null,
            }),
          ])
        : page([]),
    );
    getImportResult.mockResolvedValue({ state: "APPLIED", receipt: bad });
    renderPanel();
    await screen.findByText("Nenhuma importação para retomar");
    fireEvent.click(screen.getByRole("button", { name: "Concluídas" }));
    fireEvent.click(await screen.findByTestId("import-session-row"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /não foi possível exibir este comprovante/i,
    );
    expect(screen.queryByTestId("receipt-line")).toBeNull();
  });
});

describe("authentication scope", () => {
  it("resets to the list on a user change and never renders the previous user's data", async () => {
    listImportSessions.mockResolvedValue(page([summaryFixture({ id: "a-1" })]));
    getImportSession.mockResolvedValue(viewFixture({ id: "a-1" }));
    const { rerenderPanel } = renderPanel();
    fireEvent.click(await screen.findByTestId("import-session-row"));
    await screen.findByRole("heading", { name: /Rascunho guardado/ });

    listImportSessions.mockReset();
    listImportSessions.mockResolvedValue(page([]));
    authUser = { id: "user-b" };
    rerenderPanel();
    expect(
      await screen.findByText("Nenhuma importação para retomar"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /Rascunho guardado/ }),
    ).toBeNull();
    expect(screen.queryByText(/fatura-setembro/)).toBeNull();
  });

  it("asks to sign in again and requests nothing without a user", () => {
    authUser = null;
    renderPanel();
    expect(screen.getByText(/Entre novamente/i)).toBeInTheDocument();
    expect(listImportSessions).not.toHaveBeenCalled();
  });
});
