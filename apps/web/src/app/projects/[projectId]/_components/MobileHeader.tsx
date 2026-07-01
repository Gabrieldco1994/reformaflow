'use client';

import Link from 'next/link';
import { ArrowLeft, MoreHorizontal } from 'lucide-react';
import { NotificationsBell } from '@/components/notifications/NotificationsBell';
import { TYPE_ICONS } from './mobile-nav';
import type { ProjectInfo } from '../_types';

interface MobileHeaderProps {
  project: ProjectInfo;
  hasMoreSheet: boolean;
  onOpenMais: () => void;
}

export function MobileHeader({ project, hasMoreSheet, onOpenMais }: MobileHeaderProps) {
  return (
    <header className="md:hidden flex items-center justify-between px-4 h-14 bg-white sticky top-0 z-30 border-b border-darc-linen">
      <Link
        href="/projects"
        aria-label="Voltar para projetos"
        className="-ml-2 p-2 rounded-full text-darc-velvet/70 hover:bg-darc-linen/60 active:bg-darc-linen transition-colors"
      >
        <ArrowLeft className="w-5 h-5" />
      </Link>
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-lg flex-shrink-0">{TYPE_ICONS[project.type] ?? '📋'}</span>
        <span className="font-editorial italic text-base text-darc-velvet truncate">{project.name}</span>
      </div>
      <div className="flex items-center -mr-2">
        <NotificationsBell variant="light" />
        {hasMoreSheet ? (
          <button
            type="button"
            onClick={onOpenMais}
            aria-label="Mais opções"
            className="p-2 rounded-full text-darc-velvet/70 hover:bg-darc-linen/60 active:bg-darc-linen transition-colors"
          >
            <MoreHorizontal className="w-5 h-5" />
          </button>
        ) : null}
      </div>
    </header>
  );
}
