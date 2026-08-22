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
