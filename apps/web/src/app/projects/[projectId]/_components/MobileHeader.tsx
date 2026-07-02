'use client';

import Link from 'next/link';
import { ChevronLeft, MoreHorizontal } from 'lucide-react';
import { NotificationsBell } from '@/components/notifications/NotificationsBell';
import { typeAccent, TypeIcon } from '../../_components/type-accent';
import type { ProjectInfo } from '../_types';

interface MobileHeaderProps {
  project: ProjectInfo;
  hasMoreSheet: boolean;
  onOpenMais: () => void;
}

export function MobileHeader({ project, hasMoreSheet, onOpenMais }: MobileHeaderProps) {
  const accent = typeAccent(project.type);
  return (
    <header className="md:hidden flex items-center justify-between gap-2 px-3 h-14 bg-white/90 backdrop-blur-md sticky top-0 z-30 border-b border-darc-linen">
      <Link
        href="/projects"
        aria-label="Voltar para projetos"
        className="flex items-center gap-0.5 -ml-1 pl-1 pr-2 py-2 rounded-lg text-darc-velvet/70 text-[13px] font-semibold hover:bg-darc-linen/60 active:bg-darc-linen transition-colors"
      >
        <ChevronLeft className="w-[18px] h-[18px]" />
        Projetos
      </Link>
      <span className="flex items-center gap-2 min-w-0 rounded-full bg-white pl-1.5 pr-3 py-1 shadow-lifeone-card">
        <span
          className="flex h-6 w-6 items-center justify-center rounded-lg flex-shrink-0"
          style={{ backgroundColor: accent.fill }}
        >
          <TypeIcon type={project.type} className="w-[15px] h-[15px]" style={{ color: accent.color }} />
        </span>
        <span className="font-geist font-bold text-[12.5px] text-lifeone-ink truncate">{project.name}</span>
      </span>
      <div className="flex items-center -mr-1">
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
