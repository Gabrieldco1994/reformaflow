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
export function formatDateBR(value: string | Date | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '-';
  try {
    if (typeof value === 'string') {
      const datePart = value.slice(0, 10);
      const [y, m, d] = datePart.split('-');
      if (y && m && d && /^\d+$/.test(y) && /^\d+$/.test(m) && /^\d+$/.test(d)) {
        return `${d.padStart(2, '0')}/${m.padStart(2, '0')}/${y}`;
      }
      const parsed = new Date(value);
      if (!isNaN(parsed.getTime())) {
        return `${String(parsed.getDate()).padStart(2, '0')}/${String(parsed.getMonth() + 1).padStart(2, '0')}/${parsed.getFullYear()}`;
      }
      return '-';
    }
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return '-';
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  } catch {
    return '-';
  }
}

/**
 * Faz parse de uma data ISO ("YYYY-MM-DD" ou "YYYY-MM-DDTHH:mm:ss.sssZ")
 * retornando um Date no timezone local (não UTC). Útil para passar a
 * `toLocaleDateString` com opções customizadas sem o off-by-one de UTC.
 */
export function parseISODateLocal(value: string | Date | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  try {
    if (typeof value === 'string') {
      const datePart = value.slice(0, 10);
      const [y, m, d] = datePart.split('-').map(Number);
      if (y && m && d) return new Date(y, m - 1, d);
      const parsed = new Date(value);
      return isNaN(parsed.getTime()) ? null : parsed;
    }
    const d = value instanceof Date ? value : new Date(value);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}
