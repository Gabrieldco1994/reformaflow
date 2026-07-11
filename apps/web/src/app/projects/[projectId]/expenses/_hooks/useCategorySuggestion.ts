'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';

export interface SuggestCategoryResponse {
  category: string | null;
  subcategory: string | null;
  confidence: number;
  source: string;
  suggestedTipoDespesa: string | null;
}

const DEBOUNCE_MS = 500;
const MIN_LENGTH = 3;

/**
 * Sugestão de categoria via IA (endpoint `/merchant-categories/suggest`),
 * debounced em 500ms. Prefere `fornecedor` (mais específico) quando
 * preenchido; caso contrário usa `titulo`. Nunca dispara para texto vazio
 * ou com menos de 3 caracteres. Erros de rede são engolidos (suggestion
 * volta a null, isFetching volta a false) — nunca lançam.
 */
export function useCategorySuggestion(titulo: string, fornecedor: string) {
  const [suggestion, setSuggestion] = useState<SuggestCategoryResponse | null>(null);
  const [isFetching, setIsFetching] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const text = (fornecedor?.trim() ? fornecedor : titulo)?.trim() ?? '';

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    if (text.length < MIN_LENGTH) {
      setSuggestion(null);
      setIsFetching(false);
      return;
    }

    timerRef.current = setTimeout(() => {
      setIsFetching(true);
      api
        .post('/merchant-categories/suggest', { text })
        .then((res) => {
          setSuggestion(res as SuggestCategoryResponse);
        })
        .catch(() => {
          setSuggestion(null);
        })
        .finally(() => {
          setIsFetching(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  return { suggestion, isFetching };
}
