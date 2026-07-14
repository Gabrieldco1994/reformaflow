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
import type { NavModule, ProjectInfo } from '../_types';

export function AppShell({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const projectId = params.projectId as string;
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [launchOpen, setLaunchOpen] = useState(false);
  const { user, isAdmin, hasModule, hasProjectType, hasProjectAccess, logout, loading: authLoading } = useAuth();

  useEffect(() => {
    api.get<ProjectInfo>(`/projects/${projectId}`)
      .then(setProject)
      .catch(() => router.push('/projects'))
      .finally(() => setLoading(false));
  }, [projectId, router]);

  useEffect(() => {
    setMobileOpen(false);
    setLaunchOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!project) return;
    window.localStorage.setItem('rf_last_project_id', project.id);
  }, [project]);

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

  if (loading || !project) {
    return (
      <div className="flex h-screen items-center justify-center bg-white">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-darc-red"></div>
      </div>
    );
  }

  const basePath = `/projects/${projectId}`;
  const resolvedProjectType = project.type as ProjectType;
  const { primary, secondary } = getMobilePrimary(project.type, visibleNav);
  const hasMoreSheet = secondary.length > 0 || isAdmin || Boolean(user?.name);

  return (
    <ProjectProvider value={{ projectId: project.id, projectType: project.type, projectName: project.name }}>
      <div className="flex flex-col md:flex-row h-screen bg-white">
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

        <main className="font-platform-content flex-1 overflow-y-auto p-4 md:p-6 bg-white pb-24 md:pb-6">
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
