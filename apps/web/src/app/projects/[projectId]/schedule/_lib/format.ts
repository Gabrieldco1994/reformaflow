export function fmtCurrency(cents: number | null): string {
  if (cents == null) return '-';
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function fmtDate(iso: string | null | Date): string {
  if (!iso) return '-';
  const d = iso instanceof Date ? iso : new Date(iso);
  return d.toLocaleDateString('pt-BR');
}

export function toDateInputValue(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toISOString().slice(0, 10);
}

export function fromDateInputValue(value: string): string | null {
  if (!value) return null;
  return new Date(value + 'T12:00:00').toISOString();
}

export function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString();
}

export const DAY_NAMES = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
export const MONTH_NAMES = [
  'Jan',
  'Fev',
  'Mar',
  'Abr',
  'Mai',
  'Jun',
  'Jul',
  'Ago',
  'Set',
  'Out',
  'Nov',
  'Dez',
];

export function parsePredecessoras(value: string | null): number[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map((n) => Number(n)).filter((n) => Number.isFinite(n));
  } catch {
    // fallthrough — accept "2,3" too
  }
  return value
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

export function formatPredecessoras(nums: number[]): string | null {
  if (!nums.length) return null;
  return JSON.stringify(nums);
}

export function predecessorasDisplay(value: string | null): string {
  const nums = parsePredecessoras(value);
  if (!nums.length) return '';
  return nums.join(',');
}
