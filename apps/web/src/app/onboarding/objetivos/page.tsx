'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LifeOneLogo } from '@/components/LifeOneLogo';
import { ObjectiveSelector } from '@/components/objectives/ObjectiveSelector';
import type { ObjectiveType } from '@/components/objectives/objective-options';
import { ProjectType } from '@reformaflow/domain';
import { api } from '@/lib/api';

/** Exatamente 1 tipo -> jornada daquele tipo. 2+ -> sempre PESSOAL (denominador
 * comum); os outros projetos a pessoa cria depois pelo "+". */
function resolveDestination(selected: ObjectiveType[]): ObjectiveType {
  return selected.length === 1 ? selected[0] : ProjectType.PESSOAL;
}

export default function OnboardingObjetivosPage() {
  const router = useRouter();
  const [selected, setSelected] = useState<ObjectiveType[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submissionLock = useRef(false);

  async function handleContinue() {
    if (submissionLock.current) return;
    setError(null);
    if (selected.length === 0) {
      setError('Escolha pelo menos um objetivo para continuar.');
      return;
    }

    submissionLock.current = true;
    setSubmitting(true);
    try {
      // Persiste TODOS os tipos marcados — mesmo os que não vão definir a
      // jornada inicial. deriveObjectiveAccess libera os módulos dos dois.
      await api.patch('/auth/objectives', { projectTypes: selected });
      const destination = resolveDestination(selected);
      router.replace(`/onboarding/setup?type=${destination}`);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Não foi possível salvar seus objetivos. Tente novamente.',
      );
    } finally {
      submissionLock.current = false;
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-lifeone-canvas px-4 py-8 font-geist sm:px-6 sm:py-12">
      <div className="mx-auto w-full max-w-2xl">
        <header className="mb-8">
          <LifeOneLogo compact />
        </header>

        <div className="rounded-[22px] border border-lifeone-hairline bg-lifeone-card p-6 shadow-lifeone-card sm:p-8">
          <h1 className="text-[27px] font-bold tracking-[-0.035em] text-lifeone-ink sm:text-[32px]">
            O que você quer acompanhar?
          </h1>
          <p className="mt-2 text-[14px] leading-relaxed text-lifeone-ink-3">
            Marque um ou mais. Se marcar mais de um, começamos pelo controle Pessoal — os outros você cria depois pelo botão &quot;+&quot;.
          </p>

          {error && (
            <div
              role="alert"
              className="mt-5 rounded-[10px] border border-[#FECDCA] bg-[#FEF3F2] px-3 py-2.5 text-[13px] text-[#B42318]"
            >
              {error}
            </div>
          )}

          <div className="mt-6">
            <ObjectiveSelector selected={selected} onChange={setSelected} disabled={submitting} />
          </div>

          <div className="mt-6 flex justify-end border-t border-lifeone-hairline pt-5">
            <button
              type="button"
              onClick={handleContinue}
              disabled={submitting}
              className="inline-flex min-h-11 items-center justify-center rounded-[10px] bg-lifeone-blue px-5 text-[14px] font-semibold text-white hover:brightness-95 disabled:cursor-wait disabled:opacity-60"
            >
              {submitting ? 'Salvando…' : 'Continuar'}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
