const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

const DEFAULT_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
};

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    credentials: 'include',
    headers: { ...DEFAULT_HEADERS, ...options?.headers },
  });

  if (res.status === 401 && typeof window !== 'undefined') {
    const here = window.location.pathname;
    const isAuthFlow =
      here.startsWith('/login') || here.startsWith('/no-permission');
    const isMeProbe = path === '/auth/me';
    if (!isAuthFlow && !isMeProbe) {
      window.location.href = `/login?next=${encodeURIComponent(here)}`;
    }
  }

  if (!res.ok) {
    const error = await res.json().catch(() => ({ message: 'Erro de rede' }));
    const msg = Array.isArray(error.message)
      ? error.message.join('; ')
      : (error.message ?? `HTTP ${res.status}`);
    throw new Error(msg);
  }

  return res.json();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  upload: <T>(path: string, formData: FormData) =>
    fetch(`${API_BASE}${path}`, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    }).then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<T>;
    }),
};
