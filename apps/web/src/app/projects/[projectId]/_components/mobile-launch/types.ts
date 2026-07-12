import type { ExpenseFormData } from '@/types';

export interface LaunchAccountOption {
  id: string;
  nickname?: string | null;
  institution?: string | null;
  last4?: string | null;
}

export interface LaunchCardOption {
  id: string;
  nickname?: string | null;
  brand?: string | null;
  last4: string;
  closingDay?: number | null;
  dueDay?: number | null;
}

export type LaunchPayload = ExpenseFormData;
