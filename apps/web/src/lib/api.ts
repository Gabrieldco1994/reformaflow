function resolveApiBase(): string {
  const envBase = process.env.NEXT_PUBLIC_API_URL;
  if (envBase) return envBase;

  if (typeof window !== "undefined") {
    const { hostname } = window.location;
    if (hostname !== "localhost" && hostname !== "127.0.0.1") return "/api";
  }

  return "http://localhost:3001";
}

const API_BASE = resolveApiBase();

const DEFAULT_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
};

// Fly auto-suspende a máquina após inatividade; o primeiro request pode
// levar alguns segundos pra ela acordar. 25s cobre cold-start + margem.
const REQUEST_TIMEOUT_MS = 25_000;

interface RequestExtra {
  /** Timeout específico em ms (sobrepõe o default de 25s). Ex.: Copilot/LLM. */
  timeoutMs?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export class ApiResponseError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiResponseError";
  }
}

export class ApiTimeoutError extends Error {
  constructor() {
    super(
      "O servidor demorou mais que o esperado pra responder. Tente novamente.",
    );
    this.name = "ApiTimeoutError";
  }
}

async function request<T>(
  path: string,
  options?: RequestInit,
  extra?: RequestExtra,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort();
  const checkAbort = () => {
    if (controller.signal.aborted) {
      if (timedOut) throw new ApiTimeoutError();
      throw new DOMException("Request cancelled", "AbortError");
    }
  };
  if (extra?.signal?.aborted) abortFromCaller();
  extra?.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      timedOut = true;
      controller.abort();
    }
  }, extra?.timeoutMs ?? REQUEST_TIMEOUT_MS);
  try {
    checkAbort();
    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      credentials: "include",
      headers: { ...DEFAULT_HEADERS, ...extra?.headers, ...options?.headers },
      signal: controller.signal,
    });
    checkAbort();

    if (res.status === 401 && typeof window !== "undefined") {
      const here = window.location.pathname;
      const isAuthFlow =
        here.startsWith("/login") ||
        here.startsWith("/register") ||
        here.startsWith("/no-permission");
      const isMeProbe = path === "/auth/me";
      if (!isAuthFlow && !isMeProbe) {
        window.location.href = `/login?next=${encodeURIComponent(here)}`;
      }
    }

    if (!res.ok) {
      const error = await res.json().catch(() => ({ message: "Erro de rede" }));
      checkAbort();
      const msg = Array.isArray(error.message)
        ? error.message.join("; ")
        : (error.message ?? `HTTP ${res.status}`);
      throw new ApiResponseError(msg, res.status, error);
    }

    const text = await res.text();
    checkAbort();
    if (text.trim() === "") return null as T;
    return JSON.parse(text) as T;
  } catch (err) {
    checkAbort();
    throw err;
  } finally {
    clearTimeout(timer);
    extra?.signal?.removeEventListener("abort", abortFromCaller);
  }
}

export const api = {
  get: <T>(path: string, opts?: RequestExtra) =>
    request<T>(path, undefined, opts),
  post: <T>(path: string, body: unknown, opts?: RequestExtra) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body) }, opts),
  patch: <T>(path: string, body: unknown, opts?: RequestExtra) =>
    request<T>(path, { method: "PATCH", body: JSON.stringify(body) }, opts),
  put: <T>(path: string, body: unknown, opts?: RequestExtra) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }, opts),
  putBytes: <T>(path: string, body: Blob, opts?: RequestExtra) =>
    request<T>(
      path,
      {
        method: "PUT",
        body,
        headers: { "Content-Type": "application/octet-stream" },
      },
      opts,
    ),
  delete: <T>(path: string, opts?: RequestExtra) =>
    request<T>(path, { method: "DELETE" }, opts),
  deleteWithBody: <T>(path: string, body: unknown, opts?: RequestExtra) =>
    request<T>(path, { method: "DELETE", body: JSON.stringify(body) }, opts),
  upload: <T>(
    path: string,
    formData: FormData,
    opts?: { timeoutMs?: number },
  ) => {
    const timeoutMs = opts?.timeoutMs ?? 90_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(`${API_BASE}${path}`, {
      method: "POST",
      credentials: "include",
      body: formData,
      signal: controller.signal,
    })
      .then(async (res) => {
        if (res.status === 401 && typeof window !== "undefined") {
          const here = window.location.pathname;
          const isAuthFlow =
            here.startsWith("/login") ||
            here.startsWith("/register") ||
            here.startsWith("/no-permission");
          if (!isAuthFlow) {
            window.location.href = `/login?next=${encodeURIComponent(here)}`;
          }
        }
        if (!res.ok) {
          const error = await res
            .json()
            .catch(() => ({ message: `HTTP ${res.status}` }));
          const msg = Array.isArray(error.message)
            ? error.message.join("; ")
            : (error.message ?? `HTTP ${res.status}`);
          throw new ApiResponseError(msg, res.status, error);
        }
        return res.json() as Promise<T>;
      })
      .catch((err) => {
        if (err?.name === "AbortError") {
          throw new Error(
            `Upload demorou demais (>${Math.round(timeoutMs / 1000)}s). Verifique sua conexão e tente novamente.`,
          );
        }
        throw err;
      })
      .finally(() => clearTimeout(timer));
  },
  download: async (path: string, fileName: string) => {
    const res = await fetch(`${API_BASE}${path}`, { credentials: "include" });
    if (!res.ok) {
      const error = await res
        .json()
        .catch(() => ({ message: `HTTP ${res.status}` }));
      throw new ApiResponseError(
        error.message ?? `HTTP ${res.status}`,
        res.status,
      );
    }
    const objectUrl = URL.createObjectURL(await res.blob());
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(objectUrl);
  },
};
