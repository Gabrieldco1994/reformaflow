function extractDatePartsInTimeZone(base: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(base);

  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value);
  const day = Number(parts.find((p) => p.type === 'day')?.value);
  return { year, month, day };
}

/**
 * Converte um instante para "dia-calendário" em `timeZone`, persistindo como
 * meia-noite UTC (YYYY-MM-DDT00:00:00.000Z).
 */
export function localDateUtc(base: Date, timeZone = 'America/Sao_Paulo'): Date {
  const { year, month, day } = extractDatePartsInTimeZone(base, timeZone);
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * "Hoje" no timezone informado, persistido como meia-noite UTC.
 */
export function todayLocalDateUtc(timeZone = 'America/Sao_Paulo', now: Date = new Date()): Date {
  return localDateUtc(now, timeZone);
}
