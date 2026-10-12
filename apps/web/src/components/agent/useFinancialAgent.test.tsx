import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectProvider } from "@/contexts/project-context";
import { useFinancialAgent, type ChatMessage } from "./useFinancialAgent";

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: { post: mocks.post },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ProjectProvider
        value={{
          projectId: "project-1",
          projectType: "PESSOAL",
          projectName: "Pessoal",
        }}
      >
        {children}
      </ProjectProvider>
    </QueryClientProvider>
  );
  return renderHook(() => useFinancialAgent(), { wrapper });
}

describe("useFinancialAgent channel contract", () => {
  beforeEach(() => {
    mocks.post.mockReset();
  });

  it("sends exact per-request TEXT and VOICE bodies and keeps concurrent response origins isolated", async () => {
    const text = deferred<{
      reply: string;
      toolsUsed: string[];
      provider: string;
      importEntryAction: unknown;
    }>();
    const voice = deferred<{
      reply: string;
      toolsUsed: string[];
      provider: string;
      importEntryAction: unknown;
    }>();
    mocks.post
      .mockReturnValueOnce(text.promise)
      .mockReturnValueOnce(voice.promise);
    const { result } = setup();

    let textReply: Awaited<ReturnType<typeof result.current.send>> = null;
    let voiceReply: Awaited<ReturnType<typeof result.current.send>> = null;
    let textPending!: Promise<void>;
    let voicePending!: Promise<void>;
    act(() => {
      textPending = result.current
        .send("pedido digitado", { channel: "TEXT" })
        .then((reply) => {
          textReply = reply;
        });
      voicePending = result.current
        .send("pedido falado", { channel: "VOICE" })
        .then((reply) => {
          voiceReply = reply;
        });
    });

    expect(mocks.post).toHaveBeenNthCalledWith(
      1,
      "/agent/chat",
      {
        projectId: "project-1",
        metadata: { channel: "TEXT" },
        messages: [{ role: "user", content: "pedido digitado" }],
      },
      { timeoutMs: 120_000 },
    );
    expect(mocks.post).toHaveBeenNthCalledWith(
      2,
      "/agent/chat",
      {
        projectId: "project-1",
        metadata: { channel: "VOICE" },
        messages: [{ role: "user", content: "pedido falado" }],
      },
      { timeoutMs: 120_000 },
    );

    await act(async () => {
      voice.resolve({
        reply: "voz",
        toolsUsed: [],
        provider: "test",
        importEntryAction: {
          version: 1,
          kind: "START_CARD_INVOICE_IMPORT",
          originChannel: "VOICE",
          formats: ["CSV"],
          suggestedCardId: null,
        },
      });
      await voicePending;
      text.resolve({
        reply: "texto",
        toolsUsed: [],
        provider: "test",
        importEntryAction: {
          version: 1,
          kind: "START_CARD_INVOICE_IMPORT",
          originChannel: "TEXT",
          formats: ["CSV"],
          suggestedCardId: null,
        },
      });
      await textPending;
    });

    expect(
      (voiceReply as ChatMessage | null)?.importEntryAction?.originChannel,
    ).toBe("VOICE");
    expect(
      (textReply as ChatMessage | null)?.importEntryAction?.originChannel,
    ).toBe("TEXT");
  });

  it("defaults the generic endpoint to nested TEXT metadata", async () => {
    mocks.post.mockResolvedValue({
      reply: "ok",
      toolsUsed: [],
      provider: "test",
    });
    const { result } = setup();

    await act(async () => {
      await result.current.send("continuar");
    });

    expect(mocks.post).toHaveBeenCalledWith(
      "/agent/chat",
      {
        projectId: "project-1",
        metadata: { channel: "TEXT" },
        messages: [{ role: "user", content: "continuar" }],
      },
      { timeoutMs: 120_000 },
    );
  });
});
