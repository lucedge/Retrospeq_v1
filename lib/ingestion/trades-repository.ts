import 'server-only';
import { withUserConnection } from '@/lib/supabase/direct';
import { TRADE_COLUMNS, type TradeRow } from './corrections';

export type { TradeRow };

/**
 * Module 02 §5.1/§5.2 — read-only queries backing the trade list screen
 * (Slice 7a, 2026-08-22, the first Module 02 slice with a rendered
 * surface). Reuses `corrections.ts`'s own `TRADE_COLUMNS`/`TradeRow` —
 * one `trades` SELECT column list, not a second copy that could
 * silently drift from what `toggleNotADecision` already returns.
 *
 * Every function here is a plain owner-scoped SELECT under
 * `withUserConnection` — genuinely RLS-enforced (`SET LOCAL ROLE
 * authenticated` + `request.jwt.claims`, the same resolution path a real
 * PostgREST request uses), matching every other read in
 * `lib/broker/accounts-repository.ts`. No new RLS surface: `trades`'s
 * existing `trades_owner` "for all" policy and `trade_fills`/
 * `trade_events`'s existing owner SELECT policies (both established in
 * `20260822010000_ingestion_schema.sql`, Slice 1) already cover every
 * query below — nothing here needed a new migration.
 */

/** Module 02 §5.2's open-position card. Newest-opened first, so a
 *  trader who just entered sees their own position at the top — same
 *  "just happened, show it first" convention `listTradingAccounts`
 *  already uses for newly-connected accounts. */
export async function listOpenTrades(userId: string): Promise<TradeRow[]> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<TradeRow>(
      `select ${TRADE_COLUMNS}
         from retrospeq.trades
        where user_id = $1 and status = 'open'
        order by opened_at desc`,
      [userId],
    );
    return res.rows;
  });
}

/** Closed but not yet confirmed — the trade list's "review" bucket.
 *  `closed_at desc nulls last` is defensive only: a `status = 'closed'`
 *  row always has a real `closed_at` in this schema (§4.4's own
 *  invariant), the `nulls last` clause just avoids a surprising sort if
 *  that ever stops being true rather than silently mis-ordering. */
export async function listClosedUnconfirmedTrades(userId: string): Promise<TradeRow[]> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<TradeRow>(
      `select ${TRADE_COLUMNS}
         from retrospeq.trades
        where user_id = $1 and status = 'closed'
        order by closed_at desc nulls last, opened_at desc`,
      [userId],
    );
    return res.rows;
  });
}

/** Module 02 §11's "trade list, 50 rows < 300ms" performance budget is
 *  the reason for a default `limit` here — `confirmed` is the one
 *  status that grows without bound over a trader's whole history,
 *  unlike `open`/`closed` which are naturally small at any moment. */
const CONFIRMED_TRADES_DEFAULT_LIMIT = 50;

export async function listConfirmedTrades(
  userId: string,
  limit: number = CONFIRMED_TRADES_DEFAULT_LIMIT,
): Promise<TradeRow[]> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<TradeRow>(
      `select ${TRADE_COLUMNS}
         from retrospeq.trades
        where user_id = $1 and status = 'confirmed'
        order by confirmed_at desc nulls last, opened_at desc
        limit $2`,
      [userId, limit],
    );
    return res.rows;
  });
}

/**
 * Module 02 Slice 7b — the close-out screen's day list (§5.1/§5.2, "Blocked
 * while a coverage gap exists"). Unlike `listOpenTrades`/
 * `listClosedUnconfirmedTrades`/`listConfirmedTrades`, this is scoped to
 * ONE (account, server_day) pair across EVERY status — the close-out screen
 * needs to show the trader everything on that day, including a trade an
 * earlier partial confirm or auto-confirm already settled, honestly. This
 * mirrors exactly the set `lib/ingestion/confirm.ts`'s `confirmDay` itself
 * queries (`allTradesThisDay`) for its own assertions, so the screen and
 * the transaction it submits to never disagree about which trades are "in"
 * this day.
 */
export async function listTradesForAccountDay(
  userId: string,
  accountId: string,
  serverDay: string,
): Promise<TradeRow[]> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<TradeRow>(
      `select ${TRADE_COLUMNS}
         from retrospeq.trades
        where user_id = $1 and account_id = $2 and server_day = $3
        order by opened_at asc`,
      [userId, accountId, serverDay],
    );
    return res.rows;
  });
}

export interface TradeCaptureRow {
  tradeId: string;
  fieldId: string;
  value: unknown;
  moment: string;
}

/**
 * Every `trade_captures` row for a batch of trades, in one round trip —
 * the close-out screen derives BOTH facts it needs from this one query
 * (never a fabricated "Add now" editor, per this slice's own scope
 * boundary): whether a trade has ANY `moment = 'pre_entry'` row (the
 * "Pre-entry captured" chip), and the current `trim_reason` value if one
 * was already set (so re-visiting close-out shows what was already
 * chosen, not a blank chip row every time). RLS-scoped via
 * `withUserConnection` — `trade_captures_owner`'s real owner "for all"
 * policy (`20260822010000_ingestion_schema.sql`) already covers this read.
 */
export async function listTradeCaptures(userId: string, tradeIds: string[]): Promise<TradeCaptureRow[]> {
  if (tradeIds.length === 0) return [];
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{ trade_id: string; field_id: string; value: unknown; moment: string }>(
      `select trade_id, field_id, value, moment
         from retrospeq.trade_captures
        where trade_id = any($1::uuid[]) and user_id = $2`,
      [tradeIds, userId],
    );
    return res.rows.map((r) => ({ tradeId: r.trade_id, fieldId: r.field_id, value: r.value, moment: r.moment }));
  });
}

export interface JoinableTradeGroupMember {
  id: string;
  instrument: string;
  openedAt: string;
}

export interface JoinableTradeGroup {
  blockId: string;
  /** Chronological (`opened_at` ascending) — every entry shares one
   *  `block_id` and is unconfirmed. §4.7's "manual join... same block" is
   *  a two-trade operation (`joinTrades(userId, tradeIdA, tradeIdB)`), so a
   *  block hosting more than two candidate trades is offered to the UI as
   *  consecutive pairs, not a single N-way join — see
   *  `app/(app)/trades/page.tsx`'s own rendering of this list. */
  trades: JoinableTradeGroupMember[];
}

/**
 * Module 02 Slice 7b — the trade list's "Join with [instrument] at [time]"
 * control (§4.7: "Manual join | Before freeze only, same block | Merges,
 * recomputes"). Mirrors `joinTrades`'s own eligibility precondition
 * exactly (`confirmed_at is null`, `split-join.ts`'s `loadAndValidateJoin`)
 * so this list never offers a pairing the backend would reject on freeze
 * grounds — grouped by `block_id` in JS rather than SQL (`array_agg`)
 * since the set size per user is small and this keeps the query itself
 * trivial to audit against RLS, same posture as `page.tsx`'s own
 * `membersByTrade` grouping.
 */
export async function listJoinableTradeGroups(userId: string): Promise<JoinableTradeGroup[]> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{ block_id: string; id: string; instrument: string; opened_at: string }>(
      `select block_id, id, instrument, opened_at
         from retrospeq.trades
        where user_id = $1 and confirmed_at is null
        order by block_id, opened_at asc`,
      [userId],
    );
    const byBlock = new Map<string, JoinableTradeGroupMember[]>();
    for (const row of res.rows) {
      const entry = { id: row.id, instrument: row.instrument, openedAt: row.opened_at };
      const list = byBlock.get(row.block_id);
      if (list) list.push(entry);
      else byBlock.set(row.block_id, [entry]);
    }
    const groups: JoinableTradeGroup[] = [];
    for (const [blockId, trades] of byBlock) {
      if (trades.length > 1) groups.push({ blockId, trades });
    }
    return groups;
  });
}

export interface TradeMemberRow {
  tradeId: string;
  fillId: string;
  role: string;
  side: 'buy' | 'sell';
  volume: string;
  price: string;
  filledAt: string;
  syntheticEntryEvent: boolean;
}

/**
 * Every fill / ADR-0001 synthetic flip-opening entry backing every trade
 * in `tradeIds`, in ONE batched query — avoids an N+1 round trip per
 * expandable row on the trade list. Same `trade_fills`/`fills` UNION
 * `trade_events`/`fills` shape `lib/ingestion/split-join.ts`'s
 * `loadTradeMemberRows` already established for "every current member of
 * a trade, physical or synthetic" (see that file's own header for why a
 * synthetic entry's own `trade_events` `price`/`volume`/`occurred_at`
 * are used, never the underlying fill's full printed volume) — extended
 * here to cover MANY trades in one call (`trade_id`/`fill_id` both in
 * the SELECT list, `= any($1::uuid[])` instead of `= $1`) rather than
 * reimplemented.
 *
 * `and tf.user_id = $2` / `and te.user_id = $2` is belt-and-braces
 * alongside RLS's own identical `user_id = auth.uid()` policies on both
 * tables — the same "two independent, redundant checks of the same
 * fact" posture `corrections.ts`'s own header names explicitly, not a
 * substitute for RLS.
 */
export async function listTradeMembers(userId: string, tradeIds: string[]): Promise<TradeMemberRow[]> {
  if (tradeIds.length === 0) return [];
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{
      trade_id: string;
      fill_id: string;
      role: string;
      side: 'buy' | 'sell';
      volume: string;
      price: string;
      filled_at: string;
      synthetic_entry_event: boolean;
    }>(
      `select tf.trade_id as trade_id, f.id as fill_id, tf.role as role, f.side as side,
              f.volume as volume, f.price as price, f.filled_at as filled_at, false as synthetic_entry_event
         from retrospeq.trade_fills tf
         join retrospeq.fills f on f.id = tf.fill_id
        where tf.trade_id = any($1::uuid[]) and tf.user_id = $2

        union all

       select te.trade_id as trade_id, f.id as fill_id, te.kind as role, f.side as side,
              te.volume as volume, te.price as price, te.occurred_at as filled_at, true as synthetic_entry_event
         from retrospeq.trade_events te
         join retrospeq.fills f on f.id = te.fill_id
        where te.trade_id = any($1::uuid[]) and te.user_id = $2

        order by trade_id, filled_at, fill_id`,
      [tradeIds, userId],
    );
    return res.rows.map((r) => ({
      tradeId: r.trade_id,
      fillId: r.fill_id,
      role: r.role,
      side: r.side,
      volume: r.volume,
      price: r.price,
      filledAt: r.filled_at,
      syntheticEntryEvent: r.synthetic_entry_event,
    }));
  });
}
