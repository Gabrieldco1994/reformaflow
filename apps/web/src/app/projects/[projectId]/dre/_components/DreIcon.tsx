import {
  AlertTriangle,
  Briefcase,
  Car,
  Coins,
  CreditCard,
  GraduationCap,
  Heart,
  Home,
  Landmark,
  PiggyBank,
  RotateCcw,
  Sparkles,
  TrendingUp,
  UtensilsCrossed,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  home: Home,
  utensils: UtensilsCrossed,
  car: Car,
  heart: Heart,
  sparkles: Sparkles,
  school: GraduationCap,
  coins: Coins,
  'piggy-bank': PiggyBank,
  'credit-card': CreditCard,
  'building-bank': Landmark,
  wallet: Wallet,
  refresh: RotateCcw,
  'chart-line': TrendingUp,
  briefcase: Briefcase,
  alert: AlertTriangle,
};

export function DreIcon({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  const Icon = ICONS[name] ?? Wallet;
  return <Icon className={className ?? 'h-4 w-4'} />;
}
