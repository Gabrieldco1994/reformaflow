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
  Landmark,
  Users,
  LogOut,
  MoreHorizontal,
  Gauge,
  Target,
  X,
  type LucideIcon,
} from 'lucide-react';
import { NotificationsBell } from '@/components/notifications/NotificationsBell';
import { FinancialAgentWidget } from '@/components/agent/FinancialAgentWidget';

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
  PESSOAL: [
    { href: 'monthly', label: 'Cockpit', icon: Gauge, module: 'monthlyOverview' },
    { href: 'conta', label: 'Visão Conta', icon: Landmark, module: 'monthlyOverview' },
    { href: 'expenses', label: 'Despesas', icon: Receipt, module: 'expenses' },
    { href: 'receipts', label: 'Recebimentos', icon: Wallet, module: 'receipts' },
    { href: 'metas', label: 'Metas', icon: Target, module: 'expenses' },
    { href: 'planning', label: 'Planning', icon: CalendarClock, module: 'monthlyOverview' },
    { href: 'budget-allocation', label: 'Alocação Budget', icon: Wallet, module: 'dashboard' },
    { href: 'cash-flow', label: 'Fluxo de Caixa', icon: ArrowLeftRight, module: 'cashFlow' },
    { href: 'credit-cards', label: 'Cartões', icon: CreditCard, module: 'creditCards' },
    { href: 'bank-accounts', label: 'Contas', icon: Landmark, module: 'bankAccounts' },
  ],
  CASA: [
    { href: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, module: 'dashboard' },
    { href: 'bills', label: 'Contas', icon: CreditCard, module: 'recurringBills' },
    { href: 'expenses', label: 'Despesas', icon: Receipt, module: 'expenses' },
    { href: 'maintenance', label: 'Manutenções', icon: Wrench, module: 'maintenance' },
    { href: 'reminders', label: 'Lembretes', icon: Bell, module: 'reminders' },
  ],
  CARRO: [
    { href: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, module: 'dashboard' },
    { href: 'car-info', label: 'Meu Carro', icon: Car, module: 'carInfo' },
    { href: 'bills', label: 'Contas', icon: CreditCard, module: 'recurringBills' },
    { href: 'expenses', label: 'Despesas', icon: Receipt, module: 'expenses' },
    { href: 'maintenance', label: 'Manutenções', icon: Wrench, module: 'maintenance' },
    { href: 'reminders', label: 'Lembretes', icon: Bell, module: 'reminders' },
  ],
};

const TYPE_ICONS: Record<string, string> = {
  REFORMA: '🏗️',
  COMPRA: '🏠',
  PESSOAL: '💰',
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
  const { user, isAdmin, hasModule, hasProjectType, hasProjectAccess, logout, loading: authLoading } = useAuth();

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
    if (!hasProjectAccess(project.id)) {
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
  }, [authLoading, loading, project, pathname, projectId, navItems, hasModule, hasProjectType, hasProjectAccess, router]);

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

  // Mobile: até 4 ícones principais na bottom-nav; o resto vai pro sheet "Mais".
  const MOBILE_PRIMARY_COUNT = 4;
  const mobilePrimary = visibleNav.slice(0, MOBILE_PRIMARY_COUNT);
  const mobileSecondary = visibleNav.slice(MOBILE_PRIMARY_COUNT);
  const hasMoreSheet = mobileSecondary.length > 0 || isAdmin;
  const isPersonal = project.type === 'PESSOAL';

  return (
    <ProjectProvider value={{ projectId: project.id, projectType: project.type, projectName: project.name }}>
      <div className="flex flex-col md:flex-row h-screen bg-white">
        {/* Mobile top bar — minimalista, fundo branco, editorial */}
        <header className="md:hidden flex items-center justify-between px-4 h-14 bg-white sticky top-0 z-30 border-b border-darc-linen">
          <Link
            href="/projects"
            aria-label="Voltar para projetos"
            className="-ml-2 p-2 rounded-full text-darc-velvet/70 hover:bg-darc-linen/60 active:bg-darc-linen transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-lg flex-shrink-0">{TYPE_ICONS[project.type] ?? '📋'}</span>
            <span className="font-editorial italic text-base text-darc-velvet truncate">{project.name}</span>
          </div>
          <div className="flex items-center -mr-2">
            <NotificationsBell variant="light" />
            {hasMoreSheet ? (
              <button
                type="button"
                onClick={() => setMobileOpen(true)}
                aria-label="Mais opções"
                className="p-2 rounded-full text-darc-velvet/70 hover:bg-darc-linen/60 active:bg-darc-linen transition-colors"
              >
                <MoreHorizontal className="w-5 h-5" />
              </button>
            ) : null}
          </div>
        </header>

        {/* Mobile "Mais" bottom-sheet */}
        {mobileOpen && (
          <div
            className="md:hidden fixed inset-0 bg-darc-velvet/60 backdrop-blur-sm z-40"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
        )}
        <div
          className={`md:hidden fixed bottom-0 left-0 right-0 z-50 bg-white rounded-t-3xl shadow-darc-hero transition-transform duration-200 ${
            mobileOpen ? 'translate-y-0' : 'translate-y-full'
          }`}
        >
          <div className="flex items-center justify-between px-5 pt-4 pb-2">
            <div>
              <p className="text-[10px] tracking-[0.2em] uppercase text-darc-velvet/60">Mais opções</p>
              <p className="font-editorial italic text-lg text-darc-velvet">{project.name}</p>
            </div>
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              aria-label="Fechar"
              className="p-2 rounded-full text-darc-velvet/70 hover:bg-darc-linen/60"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          <nav className="px-3 pt-2 pb-3 space-y-1 max-h-[50vh] overflow-y-auto">
            {mobileSecondary.map((item) => {
              const fullHref = `${basePath}/${item.href}`;
              const isActive = pathname.startsWith(fullHref);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={fullHref}
                  className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-darc-linen text-darc-velvet'
                      : 'text-darc-velvet/85 hover:bg-darc-linen/40'
                  }`}
                >
                  <Icon className={`w-5 h-5 flex-shrink-0 ${isActive ? 'text-darc-red' : 'text-darc-velvet/60'}`} />
                  {item.label}
                </Link>
              );
            })}
            {isAdmin && (
              <Link
                href="/admin/users"
                className={`flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-colors ${
                  pathname.startsWith('/admin/users')
                    ? 'bg-darc-linen text-darc-velvet'
                    : 'text-darc-velvet/85 hover:bg-darc-linen/40'
                }`}
              >
                <Users className={`w-5 h-5 flex-shrink-0 ${pathname.startsWith('/admin/users') ? 'text-darc-red' : 'text-darc-velvet/60'}`} />
                Usuários
              </Link>
            )}
          </nav>
          <div className="px-3 pb-5 pt-2 border-t border-darc-linen safe-pb">
            {user && (
              <button
                onClick={handleLogout}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-darc-velvet text-darc-pink-logo text-sm font-medium hover:bg-darc-red-bright hover:text-darc-linen transition-colors"
              >
                <LogOut className="w-4 h-4" />
                Sair ({user.name})
              </button>
            )}
          </div>
        </div>

        {/* Sidebar: desktop hover-expand (mobile usa bottom-nav, não drawer aqui) */}
        <aside
          className="group/sidebar hidden md:flex bg-darc-red-bright flex-col overflow-hidden transition-all duration-200 w-16 hover:w-56"
        >
          {/* Desktop header */}
          <div className="p-3 border-b border-white/20 min-h-[56px]">
            <div className="flex items-center justify-between">
              <Link
                href="/projects"
                className="flex items-center gap-2 text-darc-linen/80 hover:text-darc-linen transition-colors"
              >
                <ArrowLeft className="w-5 h-5 flex-shrink-0" />
                <span className="text-[10px] tracking-[0.2em] uppercase whitespace-nowrap opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200">
                  Projetos
                </span>
              </Link>
              <div className="opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200">
                <NotificationsBell variant="dark" />
              </div>
            </div>
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
                  <span className="whitespace-nowrap opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200">
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
                <span className="whitespace-nowrap opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200">
                  Usuários
                </span>
              </Link>
            )}
          </nav>

          <div className="p-2 border-t border-white/20 space-y-1">
            {user && (
              <button
                onClick={handleLogout}
                title="Sair"
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-darc-linen hover:bg-white/15 transition-colors"
              >
                <LogOut className="w-5 h-5 flex-shrink-0 text-darc-linen/85" />
                <span className="whitespace-nowrap opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200 truncate">
                  Sair ({user.name})
                </span>
              </button>
            )}
            <div className="text-[10px] tracking-[0.2em] uppercase text-darc-linen/60 whitespace-nowrap opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200 px-3 pt-1">
              v0.2.0
            </div>
          </div>
        </aside>

        {/* Main content */}
        <main className="font-platform-content flex-1 overflow-y-auto p-4 md:p-6 bg-white pb-24 md:pb-6">
          {children}
        </main>

        {/* Mobile bottom navigation — pílula escura flutuante (PESSOAL) ou barra branca (demais) */}
        {isPersonal ? (
        <nav className="md:hidden fixed bottom-3 inset-x-4 z-30 safe-pb">
          <div className="flex items-stretch justify-around gap-1 rounded-full bg-darc-velvet/95 backdrop-blur-md px-2 py-1.5 shadow-darc-hero">
            {mobilePrimary.map((item) => {
              const fullHref = `${basePath}/${item.href}`;
              const isActive = pathname.startsWith(fullHref);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={fullHref}
                  className={`relative flex flex-1 items-center justify-center gap-1.5 rounded-full px-1 py-2 transition-all active:scale-95 ${
                    isActive ? 'bg-orange-500 text-white shadow-sm' : 'text-darc-linen/80'
                  }`}
                >
                  <Icon className={`w-5 h-5 shrink-0 ${isActive ? 'text-white' : 'text-darc-linen/70'}`} />
                  <span className={`text-[11px] font-semibold tracking-tight ${isActive ? 'inline' : 'hidden'}`}>
                    {item.label}
                  </span>
                </Link>
              );
            })}
            {hasMoreSheet && (
              <button
                type="button"
                onClick={() => setMobileOpen(true)}
                aria-label="Mais opções"
                className="relative flex items-center justify-center rounded-full px-3 py-2 text-darc-linen/80 transition-all active:scale-95"
              >
                <MoreHorizontal className="w-5 h-5" />
              </button>
            )}
          </div>
        </nav>
        ) : (
        <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-white/95 backdrop-blur-md border-t border-darc-linen safe-pb">
          <div className="flex items-stretch justify-around px-1 pt-1.5 pb-1">
            {mobilePrimary.map((item) => {
              const fullHref = `${basePath}/${item.href}`;
              const isActive = pathname.startsWith(fullHref);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={fullHref}
                  className="relative flex flex-col items-center justify-center gap-0.5 flex-1 py-1 rounded-lg active:scale-95 transition-transform"
                >
                  <span
                    className={`relative flex items-center justify-center h-7 w-12 rounded-full transition-colors ${
                      isActive ? 'bg-darc-linen' : ''
                    }`}
                  >
                    <Icon className={`w-5 h-5 ${isActive ? 'text-darc-red' : 'text-darc-velvet/70'}`} />
                  </span>
                  <span
                    className={`text-[10px] leading-tight font-medium tracking-tight ${
                      isActive ? 'text-darc-red' : 'text-darc-velvet/70'
                    }`}
                  >
                    {item.label}
                  </span>
                </Link>
              );
            })}
            {hasMoreSheet && (
              <button
                type="button"
                onClick={() => setMobileOpen(true)}
                className="relative flex flex-col items-center justify-center gap-0.5 flex-1 py-1 rounded-lg active:scale-95 transition-transform"
              >
                <span className="relative flex items-center justify-center h-7 w-12 rounded-full">
                  <MoreHorizontal className="w-5 h-5 text-darc-velvet/70" />
                </span>
                <span className="text-[10px] leading-tight font-medium tracking-tight text-darc-velvet/70">
                  Mais
                </span>
              </button>
            )}
          </div>
        </nav>
        )}
      </div>

      {/* Copiloto Financeiro (chat flutuante) */}
      <FinancialAgentWidget />
    </ProjectProvider>
  );
}
