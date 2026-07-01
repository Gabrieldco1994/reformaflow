import {
  LayoutDashboard,
  Receipt,
  Gauge,
  Landmark,
  Target,
  CalendarClock,
  Wallet,
  ArrowLeftRight,
  CreditCard,
  Map,
  FlaskConical,
  Wrench,
  Bell,
  Car,
  type LucideIcon,
} from 'lucide-react';

/**
 * View-layer map from the domain's stable `iconName` tokens (see
 * `@reformaflow/domain` module-navigator) to the concrete lucide components.
 * This replaces the old `icon:` field that lived inline in `FEATURE_NAV`.
 */
export const NAV_ICONS: Record<string, LucideIcon> = {
  LayoutDashboard,
  Receipt,
  Gauge,
  Landmark,
  Target,
  CalendarClock,
  Wallet,
  ArrowLeftRight,
  CreditCard,
  Map,
  FlaskConical,
  Wrench,
  Bell,
  Car,
};

/** Fallback icon for any unmapped token (defensive, never crashes). */
export function navIcon(iconName: string): LucideIcon {
  return NAV_ICONS[iconName] ?? LayoutDashboard;
}
