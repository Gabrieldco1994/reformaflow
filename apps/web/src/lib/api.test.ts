import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiResponseError, ApiTimeoutError } from "./api";

function mockFetchOnce(response: {
  ok: boolean;
  status: number;
  body: string;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: response.ok,
      status: response.status,
      text: () => Promise.resolve(response.body),
      json: () =>
        Promise.resolve(response.body === "" ? {} : JSON.parse(response.body)),
    }),
  );
}

describe("api.get — corpo vazio vira null", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "http://localhost:3001");
  });

  describe("api.putBytes — shared request transport", () => {
    const fetchStub = vi.fn<typeof fetch>();
    const bytes = new Uint8Array([0, 255, 128, 13, 10, 42]);
    const blob = () => new Blob([bytes], { type: "application/pdf" });

    beforeEach(() => {
      vi.useFakeTimers();
      fetchStub.mockReset();
      vi.stubGlobal("fetch", fetchStub);
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it("passes the identical binary Blob with octet-stream, cookies and no manual length", async () => {
      const body = blob();
      const caller = new AbortController();
      const remove = vi.spyOn(caller.signal, "removeEventListener");
      fetchStub.mockResolvedValue(new Response('{"revision":3}'));

      await expect(
        api.putBytes("/binary", body, {
          signal: caller.signal,
          headers: {
            "x-rf-import-ui": "1",
            "Content-Type": "application/json",
          },
        }),
      ).resolves.toEqual({ revision: 3 });

      expect(fetchStub).toHaveBeenCalledTimes(1);
      const options = fetchStub.mock.calls[0][1];
      expect(options?.method).toBe("PUT");
      expect(options?.body).toBe(body);
      expect(body.size).toBe(bytes.length);
      expect(body.type).toBe("application/pdf");
      expect(options?.credentials).toBe("include");
      expect(options?.headers).toEqual({
        "Content-Type": "application/octet-stream",
        "x-rf-import-ui": "1",
      });
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
      caller.abort();
      expect(options?.signal?.aborted).toBe(false);
    });

    it("does not fetch for an already aborted signal and cleans up", async () => {
      const caller = new AbortController();
      caller.abort();
      const remove = vi.spyOn(caller.signal, "removeEventListener");
      await expect(
        api.putBytes("/binary", blob(), { signal: caller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(fetchStub).not.toHaveBeenCalled();
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
    });

    it("propagates caller abort while reading the response instead of returning success", async () => {
      const caller = new AbortController();
      const remove = vi.spyOn(caller.signal, "removeEventListener");
      let finish!: (value: string) => void;
      const response = new Response();
      vi.spyOn(response, "text").mockImplementation(
        () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
      );
      fetchStub.mockResolvedValue(response);
      const request = api.putBytes("/binary", blob(), {
        signal: caller.signal,
      });
      const assertion = expect(request).rejects.toMatchObject({
        name: "AbortError",
      });
      await Promise.resolve();
      caller.abort();
      finish('{"revision":3}');
      await assertion;
      expect(fetchStub).toHaveBeenCalledTimes(1);
      expect(fetchStub.mock.calls[0][1]?.signal?.aborted).toBe(true);
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([undefined, 100])(
      "keeps the default timeout and explicit override (%s)",
      async (timeoutMs) => {
        const caller = new AbortController();
        const remove = vi.spyOn(caller.signal, "removeEventListener");
        fetchStub.mockImplementation(
          (_url, options) =>
            new Promise((_resolve, reject) => {
              options?.signal?.addEventListener("abort", () =>
                reject(new DOMException("Aborted", "AbortError")),
              );
            }),
        );
        const request = api.putBytes("/binary", blob(), {
          signal: caller.signal,
          timeoutMs,
        });
        const assertion =
          expect(request).rejects.toBeInstanceOf(ApiTimeoutError);
        await vi.advanceTimersByTimeAsync((timeoutMs ?? 25_000) - 1);
        expect(fetchStub.mock.calls[0][1]?.signal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await assertion;
        expect(fetchStub).toHaveBeenCalledTimes(1);
        expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
        expect(vi.getTimerCount()).toBe(0);
      },
    );

    it("preserves HTTP errors and cleanup without retry", async () => {
      const caller = new AbortController();
      const remove = vi.spyOn(caller.signal, "removeEventListener");
      fetchStub.mockResolvedValue(
        new Response('{"message":"Unavailable"}', { status: 503 }),
      );
      await expect(
        api.putBytes("/binary", blob(), { signal: caller.signal }),
      ).rejects.toMatchObject({
        name: "ApiResponseError",
        status: 503,
        body: { message: "Unavailable" },
      });
      expect(fetchStub).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
    });

    it("rejects malformed JSON and preserves empty-response semantics", async () => {
      fetchStub.mockResolvedValueOnce(new Response("{broken"));
      await expect(api.putBytes("/binary", blob())).rejects.toBeInstanceOf(
        SyntaxError,
      );
      expect(vi.getTimerCount()).toBe(0);
      fetchStub.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await expect(api.putBytes("/binary", blob())).resolves.toBeNull();
      expect(fetchStub).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("leaves every existing JSON method and its defaults unchanged", async () => {
      fetchStub.mockImplementation(async () => new Response('{"ok":true}'));
      const body = { value: 42 };
      await api.get("/json");
      await api.post("/json", body);
      await api.patch("/json", body);
      await api.put("/json", body);
      await api.delete("/json");
      await api.deleteWithBody("/json", body);
      expect(
        fetchStub.mock.calls.map(([, options]) => [
          options?.method ?? "GET",
          options?.body,
          options?.headers,
          options?.credentials,
        ]),
      ).toEqual(
        ["GET", "POST", "PATCH", "PUT", "DELETE", "DELETE"].map(
          (method, index) => [
            method,
            [1, 2, 3, 5].includes(index) ? '{"value":42}' : undefined,
            { "Content-Type": "application/json" },
            "include",
          ],
        ),
      );
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("request cancellation", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    it("classifies an actually elapsed deadline as timeout, not caller cancellation", async () => {
      vi.useRealTimers();
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url, options: RequestInit) =>
            new Promise((_resolve, reject) => {
              options.signal?.addEventListener("abort", () =>
                reject(new DOMException("Aborted", "AbortError")),
              );
            }),
        ),
      );
      await expect(
        api.get("/elapsed-deadline", { timeoutMs: 5 }),
      ).rejects.toBeInstanceOf(ApiTimeoutError);
    });

    it("does not fetch with an already aborted caller signal", async () => {
      const caller = new AbortController();
      caller.abort();
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      await expect(
        api.get("/cancelled", { signal: caller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(fetch).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("honors caller cancellation while reading the body and cleans listener/timer", async () => {
      const caller = new AbortController();
      const remove = vi.spyOn(caller.signal, "removeEventListener");
      let finish!: (value: string) => void;
      const body = new Promise<string>((resolve) => {
        finish = resolve;
      });
      const fetch = vi
        .fn()
        .mockResolvedValue({ ok: true, status: 200, text: () => body });
      vi.stubGlobal("fetch", fetch);
      const request = api.get("/pending-body", { signal: caller.signal });
      const assertion = expect(request).rejects.toMatchObject({
        name: "AbortError",
      });
      await Promise.resolve();
      caller.abort();
      finish('{"accepted":true}');
      await assertion;
      expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
    });

    it("keeps the old 25s timeout without a caller and removes listeners on timeout", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url, options: RequestInit) =>
            new Promise((_resolve, reject) => {
              options.signal?.addEventListener("abort", () =>
                reject(new DOMException("Aborted", "AbortError")),
              );
            }),
        ),
      );
      const caller = new AbortController();
      const remove = vi.spyOn(caller.signal, "removeEventListener");
      const withCaller = api.get("/timeout", {
        signal: caller.signal,
        timeoutMs: 100,
      });
      const failed = withCaller.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(100);
      expect(await failed).toBeInstanceOf(ApiTimeoutError);
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      const old = api.get("/old-default");
      const oldFailed = old.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(24_999);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await oldFailed).toBeInstanceOf(ApiTimeoutError);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("cleans up after success and preserves cookies and headers", async () => {
      const caller = new AbortController();
      const remove = vi.spyOn(caller.signal, "removeEventListener");
      const fetch = vi.fn().mockResolvedValue(new Response('{"ok":true}'));
      vi.stubGlobal("fetch", fetch);
      await expect(
        api.post(
          "/ok",
          {},
          { signal: caller.signal, headers: { "x-rf-import-ui": "1" } },
        ),
      ).resolves.toEqual({ ok: true });
      expect(fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "x-rf-import-ui": "1",
          },
        }),
      );
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      caller.abort();
      expect(fetch.mock.calls[0][1].signal.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("200 com corpo vazio resolve null", async () => {
    mockFetchOnce({ ok: true, status: 200, body: "" });

    const result = await api.get("/projects/1/financing");

    expect(result).toBeNull();
  });

  it("200 com JSON válido resolve o objeto", async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      body: JSON.stringify({ instituicao: "Banco X" }),
    });

    const result = await api.get("/projects/1/financing");

    expect(result).toEqual({ instituicao: "Banco X" });
  });

  it("200 com JSON malformado LANÇA", async () => {
    mockFetchOnce({ ok: true, status: 200, body: "{oops" });

    await expect(api.get("/projects/1/financing")).rejects.toThrow();
  });

  it("204 sem corpo resolve null", async () => {
    mockFetchOnce({ ok: true, status: 204, body: "" });

    const result = await api.get("/projects/1/financing");

    expect(result).toBeNull();
  });

  it("200 com corpo só com espaços resolve null", async () => {
    mockFetchOnce({ ok: true, status: 200, body: "   \n  " });

    const result = await api.get("/projects/1/financing");

    expect(result).toBeNull();
  });

  it("resposta de erro (4xx/5xx) continua lançando ApiResponseError com a mensagem da API", async () => {
    mockFetchOnce({
      ok: false,
      status: 400,
      body: JSON.stringify({ message: "Dados inválidos" }),
    });

    await expect(api.get("/projects/1/financing")).rejects.toThrow(
      ApiResponseError,
    );
    await expect(api.get("/projects/1/financing")).rejects.toThrow(
      "Dados inválidos",
    );
  });

  it("upload preserva status e validação para distinguir rejeição de resultado desconhecido", async () => {
    mockFetchOnce({
      ok: false,
      status: 400,
      body: JSON.stringify({ message: "INLINE_TARGET_INVALID" }),
    });
    await expect(
      api.upload("/import?mode=commit", new FormData()),
    ).rejects.toMatchObject({
      name: "ApiResponseError",
      status: 400,
      message: "INLINE_TARGET_INVALID",
    });
  });
});
