import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { listTradingAccounts } from '@/lib/broker/accounts-repository';
import { ManualEntryForm } from './ManualEntryForm';

/**
 * Module 02 §4.8's manual-entry screen (Slice 7b). Only ever offers
 * `platform === 'manual'` accounts — `manualTradeInputSchema`/
 * `createManualTrade` reject anything else with
 * `ManualEntryNotManualPlatformError`, so this page filters up front
 * rather than letting a trader pick a broker-connected account and hit a
 * server error. If the signed-in user has zero manual accounts, this
 * shows an honest state pointing at `/accounts/connect` instead of a form
 * with nothing valid to submit against — AGENTS.md's "never fake it"
 * applied to "don't render a form that can only fail."
 */
export default async function ManualEntryPage() {
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

  const accounts = await listTradingAccounts(user.id);
  const manualAccounts = accounts.filter((a) => a.platform === 'manual');

  if (manualAccounts.length === 0) {
    return (
      <section className="flex flex-col gap-4" aria-labelledby="manual-entry-h">
        <h1 id="manual-entry-h" className="rq-h1">
          Log a trade by hand
        </h1>
        <p className="rq-sub">
          Manual entry needs a manual account — you don&apos;t have one yet.{' '}
          <Link href="/accounts/connect" className="underline">
            Add a manual account
          </Link>{' '}
          first.
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-6" aria-labelledby="manual-entry-h">
      <h1 id="manual-entry-h" className="rq-h1">
        Log a trade by hand
      </h1>
      <ManualEntryForm accounts={manualAccounts.map((a) => ({ id: a.id, label: a.label }))} />
    </section>
  );
}
