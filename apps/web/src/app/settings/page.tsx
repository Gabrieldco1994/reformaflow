'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, CheckCircle2 } from 'lucide-react';
import { LifeOneLogo } from '@/components/LifeOneLogo';
import { ObjectiveSelector } from '@/components/objectives/ObjectiveSelector';
import {
  isObjectiveType,
  type ObjectiveType,
} from '@/components/objectives/objective-options';
import { useAuth } from '@/contexts/auth-context';

export default function SettingsPage() {
  const router = useRouter();
  const { user, loading, updateObjectives } = useAuth();
  const initialObjectives = useMemo(
    () => (user?.allowedProjectTypes ?? []).filter(isObjectiveType),
    [user?.allowedProjectTypes],
  );
  const [projectTypes, setProjectTypes] = useState<ObjectiveType[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const initializedFor = useRef<string | null>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, router, user]);

  useEffect(() => {
    if (!user || initializedFor.current === user.id) return;
    initializedFor.current = user.id;
    setProjectTypes(initialObjectives);
  }, [initialObjectives, user]);

  useEffect(() => {
    if (error) feedbackRef.current?.focus();
  }, [error]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSaved(false);
    if (projectTypes.length === 0) {
      setError('Selecione pelo menos um objetivo.');
      return;
    }
    setSaving(true);
    try {
      await updateObjectives(projectTypes);
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Não foi possível salvar seus objetivos.');
    } finally {
      setSaving(false);
    }
  }

  if (loading || !user) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-lifeone-surface">
        <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-lifeone-blue" aria-label="Carregando" />
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-lifeone-surface px-4 py-6 font-geist sm:px-6 sm:py-10">
      <div className="mx-auto w-full max-w-4xl">
        <header className="mb-6 flex items-center justify-between gap-4">
          <LifeOneLogo compact />
          <Link href="/projects" className="inline-flex min-h-11 items-center gap-2 rounded-[10px] px-3 text-[13px] font-semibold text-lifeone-blue hover:bg-white">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Projetos
          </Link>
        </header>

        <form onSubmit={handleSubmit} aria-busy={saving} className="overflow-hidden rounded-[22px] border border-lifeone-hairline bg-lifeone-card shadow-lifeone-card">
          <div className="border-b border-lifeone-hairline p-5 sm:p-8">
            <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-lifeone-blue">Configurações</p>
            <h1 className="mt-2 text-[27px] font-bold tracking-[-0.035em] text-lifeone-ink sm:text-[34px]">Seus objetivos</h1>
            <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-lifeone-ink-3">
              Ative o que faz sentido agora. Ao remover um objetivo, seus projetos e dados ficam preservados e voltam quando você o reativar.
            </p>
          </div>

          <div className="p-5 sm:p-8">
            {error && (
              <div ref={feedbackRef} role="alert" tabIndex={-1} className="mb-5 rounded-[10px] border border-[#FECDCA] bg-[#FEF3F2] px-3 py-2.5 text-[13px] text-[#B42318] outline-none focus:ring-2 focus:ring-[#B42318]/30">
                {error}
              </div>
            )}
            {saved && (
              <div role="status" className="mb-5 flex items-center gap-2 rounded-[10px] border border-lifeone-success/25 bg-lifeone-success-fill px-3 py-2.5 text-[13px] text-lifeone-success">
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                Objetivos atualizados.
              </div>
            )}
            <ObjectiveSelector selected={projectTypes} onChange={(next) => { setProjectTypes(next); setSaved(false); }} disabled={saving} legend="O que você quer acompanhar?" />
            <div className="mt-6 flex flex-col-reverse gap-3 border-t border-lifeone-hairline pt-5 sm:flex-row sm:justify-end">
              <Link href="/projects" className="inline-flex min-h-11 items-center justify-center rounded-[10px] px-4 text-[14px] font-medium text-lifeone-ink-2 hover:bg-lifeone-surface">Cancelar</Link>
              <button type="submit" disabled={saving} className="inline-flex min-h-11 items-center justify-center rounded-[10px] bg-lifeone-blue px-5 text-[14px] font-semibold text-white hover:brightness-95 disabled:cursor-wait disabled:opacity-60">
                {saving ? 'Salvando…' : 'Salvar objetivos'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </main>
  );
}
