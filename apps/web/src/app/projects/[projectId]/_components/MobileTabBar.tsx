'use client';

import Link from 'next/link';
import { Bot, MoreHorizontal } from 'lucide-react';
import { useCopilotStore } from '@/stores/copilot-store';
import { typeAccent } from '../../_components/type-accent';
import { navIcon } from './nav-icons';
import { getMobilePrimary } from './mobile-nav';
import type { NavModule } from '../_types';

interface MobileTabBarProps {
  projectType: string;
  visibleNav: NavModule[];
  basePath: string;
  pathname: string;
  isAdmin: boolean;
  onOpenMais: () => void;
}

function TabLink({
  item,
  basePath,
  pathname,
  accent,
}: {
  item: NavModule;
  basePath: string;
  pathname: string;
  accent: { color: string; fill: string };
}) {
  const fullHref = `${basePath}/${item.slug}`;
  const isActive = pathname.startsWith(fullHref);
  const Icon = navIcon(item.iconName);
  return (
    <Link
      href={fullHref}
      className="relative flex flex-col items-center justify-center gap-0.5 flex-1 py-1 rounded-lg active:scale-95 transition-transform"
    >
      <span
        className="relative flex items-center justify-center h-7 w-12 rounded-full transition-colors"
        style={isActive ? { backgroundColor: accent.fill } : undefined}
      >
        <Icon
          className={`w-5 h-5 ${isActive ? '' : 'text-darc-velvet/70'}`}
          style={isActive ? { color: accent.color } : undefined}
        />
      </span>
      <span
        className={`text-[10px] leading-tight font-medium tracking-tight ${isActive ? '' : 'text-darc-velvet/70'}`}
        style={{ color: isActive ? accent.color : undefined }}
      >
        {item.label}
      </span>
    </Link>
  );
}

/**
 * Unified mobile bottom tab bar with a fixed 5-slot layout:
 * [tab][tab] · [Maria center] · [tab][Mais]
 * Active tab pill is tinted with the project-type accent (handoff mobile UX).
 */
export function MobileTabBar({
  projectType,
  visibleNav,
  basePath,
  pathname,
  isAdmin,
  onOpenMais,
}: MobileTabBarProps) {
  const toggleCopilot = useCopilotStore((s) => s.toggle);
  const { primary, secondary } = getMobilePrimary(projectType, visibleNav);
  const showMais = secondary.length > 0 || isAdmin;
  const accent = typeAccent(projectType);

  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-white/95 backdrop-blur-md border-t border-darc-linen safe-pb">
      <div className="flex items-end justify-around px-1 pt-1.5 pb-1">
        {/* LEFT: primary[0], primary[1] */}
        {primary[0] && <TabLink item={primary[0]} basePath={basePath} pathname={pathname} accent={accent} />}
        {primary[1] && <TabLink item={primary[1]} basePath={basePath} pathname={pathname} accent={accent} />}

        {/* CENTER: Maria copiloto */}
        <div className="flex flex-1 items-center justify-center">
          <button
            type="button"
            onClick={toggleCopilot}
            aria-label="Abrir copiloto"
            className="-mt-6 flex h-14 w-14 items-center justify-center rounded-full bg-darc-velvet text-darc-pink-logo shadow-darc-hero active:scale-95 transition-transform"
          >
            <Bot className="w-6 h-6" />
          </button>
        </div>

        {/* RIGHT: primary[2], Mais */}
        {primary[2] && <TabLink item={primary[2]} basePath={basePath} pathname={pathname} accent={accent} />}
        {showMais && (
          <button
            type="button"
            onClick={onOpenMais}
            aria-label="Mais opções"
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
  );
}
