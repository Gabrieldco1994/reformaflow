'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { ProjectProvider } from '@/contexts/project-context';
import { useAuth, type ModuleSlug } from '@/contexts/auth-context';
import { getProjectNavModules, hasFeature, ProjectType } from '@reformaflow/domain';
import { canSeeBudgetAllocationEntryPoint } from '@/lib/budget-allocation-access';
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
  // D4 — um único overlay ativo por vez. Dois booleans independentes deixavam
  // Mais e Lançar coexistirem (o deep-link `?launch=1` podia abrir por cima do
  // Mais). O enum torna a exclusão mútua estrutural, não uma convenção frágil.
  const [overlay, setOverlay] = useState<"mais" | "launch" | null>(null);
  /**
   * U2-E09 — abrir um overlay empilha UMA entrada de histórico para que o gesto
   * / botão "voltar" do navegador FECHE o overlay em vez de sair da rota (hoje
   * `back` com o Mais aberto navega para fora e o overlay some junto — o teste
   * mede `about:blank`). Fechar por QUALQUER via (backdrop, botão, toque no
   * dock) consome a mesma entrada, então o overlay nunca fica com mais de um
   * nível de histórico. Não é a a11y de diálogo do launch (Escape/focus-trap),
   * que continua na #522 — isto é ciclo de vida do overlay no shell.
   */
  const overlayPushedRef = useRef(false);
  const openOverlay = useCallback((kind: "mais" | "launch") => {
    if (typeof window !== "undefined" && !overlayPushedRef.current) {
      window.history.pushState({ rfOverlay: true }, "");
      overlayPushedRef.current = true;
    }
    setOverlay(kind);
  }, []);
  const closeOverlay = useCallback(() => {
    if (typeof window !== "undefined" && overlayPushedRef.current) {
      overlayPushedRef.current = false;
      window.history.back(); // dispara popstate -> setOverlay(null)
    } else {
      setOverlay(null);
    }
  }, []);
  useEffect(() => {
    function handlePopState() {
      overlayPushedRef.current = false;
      setOverlay(null);
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);
  // U2-P17 — Escape fecha o overlay de lançamento. É o MESMO ciclo de vida de
  // shell do "voltar" do E09 (reusa closeOverlay), não a a11y de diálogo do
  // launch (role/aria-modal/focus-trap), que segue na #522. Escopo em 'launch':
  // o Mais já trata o próprio Escape internamente (MaisSheet), então cobrir os
  // dois aqui duplicaria o fechamento.
  useEffect(() => {
    if (overlay !== "launch") return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") closeOverlay();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [overlay, closeOverlay]);
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
    overlayPushedRef.current = false;
    setOverlay(null);
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
    // O onboarding agora é uma jornada gatilhada por PROJECT_CREATED, não um
    // redirect para rota dedicada. Esta verificação é removida — o painel é
    // ativado pelo runtime da jornada, nunca neste shell.
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
    setOverlay('launch');
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
  const search = searchParams.toString();
  const resolvedProjectType = project.type as ProjectType;
  const { primary, secondary } = getMobilePrimary(project.type, visibleNav);
  const hasMoreSheet = secondary.length > 0 || isAdmin || Boolean(user?.name);
  /**
   * #504 — descoberta do histórico congelado de Alocação de Budget.
   *
   * Derivado do papel + tipo de projeto, NUNCA de `isAdmin` (que não checa
   * `isGuest`, então o convidado de demo do #497 passaria) e nunca de
   * `PROJECT_NAV` (que filtra por módulo e reporia o item para todo mundo).
   *
   * É de propósito que isto NÃO dependa de "existem alocações?": condicionar a
   * visibilidade do menu a uma resposta de rede recria exatamente esta classe
   * de bug — requisição lenta ou falha faz o ponto de entrada desaparecer em
   * silêncio. Determinístico a partir da sessão.
   */
  const canSeeBudgetHistory = canSeeBudgetAllocationEntryPoint(user, project.type);

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
          maisCount={secondary.length}
          onOpenMais={() => openOverlay('mais')}
        />

        <MaisSheet
          open={overlay === 'mais'}
          project={project}
          basePath={basePath}
          pathname={pathname}
          search={search}
          secondary={secondary}
          isAdmin={isAdmin}
          canSeeBudgetHistory={canSeeBudgetHistory}
          userName={user?.name}
          onClose={closeOverlay}
          onLogout={handleLogout}
        />

        <DesktopSidebar
          project={project}
          basePath={basePath}
          pathname={pathname}
          search={search}
          visibleNav={visibleNav}
          isAdmin={isAdmin}
          canSeeBudgetHistory={canSeeBudgetHistory}
          userName={user?.name}
          onLogout={handleLogout}
        />

        <main className="minimal-main flex-1 overflow-y-auto p-4 pb-24 md:p-6 md:pb-6">
          {children}
        </main>

        <MobileTabBar
          basePath={basePath}
          pathname={pathname}
          search={search}
          projectType={resolvedProjectType}
          primary={primary}
          canLaunch={canLaunch}
          onOpenLaunch={() => openOverlay('launch')}
        />

        {supportsMobileCockpit && canLaunch && (
          <div className="md:hidden">
            <MobileLaunchSheetContainer
              projectId={project.id}
              open={overlay === 'launch'}
              onClose={closeOverlay}
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
