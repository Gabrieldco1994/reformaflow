"use client";

import Link from "next/link";
import { FolderKanban, MoreHorizontal } from "lucide-react";
import { NotificationsBell } from "@/components/notifications/NotificationsBell";
import { FeedbackButton } from "@/components/feedback/FeedbackButton";
import { TypeIcon } from "../../_components/type-accent";
import type { ProjectInfo } from "../_types";

interface MobileHeaderProps {
  project: ProjectInfo;
  hasMoreSheet: boolean;
  /**
   * Nº de destinos do Mais = `|visibleNav \ dock|` (a "lista" do complemento,
   * contrato do PO). Alimenta `data-mais-count` e o nome acessível
   * `Mais opções (n)` — um "Mais" mudo é indistinguível de um "Mais" vazio.
   */
  maisCount: number;
  onOpenMais: () => void;
}

export function MobileHeader({
  project,
  hasMoreSheet,
  maisCount,
  onOpenMais,
}: MobileHeaderProps) {
  return (
    <header
      data-mobile-header="minimal"
      data-scope-project-id={project.id}
      data-scope-project-type={project.type}
      className="minimal-header sticky top-0 z-30 flex h-14 items-center gap-1.5 border-b border-darc-linen bg-white px-2.5 md:hidden"
    >
      {/*
        U1/U2-E18 — "Projetos" é DESTINO ANCORADO (par do rail), não "voltar". O
        U1 rejeitou a leitura direcional no desktop; aqui vale igual. `FolderKanban`
        é o glifo que o app já usa para a noção de "Projeto" — reuso, não invenção.
      */}
      <Link
        href="/projects"
        aria-label="Projetos"
        data-nav-group="projetos"
        data-nav-tier="primary"
        className="flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full bg-white text-darc-velvet/70 transition-transform active:scale-95"
      >
        <FolderKanban className="h-5 w-5" />
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
        <span
          data-testid="feedback-action"
          className="flex min-h-11 min-w-11 items-center justify-center rounded-full bg-white"
        >
          <FeedbackButton variant="light" />
        </span>
        {hasMoreSheet ? (
          <button
            type="button"
            onClick={onOpenMais}
            aria-label={`Mais opções (${maisCount})`}
            data-mais-count={maisCount}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-full bg-white text-darc-velvet/70 transition-transform active:scale-95"
          >
            <MoreHorizontal className="h-5 w-5" />
          </button>
        ) : null}
      </div>
    </header>
  );
}
