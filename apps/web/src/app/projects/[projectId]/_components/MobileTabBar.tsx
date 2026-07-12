'use client';

import Link from 'next/link';
import { Home, MessageCircle, Plus } from 'lucide-react';

interface MobileTabBarProps {
  basePath: string;
  pathname: string;
  onOpenLaunch: () => void;
}

function tabClass(active: boolean) {
  // Piso tipográfico v3.1 (brief): nenhum texto abaixo de 11px.
  return `flex flex-1 flex-col items-center justify-center gap-1 py-1 text-[11px] font-semibold transition-colors ${
    active ? 'text-darc-velvet' : 'text-darc-velvet/60'
  }`;
}

export function MobileTabBar({ basePath, pathname, onOpenLaunch }: MobileTabBarProps) {
  const todayHref = `${basePath}/monthly`;
  const mariaHref = `${basePath}/maria`;

  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-darc-linen bg-white/95 backdrop-blur-md safe-pb lg:hidden">
      <div className="flex items-end justify-around px-2 pb-1 pt-1.5">
        <Link href={todayHref} className={tabClass(pathname.startsWith(todayHref))}>
          <Home className="h-5 w-5" />
          <span>Hoje</span>
        </Link>

        <button
          type="button"
          aria-label="Lançar"
          onClick={onOpenLaunch}
          className="-mt-6 flex h-14 w-14 items-center justify-center rounded-full bg-darc-velvet text-darc-pink-logo shadow-darc-hero transition-transform active:scale-95"
        >
          <Plus className="h-6 w-6" />
        </button>

        <Link href={mariaHref} className={tabClass(pathname.startsWith(mariaHref))}>
          <MessageCircle className="h-5 w-5" />
          <span>Maria</span>
        </Link>
      </div>
    </nav>
  );
}
