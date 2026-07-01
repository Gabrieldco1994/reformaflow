import type { CSSProperties } from 'react';
import { Wallet, HardHat, Home, Car, ShoppingBag, FolderKanban, type LucideIcon } from 'lucide-react';

export interface TypeAccent {
  color: string;
  fill: string;
  label: string;
  description: string;
  icon: LucideIcon;
}

/** LifeOne per-project-type accent tokens (handoff), plus label/description/icon. */
export const TYPE_ACCENT: Record<string, TypeAccent> = {
  PESSOAL: { color: '#0A6CF0', fill: '#E6EFFE', label: 'Pessoal', description: 'Controle de despesas e recebimentos pessoais', icon: Wallet },
  REFORMA: { color: '#C2691E', fill: '#FBEBDC', label: 'Reforma', description: 'Controle financeiro e visual de reformas', icon: HardHat },
  CASA: { color: '#1E924A', fill: '#DEF3E6', label: 'Casa', description: 'Gerencie contas, manutenções e lembretes da casa', icon: Home },
  CARRO: { color: '#5E5A52', fill: '#EAE7E1', label: 'Carro', description: 'Controle manutenções, custos e lembretes do carro', icon: Car },
  COMPRA: { color: '#7A3FC2', fill: '#EFE6FA', label: 'Compra', description: 'Acompanhe compras grandes (casa, carro, etc.)', icon: ShoppingBag },
};

const FALLBACK: TypeAccent = {
  color: '#6E6A63',
  fill: '#ECE8E1',
  label: 'Projeto',
  description: '',
  icon: FolderKanban,
};

export function typeAccent(type: string): TypeAccent {
  return TYPE_ACCENT[type] ?? FALLBACK;
}

export function TypeIcon({
  type,
  className,
  style,
}: {
  type: string;
  className?: string;
  style?: CSSProperties;
}) {
  const Icon = typeAccent(type).icon;
  return <Icon className={className} style={style} />;
}
