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
    <header className="md:hidden sticky top-0 z-30 flex h-14 items-center gap-1.5 border-b border-darc-linen bg-white/90 px-2.5 backdrop-blur-md">
      <Link
        href="/projects"
        aria-label="Voltar para projetos"
        className="flex shrink-0 items-center gap-0.5 rounded-lg px-1.5 py-2 text-[12px] font-semibold text-darc-velvet/70 transition-colors hover:bg-darc-linen/60 active:bg-darc-linen"
      >
        <ChevronLeft className="w-[18px] h-[18px]" />
        Projetos
      </Link>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 rounded-full border border-darc-linen/70 bg-white px-1.5 py-1 shadow-lifeone-card">
        <span
          className="flex h-6 w-6 items-center justify-center rounded-lg flex-shrink-0"
          style={{ backgroundColor: accent.fill }}
        >
          <TypeIcon type={project.type} className="w-[15px] h-[15px]" style={{ color: accent.color }} />
        </span>
        <span className="truncate font-geist text-[12px] font-bold text-lifeone-ink">{project.name}</span>
      </span>
      <div className="flex shrink-0 items-center">
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
