'use client';

import Link from 'next/link';
import { ArrowLeft, Users, LogOut } from 'lucide-react';
import { NotificationsBell } from '@/components/notifications/NotificationsBell';
import { navIcon } from './nav-icons';
import { TYPE_ICONS } from './mobile-nav';
import type { NavModule, ProjectInfo } from '../_types';

interface DesktopSidebarProps {
  project: ProjectInfo;
  basePath: string;
  pathname: string;
  visibleNav: NavModule[];
  isAdmin: boolean;
  userName?: string;
  onLogout: () => void;
}

export function DesktopSidebar({
  project,
  basePath,
  pathname,
  visibleNav,
  isAdmin,
  userName,
  onLogout,
}: DesktopSidebarProps) {
  return (
    <aside className="group/sidebar hidden md:flex bg-darc-red-bright flex-col overflow-hidden transition-all duration-200 w-16 hover:w-56">
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
          const fullHref = `${basePath}/${item.slug}`;
          const isActive = pathname.startsWith(fullHref);
          const Icon = navIcon(item.iconName);
          return (
            <Link
              key={item.slug}
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
        {userName && (
          <button
            onClick={onLogout}
            title="Sair"
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-darc-linen hover:bg-white/15 transition-colors"
          >
            <LogOut className="w-5 h-5 flex-shrink-0 text-darc-linen/85" />
            <span className="whitespace-nowrap opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200 truncate">
              Sair ({userName})
            </span>
          </button>
        )}
        <div className="text-[10px] tracking-[0.2em] uppercase text-darc-linen/60 whitespace-nowrap opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-200 px-3 pt-1">
          v0.2.0
        </div>
      </div>
    </aside>
  );
}
