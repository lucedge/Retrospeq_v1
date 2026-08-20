import { getSubscription } from '@/lib/entitlements/subscription-repository';
import { canForUser } from '@/lib/entitlements/service';
import { accountConnectLimitMessage, formatUsageFraction } from '@/lib/entitlements/messages';
import { createClient } from '@/lib/supabase/server';
import { requestBillingPortal, devSetPlan } from './actions';

/**
 * Module 01 §5.1 "Plan screen": "current plan, usage against caps as
 * fractions ('3 of 3 rules'), upgrade with the data-derived prompt,
 * billing portal link." §5.2's reference markup is the template this
 * follows, adapted to this repo's real design-system selectors (the
 * same kind of adaptation `app/(app)/accounts/connect/page.tsx` already
 * made from `.segmented`/`.field` to `.rq-pills`/real form styling).
 *
 * Only `account.connect` is rendered as a real, checkable fraction —
 * the only capability this slice can compute for real (see
 * `lib/entitlements/can.ts`'s own doc comment). Every other capability
 * in Module 01 §4.3's table belongs to a module that doesn't exist yet
 * (Rulebook, Strategy, Analytics, Graduation) — rather than fabricate a
 * fraction for a resource with no backing table, this screen states
 * plainly what Free vs Pro means for those without pretending to know a
 * trader's current usage of them (AGENTS.md "never fake it" / "'Not
 * enough data yet' is a correct, intended state — not an error, not a
 * bug").
 */
export default async function PlanPage(props: PageProps<'/plan'>) {
  const searchParams = await props.searchParams;
  const errorCode = typeof searchParams.error === 'string' ? searchParams.error : undefined;
  const planUpdated = searchParams.planUpdated === '1';

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <p className="rq-sub" role="alert">
        Your session expired. Please sign in again.
      </p>
    );
  }

  const subscription = await getSubscription(user.id);
  const plan = subscription?.plan === 'pro' ? 'pro' : 'free';
  const accountEntitlement = await canForUser(user.id, 'account.connect');

  const errorMessage =
    errorCode === 'BILLING_NOT_CONFIGURED'
      ? "Billing isn't connected yet — there's no payment provider configured for this environment. Upgrades and billing management aren't available until that's set up."
      : errorCode === 'PLAN_RATE_LIMITED'
        ? 'Too many attempts. Please wait a few minutes and try again.'
        : errorCode === 'PLAN_INVALID'
          ? 'Something went wrong. Please try again.'
          : errorCode === 'DEV_TOOL_DISABLED'
            ? undefined // never shown — this code cannot occur outside dev, and the dev tool itself is hidden there
            : errorCode
              ? 'Something went wrong. Please try again.'
              : undefined;

  return (
    <section className="flex flex-col gap-8" aria-labelledby="plan-h">
      <h1 id="plan-h" className="rq-h1">
        Your plan
      </h1>
      <p className="plan__current rq-body">{plan === 'pro' ? 'Pro' : 'Free'}</p>

      {planUpdated && (
        <p className="rq-sub" role="status">
          Plan updated.
        </p>
      )}
      {errorMessage && (
        <p className="rq-sub" role="alert">
          {errorMessage}
        </p>
      )}

      <ul className="usage flex flex-col gap-4">
        <li
          className="usage__item rq-well flex flex-col gap-2"
          data-at-limit={!accountEntitlement.allowed && accountEntitlement.reason === 'quota'}
        >
          <div className="flex items-center justify-between">
            <span className="usage__label rq-label">Connected accounts</span>
            <span className="usage__value rq-num">
              {formatUsageFraction(accountEntitlement.used ?? 0, accountEntitlement.limit)}
            </span>
          </div>
          {accountEntitlement.limit !== null && (
            <progress
              value={accountEntitlement.used ?? 0}
              max={accountEntitlement.limit}
              aria-label="Accounts connected"
              className="w-full"
            />
          )}
        </li>
      </ul>

      <div className="rq-well flex flex-col gap-2">
        <h2 className="rq-h2">What each plan includes</h2>
        <dl className="flex flex-col gap-2">
          <div className="flex justify-between gap-4">
            <dt className="rq-sub">Connected accounts</dt>
            <dd className="rq-sub">Free: 1 · Pro: unlimited</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="rq-sub">Rules</dt>
            <dd className="rq-sub">Free: 3 (soft only) · Pro: unlimited, up to 6 hard</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="rq-sub">Strategies &amp; custom fields</dt>
            <dd className="rq-sub">Free: none · Pro: unlimited</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="rq-sub">Judgment analytics &amp; graduation</dt>
            <dd className="rq-sub">Free: not included · Pro: included</dd>
          </div>
        </dl>
        <p className="rq-sub">
          Rules, strategies, and analytics usage aren&apos;t shown here yet — those features
          ship in a later slice of this build. This is not enough data to show a fraction for
          them, which is a correct, intended state, not an error.
        </p>
      </div>

      {plan === 'free' ? (
        <aside className="rq-cost flex flex-col gap-3" data-analytic="upgrade.rulecap">
          <p className="rq-body">
            {accountEntitlement.reason === 'quota' && accountEntitlement.limit !== null
              ? accountConnectLimitMessage(accountEntitlement.used ?? accountEntitlement.limit, accountEntitlement.limit)
              : 'Upgrading removes the account-connection limit and unlocks strategies, rules beyond the free cap, and judgment analytics.'}
          </p>
          <form action={requestBillingPortal}>
            <button type="submit" className="rq-btn">
              Upgrade to Pro
            </button>
          </form>
        </aside>
      ) : (
        <form action={requestBillingPortal}>
          <button type="submit" className="rq-btn">
            Manage billing
          </button>
        </form>
      )}

      {process.env.NODE_ENV !== 'production' && (
        <div className="rq-well flex flex-col gap-3" data-testid="dev-plan-tool">
          <p className="rq-sub">
            <strong>Dev only.</strong> Flips your own plan directly for testing the entitlement
            engine. This control does not exist outside development and is never a real billing
            action.
          </p>
          <div className="flex gap-2">
            <form action={devSetPlan}>
              <input type="hidden" name="plan" value="free" />
              <button type="submit" className="rq-btn rq-btn--ghost" disabled={plan === 'free'}>
                Set my plan to Free
              </button>
            </form>
            <form action={devSetPlan}>
              <input type="hidden" name="plan" value="pro" />
              <button type="submit" className="rq-btn rq-btn--ghost" disabled={plan === 'pro'}>
                Set my plan to Pro
              </button>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
