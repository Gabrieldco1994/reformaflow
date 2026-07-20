"use client";

import Link from "next/link";
import { CreditCard, Home, Landmark, MessageCircle, Plus } from "lucide-react";
import { hasFeature, ProjectType, type NavModule } from "@reformaflow/domain";
import { isPathActive } from "./mobile-nav";
import { navIcon } from "./nav-icons";

interface MobileTabBarProps {
  basePath: string;
  pathname: string;
  projectType: ProjectType;
  primary: NavModule[];
  canLaunch?: boolean;
  onOpenLaunch: () => void;
}

const DOCK_CLASS =
  "minimal-dock fixed inset-x-0 bottom-0 z-30 px-[18px] md:hidden";

function tabClass(active: boolean) {
  return `minimal-tab-link ${active ? "minimal-tab-link--active" : ""} flex h-12 min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-full px-1 text-[10px] font-semibold leading-tight transition-all active:scale-95`;
}

function pessoalTabClass(active: boolean) {
  return `flex h-12 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-full px-1 text-[10px] font-semibold leading-tight transition-all active:scale-95 ${
    active ? "bg-[#111214] text-white" : "text-[#5B6068]"
  }`;
}

export function MobileTabBar({
  basePath,
  pathname,
  projectType,
  primary,
  canLaunch = false,
  onOpenLaunch,
}: MobileTabBarProps) {
  if (hasFeature(projectType, "monthlyOverview")) {
    const todayHref = `${basePath}/monthly`;
    const contaHref = `${basePath}/conta`;
    const mariaHref = `${basePath}/maria`;
    const cardsHref = `${basePath}/credit-cards`;
    const canViewToday = primary.some((module) => module.slug === "monthly");
    const canViewConta = primary.some((module) => module.slug === "conta");
    const todayActive = isPathActive(pathname, todayHref);
    const contaActive = isPathActive(pathname, contaHref);
    const mariaActive = isPathActive(pathname, mariaHref);
    const cardsActive = isPathActive(pathname, cardsHref);

    return (
      <nav className={DOCK_CLASS} aria-label="Navegação principal">
        <div className="flex items-center gap-2.5">
          <div
            data-testid="pessoal-tab-pill"
            className="minimal-tab-pill flex min-w-0 flex-1 items-center rounded-full p-2"
          >
            {canViewToday && (
              <Link
                href={todayHref}
                aria-current={todayActive ? "page" : undefined}
                className={pessoalTabClass(todayActive)}
              >
                <Home className="h-5 w-5" />
                <span className="max-w-full truncate">Cockpit</span>
              </Link>
            )}

            {canViewConta && (
              <Link
                href={contaHref}
                aria-current={contaActive ? "page" : undefined}
                className={pessoalTabClass(contaActive)}
              >
                <Landmark className="h-5 w-5" />
                <span className="max-w-full truncate">Conta</span>
              </Link>
            )}

            <Link
              href={mariaHref}
              aria-current={mariaActive ? "page" : undefined}
              className={pessoalTabClass(mariaActive)}
            >
              <MessageCircle className="h-5 w-5" />
              <span className="max-w-full truncate">Maria</span>
            </Link>

            <Link
              href={cardsHref}
              aria-current={cardsActive ? "page" : undefined}
              className={pessoalTabClass(cardsActive)}
            >
              <CreditCard className="h-5 w-5" />
              <span className="max-w-full truncate">Cartões</span>
            </Link>
          </div>

          {canLaunch && (
            <button
              type="button"
              aria-label="Lançar"
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
    <nav className={DOCK_CLASS} aria-label="Navegação principal">
      <div className="minimal-tab-pill flex items-center rounded-full p-2">
        {primary.map((module) => {
          const href = `${basePath}/${module.slug}`;
          const active = isPathActive(pathname, href);
          const Icon = navIcon(module.iconName);

          return (
            <Link
              key={module.slug}
              href={href}
              aria-current={active ? "page" : undefined}
              className={tabClass(active)}
            >
              <Icon className="h-5 w-5" />
              <span className="max-w-full truncate">{module.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
