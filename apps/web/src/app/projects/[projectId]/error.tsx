'use client';

import { useEffect } from 'react';
import { useRouter, useParams } from 'next/navigation';
import Clarity from '@microsoft/clarity';
import { ChevronLeft } from 'lucide-react';

const CLARITY_FALLBACK_PROJECT_ID = 'xp2t8pv3uc';
const clarityProjectId = process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID?.trim() || CLARITY_FALLBACK_PROJECT_ID;

export default function ProjectError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  const params = useParams<{ projectId: string }>();
  const projectId = params?.projectId;

  useEffect(() => {
    if (process.env.NODE_ENV === 'production' && clarityProjectId && typeof window !== 'undefined') {
      try {
        Clarity.setTag('boundary', `project:${projectId}`);
        Clarity.setTag('jsErrorMsg', (error.message || '').slice(0, 80));
      } catch (e) {
        // Clarity may not be initialized; silently fail
      }
    }
  }, [error, projectId]);

  return (
    <div className="min-h-screen flex flex-col bg-lifeone-bg">
      {/* Navigation bar — always accessible */}
      <div className="border-b border-lifeone-surface px-4 py-3 flex items-center gap-3 bg-lifeone-bg">
        <button
          onClick={() => router.back()}
          className="p-2 hover:bg-lifeone-surface rounded-lg transition-colors"
          aria-label="Voltar"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <h1 className="text-lg font-semibold">Erro</h1>
      </div>

      {/* Error content */}
      <div className="flex-1 flex items-center justify-center px-4">
        <div className="text-center max-w-md">
          <div className="mb-4 text-4xl">⚠️</div>
          <h2 className="text-xl font-bold mb-2">Algo deu errado</h2>
          <p className="text-lifeone-fg-secondary mb-6">
            Ocorreu um erro ao processar sua requisição. Tente novamente ou volte para a tela anterior.
          </p>
          <div className="flex gap-3">
            <button
              onClick={() => reset()}
              className="flex-1 px-4 py-2 bg-lifeone-primary text-white rounded-lg font-semibold hover:opacity-90 transition-opacity"
            >
              Tentar novamente
            </button>
            <button
              onClick={() => router.push(`/projects/${projectId}/monthly`)}
              className="flex-1 px-4 py-2 border border-lifeone-surface text-lifeone-fg rounded-lg font-semibold hover:bg-lifeone-surface transition-colors"
            >
              Ir para Cockpit
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
