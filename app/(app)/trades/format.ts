/**
 * Pure formatting helpers for the trade list screen (Module 02 §5.1/§5.2,
 * Slice 7a). No styling decisions live here (`.rq-num` etc is the
 * caller's job) — these functions only ever produce text, kept pure and
 * directly unit-testable, same pattern as `split-join.ts`'s own pure
 * helpers and `app/(app)/accounts/page.tsx`'s `humanizeStatus`.
 */

/**
 * `null` never becomes a fake "0.0R" — AGENTS.md's "never fake it."
 * `r_multiple` is `null` exactly when `risk_pct` is null (the stop was
 * never known at any point in the trade, Module 02 §4.4) — that is "not
 * applicable," a different honest state from Module 05's aggregate "not
 * enough data yet." Rendered as a plain dash; the caller supplies an
 * honest `title`/`aria-label` for why.
 */
export function formatRMultiple(value: string | null): string {
  if (value === null) return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  const sign = num > 0 ? '+' : '';
  return `${sign}${num.toFixed(1)}R`;
}

/** `risk_pct` is already stored as a percentage value (Module 02 §4.4's
 *  `computeTradeFacts`: `riskFraction.mul(100)`) — never re-divided by
 *  100 here. `null` means the stop was never known — "not applicable,"
 *  never a fabricated 0%. */
export function formatRiskPct(value: string | null): string {
  if (value === null) return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `${num.toFixed(1)}%`;
}

/**
 * "2h 14m" style duration since `openedAt`, for the open-position card's
 * age field (§5.2's reference markup literally shows `2h 14m`). Caps
 * output to the coarsest two units so a position open unusually long
 * reads as "3d 4h", not an absurd "4560m".
 */
export function formatAge(openedAt: string, now: Date = new Date()): string {
  const opened = new Date(openedAt);
  const ms = Math.max(0, now.getTime() - opened.getTime());
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** "09:14" — matches §5.2's reference markup's `<time>` text content
 *  exactly. Fixed to UTC: a `trades` row carries no timezone of its own
 *  beyond the owning account's `day_rollover`, which this display layer
 *  deliberately doesn't join in for a plain list view. */
export function formatClockTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  }).format(new Date(iso));
}

export function formatFillCount(count: number): string {
  return count === 1 ? '1 fill' : `${count} fills`;
}

/** Direction label — text, never colour (AGENTS.md's "no red/green
 *  anywhere, ever," which extends to long/short too: neither direction
 *  is "good" or "bad"). */
export function formatDirection(direction: string): string {
  return direction === 'long' ? 'Long' : direction === 'short' ? 'Short' : direction;
}

/**
 * UI batch 2 (frame 2.1's `.day-label`, "Wed 2 Aug") — one grouping
 * label per calendar day in the day-grouped trade list. Fixed to UTC for
 * the identical reason `formatClockTime` above already is (no single
 * "correct" local day across a trader's possibly-multiple accounts).
 * `dayKey` is the grouping key this label is derived from (kept
 * separate and pure so `page.tsx` can group first, then label the
 * group's first member once — never re-derives the boundary from a
 * different formatter's own rounding).
 */
export function formatDayLabel(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(iso));
}

export function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Frame 2.9's heading, "Close out Wednesday" — the weekday name only,
 * derived from the `server_day` (`YYYY-MM-DD`) close-out is already
 * scoped to, never a second, independently-rounded date. Treated as a
 * UTC calendar date (a bare date has no timezone of its own to be wrong
 * about).
 */
export function formatWeekdayName(day: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
}

/**
 * Frame 2.9's subhead, "3 trades · +0.9R on the day" — a real sum over
 * whichever trades on the day have a KNOWN `r_multiple`. A trade with no
 * stop ever recorded (`r_multiple: null`, "not applicable" — see
 * `formatRMultiple`'s own header) contributes nothing to the sum rather
 * than a fabricated zero; this is mathematically honest (an unknown
 * addend is omitted, not assumed to be 0), not a silently narrowed claim
 * — there is no copy anywhere that says "every trade counted".
 */
export function sumRMultiples(values: (string | null)[]): number {
  let total = 0;
  for (const value of values) {
    if (value === null) continue;
    const num = Number(value);
    if (Number.isFinite(num)) total += num;
  }
  return total;
}
