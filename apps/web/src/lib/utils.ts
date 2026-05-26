import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(value: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(value);
}

export function formatPercent(value: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

/**
 * Formata data (ISO string ou Date) como dd/mm/yyyy sem aplicar timezone.
 * Resolve o bug de `new Date("2026-05-15").toLocaleDateString('pt-BR')` virar "14/05" em UTC-3.
 */
export function formatDateBR(value: string | Date | null | undefined): string {
  if (!value) return '-';
  const iso = typeof value === 'string' ? value : value.toISOString();
  const datePart = iso.slice(0, 10);
  const [y, m, d] = datePart.split('-');
  if (!y || !m || !d) return '-';
  return `${d}/${m}/${y}`;
}

/**
 * Faz parse de uma data ISO ("YYYY-MM-DD" ou "YYYY-MM-DDTHH:mm:ss.sssZ")
 * retornando um Date no timezone local (não UTC). Útil para passar a
 * `toLocaleDateString` com opções customizadas sem o off-by-one de UTC.
 */
export function parseISODateLocal(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const iso = typeof value === 'string' ? value : value.toISOString();
  const datePart = iso.slice(0, 10);
  const [y, m, d] = datePart.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}
