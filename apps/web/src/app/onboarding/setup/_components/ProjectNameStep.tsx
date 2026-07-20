'use client';

import { useCallback, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/contexts/auth-context';
import type { ProjectType } from '@reformaflow/domain';
import { PROJECT_ONBOARDING_COPY } from '../_lib/project-copy';

interface ProjectNameStepProps {
  projectType: ProjectType;
  onCreated: (projectId: string) => void;
}

/**
 * Auto-creates the project for `projectType` (name editable). Generalized from
 * today's PESSOAL-only step 0 — same `createdRef` double-submit guard (a ref,
 * not state, because a fast double-click can land both handlers before the
 * first `setCreating(true)` render commits).
 */
export function ProjectNameStep({ projectType, onCreated }: ProjectNameStepProps) {
  const { refresh } = useAuth();
  const copy = PROJECT_ONBOARDING_COPY[projectType];
  const [projectName, setProjectName] = useState(copy.defaultName);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createdRef = useRef(false);

  const createProject = useCallback(async () => {
    if (createdRef.current) return;
    createdRef.current = true;
    setCreating(true);
    setError(null);
    try {
      const project = await api.post<{ id: string }>('/projects', {
        name: projectName.trim() || copy.defaultName,
        type: projectType,
      });
      // Recarrega o usuário: se restrito, o backend acabou de conceder acesso
      // ao novo projeto — sem isso o AppShell redirecionaria para /no-permission
      // ao chegar no destino final (mesma race já resolvida em projects/page.tsx).
      await refresh();
      onCreated(project.id);
    } catch (e) {
      createdRef.current = false;
      setError(e instanceof Error ? e.message : 'Erro ao criar projeto');
    } finally {
      setCreating(false);
    }
  }, [projectName, projectType, copy.defaultName, onCreated, refresh]);

  return (
    <section className="rounded-[18px] border border-lifeone-hairline bg-lifeone-card p-6 shadow-lifeone-card">
      <h2 className="text-[20px] font-bold text-lifeone-ink">{copy.heroTitle}</h2>
      <p className="mt-2 text-[14px] text-lifeone-ink-3">{copy.heroDescription}</p>
      <div className="mt-5">
        <label htmlFor="projectName" className="mb-1.5 block text-[12px] font-medium text-lifeone-ink-2">
          Nome do projeto
        </label>
        <input
          id="projectName"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          placeholder={copy.defaultName}
          className="min-h-11 w-full rounded-[10px] border border-lifeone-hairline bg-lifeone-surface px-3.5 py-2.5 text-[14px] text-lifeone-ink placeholder:text-lifeone-ink-4 focus:border-lifeone-blue focus:outline-none focus:ring-2 focus:ring-lifeone-blue/25"
        />
      </div>
      {error && <p className="mt-3 text-[13px] text-[#B42318]">{error}</p>}
      <button
        onClick={createProject}
        disabled={creating}
        className="mt-6 flex min-h-11 w-full items-center justify-center gap-2 rounded-[10px] bg-lifeone-blue px-4 py-3 text-[14px] font-semibold text-white shadow-lifeone-card transition-transform hover:brightness-95 active:scale-[0.99] disabled:cursor-wait disabled:opacity-60"
      >
        {creating ? 'Criando…' : 'Criar e continuar'}
        {!creating && <ArrowRight className="h-4 w-4" />}
      </button>
    </section>
  );
}
