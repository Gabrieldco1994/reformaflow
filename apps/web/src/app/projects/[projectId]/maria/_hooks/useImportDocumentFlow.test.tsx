import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useImportDocumentFlow } from "./useImportDocumentFlow";
import { workflowFixture } from "../_lib/import-workflow-fixtures";
import { importRoot } from "../_lib/import-session-keys";

const auth = vi.hoisted(() => ({
  user: { id: "actor-a" } as { id: string } | null,
}));
vi.mock("@/contexts/auth-context", () => ({ useAuth: () => auth }));
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function pendingFixture() {
  const view = workflowFixture();
  view.state = "DRAFT";
  view.lines = [];
  view.selectedLineIds = [];
  view.proposal = null;
  view.actions = ["ANALYZE", "CANCEL"];
  view.attachments = ["a", "b"].map((id) => ({
    id,
    fileName: `${id}.pdf`,
    declaredBytes: 12,
    state: "ATTACHED",
    materializedInSession: false,
    canAnalyze: true,
  }));
  return view;
}

describe("inactive documentary sequencing: actual hook, transport and readers", () => {
  let current: ReturnType<typeof workflowFixture>;
  let client: QueryClient;
  let writes: Array<{ id: string; revision: number }>;
  let post: (id: string, revision: number) => Promise<Response>;
  let fetchStub: ReturnType<typeof vi.fn>;
  function complete(id: string) {
    current.revision++;
    const attachment = current.attachments.find((a) => a.id === id);
    if (!attachment) throw new Error("Unknown synthetic reference");
    attachment.materializedInSession = true;
    attachment.canAnalyze = false;
    current.actions = current.attachments.some((a) => a.canAnalyze)
      ? ["ANALYZE", "CANCEL"]
      : ["CANCEL"];
  }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T03:00:00Z"));
    auth.user = { id: "actor-a" };
    current = pendingFixture();
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    writes = [];
    post = async (id) => {
      complete(id);
      return reply(current);
    };
    fetchStub = vi.fn(async (url: string, options?: RequestInit) => {
      const path = new URL(url).pathname;
      if (options?.method === "POST") {
        expect(path).toMatch(
          /^\/import-sessions\/session-a\/attachments\/[ab]\/analyze$/,
        );
        const id = path.split("/")[4];
        const body = JSON.parse(String(options.body));
        expect(Object.keys(body)).toEqual(["expectedRevision"]);
        writes.push({ id, revision: body.expectedRevision });
        return post(id, body.expectedRevision);
      }
      expect(options?.method ?? "GET").toBe("GET");
      return reply({ ...current, id: path.split("/")[2] });
    });
    vi.stubGlobal("fetch", fetchStub);
  });
  afterEach(() => {
    client.clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  function mount() {
    return renderHook(({ id }) => useImportDocumentFlow(id), {
      initialProps: { id: "session-a" },
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
  }
  async function ready(h: ReturnType<typeof mount>) {
    await waitFor(() => expect(h.result.current.view?.id).toBe("session-a"));
  }
  it.each(["recovery-first", "initial-first"] as const)(
    "deferred GET ordering %s retains recovered revision 8 and completed A",
    async (order) => {
      const initial = deferred<Response>();
      const recovery = deferred<Response>();
      const initialResponse = reply(current);
      fetchStub
        .mockReturnValueOnce(initial.promise)
        .mockReturnValueOnce(recovery.promise);
      const h = mount();
      const key = [...importRoot("actor-a"), "workflow", "session-a"];
      await waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(1));
      expect(h.result.current.view).toBeNull();
      if (order === "initial-first") {
        await act(async () => {
          initial.resolve(initialResponse);
        });
        await ready(h);
        expect(h.result.current.view?.revision).toBe(7);
        expect(
          h.result.current.view?.attachments[0].materializedInSession,
        ).toBe(false);
        expect(h.result.current.error).toBeNull();
      }
      let recovering!: Promise<void>;
      act(() => {
        recovering = h.result.current.recover();
      });
      await waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(2));
      complete("a");
      await act(async () => {
        recovery.resolve(reply(current));
        await recovering;
      });
      await waitFor(() => expect(h.result.current.view?.revision).toBe(8));
      expect(h.result.current.error).toBeNull();
      if (order === "recovery-first") {
        expect(h.result.current.busy).toBe(true);
        await act(async () => {
          initial.resolve(initialResponse);
        });
      }
      await waitFor(() => expect(h.result.current.busy).toBe(false));
      expect(client.getQueryData(key)).toMatchObject({
        revision: 8,
        attachments: [
          { id: "a", materializedInSession: true, canAnalyze: false },
          { id: "b", materializedInSession: false, canAnalyze: true },
        ],
      });
      expect(h.result.current.view).toEqual(client.getQueryData(key));
      if (order === "recovery-first")
        expect(h.result.current.error).not.toBeNull();
      else expect(h.result.current.error).toBeNull();
      expect(fetchStub).toHaveBeenCalledTimes(2);
      for (const [url, options] of fetchStub.mock.calls) {
        expect(new URL(url).pathname).toBe("/import-sessions/session-a");
        expect(options?.method ?? "GET").toBe("GET");
        expect(options?.signal?.aborted).toBe(false);
      }
      expect(writes).toEqual([]);
      h.unmount();
    },
  );
  it("GET and reload never write; explicit batch advances the latest revision with zero observations", async () => {
    const h = mount();
    await ready(h);
    expect(writes).toEqual([]);
    await act(async () => {
      await h.result.current.recover();
    });
    expect(writes).toEqual([]);
    await act(async () => {
      await h.result.current.analyze();
    });
    expect(writes).toEqual([
      { id: "a", revision: 7 },
      { id: "b", revision: 8 },
    ]);
    expect(h.result.current.view?.revision).toBe(9);
    expect(h.result.current.view?.lines).toEqual([]);
    expect(
      h.result.current.view?.attachments.every((a) => a.materializedInSession),
    ).toBe(true);
    expect(h.result.current.view?.actions).toEqual(["CANCEL"]);
    expect(h.result.current.error).toBeNull();
    h.unmount();
  });
  it("accepts already completed replay at the same revision without inventing an increment", async () => {
    current.attachments = [current.attachments[0]];
    post = async (id) => {
      complete(id);
      current.revision--;
      return reply(current);
    };
    const h = mount();
    await ready(h);
    await act(async () => {
      await h.result.current.analyze();
    });
    expect(h.result.current.error).toBeNull();
    expect(h.result.current.view?.revision).toBe(7);
    expect(h.result.current.view?.attachments[0].materializedInSession).toBe(
      true,
    );
    h.unmount();
  });
  it.each(["lost", "malformed", "conflict"] as const)(
    "retains A after %s B; requires GET, then explicit retry only if B remains eligible",
    async (failure) => {
      post = async (id) => {
        if (id === "a") {
          complete(id);
          return reply(current);
        }
        if (failure === "lost") throw new TypeError("Synthetic response lost");
        if (failure === "conflict") return reply({}, 409);
        return reply({ ok: true });
      };
      const h = mount();
      await ready(h);
      await act(async () => {
        await h.result.current.analyze();
      });
      expect(h.result.current.error).not.toBeNull();
      expect(h.result.current.view?.attachments[0].materializedInSession).toBe(
        true,
      );
      expect(h.result.current.view?.attachments[1].materializedInSession).toBe(
        false,
      );
      await act(async () => {
        await h.result.current.analyze("b");
      });
      expect(writes).toHaveLength(2);
      post = async (id) => {
        complete(id);
        return reply(current);
      };
      await act(async () => {
        await h.result.current.recover();
      });
      expect(writes).toHaveLength(2);
      expect(h.result.current.error).toBeNull();
      await act(async () => {
        await h.result.current.analyze("b");
      });
      expect(writes).toEqual([
        { id: "a", revision: 7 },
        { id: "b", revision: 8 },
        { id: "b", revision: 8 },
      ]);
      h.unmount();
    },
  );
  it("lost successful completion is recovered by GET and never repeated", async () => {
    post = async (id) => {
      complete(id);
      if (id === "b") throw new TypeError("Lost");
      return reply(current);
    };
    const h = mount();
    await ready(h);
    await act(async () => {
      await h.result.current.analyze();
    });
    await act(async () => {
      await h.result.current.recover();
    });
    expect(
      h.result.current.view?.attachments.every((a) => a.materializedInSession),
    ).toBe(true);
    await act(async () => {
      await h.result.current.analyze("b");
    });
    expect(writes).toHaveLength(2);
    expect(h.result.current.error).not.toBeNull();
    h.unmount();
  });
  it("OFF/RAW pending state is read-only and cannot be made eligible locally", async () => {
    current.actions = ["CANCEL"];
    current.attachments.forEach((a) => {
      a.canAnalyze = false;
    });
    const h = mount();
    await ready(h);
    await act(async () => {
      await h.result.current.analyze();
    });
    expect(writes).toEqual([]);
    expect(h.result.current.error).not.toBeNull();
    h.unmount();
  });
  it("locks double clicks and stops before B when a concurrent revision supersedes A", async () => {
    const delayed = deferred<Response>();
    post = async () => delayed.promise;
    const h = mount();
    await ready(h);
    let running!: Promise<void>;
    act(() => {
      running = h.result.current.analyze();
      void h.result.current.analyze();
    });
    await waitFor(() => expect(writes).toHaveLength(1));
    const newer = pendingFixture();
    newer.revision = 30;
    act(() => {
      client.setQueryData(
        [...importRoot("actor-a"), "workflow", "session-a"],
        newer,
      );
    });
    complete("a");
    await act(async () => {
      delayed.resolve(reply(current));
      await running;
    });
    expect(h.result.current.view?.revision).toBe(30);
    expect(writes).toHaveLength(1);
    expect(h.result.current.error).not.toBeNull();
    h.unmount();
  });
  it.each(["user", "session", "unmount"] as const)(
    "fences late completion after %s changes",
    async (change) => {
      const delayed = deferred<Response>();
      post = async () => delayed.promise;
      const h = mount();
      await ready(h);
      let running!: Promise<void>;
      act(() => {
        running = h.result.current.analyze();
      });
      await waitFor(() => expect(writes).toHaveLength(1));
      const signal = fetchStub.mock.calls.find(
        ([, options]) => options?.method === "POST",
      )?.[1]?.signal;
      if (change === "unmount") h.unmount();
      else {
        if (change === "user") auth.user = { id: "actor-b" };
        h.rerender({ id: change === "session" ? "session-b" : "session-a" });
      }
      expect(signal?.aborted).toBe(true);
      complete("a");
      await act(async () => {
        delayed.resolve(reply(current));
        await running;
      });
      expect(writes).toHaveLength(1);
      if (change !== "unmount") h.unmount();
    },
  );
});
