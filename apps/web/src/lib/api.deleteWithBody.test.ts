/**
 * #704 F9 — transporte do undo: `api.deleteWithBody(path, body, opts?)` (RED v2, ainda inexistente).
 * Só o `fetch` é substituído. A base da URL é a do módulo (default de teste), por isso o caminho
 * é comparado por sufixo — nenhuma variável de ambiente inerte. Erros HTTP/timeout seguem as
 * mesmas classes já cobertas em `api.test.ts` (que NÃO é copiado aqui); `api.delete` sem corpo é o controle.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiResponseError, ApiTimeoutError } from "./api";

function stubFetch(status: number, body: string) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(body === "" ? {} : JSON.parse(body)),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type DeleteWithBody = (path: string, body: unknown, opts?: { timeoutMs?: number; headers?: Record<string, string> }) => Promise<unknown>;
function deleteWithBody(): DeleteWithBody {
  const fn = Reflect.get(api, "deleteWithBody");
  expect(typeof fn, "api.deleteWithBody ausente").toBe("function");
  return fn as DeleteWithBody;
}

describe("F9 — transporte do DELETE com corpo", () => {
  it("envia DELETE com o corpo JSON serializado, credentials e a resposta JSON decodificada", async () => {
    const send = deleteWithBody();
    const fetchMock = stubFetch(200, JSON.stringify({ revision: 4, alreadyUndone: false }));
    const result = await send("/projects/p1/expenses/e1/refund-purpose", { expectedRevision: 3 });
    expect(result).toEqual({ revision: 4, alreadyUndone: false });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url).endsWith("/projects/p1/expenses/e1/refund-purpose")).toBe(true);
    expect(init.method).toBe("DELETE");
    expect(init.body).toBe(JSON.stringify({ expectedRevision: 3 }));
    expect(init.credentials).toBe("include");
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
  });

  it("headers extras do chamador são preservados junto do Content-Type", async () => {
    const send = deleteWithBody();
    const fetchMock = stubFetch(200, "{}");
    await send("/x", { expectedRevision: 1 }, { headers: { "X-Trace": "t-1" } });
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ "Content-Type": "application/json", "X-Trace": "t-1" });
  });

  it.each([409, 502])("HTTP %i chega como ApiResponseError real (status + body), não uma forma presumida", async (status) => {
    const send = deleteWithBody();
    stubFetch(status, JSON.stringify({ message: "Falhou", statusCode: status }));
    const error = await send("/x", { expectedRevision: 1 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiResponseError);
    expect((error as ApiResponseError).status).toBe(status);
    expect((error as ApiResponseError).body).toMatchObject({ statusCode: status });
  });

  it("opts.timeoutMs aborta o pedido e vira ApiTimeoutError (resultado desconhecido, não erro HTTP)", async () => {
    const send = deleteWithBody();
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
      ),
    );
    const pending = send("/x", { expectedRevision: 1 }, { timeoutMs: 50 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60);
    expect(await pending).toBeInstanceOf(ApiTimeoutError);
  });

  it("controle: api.delete existente segue DELETE sem corpo", async () => {
    const fetchMock = stubFetch(200, JSON.stringify({ ok: true }));
    await api.delete("/projects/p1/expenses/e1");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
  });
});
