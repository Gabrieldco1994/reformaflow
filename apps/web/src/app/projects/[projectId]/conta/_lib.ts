import { Barcode, Briefcase, CreditCard, Landmark, ReceiptText, RotateCcw, TrendingUp, Wallet, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function addMonthKey(key: string, delta: number) {
  const [year, month] = key.split('-').map(Number);
  const date = new Date(Date.UTC(year, (month || 1) - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monthLabelLong(key: string) {
  const [year, month] = key.split('-').map(Number);
  const date = new Date(Date.UTC(year, (month || 1) - 1, 1));
  return new Intl.DateTimeFormat('pt-BR', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export function monthLabelShort(key: string) {
  const [year, month] = key.split('-').map(Number);
  const date = new Date(Date.UTC(year, (month || 1) - 1, 1));
  return new Intl.DateTimeFormat('pt-BR', {
    month: 'short',
    timeZone: 'UTC',
  })
    .format(date)
    .replace('.', '');
}

export function formatDeltaPct(value: number | null) {
  if (value == null) return '—';
  const rounded = Math.round(value * 10) / 10;
  return `${rounded > 0 ? '+' : ''}${rounded.toLocaleString('pt-BR', {
    minimumFractionDigits: Math.abs(rounded) < 10 && rounded % 1 !== 0 ? 1 : 0,
    maximumFractionDigits: 1,
  })}%`;
}

export function averageReading(deltaVsMediaPct: number | null) {
  if (deltaVsMediaPct == null) return 'Ainda não há histórico suficiente para comparar.';
  if (deltaVsMediaPct > 5) return 'suas compras estão maiores que o normal';
  if (deltaVsMediaPct < -5) return 'suas compras estão menores que o normal';
  return 'suas compras estão perto do seu ritmo normal';
}

export function movementMeta(kind: 'cartao' | 'pix' | 'debito' | 'boleto' | 'ted' | string): {
  label: string;
  icon: LucideIcon;
  badgeClass: string;
  iconClass: string;
} {
  switch (kind) {
    case 'cartao':
      return {
        label: 'cartão',
        icon: CreditCard,
        badgeClass: 'bg-slate-100 text-slate-700',
        iconClass: 'bg-slate-100 text-slate-700',
      };
    case 'pix':
      return {
        label: 'pix',
        icon: Zap,
        badgeClass: 'bg-emerald-100 text-emerald-700',
        iconClass: 'bg-emerald-100 text-emerald-700',
      };
    case 'boleto':
      return {
        label: 'boleto',
        icon: Barcode,
        badgeClass: 'bg-amber-100 text-amber-800',
        iconClass: 'bg-amber-100 text-amber-800',
      };
    case 'ted':
      return {
        label: 'ted',
        icon: Landmark,
        badgeClass: 'bg-sky-100 text-sky-700',
        iconClass: 'bg-sky-100 text-sky-700',
      };
    case 'salario':
      return {
        label: 'salário',
        icon: Wallet,
        badgeClass: 'bg-emerald-100 text-emerald-700',
        iconClass: 'bg-emerald-100 text-emerald-700',
      };
    case 'reembolso':
      return {
        label: 'reembolso',
        icon: RotateCcw,
        badgeClass: 'bg-emerald-100 text-emerald-700',
        iconClass: 'bg-emerald-100 text-emerald-700',
      };
    case 'rendimento':
    case 'juros_renda_fixa':
    case 'dividendos':
      return {
        label: 'rendimento',
        icon: TrendingUp,
        badgeClass: 'bg-emerald-100 text-emerald-700',
        iconClass: 'bg-emerald-100 text-emerald-700',
      };
    default:
      return {
        label: humanizeKey(kind),
        icon: ReceiptText,
        badgeClass: 'bg-slate-100 text-slate-700',
        iconClass: 'bg-slate-100 text-slate-700',
      };
  }
}

export function entryMeta(tipo: string) {
  if (tipo === 'salario' || tipo === 'adiantamento_salario') {
    return {
      label: tipo === 'salario' ? 'salário' : 'adiantamento',
      icon: Wallet,
    };
  }
  if (tipo === 'reembolso') {
    return { label: 'reembolso', icon: RotateCcw };
  }
  if (tipo === 'juros_renda_fixa' || tipo === 'dividendos' || tipo === 'bonus') {
    return { label: 'rendimento', icon: TrendingUp };
  }
  if (tipo === 'freelance') {
    return { label: 'freelance', icon: Briefcase };
  }
  return { label: humanizeKey(tipo), icon: ReceiptText };
}

function humanizeKey(value: string) {
  return value
    .replace(/_/g, ' ')
    .trim()
    .toLowerCase();
}
