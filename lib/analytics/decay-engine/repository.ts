import 'server-only';
import { withServiceRoleConnection } from '@/lib/supabase/direct';
import { evaluateDecayCheck } from './decay-engine';

/**
 * Module 05 (Analytics & Findings) §4.11/§4.13 — the decay-checking DB
 * access layer. Reads/writes `retrospeq.finding_rule_links` and
 * `retrospeq.findings` under `withServiceRoleConnection` — same
 * background-job posture as `edge-engine/repository.ts` and
 * `detection-engine/repository.ts` (no authenticated session at the call
 * site; `lib/ingestion/sync.ts`'s post-sync hook, wired AFTER
 * `recomputeEdgeFindingsForUser` so `findings` is already fresh by the
 * time this runs — see that file's own call site comment).
 *
 * ISOLATION BOUNDARY: never imports `lib/rules/**` — `rule_id` here is
 * treated as an opaque uuid throughout (matching `finding_rule_links`'s
 * own deliberate no-FK posture, see the `20260908010000_analytics_
 * registry_schema.sql` migration's own header), never resolved against
 * Module 04's rule tables. This file only ever queries
 * `finding_rule_links` and `findings`, both Module 05's own tables.
 *
 * THROTTLE MECHANICS ("every 30 new trades in the segment", §4.11):
 * `trades_at_last_check` (falling back to `trades_at_graduation` when
 * null — i.e. this link has never been checked) is the rolling baseline
 * a fresh check's own `n` (the CURRENT active finding's segment sample
 * size) is compared against. Fewer than 30 new trades since that
 * baseline is a silent no-op — "not enough data yet" (AGENTS.md
 * non-negotiable), never surfaced as an error, never even logged.
 * `trades_at_graduation` alone cannot serve as the rolling baseline: once
 * a segment first crosses 30 trades past graduation, comparing directly
 * against it would re-fire EVERY subsequent sync forever (31, 32, 33...
 * trades past graduation all satisfy "n - trades_at_graduation >= 30"),
 * which is a permanently-tripped switch, not a throttle.
 *
 * "RECOMPUTE THE FINDING" MECHANICS: the spec's pseudocode says "recompute
 * the finding," but a `finding_rule_links.finding_id` is a FIXED reference
 * captured at graduation time, and `findings` rows get SUPERSEDED (a
 * brand-new row, new id) on every edge-engine recompute
 * (`docs/adr/0024-findings-supersession-write-semantics.md`). This module
 * does NOT recompute anything itself — the edge engine already did (the
 * caller in `sync.ts` runs this AFTER `recomputeEdgeFindingsForUser`).
 * What `runDecayChecksForUser` does for each link is: (1) read the
 * ORIGINAL linked `findings` row by `finding_id` to recover the
 * `(strategy_id, field_id, segment)` tuple it was computed over at
 * graduation time — these three columns are immutable across supersession
 * (only stats/confidence/state change on a fresh row); (2) look up
 * whatever row is CURRENTLY `state = 'active'` for that EXACT tuple; (3)
 * use THAT row's own `delta_win_rate` as `current_delta`. If the
 * original finding's own `strategy_id`/`field_id` is NULL (the strategy
 * or field was hard-deleted since graduation, nulling the composite FK —
 * `on delete set null`) or no active row exists for the tuple any more
 * (the segment simply wasn't recomputed as active in the latest run —
 * see `writeFindingsForStrategy`'s own header on leaving an old active
 * row un-superseded when a run doesn't touch that exact tuple), this link
 * cannot be checked right now — silent no-op, not an error, matching this
 * module's own "not enough data yet" posture elsewhere.
 *
 * `delta_win_rate` (not `delta_avg_r`) is the metric used throughout —
 * see `decay-engine.ts`'s own header for the full reasoning.
 */

const TRADES_PER_DECAY_CHECK = 30;

// ---------------------------------------------------------------------
// createFindingRuleLink — the minimal writer.
// ---------------------------------------------------------------------

/**
 * Module 06 (Review & Graduation) §4.6: "On acceptance ... Module 05
 * writes the `finding_rule_links` row that enables decay checking."
 * Module 06's own graduation-acceptance flow does not exist in this repo
 * yet — this is the narrow, forward-looking interface that flow will
 * call once it does. `ruleId` stays a bare opaque string, never resolved
 * against or imported from `lib/rules/**` (isolation boundary, see this
 * file's own header).
 */
export async function createFindingRuleLink(
  userId: string,
  findingId: string,
  ruleId: string,
  deltaAtGraduation: number,
  tradesAtGraduation: number,
): Promise<void> {
  await withServiceRoleConnection(async (client) => {
    await client.query(
      `insert into retrospeq.finding_rule_links
         (finding_id, rule_id, user_id, delta_at_graduation, trades_at_graduation)
       values ($1, $2, $3, $4, $5)`,
      [findingId, ruleId, userId, deltaAtGraduation.toFixed(4), tradesAtGraduation],
    );
  });
}

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------

export interface FindingRuleLinkWithTuple {
  findingId: string;
  ruleId: string;
  deltaAtGraduation: number;
  tradesAtGraduation: number;
  lastCheckedAt: string | null;
  lastDelta: number | null;
  consecutiveDecayChecks: number;
  tradesAtLastCheck: number | null;
  /** The ORIGINAL linked finding's own immutable tuple columns (point 2
   *  of this module's own dispatch) — `null` when the strategy/field was
   *  hard-deleted since graduation. */
  strategyId: string | null;
  fieldId: string | null;
  segment: unknown;
}

interface FindingRuleLinkWithTupleRow {
  finding_id: string;
  rule_id: string;
  delta_at_graduation: string;
  trades_at_graduation: number;
  last_checked_at: string | null;
  last_delta: string | null;
  consecutive_decay_checks: number;
  trades_at_last_check: number | null;
  strategy_id: string | null;
  field_id: string | null;
  segment: unknown;
}

function rowToLink(row: FindingRuleLinkWithTupleRow): FindingRuleLinkWithTuple {
  return {
    findingId: row.finding_id,
    ruleId: row.rule_id,
    deltaAtGraduation: Number(row.delta_at_graduation),
    tradesAtGraduation: row.trades_at_graduation,
    lastCheckedAt: row.last_checked_at,
    lastDelta: row.last_delta === null ? null : Number(row.last_delta),
    consecutiveDecayChecks: row.consecutive_decay_checks,
    tradesAtLastCheck: row.trades_at_last_check,
    strategyId: row.strategy_id,
    fieldId: row.field_id,
    segment: row.segment,
  };
}

/** Every `finding_rule_links` row this user has, joined against the
 *  ORIGINAL linked `findings` row for its immutable `(strategy_id,
 *  field_id, segment)` tuple. */
export async function fetchFindingRuleLinksForUser(userId: string): Promise<FindingRuleLinkWithTuple[]> {
  return withServiceRoleConnection(async (client) => {
    const res = await client.query<FindingRuleLinkWithTupleRow>(
      `select l.finding_id, l.rule_id, l.delta_at_graduation, l.trades_at_graduation,
              l.last_checked_at, l.last_delta, l.consecutive_decay_checks, l.trades_at_last_check,
              f.strategy_id, f.field_id, f.segment
         from retrospeq.finding_rule_links l
         join retrospeq.findings f on f.id = l.finding_id and f.user_id = l.user_id
        where l.user_id = $1`,
      [userId],
    );
    return res.rows.map(rowToLink);
  });
}

export interface ActiveFindingTuple {
  id: string;
  n: number;
  deltaWinRate: number | null;
}

/** The exact-tuple, currently-`active` finding for `(strategyId, fieldId,
 *  segment)` — `null` when none exists (see this file's own header,
 *  "RECOMPUTE THE FINDING MECHANICS"). `findings_active_tuple_uidx`
 *  guarantees at most one such row. */
export async function fetchCurrentActiveFindingForTuple(
  userId: string,
  strategyId: string | null,
  fieldId: string | null,
  segment: unknown,
): Promise<ActiveFindingTuple | null> {
  return withServiceRoleConnection(async (client) => {
    const res = await client.query<{ id: string; n: number; delta_win_rate: string | null }>(
      `select id, n, delta_win_rate
         from retrospeq.findings
        where user_id = $1
          and state = 'active'
          and strategy_id is not distinct from $2
          and field_id is not distinct from $3
          and segment = $4::jsonb`,
      [userId, strategyId, fieldId, JSON.stringify(segment)],
    );
    const row = res.rows[0];
    if (!row) return null;
    return { id: row.id, n: row.n, deltaWinRate: row.delta_win_rate === null ? null : Number(row.delta_win_rate) };
  });
}

// ---------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------

export interface ApplyDecayCheckResultInput {
  userId: string;
  findingId: string;
  ruleId: string;
  /** The CURRENT active finding row this check's `current_delta`/`n` came
   *  from — the row that transitions to `state = 'decayed'` when the
   *  signal fires, not the (possibly long-superseded) originally-linked
   *  row. */
  currentFindingId: string;
  currentDelta: number;
  currentN: number;
  consecutiveDecayChecksAfter: number;
  decaySignalEmitted: boolean;
}

/**
 * Updates the link row (`last_checked_at`, `last_delta`,
 * `trades_at_last_check`, `consecutive_decay_checks`) and, when the
 * signal fires, transitions the current active finding to `state =
 * 'decayed'` — both writes in ONE `withServiceRoleConnection` call so a
 * crash mid-way leaves either the pre-check or post-check state, never a
 * torn write (link advanced but finding not marked decayed, or vice
 * versa).
 *
 * The finding-state UPDATE is guarded on `where id = $1 and state =
 * 'active'`, making it a safe no-op — not an error — if a concurrent
 * edge-engine recompute already superseded that exact row between this
 * check's read and this write. This is a best-effort background job, not
 * a strict transaction-isolated one against the edge engine's own writes
 * (which run in a separate, already-committed prior call); a missed
 * decay flag self-heals on the next check cycle once a fresh active row
 * exists for the tuple again.
 */
export async function applyDecayCheckResult(input: ApplyDecayCheckResultInput): Promise<void> {
  const { userId, findingId, ruleId, currentFindingId, currentDelta, currentN, consecutiveDecayChecksAfter, decaySignalEmitted } = input;
  await withServiceRoleConnection(async (client) => {
    await client.query(
      `update retrospeq.finding_rule_links
          set last_checked_at = now(),
              last_delta = $4,
              trades_at_last_check = $5,
              consecutive_decay_checks = $6
        where finding_id = $1 and rule_id = $2 and user_id = $3`,
      [findingId, ruleId, userId, currentDelta.toFixed(4), currentN, consecutiveDecayChecksAfter],
    );

    if (decaySignalEmitted) {
      // Ownership is re-constrained here even though `currentFindingId` is
      // always derived from a `user_id`-scoped SELECT earlier in the same
      // call graph: this module runs under service-role and so bypasses
      // RLS entirely, which makes the application-layer scope the ONLY
      // real cross-user boundary. The sibling `finding_rule_links` UPDATE
      // above already scopes by `user_id`; omitting it here was an
      // inconsistency, not a deliberate asymmetry. Defense-in-depth
      // against the "trust a linkage without independently constraining
      // ownership" bug class that produced a real finding in Module 04
      // Slice 8's `rule_overrides` work.
      await client.query(`update retrospeq.findings set state = 'decayed' where id = $1 and user_id = $2 and state = 'active'`, [currentFindingId, userId]);
    }
  });
}

// ---------------------------------------------------------------------
// Top-level orchestration
// ---------------------------------------------------------------------

export interface RunDecayChecksResult {
  /** Links that crossed the 30-new-trade throttle and were genuinely
   *  re-evaluated and successfully WRITTEN this run (a real, completed DB
   *  write happened for each) — not the total count of
   *  `finding_rule_links` rows this user has, and not incremented for a
   *  link whose check-and-apply threw (see `linksSkippedDueToError`). */
  linksChecked: number;
  /** Of `linksChecked`, how many pushed `consecutive_decay_checks` to
   *  >= 2 on THIS run — i.e. how many findings transitioned to `state =
   *  'decayed'` by this call. */
  decaySignalsEmitted: number;
  /** Links whose own check-and-apply threw an error this run (caught,
   *  logged, and skipped — see this function's own header, "PER-LINK
   *  ERROR CONTAINMENT") — not double-counted in `linksChecked`. Zero in
   *  the normal case; a nonzero value here across successive runs for the
   *  SAME link is the alertable signal (see `docs/runbook.md`'s "Decay
   *  check failed for an individual link" entry), not a one-off blip on
   *  its own. */
  linksSkippedDueToError: number;
}

/**
 * Runs every decay check due for this user. Safe to call unconditionally
 * on every sync — in the steady state (zero `finding_rule_links` rows,
 * since Module 06's own graduation flow that populates this table
 * doesn't exist yet) this is a correct, cheap no-op, not a bug to work
 * around (AGENTS.md: "Not enough data yet is a correct, intended state").
 *
 * PER-LINK ERROR CONTAINMENT: each link's own check-and-apply
 * (`fetchCurrentActiveFindingForTuple` through `applyDecayCheckResult`,
 * including the `evaluateDecayCheck` call in between) runs inside its own
 * `try/catch`. A thrown error for ONE link — including
 * `evaluateDecayCheck`'s own deliberate throw on a non-positive
 * `deltaAtGraduation` (`decay-engine.ts`'s own header) — is caught,
 * logged loudly (`console.error`, naming `finding_id`/`rule_id`/
 * `user_id`), counted in `linksSkippedDueToError`, and this function moves
 * on to the NEXT link rather than aborting the whole batch or re-throwing
 * to its own caller (`sync.ts`'s outer `try/catch` around this whole
 * function). This is deliberately NOT the same recovery posture
 * `recomputeEdgeFindingsForUser` (the edge engine) uses for ITS OWN
 * per-strategy loop, which has no per-item recovery at all — one corrupt
 * strategy there aborts that whole user's recompute for that sync cycle,
 * caught only by `sync.ts`'s outer catch. That's an acceptable, contained
 * cost there (a one-off miss for one sync, self-healing the next time
 * that strategy recomputes cleanly). It would NOT be acceptable here: a
 * single corrupt `finding_rule_links` row throwing unhandled would abort
 * `runDecayChecksForUser` before it ever reaches every OTHER link for
 * this user, re-throwing (and therefore blocking) that same corrupt
 * link's own neighbours on EVERY SINGLE FUTURE SYNC until someone
 * manually intervenes — a compounding failure, not a one-off. See
 * `docs/adr/0032-decay-check-delta-metric-and-trade-throttle.md`'s
 * decision 5 for the full reasoning.
 *
 * KNOWN, ACCEPTED RACE: unlike `writeFindingsForStrategy`'s per-tuple
 * `pg_advisory_xact_lock`, this function does not lock across its own
 * read (`fetchCurrentActiveFindingForTuple`) and write
 * (`applyDecayCheckResult`) steps — each is its own separate
 * `withServiceRoleConnection` call/transaction, so a lock taken inside
 * one would already be released before the other runs. Two genuinely
 * concurrent syncs for the same user (e.g. two accounts syncing at once)
 * racing on the same link could in principle double-count or interleave
 * a `consecutive_decay_checks` update. Accepted, not fixed, for this
 * slice: `finding_rule_links` has zero real rows in production today
 * (Module 06's graduation flow doesn't exist), so this is a zero-risk gap
 * right now, and a full fix would require restructuring
 * `fetchCurrentActiveFindingForTuple`/`applyDecayCheckResult` to share a
 * single connection (out of this slice's own scope, which specifies them
 * as separate exported functions). Flagged here rather than silently
 * left unmentioned, per AGENTS.md's "never fake it, always flag it."
 */
export async function runDecayChecksForUser(userId: string): Promise<RunDecayChecksResult> {
  const links = await fetchFindingRuleLinksForUser(userId);

  let linksChecked = 0;
  let decaySignalsEmitted = 0;
  let linksSkippedDueToError = 0;

  for (const link of links) {
    // Point 2 of this module's own dispatch: a NULL strategy_id/field_id
    // on the ORIGINAL linked finding means the strategy or field was
    // hard-deleted since graduation (the composite FK's `on delete set
    // null`) — the original tuple can no longer be reliably recovered,
    // so this link is skipped, not an error.
    if (link.strategyId === null || link.fieldId === null) continue;

    try {
      const current = await fetchCurrentActiveFindingForTuple(userId, link.strategyId, link.fieldId, link.segment);
      // No active row for the tuple right now, or the active row's own
      // delta is null (segment/baseline had no win-rate to compute a
      // delta from) — this link cannot be checked right now, silent
      // no-op, not an error.
      if (!current || current.deltaWinRate === null) continue;

      const baseline = link.tradesAtLastCheck ?? link.tradesAtGraduation;
      const newTrades = current.n - baseline;
      if (newTrades < TRADES_PER_DECAY_CHECK) continue; // not enough new trades yet -- silent no-op, per AGENTS.md

      const result = evaluateDecayCheck({
        deltaAtGraduation: link.deltaAtGraduation,
        currentDelta: current.deltaWinRate,
        consecutiveDecayChecksBefore: link.consecutiveDecayChecks,
      });

      await applyDecayCheckResult({
        userId,
        findingId: link.findingId,
        ruleId: link.ruleId,
        currentFindingId: current.id,
        currentDelta: current.deltaWinRate,
        currentN: current.n,
        consecutiveDecayChecksAfter: result.consecutiveDecayChecksAfter,
        decaySignalEmitted: result.decaySignalEmitted,
      });

      // Only counted once the write above genuinely completed — matches
      // `RunDecayChecksResult.linksChecked`'s own doc comment ("a real DB
      // write happened for each").
      linksChecked++;
      if (result.decaySignalEmitted) decaySignalsEmitted++;
    } catch (err) {
      linksSkippedDueToError++;
      console.error(
        `[decay-engine] decay check failed for link finding_id=${link.findingId} rule_id=${link.ruleId} user_id=${userId} -- skipping this link, continuing with the rest of this user's batch (see this function's own header, "PER-LINK ERROR CONTAINMENT", and docs/runbook.md's "Decay check failed for an individual link" entry):`,
        err,
      );
    }
  }

  return { linksChecked, decaySignalsEmitted, linksSkippedDueToError };
}
