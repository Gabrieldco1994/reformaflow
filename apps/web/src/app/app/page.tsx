'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';

interface Project {
  id: string;
  type: string;
}

function resolveTargetPath(projectId: string, screen: string | null): string {
  switch (screen) {
    case 'despesas':
      return `/projects/${projectId}/expenses`;
    case 'maria':
      return `/projects/${projectId}/maria`;
    case 'lancar':
      return `/projects/${projectId}/monthly?launch=1`;
    case 'hoje':
    default:
      return `/projects/${projectId}/monthly`;
  }
}

export default function AppEntryPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const screen = searchParams.get('screen');

  useEffect(() => {
    let cancelled = false;

    async function resolveAppEntry() {
      try {
        const projects = await api.get<Project[]>('/projects');
        if (cancelled) return;

        if (!projects.length) {
          router.replace('/projects');
          return;
        }

        const lastProjectId = window.localStorage.getItem('rf_last_project_id');
        const fromLast = projects.find((project) => project.id === lastProjectId);
        const pessoal = projects.find((project) => project.type === 'PESSOAL');
        const chosen = fromLast ?? pessoal ?? projects[0];

        router.replace(resolveTargetPath(chosen.id, screen));
      } catch {
        if (!cancelled) router.replace('/projects');
      }
    }

    resolveAppEntry();
    return () => {
      cancelled = true;
    };
  }, [router, screen]);

  return (
    <div className="min-h-screen bg-white flex items-center justify-center">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-darc-red" />
    </div>
  );
}
