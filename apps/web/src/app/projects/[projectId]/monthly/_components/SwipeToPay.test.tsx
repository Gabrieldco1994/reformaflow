import { act } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MonthlyEntry } from "../_types";
import SwipeToPay from "./SwipeToPay";

const apiPatch = vi.fn();
vi.mock("@/lib/api", () => ({
  api: {
    patch: (path: string, body: unknown) => apiPatch(path, body),
  },
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

function renderWithClient(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = vi.spyOn(client, "invalidateQueries");
  const utils = render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
  return { ...utils, client, invalidateSpy };
}

function entry(patch: Partial<MonthlyEntry> = {}): MonthlyEntry {
  return {
    id: "cashflow-1",
    data: "2026-07-10T12:00:00.000Z",
    tipo: "DESPESA",
    status: "PLANEJADO",
    valor: 50_007,
    categoria: "Moradia",
    subcategoria: null,
    formaPagamento: "PIX",
    projectId: "pessoal-test",
    projectName: "Pessoal Teste",
    projectType: "PESSOAL",
    isNeutral: false,
    isNeutralConsumo: false,
    isEspelho: false,
    expenseId: "exp-1",
    ...patch,
  };
}

beforeEach(() => {
  apiPatch.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
});

describe("SwipeToPay", () => {
  it("renders swipeable handle only for eligible entries", () => {
    renderWithClient(
      <SwipeToPay
        entries={[
          entry({ id: "cashflow-1", expenseId: "exp-1" }),
          entry({ id: "cashflow-2", expenseId: "exp-2", isEspelho: true }),
        ]}
        viewingProjectId="pessoal-test"
      />,
    );
    expect(
      screen.getAllByRole("button", { name: /marcar como pago/i }),
    ).toHaveLength(1);
  });

  it("confirming a swipe PATCHes status=PAGO using expenseId, never the cashflow id", async () => {
    apiPatch.mockResolvedValue({});
    renderWithClient(
      <SwipeToPay
        entries={[entry({ id: "cashflow-1", expenseId: "exp-1" })]}
        viewingProjectId="pessoal-test"
      />,
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /marcar como pago/i }),
      );
    });
    expect(apiPatch).toHaveBeenCalledWith("/projects/pessoal-test/expenses/exp-1", {
      status: "PAGO",
    });
    for (const call of apiPatch.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("cashflow-1");
    }
  });

  it("shows a toast with an Undo action after a successful confirm", async () => {
    apiPatch.mockResolvedValue({});
    renderWithClient(
      <SwipeToPay
        entries={[entry({ id: "cashflow-1", expenseId: "exp-1" })]}
        viewingProjectId="pessoal-test"
      />,
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /marcar como pago/i }),
      );
    });
    expect(toastSuccess).toHaveBeenCalled();
    const [, options] = toastSuccess.mock.calls[0]!;
    expect((options as { action: { label: string } }).action.label).toMatch(
      /desfazer/i,
    );
  });

  it("Undo calls PATCH status=PLANEJADO on the same (ownerProjectId, expenseId) pair — server-confirmed, not local-only", async () => {
    apiPatch.mockResolvedValue({});
    renderWithClient(
      <SwipeToPay
        entries={[entry({ id: "cashflow-1", expenseId: "exp-1" })]}
        viewingProjectId="pessoal-test"
      />,
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /marcar como pago/i }),
      );
    });
    expect(screen.queryByText("Pago")).toBeInTheDocument();

    let resolveUndo: (() => void) | undefined;
    apiPatch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveUndo = () => resolve({});
        }),
    );
    const [, options] = toastSuccess.mock.calls[0]!;
    const undoAction = (options as { action: { onClick: () => void } }).action;

    act(() => {
      undoAction.onClick();
    });
    // Row must NOT show "Pago" anymore right after the undo click (pending), before resolve.
    expect(screen.queryByText("Pago")).not.toBeInTheDocument();

    await act(async () => {
      resolveUndo?.();
      await Promise.resolve();
    });

    expect(apiPatch).toHaveBeenLastCalledWith(
      "/projects/pessoal-test/expenses/exp-1",
      { status: "PLANEJADO" },
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /marcar como pago/i }),
      ).toBeInTheDocument(),
    );
  });

  it("confirming a swipe invalidates the same canonical query keys as useExpenseMutations' payment flow", async () => {
    apiPatch.mockResolvedValue({});
    const { invalidateSpy } = renderWithClient(
      <SwipeToPay
        entries={[entry({ id: "cashflow-1", expenseId: "exp-1" })]}
        viewingProjectId="pessoal-test"
      />,
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /marcar como pago/i }),
      );
    });

    const invalidatedKeys = invalidateSpy.mock.calls.map(
      (call) => (call[0] as { queryKey: unknown[] }).queryKey,
    );
    for (const key of [
      ["expenses", "pessoal-test"],
      ["dashboard", "pessoal-test"],
      ["cash-flow", "pessoal-test"],
      ["cross-project-expenses", "pessoal-test"],
      ["account-view", "pessoal-test"],
      ["monthly-overview", "pessoal-test"],
    ]) {
      expect(invalidatedKeys).toContainEqual(key);
    }
  });

  it("a successful undo invalidates the same canonical query keys again", async () => {
    apiPatch.mockResolvedValue({});
    const { invalidateSpy } = renderWithClient(
      <SwipeToPay
        entries={[entry({ id: "cashflow-1", expenseId: "exp-1" })]}
        viewingProjectId="pessoal-test"
      />,
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /marcar como pago/i }),
      );
    });
    const callsAfterConfirm = invalidateSpy.mock.calls.length;
    expect(callsAfterConfirm).toBeGreaterThan(0);

    const [, options] = toastSuccess.mock.calls[0]!;
    const undoAction = (options as { action: { onClick: () => void } }).action;
    await act(async () => {
      undoAction.onClick();
      await Promise.resolve();
    });

    expect(invalidateSpy.mock.calls.length).toBeGreaterThan(callsAfterConfirm);
    const invalidatedKeys = invalidateSpy.mock.calls.map(
      (call) => (call[0] as { queryKey: unknown[] }).queryKey,
    );
    expect(invalidatedKeys).toContainEqual(["monthly-overview", "pessoal-test"]);
  });

  it("if the undo PATCH is rejected, the row stays confirmed (not idle) and no extra cache invalidation happens", async () => {
    apiPatch.mockResolvedValueOnce({}); // confirm succeeds
    const { invalidateSpy } = renderWithClient(
      <SwipeToPay
        entries={[entry({ id: "cashflow-1", expenseId: "exp-1" })]}
        viewingProjectId="pessoal-test"
      />,
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /marcar como pago/i }),
      );
    });
    expect(screen.getByText("Pago")).toBeInTheDocument();
    const callsAfterConfirm = invalidateSpy.mock.calls.length;

    apiPatch.mockRejectedValueOnce(new Error("network down")); // undo fails
    const [, options] = toastSuccess.mock.calls[0]!;
    const undoAction = (options as { action: { onClick: () => void } }).action;
    await act(async () => {
      undoAction.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Server is still PAGO — row must show "Pago" again, NOT the idle
    // "marcar como pago" button (which would silently imply the undo worked).
    expect(screen.getByText("Pago")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /marcar como pago/i }),
    ).not.toBeInTheDocument();
    expect(toastError).toHaveBeenCalled();
    // No new invalidation should have been triggered by the failed undo.
    expect(invalidateSpy.mock.calls.length).toBe(callsAfterConfirm);
  });

  it("a second swipe on the same row while the first PATCH is pending is a no-op", async () => {
    apiPatch.mockImplementation(() => new Promise(() => {}));
    renderWithClient(
      <SwipeToPay
        entries={[entry({ id: "cashflow-1", expenseId: "exp-1" })]}
        viewingProjectId="pessoal-test"
      />,
    );
    const button = screen.getByRole("button", {
      name: /marcar como pago/i,
    });
    await act(async () => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(apiPatch).toHaveBeenCalledTimes(1);
  });

  it("touch targets meet the 44px floor", () => {
    renderWithClient(
      <SwipeToPay
        entries={[entry({ id: "cashflow-1", expenseId: "exp-1" })]}
        viewingProjectId="pessoal-test"
      />,
    );
    expect(
      screen.getByRole("button", { name: /marcar como pago/i }).className,
    ).toMatch(/min-h-\[44px\]/);
  });
});
