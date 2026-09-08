import 'server-only';
import { withUserConnection } from '@/lib/supabase/direct';

/**
 * `retrospeq.user_cohorts` read — Module 05 §4.8's own "user in cohort"
 * term. RLS is owner-SELECT-only (docs/adr/0020) — genuine RLS-enforced
 * read under `withUserConnection`, no service role needed.
 *
 * `'beta_traders'` is the one cohort id this runtime currently checks —
 * a judgment call, not a literal spec value: neither `analytic_config`
 * nor Module 05 §4.8 names a specific cohort per analytic (the column is
 * a bare `cohort_only boolean`, with no cohort-name column alongside
 * it), and Module 01 §3.1's own `user_cohorts.cohort` comment gives
 * exactly one worked example (`'beta_traders'`) for what registry §4's
 * own "Cohort: Enable for the test cohort only" (singular, "the test
 * cohort") describes. Read as ONE designated cohort shared across every
 * `cohort_only`-gated analytic, not a per-analytic cohort name — flagged
 * here as the judgment call it is, revisit if a future slice needs
 * multiple named cohorts.
 */
const BETA_COHORT = 'beta_traders' as const;

export async function isUserInCohort(userId: string): Promise<boolean> {
  return withUserConnection(userId, async (client) => {
    const res = await client.query(
      `select 1 from retrospeq.user_cohorts where user_id = $1 and cohort = $2`,
      [userId, BETA_COHORT],
    );
    return res.rowCount !== null && res.rowCount > 0;
  });
}

export { BETA_COHORT };
