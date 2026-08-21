import 'server-only';
import { withServiceRoleConnection } from '@/lib/supabase/direct';
import { computeServerDayRange } from './server-day';
import {
  loadInstrumentBlockState,
  findUnrecordedFillsForBlock,
  type InstrumentBlockState,
} from './sync';

/**
 * Module 02 (Trade Ingestion & Model) §4.6 — "Confirmation and freeze —
 * the critical transaction." Verbatim pseudocode:
 *
 * ```
 * BEGIN
 *   assert no coverage_gap overlaps this server_day
 *   assert all ambiguous groupings in this day resolved
 *   for each trade closed in this day:
 *       set confirmed_at = now(), confirmed_by = 'user'
 *       emit trade.confirmed  → Module 04 writes frozen rule_evaluations
 *                             → Module 05 admits the trade to findings
 *   insert day_closeouts
 *   emit day.closed          → Module 07 credits the streak
 * COMMIT
 * ```
 *
 * Two entry points:
 *
 *  - `confirmDay(accountId, serverDay, options)` — the user-initiated
 *    confirm/freeze transaction for ONE (account, server_day), §4.1's
 *    step-9-and-later continuation. This is the single most
 *    safety-critical function in Module 02: after it sets `confirmed_at`,
 *    "Regrouping is blocked / Rule evaluations are immutable" (§4.6) —
 *    the mechanism that makes AGENTS.md's "rule evaluations freeze at
 *    close-out and are never recomputed retroactively" non-negotiable
 *    actually enforceable, even though Module 04 doesn't exist yet to
 *    write a frozen evaluation.
 *  - `autoConfirmStaleTrades(options)` — §4.6's second mechanism, "any
 *    trade closed more than 7 days ago with confirmed_at is null is
 *    confirmed with confirmed_by = 'auto_7d'."
 *
 * Both run as a single Postgres transaction each (`withServiceRoleConnection`
 * already wraps BEGIN/COMMIT/ROLLBACK — see `lib/supabase/direct.ts`),
 * matching `sync.ts`'s own established pattern: a trusted backend process,
 * not a client request, with every query explicitly scoped to the account/
 * user in play (ADR 0005's caveat, restated by `sync.ts`'s own header).
 *
 * ## Judgment calls made reconciling §4.6's prose into executable code
 * (00-foundation §12; flagged for PROGRESS.md's decision log)
 *
 * 1. **The coverage-gap / server_day overlap test.** §4.6 says "assert no
 *    coverage_gap overlaps this server_day," but `coverage_gaps` stores a
 *    `[gap_from, gap_to)` timestamptz range while `trades.server_day` is a
 *    plain `date` — there is no column carrying the actual UTC instant
 *    range a `server_day` covers (it depends on the account's own
 *    `day_rollover`, and `server_day` is deliberately fixed at write time,
 *    never re-derived, 00-foundation §2.2). `server-day.ts`'s new
 *    `computeServerDayRange` is the documented inverse of
 *    `computeServerDay` that answers this — see that function's own header
 *    for the derivation and its unit tests for a fixture-derived
 *    round-trip proof. Overlap itself uses the standard half-open-interval
 *    test (`gap_from < dayEnd AND gap_to > dayStart`), matching
 *    `sync.ts`'s own "any positive gap" conservative-over-flagging stance
 *    for coverage gaps generally.
 * 2. **"Assert all ambiguous groupings in this day resolved" is checked
 *    across EVERY trade with `server_day = X`, not just the ones eligible
 *    for confirmation this call (`status = 'closed' AND confirmed_at is
 *    null`).** §4.6's own wording names the DAY, not the confirmation
 *    batch — an ambiguous trade that's still `status = 'open'` (e.g. a
 *    scaled position mid-build with an unresolved split question) would
 *    otherwise slip past this assertion entirely on a technicality (it was
 *    never "eligible for confirmation" to begin with, since only closed
 *    trades are), which reads as exactly the kind of loophole §4.6's
 *    "silence over wrongness" posture exists to close. Favouring
 *    over-refusal (a real ambiguity anywhere in the day blocks confirm)
 *    over under-refusal, same reasoning `sync.ts`'s own coverage-gap
 *    judgment call already used.
 *
 *    **Also worth being explicit about why this can never actually
 *    resolve today:** §4.7's corrections (manual split/join — the only
 *    thing that ever sets `ambiguity_resolved_at` / changes
 *    `grouping_confidence` away from `'ambiguous'`) is a LATER slice
 *    (Slice 6), not built yet. Every ambiguous trade in this repo today is
 *    permanently ambiguous, so this assertion will always correctly
 *    refuse a day containing one — an honest, intended consequence of
 *    build order, not a bug in this slice.
 * 3. **The stale/incomplete-block guard (`UNRESOLVED_BLOCK_ANOMALY`) is
 *    this slice's own extension of §4.6, not literal spec text** — the
 *    mechanism that closes the tracked gap Slice 3/4's own PROGRESS.md
 *    entries flagged as "a firm requirement, not just a 'revisit if it
 *    becomes a blocker'" for whoever builds this transaction: a trade
 *    that genuinely closes across a resync boundary (`sync.ts`'s own
 *    `BLOCK_EXTENSION_DEFERRED`/`FILL_LATE_ARRIVAL` anomalies, currently
 *    only logged via `console.warn` + `RunSyncResult.anomalies`, never
 *    persisted) must never be silently confirmed with facts that are
 *    already known to be stale. Rather than in-place block extension
 *    (still out of scope, a genuinely larger feature — see `sync.ts`'s own
 *    header judgment call #4), this transaction re-derives the SAME
 *    correctness check `sync.ts`'s `recomputeInstrument` already runs
 *    (via the newly-shared `loadInstrumentBlockState`/
 *    `findUnrecordedFillsForBlock` — see `sync.ts`'s own header for why
 *    this was factored out rather than duplicated) for every block backing
 *    a trade about to be confirmed, and refuses the whole day if any of
 *    them has a fill not yet reflected in its derived facts. This makes a
 *    stuck-open-forever trade (the sharpest edge tester found in Slice 3)
 *    also un-confirmable while stuck — it can never be silently frozen
 *    with incomplete facts, closing the actual danger, not just the
 *    cosmetic `status: 'open'` symptom.
 * 4. **`day_closeouts.kind` when zero trades are eligible for confirmation
 *    this call.** §4.6 names two kinds (`traded`, `deliberate_no_trade`)
 *    but no UI/trigger for the latter exists in this repo yet (Module
 *    07/08 territory) — `kind` is exposed as an explicit, optional
 *    override, defaulting to `'traded'` whenever the day has ANY trade
 *    row at all (even if every one of them is already confirmed — see
 *    judgment call #5 below), and REQUIRED (a thrown
 *    `ConfirmDayNoEligibleTradesError`, a genuine caller bug, not a
 *    refusal result) only when the day has literally zero trade rows of
 *    any status AND no override was supplied — nothing today has a
 *    legitimate reason to call `confirmDay` that way without saying which
 *    kind it means.
 * 5. **Idempotent re-confirm.** The day_closeouts insert uses `ON CONFLICT
 *    (user_id, account_id, server_day) DO NOTHING` — a second `confirmDay`
 *    call on an already-closed-out day is a successful no-op on the
 *    `day_closeouts` row (`dayCloseoutInserted: false` in the result,
 *    never an error), not a failure. This matters concretely: a trader
 *    might click "confirm" again after a page reload where a stray
 *    trade landed in the meantime (e.g. a late sync, or an ambiguity that
 *    just got resolved) — that trade IS still eligible and gets confirmed
 *    normally by this same call; the day_closeouts row underneath it
 *    simply doesn't need re-inserting. This is also why judgment call #4's
 *    "zero eligible trades" caller-error check uses "the day has zero
 *    trade rows of ANY status," not "zero rows eligible FOR THIS CALL" —
 *    a day whose trades are all ALREADY confirmed (nothing new to do) is
 *    a legitimate double-click, not a caller bug, and should succeed
 *    idempotently with `tradesConfirmed: []`.
 *
 *    **One known, accepted gap, not fixed here:** if a day was first
 *    closed out via the zero-trades `kind: 'deliberate_no_trade'` override
 *    and a genuine trade later appears on that same server_day (e.g. a
 *    very late sync), a subsequent `confirmDay` call WILL still confirm
 *    that new trade (it's eligible, full stop) but will NOT update the
 *    existing `day_closeouts.kind` back to `'traded'` (`ON CONFLICT DO
 *    NOTHING` never touches an existing row). This is a real, narrow
 *    inconsistency, left as `deliberate_no_trade` — fixing it would mean
 *    deciding whether `day_closeouts` rows should ever be mutated post-
 *    insert at all, which has no UI/product surface to inform that
 *    decision yet (Module 06/07/08 territory), so it is not guessed at
 *    speculatively here.
 *
 * ## `autoConfirmStaleTrades` — applying (and not applying) `confirmDay`'s
 * own guards
 *
 * - **Ambiguous-grouping guard: APPLIED, beyond the literal dispatch.**
 *   Nothing in §4.6's auto-confirm sentence mentions ambiguous grouping,
 *   but auto-confirming a `grouping_confidence = 'ambiguous'` trade would
 *   silently freeze rule evaluations (once Module 04 exists) over facts
 *   the product itself has not decided are correct yet — exactly the
 *   freeze-honesty failure mode the stale-block guard below exists to
 *   prevent, just for a different kind of "still unsettled" fact. Cheap
 *   to exclude (`grouping_confidence != 'ambiguous'` in the eligibility
 *   query) and consistent with `confirmDay`'s own posture, so it's applied
 *   here too rather than left as a gap for a later slice to rediscover.
 * - **Stale/incomplete-block guard: APPLIED, per this slice's own
 *   dispatch instruction to reason through it rather than skip it.** A
 *   trade eligible for auto-confirm is `status = 'closed'` by definition
 *   (an `'open'` trade never reaches this query), so the sharpest
 *   `BLOCK_EXTENSION_DEFERRED` scenario (a position that never
 *   technically closes) doesn't apply directly. But a block can host
 *   MULTIPLE trades (§4.3: "a block is the upper bound on a trade, not
 *   the answer" — `confident_split` groups several trades onto one
 *   block_id), so a `status = 'closed'` trade can share its block with an
 *   already-CONFIRMED sibling trade, and a late fill landing inside that
 *   shared block IS exactly `sync.ts`'s `FILL_LATE_ARRIVAL` case —
 *   detectable by the same `findUnrecordedFillsForBlock` check. Applied
 *   here as a PER-TRADE skip (not a whole-sweep refusal, unlike
 *   `confirmDay`) — this sweep runs across every account/user in one
 *   call, so failing the entire batch over one trade's stale block would
 *   have a far wider blast radius than `confirmDay`'s own per-day scope
 *   justifies; the affected trade is reported in
 *   `tradesSkippedStaleBlock` (never silently dropped) and remains a
 *   candidate on the next sweep, once a resync or in-place extension
 *   resolves it.
 * - **Does NOT insert a `day_closeouts` row, ever.** Read literally from
 *   §4.6's own words: "gets a day_closeouts row only if the user closed it
 *   out." `day_closeouts` rows are created EXCLUSIVELY by `confirmDay`
 *   (the only INSERT statement into this table in the whole repo) — this
 *   function only ever touches `trades`. This is the one genuinely
 *   ambiguous piece of §4.6's prose worth flagging for the decision log:
 *   an alternative reading could be "auto-confirm creates a
 *   `day_closeouts` row too, just never counted toward the streak" — but
 *   `day_closeouts` carries no separate streak-eligibility column (Module
 *   07 doesn't exist to define one), so representing "counts for
 *   adherence but not the streak" would require either inventing a new
 *   column speculatively or overloading `confirmed_by = 'auto_7d'` on
 *   `day_closeouts` itself to mean "exists but doesn't streak" — a
 *   decision Module 07 is better positioned to make once it actually
 *   exists. The chosen reading needs no new column and is trivially
 *   correct today: no `day_closeouts` row from this path, ever.
 */

// ---------------------------------------------------------------------
// confirmDay
// ---------------------------------------------------------------------

export type ConfirmDayRefusalCode = 'COVERAGE_GAP' | 'AMBIGUOUS_GROUPING' | 'UNRESOLVED_BLOCK_ANOMALY';

export interface ConfirmDaySuccess {
  confirmed: true;
  tradesConfirmed: string[];
  dayCloseoutInserted: boolean;
  kind: 'traded' | 'deliberate_no_trade';
}

export interface ConfirmDayCoverageGapRefusal {
  confirmed: false;
  code: 'COVERAGE_GAP';
  message: string;
  gapIds: string[];
}

export interface ConfirmDayAmbiguousGroupingRefusal {
  confirmed: false;
  code: 'AMBIGUOUS_GROUPING';
  message: string;
  tradeIds: string[];
}

export interface ConfirmDayBlockAnomalyRefusal {
  confirmed: false;
  code: 'UNRESOLVED_BLOCK_ANOMALY';
  message: string;
  trades: { tradeId: string; blockId: string; anomalyCode: 'BLOCK_EXTENSION_DEFERRED' | 'FILL_LATE_ARRIVAL' }[];
}

export type ConfirmDayRefusal =
  | ConfirmDayCoverageGapRefusal
  | ConfirmDayAmbiguousGroupingRefusal
  | ConfirmDayBlockAnomalyRefusal;

export type ConfirmDayResult = ConfirmDaySuccess | ConfirmDayRefusal;

export interface ConfirmDayOptions {
  /** Testability hook, same posture as `sync.ts`'s `RunSyncOptions.now`. */
  now?: () => Date;
  /** See this file's header, judgment call #4. Required (a thrown
   *  `ConfirmDayNoEligibleTradesError`) only when the day has zero trade
   *  rows of any status; otherwise defaults to `'traded'`. */
  kind?: 'traded' | 'deliberate_no_trade';
}

/** Thrown for input this function itself can recognise as a genuine
 *  caller bug, not a legitimate-but-blocked confirmation attempt — same
 *  posture as `sync.ts`'s own unknown-`accountId` throw. Never returned
 *  as part of `ConfirmDayResult`. */
export class ConfirmDayAccountNotFoundError extends Error {
  constructor(accountId: string) {
    super(
      `confirmDay: no retrospeq.trading_accounts row for id ${accountId} -- accountId must reference a real, existing account.`,
    );
    this.name = 'ConfirmDayAccountNotFoundError';
  }
}

/** See this file's header, judgment call #4. */
export class ConfirmDayNoEligibleTradesError extends Error {
  constructor(accountId: string, serverDay: string) {
    super(
      `confirmDay: account ${accountId} has zero trade rows on server_day ${serverDay} and no explicit "kind" override was supplied -- pass { kind: 'deliberate_no_trade' } to record a deliberate no-trade day, or { kind: 'traded' } if this call is otherwise expected to have trades.`,
    );
    this.name = 'ConfirmDayNoEligibleTradesError';
  }
}

interface ConfirmDayTradeRow {
  id: string;
  instrument: string;
  block_id: string;
  status: string;
  confirmed_at: string | null;
  grouping_confidence: string;
}

/**
 * §4.6's confirm/freeze transaction for ONE (account, server_day). See
 * this file's header for the full judgment-call reasoning. Runs entirely
 * inside one `withServiceRoleConnection` transaction — every query
 * explicitly scoped to `account.id`/`account.user_id`, matching ADR 0005's
 * caveat and `sync.ts`'s own established convention.
 */
export async function confirmDay(
  accountId: string,
  serverDay: string,
  options: ConfirmDayOptions = {},
): Promise<ConfirmDayResult> {
  const now = options.now ? options.now() : new Date();

  return withServiceRoleConnection(async (client) => {
    const accountRes = await client.query<{ id: string; user_id: string; day_rollover: string }>(
      `select id, user_id, day_rollover from retrospeq.trading_accounts where id = $1`,
      [accountId],
    );
    const account = accountRes.rows[0];
    if (!account) {
      throw new ConfirmDayAccountNotFoundError(accountId);
    }

    const { start, end } = computeServerDayRange(serverDay, account.day_rollover);

    // Assertion 1 (§4.6): "assert no coverage_gap overlaps this
    // server_day." Half-open-interval overlap test -- see header judgment
    // call #1.
    const gapRes = await client.query<{ id: string }>(
      `select id
         from retrospeq.coverage_gaps
        where account_id = $1 and user_id = $2 and resolved_at is null
          and gap_from < $4 and gap_to > $3`,
      [account.id, account.user_id, start.toISOString(), end.toISOString()],
    );
    if (gapRes.rows.length > 0) {
      const refusal: ConfirmDayCoverageGapRefusal = {
        confirmed: false,
        code: 'COVERAGE_GAP',
        message: `Cannot close out ${serverDay}: ${gapRes.rows.length} unresolved coverage gap(s) overlap this day. Retry sync to fill the gap, then confirm again (Module 02 §9 SYNC_COVERAGE_GAP).`,
        gapIds: gapRes.rows.map((r) => r.id),
      };
      return refusal;
    }

    const tradesRes = await client.query<ConfirmDayTradeRow>(
      `select id, instrument, block_id, status, confirmed_at, grouping_confidence
         from retrospeq.trades
        where account_id = $1 and user_id = $2 and server_day = $3`,
      [account.id, account.user_id, serverDay],
    );
    const allTradesThisDay = tradesRes.rows;

    // Assertion 2 (§4.6): "assert all ambiguous groupings in this day
    // resolved." See header judgment call #2 for why this scans every
    // trade this day, not just the confirmation-eligible subset.
    const ambiguous = allTradesThisDay.filter((t) => t.grouping_confidence === 'ambiguous');
    if (ambiguous.length > 0) {
      const refusal: ConfirmDayAmbiguousGroupingRefusal = {
        confirmed: false,
        code: 'AMBIGUOUS_GROUPING',
        message: `Cannot close out ${serverDay}: ${ambiguous.length} trade(s) have an unresolved ambiguous grouping. Resolve via manual split/join before confirming (Module 02 §4.3/§4.7).`,
        tradeIds: ambiguous.map((t) => t.id),
      };
      return refusal;
    }

    // "For each trade closed in this day" (§4.6) -- an OPEN trade is never
    // eligible (it genuinely isn't done being decided yet), and an
    // already-confirmed trade is a no-op (idempotent re-confirm, header
    // judgment call #5).
    const eligibleTrades = allTradesThisDay.filter((t) => t.status === 'closed' && t.confirmed_at === null);

    // Assertion 3 -- this slice's own extension (header judgment call #3):
    // no eligible trade's backing block may have a fill not yet reflected
    // in its derived facts.
    const instruments = [...new Set(eligibleTrades.map((t) => t.instrument))];
    const stateByInstrument = new Map<string, InstrumentBlockState>();
    for (const instrument of instruments) {
      stateByInstrument.set(instrument, await loadInstrumentBlockState(client, account.id, instrument, account.day_rollover));
    }

    const anomalousTrades: ConfirmDayBlockAnomalyRefusal['trades'] = [];
    for (const trade of eligibleTrades) {
      const state = stateByInstrument.get(trade.instrument)!;
      const unrecorded = findUnrecordedFillsForBlock(state, trade.block_id);
      if (unrecorded.length > 0) {
        const isConfirmed = state.confirmedBlockIds.has(trade.block_id);
        anomalousTrades.push({
          tradeId: trade.id,
          blockId: trade.block_id,
          anomalyCode: isConfirmed ? 'FILL_LATE_ARRIVAL' : 'BLOCK_EXTENSION_DEFERRED',
        });
      }
    }
    if (anomalousTrades.length > 0) {
      const refusal: ConfirmDayBlockAnomalyRefusal = {
        confirmed: false,
        code: 'UNRESOLVED_BLOCK_ANOMALY',
        message: `Cannot close out ${serverDay}: ${anomalousTrades.length} trade(s) have fill(s) not yet reflected in their grouped facts (a resync landed a fill on an already-derived block). Resync and retry (Module 02 §4.1/§9).`,
        trades: anomalousTrades,
      };
      return refusal;
    }

    // Header judgment call #4: a day with zero trade rows of ANY status
    // requires an explicit `kind` -- a genuine caller bug otherwise, not a
    // refusal result (nothing today has a legitimate reason to call this
    // without saying which kind it means).
    if (allTradesThisDay.length === 0 && options.kind === undefined) {
      throw new ConfirmDayNoEligibleTradesError(accountId, serverDay);
    }
    const kind: 'traded' | 'deliberate_no_trade' = options.kind ?? 'traded';

    // Atomic, conditional confirm -- retrospeq-security-reviewer FAIL,
    // 2026-08-22: the prior version did an unconditional UPDATE keyed only
    // on `id`/`account_id`, so two genuinely concurrent `confirmDay` calls
    // for the same (account, server_day) could both "win," leaving
    // `confirmed_at`/`confirmed_by` as whichever transaction happened to
    // commit last -- nondeterministic, on the exact columns that anchor
    // this module's freeze invariant. Same bug shape, same fix pattern, as
    // `lib/privacy/data-requests-repository.ts`'s `markDataRequestProcessing`
    // (an earlier FAIL in this build): the extra `and status = 'closed' and
    // confirmed_at is null` in the WHERE clause makes the UPDATE itself the
    // atomic check-and-set -- under Postgres's default READ COMMITTED
    // isolation, a second concurrent UPDATE on the same row blocks on the
    // first's row lock, then re-evaluates its WHERE predicate against the
    // now-committed row once unblocked, so it correctly affects 0 rows
    // rather than double-confirming. `rowCount === 0` is not an error --
    // it means a concurrent call already won this trade's confirmation
    // inside this same transaction window, so it's silently skipped from
    // `tradesConfirmed` (the loser's own view of "what I actually
    // confirmed" stays accurate; the winner's does too).
    const tradesConfirmed: string[] = [];
    for (const trade of eligibleTrades) {
      const updateRes = await client.query(
        `update retrospeq.trades
            set confirmed_at = $3, confirmed_by = 'user', status = 'confirmed'
          where id = $1 and account_id = $2 and status = 'closed' and confirmed_at is null`,
        [trade.id, account.id, now.toISOString()],
      );
      if ((updateRes.rowCount ?? 0) > 0) {
        tradesConfirmed.push(trade.id);
        // emit trade.confirmed -> Module 04 writes frozen rule_evaluations,
        // Module 05 admits the trade to findings. DOCUMENTED NO-OP: neither
        // module exists in this repo yet -- same posture as sync.ts's own
        // step-10 deferral.
      }
    }

    // insert day_closeouts -- header judgment call #5, idempotent re-confirm.
    const insertRes = await client.query(
      `insert into retrospeq.day_closeouts (user_id, account_id, server_day, kind, confirmed_at, confirmed_by)
       values ($1, $2, $3, $4, $5, 'user')
       on conflict (user_id, account_id, server_day) do nothing
       returning server_day`,
      [account.user_id, account.id, serverDay, kind, now.toISOString()],
    );
    const dayCloseoutInserted = insertRes.rows.length > 0;

    // emit day.closed -> Module 07 credits the streak. DOCUMENTED NO-OP:
    // Module 07 doesn't exist in this repo yet.

    const success: ConfirmDaySuccess = {
      confirmed: true,
      tradesConfirmed,
      dayCloseoutInserted,
      kind,
    };
    return success;
  });
}

// ---------------------------------------------------------------------
// autoConfirmStaleTrades
// ---------------------------------------------------------------------

const AUTO_CONFIRM_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

export interface AutoConfirmOptions {
  /** Testability hook, same posture as everywhere else in this module. */
  now?: () => Date;
}

export interface AutoConfirmResult {
  tradesConfirmed: string[];
  /** Trades that met every other 7-day auto-confirm criterion but were
   *  skipped because their backing block has fill(s) not yet reflected in
   *  its derived facts -- see this file's header re: applying
   *  `confirmDay`'s own stale-block guard here too. Never silently
   *  auto-confirmed with stale facts; these remain candidates on the next
   *  sweep. */
  tradesSkippedStaleBlock: string[];
}

interface AutoConfirmCandidateRow {
  id: string;
  account_id: string;
  instrument: string;
  block_id: string;
  day_rollover: string;
}

/**
 * §4.6's daily auto-confirm sweep: "any trade closed more than 7 days ago
 * with confirmed_at is null is confirmed with confirmed_by = 'auto_7d'."
 * Runs across every account/user in a single call (no per-user scoping —
 * see this file's header for why this table's own ownership guarantees
 * are still upheld: every UPDATE below is `where id = any($1::uuid[])`
 * against ids this same query just selected under the service role, never
 * against a caller-supplied id). No cron/API-route trigger surface is
 * built here — that's a dedicated future slice, same posture as
 * `sync.ts`'s own `trigger` param never building its own caller.
 */
export async function autoConfirmStaleTrades(options: AutoConfirmOptions = {}): Promise<AutoConfirmResult> {
  const now = options.now ? options.now() : new Date();
  const cutoff = new Date(now.getTime() - AUTO_CONFIRM_THRESHOLD_MS);

  return withServiceRoleConnection(async (client) => {
    const candidatesRes = await client.query<AutoConfirmCandidateRow>(
      `select t.id, t.account_id, t.instrument, t.block_id, a.day_rollover
         from retrospeq.trades t
         join retrospeq.trading_accounts a on a.id = t.account_id
        where t.status = 'closed'
          and t.confirmed_at is null
          and t.closed_at < $1
          and t.grouping_confidence != 'ambiguous'`,
      [cutoff.toISOString()],
    );
    const candidates = candidatesRes.rows;
    if (candidates.length === 0) {
      return { tradesConfirmed: [], tradesSkippedStaleBlock: [] };
    }

    // Reuse one loadInstrumentBlockState call per (account, instrument)
    // pair -- this sweep can span many accounts/instruments in one call.
    const stateCache = new Map<string, InstrumentBlockState>();
    const toConfirm: string[] = [];
    const skipped: string[] = [];

    for (const trade of candidates) {
      const cacheKey = `${trade.account_id}::${trade.instrument}`;
      let state = stateCache.get(cacheKey);
      if (!state) {
        state = await loadInstrumentBlockState(client, trade.account_id, trade.instrument, trade.day_rollover);
        stateCache.set(cacheKey, state);
      }
      const unrecorded = findUnrecordedFillsForBlock(state, trade.block_id);
      if (unrecorded.length > 0) {
        skipped.push(trade.id);
        console.warn(
          `[auto-confirm] skipped trade ${trade.id}: block ${trade.block_id} has ${unrecorded.length} fill(s) not yet reflected in its trade(s) -- never auto-confirmed with stale facts (Module 02 §4.6).`,
        );
        continue;
      }
      toConfirm.push(trade.id);
    }

    if (toConfirm.length > 0) {
      // Same atomic guard as confirmDay's per-trade UPDATE above, applied
      // here for the same reason plus one this bulk path adds of its own:
      // without `and confirmed_at is null`, a trade that a concurrent
      // user-initiated `confirmDay` call already confirmed (confirmed_by =
      // 'user') between this function's own SELECT and this UPDATE would
      // get silently overwritten to confirmed_by = 'auto_7d' -- corrupting
      // the confirmation provenance, not just racing on which caller
      // "wins." `returning id` lets `tradesConfirmed` report only the rows
      // this call actually confirmed, not the rows it merely intended to.
      const bulkRes = await client.query<{ id: string }>(
        `update retrospeq.trades
            set confirmed_at = $2, confirmed_by = 'auto_7d', status = 'confirmed'
          where id = any($1::uuid[]) and status = 'closed' and confirmed_at is null
          returning id`,
        [toConfirm, now.toISOString()],
      );
      const actuallyConfirmed = new Set(bulkRes.rows.map((r) => r.id));
      for (let i = toConfirm.length - 1; i >= 0; i--) {
        if (!actuallyConfirmed.has(toConfirm[i])) toConfirm.splice(i, 1);
      }
    }

    // No day_closeouts row, ever -- see header's own dedicated paragraph.

    return { tradesConfirmed: toConfirm, tradesSkippedStaleBlock: skipped };
  });
}
