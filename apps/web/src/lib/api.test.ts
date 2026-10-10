import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiResponseError } from "./api";

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

describe("api — signal do chamador e putBytes", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_API_URL", "http://localhost:3001");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("encaminha o abort do chamador ao fetch sem virar timeout", async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const e = new Error("aborted");
            e.name = "AbortError";
            reject(e);
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const caller = new AbortController();
    const pending = api.get("/x", { signal: caller.signal });
    caller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("putBytes envia Blob como octet-stream via PUT", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{"ok":true}'),
    });
    vi.stubGlobal("fetch", fetchMock);
    const blob = new Blob(["a,b"]);
    await api.putBytes("/up", blob);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(blob);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/octet-stream",
    );
  });
});
