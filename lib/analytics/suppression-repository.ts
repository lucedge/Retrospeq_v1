import 'server-only';
import { withUserConnection } from '@/lib/supabase/direct';

/**
 * `retrospeq.analytic_user_suppression` read — Module 05 §4.8's own
 * `suppressed(user, analytic_id)` term. RLS is standard owner "for all"
 * (this table is NOT one of Module 01 §3.3's two named exceptions, see
 * the migration's own header) — genuine RLS-enforced read under
 * `withUserConnection`.
 *
 * Existence of ANY row for `(userId, analyticId)` means suppressed,
 * regardless of `reason` — `declined_once`/`declined_twice`/
 * `user_hidden` are all "do not render this" states as far as
 * `canRender` is concerned; the DISTINCTION between them (and the
 * re-surfacing logic for `declined_once`, story 2.3: "dormant until
 * occurrences double") is detection-engine scope, a future slice, per
 * this slice's own dispatch — not built here.
 */
export async function isSuppressed(userId: string, analyticId: string): Promise<boolean> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query(
      `select 1 from retrospeq.analytic_user_suppression where user_id = $1 and analytic_id = $2`,
      [userId, analyticId],
    );
    return res.rowCount !== null && res.rowCount > 0;
  });
}
