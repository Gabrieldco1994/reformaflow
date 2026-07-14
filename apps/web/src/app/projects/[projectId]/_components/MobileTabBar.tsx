"use client";

import Link from "next/link";
import { Home, MessageCircle, Plus } from "lucide-react";
import { hasFeature, ProjectType, type NavModule } from "@reformaflow/domain";
import { typeAccent } from "../../_components/type-accent";
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

const BAR_CLASS =
  "fixed inset-x-0 bottom-0 z-30 border-t border-darc-linen bg-white/95 backdrop-blur-md safe-pb md:hidden";
const PESSOAL_BAR_CLASS =
  "pessoal-minimal-dock fixed inset-x-0 bottom-0 z-30 px-[18px] md:hidden";

function tabClass(active: boolean) {
  return `flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-1 px-1 py-1 text-[11px] font-semibold leading-tight transition-colors ${
    active ? "text-darc-velvet" : "text-darc-velvet/60"
  }`;
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
    const ExpensesIcon = navIcon("expenses");
    const todayHref = `${basePath}/monthly`;
    const expensesHref = `${basePath}/expenses`;
    const mariaHref = `${basePath}/maria`;
    const canViewToday = primary.some((module) => module.slug === "monthly");
    const canViewExpenses = canLaunch;
    const todayActive = isPathActive(pathname, todayHref);
    const expensesActive = isPathActive(pathname, expensesHref);
    const mariaActive = isPathActive(pathname, mariaHref);

    return (
      <nav className={PESSOAL_BAR_CLASS} aria-label="Navegação principal">
        <div className="flex items-center gap-2.5">
          <div
            data-testid="pessoal-tab-pill"
            className="flex min-w-0 flex-1 items-center rounded-full bg-white p-2 shadow-[0_1px_2px_rgba(17,18,20,.03),0_12px_32px_rgba(17,18,20,.06)]"
          >
            {canViewToday && (
              <Link
                href={todayHref}
                aria-current={todayActive ? "page" : undefined}
                className={pessoalTabClass(todayActive)}
              >
                <Home className="h-5 w-5" />
                <span className="max-w-full truncate">Hoje</span>
              </Link>
            )}

            {canViewExpenses && (
              <Link
                href={expensesHref}
                aria-current={expensesActive ? "page" : undefined}
                className={pessoalTabClass(expensesActive)}
              >
                <ExpensesIcon className="h-5 w-5" />
                <span className="max-w-full truncate">Despesas</span>
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
          </div>

          {canLaunch && (
            <button
              type="button"
              aria-label="Lançar"
              onClick={onOpenLaunch}
              className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-white text-[#111214] shadow-[0_1px_2px_rgba(17,18,20,.03),0_12px_32px_rgba(17,18,20,.06)] transition-transform active:scale-95"
            >
              <Plus className="h-6 w-6" />
            </button>
          )}
        </div>
      </nav>
    );
  }

  if (primary.length === 0) return null;

  const accent = typeAccent(projectType);

  return (
    <nav className={BAR_CLASS}>
      <div className="flex items-stretch justify-around px-2 pb-1 pt-1.5">
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
              style={active ? { color: accent.color } : undefined}
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
