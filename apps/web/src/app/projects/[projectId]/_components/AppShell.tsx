'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { ProjectProvider } from '@/contexts/project-context';
import { useAuth, type ModuleSlug } from '@/contexts/auth-context';
import { getProjectNavModules, hasFeature, ProjectType } from '@reformaflow/domain';
import { FinancialAgentWidget } from '@/components/agent/FinancialAgentWidget';
import { DesktopSidebar } from './DesktopSidebar';
import { MobileHeader } from './MobileHeader';
import { MobileTabBar } from './MobileTabBar';
import { MaisSheet } from './MaisSheet';
import { getMobilePrimary } from './mobile-nav';
import { MobileLaunchSheetContainer } from './mobile-launch/MobileLaunchSheetContainer';
import { projectAccentStyle } from '../../_components/type-accent';
import type { NavModule, ProjectInfo } from '../_types';

interface ProjectLoadState {
  projectId: string;
  project: ProjectInfo | null;
  loading: boolean;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const projectId = params.projectId as string;
  const [projectLoad, setProjectLoad] = useState<ProjectLoadState>(() => ({
    projectId,
    project: null,
    loading: true,
  }));
  const currentProjectLoad =
    projectLoad.projectId === projectId ? projectLoad : null;
  const project = currentProjectLoad?.project ?? null;
  const loading = currentProjectLoad?.loading ?? true;
  const [mobileOpen, setMobileOpen] = useState(false);
  const [launchOpen, setLaunchOpen] = useState(false);
  const { user, isAdmin, hasModule, hasProjectType, hasProjectAccess, logout, loading: authLoading } = useAuth();

  useEffect(() => {
    let active = true;

    setProjectLoad({ projectId, project: null, loading: true });
    api.get<ProjectInfo>(`/projects/${projectId}`)
      .then((nextProject) => {
        if (!active) return;
        setProjectLoad({ projectId, project: nextProject, loading: true });
      })
      .catch(() => {
        if (!active) return;
        router.push("/projects");
      })
      .finally(() => {
        if (!active) return;
        setProjectLoad((current) =>
          current.projectId === projectId
            ? { ...current, loading: false }
            : current,
        );
      });

    return () => {
      active = false;
    };
  }, [projectId, router]);

  useEffect(() => {
    setMobileOpen(false);
    setLaunchOpen(false);
  }, [pathname, projectId]);

  const canAccessProject = Boolean(
    project && hasProjectType(project.type) && hasProjectAccess(project.id),
  );

  useEffect(() => {
    if (authLoading || !project || !canAccessProject) return;
    window.localStorage.setItem('rf_last_project_id', project.id);
  }, [authLoading, canAccessProject, project]);

  const navItems = useMemo<NavModule[]>(
    () => (project ? getProjectNavModules(project.type as ProjectType) : []),
    [project],
  );

  const visibleNav = useMemo(
    () => navItems.filter((item) => hasModule(item.module as ModuleSlug)),
    [navItems, hasModule],
  );

  useEffect(() => {
    if (authLoading || loading || !project) return;
    if (!hasProjectType(project.type)) {
      router.replace('/no-permission');
      return;
    }
    if (!hasProjectAccess(project.id)) {
      router.replace('/no-permission');
      return;
    }
    const basePath = `/projects/${projectId}`;
    if (pathname === basePath) return;
    const slug = pathname.replace(basePath + '/', '').split('/')[0];
    const current = navItems.find((n) => n.slug === slug);
    if (current && !hasModule(current.module as ModuleSlug)) {
      router.replace('/no-permission');
    }
  }, [authLoading, loading, project, pathname, projectId, navItems, hasModule, hasProjectType, hasProjectAccess, router]);

  async function handleLogout() {
    await logout();
    router.replace('/login');
  }

  const projectType = project?.type as ProjectType | undefined;
  const supportsMobileCockpit = projectType
    ? hasFeature(projectType, 'monthlyOverview')
    : false;
  const canLaunch =
    supportsMobileCockpit && visibleNav.some((item) => item.module === 'expenses');

  useEffect(() => {
    if (!canLaunch) return;
    if (searchParams.get('launch') !== '1') return;
    setLaunchOpen(true);
  }, [canLaunch, searchParams]);

  if (authLoading || loading || !project || !canAccessProject) {
    return (
      <div
        data-ui-skin="minimal"
        data-ui-loading="minimal-neutral"
        role="status"
        aria-label="Carregando projeto"
        className="minimal-loading flex min-h-[100dvh] items-center justify-center bg-[#eef0f3]"
      >
        <div
          className="minimal-loading-indicator h-8 w-8 animate-spin rounded-full border-2"
          aria-hidden
        />
      </div>
    );
  }

  const basePath = `/projects/${projectId}`;
  const resolvedProjectType = project.type as ProjectType;
  const { primary, secondary } = getMobilePrimary(project.type, visibleNav);
  const hasMoreSheet = secondary.length > 0 || isAdmin || Boolean(user?.name);

  return (
    <ProjectProvider value={{ projectId: project.id, projectType: project.type, projectName: project.name }}>
      <div
        data-ui-skin="minimal"
        data-project-type={resolvedProjectType}
        style={projectAccentStyle(resolvedProjectType)}
        className="minimal-shell flex h-[100dvh] flex-col md:h-screen md:flex-row"
      >
        <MobileHeader
          project={project}
          hasMoreSheet={hasMoreSheet}
          onOpenMais={() => setMobileOpen(true)}
        />

        <MaisSheet
          open={mobileOpen}
          project={project}
          basePath={basePath}
          pathname={pathname}
          secondary={secondary}
          isAdmin={isAdmin}
          userName={user?.name}
          onClose={() => setMobileOpen(false)}
          onLogout={handleLogout}
        />

        <DesktopSidebar
          project={project}
          basePath={basePath}
          pathname={pathname}
          visibleNav={visibleNav}
          isAdmin={isAdmin}
          userName={user?.name}
          onLogout={handleLogout}
        />

        <main className="minimal-main flex-1 overflow-y-auto p-4 pb-24 md:p-6 md:pb-6">
          {children}
        </main>

        <MobileTabBar
          basePath={basePath}
          pathname={pathname}
          projectType={resolvedProjectType}
          primary={primary}
          canLaunch={canLaunch}
          onOpenLaunch={() => setLaunchOpen(true)}
        />

        {supportsMobileCockpit && canLaunch && (
          <div className="md:hidden">
            <MobileLaunchSheetContainer
              projectId={project.id}
              open={launchOpen}
              onClose={() => setLaunchOpen(false)}
            />
          </div>
        )}
      </div>

      {/* Copiloto Financeiro (desktop). No mobile a rota /maria assume esse papel. */}
      <div className="hidden lg:block">
        <FinancialAgentWidget />
      </div>
    </ProjectProvider>
  );
}
