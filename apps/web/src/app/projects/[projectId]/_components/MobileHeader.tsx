"use client";

import Link from "next/link";
import { ChevronLeft, MoreHorizontal } from "lucide-react";
import { NotificationsBell } from "@/components/notifications/NotificationsBell";
import { FeedbackButton } from "@/components/feedback/FeedbackButton";
import { TypeIcon } from "../../_components/type-accent";
import type { ProjectInfo } from "../_types";

interface MobileHeaderProps {
  project: ProjectInfo;
  hasMoreSheet: boolean;
  onOpenMais: () => void;
}

export function MobileHeader({
  project,
  hasMoreSheet,
  onOpenMais,
}: MobileHeaderProps) {
  return (
    <header
      data-mobile-header="minimal"
      className="minimal-header safe-pt sticky top-0 z-30 flex h-14 items-center gap-1.5 border-b border-darc-linen bg-white/90 px-2.5 backdrop-blur-md md:hidden"
    >
      <Link
        href="/projects"
        aria-label="Voltar para projetos"
        className="flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-0.5 rounded-full bg-white text-[12px] font-semibold text-darc-velvet/70 transition-transform active:scale-95"
      >
        <ChevronLeft className="h-[18px] w-[18px]" />
        <span className="sr-only">Projetos</span>
      </Link>
      <span className="flex min-w-0 flex-1 items-center justify-center gap-1.5 px-1.5 py-1">
        <span className="minimal-project-mark flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full">
          <TypeIcon
            type={project.type}
            className="minimal-project-icon h-[15px] w-[15px]"
          />
        </span>
        <span className="truncate font-geist text-[12px] font-bold text-lifeone-ink">
          {project.name}
        </span>
      </span>
      <div className="flex shrink-0 items-center gap-1">
        <span
          data-testid="notification-action"
          className="flex min-h-11 min-w-11 items-center justify-center rounded-full bg-white"
        >
          <NotificationsBell variant="light" />
        </span>
        <span className="flex min-h-11 min-w-11 items-center justify-center rounded-full bg-white">
          <FeedbackButton variant="light" />
        </span>
        {hasMoreSheet ? (
          <button
            type="button"
            onClick={onOpenMais}
            aria-label="Mais opções"
            className="flex min-h-11 min-w-11 items-center justify-center rounded-full bg-white text-darc-velvet/70 transition-transform active:scale-95"
          >
            <MoreHorizontal className="h-5 w-5" />
          </button>
        ) : null}
      </div>
    </header>
  );
}
