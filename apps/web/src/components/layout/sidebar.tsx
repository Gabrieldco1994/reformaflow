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
} from 'lucide-react';
import { useAuth, type ModuleSlug } from '@/contexts/auth-context';

const navItems: { href: string; label: string; icon: typeof LayoutDashboard; module: ModuleSlug }[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, module: 'dashboard' },
  { href: '/expenses', label: 'Despesas', icon: Receipt, module: 'expenses' },
  { href: '/receipts', label: 'Recebimentos', icon: Wallet, module: 'receipts' },
  { href: '/cash-flow', label: 'Fluxo de Caixa', icon: ArrowLeftRight, module: 'cashFlow' },
  { href: '/floor-plans', label: 'Plantas', icon: Map, module: 'floorPlans' },
  { href: '/simulation', label: 'Simulação', icon: FlaskConical, module: 'simulation' },
];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, isAdmin, hasModule, logout } = useAuth();

  const visibleItems = navItems.filter((item) => hasModule(item.module));

  async function handleLogout() {
    await logout();
    router.replace('/login');
  }

  return (
    <aside className="group/sidebar w-16 hover:w-52 transition-all duration-200 border-r border-gray-200 bg-white flex flex-col overflow-hidden">
      <div className="p-3 border-b border-gray-200 flex items-center gap-2 min-h-[56px]">
        <span className="text-xl flex-shrink-0">🏠</span>
        <span className="text-sm font-bold text-brand-700 whitespace-nowrap opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200">ReformaFlow</span>
      </div>

      <nav className="flex-1 p-2 space-y-1">
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
                  ? 'bg-brand-50 text-brand-700'
                  : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
              }`}
            >
              <Icon className="w-5 h-5 flex-shrink-0" />
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
                ? 'bg-brand-50 text-brand-700'
                : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
            }`}
          >
            <Users className="w-5 h-5 flex-shrink-0" />
            <span className="whitespace-nowrap opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200">Usuários</span>
          </Link>
        )}
      </nav>

      <div className="p-2 border-t border-gray-200 space-y-1">
        {user && (
          <button
            onClick={handleLogout}
            title="Sair"
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-colors"
          >
            <LogOut className="w-5 h-5 flex-shrink-0" />
            <span className="whitespace-nowrap opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200">
              Sair ({user.name})
            </span>
          </button>
        )}
        <div className="text-xs text-gray-400 whitespace-nowrap opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200 px-3">
          v0.1.0
        </div>
      </div>
    </aside>
  );
}
