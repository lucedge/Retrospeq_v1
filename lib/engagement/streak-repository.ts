import 'server-only';
import type { PoolClient } from 'pg';
import { withServiceRoleConnection, withUserConnection } from '@/lib/supabase/direct';
import { addDaysToServerDay, weekStartForServerDay } from '@/lib/rules/week-boundary';
import {
  fetchWeekCompletenessRowsInRange,
  markWeekGraceApplied,
  recomputeWeekCompleteness,
  type WeekCompletenessRecord,
} from './week-completeness-repository';

/**
 * Module 07 (Engagement) §3.5/§5.3 — the streak walk, materialised into
 * `engagement_state`. Slice 1 of Module 07, per this slice's own dispatch:
 * streak mechanism only, no `engagement_events` ledger, no XP accrual, no
 * milestones (all future Module 07 slices — see this repo's migration
 * header for the full scope note).
 *
 * ## The walk, §5.3 verbatim
 *
 * ```
 * walk weeks backwards from the current one:
 *     if week.complete            -> streak_weeks += 1
 *     else if grace available     -> apply grace, mark grace_applied, streak_weeks += 1
 *     else                        -> stop
 * ```
 *
 * "The current week counts only once complete... an in-progress week
 * neither extends nor breaks the streak" — this walk therefore NEVER
 * starts at the in-progress week. It starts at `lastCompletedWeekStart`,
 * the Monday exactly 7 days before the in-progress week's own Monday.
 * The in-progress week's own `week_completeness` row is still recomputed
 * every time (for `engagement_state.current_week_start`/
 * `current_week_complete` and Module 06's own "3 of 5 days closed out so
 * far" display), it just never contributes to `streak_weeks`.
 *
 * ## "Current" server day — a deliberately different definition from
 * Module 02's account-rollover-aware `server_day`
 *
 * `trades.server_day`/`day_closeouts.server_day` are each fixed at write
 * time against ONE account's own `day_rollover` config (00-foundation
 * §2.2) — there is no single "the trader's current day" across possibly
 * several accounts with different rollovers. The streak, however, is a
 * per-USER concept (`engagement_state.user_id`, one row per user, no
 * account dimension at all — §4's own schema). This file's own
 * `currentServerDayForNow` is therefore a plain UTC calendar date read
 * off wall-clock `now` — NOT a re-implementation of
 * `lib/ingestion/server-day.ts`'s `computeServerDay` (which needs an
 * account's rollover and answers a different, per-trade question). It
 * only ever answers "which ISO week is in progress right now", which is
 * account-agnostic by construction — a documented judgment call, not an
 * oversight.
 *
 * ## The streak floor — why the walk does not run back to the epoch
 *
 * §3.2's own literal rule ("Traded 0 days -> Also intact. Nothing was
 * owed") would, read alone, let the walk count every week since the
 * beginning of time for a user who has simply never traded — clearly not
 * the intent (a brand-new signup should never read as having an
 * already-months-long streak). This file bounds the walk at the user's
 * own `profiles.created_at` week — nothing before the week the account
 * was created can ever count toward the streak, since there is no
 * product to have "closed the loop" with before the account existed.
 * This is a genuine judgment call the spec text does not resolve
 * explicitly (flagged for PROGRESS.md's decision log, same posture as
 * `unlock-state-repository.ts`'s own `weeks_active` definition note).
 * A hard `MAX_WALK_WEEKS` safety cap below additionally bounds worst-case
 * walk length regardless (§12's own "< 200ms" streak-walk budget), purely
 * as a defensive backstop, not expected to ever bind in practice.
 *
 * ## Grace: §3.5, "one grace week per rolling quarter"
 *
 * Implemented as a literal ROLLING window (not a calendar Q1–Q4 bucket,
 * which "rolling quarter" itself explicitly distinguishes from): grace is
 * available whenever `grace_used_at` is null, or at least
 * `GRACE_ROLLING_WINDOW_DAYS` (91 — the nearest whole-day approximation
 * of a calendar quarter, 365/4) have elapsed since the last time it was
 * used. Once a grace has been SPENT on a specific week (`grace_applied =
 * true` persisted on that `week_completeness` row), it is never
 * reconsidered or revoked on a later walk — re-litigating a past grace
 * decision every time the rolling window resets would let a streak
 * DECREASE on a later recompute, which §10 explicitly forbids ("a wrong
 * streak is worse than a missing one"). Only ONE grace may be spent
 * within a single walk, regardless of the rolling-window math (a second,
 * later broken week in the same walk simply stops the walk — see
 * `decideWeekForStreak` below).
 *
 * ## Recompute timing: BEST-EFFORT, AFTER COMMIT — identical posture to
 * `adherence_weekly`/`unlock_state`
 *
 * `recomputeEngagementForConfirmations` is called from
 * `lib/ingestion/confirm.ts`'s `confirmDay`/`autoConfirmStaleTrades`
 * AFTER their own transaction has already committed, same call site
 * shape as `recomputeAdherenceWeeklyForConfirmations`/
 * `recomputeUnlockStateForConfirmations` (see those files' own headers
 * for the full "why not inside the transaction" reasoning, which applies
 * here verbatim). Never throws; each user's recompute is individually
 * try/caught and logged loudly (`docs/runbook.md`'s new "engagement
 * streak recompute failing after a confirmation" entry).
 *
 * ## §3.3's "auto-confirm does not earn streak" — how this file preserves
 * it WITHOUT special-casing the caller
 *
 * `autoConfirmStaleTrades` sets `trades.confirmed_at` but never inserts a
 * `day_closeouts` row (`lib/ingestion/confirm.ts`'s own header, "gets a
 * day_closeouts row only if the user closed it out"). Recomputing
 * `week_completeness` after an auto-confirm sweep therefore correctly
 * INCREASES `days_traded` for the affected week (the trade is now
 * confirmed) WITHOUT increasing `days_closed` (no closeout row exists) —
 * which can flip a previously-complete week to incomplete, exactly §3.3's
 * own stated consequence ("a returning trader sees broken streaks for the
 * period they were away"). This file does not need — and deliberately
 * does not add — any `confirmed_by = 'auto_7d'` filter of its own; the
 * distinction is preserved entirely by construction, by reading the same
 * two source tables §5.2 already names. Both `confirmDay` and
 * `autoConfirmStaleTrades` call this file's own recompute after their
 * commit for exactly this reason — an auto-confirm sweep can legitimately
 * BREAK a streak it never earns credit toward.
 */

// ---------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------

/** §3.5's "one grace week per rolling quarter" — 91 days, the nearest
 *  whole-day approximation of 365/4. See this file's header. */
export const GRACE_ROLLING_WINDOW_DAYS = 91;
const GRACE_ROLLING_WINDOW_MS = GRACE_ROLLING_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** Defensive safety cap only (~10 years of weeks) — see this file's
 *  header, "The streak floor". Not expected to bind in practice; the
 *  account-creation floor below is the real, intended bound. */
const MAX_WALK_WEEKS = 520;

// ---------------------------------------------------------------------
// Pure computation — no I/O, directly unit-testable
// ---------------------------------------------------------------------

/** This file's own account-agnostic "which calendar date is it right
 *  now" — see this file's header for why this is deliberately NOT
 *  `lib/ingestion/server-day.ts`'s `computeServerDay`. */
export function currentServerDayForNow(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** §3.5: grace is available when it has never been used, or the rolling
 *  window has fully elapsed since it last was. Pure, millisecond-based —
 *  no calendar-quarter boundary math (a literal "rolling" window, per
 *  this file's header). */
export function isGraceAvailable(graceUsedAt: string | null, now: Date): boolean {
  if (graceUsedAt === null) return true;
  const usedAtMs = new Date(graceUsedAt).getTime();
  return now.getTime() - usedAtMs >= GRACE_ROLLING_WINDOW_MS;
}

export interface WeekStreakInput {
  complete: boolean;
  graceApplied: boolean;
}

export type WeekStreakDecision = 'count' | 'count_with_grace' | 'stop';

/**
 * §5.3's per-week walk decision, in isolation from any I/O — directly
 * unit-testable against §8.1's own required cases ("Streak walks
 * backwards correctly across a grace week", "Grace applies once per
 * rolling quarter and no more").
 *
 * A week that is ALREADY `grace_applied = true` from a prior walk always
 * counts (`'count'`, not `'count_with_grace'`) — that grace was already
 * spent and persisted; this call is not spending a new one.
 */
export function decideWeekForStreak(week: WeekStreakInput, graceAvailableThisWalk: boolean): WeekStreakDecision {
  if (week.complete || week.graceApplied) return 'count';
  if (graceAvailableThisWalk) return 'count_with_grace';
  return 'stop';
}

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

/** Same posture as `lib/ingestion/confirm.ts`'s `ConfirmDayAccountNotFoundError`
 *  — a genuine caller bug (an unknown `userId`), never a legitimate
 *  "not enough data yet" state. Every real user has a `profiles` row from
 *  signup (`handle_new_user`), so this should never fire in practice. */
export class EngagementProfileNotFoundError extends Error {
  constructor(userId: string) {
    super(
      `streak-repository: no retrospeq.profiles row for id ${userId} -- userId must reference a real, existing user.`,
    );
    this.name = 'EngagementProfileNotFoundError';
  }
}

// ---------------------------------------------------------------------
// Recompute (write side) — service role, engagement_state/week_completeness
// have no client write path at all (this slice's own migration comment)
// ---------------------------------------------------------------------

export interface EngagementStateRecord {
  userId: string;
  streakWeeks: number;
  longestStreakWeeks: number;
  currentWeekStart: string;
  currentWeekComplete: boolean;
  totalXp: number;
  graceUsedAt: string | null;
  computedAt: string;
}

export interface RecomputeEngagementStateOptions {
  /** Testability hook, same posture as every other `now`-accepting
   *  function in this repo (`sync.ts`, `confirm.ts`). */
  now?: () => Date;
  /** Extra `server_day`s (beyond the current in-progress week, always
   *  refreshed) whose OWN week must be explicitly re-recomputed even if
   *  it already has a materialised row — used when a confirmation lands
   *  in a PAST week (e.g. a late auto-confirm) so that week's counts are
   *  refreshed rather than left stale (see this file's header, "auto-
   *  confirm does not earn streak"). Weeks not named here and not
   *  already materialised are still self-healed by the walk itself (see
   *  below) — this list only matters for weeks that already HAVE a row
   *  that needs refreshing. */
  explicitServerDays?: readonly string[];
}

interface ProfileCreatedAtRow {
  created_date: string;
}

interface PriorEngagementStateRow {
  longest_streak_weeks: number;
  grace_used_at: string | null;
}

/**
 * Computes and upserts ONE `engagement_state` row for `userId`, and along
 * the way materialises every `week_completeness` row the walk touches —
 * inside the caller-supplied connection/transaction. Reused by the
 * standalone service-role wrapper below.
 */
export async function recomputeEngagementState(
  client: PoolClient,
  userId: string,
  options: RecomputeEngagementStateOptions = {},
): Promise<EngagementStateRecord> {
  const now = options.now ? options.now() : new Date();

  const profileRes = await client.query<ProfileCreatedAtRow>(
    `select created_at::date::text as created_date from retrospeq.profiles where id = $1`,
    [userId],
  );
  const profile = profileRes.rows[0];
  if (!profile) {
    throw new EngagementProfileNotFoundError(userId);
  }
  const floorWeekStart = weekStartForServerDay(profile.created_date);

  const currentServerDay = currentServerDayForNow(now);
  const currentWeekStart = weekStartForServerDay(currentServerDay);
  const lastCompletedWeekStart = addDaysToServerDay(currentWeekStart, -7);

  // The in-progress week is ALWAYS refreshed (for
  // current_week_start/current_week_complete display) but never
  // contributes to streak_weeks -- see this file's header.
  const currentWeekRecord = await recomputeWeekCompleteness(client, userId, currentWeekStart);

  // Explicitly refresh any PAST week named by a confirmation this call is
  // responding to -- see RecomputeEngagementStateOptions.explicitServerDays.
  const explicitWeekStarts = new Set(
    (options.explicitServerDays ?? [])
      .map((serverDay) => weekStartForServerDay(serverDay))
      .filter((weekStart) => weekStart !== currentWeekStart && weekStart <= lastCompletedWeekStart),
  );
  const refreshedByWalk = new Map<string, WeekCompletenessRecord>();
  for (const weekStart of explicitWeekStarts) {
    refreshedByWalk.set(weekStart, await recomputeWeekCompleteness(client, userId, weekStart));
  }

  // Prior state (for longest_streak_weeks monotonicity and grace
  // rolling-window gating).
  const priorRes = await client.query<PriorEngagementStateRow>(
    `select longest_streak_weeks, grace_used_at::text as grace_used_at
       from retrospeq.engagement_state where user_id = $1`,
    [userId],
  );
  const prior = priorRes.rows[0];
  const priorLongestStreakWeeks = prior?.longest_streak_weeks ?? 0;
  const priorGraceUsedAt = prior?.grace_used_at ?? null;

  let graceAvailable = isGraceAvailable(priorGraceUsedAt, now);
  let graceUsedThisWalk = false;
  let streakWeeks = 0;

  if (lastCompletedWeekStart >= floorWeekStart) {
    // Batch-read already-materialised rows in range first (avoids an N+1
    // read per week for weeks that already have a row) -- explicit
    // refreshes above already overwrote their own map entries in
    // `refreshedByWalk`, which takes priority over this batch read below.
    const existing = await fetchWeekCompletenessRowsInRange(client, userId, floorWeekStart, lastCompletedWeekStart);
    for (const [weekStart, record] of refreshedByWalk) existing.set(weekStart, record);

    let weekStart = lastCompletedWeekStart;
    let iterations = 0;
    while (weekStart >= floorWeekStart && iterations < MAX_WALK_WEEKS) {
      iterations += 1;

      let record = existing.get(weekStart);
      if (!record) {
        // Genuine gap -- a week with no materialised row at all. Self-heal
        // by recomputing it for real (never assumed to be complete purely
        // from absence -- see week-completeness-repository.ts's own header
        // for why a missing row is not trusted to mean "zero activity").
        record = await recomputeWeekCompleteness(client, userId, weekStart);
        existing.set(weekStart, record);
      }

      const decision = decideWeekForStreak(
        { complete: record.complete, graceApplied: record.graceApplied },
        graceAvailable && !graceUsedThisWalk,
      );

      if (decision === 'stop') break;

      if (decision === 'count_with_grace') {
        await markWeekGraceApplied(client, userId, weekStart);
        graceUsedThisWalk = true;
        graceAvailable = false;
      }

      streakWeeks += 1;
      weekStart = addDaysToServerDay(weekStart, -7);
    }
  }

  const longestStreakWeeks = Math.max(priorLongestStreakWeeks, streakWeeks);
  const graceUsedAtParam = graceUsedThisWalk ? now.toISOString() : null;

  const res = await client.query<{ grace_used_at: string | null; computed_at: string }>(
    `insert into retrospeq.engagement_state
       (user_id, streak_weeks, longest_streak_weeks, current_week_start, current_week_complete,
        grace_used_at, computed_at)
     values ($1, $2, $3, $4, $5, $6, now())
     on conflict (user_id) do update
       set streak_weeks          = excluded.streak_weeks,
           longest_streak_weeks  = greatest(retrospeq.engagement_state.longest_streak_weeks, excluded.longest_streak_weeks),
           current_week_start    = excluded.current_week_start,
           current_week_complete = excluded.current_week_complete,
           -- Only overwritten when THIS walk actually spent a grace
           -- ($6 is null otherwise) -- never clobbers a real prior value
           -- with null (see this file's header, grace rolling-window
           -- reasoning).
           grace_used_at         = coalesce($6, retrospeq.engagement_state.grace_used_at),
           computed_at           = excluded.computed_at
       -- total_xp deliberately untouched -- this slice never writes it
       -- (see the migration's own header; the XP ledger is a future
       -- Module 07 slice).
     returning grace_used_at::text as grace_used_at, computed_at::text as computed_at`,
    [userId, streakWeeks, longestStreakWeeks, currentWeekStart, currentWeekRecord.complete, graceUsedAtParam],
  );

  const row = res.rows[0]!;
  return {
    userId,
    streakWeeks,
    longestStreakWeeks,
    currentWeekStart,
    currentWeekComplete: currentWeekRecord.complete,
    totalXp: 0, // this slice never reads/writes total_xp meaningfully -- see header
    graceUsedAt: row.grace_used_at,
    computedAt: row.computed_at,
  };
}

/** Standalone caller-facing wrapper — opens its own service-role
 *  connection/transaction, matching `recomputeAdherenceWeeklyForUser`'s
 *  own established shape. */
export async function recomputeEngagementStateForUser(
  userId: string,
  options: RecomputeEngagementStateOptions = {},
): Promise<EngagementStateRecord> {
  return withServiceRoleConnection((client) => recomputeEngagementState(client, userId, options));
}

export interface EngagementRecomputeTarget {
  userId: string;
  /** The `server_day` a confirmation touched -- bucketed to its own week
   *  internally as an EXPLICIT refresh target (see
   *  `RecomputeEngagementStateOptions.explicitServerDays`). */
  serverDay: string;
}

export interface EngagementRecomputeBatchResult {
  recomputed: string[];
  failed: { userId: string; error: unknown }[];
}

/**
 * The best-effort, after-commit half described in this file's own header.
 * Dedupes by `userId` (like `unlock-state-repository.ts`'s own batch
 * helper, not per-`(userId, weekStart)` like adherence's — a streak
 * recompute always re-walks a user's FULL recent history regardless of
 * which single week triggered it, so a sweep touching the same user
 * across many days/weeks in one call still only needs one recompute for
 * that user), while still passing every distinct `serverDay` touched so
 * each of THOSE specific weeks gets explicitly refreshed inside that one
 * recompute (see `RecomputeEngagementStateOptions.explicitServerDays`).
 *
 * NEVER THROWS. Each user's recompute is individually try/caught and
 * logged loudly (`console.error`, matching `adherence-repository.ts`'s/
 * `unlock-state-repository.ts`'s own established shape and
 * `docs/runbook.md`'s matching new entry) — a failure for one user never
 * prevents others from recomputing, and never propagates back to the
 * caller's already-committed confirmation.
 */
export async function recomputeEngagementForConfirmations(
  targets: readonly EngagementRecomputeTarget[],
): Promise<EngagementRecomputeBatchResult> {
  const serverDaysByUser = new Map<string, Set<string>>();
  for (const target of targets) {
    const set = serverDaysByUser.get(target.userId) ?? new Set<string>();
    set.add(target.serverDay);
    serverDaysByUser.set(target.userId, set);
  }

  const recomputed: string[] = [];
  const failed: { userId: string; error: unknown }[] = [];

  for (const [userId, serverDays] of serverDaysByUser) {
    try {
      await recomputeEngagementStateForUser(userId, { explicitServerDays: [...serverDays] });
      recomputed.push(userId);
    } catch (err) {
      console.error(
        `[engagement] streak recompute failed for user ${userId} -- engagement_state will read stale ` +
          `(or, for a never-yet-computed user, its signup-default all-zero) streak until the next successful ` +
          `recompute (Module 07 sec 5.3/sec 10 "ENGAGEMENT_RECOMPUTE_FAILED"; docs/runbook.md ` +
          `"engagement streak recompute failing after a confirmation"):`,
        err,
      );
      failed.push({ userId, error: err });
    }
  }

  return { recomputed, failed };
}

// ---------------------------------------------------------------------
// Read (Module 06's Part 1 consistency panel, Module 08's dashboard) —
// exposed cleanly this slice; NOT yet wired into either module's own UI
// (per this slice's own dispatch scope)
// ---------------------------------------------------------------------

export interface EngagementSummary {
  streakWeeks: number;
  longestStreakWeeks: number;
  /** The in-progress week's own materialised counts, as of the LAST
   *  recompute -- may be a few confirmations stale (see §10
   *  "ENGAGEMENT_STATE_STALE... serve stale with no indicator. A
   *  slightly old streak is harmless"), never live-recomputed at read
   *  time (matching every other materialised-cache read function in this
   *  repo, e.g. `fetchAdherenceWeekly`/`fetchUnlockState`). `daysTraded`/
   *  `daysClosed` are 0 and `complete` is `false` when
   *  `current_week_start` is still null (no recompute has ever run for
   *  this user) -- a correct "not enough data yet" reading, not an error
   *  (AGENTS.md). Matches §6's own `EngagementState.current_week` shape. */
  currentWeek: { weekStart: string | null; daysTraded: number; daysClosed: number; complete: boolean };
  /** Real column, always 0 until a future Module 07 slice builds the XP
   *  ledger -- see the migration's own header. Not a placeholder: it is
   *  the genuine, currently-always-zero value of a real DB column. */
  totalXp: number;
  computedAt: string;
}

interface EngagementStateQueryRow {
  streak_weeks: number;
  longest_streak_weeks: number;
  current_week_start: string | null;
  current_week_complete: boolean;
  total_xp: number;
  computed_at: string;
}

interface CurrentWeekActivityRow {
  days_traded: number;
  days_closed: number;
}

/**
 * Reads the MATERIALISED `engagement_state` row only — never recomputes
 * at read time (see this file's header and §10's own error-handling
 * table: "Serve last materialised state... never show a wrong streak").
 * `null` when no row has been materialised yet — should not happen for
 * any user created via `handle_new_user` from this slice's migration
 * forward (a default all-zero `engagement_state` row is created at
 * signup), but is a correct "not enough data yet" state per AGENTS.md if
 * it ever occurs for an older/backfilled row, not an error.
 *
 * Runs under `withUserConnection` (genuinely RLS-enforced against the
 * caller's own session) — `engagement_state`'s own owner-SELECT-only
 * policy is what actually narrows this, not application-layer filtering
 * alone.
 *
 * **Not yet called by any UI or Module 06/08 code in this repo** — this
 * slice's own scope is exposing the read cleanly, not wiring it in (that
 * is Module 06's own future slice, and Module 08's own dashboard slice
 * per `07-engagement.md` §1's "the dashboard streak display (Module 08
 * defines the state, this module supplies the number)" scope split).
 */
export async function fetchEngagementSummaryForUser(userId: string): Promise<EngagementSummary | null> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<EngagementStateQueryRow>(
      `select streak_weeks, longest_streak_weeks, current_week_start::text as current_week_start,
              current_week_complete, total_xp, computed_at::text as computed_at
         from retrospeq.engagement_state
        where user_id = $1`,
      [userId],
    );
    const row = res.rows[0];
    if (!row) return null;

    // A second, still purely-materialised read -- the `week_completeness`
    // row named by `engagement_state.current_week_start`, for the
    // `days_traded`/`days_closed` counts §6's own `EngagementState` type
    // requires (`engagement_state` itself only stores the boolean
    // `current_week_complete`). Absent when `current_week_start` is null
    // (no recompute has run yet for this user) -- handled as zero counts
    // below, a correct "not enough data yet" reading, not a live compute.
    let daysTraded = 0;
    let daysClosed = 0;
    if (row.current_week_start) {
      const weekRes = await client.query<CurrentWeekActivityRow>(
        `select days_traded, days_closed from retrospeq.week_completeness
          where user_id = $1 and week_start = $2`,
        [userId, row.current_week_start],
      );
      const weekRow = weekRes.rows[0];
      if (weekRow) {
        daysTraded = weekRow.days_traded;
        daysClosed = weekRow.days_closed;
      }
    }

    return {
      streakWeeks: row.streak_weeks,
      longestStreakWeeks: row.longest_streak_weeks,
      currentWeek: {
        weekStart: row.current_week_start,
        daysTraded,
        daysClosed,
        complete: row.current_week_complete,
      },
      totalXp: row.total_xp,
      computedAt: row.computed_at,
    };
  });
}
