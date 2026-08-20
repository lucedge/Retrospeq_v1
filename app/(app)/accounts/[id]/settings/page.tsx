import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { getTradingAccount } from '@/lib/broker/accounts-repository';
import { AccountSettingsForm } from './AccountSettingsForm';

/**
 * Module 01 §2 stories 3.1-3.4 "Account settings" — reached from the
 * account list's "Settings" action (§5.1: "Actions: rename, settings,
 * disconnect"). A dedicated route rather than an inline edit on the
 * account card, per this slice's dispatch — the literal reading of
 * §5.1's three distinct named actions.
 *
 * Server component: fetches + ownership-checks the account (via
 * `getTradingAccount`, RLS-scoped the same way `listTradingAccounts`
 * is), then hands prefilled data to the interactive client form —
 * matches `app/(app)/security/page.tsx` + `SecurityScreenClient.tsx`'s
 * established split, not a new pattern.
 */
export default async function AccountSettingsPage(props: PageProps<'/accounts/[id]/settings'>) {
  const { id } = await props.params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // app/(app)/layout.tsx already redirects signed-out visitors to
  // /login before this page renders — `user` is only possibly null here
  // if the session expired between the layout's check and this render.
  if (!user) {
    return (
      <p className="rq-sub" role="alert">
        Your session expired. Please sign in again.
      </p>
    );
  }

  const account = await getTradingAccount(user.id, id);
  if (!account) {
    return (
      <section className="flex flex-col gap-4" aria-labelledby="settings-h">
        <h1 id="settings-h" className="rq-h1">
          Account settings
        </h1>
        <p className="rq-sub" role="alert">
          We couldn&apos;t find that account.
        </p>
        <Link href="/accounts" className="rq-btn rq-btn--ghost">
          Back to accounts
        </Link>
      </section>
    );
  }

  return <AccountSettingsForm accountId={id} account={account} />;
}
