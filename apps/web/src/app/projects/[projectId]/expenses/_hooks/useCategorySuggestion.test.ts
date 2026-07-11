import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useCategorySuggestion } from './useCategorySuggestion';

const postMock = vi.fn();
vi.mock('@/lib/api', () => ({
  api: { post: (...args: unknown[]) => postMock(...args) },
}));

describe('useCategorySuggestion', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    postMock.mockReset();
    postMock.mockResolvedValue({
      category: 'Material',
      subcategory: null,
      confidence: 0.9,
      source: 'REGEX',
      suggestedTipoDespesa: 'MATERIAL_CONSTRUCAO',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('não dispara antes de 500ms', () => {
    renderHook(({ titulo, fornecedor }) => useCategorySuggestion(titulo, fornecedor), {
      initialProps: { titulo: 'Cimento', fornecedor: '' },
    });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(postMock).not.toHaveBeenCalled();
  });

  it('dispara 1x após múltiplas mudanças rápidas (debounce)', async () => {
    const { rerender } = renderHook(
      ({ titulo, fornecedor }) => useCategorySuggestion(titulo, fornecedor),
      { initialProps: { titulo: 'Cim', fornecedor: '' } },
    );
    act(() => {
      vi.advanceTimersByTime(200);
    });
    rerender({ titulo: 'Ciment', fornecedor: '' });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    rerender({ titulo: 'Cimento', fornecedor: '' });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock).toHaveBeenCalledWith('/merchant-categories/suggest', { text: 'Cimento' });
  });

  it('prefere fornecedor quando preenchido', async () => {
    renderHook(({ titulo, fornecedor }) => useCategorySuggestion(titulo, fornecedor), {
      initialProps: { titulo: 'Cimento', fornecedor: 'Leroy Merlin' },
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    await waitFor(() => expect(postMock).toHaveBeenCalledTimes(1));
    expect(postMock).toHaveBeenCalledWith('/merchant-categories/suggest', { text: 'Leroy Merlin' });
  });

  it('texto vazio nunca dispara', () => {
    renderHook(({ titulo, fornecedor }) => useCategorySuggestion(titulo, fornecedor), {
      initialProps: { titulo: '', fornecedor: '' },
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(postMock).not.toHaveBeenCalled();
  });

  it('texto menor que 3 chars nunca dispara', () => {
    renderHook(({ titulo, fornecedor }) => useCategorySuggestion(titulo, fornecedor), {
      initialProps: { titulo: 'Ci', fornecedor: '' },
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(postMock).not.toHaveBeenCalled();
  });

  it('erro de rede não quebra o hook: suggestion fica null, isFetching volta a false', async () => {
    postMock.mockReset();
    postMock.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(({ titulo, fornecedor }) => useCategorySuggestion(titulo, fornecedor), {
      initialProps: { titulo: 'Cimento', fornecedor: '' },
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(result.current.suggestion).toBeNull();
  });
});
