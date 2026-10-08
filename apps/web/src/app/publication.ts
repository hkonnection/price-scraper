const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_BASE = 'https://github.com/hkonnection/price-scraper/actions/workflows/';

// Existing workflow schedules: twice weekly has a maximum four-day gap.
// Paused sources remain paused; links do not assert the outcome of an attempt.
const COLLECTIONS: Record<string, { workflow: string; maxAgeDays: number; paused: boolean }> = {
  costco: { workflow: 'scrape.yml', maxAgeDays: 4, paused: false },
  lululemon: { workflow: 'scrape-lululemon.yml', maxAgeDays: 4, paused: false },
  nike: { workflow: 'scrape-nike.yml', maxAgeDays: 7, paused: false },
  sportchek: { workflow: 'scrape-sportchek.yml', maxAgeDays: 7, paused: false },
  barrys: { workflow: 'scrape-barrys.yml', maxAgeDays: 7, paused: true },
  gourmetwarehouse: { workflow: 'scrape-gourmetwarehouse.yml', maxAgeDays: 4, paused: true },
  indigo: { workflow: 'scrape-indigo.yml', maxAgeDays: 4, paused: true },
  toycompany: { workflow: 'scrape-toycompany.yml', maxAgeDays: 4, paused: true },
  westcoastkids: { workflow: 'scrape-westcoastkids.yml', maxAgeDays: 4, paused: true },
  wholefoods: { workflow: 'scrape-wholefoods.yml', maxAgeDays: 7, paused: true },
};

/**
 * Read the known collection cadence and public workflow history link.
 * @param slug - Store slug; unknown and manual stores have no workflow link.
 * @returns Collection policy without contacting GitHub.
 */
export function collectionPolicy(slug: string) {
  const policy = Object.hasOwn(COLLECTIONS, slug) ? COLLECTIONS[slug] : null;
  return {
    maxAgeDays: policy?.maxAgeDays ?? null,
    paused: policy?.paused ?? false,
    historyUrl: policy ? HISTORY_BASE + policy.workflow : null,
  };
}

/**
 * Parse ISO and SQLite timestamps deterministically. Zone-less database dates are UTC.
 * @param value - Untrusted timestamp, not a substitute for the current time.
 * @returns Canonical UTC timestamp, or null for missing or invalid dates.
 */
export function normalizePublicationDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?)?$/.exec(value);
  if (!match) return null;
  const [, day, hour = '00', minute = '00', second = '00', fraction = '', zone = 'Z'] = match;
  const calendar = new Date(day + 'T00:00:00Z');
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== day) return null;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  const date = new Date(`${day}T${hour}:${minute}:${second}${fraction}${zone}`);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/**
 * Format a date identically on the server and browser, with an explicit UTC label.
 * @param value - Publication or legacy observation timestamp.
 * @returns Year, date and time in UTC, or Unknown.
 */
export function formatPublicationDate(value: unknown): string {
  const normalized = normalizePublicationDate(value);
  return normalized ? normalized.slice(0, 19).replace('T', ' ') + ' UTC' : 'Unknown';
}

/**
 * Evaluate age once using the server reference time, not the browser clock.
 * @param value - Publication timestamp.
 * @param evaluatedAt - Server request time, passed unchanged through hydration.
 * @param maxAgeDays - Maximum scheduled collection gap, or null without a cadence.
 * @returns Age label and a stale flag strictly after the age limit.
 */
export function publicationAge(value: unknown, evaluatedAt: string, maxAgeDays: number | null) {
  const published = normalizePublicationDate(value);
  const reference = normalizePublicationDate(evaluatedAt);
  if (!published || !reference) return { label: 'Age unknown', stale: false };
  const age = Date.parse(reference) - Date.parse(published);
  if (age < 0) return { label: 'Future date; age unknown', stale: false };
  const days = Math.floor(age / DAY_MS);
  return {
    label: days === 0 ? 'Less than 1 day old' : `${days} ${days === 1 ? 'day' : 'days'} old`,
    stale: maxAgeDays !== null && age > maxAgeDays * DAY_MS,
  };
}
