"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Compass,
  Settings,
  LogOut,
  Users,
} from "lucide-react";
import { NotificationsBell } from "@/components/notifications/NotificationsBell";
import { FeedbackButton } from "@/components/feedback/FeedbackButton";
import { TypeIcon } from "../../_components/type-accent";
import { isPathActive } from "./mobile-nav";
import { navIcon } from "./nav-icons";
import type { NavModule, ProjectInfo } from "../_types";

const SIDEBAR_STORAGE_KEY = "lifeone:sidebar:collapsed";

interface DesktopSidebarProps {
  project: ProjectInfo;
  basePath: string;
  pathname: string;
  visibleNav: NavModule[];
  isAdmin: boolean;
  userName?: string;
  onLogout: () => void;
}

interface NavGroup {
  id: string;
  label: string;
  items: NavModule[];
}

function buildDesktopNavGroups(projectType: string, visibleNav: NavModule[]): NavGroup[] {
  if (projectType !== "PESSOAL") {
    return [{ id: "default", label: "Módulos", items: visibleNav }];
  }

  const bySlug = new Map(visibleNav.map((item) => [item.slug, item] as const));
  const groups: Array<{ id: string; label: string; slugs: string[] }> = [
    { id: "cockpit", label: "Cockpit", slugs: ["monthly"] },
    { id: "conta", label: "Conta", slugs: ["conta"] },
    { id: "cartoes", label: "Cartões", slugs: ["credit-cards"] },
    { id: "planejamento", label: "Planejamento", slugs: ["metas", "planning", "budget-allocation"] },
    { id: "analises", label: "Análises", slugs: ["dre", "cash-flow", "neutros"] },
  ];
  return groups
    .map((group) => ({
      id: group.id,
      label: group.label,
      items: group.slugs.map((slug) => bySlug.get(slug)).filter((item): item is NavModule => item != null),
    }))
    .filter((group) => group.items.length > 0);
}

export function DesktopSidebar({
  project,
  basePath,
  pathname,
  visibleNav,
  isAdmin,
  userName,
  onLogout,
}: DesktopSidebarProps) {
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
      if (stored === "true" || stored === "false")
        setCollapsed(stored === "true");
    } catch {
      // The default collapsed state remains usable without storage.
    }
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
      } catch {}
      return next;
    });
  };
  const labelClass = collapsed ? "sr-only" : "whitespace-nowrap truncate";
  const itemClass = `minimal-sidebar-item flex min-h-11 items-center rounded-[14px] text-sm font-medium transition-colors ${collapsed ? "justify-center px-2" : "gap-3 px-3"}`;
  const adminHref = "/admin/users";
  const isAdminActive = isPathActive(pathname, adminHref);
  const settingsHref = "/settings";
  const apoioHref = `${basePath}/apoio`;
  const isApoioActive = isPathActive(pathname, apoioHref);
  const navGroups = buildDesktopNavGroups(project.type, visibleNav);

  return (
    <aside
      className={`minimal-sidebar relative hidden flex-col border-r transition-[width] duration-200 md:flex ${collapsed ? "w-16" : "w-56"}`}
    >
      <div className="minimal-sidebar-header border-b p-2">
        <div
          className={`flex items-center ${collapsed ? "flex-col" : "justify-between"}`}
        >
          <Link
            href="/projects"
            title="Projetos"
            aria-label="Voltar para projetos"
            className="minimal-sidebar-control flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-[14px] transition-colors"
          >
            <ArrowLeft className="h-5 w-5 shrink-0" />
            <span className={labelClass}>Projetos</span>
          </Link>
          <NotificationsBell
            variant="light"
            className="minimal-sidebar-control min-h-11 min-w-11 rounded-[14px]"
          />
          <FeedbackButton
            variant="light"
            className="minimal-sidebar-control min-h-11 min-w-11 rounded-[14px]"
          />
        </div>
        <div
          className={`mt-1 flex min-h-11 items-center ${collapsed ? "justify-center" : "gap-2 px-2"}`}
          title={project.name}
        >
          <span className="minimal-sidebar-project-mark flex h-9 w-9 shrink-0 items-center justify-center rounded-[14px]">
            <TypeIcon type={project.type} className="h-5 w-5" />
          </span>
          <span
            className={`font-geist text-[15px] font-semibold ${labelClass}`}
          >
            {project.name}
          </span>
        </div>
      </div>

      <nav className="flex-1 space-y-2 overflow-y-auto p-2">
        {navGroups.map((group) => (
          <div key={group.id} className="space-y-1">
            {!collapsed && navGroups.length > 1 && (
              <p className="px-3 pb-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-lifeone-ink-4">
                {group.label}
              </p>
            )}
            {group.items.map((item) => {
              const fullHref = `${basePath}/${item.slug}`;
              const isActive = isPathActive(pathname, fullHref);
              const Icon = navIcon(item.iconName);
              return (
                <Link
                  key={item.slug}
                  href={fullHref}
                  title={item.label}
                  aria-label={item.label}
                  aria-current={isActive ? "page" : undefined}
                  className={itemClass}
                >
                  <Icon className="minimal-sidebar-icon h-5 w-5 shrink-0" />
                  <span className={labelClass}>{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
        <Link
          href={apoioHref}
          title="Apoio"
          aria-label="Apoio"
          aria-current={isApoioActive ? "page" : undefined}
          className={itemClass}
        >
          <Compass className="minimal-sidebar-icon h-5 w-5 shrink-0" />
          <span className={labelClass}>Apoio</span>
        </Link>
        {!isAdmin && (
          <Link
            href={settingsHref}
            title="Configurações"
            aria-label="Configurações"
            className={`${itemClass} text-lifeone-ink-2 hover:bg-white/70`}
          >
            <Settings className="h-5 w-5 shrink-0 text-lifeone-ink-3" />
            <span className={labelClass}>Configurações</span>
          </Link>
        )}
        {isAdmin && (
          <Link
            href={adminHref}
            title="Usuários"
            aria-label="Usuários"
            aria-current={isAdminActive ? "page" : undefined}
            className={itemClass}
          >
            <Users className="minimal-sidebar-icon h-5 w-5 shrink-0" />
            <span className={labelClass}>Usuários</span>
          </Link>
        )}
      </nav>

      <div className="minimal-sidebar-footer space-y-1 border-t p-2">
        {userName && (
          <button
            type="button"
            onClick={onLogout}
            title={`Sair (${userName})`}
            aria-label={`Sair (${userName})`}
            className={`minimal-sidebar-control w-full ${itemClass}`}
          >
            <LogOut className="h-5 w-5 shrink-0" />
            <span className={labelClass}>Sair ({userName})</span>
          </button>
        )}
        {!collapsed && (
          <div className="px-3 pt-1 text-[10px] uppercase tracking-[0.2em] text-lifeone-ink-4">
            v0.2.0
          </div>
        )}
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={
            collapsed ? "Expandir menu lateral" : "Recolher menu lateral"
          }
          title={collapsed ? "Expandir menu lateral" : "Recolher menu lateral"}
          className={`minimal-sidebar-control flex min-h-11 w-full items-center rounded-[14px] transition-colors ${collapsed ? "justify-center" : "gap-3 px-3"}`}
        >
          {collapsed ? (
            <ChevronRight className="h-5 w-5" />
          ) : (
            <ChevronLeft className="h-5 w-5" />
          )}
          <span className={labelClass}>
            {collapsed ? "Expandir" : "Recolher"}
          </span>
        </button>
      </div>
    </aside>
  );
}
