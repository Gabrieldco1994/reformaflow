'use client';

import { useEffect } from 'react';
import Clarity from '@microsoft/clarity';

const CLARITY_FALLBACK_PROJECT_ID = 'xp2t8pv3uc';
const clarityProjectId = process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID?.trim() || CLARITY_FALLBACK_PROJECT_ID;

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (process.env.NODE_ENV === 'production' && clarityProjectId && typeof window !== 'undefined') {
      try {
        Clarity.setTag('boundary', 'global');
        Clarity.setTag('jsErrorMsg', (error.message || '').slice(0, 80));
      } catch (e) {
        // Clarity may not be initialized; silently fail
      }
    }
  }, [error]);

  return (
    <html>
      <body className="bg-lifeone-bg text-lifeone-fg">
        <div className="min-h-screen flex items-center justify-center px-4">
          <div className="text-center max-w-md">
            <div className="mb-4 text-4xl">⚠️</div>
            <h1 className="text-2xl font-bold mb-2">Algo deu errado</h1>
            <p className="text-lifeone-fg-secondary mb-6">
              Desculpe, ocorreu um erro inesperado. Tente recarregar a página.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-lifeone-primary text-white rounded-lg font-semibold hover:opacity-90 transition-opacity"
            >
              Recarregar
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
