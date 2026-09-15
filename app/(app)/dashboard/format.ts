/**
 * Module 08 (Onboarding & Home) §8's `<p class="dash__day">Wednesday</p>` —
 * a pure formatting helper, same "no styling decisions live here" posture
 * `app/(app)/trades/format.ts` already established for this repo. Fixed to
 * UTC for the same reason `formatClockTime` (that file) is: a trader's
 * accounts can each carry a different `day_rollover`, so there is no
 * single "correct" local day-of-week to derive this from without picking
 * one account arbitrarily — this is a plain calendar label, not a
 * per-account `server_day` claim.
 */
export function formatDayOfWeek(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(now);
}

/**
 * Frame 1.14's `.rq-row__meta` slot is a single-letter direction mark
 * ("L"/"S") — 34px wide, mono, uppercase (`components.css`'s own
 * `.rq-row__meta` rule). `../trades/format.ts`'s `formatDirection`
 * ("Long"/"Short") is the wrong shape for this lane, not a different
 * claim — same real `direction` value, just abbreviated for a dense list.
 */
export function formatDirectionLetter(direction: string): string {
  return direction === 'long' ? 'L' : direction === 'short' ? 'S' : direction.slice(0, 1).toUpperCase();
}

/**
 * Frame 1.14's R-mark row (`.rq-track` + `.rq-fill`, the same primitive
 * `marks.css`'s own `.rq-rrow` documents: "left:50%" for positive,
 * "right:50%" for negative, both measured from the zero line at centre).
 * `rMultiple === null` (the stop was never known — see
 * `DashboardTradeSummary`'s own doc) renders an honest EMPTY track: no
 * `.rq-fill` at all, never a fabricated zero-width or centred bar.
 *
 * SCALE, a documented, deliberate choice (no spec-given formula, same
 * posture as `RiskGauge`'s own "fixed headroom" comment in `page.tsx`):
 * ±3R fills one full half-track. Three is picked because it is a real,
 * common outer bound for a single trade's R in this product's own worked
 * examples (`analytics-registry.md`'s "+1.3R", `findings-payload.ts`'s
 * `signedR`) — large enough that an ordinary trade's bar reads as a
 * meaningful fraction of the lane, not a hairline, while still leaving
 * room to clamp an outlier rather than let it overflow the row.
 */
const R_TRACK_SCALE = 3;

export interface RTrackFill {
  side: 'pos' | 'neg';
  /** 0-100, already clamped to the track's own half-width. */
  pct: number;
}

export function rTrackFill(rMultiple: string | null): RTrackFill | null {
  if (rMultiple === null) return null;
  const value = Number(rMultiple);
  if (!Number.isFinite(value)) return null;
  // A real, known 0.0R (breakeven) is a genuine value, not "not
  // applicable" -- kept distinguishable from the `null` case above even
  // though `pct: 0` renders the same zero-width bar either way (the
  // `side` is otherwise meaningless at exactly zero).
  const pct = Math.min(100, Math.round((Math.abs(value) / R_TRACK_SCALE) * 100));
  return { side: value >= 0 ? 'pos' : 'neg', pct };
}
