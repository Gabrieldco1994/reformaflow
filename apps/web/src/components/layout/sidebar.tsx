'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  ClipboardList,
  ShoppingCart,
  HardHat,
  ArrowLeftRight,
  AlertTriangle,
} from 'lucide-react';

const navItems = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/projects', label: 'Orçamento', icon: ClipboardList },
  { href: '/purchases', label: 'Compras', icon: ShoppingCart },
  { href: '/contractors', label: 'Empreiteiro', icon: HardHat },
  { href: '/cash-flow', label: 'Fluxo de Caixa', icon: ArrowLeftRight },
  { href: '/change-orders', label: 'Aditivos', icon: AlertTriangle },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-64 border-r border-gray-200 bg-white flex flex-col">
      <div className="p-6 border-b border-gray-200">
        <h1 className="text-xl font-bold text-brand-700">🏠 ReformaFlow</h1>
        <p className="text-xs text-gray-500 mt-1">Gestão Financeira de Obras</p>
      </div>

      <nav className="flex-1 p-4 space-y-1">
        {navItems.map((item) => {
          const isActive = pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-brand-50 text-brand-700'
                  : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
              }`}
            >
              <Icon className="w-5 h-5" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="p-4 border-t border-gray-200 text-xs text-gray-400">
        ReformaFlow v0.1.0
      </div>
    </aside>
  );
}
