'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Receipt,
  Wallet,
  ArrowLeftRight,
  FlaskConical,
} from 'lucide-react';

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/expenses', label: 'Despesas', icon: Receipt },
  { href: '/receipts', label: 'Recebimentos', icon: Wallet },
  { href: '/cash-flow', label: 'Fluxo de Caixa', icon: ArrowLeftRight },
  { href: '/simulation', label: 'Simulação', icon: FlaskConical },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="group/sidebar w-16 hover:w-52 transition-all duration-200 border-r border-gray-200 bg-white flex flex-col overflow-hidden">
      <div className="p-3 border-b border-gray-200 flex items-center gap-2 min-h-[56px]">
        <span className="text-xl flex-shrink-0">🏠</span>
        <span className="text-sm font-bold text-brand-700 whitespace-nowrap opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200">ReformaFlow</span>
      </div>

      <nav className="flex-1 p-2 space-y-1">
        {navItems.map((item) => {
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
      </nav>

      <div className="p-2 border-t border-gray-200 text-xs text-gray-400 whitespace-nowrap opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200">
        ReformaFlow v0.1.0
      </div>
    </aside>
  );
}
