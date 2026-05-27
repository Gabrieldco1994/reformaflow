import type { Receipt } from '@/types';

export interface TipoOption {
  value: string;
  label: string;
  group?: string;
}

export interface GrupoPorTipo {
  tipo: string;
  label: string;
  items: Receipt[];
  total: number;
  totalEmCaixa: number;
  totalPrevisto: number;
}

export interface GrupoPorMes {
  mesKey: string; // 'YYYY-MM'
  mesLabel: string; // 'Outubro 2026'
  items: Receipt[];
  total: number;
  totalEmCaixa: number;
  totalPrevisto: number;
  isCurrentMonth: boolean;
  isFuture: boolean;
}

export type ViewMode = 'month' | 'type';
