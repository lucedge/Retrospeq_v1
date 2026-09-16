import { getSubscription } from '@/lib/entitlements/subscription-repository';
import { canForUser } from '@/lib/entitlements/service';
import { accountConnectLimitMessage, ruleCreateLimitMessage } from '@/lib/entitlements/messages';
import { devEntitlementToolsEnabled } from '@/lib/entitlements/dev-tools-guard';
import { createClient } from '@/lib/supabase/server';
import type { EntitlementResult } from '@/lib/entitlements/types';
import { requestBillingPortal, devSetPlan } from './actions';
import { usageDisplay, usageLabel, type UsageDisplay } from './usage';

/**
 * Module 01 §5.1 "Plan screen", built against frame 6.7
 * (`brand/docs/screens/account.html#6.7`): "fractions, never a bare
 * percentage. The upgrade prompt is generated from the trader's own
 * history, never generic. Price is a placeholder until the owner sets
 * it."
 *
 * Every cap in Module 01 §4.3's table now has a real usage counter
 * wired into `lib/entitlements/service.ts` (accounts, rules, hard
 * rules, strategies, custom fields), so these fractions are counted,
 * not asserted — this page's earlier "usage isn't shown here yet" note
 * predated those counters and is gone. Where a cap has no fraction to
 * show (unlimited on Pro, or a cap of exactly 0, which is a plan
 * exclusion and carries no count) the row says which, never "0 of 0"
 * (see `usage.ts`).
 *
 * The frame's second sentence — "Your history suggests four more" — is
 * still not built: it needs Module 05's rule-proposal signal, and
 * `lib/entitlements/messages.ts` deliberately ships the honest half of
 * that copy only. Inventory row 6.7 records it.
 */

interface UsageRow {
  key: string;
  label: string;
  display: UsageDisplay;
}

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

  const [subscription, accountEntitlement, ruleEntitlement, strategyEntitlement, fieldEntitlement] =
    await Promise.all([
      getSubscription(user.id),
      canForUser(user.id, 'account.connect'),
      canForUser(user.id, 'rules.create'),
      canForUser(user.id, 'strategy.create'),
      canForUser(user.id, 'fields.custom'),
    ]);
  const plan = subscription?.plan === 'pro' ? 'pro' : 'free';

  const rows: UsageRow[] = [
    { key: 'rules', label: 'Rules', display: usageDisplay(ruleEntitlement) },
    { key: 'accounts', label: 'Connected accounts', display: usageDisplay(accountEntitlement) },
    { key: 'strategies', label: 'Strategies', display: usageDisplay(strategyEntitlement) },
    { key: 'fields', label: 'Custom fields', display: usageDisplay(fieldEntitlement) },
  ];

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
    <section className="plan flex flex-col gap-5" aria-labelledby="plan-h">
      <div>
        <h1 id="plan-h" className="rq-h1">
          Your plan
        </h1>
        <p className="plan__current">{plan === 'pro' ? 'Pro' : 'Free'}</p>
      </div>

      {planUpdated && (
        <p className="hint" role="status">
          Plan updated.
        </p>
      )}
      {errorMessage && (
        <div className="alert alert--blocking">
          <p role="alert">{errorMessage}</p>
        </div>
      )}

      <ul className="usage">
        {rows.map((row) => (
          <UsageItem key={row.key} row={row} />
        ))}
      </ul>

      {plan === 'free' ? (
        <aside className="upgrade-prompt" data-analytic="upgrade.rulecap">
          <p>{upgradePrompt(ruleEntitlement, accountEntitlement)}</p>
          <p className="hint">
            Pro: unlimited rules, strategies and fields, judgment findings.{' '}
            <span className="price rq-num">$— / month</span>{' '}
            <span className="rq-tag rq-tag--muted">TODO(owner)</span>
          </p>
          <form action={requestBillingPortal}>
            <button type="submit" className="rq-btn">
              See Pro
            </button>
          </form>
        </aside>
      ) : (
        <form action={requestBillingPortal} className="auth__foot">
          <button type="submit" className="link">
            Billing portal
          </button>
        </form>
      )}

      {devEntitlementToolsEnabled() && (
        <div className="rq-well flex flex-col gap-3" data-testid="dev-plan-tool">
          <p className="hint">
            <strong>Dev only.</strong> Flips your own plan directly for testing the entitlement
            engine. This control does not exist outside development and is never a real billing
            action.
          </p>
          <div className="rq-btn-row">
            <form action={devSetPlan}>
              <input type="hidden" name="plan" value="free" />
              <button
                type="submit"
                className="rq-btn rq-btn--ghost rq-btn--block"
                disabled={plan === 'free'}
              >
                Set my plan to Free
              </button>
            </form>
            <form action={devSetPlan}>
              <input type="hidden" name="plan" value="pro" />
              <button
                type="submit"
                className="rq-btn rq-btn--ghost rq-btn--block"
                disabled={plan === 'pro'}
              >
                Set my plan to Pro
              </button>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}

function UsageItem({ row }: { row: UsageRow }) {
  const { display } = row;
  return (
    <li className="usage__item" data-at-limit={display.kind === 'fraction' && display.atLimit}>
      <span className="usage__label">{row.label}</span>
      <span className="usage__value rq-num">
        {display.kind === 'fraction' ? (
          <>
            <strong>{display.used}</strong> of {display.limit}
          </>
        ) : (
          usageLabel(display)
        )}
      </span>
      {/* The bar is the same fraction, drawn — never a second, different
          number, and never rendered at all when there is no fraction. */}
      {display.kind === 'fraction' && (
        <progress value={display.used} max={display.limit} aria-label={`${row.label} used`} />
      )}
    </li>
  );
}

/** Frame 6.7's prompt is "generated from the trader's own history, never
 *  generic": the first cap actually reached names itself with its own
 *  real numbers. With nothing at a cap yet there is no such fact, so the
 *  copy states what Pro changes instead of inventing pressure. */
function upgradePrompt(rules: EntitlementResult, accounts: EntitlementResult): string {
  if (rules.reason === 'quota' && rules.limit !== null && rules.used !== undefined) {
    return ruleCreateLimitMessage(rules.used, rules.limit);
  }
  if (accounts.reason === 'quota' && accounts.limit !== null && accounts.used !== undefined) {
    return accountConnectLimitMessage(accounts.used, accounts.limit);
  }
  return 'Upgrading removes the account limit and unlocks strategies, custom fields, rules beyond the free cap, and judgment findings.';
}
