import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #218 W5 — empty state vazio de Fluxo de Caixa com CTA acionável.
 * Navega para /expenses (onde novas despesas alimentam o fluxo de caixa).
 */
const entriesResponse: { value: unknown[] } = { value: [] };
const apiGet = vi.fn(async () => entriesResponse.value);
const routerPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
}));

vi.mock("@/contexts/project-context", () => ({
  useProject: () => ({
    projectId: "p1",
    projectType: "REFORMA",
    projectName: "Reforma",
  }),
}));

vi.mock("@/lib/api", () => ({
  api: { get: (...args: unknown[]) => apiGet(...(args as [])) },
}));

import CashFlowPage from "./page";

describe("CashFlowPage — estado vazio com ação (#218)", () => {
  beforeEach(() => {
    entriesResponse.value = [];
    apiGet.mockClear();
    routerPush.mockClear();
  });

  it("navega para /expenses ao clicar na CTA do estado vazio", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <CashFlowPage />
      </QueryClientProvider>,
    );
    const heading = await screen.findByText("Sem lançamentos no período");
    const emptyStateContainer = heading.parentElement as HTMLElement;
    const cta = within(emptyStateContainer).getByRole("button");
    cta.click();

    expect(routerPush).toHaveBeenCalledWith("/projects/p1/expenses");
  });
});
