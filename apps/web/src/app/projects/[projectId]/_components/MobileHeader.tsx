"use client";

import Link from "next/link";
import { ChevronLeft, MoreHorizontal } from "lucide-react";
import { ProjectType } from "@reformaflow/domain";
import { NotificationsBell } from "@/components/notifications/NotificationsBell";
import { typeAccent, TypeIcon } from "../../_components/type-accent";
import type { ProjectInfo } from "../_types";

interface MobileHeaderProps {
  project: ProjectInfo;
  hasMoreSheet: boolean;
  onOpenMais: () => void;
}

export function MobileHeader({ project, hasMoreSheet, onOpenMais }: MobileHeaderProps) {
  const accent = typeAccent(project.type);
  const isMinimal = project.type === ProjectType.PESSOAL;

  return (
    <header
      data-mobile-header={isMinimal ? "minimal" : undefined}
      className={`sticky top-0 z-30 flex h-14 items-center gap-1.5 border-b border-darc-linen bg-white/90 px-2.5 backdrop-blur-md md:hidden ${
        isMinimal ? "pessoal-minimal-header" : ""
      }`}
    >
      <Link
        href="/projects"
        aria-label="Voltar para projetos"
        className={`flex shrink-0 items-center justify-center gap-0.5 rounded-full text-[12px] font-semibold text-darc-velvet/70 transition-transform active:scale-95 ${
          isMinimal ? "min-h-11 min-w-11 bg-white" : "px-1.5 py-2 hover:bg-darc-linen/60 active:bg-darc-linen"
        }`}
      >
        <ChevronLeft className="h-[18px] w-[18px]" />
        <span className={isMinimal ? "sr-only" : ""}>Projetos</span>
      </Link>
      <span
        className={`flex min-w-0 flex-1 items-center gap-1.5 px-1.5 py-1 ${
          isMinimal ? "justify-center" : "rounded-full border border-darc-linen/70 bg-white shadow-lifeone-card"
        }`}
      >
        <span
          className={`flex h-6 w-6 flex-shrink-0 items-center justify-center ${isMinimal ? "rounded-full" : "rounded-lg"}`}
          style={{ backgroundColor: isMinimal ? "#F6F7F9" : accent.fill }}
        >
          <TypeIcon
            type={project.type}
            className="h-[15px] w-[15px]"
            style={{ color: isMinimal ? "#111214" : accent.color }}
          />
        </span>
        <span className="truncate font-geist text-[12px] font-bold text-lifeone-ink">
          {project.name}
        </span>
      </span>
      <div className="flex shrink-0 items-center gap-1">
        <span
          data-testid="notification-action"
          className={isMinimal ? "flex min-h-11 min-w-11 items-center justify-center rounded-full bg-white" : "flex"}
        >
          <NotificationsBell variant="light" />
        </span>
        {hasMoreSheet ? (
          <button
            type="button"
            onClick={onOpenMais}
            aria-label="Mais opções"
            className={`flex items-center justify-center rounded-full text-darc-velvet/70 transition-transform active:scale-95 ${
              isMinimal ? "min-h-11 min-w-11 bg-white" : "p-2 hover:bg-darc-linen/60 active:bg-darc-linen"
            }`}
          >
            <MoreHorizontal className="h-5 w-5" />
          </button>
        ) : null}
      </div>
    </header>
  );
}
