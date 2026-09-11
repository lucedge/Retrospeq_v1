import 'server-only';
import type { PoolClient } from 'pg';
import { withServiceRoleConnection } from '@/lib/supabase/direct';
import { weekEndForServerDay, weekStartForServerDay } from '@/lib/rules/week-boundary';

/**
 * Module 07 (Engagement) §5.2 — the `week_completeness` materialisation.
 * The table itself was migrated in this slice's own
 * `supabase/migrations/20260911030000_engagement_streak_schema.sql` — this
 * file is the first code that reads/writes it.
 *
 * **This file deliberately imports `lib/rules/week-boundary.ts` and
 * NOTHING else from `lib/rules/`.** `week-boundary.ts` is a generic
 * calendar utility (ADR 0015) this slice's own dispatch explicitly
 * instructed reusing "exactly" so Module 07's week bucketing can never
 * silently disagree with `adherence_weekly`'s — it carries no rule,
 * evaluation, or adherence logic. Module 07 §4.1/§11's own "no dependency
 * on Module 04 or 05, and the absence should be visible" instruction is
 * about NOT importing `lib/rules/adherence-repository.ts` or any rule/
 * evaluation-bearing module — this file (and `streak-repository.ts`)
 * never does.
 *
 * ## §5.2's formula, verbatim
 *
 * ```
 * days_traded = distinct server_day with >= 1 confirmed trade
 * days_closed = distinct server_day with a day_closeouts row
 *               (including deliberate_no_trade)
 * complete    = (days_traded == 0) OR (days_closed >= days_traded)
 * ```
 *
 * `days_traded` reads `retrospeq.trades` where `confirmed_at is not null`
 * — the Module 02 §4.6 freeze point, matching `unlock-state-
 * repository.ts`'s own `fetchConfirmedTradesForUnlock` precedent exactly
 * (a trade only counts once it's actually been reviewed/frozen, not
 * merely closed). `days_closed` reads `retrospeq.day_closeouts` directly
 * — every row in that table (§4.6: "gets a day_closeouts row only if the
 * user closed it out") already represents a closed-out day of EITHER
 * kind (`traded` or `deliberate_no_trade`), so no `kind` filter is
 * needed to satisfy "(including deliberate_no_trade)".
 *
 * ## Why this file never checks `days_closed <= days_traded`
 *
 * Unlike `unlock_state`'s `trades_with_captures <= trades_confirmed`
 * invariant, that relationship does NOT hold here by construction — a
 * week with three deliberate no-trade closeouts and zero traded days has
 * `days_closed = 3, days_traded = 0`, both real and both larger-on-one-
 * side-than-the-other than the unlock_state case. The migration's own
 * `week_completeness` table therefore carries no such CHECK constraint —
 * see that file's header for the full reasoning.
 *
 * ## Recompute is idempotent and preserves `grace_applied`
 *
 * `recomputeWeekCompleteness` ALWAYS re-derives `days_traded`/
 * `days_closed`/`complete` fresh from `trades`/`day_closeouts` (never an
 * incremental delta — same "self-healing materialised cache" shape
 * `unlock-state-repository.ts`'s own header establishes) but NEVER
 * touches `grace_applied` on an existing row (omitted from the `ON
 * CONFLICT ... DO UPDATE SET` list entirely) — `grace_applied` is owned
 * exclusively by `streak-repository.ts`'s own streak walk, a decision
 * made once and never revisited (§10: "a wrong streak is worse than a
 * missing one" — once a grace has been spent on a week, that week must
 * keep counting toward the streak even if this file's own recompute
 * later re-touches the row for an unrelated reason, e.g. a late-arriving
 * trade in that same week).
 */

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

export class InvalidWeekStartError extends Error {
  constructor(weekStart: string) {
    super(
      `week-completeness-repository: "${weekStart}" is not an ISO week start (Monday) -- callers must pass ` +
        `weekStartForServerDay(serverDay)'s own output, never an arbitrary date (lib/rules/week-boundary.ts, ADR 0015).`,
    );
    this.name = 'InvalidWeekStartError';
  }
}

/** Same guard `lib/rules/adherence-repository.ts` already establishes for
 *  the identical class of caller mistake — duplicated rather than
 *  imported from that file, deliberately (see this file's header: no
 *  dependency on Module 04's own rule/adherence code, even for a
 *  two-line helper). */
export function assertCanonicalWeekStart(weekStart: string): void {
  if (weekStartForServerDay(weekStart) !== weekStart) {
    throw new InvalidWeekStartError(weekStart);
  }
}

// ---------------------------------------------------------------------
// Pure computation — no I/O, directly unit-testable
// ---------------------------------------------------------------------

export interface WeekActivityCounts {
  daysTraded: number;
  daysClosed: number;
}

export interface WeekCompletenessCounts extends WeekActivityCounts {
  complete: boolean;
}

/** §5.2's formula, applied to already-counted `daysTraded`/`daysClosed`
 *  values — separated from the SQL fetch below purely for direct unit
 *  testability, same posture as every other `compute*` function in this
 *  repo's `*-repository.ts` files. */
export function computeWeekCompleteness(counts: WeekActivityCounts): WeekCompletenessCounts {
  const complete = counts.daysTraded === 0 || counts.daysClosed >= counts.daysTraded;
  return { daysTraded: counts.daysTraded, daysClosed: counts.daysClosed, complete };
}

// ---------------------------------------------------------------------
// Recompute (write side) — service role, week_completeness has no client
// write path at all (this slice's own migration comment)
// ---------------------------------------------------------------------

export interface WeekCompletenessRecord {
  userId: string;
  weekStart: string;
  daysTraded: number;
  daysClosed: number;
  complete: boolean;
  graceApplied: boolean;
  computedAt: string;
}

interface WeekActivityCountsRow {
  days_traded: string | number;
  days_closed: string | number;
}

/** One scoped query, two scalar subqueries in a single round trip —
 *  matches `adherence-repository.ts`'s own "< 500ms per week, no N+1"
 *  budget posture. Exported separately from `recomputeWeekCompleteness`
 *  purely for direct unit testability against a mocked `client.query`. */
export async function fetchWeekActivityCounts(
  client: PoolClient,
  userId: string,
  weekStart: string,
): Promise<WeekActivityCounts> {
  assertCanonicalWeekStart(weekStart);
  const weekEnd = weekEndForServerDay(weekStart);
  const res = await client.query<WeekActivityCountsRow>(
    `select
       (select count(distinct server_day) from retrospeq.trades
         where user_id = $1 and confirmed_at is not null and server_day between $2 and $3) as days_traded,
       (select count(distinct server_day) from retrospeq.day_closeouts
         where user_id = $1 and server_day between $2 and $3) as days_closed`,
    [userId, weekStart, weekEnd],
  );
  const row = res.rows[0]!;
  return { daysTraded: Number(row.days_traded), daysClosed: Number(row.days_closed) };
}

interface WeekCompletenessQueryRow {
  days_traded: number;
  days_closed: number;
  complete: boolean;
  grace_applied: boolean;
  computed_at: string;
}

/**
 * Computes and upserts ONE `week_completeness` row for `(userId,
 * weekStart)`, inside the caller-supplied connection/transaction —
 * reused by the standalone service-role wrapper below and by
 * `streak-repository.ts`'s own streak walk (which calls this directly,
 * same client, to self-heal a week that has no materialised row yet —
 * see that file's header).
 */
export async function recomputeWeekCompleteness(
  client: PoolClient,
  userId: string,
  weekStart: string,
): Promise<WeekCompletenessRecord> {
  assertCanonicalWeekStart(weekStart);

  const activity = await fetchWeekActivityCounts(client, userId, weekStart);
  const counts = computeWeekCompleteness(activity);

  const res = await client.query<WeekCompletenessQueryRow>(
    `insert into retrospeq.week_completeness
       (user_id, week_start, days_traded, days_closed, complete, grace_applied, computed_at)
     values ($1, $2, $3, $4, $5, false, now())
     on conflict (user_id, week_start) do update
       set days_traded = excluded.days_traded,
           days_closed = excluded.days_closed,
           complete    = excluded.complete,
           computed_at = excluded.computed_at
       -- grace_applied deliberately OMITTED from this SET list -- see
       -- this file's header, "Recompute is idempotent and preserves
       -- grace_applied".
     returning days_traded, days_closed, complete, grace_applied, computed_at::text as computed_at`,
    [userId, weekStart, counts.daysTraded, counts.daysClosed, counts.complete],
  );

  const row = res.rows[0]!;
  return {
    userId,
    weekStart,
    daysTraded: row.days_traded,
    daysClosed: row.days_closed,
    complete: row.complete,
    graceApplied: row.grace_applied,
    computedAt: row.computed_at,
  };
}

/** Standalone caller-facing wrapper — opens its own service-role
 *  connection/transaction, matching `recomputeAdherenceWeeklyForUser`'s
 *  own established shape. Not used by `streak-repository.ts` itself
 *  (which always passes its own already-open `client` so the whole
 *  streak walk stays inside one transaction), but available for any
 *  future one-off recompute need. */
export async function recomputeWeekCompletenessForUser(
  userId: string,
  weekStart: string,
): Promise<WeekCompletenessRecord> {
  return withServiceRoleConnection((client) => recomputeWeekCompleteness(client, userId, weekStart));
}

/**
 * Marks an EXISTING `week_completeness` row as grace-applied — the one
 * write `streak-repository.ts`'s own walk makes to this table that is
 * NOT a full recompute (§3.5: grace is a streak-walk-time decision, never
 * re-derived from `trades`/`day_closeouts`). Callers MUST have already
 * ensured the row exists (via `recomputeWeekCompleteness`) before calling
 * this — it updates, never inserts.
 */
export async function markWeekGraceApplied(client: PoolClient, userId: string, weekStart: string): Promise<void> {
  assertCanonicalWeekStart(weekStart);
  await client.query(
    `update retrospeq.week_completeness
        set grace_applied = true
      where user_id = $1 and week_start = $2`,
    [userId, weekStart],
  );
}

/**
 * Batch-reads already-materialised `week_completeness` rows in
 * `[fromWeekStart, toWeekStart]` (inclusive), keyed by `week_start` — used
 * by `streak-repository.ts`'s walk to avoid an N+1 read per week for
 * weeks that already have a row, before falling back to
 * `recomputeWeekCompleteness` (a write) only for genuine gaps.
 */
export async function fetchWeekCompletenessRowsInRange(
  client: PoolClient,
  userId: string,
  fromWeekStart: string,
  toWeekStart: string,
): Promise<Map<string, WeekCompletenessRecord>> {
  assertCanonicalWeekStart(fromWeekStart);
  assertCanonicalWeekStart(toWeekStart);
  const res = await client.query<{ week_start: string } & WeekCompletenessQueryRow>(
    `select week_start::text as week_start, days_traded, days_closed, complete, grace_applied,
            computed_at::text as computed_at
       from retrospeq.week_completeness
      where user_id = $1 and week_start between $2 and $3`,
    [userId, fromWeekStart, toWeekStart],
  );
  const map = new Map<string, WeekCompletenessRecord>();
  for (const row of res.rows) {
    map.set(row.week_start, {
      userId,
      weekStart: row.week_start,
      daysTraded: row.days_traded,
      daysClosed: row.days_closed,
      complete: row.complete,
      graceApplied: row.grace_applied,
      computedAt: row.computed_at,
    });
  }
  return map;
}
