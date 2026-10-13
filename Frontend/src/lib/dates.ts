export type DateFormat = 'auto' | 'day-first' | 'month-first';

export function detectDateFormat(values: string[]): Exclude<DateFormat, 'auto'> {
  for (const value of values) {
    const match = value.trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.]\d{4}$/);
    if (!match) continue;
    const first = Number(match[1]);
    const second = Number(match[2]);
    if (first > 12 && second <= 12) return 'day-first';
    if (second > 12 && first <= 12) return 'month-first';
  }

  const example = values.find(value => /^\d{1,2}[-/.]\d{1,2}[-/.]\d{4}$/.test(value.trim()))?.trim();
  return example?.includes('/') ? 'month-first' : 'day-first';
}

export function parseWeeklyDate(value: string, format: Exclude<DateFormat, 'auto'>): string | null {
  const text = value.trim();
  const yearFirst = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ].*)?$/);
  let year: number;
  let month: number;
  let day: number;

  if (yearFirst) {
    year = Number(yearFirst[1]);
    month = Number(yearFirst[2]);
    day = Number(yearFirst[3]);
  } else {
    const parts = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    if (parts) {
      const first = Number(parts[1]);
      const second = Number(parts[2]);
      year = Number(parts[3]);
      month = format === 'day-first' ? second : first;
      day = format === 'day-first' ? first : second;
    } else {
      const fallback = new Date(text);
      if (!Number.isFinite(fallback.getTime())) return null;
      year = fallback.getUTCFullYear();
      month = fallback.getUTCMonth() + 1;
      day = fallback.getUTCDate();
    }
  }

  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return parsed.toISOString().slice(0, 10);
}

export function weekStart(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  const mondayOffset = (parsed.getUTCDay() + 6) % 7;
  parsed.setUTCDate(parsed.getUTCDate() - mondayOffset);
  return parsed.toISOString().slice(0, 10);
}
