import 'server-only';
import { withServiceRoleConnection } from '@/lib/supabase/direct';
import { isCryptoPlatform } from '@/lib/broker/platform-defaults';
import type { Platform } from '@/lib/broker/adapter';
import { filterEligibleTrades, type EligibleTradeFact } from '../shadow-harness/eligible-trade';
import type { FieldDataType, FieldRawValue } from './field-values';
import { extractFieldValue, type EdgeEngineTradeColumns } from './field-values';
import { computeEdgeFindingsForStrategy, type EdgeEngineField, type FieldValuesByFieldAndTrade } from './edge-engine';
import type { SegmentComputationResult } from './gates';
import { partitionByAssetClassSuppression } from './asset-class-suppression';

/**
 * Module 05 (Analytics & Findings) §4.13 — the edge engine's DB access
 * layer: fetch a user's active strategies, each strategy's own field list
 * (from `strategy_versions.fields`) and eligible trades (§4.1), the
 * captured values behind them, run the pure `computeEdgeFindingsForStrategy`
 * (`edge-engine.ts`), and write `findings` rows.
 *
 * Runs entirely under `withServiceRoleConnection` (RLS bypassed) because
 * this is a BACKGROUND recompute — no authenticated session exists at the
 * call site (`lib/ingestion/sync.ts`'s post-sync hook, same shape as
 * `lib/rules/distributions-repository.ts`'s own established precedent for
 * exactly this situation). Every query is explicitly scoped to the
 * caller-supplied `userId`, never trusting RLS to narrow it — matching
 * `distributions-repository.ts`'s own documented paranoia.
 *
 * ISOLATION BOUNDARY: this file (and everything else under
 * `lib/analytics/edge-engine/`) never imports `lib/rules/**` — enforced
 * both by `eslint.config.mjs`'s Module 04/05 rule and, structurally, by
 * this file only ever querying `strategies`, `strategy_versions`,
 * `fields`, `trades`, `trading_accounts`, `trade_captures`, `findings`,
 * `shadow_runs` — never `rules`, `rule_versions`, `rule_evaluations`, or
 * `adherence_weekly` (§7.5). `trading_accounts.platform` is read
 * (`fetchEligibleTradesForStrategy`) only for §4.12's asset-class
 * suppression classification — see that function's own comment.
 */

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------

interface ActiveStrategyRow {
  id: string;
  current_version: number;
}

/** Every ACTIVE strategy this user owns — an archived strategy is not
 *  recomputed (matches §4.13's own "only strategies with new confirmed
 *  trades" framing in spirit: an archived strategy accrues no new
 *  trades a trader would act on going forward). */
export async function fetchActiveStrategiesForUser(userId: string): Promise<ActiveStrategyRow[]> {
  return withServiceRoleConnection(async (client) => {
    const res = await client.query<ActiveStrategyRow>(
      `select id, current_version from retrospeq.strategies where user_id = $1 and state = 'active'`,
      [userId],
    );
    return res.rows;
  });
}

interface StrategyVersionFieldsRow {
  fields: { field_id: string }[];
}

/** The strategy's CURRENT version's own field list (§3.1's
 *  `strategy_versions.fields`, `[{field_id, capture_moment, order}]`),
 *  joined against `retrospeq.fields` for `data_type` — archived fields
 *  are silently excluded (a field a trader has since deleted/archived
 *  should not keep generating findings), matching `fields_owner_select`'s
 *  own "any state" read elsewhere being narrowed at the APPLICATION
 *  layer here, not a schema gap. `note`-typed fields are INCLUDED in the
 *  returned list (not filtered here) — `edge-engine.ts`'s own §4.2 "never
 *  segmented" skip is the single place that rule is enforced, so a future
 *  reader has one place to look, not two.
 */
export async function fetchStrategyFieldSpecs(
  userId: string,
  strategyId: string,
  currentVersion: number,
): Promise<EdgeEngineField[]> {
  return withServiceRoleConnection(async (client) => {
    const versionRes = await client.query<StrategyVersionFieldsRow>(
      `select fields from retrospeq.strategy_versions where user_id = $1 and strategy_id = $2 and version = $3`,
      [userId, strategyId, currentVersion],
    );
    const fieldIds = [...new Set((versionRes.rows[0]?.fields ?? []).map((f) => f.field_id))];
    if (fieldIds.length === 0) return [];

    const fieldsRes = await client.query<{ id: string; data_type: FieldDataType }>(
      `select id, data_type from retrospeq.fields where user_id = $1 and id = any($2::text[]) and state = 'active'`,
      [userId, fieldIds],
    );
    return fieldsRes.rows.map((row) => ({ fieldId: row.id, dataType: row.data_type }));
  });
}

interface TradeRow {
  id: string;
  status: 'open' | 'closed' | 'confirmed';
  not_a_decision: boolean;
  closed_at: string | null;
  server_day: string;
  opened_at: string;
  outcome: 'win' | 'loss' | 'scratch' | null;
  r_multiple: string | null;
  realized_pnl: string | null;
  currency: string;
  strategy_id: string | null;
  direction: 'long' | 'short';
  instrument: string;
  hold_seconds: number | null;
  risk_pct: string | null;
}

export interface EdgeEngineEligibleTrade {
  id: string;
  outcome: 'win' | 'loss' | 'scratch' | null;
  rMultiple: number | null;
  /** §4.12 asset-class suppression — the account this trade belongs to.
   *  Not part of `columns` (the derived-field-extraction shape) because
   *  it's never a segmentable/derived field value, only a classification
   *  input the caller uses once per strategy. */
  platform: string;
  columns: EdgeEngineTradeColumns;
}

/**
 * Every trade bound to this strategy (`trades.strategy_id`), filtered to
 * §4.1's eligible-trade contract via `filterEligibleTrades` (reused
 * verbatim, per this slice's own dispatch — never reimplemented). Fetches
 * every column both the eligibility filter AND `field-values.ts`'s own
 * derived-field extractors need, in one query — plus (§4.12) each trade's
 * own `trading_accounts.platform`, joined in the same query rather than a
 * second round trip, so `computeEdgeFindingsForStrategyId` can classify
 * the strategy as crypto-or-not from the SAME eligible-trade population
 * the rest of this computation already uses (never a separate, possibly
 * inconsistent account query).
 */
export async function fetchEligibleTradesForStrategy(userId: string, strategyId: string): Promise<EdgeEngineEligibleTrade[]> {
  return withServiceRoleConnection(async (client) => {
    const res = await client.query<TradeRow & { platform: string }>(
      `select t.id, t.status, t.not_a_decision, t.closed_at, t.server_day::text as server_day, t.opened_at,
              t.outcome, t.r_multiple, t.realized_pnl, t.currency, t.strategy_id, t.direction, t.instrument,
              t.hold_seconds, t.risk_pct, ta.platform
         from retrospeq.trades t
         join retrospeq.trading_accounts ta on ta.id = t.account_id
        where t.user_id = $1 and t.strategy_id = $2`,
      [userId, strategyId],
    );

    const eligibilityFacts: EligibleTradeFact[] = res.rows.map((row) => ({
      id: row.id,
      user_id: userId,
      status: row.status,
      not_a_decision: row.not_a_decision,
      closed_at: row.closed_at,
      server_day: row.server_day,
      opened_at: row.opened_at,
      outcome: row.outcome,
      r_multiple: row.r_multiple,
      realized_pnl: row.realized_pnl,
      currency: row.currency,
      strategy_id: row.strategy_id,
    }));
    const eligibleIds = new Set(filterEligibleTrades(eligibilityFacts).map((t) => t.id));

    return res.rows
      .filter((row) => eligibleIds.has(row.id))
      .map((row) => ({
        id: row.id,
        outcome: row.outcome,
        rMultiple: row.r_multiple === null ? null : Number(row.r_multiple),
        platform: row.platform,
        columns: {
          id: row.id,
          serverDay: row.server_day,
          direction: row.direction,
          instrument: row.instrument,
          holdSeconds: row.hold_seconds,
          riskPct: row.risk_pct === null ? null : Number(row.risk_pct),
        },
      }));
  });
}

/**
 * `trade_captures.value` for every `(trade, field)` pair among the given
 * ids, in one query — `field-values.ts`'s `extractFieldValue` is the pure
 * function that turns this (plus each trade's own columns) into the
 * actual value used for segmentation.
 */
export async function fetchCapturesForTrades(
  userId: string,
  tradeIds: readonly string[],
  fieldIds: readonly string[],
): Promise<Map<string, Map<string, unknown>>> {
  const out = new Map<string, Map<string, unknown>>(); // fieldId -> tradeId -> value
  if (tradeIds.length === 0 || fieldIds.length === 0) return out;
  return withServiceRoleConnection(async (client) => {
    const res = await client.query<{ trade_id: string; field_id: string; value: unknown }>(
      `select trade_id, field_id, value
         from retrospeq.trade_captures
        where user_id = $1 and trade_id = any($2::uuid[]) and field_id = any($3::text[])`,
      [userId, tradeIds, fieldIds],
    );
    for (const row of res.rows) {
      const byTrade = out.get(row.field_id) ?? new Map<string, unknown>();
      byTrade.set(row.trade_id, row.value);
      out.set(row.field_id, byTrade);
    }
    return out;
  });
}

// ---------------------------------------------------------------------
// Orchestration (still read-only) — assembles the pure computation's
// inputs from the reads above.
// ---------------------------------------------------------------------

export interface StrategyEdgeComputation {
  strategyId: string;
  /** To render — the segments NOT suppressed by §4.12. Written to
   *  `findings` by `writeFindingsForStrategy`. */
  results: SegmentComputationResult[];
  /** §4.12 asset-class suppression — computed but never rendered, logged
   *  to `shadow_runs` by `writeShadowedFindings` instead, never written
   *  to `findings` at all. Empty for every non-crypto strategy (today,
   *  every real strategy — no live crypto broker integration exists
   *  yet). */
  suppressed: SegmentComputationResult[];
  tradesScanned: number;
}

export async function computeEdgeFindingsForStrategyId(
  userId: string,
  strategyId: string,
  currentVersion: number,
): Promise<StrategyEdgeComputation> {
  const [fields, trades] = await Promise.all([
    fetchStrategyFieldSpecs(userId, strategyId, currentVersion),
    fetchEligibleTradesForStrategy(userId, strategyId),
  ]);

  const tradeIds = trades.map((t) => t.id);
  const fieldIds = fields.map((f) => f.fieldId);
  const captures = await fetchCapturesForTrades(userId, tradeIds, fieldIds);

  const valuesByFieldAndTrade: FieldValuesByFieldAndTrade = new Map(
    fields.map((field) => {
      const capturesForField = captures.get(field.fieldId) ?? new Map<string, unknown>();
      const byTrade = new Map<string, FieldRawValue | null>();
      for (const trade of trades) {
        byTrade.set(trade.id, extractFieldValue(field.fieldId, trade.columns, capturesForField.get(trade.id)));
      }
      return [field.fieldId, byTrade];
    }),
  );

  const results = computeEdgeFindingsForStrategy(
    trades.map((t) => ({ id: t.id, outcome: t.outcome, rMultiple: t.rMultiple })),
    fields,
    valuesByFieldAndTrade,
  );

  // §4.12: a strategy counts as "crypto" only when EVERY distinct
  // account platform among its OWN eligible trades is a crypto platform
  // — see `asset-class-suppression.ts`'s own header for the full
  // reasoning (conservative: a strategy with zero eligible trades, or
  // any non-crypto platform present, is never suppressed).
  const distinctPlatforms = new Set(trades.map((t) => t.platform));
  const isCryptoStrategy = distinctPlatforms.size > 0 && [...distinctPlatforms].every((p) => isCryptoPlatform(p as Platform));
  const { rendered, suppressed } = partitionByAssetClassSuppression(results, isCryptoStrategy);

  return { strategyId, results: rendered, suppressed, tradesScanned: trades.length };
}

// ---------------------------------------------------------------------
// Writes — findings supersession
// ---------------------------------------------------------------------

/**
 * §3.1's own `superseded_by` self-reference and `state` column
 * (`active | superseded | decayed`) imply supersession but don't spell
 * out the write semantics — this slice's own explicit judgment call,
 * documented here (and in `docs/adr/0024-findings-supersession-write-
 * semantics.md`) rather than guessed silently:
 *
 * On every fresh computation for a given `(user_id, strategy_id,
 * field_id, segment)` tuple, the PRIOR `state = 'active'` row for that
 * EXACT SAME tuple (if one exists) is set to `state = 'superseded'`,
 * `superseded_by = <new row's id>`, and the new row is inserted with
 * `state = 'active'`. Scoped to the exact segment tuple, not "every
 * active finding for this strategy" — a run that (for whatever reason)
 * doesn't recompute every segment a prior run once produced (e.g. a
 * field removed from the strategy's current version, or an option value
 * that no longer appears in the eligible-trade set) leaves that OLD
 * finding `active` rather than orphaning it into a state with no
 * successor — matching `superseded_by`'s own FK, which only makes sense
 * pointing at a row that genuinely replaces it. Originally one atomic SQL
 * statement (insert + update via a CTE) so there was no window where both
 * the old and new row were simultaneously `active` if the process crashed
 * mid-write — see the CONCURRENCY FIX below for why that shape changed
 * (the crash-safety property itself is preserved, just by the surrounding
 * TRANSACTION now, not by being a single statement).
 *
 * CONCURRENCY FIX (2026-09-09, post-independent-verification — see
 * `docs/adr/0024-findings-supersession-write-semantics.md`'s Consequences
 * section for the full incident writeup). The single-statement atomicity
 * described above is only atomic WITHIN one transaction. Two genuinely
 * CONCURRENT calls to this function (e.g. an overlapping manual "recompute
 * now" racing a triggered recompute for the same strategy) racing on the
 * SAME `(user_id, strategy_id, field_id, segment)` tuple could both commit
 * a fresh `active` row for it — under READ COMMITTED, each transaction's
 * own UPDATE-the-old-row-to-superseded step only sees rows already
 * committed as of ITS OWN statement's snapshot, so neither sees the
 * other's not-yet-committed INSERT, and both INSERTs succeed. Confirmed
 * live via a genuine two-connection `pg_stat_activity` lock-wait probe
 * (`tmp/edge-engine-concurrency-probe.mjs`) before this fix, reproducing
 * two simultaneously `active` rows for one segment.
 *
 * Fixed with the SAME two-layer pattern this repo already established for
 * Module 03's `archiveField`/`rebuildFieldUsagesForStrategy` TOCTOU race
 * and Module 04's `promoteRuleSeverity`/`insertRuleAndVersion` hard-cap
 * races:
 *
 *  1. A real DB-level constraint (`findings_active_tuple_uidx`, a partial
 *     unique index on `(user_id, strategy_id, field_id, segment) where
 *     state = 'active'` — `20260909020000_findings_active_tuple_
 *     uniqueness.sql`) — makes the invariant hold even if this
 *     application-level serialization is ever bypassed, turning a
 *     would-be silent duplicate into a loud constraint-violation error.
 *     PostgreSQL cannot make a PARTIAL unique index DEFERRABLE (confirmed
 *     live: `ALTER TABLE ... ADD CONSTRAINT ... UNIQUE USING INDEX ...
 *     DEFERRABLE` rejects it outright, "is a partial index") — see point 3
 *     below for why that structural limitation is exactly why the write
 *     SEQUENCE changed (not just gained a lock).
 *  2. `pg_advisory_xact_lock(hashtext(...))`, taken as the FIRST
 *     statement of each per-segment write below, keyed on the FULL exact
 *     tuple this segment's own uniqueness invariant is scoped to —
 *     deliberately NOT coarser (e.g. per-strategy or per-field), because
 *     one `writeFindingsForStrategy` call writes MANY segments (every
 *     field/option/bucket a single computation run produced) and a
 *     coarser lock would serialize ALL of them against any other
 *     concurrent run for the same strategy, even segments the other run
 *     isn't touching at all — unnecessary contention for zero correctness
 *     benefit, since the real invariant ("at most one active row per
 *     EXACT tuple") is scoped no wider than the tuple itself. Whichever
 *     writer acquires the lock for a given tuple first now genuinely
 *     blocks the other until it commits; the loser's own writes (below)
 *     then run against a fresh READ COMMITTED snapshot taken AFTER the
 *     wait, correctly seeing the winner's already-committed row and
 *     superseding THAT row instead of racing past it.
 *  3. The write SEQUENCE itself changed from "insert new, then (same
 *     statement) supersede old" to three ordered statements — UPDATE the
 *     prior `active` row to `superseded` FIRST, THEN INSERT the new
 *     `active` row, THEN (only if a prior row existed) UPDATE that prior
 *     row's `superseded_by` to point at the new row's id. This was NOT
 *     optional cleanup — it's required BECAUSE the unique index above
 *     cannot be deferred (point 1): a non-deferrable unique index
 *     validates each row THE INSTANT it's inserted, so the ORIGINAL
 *     insert-then-supersede CTE shape put a brand-new `active` row and
 *     the not-yet-superseded old `active` row in existence AT THE SAME
 *     INSTANT within one statement — a genuine unique-index violation on
 *     ORDINARY SEQUENTIAL RECOMPUTES, not just concurrent ones (confirmed
 *     live, this session: applying the plain non-deferrable index against
 *     the ORIGINAL insert-then-update shape broke
 *     `repository.live.test.ts`'s own pre-existing sequential
 *     "recompute twice" test, which has no concurrency in it at all).
 *     Superseding the old row BEFORE the new row is inserted means there
 *     is never a moment with two `active` rows for the same tuple in this
 *     transaction's own writes, sequential OR (combined with the lock)
 *     concurrent. Three round trips instead of one is an acceptable cost
 *     for a background recompute job; a combined single-CTE reordering was
 *     considered and rejected — PostgreSQL explicitly does NOT guarantee
 *     execution order between independent (non-data-dependent)
 *     data-modifying CTEs in one statement, so relying on "the UPDATE
 *     physically runs before the INSERT" without an explicit data
 *     dependency between them would be relying on unspecified behaviour,
 *     not a real guarantee — the opposite of this codebase's own
 *     "prove, don't assume" posture. The crash-safety property ADR 0024
 *     originally attributed to "one atomic SQL statement" is preserved by
 *     ordinary transaction atomicity instead (`withServiceRoleConnection`
 *     wraps every per-segment write in one transaction per top-level
 *     call): a crash at any point before COMMIT rolls back every
 *     statement issued so far, so the pre-write state (old row still
 *     `active`, nothing partially written) is always what's left if the
 *     process dies mid-write — no window where a crash could leave
 *     inconsistent state, matching ADR 0024's original guarantee via a
 *     different mechanism.
 *
 * Re-verified live: `tmp/edge-engine-concurrency-probe.mjs`'s exact
 * scenario (two real concurrent connections, `pg_stat_activity` lock-wait
 * polling) now shows the second writer genuinely BLOCKED on the advisory
 * lock and, post-fix, exactly one `active` row per segment after both
 * commit — see
 * `__tests__/repository.concurrency.independent-verify.live.test.ts`.
 */
export async function writeFindingsForStrategy(
  userId: string,
  strategyId: string,
  results: readonly SegmentComputationResult[],
): Promise<void> {
  if (results.length === 0) return;

  // DEADLOCK AVOIDANCE (security-reviewer finding, 2026-09-09): `userId`
  // and `strategyId` are fixed for this whole call, so the only part of
  // each per-segment advisory lock key (below) that varies is
  // `fieldId` + the segment — this call's own caller
  // (`computeEdgeFindingsForStrategyId`) builds `results` by iterating
  // `fetchStrategyFieldSpecs`'s rows, which has NO `ORDER BY`, so two
  // concurrent recomputes of the SAME strategy have no guarantee of
  // seeing fields/segments in the same order. Acquiring locks one after
  // another in whatever order `results` happens to arrive in would let
  // two concurrent calls that both touch tuples X and Y, in opposite
  // orders, deadlock (call A holds X wants Y, call B holds Y wants X) —
  // the EXACT problem class `strategy-repository.ts`'s
  // `rebuildFieldUsagesForStrategy` already solved for its own
  // multi-field-lock case (see that function's own "DEADLOCK AVOIDANCE"
  // comment). Fixed the same way: sort into one CONSISTENT order —
  // `fieldId + JSON.stringify(segment)`, the same two fields that (along
  // with the constant `userId`/`strategyId`) go into the lock key
  // itself below — and acquire every lock in THAT order, every time,
  // regardless of the order the caller's own `results` array happened to
  // list them in. `JSON.stringify` on a segment is deterministic for the
  // plain `{op, value}` shape this repo's segments always are (matching
  // the SAME `JSON.stringify(r.segment)` already used, unmodified, as the
  // literal jsonb parameter a few lines below), so this sort key is
  // consistent with the actual lock key it precedes.
  const lockOrderedResults = [...results].sort((a, b) => {
    const keyA = `${a.fieldId}:${JSON.stringify(a.segment)}`;
    const keyB = `${b.fieldId}:${JSON.stringify(b.segment)}`;
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });

  await withServiceRoleConnection(async (client) => {
    for (const r of lockOrderedResults) {
      // Layer 2 of the concurrency fix (see this function's own header) —
      // serializes concurrent writers for this EXACT tuple before any of
      // the three writes below runs. Transaction-scoped, released
      // automatically at this transaction's own commit/rollback
      // (`withServiceRoleConnection` owns both) — no unlock call needed
      // or safe to add manually, matching this repo's established
      // `pg_advisory_xact_lock` precedent (`fields-repository.ts`'s
      // `archiveField`, `severity-lifecycle-repository.ts`'s
      // `promoteRuleSeverity`). A hash collision between two different
      // tuples would only ever cause harmless extra serialization, never
      // a correctness problem — every WHERE clause below still scopes
      // strictly to the real tuple.
      const lockKey = `findings:${userId}:${strategyId}:${r.fieldId}:${JSON.stringify(r.segment)}`;
      await client.query('select pg_advisory_xact_lock(hashtext($1::text))', [lockKey]);

      // Statement 1 of 3 — supersede the prior `active` row for this
      // EXACT tuple FIRST (before any new row exists), leaving
      // `superseded_by` temporarily null (fixed up in statement 3 once
      // the new row's id is known). Zero rows affected is the normal,
      // expected case for a segment's first-ever computation.
      const supersededRes = await client.query<{ id: string }>(
        `update retrospeq.findings
            set state = 'superseded'
          where user_id = $1
            and strategy_id = $2
            and field_id = $3
            and segment = $4::jsonb
            and state = 'active'
          returning id`,
        [userId, strategyId, r.fieldId, JSON.stringify(r.segment)],
      );
      const priorActiveId: string | null = supersededRes.rows[0]?.id ?? null;

      // Statement 2 of 3 — insert the new `active` row. At this point the
      // tuple has ZERO `active` rows (statement 1 already demoted the
      // prior one, if any), so this can never conflict with
      // `findings_active_tuple_uidx`.
      const insertedRes = await client.query<{ id: string }>(
        `insert into retrospeq.findings
           (user_id, analytic_id, strategy_id, field_id, segment, n, win_rate, avg_r,
            baseline_n, baseline_win_rate, baseline_avg_r, delta_win_rate, delta_avg_r,
            p_value, p_adjusted, confidence, gate_failures, state)
         values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::text[],'active')
         returning id`,
        [
          userId,
          r.analyticId,
          strategyId,
          r.fieldId,
          JSON.stringify(r.segment),
          r.n,
          toNumeric(r.winRate, 4),
          toNumeric(r.avgR, 4),
          r.baselineN,
          toNumeric(r.baselineWinRate, 4),
          toNumeric(r.baselineAvgR, 4),
          toNumeric(r.deltaWinRate, 4),
          toNumeric(r.deltaAvgR, 4),
          toNumeric(r.pValue, 8),
          toNumeric(r.pAdjusted, 8),
          r.confidence,
          r.gateFailures,
        ],
      );
      const newId = insertedRes.rows[0].id;

      // Statement 3 of 3 — only if a prior row genuinely existed: point
      // its `superseded_by` at the row that actually replaces it, per
      // `superseded_by`'s own FK/intent (never left pointing at nothing
      // once a real successor exists).
      if (priorActiveId !== null) {
        await client.query(`update retrospeq.findings set superseded_by = $1 where id = $2`, [newId, priorActiveId]);
      }
    }
  });
}

/** Formats a computed float to a fixed-decimal STRING before it becomes
 *  a SQL parameter for a `numeric(...)` column — never passes a raw JS
 *  float directly, matching this repo's "never float" storage posture
 *  (00-foundation §2.3) even though the VALUE itself is a statistical
 *  computation, not money — the risk this avoids (a JS float's own
 *  binary representation producing a slightly different decimal string
 *  than intended, e.g. `0.1 + 0.2`) applies equally to any `numeric`
 *  column, not just currency ones. */
function toNumeric(value: number | null, decimalPlaces: number): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return value.toFixed(decimalPlaces);
}

// ---------------------------------------------------------------------
// Writes — §4.12 asset-class suppression's shadow-run log
// ---------------------------------------------------------------------

/** Statistical-gates-only render verdict, orthogonal from the asset-class
 *  policy decision that suppresses this result — "would this have
 *  rendered absent §4.12," not "did it render." */
function wouldRenderByStatisticalGatesAlone(confidence: SegmentComputationResult['confidence']): boolean {
  return confidence === 'confident' || confidence === 'provisional';
}

/**
 * §4.12: "findings over these fields are computed but suppressed from
 * render and logged to shadow_runs instead." One `shadow_runs` row per
 * suppressed segment, written under `withServiceRoleConnection` via raw
 * `insert` — deliberately NOT
 * `lib/analytics/shadow-harness/repository.ts`'s
 * `createSupabaseShadowRunRepository()` (a separate supabase-js/env-var
 * connection outside this function's own transaction; see this module's
 * own dispatch brief). `ShadowRunRecord`'s TYPE (imported for shape
 * consistency only, no runtime dependency) documents the row shape this
 * insert matches.
 *
 * `analyticId` is reused from the same `SegmentComputationResult` the
 * finding would have used (`find.session` / `find.pickone`) — "the
 * fields still exist," same analytic, just never rendered. `would_render`
 * reflects the STATISTICAL gates alone (orthogonal from the suppression
 * reason); `gate_failures` stays the segment's own real statistical
 * failures, never repurposed to encode the policy reason — that lives in
 * `payload.suppressionReason` instead.
 */
export async function writeShadowedFindings(
  userId: string,
  strategyId: string,
  suppressed: readonly SegmentComputationResult[],
): Promise<void> {
  if (suppressed.length === 0) return;

  await withServiceRoleConnection(async (client) => {
    for (const r of suppressed) {
      const payload = {
        strategyId,
        fieldId: r.fieldId,
        segment: r.segment,
        n: r.n,
        winRate: r.winRate,
        avgR: r.avgR,
        baselineN: r.baselineN,
        baselineWinRate: r.baselineWinRate,
        baselineAvgR: r.baselineAvgR,
        deltaWinRate: r.deltaWinRate,
        deltaAvgR: r.deltaAvgR,
        pValue: r.pValue,
        pAdjusted: r.pAdjusted,
        confidence: r.confidence,
        suppressionReason: 'asset_class_crypto' as const,
      };
      await client.query(
        `insert into retrospeq.shadow_runs (user_id, analytic_id, would_render, payload, gate_failures)
         values ($1, $2, $3, $4::jsonb, $5::text[])`,
        [userId, r.analyticId, wouldRenderByStatisticalGatesAlone(r.confidence), JSON.stringify(payload), r.gateFailures],
      );
    }
  });
}

// ---------------------------------------------------------------------
// Top-level: one user, every active strategy
// ---------------------------------------------------------------------

export interface RecomputeEdgeFindingsResult {
  strategiesComputed: number;
  findingsWritten: number;
}

/**
 * §4.13: "Edge engine | Nightly per user + on demand before weekly
 * review ... Only strategies with new confirmed trades." Nightly is NOT
 * built here — no cron/scheduler infra exists in this repo yet (see
 * PROGRESS.md "Infra gaps"; the identical, already-tracked gap
 * `distributions-repository.ts`'s own header documents for
 * `operand_distributions`, not a new gap). This function is the "on
 * demand" half, wired into `lib/ingestion/sync.ts`'s post-sync hook —
 * see that file's own call site. Recomputes EVERY active strategy for
 * this user on every call (not narrowed to "only strategies with new
 * trades" — the same simplifying call `recomputeOperandDistributionsForUser`
 * already made for an analogous reason: predicting which strategies could
 * possibly have gained a new eligible trade from a given sync is not
 * worth the complexity next to "just recompute them all," and a
 * strategy with zero eligible trades is cheap to recompute into an empty
 * result set).
 */
export async function recomputeEdgeFindingsForUser(userId: string): Promise<RecomputeEdgeFindingsResult> {
  const strategies = await fetchActiveStrategiesForUser(userId);
  let findingsWritten = 0;
  for (const strategy of strategies) {
    const computation = await computeEdgeFindingsForStrategyId(userId, strategy.id, strategy.current_version);
    // §4.12: the rendered half writes to `findings` as usual; the
    // suppressed half (empty for every non-crypto strategy — today,
    // every real strategy) writes to `shadow_runs` instead, never to
    // `findings` at all. Two independent writes, not one conditional —
    // a strategy can have both in the same run if its own segment set
    // includes both suppressible and non-suppressible fields.
    await writeFindingsForStrategy(userId, strategy.id, computation.results);
    await writeShadowedFindings(userId, strategy.id, computation.suppressed);
    findingsWritten += computation.results.length;
  }
  return { strategiesComputed: strategies.length, findingsWritten };
}
