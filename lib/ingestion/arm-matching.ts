/**
 * Module 02 (Trade Ingestion & Model) §4.5 — arm-event matching.
 *
 * "An armed setup that never filled is retained, not discarded. It is the
 * dataset no competitor has." This file implements ONLY the pure
 * `match(arm, fills)` decision described by §4.5's pseudocode:
 *
 * ```
 * match(arm, fills):
 *   candidates = fills where
 *       instrument = arm.instrument
 *       AND side matches arm.direction
 *       AND role = 'entry'
 *       AND filled_at between arm.armed_at and arm.armed_at + WINDOW   (default 30 min)
 *   0 candidates and window expired  → match_state = 'never_filled'
 *   1 candidate                      → matched, captures copied onto the trade, locked
 *   >1 candidates                    → 'ambiguous', ask at close-out. NEVER guess
 * ```
 *
 * No DB access, no I/O — same posture as `grouping.ts`/`trade-facts.ts`.
 * Writing `arm_events`/`trade_captures` rows from this decision is the sync
 * pipeline's job (`sync.ts`'s Step 8 hook) and `trade-captures.ts`'s
 * `lockPreEntryCaptures` (the pre-entry lock, §4.5's second paragraph).
 *
 * ## Judgment calls made reconciling §4.5's prose into executable code
 * (00-foundation §12; flagged for PROGRESS.md's decision log)
 *
 * 1. **"candidates = fills where ... role = 'entry'" — candidate ENTRY
 *    FILLS, not candidate TRADES, but the two readings collapse to the
 *    same thing in practice and this file is written against the fill
 *    reading literally.** §4.5's own next line says "1 candidate →
 *    matched, captures copied onto the trade" — singular "the trade" only
 *    makes sense if a candidate identifies exactly one trade. Module 02
 *    §3.1's `trade_fills` table enforces `role = 'entry'` as belonging to
 *    exactly one member of exactly one trade (a trade has exactly one
 *    entry fill by definition — everything after it is `add`/`trim`/
 *    `exit`, per `grouping.ts`'s `assignRoles`), so "a candidate entry
 *    fill" and "a candidate trade, identified by its entry fill" are the
 *    same set, in 1:1 correspondence. This file's public API
 *    (`CandidateEntryFill`) therefore carries BOTH `fillId` and `tradeId`
 *    on each candidate — literal enough to satisfy the spec's own
 *    "fills where role = 'entry'" wording, but the caller (the sync
 *    pipeline) only ever needs `tradeId` to actually act on a match (copy
 *    captures onto the trade, set `arm_events.matched_trade_id`). This is
 *    a reconciliation of two compatible readings, not a deviation from
 *    either.
 * 2. **The unstated "0 candidates, window NOT YET expired" case.** §4.5
 *    only names outcomes for 0-candidates-with-expired-window
 *    (`never_filled`), 1 candidate (`matched`), and >1 candidates
 *    (`ambiguous`). It says nothing about 0 candidates while the window is
 *    still open. The obvious reading, consistent with `arm_events`'
 *    own `match_state` default (`'pending'`, Module 02 §3.1's DDL) and
 *    00-foundation §6.2's silence principle ("when [a decision] cannot be
 *    determined... remains unconfirmed rather than being force-[decided]"):
 *    **no state change — stays `pending`.** A fill may still land before
 *    the window closes; declaring `never_filled` early would be a false
 *    negative on the exact dataset §4.5 calls out as uniquely valuable.
 *    This file's `matchArmEvent` returns `{ state: 'pending' }` for this
 *    case; the caller is expected to no-op the `arm_events` row (leave
 *    `match_state` alone) rather than write anything.
 * 3. **Window boundary is inclusive on both ends** — "between arm.armed_at
 *    and arm.armed_at + WINDOW" is read as a closed interval
 *    (`armed_at <= filled_at <= armed_at + WINDOW`), matching this repo's
 *    existing convention for closed-interval "between" language
 *    elsewhere (`sync.ts`'s `detectCoverageGap` doc comment reasons about
 *    "any positive gap" the same conservative way). A fill landing at
 *    exactly `armed_at` (the same instant the setup was armed) or at
 *    exactly the window's own edge both count as candidates, never
 *    excluded by an off-by-one.
 * 4. **"side matches arm.direction"** uses the SAME buy→long / sell→short
 *    mapping `trade-facts.ts`'s `direction` fact already uses
 *    (`first.side === 'buy' ? 'long' : 'short'`) — one canonical mapping,
 *    not a second parallel definition. See `sideMatchesDirection` below.
 * 5. **`WINDOW` default 30 min**, overridable via `windowMs` — §4.5's own
 *    literal "(default 30 min)".
 *
 * ## The `never_filled` sweep — NOT part of `matchArmEvent`
 *
 * `matchArmEvent` only ever evaluates candidates that already exist at
 * call time. Detecting "window has now expired with zero candidates ever
 * having appeared" for an `arm_events` row that receives NO new candidate
 * fills at all (so nothing ever calls `matchArmEvent` for it again) is a
 * separate, time-based condition — `isArmEventExpired` below is the pure
 * helper for that sweep; the DB-side sweep itself lives in `sync.ts`
 * (§4.1's per-sync hook), not here.
 */

export type ArmDirection = 'long' | 'short';
export type ArmFillSide = 'buy' | 'sell';

/** §4.5's default WINDOW — 30 minutes, in milliseconds. */
export const DEFAULT_ARM_MATCH_WINDOW_MS = 30 * 60 * 1000;

/** The minimal shape `matchArmEvent` needs from an `arm_events` row. */
export interface ArmEventForMatching {
  instrument: string;
  direction: ArmDirection;
  /** ISO-8601 timestamptz. */
  armedAt: string;
}

/**
 * The minimal shape `matchArmEvent` needs from a candidate ENTRY fill —
 * i.e. a `fills` row with a `trade_fills.role = 'entry'` row pointing at
 * it (or, equivalently, a `trade_events` row of `kind = 'entry'` for an
 * ADR-0001 flip-opened trade — see judgment call #1: either way, one
 * `tradeId` per candidate). Callers (the sync pipeline) are responsible
 * for the DB query that produces exactly this filtered set; this file
 * does not know how a "role = entry" fill is derived.
 */
export interface CandidateEntryFill {
  fillId: string;
  tradeId: string;
  instrument: string;
  side: ArmFillSide;
  /** ISO-8601 timestamptz. */
  filledAt: string;
}

export type ArmMatchResult =
  | { state: 'matched'; tradeId: string; fillId: string }
  | {
      state: 'ambiguous';
      /** Deduplicated, sorted by (filledAt, fillId) for deterministic output. */
      candidateTradeIds: string[];
      candidateFillIds: string[];
    }
  | { state: 'never_filled' }
  | { state: 'pending' };

/** Judgment call #4 — the one canonical buy/sell <-> long/short mapping, matching `trade-facts.ts`'s `direction` fact. */
export function sideMatchesDirection(side: ArmFillSide, direction: ArmDirection): boolean {
  return (side === 'buy' && direction === 'long') || (side === 'sell' && direction === 'short');
}

function compareCandidates(a: CandidateEntryFill, b: CandidateEntryFill): number {
  const delta = new Date(a.filledAt).getTime() - new Date(b.filledAt).getTime();
  if (delta !== 0) return delta;
  return a.fillId < b.fillId ? -1 : a.fillId > b.fillId ? 1 : 0;
}

/**
 * §4.5's `match(arm, fills)`. `entryFills` should already be filtered to
 * `role = 'entry'` fills by the caller (judgment call #1) — this function
 * additionally filters on instrument/direction/window itself, since that
 * IS the matching logic. `now` drives the `pending` vs `never_filled`
 * distinction (judgment call #2) and must be supplied explicitly (no
 * implicit `new Date()` — same testability posture as `sync.ts`'s own
 * `RunSyncOptions.now`).
 */
export function matchArmEvent(
  arm: ArmEventForMatching,
  entryFills: readonly CandidateEntryFill[],
  now: Date,
  windowMs: number = DEFAULT_ARM_MATCH_WINDOW_MS,
): ArmMatchResult {
  const armedAt = new Date(arm.armedAt);
  const windowEnd = new Date(armedAt.getTime() + windowMs);

  // Judgment call #3 — closed interval on both ends.
  const candidates = entryFills
    .filter((f) => f.instrument === arm.instrument)
    .filter((f) => sideMatchesDirection(f.side, arm.direction))
    .filter((f) => {
      const t = new Date(f.filledAt).getTime();
      return t >= armedAt.getTime() && t <= windowEnd.getTime();
    })
    .slice()
    .sort(compareCandidates);

  if (candidates.length === 1) {
    return { state: 'matched', tradeId: candidates[0].tradeId, fillId: candidates[0].fillId };
  }

  if (candidates.length > 1) {
    const candidateTradeIds = [...new Set(candidates.map((c) => c.tradeId))];
    return {
      state: 'ambiguous',
      candidateTradeIds,
      candidateFillIds: candidates.map((c) => c.fillId),
    };
  }

  // Zero candidates -- judgment call #2.
  if (now.getTime() >= windowEnd.getTime()) {
    return { state: 'never_filled' };
  }
  return { state: 'pending' };
}

/**
 * Pure predicate for the `never_filled` sweep (see this file's header —
 * the DB-side sweep itself is `sync.ts`'s job). True once `now` is at or
 * past `arm.armedAt + windowMs`, regardless of candidates — callers only
 * invoke this for an `arm_events` row that is STILL `match_state =
 * 'pending'` with zero candidates found this run.
 */
export function isArmEventExpired(arm: ArmEventForMatching, now: Date, windowMs: number = DEFAULT_ARM_MATCH_WINDOW_MS): boolean {
  const windowEnd = new Date(new Date(arm.armedAt).getTime() + windowMs);
  return now.getTime() >= windowEnd.getTime();
}
