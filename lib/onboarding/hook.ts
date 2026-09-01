import 'server-only';
import { withUserConnection } from '@/lib/supabase/direct';

/**
 * Module 08 (Onboarding & Home) §5.2 -- Slice 08b. Backs the honest-
 * fallback Hook screen (`app/(app)/onboarding/hook/page.tsx`) — this
 * dispatch's ONLY buildable Hook variant, see that page's own header for
 * why the real-finding path (§5.2's "Across your last 214 trades, Friday
 * afternoons lost money 68% of the time" branch) cannot be built until
 * Module 05 exists.
 *
 * "We've imported N trades" needs the count of trades a real broker sync
 * actually wrote — every `trades` row belonging to one of the trader's own
 * NON-MANUAL (broker-synced) accounts, regardless of confirmation status.
 * This is deliberately NOT `unlock_state.trades_confirmed`
 * (`lib/onboarding/unlock-state-repository.ts`) — that counter is scoped
 * to CONFIRMED trades only (Module 02 §4.6's freeze point), a materially
 * different claim ("the trader has reviewed and closed these out") from
 * "the broker handed these over" (§5.2's own copy is explicitly about
 * import, not review).
 *
 * Manual-path accounts (`platform = 'manual'`) are excluded. A manual-path
 * trader never reaches this screen at all (Module 08 §5.6 — the onboarding
 * router, `lib/onboarding/router.ts`, sends `path = 'manual'` straight to
 * `/rules/start`), but excluding manual accounts here too keeps this count
 * honest even for a broker-path trader who ALSO happens to have a manual
 * account connected (Module 01 permits more than one account) — a manually
 * typed trade was never "imported" from anywhere.
 */
export async function countImportedTradesForUser(userId: string): Promise<number> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query<{ count: string }>(
      `select count(*)::text as count
         from retrospeq.trades t
         join retrospeq.trading_accounts a on a.id = t.account_id
        where t.user_id = $1
          and a.platform <> 'manual'`,
      [userId],
    );
    return Number(res.rows[0]?.count ?? '0');
  });
}
