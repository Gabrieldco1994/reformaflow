import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportSessionViewV1 } from "@reformaflow/domain";
import { useImportExecution } from "./useImportExecution";

const mocks = vi.hoisted(() => ({
  getFullImportSession: vi.fn(),
  challengeImportSession: vi.fn(),
  confirmImportSession: vi.fn(),
  executeImportSession: vi.fn(),
  catalogRetry: vi.fn(),
}));

vi.mock("../_lib/import-session-api", () => ({
  getFullImportSession: mocks.getFullImportSession,
  challengeImportSession: mocks.challengeImportSession,
  confirmImportSession: mocks.confirmImportSession,
  executeImportSession: mocks.executeImportSession,
}));
vi.mock("./useImportSessions", () => ({
  useImportUserId: () => "user-1",
}));
vi.mock("./useImportWorkflowCatalog", () => ({
  useImportWorkflowCatalog: () => ({
    data: {
      names: {
        project: () => "Projeto",
        card: () => "Cartão",
      },
      rooms: new Map(),
    },
    pending: false,
    error: null,
    retry: mocks.catalogRetry,
  }),
}));

const financialRequestId = "12345678-1234-4123-8123-123456789abc";
const proposalHash = "a".repeat(64);
const proposal = {
  version: 1,
  kind: "CREATE_CARD_PURCHASES",
  sessionId: "session-1",
  revision: 3,
  proposalHash,
  lines: [],
  deferredObservationIds: [],
  deferredAttachmentIds: [],
  retainUntil: null,
  createdEconomicTotalCents: 0,
  bankCashDeltaCents: 0,
  invoiceDeltas: [],
};
const confirmation = {
  financialRequestId,
  confirmedRevision: 3,
  proposalHash,
};
const confirmed = {
  version: 1,
  id: "session-1",
  ownerProjectId: "project-1",
  cardId: "card-1",
  state: "CONFIRMED",
  revision: 3,
  expiresAt: "2026-10-16T21:00:00.000Z",
  attachments: [],
  lines: [],
  selectedLineIds: [],
  questions: [],
  declaredFacts: [],
  reviewBlockers: [],
  searchComplete: true,
  proposal,
  confirmation,
  receipt: null,
  actions: ["EXECUTE"],
} as unknown as ImportSessionViewV1;
const receipt = {
  version: 1,
  sessionId: confirmed.id,
  financialRequestId,
  confirmedRevision: 3,
  proposalHash,
  appliedAt: "2026-10-10T21:00:00.000Z",
  continuationSessionId: "continuation-1",
  items: [],
  auditItems: [
    {
      observationId: "observation-payment",
      outcome: "IGNORED",
      reason: "INVOICE_PAYMENT",
      title: "Pagamento de fatura",
      amountCents: -12000,
    },
  ],
  snapshot: {
    lines: [],
    participantProjectIds: ["project-1"],
    createdEconomicTotalCents: 19134,
    bankCashDeltaCents: 0,
    invoiceDeltas: [],
  },
};
const applied = {
  ...confirmed,
  state: "APPLIED",
  expiresAt: null,
  proposal: null,
  receipt,
  actions: ["READ_RESULT"],
} as unknown as ImportSessionViewV1;

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useImportExecution("session-1"), { wrapper });
}

describe("useImportExecution lost-response recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-10-10T19:30:00.000Z"));
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.catalogRetry.mockResolvedValue({});
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("recovers APPLIED from the authorized full view after execute response loss and never posts execute again", async () => {
    let serverState = confirmed;
    mocks.getFullImportSession.mockImplementation(async () => serverState);
    mocks.executeImportSession.mockImplementation(async () => {
      serverState = applied;
      throw new TypeError("execute response lost");
    });

    const mounted = setup();
    await waitFor(() =>
      expect(mounted.result.current.financialAction).toBe("EXECUTE"),
    );
    await act(async () => {
      await mounted.result.current.act();
    });

    await waitFor(() => {
      expect(mounted.result.current.view?.state).toBe("APPLIED");
      expect(mounted.result.current.view?.receipt).toEqual(receipt);
      expect(mounted.result.current.financialAction).toBeNull();
    });
    expect(mocks.executeImportSession).toHaveBeenCalledTimes(1);
    expect(mocks.executeImportSession).toHaveBeenCalledWith(
      "session-1",
      { financialRequestId },
      "project-1",
    );
    expect(mounted.result.current.notice).toMatch(
      /estado guardado foi consultado/i,
    );

    await act(async () => {
      await mounted.result.current.act();
    });
    expect(mocks.executeImportSession).toHaveBeenCalledTimes(1);
    mounted.unmount();

    const reloaded = setup();
    await waitFor(() =>
      expect(reloaded.result.current.view?.state).toBe("APPLIED"),
    );
    expect(reloaded.result.current.view?.receipt).toEqual(receipt);
    expect(reloaded.result.current.financialAction).toBeNull();
    await act(async () => {
      await reloaded.result.current.act();
    });
    expect(mocks.challengeImportSession).not.toHaveBeenCalled();
    expect(mocks.confirmImportSession).not.toHaveBeenCalled();
    expect(mocks.executeImportSession).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed recovery read uncertain and read-only without blindly reposting", async () => {
    let recoveryMustFail = false;
    mocks.getFullImportSession.mockImplementation(async () => {
      if (recoveryMustFail) throw new TypeError("recovery read failed");
      return confirmed;
    });
    mocks.executeImportSession.mockImplementation(async () => {
      recoveryMustFail = true;
      throw new TypeError("execute response lost");
    });

    const { result } = setup();
    await waitFor(() => expect(result.current.financialAction).toBe("EXECUTE"));
    await act(async () => {
      await result.current.act();
    });

    expect(result.current.notice).toMatch(/resultado incerto/i);
    expect(result.current.error).not.toBeNull();
    expect(result.current.financialAction).toBeNull();
    expect(mocks.executeImportSession).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.act();
      await result.current.retry();
    });
    expect(mocks.getFullImportSession.mock.calls.length).toBeGreaterThan(2);
    expect(mocks.challengeImportSession).not.toHaveBeenCalled();
    expect(mocks.confirmImportSession).not.toHaveBeenCalled();
    expect(mocks.executeImportSession).toHaveBeenCalledTimes(1);
  });
});
