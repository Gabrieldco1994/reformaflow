'use client';

import { useEffect } from 'react';
import Clarity from '@microsoft/clarity';

const CLARITY_FALLBACK_PROJECT_ID = 'xp2t8pv3uc';
const clarityProjectId = process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID?.trim() || CLARITY_FALLBACK_PROJECT_ID;

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (process.env.NODE_ENV === 'production' && clarityProjectId && typeof window !== 'undefined') {
      try {
        Clarity.setTag('boundary', 'generic');
        Clarity.setTag('jsErrorMsg', (error.message || '').slice(0, 80));
      } catch (e) {
        // Clarity may not be initialized; silently fail
      }
    }
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-lifeone-bg">
      <div className="text-center max-w-md">
        <div className="mb-4 text-4xl">⚠️</div>
        <h1 className="text-2xl font-bold mb-2">Algo deu errado</h1>
        <p className="text-lifeone-fg-secondary mb-6">
          Ocorreu um erro ao carregar esta página. Tente novamente.
        </p>
        <button
          onClick={() => reset()}
          className="px-4 py-2 bg-lifeone-primary text-white rounded-lg font-semibold hover:opacity-90 transition-opacity"
        >
          Tentar novamente
        </button>
      </div>
    </div>
  );
}
