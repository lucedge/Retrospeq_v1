'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { enforceRateLimit } from '@/lib/rate-limit/limiter';
import { getClientIp } from '@/lib/rate-limit/http';
import { RateLimitExceededError } from '@/lib/rate-limit/errors';
import { getSubscription, setUserPlanForTesting } from '@/lib/entitlements/subscription-repository';
import { BillingNotConfiguredError, getBillingPortalUrl } from '@/lib/entitlements/billing';
import { devSetPlanInputSchema } from '@/lib/entitlements/schemas';

/**
 * Module 01 stories 4.1-4.4 — the "Plan" screen's Server Actions.
 *
 * `requestBillingPortal` backs BOTH the free-plan "Upgrade to Pro" CTA
 * and the Pro-plan "Manage billing" link (§5.1 lists them as one
 * concept — "billing portal link" — and today they hit the identical
 * wall regardless of which button was clicked, since no billing
 * provider is configured at all yet, not just "no portal session for
 * this specific user"). Per AGENTS.md "never fake it": this NEVER
 * redirects anywhere that looks like a real checkout/portal page. It
 * fails loudly and redirects to an honest, clearly-labeled
 * "billing isn't connected yet" state on the same screen.
 */
export async function requestBillingPortal(_formData: FormData): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  try {
    await enforceRateLimit('billingPortal', await getClientIp(), user.id);
  } catch (err) {
    if (err instanceof RateLimitExceededError) {
      redirect('/plan?error=PLAN_RATE_LIMITED');
    }
    throw err;
  }

  const subscription = await getSubscription(user.id);

  try {
    // `getBillingPortalUrl` is typed `never` — it always throws today
    // (no billing provider configured, see that file's own doc
    // comment). The redirect-on-success line does not exist yet
    // because there is no success path to redirect to; add
    // `redirect(url)` here the moment a real provider is wired in.
    getBillingPortalUrl(user.id, subscription?.provider_ref ?? null);
  } catch (err) {
    if (err instanceof BillingNotConfiguredError) {
      redirect('/plan?error=BILLING_NOT_CONFIGURED');
    }
    throw err;
  }
}

/**
 * DEV/TEST-ONLY. Lets a developer exercise the entitlement engine
 * (caps, the account-cap downgrade/upgrade lifecycle) end-to-end
 * without a real billing provider. Refuses to run outside development —
 * defense in depth alongside `setUserPlanForTesting`'s own identical
 * guard (docs/adr/0008) and `subscriptions`' RLS itself (no client
 * write policy exists at all, so even a compromised/bypassed guard here
 * still could not write the table directly). NEVER surface this as an
 * ordinary product affordance — `app/(app)/plan/page.tsx` only renders
 * the form that calls this when `process.env.NODE_ENV !== 'production'`,
 * matching this function's own posture.
 */
export async function devSetPlan(formData: FormData): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    redirect('/plan?error=DEV_TOOL_DISABLED');
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  try {
    await enforceRateLimit('devSetPlan', await getClientIp(), user.id);
  } catch (err) {
    if (err instanceof RateLimitExceededError) {
      redirect('/plan?error=PLAN_RATE_LIMITED');
    }
    throw err;
  }

  const parsed = devSetPlanInputSchema.safeParse({ plan: formData.get('plan') });
  if (!parsed.success) {
    redirect('/plan?error=PLAN_INVALID');
  }

  await setUserPlanForTesting(user.id, parsed.data.plan);

  revalidatePath('/plan');
  revalidatePath('/accounts');
  redirect('/plan?planUpdated=1');
}
