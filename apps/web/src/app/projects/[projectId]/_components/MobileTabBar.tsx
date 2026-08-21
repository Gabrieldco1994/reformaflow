"use client";

import Link from "next/link";
import { Home, Landmark, MessageCircle, Plus } from "lucide-react";
import { hasFeature, ProjectType, type NavModule } from "@reformaflow/domain";
import { isPathActive } from "./mobile-nav";
import { buildNavHref } from "../_lib/nav-href";
import { navIcon } from "./nav-icons";

interface MobileTabBarProps {
  basePath: string;
  pathname: string;
  /**
   * Query atual (string sem `?`, ex.: `mes=2026-03`). Alimenta `buildNavHref`
   * para o dock preservar o contexto compartilhado (`?mes`). O estado ativo
   * NUNCA sai daqui — vem do `pathHref` (sem query), senão `?mes` apagaria o
   * destaque (E-7, 3ª cláusula).
   */
  search?: string;
  projectType: ProjectType;
  primary: NavModule[];
  canLaunch?: boolean;
  onOpenLaunch: () => void;
}

const DOCK_CLASS = "minimal-dock fixed inset-x-0 bottom-0 z-30 px-3 md:hidden";

function tabClass(active: boolean) {
  return `minimal-tab-link ${active ? "minimal-tab-link--active" : ""} flex h-12 min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-full px-1 text-[11px] font-semibold leading-tight transition-all active:scale-95`;
}

function pessoalTabClass(active: boolean) {
  return `flex h-12 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-full px-1 text-[11px] font-semibold leading-tight transition-all active:scale-95 ${
    active ? "bg-[#111214] text-white" : "text-[#5B6068]"
  }`;
}

export function MobileTabBar({
  basePath,
  pathname,
  search = "",
  projectType,
  primary,
  canLaunch = false,
  onOpenLaunch,
}: MobileTabBarProps) {
  /**
   * Um slot do dock. `pathHref` (sem query) governa o estado ativo; `linkHref`
   * (com `?mes`) é o destino navegável. Todo slot carrega `data-dock-slot`,
   * `data-active` e `aria-current` — vocabulário congelado que a Lane B assere.
   */
  function renderSlot(
    slug: string,
    label: string,
    Icon: ReturnType<typeof navIcon>,
    className: (active: boolean) => string,
  ) {
    const pathHref = `${basePath}/${slug}`;
    const active = isPathActive(pathname, pathHref);
    return (
      <Link
        key={slug}
        href={buildNavHref(pathHref, search)}
        data-dock-slot={slug}
        data-active={active ? "true" : undefined}
        aria-current={active ? "page" : undefined}
        className={className(active)}
      >
        <Icon className="h-5 w-5" />
        <span className="max-w-full truncate">{label}</span>
      </Link>
    );
  }

  if (hasFeature(projectType, "monthlyOverview")) {
    // Dock PESSOAL: destinos FIXOS de hoje, cada um guardado por permissão via
    // presença em `primary` (D11/E-5). A Maria não é módulo de nav — é o destino
    // agent-first, sempre presente sob o gate de tipo (`monthlyOverview`).
    //
    // U4 (#453): TRÊS slots. `credit-cards` saiu de `PROJECT_NAV[PESSOAL]` e do
    // dock — cartões vivem no hub `/conta`. O slot foi REMOVIDO, não deixado
    // atrás de um `canViewCards` que `primary` nunca mais satisfaz: ramo que não
    // pode executar não tem teste honesto (só se escreve um forjando um
    // `NavModule` à mão) e volta sozinho no primeiro PR que mexer no nav.
    const canViewToday = primary.some((module) => module.slug === "monthly");
    const canViewConta = primary.some((module) => module.slug === "conta");

    return (
      <nav
        data-dock="minimal"
        className={DOCK_CLASS}
        aria-label="Navegação principal"
      >
        <div className="flex items-center gap-2.5">
          <div
            data-testid="pessoal-tab-pill"
            className="minimal-tab-pill flex min-w-0 flex-1 items-center rounded-full p-2"
          >
            {canViewToday &&
              renderSlot("monthly", "Cockpit", Home, pessoalTabClass)}
            {canViewConta &&
              renderSlot("conta", "Conta", Landmark, pessoalTabClass)}
            {renderSlot("maria", "Maria", MessageCircle, pessoalTabClass)}
          </div>

          {canLaunch && (
            <button
              type="button"
              aria-label="Lançar"
              data-launcher="true"
              onClick={onOpenLaunch}
              className="minimal-launch-action flex h-16 w-16 shrink-0 bg-white items-center justify-center rounded-full text-[#111214] transition-transform active:scale-95"
            >
              <Plus className="h-6 w-6" />
            </button>
          )}
        </div>
      </nav>
    );
  }

  if (primary.length === 0) return null;

  return (
    <nav
      data-dock="minimal"
      className={DOCK_CLASS}
      aria-label="Navegação principal"
    >
      <div className="minimal-tab-pill flex items-center rounded-full p-2">
        {primary.map((module) =>
          renderSlot(
            module.slug,
            module.label,
            navIcon(module.iconName),
            tabClass,
          ),
        )}
      </div>
    </nav>
  );
}
