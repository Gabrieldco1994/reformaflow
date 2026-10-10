import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useFinancialAgent } from "./useFinancialAgent";

vi.mock("@/contexts/project-context", () => ({
  useProject: () => ({ projectId: "project-a" }),
}));
afterEach(() => vi.unstubAllGlobals());

function mount() {
  const client = new QueryClient();
  return renderHook(() => useFinancialAgent(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

it("present null importTurn cannot send a generic request", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      new Response(
        JSON.stringify({ reply: "Já lancei!", toolsUsed: ["create_expense"] }),
      ),
    );
  vi.stubGlobal("fetch", fetch);
  const h = mount();
  await act(async () => {
    await expect(
      h.result.current.send("sim", { importTurn: null }),
    ).rejects.toThrow();
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(h.result.current.messages).toEqual([]);
});

it("absent context preserves generic history, project and reply", async () => {
  const fetch = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ reply: "Resposta genérica", toolsUsed: [] }),
        ),
      ),
    );
  vi.stubGlobal("fetch", fetch);
  const h = mount();
  await act(async () => {
    await h.result.current.send("  oi  ");
  });
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
    projectId: "project-a",
    messages: [{ role: "user", content: "oi" }],
  });
  expect(h.result.current.messages.at(-1)?.content).toBe("Resposta genérica");
});
