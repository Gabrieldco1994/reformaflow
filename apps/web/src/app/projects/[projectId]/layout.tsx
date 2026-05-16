'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { api } from '@/lib/api';
import { ProjectProvider } from '@/contexts/project-context';
import { useAuth, type ModuleSlug } from '@/contexts/auth-context';
import {
  LayoutDashboard,
  Receipt,
  Wallet,
  ArrowLeftRight,
  Map,
  FlaskConical,
  CreditCard,
  Wrench,
  Bell,
  ArrowLeft,
  Car,
  CalendarClock,
  Users,
  LogOut,
  Menu,
  X,
  type LucideIcon,
} from 'lucide-react';

interface Project {
  id: string;
  name: string;
  type: string;
  description?: string;
}

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  module: ModuleSlug;
}

const FEATURE_NAV: Record<string, NavItem[]> = {
  REFORMA: [
    { href: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, module: 'dashboard' },
    { href: 'expenses', label: 'Despesas', icon: Receipt, module: 'expenses' },
    { href: 'receipts', label: 'Recebimentos', icon: Wallet, module: 'receipts' },
    { href: 'cash-flow', label: 'Fluxo de Caixa', icon: ArrowLeftRight, module: 'cashFlow' },
    { href: 'schedule', label: 'Cronograma', icon: CalendarClock, module: 'schedule' },
    { href: 'floor-plans', label: 'Plantas', icon: Map, module: 'floorPlans' },
    { href: 'simulation', label: 'Simulação', icon: FlaskConical, module: 'simulation' },
  ],
  COMPRA: [
    { href: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, module: 'dashboard' },
    { href: 'expenses', label: 'Despesas', icon: Receipt, module: 'expenses' },
    { href: 'receipts', label: 'Recebimentos', icon: Wallet, module: 'receipts' },
    { href: 'cash-flow', label: 'Fluxo de Caixa', icon: ArrowLeftRight, module: 'cashFlow' },
  ],
  CASA: [
    { href: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, module: 'dashboard' },
    { href: 'bills', label: 'Contas', icon: CreditCard, module: 'recurringBills' },
    { href: 'maintenance', label: 'Manutenções', icon: Wrench, module: 'maintenance' },
    { href: 'reminders', label: 'Lembretes', icon: Bell, module: 'reminders' },
  ],
  CARRO: [
    { href: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, module: 'dashboard' },
    { href: 'car-info', label: 'Meu Carro', icon: Car, module: 'carInfo' },
    { href: 'bills', label: 'Contas', icon: CreditCard, module: 'recurringBills' },
    { href: 'maintenance', label: 'Manutenções', icon: Wrench, module: 'maintenance' },
    { href: 'reminders', label: 'Lembretes', icon: Bell, module: 'reminders' },
  ],
};

const TYPE_ICONS: Record<string, string> = {
  REFORMA: '🏗️',
  COMPRA: '🏠',
  CASA: '🏡',
  CARRO: '🚗',
};

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const pathname = usePathname();
  const router = useRouter();
  const projectId = params.projectId as string;
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { user, isAdmin, hasModule, hasProjectType, logout, loading: authLoading } = useAuth();

  useEffect(() => {
    api.get<Project>(`/projects/${projectId}`)
      .then(setProject)
      .catch(() => router.push('/projects'))
      .finally(() => setLoading(false));
  }, [projectId, router]);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  const navItems = useMemo(
    () => (project ? FEATURE_NAV[project.type] ?? FEATURE_NAV.REFORMA : []),
    [project],
  );

  const visibleNav = useMemo(
    () => navItems.filter((item) => hasModule(item.module)),
    [navItems, hasModule],
  );

  useEffect(() => {
    if (authLoading || loading || !project) return;
    if (!hasProjectType(project.type)) {
      router.replace('/no-permission');
      return;
    }
    const basePath = `/projects/${projectId}`;
    if (pathname === basePath) return;
    const slug = pathname.replace(basePath + '/', '').split('/')[0];
    const current = navItems.find((n) => n.href === slug);
    if (current && !hasModule(current.module)) {
      router.replace('/no-permission');
    }
  }, [authLoading, loading, project, pathname, projectId, navItems, hasModule, hasProjectType, router]);

  async function handleLogout() {
    await logout();
    router.replace('/login');
  }

  if (loading || !project) {
    return (
      <div className="flex h-screen items-center justify-center bg-white">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-darc-red"></div>
      </div>
    );
  }

  const basePath = `/projects/${projectId}`;

  return (
    <ProjectProvider value={{ projectId: project.id, projectType: project.type, projectName: project.name }}>
      <div className="flex flex-col md:flex-row h-screen bg-white">
        {/* Mobile top bar */}
        <header className="md:hidden flex items-center justify-between px-4 h-14 border-b border-darc-red-bright/30 bg-darc-red-bright sticky top-0 z-30">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Abrir menu"
            className="p-2 -ml-2 rounded-lg text-darc-linen hover:bg-white/15"
          >
            <Menu className="w-6 h-6" />
          </button>
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xl flex-shrink-0">{TYPE_ICONS[project.type] ?? '📋'}</span>
            <span className="text-sm font-semibold text-darc-linen truncate">{project.name}</span>
          </div>
          <Link
            href="/projects"
            aria-label="Voltar para projetos"
            className="p-2 -mr-2 rounded-lg text-darc-linen/80 hover:bg-white/15"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
        </header>

        {/* Mobile drawer backdrop */}
        {mobileOpen && (
          <div
            className="md:hidden fixed inset-0 bg-darc-velvet/70 backdrop-blur-sm z-40"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
        )}

        {/* Sidebar: drawer on mobile, hover-expand on desktop */}
        <aside
          className={`group/sidebar fixed md:static inset-y-0 left-0 z-50 md:z-auto bg-darc-red-bright flex flex-col overflow-hidden transition-all duration-200
            w-64 md:w-16 md:hover:w-56
            ${mobileOpen ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0`}
        >
          {/* Mobile close button */}
          <div className="md:hidden flex items-center justify-between px-3 h-14 border-b border-white/20">
            <span className="text-sm font-semibold text-darc-linen truncate">
              {TYPE_ICONS[project.type] ?? '📋'} {project.name}
            </span>
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              aria-label="Fechar menu"
              className="p-2 -mr-2 rounded-lg text-darc-linen hover:bg-white/15"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Desktop header */}
          <div className="hidden md:block p-3 border-b border-white/20 min-h-[56px]">
            <Link
              href="/projects"
              className="flex items-center gap-2 text-darc-linen/80 hover:text-darc-linen transition-colors"
            >
              <ArrowLeft className="w-5 h-5 flex-shrink-0" />
              <span className="text-[10px] tracking-[0.2em] uppercase whitespace-nowrap opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200">
                Projetos
              </span>
            </Link>
            <div className="flex items-center gap-2 mt-2">
              <span className="text-xl flex-shrink-0">{TYPE_ICONS[project.type] ?? '📋'}</span>
              <span className="font-editorial italic text-base text-darc-linen whitespace-nowrap opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200 truncate">
                {project.name}
              </span>
            </div>
          </div>

          {/* Nav items */}
          <nav className="flex-1 p-2 space-y-1 overflow-y-auto">
            {visibleNav.map((item) => {
              const fullHref = `${basePath}/${item.href}`;
              const isActive = pathname.startsWith(fullHref);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={fullHref}
                  title={item.label}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-darc-linen text-darc-velvet shadow-darc-soft'
                      : 'text-darc-linen hover:bg-white/15'
                  }`}
                >
                  <Icon className={`w-5 h-5 flex-shrink-0 ${isActive ? 'text-darc-red' : 'text-darc-linen/85'}`} />
                  <span className="whitespace-nowrap md:opacity-0 md:group-hover/sidebar:opacity-100 transition-opacity duration-200">
                    {item.label}
                  </span>
                </Link>
              );
            })}

            {isAdmin && (
              <Link
                href="/admin/users"
                title="Usuários"
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  pathname.startsWith('/admin/users')
                    ? 'bg-darc-linen text-darc-velvet shadow-darc-soft'
                    : 'text-darc-linen hover:bg-white/15'
                }`}
              >
                <Users className={`w-5 h-5 flex-shrink-0 ${pathname.startsWith('/admin/users') ? 'text-darc-red' : 'text-darc-linen/85'}`} />
                <span className="whitespace-nowrap md:opacity-0 md:group-hover/sidebar:opacity-100 transition-opacity duration-200">
                  Usuários
                </span>
              </Link>
            )}
          </nav>

          <div className="p-2 border-t border-white/20 space-y-1 safe-pb">
            {user && (
              <button
                onClick={handleLogout}
                title="Sair"
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-darc-linen hover:bg-white/15 transition-colors"
              >
                <LogOut className="w-5 h-5 flex-shrink-0 text-darc-linen/85" />
                <span className="whitespace-nowrap md:opacity-0 md:group-hover/sidebar:opacity-100 transition-opacity duration-200 truncate">
                  Sair ({user.name})
                </span>
              </button>
            )}
            <div className="text-[10px] tracking-[0.2em] uppercase text-darc-linen/60 whitespace-nowrap md:opacity-0 md:group-hover/sidebar:opacity-100 transition-opacity duration-200 px-3 pt-1">
              v0.2.0
            </div>
          </div>
        </aside>

        {/* Main content */}
        <main className="flex-1 overflow-y-auto p-4 md:p-6 bg-white">
          {children}
        </main>
      </div>
    </ProjectProvider>
  );
}
