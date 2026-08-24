"use client";

import { useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { Archive, Compass, LogOut, Settings, Users, X } from "lucide-react";
import { buildNavGroups, type ProjectType } from "@reformaflow/domain";
import { isPathActive } from "./mobile-nav";
import { buildNavHref } from "../_lib/nav-href";
import { navIcon } from "./nav-icons";
import type { NavModule, ProjectInfo } from "../_types";

interface MaisSheetProps {
  open: boolean;
  project: ProjectInfo;
  basePath: string;
  pathname: string;
  /** Query atual (sem `?`) para preservar o contexto compartilhado (`?mes`). */
  search?: string;
  secondary: NavModule[];
  isAdmin: boolean;
  /** #504 — ver `DesktopSidebar`: descoberta do histórico congelado de budget. */
  canSeeBudgetHistory: boolean;
  userName?: string;
  onClose: () => void;
  onLogout: () => void;
}

function GridTile({
  href,
  label,
  Icon,
  isActive,
  testId,
}: {
  href: string;
  label: string;
  Icon: ReturnType<typeof navIcon>;
  isActive: boolean;
  testId?: string;
}) {
  return (
    <Link
      href={href}
      aria-current={isActive ? "page" : undefined}
      data-testid={testId}
      className="minimal-more-tile flex min-h-[74px] min-w-0 flex-col items-center gap-2 rounded-2xl px-1.5 py-3.5 transition-transform active:scale-95"
    >
      <span className="minimal-more-icon flex h-10 w-10 items-center justify-center rounded-[13px]">
        <Icon className="h-5 w-5" />
      </span>
      {/*
        U2-E11 — o rótulo NÃO pode depender de quanto uma fonte específica mede.
        A célula do grid-cols-4 é ~78px; sem largura própria o span cresce até o
        max-content da palavra e uma palavra longa (Recebimentos/Recorrentes/
        Planejador) transborda por poucos px — invisível no macOS, +2px no Linux
        do CI (`sw:80 cw:78`). `w-full` prende o span à célula e `break-words`
        quebra a palavra dentro dela: a MESMA folga existe com uma fonte 3% mais
        larga, porque a palavra passa a quebrar em vez de vazar. E-03 (1 linha) é
        do DOCK; o Mais não exige linha única (E-04 só mede 44px e ≥11px).
      */}
      <span className="minimal-more-label w-full break-words text-center text-[11px] font-semibold leading-tight">
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
  search = "",
  secondary,
  isAdmin,
  canSeeBudgetHistory,
  userName,
  onClose,
  onLogout,
}: MaisSheetProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Mesma taxonomia do dock e do rail (§4.d): o Mais lista o COMPLEMENTO do
  // dock agrupado por NAV_GROUPS. Grupos vazios não são emitidos (buildNavGroups
  // já garante). Vocabulário único, três superfícies.
  const navGroups = useMemo(
    () => buildNavGroups(project.type as ProjectType, secondary),
    [project.type, secondary],
  );
  const showGroupLabels = navGroups.length > 1;

  useEffect(() => {
    if (!open) return;
    const trigger = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const focusableSelector =
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

    dialog?.querySelector<HTMLElement>(focusableSelector)?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;

      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(focusableSelector),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      trigger?.focus();
    };
  }, [onClose, open]);

  if (!open) return null;

  /**
   * `pathHref` (sem query) governa o estado ativo; `linkHref` (com `?mes`) é o
   * destino. `leavesProject` corta o contexto para destinos fora do projeto
   * (`/admin/users`, `/settings`) — levar `?mes` para lá é lixo.
   */
  function tile(
    pathHref: string,
    label: string,
    Icon: ReturnType<typeof navIcon>,
    options?: { leavesProject?: boolean; testId?: string },
  ) {
    return (
      <GridTile
        key={pathHref}
        href={buildNavHref(pathHref, search, options)}
        label={label}
        Icon={Icon}
        isActive={isPathActive(pathname, pathHref)}
        testId={options?.testId}
      />
    );
  }

  return (
    <>
      <div
        className="minimal-backdrop fixed inset-0 z-40 bg-darc-velvet/60 backdrop-blur-sm md:hidden"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="minimal-more-title"
        data-overlay="mais"
        className="minimal-more-sheet fixed inset-x-0 bottom-0 z-50 rounded-t-[26px] md:hidden"
      >
        <div className="flex justify-center pt-2.5">
          <span
            className="minimal-more-handle h-1 w-9 rounded-full bg-darc-velvet/20"
            aria-hidden
          />
        </div>
        <div className="flex items-center justify-between px-5 pb-3 pt-2">
          <div>
            <p className="text-[10px] uppercase tracking-[0.2em] text-darc-velvet/60">
              Mais opções
            </p>
            <p
              id="minimal-more-title"
              className="font-geist text-lg font-semibold text-lifeone-ink"
            >
              {project.name}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-darc-velvet/70 hover:bg-darc-linen/60"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="max-h-[52dvh] space-y-4 overflow-y-auto px-4 pb-3 pt-1">
          {navGroups.map((group) => (
            <section
              key={group.id}
              role="group"
              aria-label={group.label}
              data-nav-group={group.id}
              data-nav-tier={group.tier}
            >
              {showGroupLabels && (
                <p className="px-1.5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-darc-velvet/50">
                  {group.label}
                </p>
              )}
              <div className="grid grid-cols-4 gap-2.5">
                {group.items.map((item) =>
                  tile(
                    `${basePath}/${item.slug}`,
                    item.label,
                    navIcon(item.iconName),
                  ),
                )}
              </div>
            </section>
          ))}

          {/*
            Cluster utilitário — paridade com o rodapé do rail (D8): Apoio é um
            destino de apoio do projeto (não um módulo de nav), presente em toda
            superfície. Histórico de Budget e Usuários seguem seus gates.
          */}
          <div className="grid grid-cols-4 gap-2.5">
            {tile(`${basePath}/apoio`, "Apoio", Compass)}
            {canSeeBudgetHistory &&
              tile(`${basePath}/budget-allocation`, "Histórico de Budget", Archive, {
                testId: "mais-budget-history",
              })}
            {isAdmin &&
              tile("/admin/users", "Usuários", Users, { leavesProject: true })}
          </div>
        </div>
        <div className="minimal-more-footer space-y-2 border-t border-darc-linen px-4 pb-5 pt-2 safe-pb">
          {!isAdmin && (
            <Link
              href="/settings"
              role="button"
              className="flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl bg-white px-4 py-2.5 text-sm font-medium text-lifeone-ink-2"
            >
              <Settings className="h-4 w-4" aria-hidden="true" />
              Configurações
            </Link>
          )}
          {userName && (
            <button
              type="button"
              onClick={onLogout}
              className="minimal-more-logout flex min-h-[52px] w-full items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-medium transition-colors"
            >
              <LogOut className="h-4 w-4" />
              Sair ({userName})
            </button>
          )}
        </div>
      </div>
    </>
  );
}
