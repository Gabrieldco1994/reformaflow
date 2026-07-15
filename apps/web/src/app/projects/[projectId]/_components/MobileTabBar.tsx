'use client';

import Link from 'next/link';
import { CreditCard, Home, MessageCircle, Plus } from 'lucide-react';
import { hasFeature, ProjectType, type NavModule } from '@reformaflow/domain';
import { typeAccent } from '../../_components/type-accent';
import { isPathActive } from './mobile-nav';
import { navIcon } from './nav-icons';

interface MobileTabBarProps {
  basePath: string;
  pathname: string;
  projectType: ProjectType;
  primary: NavModule[];
  canLaunch?: boolean;
  onOpenLaunch: () => void;
}

const BAR_CLASS =
  'fixed inset-x-0 bottom-0 z-30 border-t border-darc-linen bg-white/95 backdrop-blur-md safe-pb md:hidden';

function tabClass(active: boolean) {
  return `flex min-h-11 min-w-0 flex-1 flex-col items-center justify-center gap-1 px-1 py-1 text-[11px] font-semibold leading-tight transition-colors ${
    active ? 'text-darc-velvet' : 'text-darc-velvet/60'
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
  if (hasFeature(projectType, 'monthlyOverview')) {
    const ExpensesIcon = navIcon('expenses');
    const todayHref = `${basePath}/monthly`;
    const expensesHref = `${basePath}/expenses`;
    const mariaHref = `${basePath}/maria`;
    const cardsHref = `${basePath}/credit-cards`;
    const canViewToday = primary.some((module) => module.slug === 'monthly');
    const canViewExpenses = canLaunch;
    const todayActive = isPathActive(pathname, todayHref);
    const expensesActive = isPathActive(pathname, expensesHref);
    const mariaActive = isPathActive(pathname, mariaHref);
    const cardsActive = isPathActive(pathname, cardsHref);

    return (
      <nav className={BAR_CLASS}>
        <div className="flex items-end justify-around px-2 pb-1 pt-1.5">
          {canViewToday && (
            <Link
              href={todayHref}
              aria-current={todayActive ? 'page' : undefined}
              className={tabClass(todayActive)}
            >
              <Home className="h-5 w-5" />
              <span className="max-w-full truncate">Cockpit</span>
            </Link>
          )}

          {canViewExpenses && (
            <Link
              href={expensesHref}
              aria-current={expensesActive ? 'page' : undefined}
              className={tabClass(expensesActive)}
            >
              <ExpensesIcon className="h-5 w-5" />
              <span className="max-w-full truncate">Despesas</span>
            </Link>
          )}

          {canLaunch && (
            <button
              type="button"
              aria-label="Lançar"
              onClick={onOpenLaunch}
              className="-mt-6 flex h-14 w-14 items-center justify-center rounded-full bg-[#0F6B4D] text-white shadow-darc-hero transition-transform active:scale-95"
            >
              <Plus className="h-6 w-6" />
            </button>
          )}

          <Link
            href={mariaHref}
            aria-current={mariaActive ? 'page' : undefined}
            className={tabClass(mariaActive)}
          >
            <MessageCircle className="h-5 w-5" />
            <span className="max-w-full truncate">Maria</span>
          </Link>

          <Link
            href={cardsHref}
            aria-current={cardsActive ? 'page' : undefined}
            className={tabClass(cardsActive)}
          >
            <CreditCard className="h-5 w-5" />
            <span className="max-w-full truncate">Cartões</span>
          </Link>
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
              aria-current={active ? 'page' : undefined}
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
