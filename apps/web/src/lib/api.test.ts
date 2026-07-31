import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiResponseError } from './api';

function mockFetchOnce(response: {
  ok: boolean;
  status: number;
  body: string;
}) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: response.ok,
      status: response.status,
      text: () => Promise.resolve(response.body),
      json: () => Promise.resolve(response.body === '' ? {} : JSON.parse(response.body)),
    }),
  );
}

describe('api.get — corpo vazio vira null', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://localhost:3001');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('200 com corpo vazio resolve null', async () => {
    mockFetchOnce({ ok: true, status: 200, body: '' });

    const result = await api.get('/projects/1/financing');

    expect(result).toBeNull();
  });

  it('200 com JSON válido resolve o objeto', async () => {
    mockFetchOnce({ ok: true, status: 200, body: JSON.stringify({ instituicao: 'Banco X' }) });

    const result = await api.get('/projects/1/financing');

    expect(result).toEqual({ instituicao: 'Banco X' });
  });

  it('200 com JSON malformado LANÇA', async () => {
    mockFetchOnce({ ok: true, status: 200, body: '{oops' });

    await expect(api.get('/projects/1/financing')).rejects.toThrow();
  });

  it('204 sem corpo resolve null', async () => {
    mockFetchOnce({ ok: true, status: 204, body: '' });

    const result = await api.get('/projects/1/financing');

    expect(result).toBeNull();
  });

  it('200 com corpo só com espaços resolve null', async () => {
    mockFetchOnce({ ok: true, status: 200, body: '   \n  ' });

    const result = await api.get('/projects/1/financing');

    expect(result).toBeNull();
  });

  it('resposta de erro (4xx/5xx) continua lançando ApiResponseError com a mensagem da API', async () => {
    mockFetchOnce({
      ok: false,
      status: 400,
      body: JSON.stringify({ message: 'Dados inválidos' }),
    });

    await expect(api.get('/projects/1/financing')).rejects.toThrow(ApiResponseError);
    await expect(api.get('/projects/1/financing')).rejects.toThrow('Dados inválidos');
  });
});
