'use client';

import Link from 'next/link';
import { X, Users, LogOut } from 'lucide-react';
import { navIcon } from './nav-icons';
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
  return (
    <>
      {open && (
        <div
          className="md:hidden fixed inset-0 bg-darc-velvet/60 backdrop-blur-sm z-40"
          onClick={onClose}
          aria-hidden
        />
      )}
      <div
        className={`md:hidden fixed bottom-0 left-0 right-0 z-50 bg-white rounded-t-3xl shadow-darc-hero transition-transform duration-200 ${
          open ? 'translate-y-0' : 'translate-y-full'
        }`}
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-2">
          <div>
            <p className="text-[10px] tracking-[0.2em] uppercase text-darc-velvet/60">Mais opções</p>
            <p className="font-editorial italic text-lg text-darc-velvet">{project.name}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="p-2 rounded-full text-darc-velvet/70 hover:bg-darc-linen/60"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <nav className="px-3 pt-2 pb-3 space-y-1 max-h-[50vh] overflow-y-auto">
          {secondary.map((item) => {
            const fullHref = `${basePath}/${item.slug}`;
            const isActive = pathname.startsWith(fullHref);
            const Icon = navIcon(item.iconName);
            return (
              <Link
                key={item.slug}
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
          {userName && (
            <button
              onClick={onLogout}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-darc-velvet text-darc-pink-logo text-sm font-medium hover:bg-darc-red-bright hover:text-darc-linen transition-colors"
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
