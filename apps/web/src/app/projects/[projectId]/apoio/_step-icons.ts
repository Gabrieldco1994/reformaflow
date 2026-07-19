import {
  ArrowLeftRight,
  Bell,
  CalendarClock,
  Car,
  CreditCard,
  FlaskConical,
  Gauge,
  Landmark,
  LayoutDashboard,
  ListChecks,
  Map as MapIcon,
  MessageCircle,
  Receipt,
  ScanSearch,
  Sprout,
  Tags,
  Wallet,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

/**
 * slug -> ícone, só para o preview visual do guia de Apoio. Reaproveita as
 * mesmas escolhas de ícone já usadas no sidebar/nav-icons.ts para o mesmo
 * slug, onde existe precedente (dashboard, expenses, bills, maria...).
 */
const STEP_ICONS: Record<string, LucideIcon> = {
  dashboard: LayoutDashboard,
  expenses: Receipt,
  receipts: Wallet,
  'cash-flow': ArrowLeftRight,
  schedule: CalendarClock,
  pendencias: ListChecks,
  'floor-plans': MapIcon,
  simulation: FlaskConical,
  monthly: Gauge,
  conta: Landmark,
  'credit-cards': CreditCard,
  'bank-accounts': Landmark,
  bills: CreditCard,
  maintenance: Wrench,
  reminders: Bell,
  'car-info': Car,
  plants: Sprout,
  'plants-ai': ScanSearch,
  maria: MessageCircle,
  'price-compare': Tags,
};

/** Fallback pro Compass do próprio guia — nunca deixa o preview sem ícone. */
export function stepIcon(slug?: string): LucideIcon {
  return (slug && STEP_ICONS[slug]) || LayoutDashboard;
}
