"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { LogOut, Users, X } from "lucide-react";
import { isPathActive } from "./mobile-nav";
import { navIcon } from "./nav-icons";
import type { NavModule, ProjectInfo } from "../_types";

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
}: {
  href: string;
  label: string;
  Icon: ReturnType<typeof navIcon>;
  isActive: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={isActive ? "page" : undefined}
      className="minimal-more-tile flex min-h-[74px] flex-col items-center gap-2 rounded-2xl px-1.5 py-3.5 transition-transform active:scale-95"
    >
      <span className="minimal-more-icon flex h-10 w-10 items-center justify-center rounded-[13px]">
        <Icon className="h-5 w-5" />
      </span>
      <span className="minimal-more-label text-center text-[10.5px] font-semibold leading-tight">
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
  const dialogRef = useRef<HTMLDivElement>(null);

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
        <div className="max-h-[52vh] overflow-y-auto px-4 pb-3 pt-1">
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
                />
              );
            })}
            {isAdmin && (
              <GridTile
                href="/admin/users"
                label="Usuários"
                Icon={Users}
                isActive={isPathActive(pathname, "/admin/users")}
              />
            )}
          </div>
        </div>
        <div className="minimal-more-footer border-t border-darc-linen px-4 pb-5 pt-2 safe-pb">
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
