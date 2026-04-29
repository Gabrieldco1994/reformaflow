const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

// TODO: substituir por token JWT real após integração Auth
const DEFAULT_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  'X-Tenant-Id': 'dev-tenant-1',
};

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { ...DEFAULT_HEADERS, ...options?.headers },
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Erro de rede' }));
    throw new Error(error.message ?? `HTTP ${res.status}`);
  }

  return res.json();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
