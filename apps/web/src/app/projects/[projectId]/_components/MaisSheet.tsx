'use client';

import Link from 'next/link';
import { X, Users, LogOut } from 'lucide-react';
import { typeAccent } from '../../_components/type-accent';
import { navIcon } from './nav-icons';
import { isPathActive } from './mobile-nav';
import type { NavModule, ProjectInfo } from '../_types';

interface MaisSheetProps {
  open: boolean;
  project: ProjectInfo;
  basePath: string;
  pathname: string;
  secondary: NavModule[];
  isAdmin: boolean;
  userName?: string;
  onClose: () => void;
  onLogout: () => void;
}

function GridTile({
  href,
  label,
  Icon,
  isActive,
  accent,
}: {
  href: string;
  label: string;
  Icon: ReturnType<typeof navIcon>;
  isActive: boolean;
  accent: { color: string; fill: string };
}) {
  return (
    <Link
      href={href}
      aria-current={isActive ? 'page' : undefined}
      className="pessoal-minimal-more-tile flex flex-col items-center gap-2 rounded-2xl px-1.5 py-3.5 min-h-[74px] active:scale-95 transition-transform"
      style={{ backgroundColor: isActive ? accent.fill : '#FFFFFF' }}
    >
      <span
        className="pessoal-minimal-more-icon flex h-10 w-10 items-center justify-center rounded-[13px]"
        style={{ backgroundColor: isActive ? '#FFFFFF' : accent.fill }}
      >
        <Icon className="w-5 h-5" style={{ color: accent.color }} />
      </span>
      <span
        className="pessoal-minimal-more-label text-[10.5px] font-semibold leading-tight text-center"
        style={{ color: isActive ? accent.color : '#4A463F' }}
      >
        {label}
      </span>
    </Link>
  );
}

export function MaisSheet({
  open,
  project,
  basePath,
  pathname,
  secondary,
  isAdmin,
  userName,
  onClose,
  onLogout,
}: MaisSheetProps) {
  const accent = typeAccent(project.type);
  return (
    <>
      {open && (
        <div
          className="pessoal-minimal-backdrop md:hidden fixed inset-0 bg-darc-velvet/60 backdrop-blur-sm z-40"
          onClick={onClose}
          aria-hidden
        />
      )}
      <div
        className={`pessoal-minimal-more-sheet md:hidden fixed bottom-0 left-0 right-0 z-50 bg-lifeone-surface rounded-t-[26px] shadow-lifeone-dialog transition-transform duration-200 ${
          open ? 'translate-y-0' : 'translate-y-full'
        }`}
      >
        <div className="flex justify-center pt-2.5">
          <span className="h-1 w-9 rounded-full bg-darc-velvet/20" aria-hidden />
        </div>
        <div className="flex items-center justify-between px-5 pt-2 pb-3">
          <div>
            <p className="text-[10px] tracking-[0.2em] uppercase text-darc-velvet/60">Mais opções</p>
            <p className="font-geist font-semibold text-lg text-lifeone-ink">{project.name}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-darc-velvet/70 hover:bg-darc-linen/60"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-4 pt-1 pb-3 max-h-[52vh] overflow-y-auto">
          <div className="grid grid-cols-4 gap-2.5">
            {secondary.map((item) => {
              const fullHref = `${basePath}/${item.slug}`;
              return (
                <GridTile
                  key={item.slug}
                  href={fullHref}
                  label={item.label}
                  Icon={navIcon(item.iconName)}
                  isActive={isPathActive(pathname, fullHref)}
                  accent={accent}
                />
              );
            })}
            {isAdmin && (
              <GridTile
                href="/admin/users"
                label="Usuários"
                Icon={Users}
                isActive={isPathActive(pathname, '/admin/users')}
                accent={accent}
              />
            )}
          </div>
        </div>
        <div className="px-4 pb-5 pt-2 border-t border-darc-linen safe-pb">
          {userName && (
            <button
              onClick={onLogout}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-2xl bg-darc-velvet text-darc-pink-logo text-sm font-medium hover:bg-darc-red-bright hover:text-darc-linen transition-colors min-h-[52px]"
            >
              <LogOut className="w-4 h-4" />
              Sair ({userName})
            </button>
          )}
        </div>
      </div>
    </>
  );
}
