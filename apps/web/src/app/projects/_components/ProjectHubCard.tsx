'use client';

import { LayoutGrid } from 'lucide-react';
import { getProjectNavModules, type ProjectType } from '@reformaflow/domain';
import { typeAccent, TypeIcon } from './type-accent';

interface Project {
  id: string;
  name: string;
  type: string;
  description?: string;
  createdAt: string;
}

interface ProjectHubCardProps {
  project: Project;
  isAdmin: boolean;
  onOpen: () => void;
  onDelete: (e: React.MouseEvent) => void;
}

export function ProjectHubCard({ project, isAdmin, onOpen, onDelete }: ProjectHubCardProps) {
  const accent = typeAccent(project.type);
  const moduleCount = getProjectNavModules(project.type as ProjectType).length;

  return (
    <div
      onClick={onOpen}
      className="group relative flex flex-col bg-lifeone-card rounded-[18px] p-5 border border-lifeone-hairline shadow-lifeone-card cursor-pointer transition-all hover:-translate-y-0.5 hover:shadow-lifeone-hover"
    >
      <div className="flex items-center justify-between gap-3">
        <div
          className="w-[46px] h-[46px] rounded-[13px] flex items-center justify-center flex-shrink-0"
          style={{ backgroundColor: accent.fill }}
        >
          <TypeIcon type={project.type} className="w-[22px] h-[22px]" style={{ color: accent.color }} />
        </div>
        <span
          className="text-[10.5px] font-bold uppercase tracking-[0.06em] px-2 py-1 rounded-full"
          style={{ backgroundColor: accent.fill, color: accent.color }}
        >
          {accent.label}
        </span>
      </div>

      <div className="mt-4 flex-1 min-w-0">
        <div className="text-[18px] font-bold text-lifeone-ink tracking-[-0.02em] truncate">
          {project.name}
        </div>
        {project.description ? (
          <p className="text-[13px] text-lifeone-ink-3 mt-0.5 line-clamp-1">{project.description}</p>
        ) : null}
      </div>

      <div className="mt-3 flex items-center gap-1.5 text-[13px] text-lifeone-ink-3">
        <LayoutGrid className="w-4 h-4" />
        <span>{moduleCount} {moduleCount === 1 ? 'módulo' : 'módulos'}</span>
      </div>

      {isAdmin && (
        <button
          onClick={onDelete}
          title="Excluir projeto"
          aria-label="Excluir projeto"
          className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-lifeone-ink-4 hover:text-[#B42318] hover:bg-[#FEF3F2] transition-all"
        >
          <TrashIcon />
        </button>
      )}
    </div>
  );
}

function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}
