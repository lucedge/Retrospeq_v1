import 'server-only';
import type { PoolClient } from 'pg';
import { withServiceRoleConnection, withUserConnection } from '@/lib/supabase/direct';
import { weekStartForServerDay } from '@/lib/rules/week-boundary';

/**
 * Module 08 (Onboarding & Home) §4 / §6 — Slice 08a: the `unlock_state`
 * materialisation. §4's own table comment: "Gates what the app is allowed
 * to show. Recomputed after each confirm." Same "materialised CACHE,
 * never itself a source of truth, owner SELECT only, exclusively written
 * by a service-role recompute" shape Module 04 §3.1 already established
 * for `adherence_weekly`/`operand_distributions` — this file's structure
 * deliberately mirrors `lib/rules/adherence-repository.ts` (read the
 * source, compute pure counts, upsert, wire into `confirm.ts` post-commit
 * best-effort) rather than inventing a parallel shape for what is, at the
 * data-flow level, the exact same kind of table.
 *
 * ## What this slice computes for real, and what it deliberately doesn't
 *
 * `trades_confirmed` / `trades_with_captures` / `weeks_active` are
 * computed from real `retrospeq.trades`/`retrospeq.trade_captures` data —
 * the ingestion/rulebook data this repo already has. `derived_findings_
 * available` / `judgment_findings_available` / `graduation_available`
 * are ALWAYS `false` here, on purpose, not an oversight:
 *
 *   - `derived_findings_available` gates Module 05's behavioural findings
 *     (§6: "Derived findings, calibrated rules" at the "Imported, 0
 *     logged" rung) — Module 05 does not exist in this repo at all.
 *   - `judgment_findings_available` gates Module 05's single-field
 *     judgment findings (§6's "~30 with captures" rung) — same reason,
 *     plus it also needs Module 03's field registry to have captured
 *     anything to judge.
 *   - `graduation_available` gates Module 06's graduation prompts (§6's
 *     "~60" rung) — Module 06 does not exist.
 *
 * Per this slice's own dispatch instruction, these three are NOT computed
 * from a guessed threshold against `trades_confirmed`/`weeks_active`
 * alone (e.g. "graduation_available = trades_confirmed >= 60") — doing so
 * would silently promise a feature (a real graduation prompt, a real
 * judgment finding) that genuinely cannot be shown today, exactly the
 * "TODO: this returns dummy data for now" anti-pattern AGENTS.md's "never
 * fake it" rule exists to prevent. Wiring real logic into these three is
 * explicitly Modules 05/06's own future work, not a gap in this slice.
 *
 * ## `weeks_active` — this file's own definition, no single spec-mandated
 * answer (per this slice's own dispatch instruction, documented here)
 *
 * Defined as: the count of DISTINCT ISO weeks (Monday start,
 * `lib/rules/week-boundary.ts`'s `weekStartForServerDay`, ADR 0015 — the
 * SAME week-bucketing convention `adherence_weekly` already uses, so this
 * counter and adherence's own week grouping can never silently disagree
 * about which calendar dates share a week) that contain at least one
 * CONFIRMED trade's `server_day`. Deliberately NOT "weeks since account
 * creation" — a trader who signed up 20 weeks ago but only actively
 * logged trades in 8 of them reads as `weeks_active = 8`, matching the
 * spirit of Module 07's own future streak concept (a trader is only
 * "active" in a week they actually traded/logged in) — but this counter
 * is its own thing, deliberately NOT Module 07's eventual streak (AGENTS.md:
 * "Streak counts weeks, not days" is a STREAK-specific non-negotiable
 * about a different, still-unbuilt concept — a "current consecutive run"
 * — whereas `weeks_active` here is a simple lifetime distinct-week COUNT,
 * with no consecutiveness requirement at all). The two must never be
 * confused with each other once Module 07 exists; this file's own name
 * (`weeks_active`, matching §4's literal column name, not `current_streak`
 * or similar) is chosen specifically to avoid that confusion.
 *
 * ## Recompute timing: BEST-EFFORT, AFTER COMMIT — identical posture to
 * `adherence_weekly`/`operand_distributions`
 *
 * `recomputeUnlockStateForConfirmations` is called from
 * `lib/ingestion/confirm.ts`'s `confirmDay`/`autoConfirmStaleTrades`
 * AFTER their own transaction has already committed, same call site
 * shape as `recomputeAdherenceWeeklyForConfirmations` (see that file's
 * own header for the full "why not inside the transaction" reasoning,
 * which applies here verbatim — `unlock_state` is a cache over already-
 * committed `trades`/`trade_captures` rows, not itself trust-sensitive).
 * Never throws; each user's recompute is individually try/caught and
 * logged loudly (`docs/runbook.md`'s new "unlock_state recompute failing
 * after a confirmation" entry).
 *
 * Deduped by `userId` ONLY (not `(userId, weekStart)` the way adherence's
 * batch helper dedupes) — `unlock_state` has no week dimension at all
 * (§4's own schema: one row per user, not per user-per-week), so a sweep
 * touching the same user across many different days in one call still
 * only needs ONE recompute for that user (it always reads that user's
 * FULL confirmed-trade history regardless of which day triggered it).
 */

// ---------------------------------------------------------------------
// Pure computation — no I/O, directly unit-testable
// ---------------------------------------------------------------------

export interface ConfirmedTradeForUnlock {
  /** `server_day` as `YYYY-MM-DD` text — never a parsed `Date` (matches
   *  every other cross-trade computation in this repo, `week-boundary.ts`'s
   *  own header). */
  serverDay: string;
  hasCapture: boolean;
}

export interface UnlockCounters {
  tradesConfirmed: number;
  tradesWithCaptures: number;
  weeksActive: number;
}

/** §4's three real counters, computed from the trader's FULL confirmed-
 *  trade history (never an incremental delta — see this file's own
 *  header and `docs/runbook.md`'s matching entry for why that's the
 *  correct, self-healing shape for a materialised cache). */
export function computeUnlockCounters(rows: readonly ConfirmedTradeForUnlock[]): UnlockCounters {
  const activeWeeks = new Set<string>();
  let tradesWithCaptures = 0;

  for (const row of rows) {
    activeWeeks.add(weekStartForServerDay(row.serverDay));
    if (row.hasCapture) tradesWithCaptures += 1;
  }

  return {
    tradesConfirmed: rows.length,
    tradesWithCaptures,
    weeksActive: activeWeeks.size,
  };
}

// ---------------------------------------------------------------------
// Recompute (write side) — service role, unlock_state has no client write
// path at all (this slice's own migration comment)
// ---------------------------------------------------------------------

export interface UnlockStateRecord {
  userId: string;
  tradesConfirmed: number;
  tradesWithCaptures: number;
  weeksActive: number;
  derivedFindingsAvailable: boolean;
  judgmentFindingsAvailable: boolean;
  graduationAvailable: boolean;
  computedAt: string;
}

interface ConfirmedTradeForUnlockRow {
  server_day: string;
  has_capture: boolean;
}

/** One scoped query — every one of the trader's own CONFIRMED trades
 *  (`confirmed_at is not null`, the Module 02 §4.6 freeze point), joined
 *  against `trade_captures` via `exists` rather than a `left join` +
 *  `distinct` (a trade can have many capture rows, one per field — a
 *  plain join would multiply trade rows and double-count `tradesConfirmed`).
 *  Exported separately from `recomputeUnlockState` purely for direct unit
 *  testability against a mocked `client.query`, same posture
 *  `adherence-repository.ts`'s `fetchAdherenceEvaluationRowsForWeek`
 *  already establishes. */
export async function fetchConfirmedTradesForUnlock(
  client: PoolClient,
  userId: string,
): Promise<ConfirmedTradeForUnlock[]> {
  const res = await client.query<ConfirmedTradeForUnlockRow>(
    `select t.server_day::text as server_day,
            exists (select 1 from retrospeq.trade_captures tc where tc.trade_id = t.id) as has_capture
       from retrospeq.trades t
      where t.user_id = $1
        and t.confirmed_at is not null`,
    [userId],
  );
  return res.rows.map((row) => ({ serverDay: row.server_day, hasCapture: row.has_capture }));
}

/**
 * Computes and upserts ONE `unlock_state` row for `userId`, inside the
 * caller-supplied connection/transaction — reused by the standalone
 * service-role wrapper below.
 */
export async function recomputeUnlockState(client: PoolClient, userId: string): Promise<UnlockStateRecord> {
  const rows = await fetchConfirmedTradesForUnlock(client, userId);
  const counters = computeUnlockCounters(rows);

  const res = await client.query<{ computed_at: string }>(
    `insert into retrospeq.unlock_state
       (user_id, trades_confirmed, trades_with_captures, weeks_active,
        derived_findings_available, judgment_findings_available, graduation_available, computed_at)
     values ($1, $2, $3, $4, false, false, false, now())
     on conflict (user_id) do update
       set trades_confirmed            = excluded.trades_confirmed,
           trades_with_captures        = excluded.trades_with_captures,
           weeks_active                = excluded.weeks_active,
           -- Always false -- see this file's own header. Written
           -- explicitly on every recompute (not merely left alone) so a
           -- future accidental true value written by some other path is
           -- self-correcting on the NEXT recompute, not just on initial
           -- insert.
           derived_findings_available  = false,
           judgment_findings_available = false,
           graduation_available        = false,
           computed_at                 = excluded.computed_at
     returning computed_at::text as computed_at`,
    [userId, counters.tradesConfirmed, counters.tradesWithCaptures, counters.weeksActive],
  );

  return {
    userId,
    tradesConfirmed: counters.tradesConfirmed,
    tradesWithCaptures: counters.tradesWithCaptures,
    weeksActive: counters.weeksActive,
    derivedFindingsAvailable: false,
    judgmentFindingsAvailable: false,
    graduationAvailable: false,
    computedAt: res.rows[0]!.computed_at,
  };
}

/** Standalone caller-facing wrapper — opens its own service-role
 *  connection/transaction, matching `recomputeAdherenceWeeklyForUser`'s
 *  own established shape. */
export async function recomputeUnlockStateForUser(userId: string): Promise<UnlockStateRecord> {
  return withServiceRoleConnection((client) => recomputeUnlockState(client, userId));
}

export interface UnlockRecomputeTarget {
  userId: string;
}

export interface UnlockRecomputeBatchResult {
  recomputed: string[];
  failed: { userId: string; error: unknown }[];
}

/**
 * The best-effort, after-commit half described in this file's own header.
 * Dedupes by `userId` ONLY (see header — `unlock_state` has no week
 * dimension, unlike `adherence_weekly`'s own `(userId, weekStart)`
 * dedupe), so a single `autoConfirmStaleTrades` sweep touching the same
 * user across many days/accounts still recomputes that user exactly once.
 *
 * NEVER THROWS. Each user's recompute is individually try/caught and
 * logged loudly (`console.error`, matching `adherence-repository.ts`'s
 * own established shape and `docs/runbook.md`'s matching new entry) — a
 * failure for one user never prevents others from recomputing, and never
 * propagates back to the caller's already-committed confirmation.
 */
export async function recomputeUnlockStateForConfirmations(
  targets: readonly UnlockRecomputeTarget[],
): Promise<UnlockRecomputeBatchResult> {
  const uniqueUserIds = new Set(targets.map((t) => t.userId));

  const recomputed: string[] = [];
  const failed: { userId: string; error: unknown }[] = [];

  for (const userId of uniqueUserIds) {
    try {
      await recomputeUnlockStateForUser(userId);
      recomputed.push(userId);
    } catch (err) {
      console.error(
        `[onboarding] unlock_state recompute failed for user ${userId} -- unlock_state will read stale ` +
          `(or, for a never-yet-computed user, absent) counters until the next successful recompute ` +
          `(Module 08 §4; docs/runbook.md "unlock_state recompute failing after a confirmation"):`,
        err,
      );
      failed.push({ userId, error: err });
    }
  }

  return { recomputed, failed };
}

// ---------------------------------------------------------------------
// Read (a future onboarding/dashboard UI slice's own concern)
// ---------------------------------------------------------------------

interface UnlockStateQueryRow {
  user_id: string;
  trades_confirmed: number;
  trades_with_captures: number;
  weeks_active: number;
  derived_findings_available: boolean;
  judgment_findings_available: boolean;
  graduation_available: boolean;
  computed_at: string;
}

/**
 * Reads the MATERIALISED row only — never recomputes from raw
 * `trades`/`trade_captures` at read time (same "materialised, never
 * computed at read-time" posture `fetchAdherenceWeekly` already
 * establishes for the analogous table). `null` when no row has been
 * materialised yet — should not happen for any user created via
 * `handle_new_user` from this slice's migration forward (a `unlock_state`
 * row is created at signup, defaulted to all-zero counters), but is a
 * correct, "not enough data yet" state per AGENTS.md if it ever occurs,
 * not an error.
 *
 * Runs under `withUserConnection` (genuinely RLS-enforced against the
 * caller's own session) — `unlock_state`'s own owner-SELECT-only policy
 * is what actually narrows this, not application-layer filtering alone.
 */
export async function fetchUnlockState(userId: string): Promise<UnlockStateRecord | null> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<UnlockStateQueryRow>(
      `select user_id, trades_confirmed, trades_with_captures, weeks_active,
              derived_findings_available, judgment_findings_available, graduation_available,
              computed_at::text as computed_at
         from retrospeq.unlock_state
        where user_id = $1`,
      [userId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      userId: row.user_id,
      tradesConfirmed: row.trades_confirmed,
      tradesWithCaptures: row.trades_with_captures,
      weeksActive: row.weeks_active,
      derivedFindingsAvailable: row.derived_findings_available,
      judgmentFindingsAvailable: row.judgment_findings_available,
      graduationAvailable: row.graduation_available,
      computedAt: row.computed_at,
    };
  });
}
