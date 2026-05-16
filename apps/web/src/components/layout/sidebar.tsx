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
    <aside className="group/sidebar w-16 hover:w-56 transition-all duration-200 bg-darc-velvet flex flex-col overflow-hidden">
      <div className="p-3 border-b border-darc-maroon/50 flex items-center gap-3 min-h-[56px]">
        <span className="font-editorial text-2xl text-darc-red leading-none flex-shrink-0">D</span>
        <span className="font-editorial italic text-darc-linen text-base whitespace-nowrap opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200">D&apos;arc Studio</span>
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
                  ? 'bg-darc-red text-darc-linen'
                  : 'text-darc-linen hover:bg-darc-mist/15'
              }`}
            >
              <Icon className={`w-5 h-5 flex-shrink-0 ${isActive ? 'text-darc-linen' : 'text-darc-mist'}`} />
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
                ? 'bg-darc-red text-darc-linen'
                : 'text-darc-linen hover:bg-darc-mist/15'
            }`}
          >
            <Users className={`w-5 h-5 flex-shrink-0 ${pathname.startsWith('/admin/users') ? 'text-darc-linen' : 'text-darc-mist'}`} />
            <span className="whitespace-nowrap opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200">Usuários</span>
          </Link>
        )}
      </nav>

      <div className="p-2 border-t border-darc-maroon/50 space-y-1">
        {user && (
          <button
            onClick={handleLogout}
            title="Sair"
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-darc-linen hover:bg-darc-mist/15 transition-colors"
          >
            <LogOut className="w-5 h-5 flex-shrink-0 text-darc-mist" />
            <span className="whitespace-nowrap opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200">
              Sair ({user.name})
            </span>
          </button>
        )}
        <div className="text-[10px] tracking-[0.2em] uppercase text-darc-mist/60 whitespace-nowrap opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200 px-3 pt-1">
          v0.1.0
        </div>
      </div>
    </aside>
  );
}
