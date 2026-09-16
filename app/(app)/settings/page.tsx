import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { listTradingAccounts } from '@/lib/broker/accounts-repository';
import { getSubscription } from '@/lib/entitlements/subscription-repository';
import { canForUser } from '@/lib/entitlements/service';
import { signOut } from '../../(auth)/actions';
import {
  accountsSummary,
  countAccountStatuses,
  planSummary,
  securitySummary,
} from './summaries';

/**
 * Settings index — the one entry point for account-level screens that
 * don't belong in Module 08 §7.5's four tabs (accounts, plan, security,
 * privacy) plus sign-out, which moved here from the old header chrome.
 * No new behaviour: every row links to an existing, already-reviewed
 * route; sign-out is the same `signOut` Server Action as before.
 *
 * Built against frame 6.4 (`brand/docs/screens/account.html#6.4`):
 * `.settings` rows, each previewing its own state ("1 connected · 1
 * needs attention") so the trader knows before tapping, and a ghost
 * "Sign out" bottom-pinned with `.push` — never this view's primary.
 * The previews are read from the same repositories the target screens
 * use, so nothing here can drift from what the row opens; where a
 * number genuinely isn't available (the frame's "2 sessions" — Supabase
 * exposes no session list) the clause is dropped, never invented.
 */

const CHEVRON = (
  <svg
    className="settings__chev"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m9 6 6 6-6 6" />
  </svg>
);

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // app/(app)/layout.tsx already redirects signed-out visitors to /login
  // before this page renders — `user` is only possibly null here if the
  // session expired between the layout's check and this render.
  if (!user) {
    return (
      <p className="rq-sub" role="alert">
        Your session expired. Please sign in again.
      </p>
    );
  }

  const [accounts, subscription, rules, factors] = await Promise.all([
    listTradingAccounts(user.id),
    getSubscription(user.id),
    canForUser(user.id, 'rules.create'),
    supabase.auth.mfa.listFactors(),
  ]);

  const plan = subscription?.plan === 'pro' ? 'pro' : 'free';
  const twoFactorOn = Boolean(factors.data?.totp.some((f) => f.status === 'verified'));

  const rows = [
    {
      href: '/accounts',
      label: 'Trading accounts',
      hint: accountsSummary(countAccountStatuses(accounts.map((a) => a.status))),
    },
    { href: '/plan', label: 'Plan', hint: planSummary(plan, rules.used, rules.limit) },
    { href: '/security', label: 'Security', hint: securitySummary(twoFactorOn) },
    { href: '/privacy', label: 'Privacy', hint: 'Export, delete, telemetry' },
  ];

  return (
    <section aria-labelledby="settings-h" className="settings-index flex flex-col gap-6">
      <h1 id="settings-h" className="rq-h1">
        Settings
      </h1>

      <ul className="settings">
        {rows.map((row) => (
          <li key={row.href}>
            <Link href={row.href}>
              <span className="settings__label">
                <b>{row.label}</b>
                <span>{row.hint}</span>
              </span>
              {CHEVRON}
            </Link>
          </li>
        ))}
      </ul>

      <form action={signOut} className="push">
        <button type="submit" className="rq-btn rq-btn--ghost rq-btn--block">
          Sign out
        </button>
      </form>
    </section>
  );
}
