/**
 * Frame 6.9's dates: "Deletion scheduled for 21 September", "Requested
 * 14:02 · link valid for …". Fixed locale + UTC so the string is stable
 * between server render and test, and `null` whenever the timestamp
 * isn't there — the caller drops the clause rather than printing a
 * stand-in date.
 */

export function formatLongDate(iso: string | null | undefined): string | null {
  const date = parse(iso);
  if (!date) return null;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(date);
}

/** "17 Sep, 14:02 UTC" — the zone is named because it isn't the
 *  trader's own, and a bare time would read as local. */
export function formatDateTime(iso: string | null | undefined): string | null {
  const date = parse(iso);
  if (!date) return null;
  const day = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(date);
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }).format(date);
  return `${day}, ${time} UTC`;
}

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}
