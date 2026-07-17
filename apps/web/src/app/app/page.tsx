'use client';

import { hasFeature, type ProjectType } from '@reformaflow/domain';
import { Suspense, useEffect } from 'react';
import { useOptionalAuth } from '@/contexts/auth-context';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import {
  getProjectHomePath,
  isKnownProjectType,
} from '../projects/_lib/project-home-route';

interface Project {
  id: string;
  type: string;
}

type AppScreen = 'hoje' | 'despesas' | 'maria' | 'lancar';

function hasTypeFeature(
  projectType: string,
  feature: Parameters<typeof hasFeature>[1],
): boolean {
  if (!isKnownProjectType(projectType)) return false;
  return hasFeature(projectType as ProjectType, feature);
}

function supportsScreen(project: Project, screen: string | null): boolean {
  const normalized: AppScreen =
    screen === 'despesas' || screen === 'maria' || screen === 'lancar'
      ? screen
      : 'hoje';

  if (normalized === 'despesas') {
    return hasTypeFeature(project.type, 'expenses');
  }

  return hasTypeFeature(project.type, 'monthlyOverview');
}

function pickProjectForScreen(
  projects: Project[],
  screen: string | null,
  lastProjectId: string | null,
): Project {
  const fromLast = lastProjectId
    ? projects.find((project) => project.id === lastProjectId)
    : undefined;
  if (fromLast && supportsScreen(fromLast, screen)) return fromLast;

  const pessoal = projects.find((project) => project.type === 'PESSOAL');
  if (pessoal && supportsScreen(pessoal, screen)) return pessoal;

  const firstMatching = projects.find((project) =>
    supportsScreen(project, screen),
  );
  if (firstMatching) return firstMatching;

  return fromLast ?? projects[0];
}

function resolveTargetPath(project: Project, screen: string | null): string {
  const homePath = getProjectHomePath(project.id, project.type);

  switch (screen) {
    case 'despesas':
      return hasTypeFeature(project.type, 'expenses')
        ? `/projects/${project.id}/expenses`
        : homePath;
    case 'maria':
      return hasTypeFeature(project.type, 'monthlyOverview')
        ? `/projects/${project.id}/maria`
        : homePath;
    case 'lancar':
      return hasTypeFeature(project.type, 'monthlyOverview')
        ? `/projects/${project.id}/monthly?launch=1`
        : homePath;
    case 'hoje':
    default:
      return hasTypeFeature(project.type, 'monthlyOverview')
        ? `/projects/${project.id}/monthly`
        : homePath;
  }
}

function AppEntryContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const screen = searchParams.get('screen');
  const auth = useOptionalAuth();
  const authLoading = auth?.loading ?? false;

  useEffect(() => {
    let cancelled = false;

    if (authLoading) return;

    async function resolveAppEntry() {
      try {
        const projects = await api.get<Project[]>('/projects');
        if (cancelled) return;

        const visibleProjects = auth
          ? projects.filter(
              (project) =>
                auth.hasProjectType(project.type) && auth.hasProjectAccess(project.id),
            )
          : projects;

        if (!visibleProjects.length) {
          router.replace('/projects');
          return;
        }

        const lastProjectId = window.localStorage.getItem('rf_last_project_id');
        const chosen = pickProjectForScreen(visibleProjects, screen, lastProjectId);

        router.replace(resolveTargetPath(chosen, screen));
      } catch {
        if (!cancelled) router.replace('/projects');
      }
    }

    resolveAppEntry();
    return () => {
      cancelled = true;
    };
  }, [auth, authLoading, router, screen]);

  return (
    <div className="min-h-screen bg-white flex items-center justify-center">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-darc-red" />
    </div>
  );
}

export default function AppEntryPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-white flex items-center justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-darc-red" />
        </div>
      }
    >
      <AppEntryContent />
    </Suspense>
  );
}
