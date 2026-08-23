import 'server-only';
import { z } from 'zod';
import { Decimal } from 'decimal.js';
import type { PoolClient } from 'pg';
import { withUserConnection, withServiceRoleConnection } from '@/lib/supabase/direct';
import { computeServerDay } from './server-day';
import { assignRoles, type GroupingInputFill, type GroupingRole, type TradeGroupMember } from './grouping';
import { computeTradeFacts, type TradeFacts, type TradeFactsMember } from './trade-facts';

/**
 * Module 02 (Trade Ingestion & Model) §4.7 — the two remaining corrections
 * operations, verbatim:
 *
 * | Operation    | Allowed                    | Effect                                                          |
 * |--------------|-----------------------------|------------------------------------------------------------------|
 * | Manual split | Before freeze only         | Creates two trades from one, recomputes facts, sets `grouping_source = 'user_split'` |
 * | Manual join  | Before freeze only, same block | Merges, recomputes                                          |
 *
 * A third, smaller operation lives at the bottom of this file, added
 * 2026-08-23 as a design-ethics fix rather than a literal §4.7 line item:
 * `resolveAmbiguousGroupingAsSingle` resolves an `ambiguous` trade's
 * grouping VERDICT to `confident_single` with NO membership change at all
 * — see that function's own header comment for the full reasoning (it
 * exists to give `GroupingChip.tsx`'s "Same trade" option a real backing
 * write, restoring the `.rq-btn--equal` pair's required symmetry with
 * "Separate").
 *
 * Both split/join reuse `grouping.ts`'s exported `assignRoles` (the exact function real
 * grouping uses to turn a chronological fill list into entry/add/trim/exit
 * roles) and `trade-facts.ts`'s `computeTradeFacts` — "recomputes facts"
 * means literally calling the same functions the sync pipeline calls, never
 * a parallel reimplementation (this repo's established "no parallel code
 * path" discipline — see `manual-entry.ts`'s own header for the precedent).
 *
 * ## The shared query: a trade's CURRENT full member list
 *
 * `loadTradeMemberRows` unions `trade_fills`/`fills` with `trade_events`/
 * `fills` — the same union `sync.ts`'s `matchPendingArmEvents` already
 * established for "every candidate entry fill, physical or ADR-0001
 * synthetic." Here it answers a different question ("every member of THIS
 * trade," not "every candidate entry for this instrument") but the shape —
 * a physical `trade_fills` row contributes its own full fill data, an
 * ADR-0001 synthetic flip-opening entry contributes `trade_events`' own
 * recorded `price`/`volume`/`occurred_at` (NOT the underlying fill's full
 * printed volume, which would be wrong — see `docs/adr/0001` and this
 * file's own `toGroupingInputFill` below) — is the same, reused rather than
 * reinvented.
 *
 * ## Reconstructing `appliedVolume` (grouping.ts's signed running-total
 * contribution) from stored data
 *
 * Nothing in this schema stores the signed `appliedVolume` grouping.ts's
 * `assignRoles` needs — only the unsigned `volume` magnitude and the
 * already-resolved `role`/`kind`. `blocks.ts`'s own signed-volume
 * convention is global, not relative to a trade's own direction: buy is
 * always `+volume`, sell is always `-volume` (§4.2, "Signed volume uses
 * buy positive, sell negative"), REGARDLESS of whether the position it
 * contributes to is long or short — `assignRoles` itself derives
 * `blockSignValue` fresh from whichever member ends up first in whatever
 * subset it's given, so re-deriving `appliedVolume = side==='buy' ? +volume
 * : -volume` for every member, unconditionally, reproduces exactly the
 * value the original grouping pass would have computed. This is what makes
 * "re-derive roles for a NEW/MERGED subset" well-defined at all: the
 * function doesn't need history, only each member's own side + magnitude.
 *
 * ## Two-phase write, `withUserConnection` then `withServiceRoleConnection`
 * — and why this slice has NO orphaned-write window (unlike `manual-entry.ts`)
 *
 * Same two-role split established by `manual-entry.ts`/`corrections.ts`/
 * `confirm.ts`: phase 1 (`withUserConnection`) is where RLS is genuinely
 * enforced against the caller's own session — `trades`/`trade_fills`/
 * `trade_events` all have real owner SELECT policies, so every validation
 * read here is a real security boundary, not merely app-layer-trusted.
 * Phase 2 (`withServiceRoleConnection`) does the actual restructuring,
 * necessarily service-role because `trade_fills` has NO update policy for
 * any client role at all (`trade_fills_owner_select` is SELECT-only) and
 * `trade_events` has none either (SELECT + INSERT only) — reassigning
 * `trade_id`/`role`/`kind` is structurally impossible under RLS regardless
 * of ownership, the identical reason `manual-entry.ts`'s own phase 2 is
 * service-role.
 *
 * **Unlike `manual-entry.ts`, phase 1 here performs NO writes at all** —
 * it is pure validation (existence, ownership, freeze status, boundary
 * membership). That means there is no analogue of `manual-entry.ts`'s
 * documented "orphaned-fills window" gap: every actual mutation for both
 * `splitTrade` and `joinTrades` happens inside phase 2's own single
 * transaction (`withServiceRoleConnection` wraps one BEGIN/COMMIT/ROLLBACK
 * per call, `lib/supabase/direct.ts`), so a failure anywhere inside phase 2
 * rolls back everything phase 2 attempted, leaving the original,
 * pre-operation state completely intact — a deliberate design property of
 * this slice, not an accident. Phase 2 re-validates ownership/freeze/
 * boundary-membership from scratch (a defensive re-check, not a trust of
 * phase 1's result) purely to close the narrow race where a concurrent
 * `confirmDay`/`autoConfirmStaleTrades` call freezes the trade in the gap
 * between phase 1 committing and phase 2 starting — cheap, and matches this
 * repo's established "two independent, redundant checks of the same fact"
 * posture (`corrections.ts`'s own header uses the identical phrase).
 *
 * ## `joinTrades`' delete-trigger interaction — the one genuinely fragile
 * mechanism in this slice (security-reviewer flagged, see PROGRESS.md)
 *
 * `retrospeq.forbid_broker_confirmed_trade_delete` (§4.7's "delete a
 * broker-confirmed trade: never") checks, AT DELETE TIME, whether ANY
 * `trade_fills`/`trade_events` row CURRENTLY backing the trade being
 * deleted has a non-`manual:`-prefixed `provider_ref` — it has no concept
 * of history, only present membership. `joinTrades` exploits this precise
 * shape deliberately and safely: every member row belonging to the
 * absorbed trade is UPDATEd to point at the surviving trade's id BEFORE the
 * absorbed trade row is deleted, in the SAME phase-2 transaction. By the
 * time the `DELETE FROM trades WHERE id = absorbed.id` statement runs, the
 * absorbed trade has ZERO backing `trade_fills`/`trade_events` rows left —
 * the trigger's own `exists (...)` checks both find nothing, and the
 * delete is permitted regardless of whether the absorbed trade was
 * originally broker-originated. This is not bypassing the "never delete a
 * broker-confirmed trade" rule — the broker-originated FILLS themselves are
 * never deleted, only reassigned to a different (still-real, still
 * unconfirmed) trade row; the invariant the trigger actually protects
 * ("no financial fact backing a broker-confirmed trade is ever destroyed")
 * holds throughout. See `__tests__/split-join.live.test.ts`'s
 * "join reassigns a broker-originated absorbed trade's members before
 * deleting it" test — the one test in this slice proving the mechanism
 * against a real, non-`manual:` fill, not just reasoning about it.
 *
 * ## Judgment calls made (flagged for PROGRESS.md's decision log, per
 * 00-foundation §12 — none deviate from a stated 00-foundation convention,
 * so no dedicated ADR; these are §4.7 prose-to-code translations)
 *
 * 1. **Both resulting trades' `grouping_confidence` -> `'confident_single'`,
 *    `grouping_signals` cleared to `{}`.** §4.7 doesn't name a value. "A
 *    user-directed split/join has no ambiguity left by definition" (this
 *    slice's own dispatch, verbatim) — the trader just told the system
 *    exactly where the boundary is (split) or that there is no boundary
 *    (join), which is strictly more certain than any automatic signal could
 *    produce. Leaving a stale `grouping_signals` blob from the PRE-correction
 *    state around would be actively misleading (Module 06's review screen,
 *    once built, would show a stale ambiguity marker for a boundary the
 *    trader already resolved).
 * 2. **`grouping_source`: `'user_split'` for both trades a split produces
 *    (§4.7's own literal value); `'user_join'` for the survivor of a join**
 *    — verified against `trades_grouping_source_check`'s exact allowed list
 *    in `20260822010000_ingestion_schema.sql` (`'auto' | 'user_split' |
 *    'user_join'`) before use, not guessed.
 * 3. **`ambiguity_resolved_at` is set to the operation's own timestamp on
 *    every trade a split/join touches, regardless of whether the trade was
 *    actually `'ambiguous'` beforehand.** Read as "the last time a human
 *    decided this trade's own boundary," which is true here even when there
 *    was no automatic ambiguity to resolve (a trader can split/join a
 *    `confident_single`/`confident_split` trade too — §4.7 imposes no
 *    "only if ambiguous" precondition on either operation).
 * 4. **Split boundary validation, exactly as this slice's own dispatch
 *    specifies, no more and no less:** `splitAtFillId` must (a) be a
 *    current member of the trade (`SplitBoundaryNotMemberError` otherwise),
 *    (b) not be the trade's own chronologically-first member
 *    (`SplitBoundaryIsFirstMemberError` — would leave the original trade
 *    with zero members), and (c) not be the ADR-0001 synthetic flip-opening
 *    entry (`SplitBoundaryIsSyntheticEntryError` — a `trade_events` row, not
 *    a `trade_fills` row; splitting "at" a fact with no real second fill to
 *    anchor a new trade's own entry is not meaningful). Condition (b)
 *    structurally implies most of (c) in practice (the synthetic entry, if
 *    one exists for this trade, is ALWAYS its chronologically-first member
 *    — a block's synthetic entry is by construction the very first event of
 *    that block, and blocks/trades never reorder), so `loadAndValidateSplit`
 *    checks (c) BEFORE (b) — the more specific, more informative reason —
 *    rather than letting the generic "first member" check shadow it
 *    permanently. Both are still checked independently and explicitly,
 *    exactly as the dispatch names them; the ordering only decides which
 *    named error a real flip-opened trade's own synthetic-entry boundary
 *    actually surfaces as.
 * 5. **Join's surviving trade: the chronologically-earlier one
 *    (`opened_at`), tying on `id` for a fully deterministic choice** — this
 *    slice's own dispatch's suggested reading, and the one with the
 *    clearest resulting semantics: the earlier trade's own identity (and
 *    any `arm_events.matched_trade_id` already pointing at it) survives
 *    unchanged, while the later trade's own row is what disappears.
 * 6. **First-subset (split) / previously-existing (join) `trade_fills`/
 *    `trade_events` rows that stay on their already-correct `trade_id`
 *    are left completely untouched — no redundant UPDATE.** For split,
 *    this is not just an optimisation: `assignRoles`' role assignment is a
 *    strict left-to-right walk depending only on each member's own position
 *    within whatever subset it's given, so the FIRST `boundaryIndex`
 *    members of the original chronological order always recompute to
 *    EXACTLY the roles they already have in the database (a proof, not an
 *    assumption — see `__tests__/split-join.live.test.ts`'s "first
 *    subset's trade_fills rows are never rewritten" assertion for the
 *    concrete check). `splitTrade` still calls `assignRoles` on that
 *    first subset (never skips it, per the dispatch's own explicit
 *    instruction), because it needs the subset's `isClosed`/member data to
 *    compute the ORIGINAL trade row's own recomputed facts — it just never
 *    writes a redundant, value-identical UPDATE to `trade_fills` for those
 *    rows. Join has no equivalent shortcut (a merge can genuinely change
 *    every member's role — the whole point of "recomputes"), so every
 *    member row a join touches DOES get written, unconditionally.
 *
 * ## A known, accepted limitation — NOT fixed here, flagged rather than
 * silently accepted (00-foundation §6.2 "silence over wrongness" is about
 * never fabricating a wrong answer, not about refusing every edge case;
 * this one is left to whichever slice designs the actual UI affordance)
 *
 * The dispatch's boundary-validation rules are exhaustive and are
 * implemented exactly as given — no additional restriction beyond "not the
 * first member, not the synthetic entry" is added here. One consequence:
 * `assignRoles` itself has no concept of "a subset may only cross net-flat
 * once, at its own end" — it is a proof about ORIGINAL, machine-derived
 * groups (§4.2/§4.3's own invariant, "a block never touches zero except at
 * its own boundaries"), not an enforced property of an arbitrary
 * user-chosen split boundary. A pathological boundary choice (e.g.
 * splitting a 4-member trade immediately AFTER its own first `add`, so the
 * new subset re-derives through a full round-trip AND has members left
 * over past that point) can produce a subset whose re-derived roles include
 * a `'trim'` AFTER an already-`'exit'`-marked point in the same subset —
 * `computeTradeFacts` does not reject this (it has no invariant check of
 * its own beyond requiring the first member to be an `'entry'`), it simply
 * produces facts describing whatever `assignRoles` output. This never
 * corrupts data (every write here is still internally consistent — no
 * orphaned rows, no `NULL` where a value is required) and never occurs for
 * ANY split boundary this file's own test suite exercises, but it is not
 * structurally IMPOSSIBLE for a caller to construct. Left as a known,
 * documented product-design question (should the UI even offer such a
 * boundary as a choice?) rather than an invented restriction beyond what
 * the dispatch specified.
 */

// ---------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------

const uuidSchema = z.uuid();

interface RawMemberRow {
  fill_id: string;
  role: GroupingRole;
  side: 'buy' | 'sell';
  volume: string;
  price: string;
  filled_at: string;
  stop_at_fill: string | null;
  provider_position_ref: string | null;
  provider_parent_ref: string | null;
  realized_pnl: string | null;
  synthetic_entry_event: boolean;
}

/**
 * A trade's CURRENT full member list — the union of its physical
 * `trade_fills` rows and its (at most one) ADR-0001 synthetic
 * `trade_events` entry row, chronologically sorted with the same
 * `(filled_at, fill_id)` tie-break `grouping.ts`'s own `compareFills` uses,
 * for deterministic output. See this file's header for why a
 * `trade_events` row's OWN `price`/`volume`/`occurred_at` are used, never
 * the underlying fill's full printed volume.
 */
async function loadTradeMemberRows(client: PoolClient, tradeId: string): Promise<RawMemberRow[]> {
  const res = await client.query<RawMemberRow>(
    `select f.id as fill_id, tf.role as role, f.side as side, f.volume as volume, f.price as price,
            f.filled_at as filled_at, f.stop_at_fill as stop_at_fill,
            f.provider_position_ref as provider_position_ref, f.provider_parent_ref as provider_parent_ref,
            f.realized_pnl as realized_pnl, false as synthetic_entry_event
       from retrospeq.trade_fills tf
       join retrospeq.fills f on f.id = tf.fill_id
      where tf.trade_id = $1

      union all

     select f.id as fill_id, te.kind as role, f.side as side, te.volume as volume, te.price as price,
            te.occurred_at as filled_at, null as stop_at_fill,
            null as provider_position_ref, null as provider_parent_ref,
            null as realized_pnl, true as synthetic_entry_event
       from retrospeq.trade_events te
       join retrospeq.fills f on f.id = te.fill_id
      where te.trade_id = $1

      order by filled_at, fill_id`,
    [tradeId],
  );
  return res.rows;
}

/** See this file's header — buy is always `+volume`, sell always
 *  `-volume`, the same global convention `blocks.ts` uses, independent of
 *  the trade's own eventual direction. */
function toGroupingInputFill(row: RawMemberRow): GroupingInputFill {
  const magnitude = new Decimal(row.volume);
  const signed = row.side === 'buy' ? magnitude : magnitude.negated();
  return {
    fillId: row.fill_id,
    side: row.side,
    volume: magnitude.toFixed(8),
    appliedVolume: signed.toFixed(8),
    price: row.price,
    filledAt: row.filled_at,
    stopAtFill: row.stop_at_fill,
    providerPositionRef: row.provider_position_ref,
    providerParentRef: row.provider_parent_ref,
  };
}

/** Same mapping `sync.ts`'s `recomputeInstrument` already uses: a
 *  synthetic entry event's `realizedPnl` is always `null` (ADR-0001 —
 *  `trade_events` has no P&L column, and it never should, since no
 *  position has closed on it), a physical fill's is its own stored value. */
function toFactsMembers(members: TradeGroupMember[], rawByFillId: Map<string, RawMemberRow>): TradeFactsMember[] {
  return members.map((m) => {
    const raw = rawByFillId.get(m.fillId);
    if (!raw) {
      throw new Error(`split-join: no raw member row for fill ${m.fillId} -- should be structurally impossible.`);
    }
    return {
      fillId: m.fillId,
      role: m.role,
      side: m.side,
      volume: m.volume,
      price: m.price,
      filledAt: m.filledAt,
      stopAtFill: m.stopAtFill,
      realizedPnl: m.syntheticEntryEvent ? null : (raw.realized_pnl ?? null),
      syntheticEntryEvent: m.syntheticEntryEvent,
    };
  });
}

interface AccountContext {
  id: string;
  user_id: string;
  day_rollover: string;
  starting_equity: string | null;
  base_currency: string;
}

async function loadAccountContext(client: PoolClient, accountId: string): Promise<AccountContext> {
  const res = await client.query<AccountContext>(
    `select id, user_id, day_rollover, starting_equity, base_currency
       from retrospeq.trading_accounts
      where id = $1`,
    [accountId],
  );
  const row = res.rows[0];
  if (!row) {
    throw new Error(
      `split-join: no retrospeq.trading_accounts row for id ${accountId} -- should be structurally impossible (sourced from an already-validated trade's own account_id).`,
    );
  }
  return row;
}

interface RecomputedGroup {
  members: TradeGroupMember[];
  isClosed: boolean;
  facts: TradeFacts;
  openedAt: string;
  closedAt: string | null;
  serverDay: string;
  status: 'open' | 'closed';
}

function recomputeGroup(
  input: GroupingInputFill[],
  firstIsFlipOpening: boolean,
  rawByFillId: Map<string, RawMemberRow>,
  account: AccountContext,
): RecomputedGroup {
  const { members, isClosed } = assignRoles(input, firstIsFlipOpening);
  const facts = computeTradeFacts(toFactsMembers(members, rawByFillId), {
    startingEquity: account.starting_equity,
    currency: account.base_currency,
    contractValue: '1',
  });
  const first = members[0];
  const last = members[members.length - 1];
  const openedAt = first.filledAt;
  const closedAt = isClosed ? last.filledAt : null;
  const serverDay = computeServerDay(openedAt, account.day_rollover);
  return { members, isClosed, facts, openedAt, closedAt, serverDay, status: isClosed ? 'closed' : 'open' };
}

const TRADES_RECOMPUTE_SET_CLAUSE = `
  direction = $2, opened_at = $3, closed_at = $4, server_day = $5, status = $6,
  entry_price_avg = $7, exit_price_avg = $8, peak_volume = $9, initial_stop = $10,
  risk_pct = $11, initial_risk_pct = $12, r_multiple = $13, realized_pnl = $14,
  hold_seconds = $15, outcome = $16,
  grouping_confidence = 'confident_single', grouping_signals = '{}'::jsonb,
  grouping_source = $17, ambiguity_resolved_at = $18
`;

function recomputeUpdateParams(
  tradeId: string,
  group: RecomputedGroup,
  groupingSource: 'user_split' | 'user_join',
  now: string,
): unknown[] {
  const f = group.facts;
  return [
    tradeId,
    f.direction,
    group.openedAt,
    group.closedAt,
    group.serverDay,
    group.status,
    f.entryPriceAvg,
    f.exitPriceAvg,
    f.peakVolume,
    f.initialStop,
    f.riskPct,
    f.initialRiskPct,
    f.rMultiple,
    f.realizedPnl,
    f.holdSeconds,
    f.outcome,
    groupingSource,
    now,
  ];
}

// ---------------------------------------------------------------------
// splitTrade
// ---------------------------------------------------------------------

export class SplitTradeNotFoundError extends Error {
  constructor(tradeId: string) {
    super(`splitTrade: no retrospeq.trades row for id ${tradeId} owned by the calling user.`);
    this.name = 'SplitTradeNotFoundError';
  }
}

export class SplitTradeAlreadyConfirmedError extends Error {
  constructor(tradeId: string) {
    super(
      `splitTrade: trade ${tradeId} is already confirmed -- manual split is allowed before freeze only (Module 02 §4.7).`,
    );
    this.name = 'SplitTradeAlreadyConfirmedError';
  }
}

export class SplitBoundaryNotMemberError extends Error {
  constructor(tradeId: string, fillId: string) {
    super(`splitTrade: fill ${fillId} is not a current member of trade ${tradeId}.`);
    this.name = 'SplitBoundaryNotMemberError';
  }
}

export class SplitBoundaryIsFirstMemberError extends Error {
  constructor(tradeId: string, fillId: string) {
    super(
      `splitTrade: fill ${fillId} is trade ${tradeId}'s own chronologically-first member -- splitting there would leave the original trade with zero members.`,
    );
    this.name = 'SplitBoundaryIsFirstMemberError';
  }
}

export class SplitBoundaryIsSyntheticEntryError extends Error {
  constructor(tradeId: string, fillId: string) {
    super(
      `splitTrade: fill ${fillId} is trade ${tradeId}'s ADR-0001 synthetic flip-opening entry (a trade_events row, not a trade_fills row) -- splitting there is not meaningful.`,
    );
    this.name = 'SplitBoundaryIsSyntheticEntryError';
  }
}

export interface SplitTradeResult {
  originalTradeId: string;
  newTradeId: string;
  blockId: string;
}

interface SplitValidatedState {
  accountId: string;
  userId: string;
  blockId: string;
  instrument: string;
  rows: RawMemberRow[];
  boundaryIndex: number;
}

/** Shared by both phases -- throws the exact same named errors either way,
 *  so a race that only manifests in phase 2 (the trade got confirmed, or a
 *  concurrent split changed membership, between phase 1 committing and
 *  phase 2 starting) surfaces identically to a phase-1 rejection. */
async function loadAndValidateSplit(
  client: PoolClient,
  tradeId: string,
  splitAtFillId: string,
  scopeToUserId: string | null,
): Promise<SplitValidatedState> {
  const tradeRes = await client.query<{
    id: string;
    user_id: string;
    account_id: string;
    block_id: string;
    instrument: string;
    confirmed_at: string | null;
  }>(
    scopeToUserId
      ? `select id, user_id, account_id, block_id, instrument, confirmed_at from retrospeq.trades where id = $1 and user_id = $2`
      : `select id, user_id, account_id, block_id, instrument, confirmed_at from retrospeq.trades where id = $1`,
    scopeToUserId ? [tradeId, scopeToUserId] : [tradeId],
  );
  const trade = tradeRes.rows[0];
  if (!trade) throw new SplitTradeNotFoundError(tradeId);
  if (trade.confirmed_at !== null) throw new SplitTradeAlreadyConfirmedError(tradeId);

  const rows = await loadTradeMemberRows(client, tradeId);
  if (rows.length === 0) {
    throw new Error(`splitTrade: trade ${tradeId} has zero members -- should be structurally impossible.`);
  }
  const boundaryIndex = rows.findIndex((r) => r.fill_id === splitAtFillId);
  if (boundaryIndex === -1) throw new SplitBoundaryNotMemberError(tradeId, splitAtFillId);
  // Checked BEFORE the "is first member" check, deliberately -- a real
  // ADR-0001 synthetic flip-opening entry is ALWAYS a trade's own
  // chronologically-first member (see this file's header, judgment call
  // #4), so checking index-zero first would make this more specific, more
  // informative error permanently unreachable. Ordering it first means a
  // caller splitting at a real synthetic entry gets told exactly why
  // ("this is the synthetic flip-opening entry"), not the generic "this is
  // the first member" reason.
  if (rows[boundaryIndex].synthetic_entry_event) throw new SplitBoundaryIsSyntheticEntryError(tradeId, splitAtFillId);
  if (boundaryIndex === 0) throw new SplitBoundaryIsFirstMemberError(tradeId, splitAtFillId);

  return {
    accountId: trade.account_id,
    userId: trade.user_id,
    blockId: trade.block_id,
    instrument: trade.instrument,
    rows,
    boundaryIndex,
  };
}

/**
 * Module 02 §4.7 — manual split. Splits `tradeId` into two trades at
 * `splitAtFillId`: everything strictly before the boundary fill stays on
 * the original trade id; the boundary fill and everything after it moves
 * to a brand-new trade id. See this file's header for the boundary
 * validation rules, the `grouping_confidence`/`grouping_source` choices,
 * and why the first subset's `trade_fills` rows are never rewritten.
 */
export async function splitTrade(
  userId: string,
  tradeId: string,
  splitAtFillId: string,
): Promise<SplitTradeResult> {
  uuidSchema.parse(userId);
  uuidSchema.parse(tradeId);
  uuidSchema.parse(splitAtFillId);

  // Phase 1 -- withUserConnection, genuinely RLS-enforced. Read-only: see
  // this file's header for why this slice has no orphaned-write window.
  await withUserConnection(userId, (client) => loadAndValidateSplit(client, tradeId, splitAtFillId, userId));

  // Phase 2 -- withServiceRoleConnection, the actual restructuring. Every
  // query explicitly scoped to already-validated ids (ADR 0005's caveat).
  return withServiceRoleConnection(async (client) => {
    const state = await loadAndValidateSplit(client, tradeId, splitAtFillId, null);
    const account = await loadAccountContext(client, state.accountId);
    const rawByFillId = new Map(state.rows.map((r) => [r.fill_id, r]));

    const subset1Rows = state.rows.slice(0, state.boundaryIndex);
    const subset2Rows = state.rows.slice(state.boundaryIndex);

    const group1 = recomputeGroup(
      subset1Rows.map(toGroupingInputFill),
      subset1Rows[0].synthetic_entry_event,
      rawByFillId,
      account,
    );
    // subset2's first member can never be the synthetic flip-opening entry
    // -- validated above (SplitBoundaryIsSyntheticEntryError).
    const group2 = recomputeGroup(subset2Rows.map(toGroupingInputFill), false, rawByFillId, account);

    const now = new Date().toISOString();

    // Atomic, conditional -- retrospeq-security-reviewer FAIL, 2026-08-22:
    // the phase-1/phase-2-entry `confirmed_at` re-checks above are both
    // read-then-act, not a CAS -- a concurrent confirmDay/autoConfirmStaleTrades
    // call could commit BETWEEN that read and this UPDATE, freezing the
    // trade in the gap. Without `and confirmed_at is null` here, this
    // UPDATE would still fire unconditionally, silently rewriting a
    // now-frozen trade's derived facts -- a direct violation of "rule
    // evaluations freeze at close-out and are never recomputed
    // retroactively." Same bug shape, same fix pattern, as confirm.ts's
    // own atomic guard (see that file's header). `rowCount !== 1` means a
    // concurrent freeze won the race; abort the whole phase-2 transaction
    // (including the not-yet-executed member-reassignment/insert below)
    // rather than proceed with a stale precondition.
    const originalUpdateRes = await client.query(
      `update retrospeq.trades set ${TRADES_RECOMPUTE_SET_CLAUSE} where id = $1 and confirmed_at is null`,
      recomputeUpdateParams(tradeId, group1, 'user_split', now),
    );
    if ((originalUpdateRes.rowCount ?? 0) !== 1) {
      throw new SplitTradeAlreadyConfirmedError(tradeId);
    }

    const newTradeRes = await client.query<{ id: string }>(
      `insert into retrospeq.trades
         (user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
          entry_price_avg, exit_price_avg, peak_volume, initial_stop, risk_pct, initial_risk_pct, r_multiple,
          realized_pnl, currency, hold_seconds, outcome,
          grouping_confidence, grouping_signals, grouping_source, ambiguity_resolved_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
               'confident_single', '{}'::jsonb, 'user_split', $21)
       returning id`,
      [
        state.userId,
        state.accountId,
        state.blockId,
        state.instrument,
        group2.facts.direction,
        group2.openedAt,
        group2.closedAt,
        group2.serverDay,
        group2.status,
        group2.facts.entryPriceAvg,
        group2.facts.exitPriceAvg,
        group2.facts.peakVolume,
        group2.facts.initialStop,
        group2.facts.riskPct,
        group2.facts.initialRiskPct,
        group2.facts.rMultiple,
        group2.facts.realizedPnl,
        group2.facts.currency,
        group2.facts.holdSeconds,
        group2.facts.outcome,
        now,
      ],
    );
    const newTradeId = newTradeRes.rows[0].id;

    // Reassign ONLY the second subset's trade_fills rows -- see header
    // judgment call #6 for the proof that the first subset's own
    // trade_id/role are already correct and need no write.
    for (const member of group2.members) {
      const res = await client.query(
        `update retrospeq.trade_fills set trade_id = $1, role = $2 where trade_id = $3 and fill_id = $4`,
        [newTradeId, member.role, tradeId, member.fillId],
      );
      if ((res.rowCount ?? 0) !== 1) {
        throw new Error(
          `splitTrade: expected exactly one trade_fills row for fill ${member.fillId} on trade ${tradeId}, affected ${res.rowCount} -- should be structurally impossible.`,
        );
      }
    }

    return { originalTradeId: tradeId, newTradeId, blockId: state.blockId };
  });
}

// ---------------------------------------------------------------------
// joinTrades
// ---------------------------------------------------------------------

export class JoinTradeNotFoundError extends Error {
  constructor(tradeId: string) {
    super(`joinTrades: no retrospeq.trades row for id ${tradeId} owned by the calling user.`);
    this.name = 'JoinTradeNotFoundError';
  }
}

export class JoinTradeAlreadyConfirmedError extends Error {
  constructor(tradeId: string) {
    super(
      `joinTrades: trade ${tradeId} is already confirmed -- manual join is allowed before freeze only (Module 02 §4.7).`,
    );
    this.name = 'JoinTradeAlreadyConfirmedError';
  }
}

export class JoinTradeDifferentBlockError extends Error {
  constructor(tradeIdA: string, tradeIdB: string) {
    super(`joinTrades: trades ${tradeIdA} and ${tradeIdB} do not share the same block -- join requires the same block (Module 02 §4.7).`);
    this.name = 'JoinTradeDifferentBlockError';
  }
}

export class JoinTradeSameTradeError extends Error {
  constructor(tradeId: string) {
    super(`joinTrades: cannot join trade ${tradeId} with itself.`);
    this.name = 'JoinTradeSameTradeError';
  }
}

export interface JoinTradesResult {
  survivingTradeId: string;
  absorbedTradeId: string;
  blockId: string;
}

interface JoinTradeRow {
  id: string;
  user_id: string;
  account_id: string;
  block_id: string;
  instrument: string;
  opened_at: string;
  confirmed_at: string | null;
}

interface JoinValidatedState {
  survivor: JoinTradeRow;
  absorbed: JoinTradeRow;
}

async function loadAndValidateJoin(
  client: PoolClient,
  tradeIdA: string,
  tradeIdB: string,
  scopeToUserId: string | null,
): Promise<JoinValidatedState> {
  const res = await client.query<JoinTradeRow>(
    scopeToUserId
      ? `select id, user_id, account_id, block_id, instrument, opened_at, confirmed_at
           from retrospeq.trades where id = any($1::uuid[]) and user_id = $2`
      : `select id, user_id, account_id, block_id, instrument, opened_at, confirmed_at
           from retrospeq.trades where id = any($1::uuid[])`,
    scopeToUserId ? [[tradeIdA, tradeIdB], scopeToUserId] : [[tradeIdA, tradeIdB]],
  );
  const byId = new Map(res.rows.map((r) => [r.id, r]));
  const a = byId.get(tradeIdA);
  const b = byId.get(tradeIdB);
  if (!a) throw new JoinTradeNotFoundError(tradeIdA);
  if (!b) throw new JoinTradeNotFoundError(tradeIdB);
  if (a.confirmed_at !== null) throw new JoinTradeAlreadyConfirmedError(tradeIdA);
  if (b.confirmed_at !== null) throw new JoinTradeAlreadyConfirmedError(tradeIdB);
  if (a.block_id !== b.block_id) throw new JoinTradeDifferentBlockError(tradeIdA, tradeIdB);

  // Header judgment call #5 -- chronologically-earlier survives, tie-break
  // on id for a fully deterministic choice (opened_at collisions are
  // possible in principle -- e.g. two same-instant excursions -- even if
  // no current golden fixture produces one).
  const aTime = new Date(a.opened_at).getTime();
  const bTime = new Date(b.opened_at).getTime();
  const [survivor, absorbed] = aTime !== bTime ? (aTime < bTime ? [a, b] : [b, a]) : a.id < b.id ? [a, b] : [b, a];

  return { survivor, absorbed };
}

function compareRawRows(a: RawMemberRow, b: RawMemberRow): number {
  const delta = new Date(a.filled_at).getTime() - new Date(b.filled_at).getTime();
  if (delta !== 0) return delta;
  return a.fill_id < b.fill_id ? -1 : a.fill_id > b.fill_id ? 1 : 0;
}

/**
 * Module 02 §4.7 — manual join. Merges `tradeIdA`/`tradeIdB` (must share a
 * `block_id`, both unconfirmed) into one surviving trade, re-deriving roles
 * for the FULL merged member set (a member that was `role: 'exit'` on the
 * absorbed trade may become `add`/`trim` once merged — the whole point of
 * "recomputes"). See this file's header for the delete-trigger interaction
 * this function relies on, and the surviving-trade choice.
 */
export async function joinTrades(userId: string, tradeIdA: string, tradeIdB: string): Promise<JoinTradesResult> {
  uuidSchema.parse(userId);
  uuidSchema.parse(tradeIdA);
  uuidSchema.parse(tradeIdB);
  if (tradeIdA === tradeIdB) throw new JoinTradeSameTradeError(tradeIdA);

  // Phase 1 -- withUserConnection, genuinely RLS-enforced. Read-only.
  await withUserConnection(userId, (client) => loadAndValidateJoin(client, tradeIdA, tradeIdB, userId));

  // Phase 2 -- withServiceRoleConnection, the actual restructuring.
  return withServiceRoleConnection(async (client) => {
    const { survivor, absorbed } = await loadAndValidateJoin(client, tradeIdA, tradeIdB, null);
    const account = await loadAccountContext(client, survivor.account_id);

    const survivorRows = await loadTradeMemberRows(client, survivor.id);
    const absorbedRows = await loadTradeMemberRows(client, absorbed.id);
    const merged = [...survivorRows, ...absorbedRows].sort(compareRawRows);

    // Defensive structural assertions -- see this file's header re:
    // "should be structurally impossible" reasoning for why a block can
    // never contribute more than one synthetic entry, or place it anywhere
    // but the merged set's own first member.
    const syntheticRows = merged.filter((r) => r.synthetic_entry_event);
    if (syntheticRows.length > 1) {
      throw new Error(
        `joinTrades: merged member set for trades ${survivor.id}/${absorbed.id} has ${syntheticRows.length} synthetic flip-opening entries -- should be structurally impossible (at most one per block).`,
      );
    }
    if (syntheticRows.length === 1 && !merged[0].synthetic_entry_event) {
      throw new Error(
        `joinTrades: the synthetic flip-opening entry for trades ${survivor.id}/${absorbed.id} is not the merged set's own chronologically-first member -- should be structurally impossible.`,
      );
    }

    const rawByFillId = new Map(merged.map((r) => [r.fill_id, r]));
    const group = recomputeGroup(merged.map(toGroupingInputFill), merged[0].synthetic_entry_event, rawByFillId, account);

    const now = new Date().toISOString();

    // Atomic, conditional -- retrospeq-security-reviewer FAIL, 2026-08-22.
    // Same reasoning as splitTrade's own guard above: without
    // `and confirmed_at is null`, a concurrent confirmDay/autoConfirmStaleTrades
    // call could freeze the survivor between this phase's own entry
    // re-validation and this UPDATE, and this UPDATE would still fire
    // unconditionally, rewriting a frozen trade's facts. The absorbed
    // trade's side is incidentally already safe (the later DELETE hits
    // forbid_broker_confirmed_trade_delete's own confirmed_at check and
    // aborts the whole transaction) -- this survivor-side guard was the
    // actual gap. Abort before any member reassignment/delete below if
    // this update loses the race.
    const survivorUpdateRes = await client.query(
      `update retrospeq.trades set ${TRADES_RECOMPUTE_SET_CLAUSE} where id = $1 and confirmed_at is null`,
      recomputeUpdateParams(survivor.id, group, 'user_join', now),
    );
    if ((survivorUpdateRes.rowCount ?? 0) !== 1) {
      throw new JoinTradeAlreadyConfirmedError(survivor.id);
    }

    // Reassign EVERY merged member's role/kind, moving the absorbed
    // trade's own rows onto the surviving trade id. Unlike split, there is
    // no "leave it alone" shortcut here -- a merge can genuinely change any
    // member's role, including ones that were already on the surviving
    // trade.
    for (const member of group.members) {
      if (member.syntheticEntryEvent) {
        const res = await client.query(
          `update retrospeq.trade_events set trade_id = $1, kind = $2 where trade_id = any($3::uuid[]) and fill_id = $4`,
          [survivor.id, member.role, [survivor.id, absorbed.id], member.fillId],
        );
        if ((res.rowCount ?? 0) !== 1) {
          throw new Error(
            `joinTrades: expected exactly one trade_events row for fill ${member.fillId}, affected ${res.rowCount} -- should be structurally impossible.`,
          );
        }
      } else {
        const res = await client.query(
          `update retrospeq.trade_fills set trade_id = $1, role = $2 where trade_id = any($3::uuid[]) and fill_id = $4`,
          [survivor.id, member.role, [survivor.id, absorbed.id], member.fillId],
        );
        if ((res.rowCount ?? 0) !== 1) {
          throw new Error(
            `joinTrades: expected exactly one trade_fills row for fill ${member.fillId}, affected ${res.rowCount} -- should be structurally impossible.`,
          );
        }
      }
    }

    // The absorbed trade now has ZERO backing trade_fills/trade_events rows
    // -- forbid_broker_confirmed_trade_delete's exists-checks both find
    // nothing and permit this delete regardless of the absorbed trade's
    // original provenance. See this file's header for the full reasoning.
    await client.query(`delete from retrospeq.trades where id = $1`, [absorbed.id]);

    return { survivingTradeId: survivor.id, absorbedTradeId: absorbed.id, blockId: survivor.block_id };
  });
}

// ---------------------------------------------------------------------
// resolveAmbiguousGroupingAsSingle
// ---------------------------------------------------------------------

/**
 * Design-ethics fix (retrospeq-qa finding on Module 02 Slice 7b,
 * 2026-08-23) -- `GroupingChip.tsx`'s ambient grouping question ("Is this
 * add part of the same trade?") is a `.rq-btn--equal` pair
 * (design-system rule: no primary/secondary distinction between the two
 * options). Slice 7b wired "Separate" to a real deep link into
 * `SplitControl`, but left "Same trade" disabled, because no write existed
 * that resolves an ALREADY-correctly-grouped ambiguous trade's own VERDICT
 * to `confident_single` without also touching `trade_fills`/`trade_events`
 * membership -- `splitTrade`/`joinTrades` both require an explicit
 * boundary/counterpart trade and neither operates on "no boundary chosen."
 *
 * This function is deliberately the SIMPLEST of the three corrections
 * operations in this file: unlike `splitTrade`/`joinTrades`, it never
 * touches `trade_fills`/`trade_events` at all. The trader is not telling
 * the system anything new about which fills belong together -- the
 * automatic grouping already put the right fills on the right trade, the
 * trader is only resolving the QUESTION ("is this ambiguous grouping
 * actually one trade?") to "yes." So the entire operation is one guarded
 * `UPDATE ... trades SET grouping_confidence = 'confident_single', ...`,
 * with no member reassignment, no new trade row, no delete -- the same
 * three writes `splitTrade`/`joinTrades` already make to the *grouping
 * provenance* columns on every trade they touch (see this file's header,
 * judgment call #1), applied here on their own without the restructuring
 * that normally accompanies them.
 *
 * Because there is no membership restructuring, there is also no need for
 * `splitTrade`/`joinTrades`' two-phase `withUserConnection` ->
 * `withServiceRoleConnection` split for its OWN sake (that split exists
 * because `trade_fills`/`trade_events` have no client-role UPDATE policy
 * at all -- see this file's header). This function still follows the same
 * shape anyway, for two reasons worth being explicit about: (1) it is the
 * established convention every trade-state-mutating operation in this file
 * uses, and a lone exception would be a real, unexplained inconsistency,
 * not a simplification; (2) phase 1 (`withUserConnection`) is still the
 * only place ownership is genuinely RLS-enforced against the caller's own
 * session -- `trades_owner`'s `for all using (user_id = auth.uid())`
 * policy would in principle let an authenticated-role UPDATE succeed
 * directly, but every other write in this file goes through the
 * service-role connection for its actual mutation, and diverging here
 * would mean this is the only trade-mutating function in the file NOT
 * doing so, for no functional gain.
 */

export class ResolveAmbiguousGroupingNotFoundError extends Error {
  constructor(tradeId: string) {
    super(`resolveAmbiguousGroupingAsSingle: no retrospeq.trades row for id ${tradeId} owned by the calling user.`);
    this.name = 'ResolveAmbiguousGroupingNotFoundError';
  }
}

export class ResolveAmbiguousGroupingAlreadyConfirmedError extends Error {
  constructor(tradeId: string) {
    super(
      `resolveAmbiguousGroupingAsSingle: trade ${tradeId} is already confirmed -- this correction is allowed before freeze only (Module 02 §4.7's "before freeze only" posture, matching manual split/join).`,
    );
    this.name = 'ResolveAmbiguousGroupingAlreadyConfirmedError';
  }
}

export class ResolveAmbiguousGroupingNotAmbiguousError extends Error {
  constructor(tradeId: string, actualConfidence: string) {
    super(
      `resolveAmbiguousGroupingAsSingle: trade ${tradeId} has grouping_confidence '${actualConfidence}', not 'ambiguous' -- this operation only resolves a trade that is actually asking the question (Module 02 §4.3's confidence bands); calling it on an already-confident trade is a caller error, not a legitimate no-op.`,
    );
    this.name = 'ResolveAmbiguousGroupingNotAmbiguousError';
  }
}

export interface ResolveAmbiguousGroupingResult {
  tradeId: string;
}

interface ResolveAmbiguousGroupingValidatedState {
  tradeId: string;
}

/** Shared by both phases, same reasoning as `loadAndValidateSplit`/
 *  `loadAndValidateJoin` above -- a race that only manifests in phase 2
 *  surfaces identically to a phase-1 rejection. */
async function loadAndValidateResolveAmbiguous(
  client: PoolClient,
  tradeId: string,
  scopeToUserId: string | null,
): Promise<ResolveAmbiguousGroupingValidatedState> {
  const res = await client.query<{ id: string; confirmed_at: string | null; grouping_confidence: string }>(
    scopeToUserId
      ? `select id, confirmed_at, grouping_confidence from retrospeq.trades where id = $1 and user_id = $2`
      : `select id, confirmed_at, grouping_confidence from retrospeq.trades where id = $1`,
    scopeToUserId ? [tradeId, scopeToUserId] : [tradeId],
  );
  const trade = res.rows[0];
  if (!trade) throw new ResolveAmbiguousGroupingNotFoundError(tradeId);
  if (trade.confirmed_at !== null) throw new ResolveAmbiguousGroupingAlreadyConfirmedError(tradeId);
  if (trade.grouping_confidence !== 'ambiguous') {
    throw new ResolveAmbiguousGroupingNotAmbiguousError(tradeId, trade.grouping_confidence);
  }
  return { tradeId: trade.id };
}

/**
 * Module 02 §4.3/§4.7 -- resolves an `ambiguous` trade's grouping VERDICT to
 * `confident_single`, with no change to trade membership. See this
 * function's own header comment above for the full reasoning and why this
 * is intentionally the simplest of the three corrections operations in
 * this file.
 */
export async function resolveAmbiguousGroupingAsSingle(
  userId: string,
  tradeId: string,
): Promise<ResolveAmbiguousGroupingResult> {
  uuidSchema.parse(userId);
  uuidSchema.parse(tradeId);

  // Phase 1 -- withUserConnection, genuinely RLS-enforced. Read-only.
  await withUserConnection(userId, (client) => loadAndValidateResolveAmbiguous(client, tradeId, userId));

  // Phase 2 -- withServiceRoleConnection. Re-validates from scratch (the
  // same defensive re-check posture `splitTrade`/`joinTrades` use), then
  // performs the one guarded write.
  return withServiceRoleConnection(async (client) => {
    const state = await loadAndValidateResolveAmbiguous(client, tradeId, null);

    // Atomic, conditional -- same concurrency-guard shape
    // `splitTrade`/`joinTrades`/`confirmDay` already use (`and confirmed_at
    // is null` in the WHERE clause itself, `rowCount` checked, the
    // already-confirmed error thrown on a lost race), deliberately applied
    // here from the start rather than risking the exact unguarded-UPDATE
    // bug class retrospeq-security-reviewer already found and fixed twice
    // this session in `splitTrade`/`joinTrades` (see this file's own
    // inline comments on those two UPDATEs). A concurrent
    // confirmDay/autoConfirmStaleTrades call could freeze this trade
    // between phase 1 committing (or this phase's own re-validation read
    // above) and this UPDATE; without the guard, that UPDATE would still
    // fire unconditionally, silently rewriting grouping_confidence/
    // grouping_signals/ambiguity_resolved_at on a now-frozen trade -- a
    // direct violation of "rule evaluations freeze at close-out and are
    // never recomputed retroactively."
    const updateRes = await client.query(
      `update retrospeq.trades
          set grouping_confidence = 'confident_single',
              grouping_signals = '{}'::jsonb,
              grouping_source = 'user_confirmed_single',
              ambiguity_resolved_at = now()
        where id = $1 and confirmed_at is null`,
      [state.tradeId],
    );
    if ((updateRes.rowCount ?? 0) !== 1) {
      throw new ResolveAmbiguousGroupingAlreadyConfirmedError(state.tradeId);
    }

    return { tradeId: state.tradeId };
  });
}
