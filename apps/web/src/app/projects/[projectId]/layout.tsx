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
      <div className="flex h-screen items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600"></div>
      </div>
    );
  }

  const basePath = `/projects/${projectId}`;

  return (
    <ProjectProvider value={{ projectId: project.id, projectType: project.type, projectName: project.name }}>
      <div className="flex flex-col md:flex-row h-screen">
        {/* Mobile top bar */}
        <header className="md:hidden flex items-center justify-between px-4 h-14 border-b border-gray-200 bg-white sticky top-0 z-30">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Abrir menu"
            className="p-2 -ml-2 rounded-lg text-gray-600 hover:bg-gray-100"
          >
            <Menu className="w-6 h-6" />
          </button>
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xl flex-shrink-0">{TYPE_ICONS[project.type] ?? '📋'}</span>
            <span className="text-sm font-semibold text-brand-700 truncate">{project.name}</span>
          </div>
          <Link
            href="/projects"
            aria-label="Voltar para projetos"
            className="p-2 -mr-2 rounded-lg text-gray-500 hover:bg-gray-100"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
        </header>

        {/* Mobile drawer backdrop */}
        {mobileOpen && (
          <div
            className="md:hidden fixed inset-0 bg-black/50 z-40"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
        )}

        {/* Sidebar: drawer on mobile, hover-expand on desktop */}
        <aside
          className={`group/sidebar fixed md:static inset-y-0 left-0 z-50 md:z-auto bg-white border-r border-gray-200 flex flex-col overflow-hidden transition-all duration-200
            w-64 md:w-16 md:hover:w-52
            ${mobileOpen ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0`}
        >
          {/* Mobile close button */}
          <div className="md:hidden flex items-center justify-between px-3 h-14 border-b border-gray-200">
            <span className="text-sm font-semibold text-brand-700 truncate">
              {TYPE_ICONS[project.type] ?? '📋'} {project.name}
            </span>
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              aria-label="Fechar menu"
              className="p-2 -mr-2 rounded-lg text-gray-500 hover:bg-gray-100"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Desktop header */}
          <div className="hidden md:block p-3 border-b border-gray-200 min-h-[56px]">
            <Link
              href="/projects"
              className="flex items-center gap-2 text-gray-500 hover:text-gray-800 transition-colors"
            >
              <ArrowLeft className="w-5 h-5 flex-shrink-0" />
              <span className="text-xs whitespace-nowrap opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200">
                Projetos
              </span>
            </Link>
            <div className="flex items-center gap-2 mt-2">
              <span className="text-xl flex-shrink-0">{TYPE_ICONS[project.type] ?? '📋'}</span>
              <span className="text-sm font-bold text-brand-700 whitespace-nowrap opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200 truncate">
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
                      ? 'bg-brand-50 text-brand-700'
                      : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                  }`}
                >
                  <Icon className="w-5 h-5 flex-shrink-0" />
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
                    ? 'bg-brand-50 text-brand-700'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                }`}
              >
                <Users className="w-5 h-5 flex-shrink-0" />
                <span className="whitespace-nowrap md:opacity-0 md:group-hover/sidebar:opacity-100 transition-opacity duration-200">
                  Usuários
                </span>
              </Link>
            )}
          </nav>

          <div className="p-2 border-t border-gray-200 space-y-1 safe-pb">
            {user && (
              <button
                onClick={handleLogout}
                title="Sair"
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-colors"
              >
                <LogOut className="w-5 h-5 flex-shrink-0" />
                <span className="whitespace-nowrap md:opacity-0 md:group-hover/sidebar:opacity-100 transition-opacity duration-200 truncate">
                  Sair ({user.name})
                </span>
              </button>
            )}
            <div className="text-xs text-gray-400 whitespace-nowrap md:opacity-0 md:group-hover/sidebar:opacity-100 transition-opacity duration-200 px-3">
              v0.2.0
            </div>
          </div>
        </aside>

        {/* Main content */}
        <main className="flex-1 overflow-y-auto p-4 md:p-6">
          {children}
        </main>
      </div>
    </ProjectProvider>
  );
}
