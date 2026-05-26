'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  LayoutDashboard,
  Receipt,
  Wallet,
  ArrowLeftRight,
  FlaskConical,
  Map,
  Users,
  LogOut,
  PieChart,
} from 'lucide-react';
import { useAuth, type ModuleSlug } from '@/contexts/auth-context';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useMemo } from 'react';

const navItems: { href: string; label: string; icon: typeof LayoutDashboard; module: ModuleSlug }[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, module: 'dashboard' },
  { href: '/expenses', label: 'Despesas', icon: Receipt, module: 'expenses' },
  { href: '/receipts', label: 'Recebimentos', icon: Wallet, module: 'receipts' },
  { href: '/cash-flow', label: 'Fluxo de Caixa', icon: ArrowLeftRight, module: 'cashFlow' },
  { href: '/floor-plans', label: 'Plantas', icon: Map, module: 'floorPlans' },
  { href: '/simulation', label: 'Simulação', icon: FlaskConical, module: 'simulation' },
];

const PROJECT_BG_COLORS: Record<string, string> = {
  REFORMA: 'bg-orange-600',
  COMPRA: 'bg-pink-600',
  CASA: 'bg-teal-600',
  CARRO: 'bg-blue-600',
  PESSOAL: 'bg-purple-600',
};

const PROJECT_ICON_COLORS: Record<string, string> = {
  REFORMA: 'text-orange-700',
  COMPRA: 'text-pink-700',
  CASA: 'text-teal-700',
  CARRO: 'text-blue-700',
  PESSOAL: 'text-purple-700',
};

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, isAdmin, hasModule, logout } = useAuth();

  // Detecta se está em uma rota de projeto
  const projectId = useMemo(() => {
    const match = pathname.match(/^\/projects\/([^/]+)/);
    return match ? match[1] : null;
  }, [pathname]);

  // Busca dados do projeto se estiver em uma rota de projeto
  const { data: project } = useQuery<{ id: string; name: string; type: string }>({
    queryKey: ['project', projectId],
    queryFn: () => api.get(`/projects/${projectId}`),
    enabled: !!projectId,
    staleTime: 5 * 60 * 1000,
  });

  const sidebarBgColor = project?.type ? PROJECT_BG_COLORS[project.type] || 'bg-darc-red-bright' : 'bg-darc-red-bright';
  const activeIconColor = project?.type ? PROJECT_ICON_COLORS[project.type] || 'text-darc-red' : 'text-darc-red';

  const visibleItems = navItems.filter((item) => hasModule(item.module));

  async function handleLogout() {
    await logout();
    router.replace('/login');
  }

  return (
    <aside className={`group/sidebar w-16 hover:w-56 transition-all duration-200 ${sidebarBgColor} flex flex-col overflow-hidden`}>
      <div className="p-3 border-b border-white/20 flex items-center gap-3 min-h-[56px]">
        <span className="font-editorial text-2xl text-darc-linen leading-none flex-shrink-0">D</span>
        <span className="font-editorial italic text-darc-linen text-base whitespace-nowrap opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200">D&apos;arc Studio</span>
      </div>

      <nav className="flex-1 p-2 space-y-1">
        <Link
          href="/financeiro"
          title="Visão Geral"
          className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
            pathname === '/financeiro'
              ? 'bg-darc-linen text-darc-velvet shadow-darc-soft'
              : 'text-darc-linen hover:bg-white/15'
          }`}
        >
          <PieChart className={`w-5 h-5 flex-shrink-0 ${pathname === '/financeiro' ? activeIconColor : 'text-darc-linen/85'}`} />
          <span className="whitespace-nowrap opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200">Visão Geral</span>
        </Link>

        {visibleItems.map((item) => {
          const isActive = pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              title={item.label}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-darc-linen text-darc-velvet shadow-darc-soft'
                  : 'text-darc-linen hover:bg-white/15'
              }`}
            >
              <Icon className={`w-5 h-5 flex-shrink-0 ${isActive ? activeIconColor : 'text-darc-linen/85'}`} />
              <span className="whitespace-nowrap opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200">{item.label}</span>
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
            <Users className={`w-5 h-5 flex-shrink-0 ${pathname.startsWith('/admin/users') ? activeIconColor : 'text-darc-linen/85'}`} />
            <span className="whitespace-nowrap opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200">Usuários</span>
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
            <span className="whitespace-nowrap opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200">
              Sair ({user.name})
            </span>
          </button>
        )}
        <div className="text-[10px] tracking-[0.2em] uppercase text-darc-linen/60 whitespace-nowrap opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200 px-3 pt-1">
          v0.1.0
        </div>
      </div>
    </aside>
  );
}
