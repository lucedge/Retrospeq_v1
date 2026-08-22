import 'server-only';
import { withUserConnection } from '@/lib/supabase/direct';

/**
 * Module 02 (Trade Ingestion & Model) §4.7 — corrections, the
 * `not_a_decision` toggle:
 *
 * "Mark `not_a_decision` | Always, before or after freeze | Stays in P&L,
 * excluded from edge analysis and findings. Plain toggle, no reason
 * required."
 *
 * ## Why this is `withUserConnection`, not `withServiceRoleConnection`
 * (unlike `sync.ts`/`confirm.ts`)
 *
 * `sync.ts`/`confirm.ts` are trusted BACKEND-PROCESS transactions (a
 * cron/API-route trigger, not a client request — see both files' own
 * headers) that also touch tables with no client write policy at all
 * (`blocks`, `trade_fills`, `day_closeouts`), so they run entirely under
 * `service_role` with every query explicitly scoped to the resolved
 * account/user (ADR 0005's caveat). This function is different in kind:
 * it is a genuine end-user-initiated write — a trader tapping a checkbox
 * on their own trade — against `trades`' existing owner "for all" RLS
 * policy (`trades_owner`, `20260822010000_ingestion_schema.sql`), which
 * already permits exactly this: `for all using (user_id = auth.uid())
 * with check (user_id = auth.uid())`. `withUserConnection` makes RLS
 * genuinely enforced here (`SET LOCAL ROLE authenticated` +
 * `request.jwt.claims`, the same resolution path a real PostgREST request
 * uses), not merely trusted at the application layer — the `WHERE id = $1
 * AND user_id = $2` clause below and the table's own RLS policy are two
 * independent, redundant checks of the same ownership fact.
 *
 * ## Interaction with the freeze trigger
 * (`retrospeq.forbid_frozen_trade_regrouping`,
 * `20260822040000_trades_freeze_regrouping_trigger.sql`)
 *
 * That trigger blocks every column change on a confirmed trade EXCEPT
 * `not_a_decision`, which it explicitly allowlists — this function's
 * UPDATE only ever touches that one column, so it always satisfies the
 * trigger regardless of `confirmed_at`, matching §4.7's "always, before
 * or after freeze" literally. See `trades-freeze-trigger.live.test.ts`
 * for the trigger's own allow/deny proof, and this file's own live test
 * for the proof that `toggleNotADecision` specifically still succeeds on
 * an already-confirmed trade.
 *
 * ## Scope
 *
 * No Server Action / UI wiring in this slice (Slice 7's job — the
 * `<label class="not-a-decision">` checkbox in Module 02 §5.2's reference
 * markup, and the review screen's "excluded count," per §4.7's own
 * closing sentence: "the excluded count is visible on the review screen,
 * which keeps the toggle self-policing"). This is the one repository
 * function a future Server Action calls.
 */

export interface TradeRow {
  id: string;
  user_id: string;
  account_id: string;
  block_id: string;
  instrument: string;
  direction: string;
  opened_at: string;
  closed_at: string | null;
  server_day: string;
  status: string;
  entry_price_avg: string | null;
  exit_price_avg: string | null;
  peak_volume: string | null;
  initial_stop: string | null;
  risk_pct: string | null;
  initial_risk_pct: string | null;
  r_multiple: string | null;
  realized_pnl: string | null;
  currency: string;
  hold_seconds: number | null;
  outcome: string | null;
  strategy_id: string | null;
  strategy_version: number | null;
  grouping_confidence: string;
  grouping_signals: Record<string, number>;
  grouping_source: string;
  ambiguity_resolved_at: string | null;
  not_a_decision: boolean;
  confirmed_at: string | null;
  confirmed_by: string | null;
  created_at: string;
}

/**
 * Exported (2026-08-22, Module 02 Slice 7a) so
 * `lib/ingestion/trades-repository.ts`'s read-only trade-list queries
 * reuse the exact same column list rather than maintaining a second,
 * driftable copy — one `trades` SELECT shape, not two.
 */
export const TRADE_COLUMNS = `
  id, user_id, account_id, block_id, instrument, direction, opened_at, closed_at, server_day, status,
  entry_price_avg, exit_price_avg, peak_volume, initial_stop, risk_pct, initial_risk_pct, r_multiple,
  realized_pnl, currency, hold_seconds, outcome, strategy_id, strategy_version,
  grouping_confidence, grouping_signals, grouping_source, ambiguity_resolved_at,
  not_a_decision, confirmed_at, confirmed_by, created_at
`;

/**
 * Toggles `trades.not_a_decision` for one trade owned by `userId`. Plain,
 * unconditional write — no reason field, no state-dependent branching
 * (§4.7: "Plain toggle, no reason required"), and no `confirmed_at` check
 * of its own, since it is allowed unconditionally either side of freeze.
 *
 * Returns `null` if the trade doesn't exist or isn't owned by `userId` —
 * same "not found / not yours -> null" convention as
 * `lib/broker/accounts-repository.ts`'s `updateTradingAccountSettings`,
 * rather than a thrown error, so a caller can render a plain "not found"
 * state without a try/catch.
 */
export async function toggleNotADecision(
  userId: string,
  tradeId: string,
  value: boolean,
): Promise<TradeRow | null> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<TradeRow>(
      `update retrospeq.trades
          set not_a_decision = $1
        where id = $2 and user_id = $3
        returning ${TRADE_COLUMNS}`,
      [value, tradeId, userId],
    );
    return res.rows[0] ?? null;
  });
}
