import 'server-only';
import type { PoolClient } from 'pg';
import { withServiceRoleConnection, withUserConnection } from '@/lib/supabase/direct';
import { weekEndForServerDay, weekStartForServerDay } from './week-boundary';

/**
 * Module 04 (Rulebook & Evaluation) §5.6 / §3.1 — Slice 6: the
 * `adherence_weekly` materialisation. `adherence_weekly` itself was already
 * migrated in Slice 1 (`supabase/migrations/20260823020000_rulebook_schema.sql`)
 * with its own "owner SELECT only, no client write path" RLS shape — this
 * file is the FIRST code that actually reads/writes it.
 *
 * ## The only input: frozen `rule_evaluations`
 *
 * §5.6, verbatim:
 * ```
 * hard_total     = count(evaluations where severity='hard' and result != 'not_applicable')
 * hard_followed  = count(... and result = 'followed')
 * soft_total     = same for soft
 * ```
 * `not_applicable` drops out of BOTH numerator and denominator — not
 * counted as followed (would inflate) and not counted as broken (would be
 * unfair). `rule_evaluations` rows are frozen once, at close-out
 * confirmation (`lib/rules/freeze-evaluations.ts`, Slice 5) and never
 * recomputed retroactively (AGENTS.md non-negotiable) — this file reads
 * that table and NOTHING else as its source of truth. It never calls
 * `evaluate()` and never touches `rules`/`rule_versions` beyond storing a
 * bare `rule_id` (see "name-agnostic" note below).
 *
 * ## Week boundary: `lib/rules/week-boundary.ts`, and only that file
 *
 * A `rule_evaluations` row's `server_day` determines which week it
 * belongs to, via `weekStartForServerDay`/`weekEndForServerDay` — the
 * repo's ONE week-boundary definition (ADR 0015). Every `weekStart` this
 * file accepts as a parameter MUST already be a canonical Monday
 * week-start (i.e. `weekStartForServerDay(weekStart) === weekStart`) —
 * enforced by `assertCanonicalWeekStart` below, a loud thrown error, not a
 * silent re-derivation, so a caller can never accidentally materialise a
 * row keyed on a non-Monday date.
 *
 * ## `top_break_rule_id` scope: HARD-PRIORITY, never a blended pool
 *
 * **Reconciled against `retrospeq-design-decisions.md` §6 ("Two numbers,
 * never one"), 2026-08-25 — retrospeq-qa flagged the original COMBINED
 * implementation as a real design-intent violation; per AGENTS.md's
 * "spec vs design-decisions doc -> design doc wins" convention, this file
 * now defers to the design doc over §5.6's own looser wording.** §6,
 * verbatim: *"A weighted blend hides exactly what should be visible. Hard
 * rules should be few enough that '34 of 34' is the normal reading and
 * any deviation is loud."* Soft rules are broken far more often than hard
 * ones BY DESIGN (§6's own hard/soft split, "Hard rules: 34 of 34. Soft:
 * 88 of 102."), so a combined ranked pool means a rare, important hard-rule
 * breach can get numerically buried under a much more common soft-rule
 * violation — exactly the failure story 3.3 names directly: "a risk
 * breach doesn't read like a skipped checkbox." §5.6's own "31 of 34
 * rules... with drops attributed to a single named rule" line is NOT
 * itself a counterexample once read against §6: it describes the
 * denominator (every active rule counts toward the headline fraction,
 * regardless of severity) not the top-break SELECTION pool, and §6.1's
 * own worked attribution example — *"Your risk cap accounts for 6 of the
 * 14 soft breaks"* — scopes the attribution number within the SOFT
 * population specifically (14 matches a soft-only broken count, not a
 * combined hard+soft total), confirming per-severity-scoped attribution
 * is the design doc's own standalone pattern, not merely a fallback this
 * file invented.
 *
 * Implemented as: group `result = 'broken'` evaluations into TWO separate
 * per-rule pools by severity (hard, soft) first. If the hard pool is
 * non-empty, the top break is drawn from the hard pool ONLY — a hard
 * breach, however outnumbered by soft breaks, always wins the naming
 * slot. Only when the hard pool is EMPTY (zero hard breaks that week)
 * does selection fall back to the soft pool — chosen over falling back to
 * a re-combined pool because §6.1's worked example treats soft-scoped
 * attribution as a real, standalone reading in its own right, not a
 * last-resort blend; a combined fallback would reintroduce the exact
 * blending §6 rejects, just conditionally instead of always.
 *
 * **Tie-break (deterministic, not left to Map/array iteration order),
 * applied WITHIN whichever pool (hard, or soft on fallback) was selected:**
 * highest broken count wins; a tie is broken by the EARLIEST `frozen_at`
 * among the tied rules' own broken evaluations (the rule that started
 * breaking first in the week reads as more informative to name than one
 * whose breaks all landed later); a further tie (two rules whose earliest
 * break landed at the exact same instant — practically only possible for
 * two evaluations frozen in the very same confirm-transaction batch) is
 * broken by `rule_id` ascending, purely for total determinism. See
 * `computeAdherenceWeekCounts`'s own implementation (`pickTopBreak`).
 *
 * ## This table is deliberately NAME-AGNOSTIC
 *
 * `top_break_rule_id` stores only the id — never the rule's rendered
 * sentence or name. Resolving that id to display text is a later read-side
 * join (Module 06's own concern, once it exists), same posture
 * `rule_evaluations` itself already takes (severity is copied at freeze,
 * but the evaluation row never denormalises the rule's own display text).
 *
 * ## Recompute timing: BEST-EFFORT, AFTER COMMIT — not inside the confirm
 * transaction
 *
 * `adherence_weekly` is a materialised CACHE derived from `rule_evaluations`
 * (the trust-sensitive record, which is ALREADY frozen atomically inside
 * `confirm.ts`'s own transaction by Slice 5's `evaluateAndFreezeTradeRules`)
 * — not itself the source of truth. That is exactly the same shape
 * `operand_distributions` already established in this module
 * (`distributions-repository.ts`'s own header): a precomputed, idempotent
 * cache where a partial/failed recompute leaves the reader with STALE
 * numbers until the next successful recompute, never CORRUPTED or
 * double-counted ones (each `(user_id, week_start)` row is an independent
 * upsert that fully overwrites itself in place). Recomputing inside
 * `confirm.ts`'s own transaction was considered and rejected: `confirmDay`
 * is Module 02's single most safety-critical transaction (its own header:
 * "after it sets confirmed_at ... rule evaluations are immutable"), and
 * `autoConfirmStaleTrades` in particular can span many accounts/users/days
 * in ONE sweep — adding a materialisation write for every distinct
 * `(user_id, week)` pair touched inside that same transaction would grow
 * its lock duration in proportion to sweep size for a value that is, by
 * its own table comment, allowed to be "materialised on a schedule," not
 * synchronously consistent with the freeze that produced it. Matching
 * `distributions-repository.ts`'s own call site in `sync.ts` (awaited,
 * try/caught, logged loudly on failure, NEVER allowed to turn an already-
 * committed confirmation into a reported failure) — see
 * `recomputeAdherenceWeeklyForConfirmations` below, wired into
 * `lib/ingestion/confirm.ts` AFTER each transaction commits.
 *
 * **Known gap, not built here (already tracked, `docs/runbook.md` /
 * PROGRESS.md "Infra gaps"):** no real cron/scheduler infra exists in this
 * repo, so there is no independent nightly "recompute every trader's
 * current week regardless of confirmation activity" job. Until one exists,
 * a confirm/auto-confirm call is the ONLY way a trader's `adherence_weekly`
 * row gets refreshed — a week with zero NEW confirmations after a prior
 * recompute simply keeps its last-computed numbers (correct, not stale in
 * the sense of being wrong, just not re-touched, matching
 * `operand_distributions`'s identical situation).
 */

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

export class InvalidWeekStartError extends Error {
  constructor(weekStart: string) {
    super(
      `adherence-repository: "${weekStart}" is not an ISO week start (Monday) -- callers must pass ` +
        `weekStartForServerDay(serverDay)'s own output, never an arbitrary date (lib/rules/week-boundary.ts, ADR 0015).`,
    );
    this.name = 'InvalidWeekStartError';
  }
}

function assertCanonicalWeekStart(weekStart: string): void {
  if (weekStartForServerDay(weekStart) !== weekStart) {
    throw new InvalidWeekStartError(weekStart);
  }
}

// ---------------------------------------------------------------------
// Pure computation — no I/O, directly unit-testable
// ---------------------------------------------------------------------

export interface AdherenceEvaluationRow {
  ruleId: string;
  severity: 'soft' | 'hard';
  result: 'followed' | 'broken' | 'not_applicable';
  /** ISO-8601 string (this repo's own timestamptz convention, see
   *  `lib/supabase/pg-type-parsers.ts`) — used only for the top-break
   *  tie-break, never parsed as a `Date`. */
  frozenAt: string;
}

export interface AdherenceWeekCounts {
  hardFollowed: number;
  hardTotal: number;
  softFollowed: number;
  softTotal: number;
  topBreakRuleId: string | null;
  topBreakCount: number | null;
}

/** Applies this file's one deterministic tie-break (highest count ->
 *  earliest `frozen_at` -> lowest `rule_id`) WITHIN a single per-rule
 *  broken-count pool. Shared by both the hard-pool and soft-pool
 *  selection passes in `computeAdherenceWeekCounts` below so the
 *  tie-break itself is defined exactly once, not duplicated per pool. */
function pickTopBreak(
  brokenByRule: ReadonlyMap<string, { count: number; earliestFrozenAt: string }>,
): { ruleId: string; count: number; earliestFrozenAt: string } | null {
  let best: { ruleId: string; count: number; earliestFrozenAt: string } | null = null;
  for (const [ruleId, { count, earliestFrozenAt }] of brokenByRule) {
    const isBetter =
      best === null ||
      count > best.count ||
      (count === best.count && earliestFrozenAt < best.earliestFrozenAt) ||
      (count === best.count && earliestFrozenAt === best.earliestFrozenAt && ruleId < best.ruleId);
    if (isBetter) {
      best = { ruleId, count, earliestFrozenAt };
    }
  }
  return best;
}

/**
 * §5.6's core computation, applied to one week's already-fetched
 * `rule_evaluations` rows. Plain integer counting — no `decimal.js`
 * needed (these are counts, not money/percentage-derived decimals, per
 * this slice's own dispatch).
 */
export function computeAdherenceWeekCounts(rows: readonly AdherenceEvaluationRow[]): AdherenceWeekCounts {
  let hardFollowed = 0;
  let hardTotal = 0;
  let softFollowed = 0;
  let softTotal = 0;

  // Two SEPARATE pools, never merged -- see this file's own header
  // ("`top_break_rule_id` scope: HARD-PRIORITY, never a blended pool").
  const hardBrokenByRule = new Map<string, { count: number; earliestFrozenAt: string }>();
  const softBrokenByRule = new Map<string, { count: number; earliestFrozenAt: string }>();

  for (const row of rows) {
    // §5.6: not_applicable drops out of BOTH numerator and denominator.
    if (row.result === 'not_applicable') continue;

    const isHard = row.severity === 'hard';
    if (isHard) hardTotal += 1;
    else softTotal += 1;

    if (row.result === 'followed') {
      if (isHard) hardFollowed += 1;
      else softFollowed += 1;
      continue;
    }

    // result === 'broken' -- accumulate per-rule count + earliest break
    // instant, scoped to this row's own severity pool, for the top-break
    // tie-break (see this file's own header).
    const brokenByRule = isHard ? hardBrokenByRule : softBrokenByRule;
    const existing = brokenByRule.get(row.ruleId);
    if (!existing) {
      brokenByRule.set(row.ruleId, { count: 1, earliestFrozenAt: row.frozenAt });
    } else {
      existing.count += 1;
      if (row.frozenAt < existing.earliestFrozenAt) existing.earliestFrozenAt = row.frozenAt;
    }
  }

  // Hard-priority: a hard breach always wins the naming slot over any
  // number of soft breaks. Only fall back to the soft pool when zero
  // hard breaks occurred this week -- see this file's own header for why
  // the fallback is soft-scoped, not a re-combined pool.
  const best = pickTopBreak(hardBrokenByRule) ?? pickTopBreak(softBrokenByRule);

  return {
    hardFollowed,
    hardTotal,
    softFollowed,
    softTotal,
    topBreakRuleId: best?.ruleId ?? null,
    topBreakCount: best?.count ?? null,
  };
}

// ---------------------------------------------------------------------
// Recompute (write side) — service role, adherence_weekly has no client
// write path at all (Slice 1's own migration comment)
// ---------------------------------------------------------------------

export interface AdherenceWeeklyRecord {
  userId: string;
  weekStart: string;
  hardFollowed: number;
  hardTotal: number;
  softFollowed: number;
  softTotal: number;
  topBreakRuleId: string | null;
  topBreakCount: number | null;
  computedAt: string;
}

interface EvaluationQueryRow {
  rule_id: string;
  severity: 'soft' | 'hard';
  result: 'followed' | 'broken' | 'not_applicable';
  frozen_at: string;
}

/** One scoped query, `(user_id, server_day between weekStart and weekEnd)`
 *  -- §12's "< 500ms per week" budget, a single round trip, no N+1 per
 *  rule. Exported separately from `recomputeAdherenceWeekly` purely for
 *  direct unit testability against a mocked `client.query`. */
export async function fetchAdherenceEvaluationRowsForWeek(
  client: PoolClient,
  userId: string,
  weekStart: string,
): Promise<AdherenceEvaluationRow[]> {
  assertCanonicalWeekStart(weekStart);
  const weekEnd = weekEndForServerDay(weekStart);
  const res = await client.query<EvaluationQueryRow>(
    `select rule_id, severity, result, frozen_at::text as frozen_at
       from retrospeq.rule_evaluations
      where user_id = $1
        and server_day between $2 and $3`,
    [userId, weekStart, weekEnd],
  );
  return res.rows.map((row) => ({
    ruleId: row.rule_id,
    severity: row.severity,
    result: row.result,
    frozenAt: row.frozen_at,
  }));
}

/**
 * Computes and upserts ONE `adherence_weekly` row for `(userId, weekStart)`,
 * inside the caller-supplied connection/transaction (`client`) — reused by
 * both the standalone service-role wrapper below and, if a future caller
 * genuinely needs it inside an existing transaction, directly.
 */
export async function recomputeAdherenceWeekly(
  client: PoolClient,
  userId: string,
  weekStart: string,
): Promise<AdherenceWeeklyRecord> {
  assertCanonicalWeekStart(weekStart);

  const rows = await fetchAdherenceEvaluationRowsForWeek(client, userId, weekStart);
  const counts = computeAdherenceWeekCounts(rows);

  const res = await client.query<{ computed_at: string }>(
    `insert into retrospeq.adherence_weekly
       (user_id, week_start, hard_followed, hard_total, soft_followed, soft_total, top_break_rule_id, top_break_count, computed_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now())
     on conflict (user_id, week_start) do update
       set hard_followed     = excluded.hard_followed,
           hard_total        = excluded.hard_total,
           soft_followed     = excluded.soft_followed,
           soft_total        = excluded.soft_total,
           top_break_rule_id = excluded.top_break_rule_id,
           top_break_count   = excluded.top_break_count,
           computed_at       = excluded.computed_at
     returning computed_at::text as computed_at`,
    [
      userId,
      weekStart,
      counts.hardFollowed,
      counts.hardTotal,
      counts.softFollowed,
      counts.softTotal,
      counts.topBreakRuleId,
      counts.topBreakCount,
    ],
  );

  return {
    userId,
    weekStart,
    hardFollowed: counts.hardFollowed,
    hardTotal: counts.hardTotal,
    softFollowed: counts.softFollowed,
    softTotal: counts.softTotal,
    topBreakRuleId: counts.topBreakRuleId,
    topBreakCount: counts.topBreakCount,
    computedAt: res.rows[0]!.computed_at,
  };
}

/** Standalone caller-facing wrapper — opens its own service-role
 *  connection/transaction. Used by the best-effort batch helper below,
 *  and available directly for any future one-off recompute (e.g. an
 *  eventual nightly job, see this file's own header re: the tracked cron
 *  infra gap). */
export async function recomputeAdherenceWeeklyForUser(
  userId: string,
  weekStart: string,
): Promise<AdherenceWeeklyRecord> {
  return withServiceRoleConnection((client) => recomputeAdherenceWeekly(client, userId, weekStart));
}

export interface AdherenceRecomputeTarget {
  userId: string;
  /** Any `server_day` inside the week to recompute -- bucketed via
   *  `weekStartForServerDay` internally, so callers pass the trade's own
   *  `server_day`, never a pre-derived week start. */
  serverDay: string;
}

export interface AdherenceRecomputeBatchResult {
  recomputed: { userId: string; weekStart: string }[];
  failed: { userId: string; weekStart: string; error: unknown }[];
}

/**
 * The best-effort, after-commit half described in this file's own header.
 * Dedupes `(userId, weekStart)` pairs derived from `targets` (a
 * `confirmDay` call always contributes exactly one distinct pair;
 * `autoConfirmStaleTrades` can contribute many, across many users/weeks,
 * in one sweep) so the SAME pair is never recomputed twice in one call.
 *
 * NEVER THROWS. Each pair's recompute is individually try/caught and
 * logged loudly (`console.error`, matching `distributions-repository.ts`'s
 * own sync-time precedent and `docs/runbook.md`'s matching entry) — a
 * failure for one pair never prevents the others from recomputing, and
 * never propagates back to the caller's already-committed confirmation.
 */
export async function recomputeAdherenceWeeklyForConfirmations(
  targets: readonly AdherenceRecomputeTarget[],
): Promise<AdherenceRecomputeBatchResult> {
  const uniquePairs = new Map<string, { userId: string; weekStart: string }>();
  for (const target of targets) {
    const weekStart = weekStartForServerDay(target.serverDay);
    uniquePairs.set(`${target.userId}::${weekStart}`, { userId: target.userId, weekStart });
  }

  const recomputed: { userId: string; weekStart: string }[] = [];
  const failed: { userId: string; weekStart: string; error: unknown }[] = [];

  for (const pair of uniquePairs.values()) {
    try {
      await recomputeAdherenceWeeklyForUser(pair.userId, pair.weekStart);
      recomputed.push(pair);
    } catch (err) {
      console.error(
        `[adherence] recompute failed for user ${pair.userId}, week ${pair.weekStart} -- adherence_weekly will ` +
          `read stale (or, for a never-yet-computed week, absent) numbers until the next successful recompute ` +
          `(Module 04 sec 5.6; docs/runbook.md "adherence_weekly recompute failed after confirm"):`,
        err,
      );
      failed.push({ ...pair, error: err });
    }
  }

  return { recomputed, failed };
}

// ---------------------------------------------------------------------
// Read (Module 06's future weekly review, or any other future caller)
// ---------------------------------------------------------------------

interface AdherenceWeeklyQueryRow {
  user_id: string;
  week_start: string;
  hard_followed: number;
  hard_total: number;
  soft_followed: number;
  soft_total: number;
  top_break_rule_id: string | null;
  top_break_count: number | null;
  computed_at: string;
}

/**
 * Reads the MATERIALISED row only — never recomputes from raw
 * `rule_evaluations` at read time (§3.1's own table comment, §12's
 * performance budget). `null` when no row has been materialised yet for
 * this `(userId, weekStart)` — e.g. a brand-new trader's current week
 * before their first confirm, or a week that predates this trader's
 * first rule — a correct, "not enough data yet" state per AGENTS.md, not
 * an error.
 *
 * Runs under `withUserConnection` (genuinely RLS-enforced against the
 * caller's own session, matching `rules-repository.ts`'s established
 * convention for reads a real trader session drives) — `adherence_weekly`'s
 * own owner-SELECT-only policy (Slice 1) is what actually narrows this,
 * not application-layer filtering alone.
 *
 * Returns the two fractions as four SEPARATE integers
 * (`hardFollowed`/`hardTotal`, `softFollowed`/`softTotal`) — deliberately
 * NOT a pre-computed ratio and NEVER a single blended number spanning both
 * severities (AGENTS.md: adherence is "reported as two fractions, never
 * blended, never a bare percentage," §5.6). A future UI slice choosing to
 * render a ratio does its own division from these four numbers; this data
 * layer does not offer a shape that makes blending them together easy.
 */
export async function fetchAdherenceWeekly(userId: string, weekStart: string): Promise<AdherenceWeeklyRecord | null> {
  assertCanonicalWeekStart(weekStart);
  return withUserConnection(userId, async (client) => {
    const res = await client.query<AdherenceWeeklyQueryRow>(
      `select user_id, week_start::text as week_start, hard_followed, hard_total, soft_followed, soft_total,
              top_break_rule_id, top_break_count, computed_at::text as computed_at
         from retrospeq.adherence_weekly
        where user_id = $1 and week_start = $2`,
      [userId, weekStart],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      userId: row.user_id,
      weekStart: row.week_start,
      hardFollowed: row.hard_followed,
      hardTotal: row.hard_total,
      softFollowed: row.soft_followed,
      softTotal: row.soft_total,
      topBreakRuleId: row.top_break_rule_id,
      topBreakCount: row.top_break_count,
      computedAt: row.computed_at,
    };
  });
}
