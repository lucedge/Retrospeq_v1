import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { listTradingAccounts } from '@/lib/broker/accounts-repository';
import { AmbientAccountNotFoundError, getAmbientAccountState, type AmbientAccountState } from '@/lib/rules/ambient-state';
import { ManualEntryScreen } from './ManualEntryScreen';

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
 *
 * Module 04 §5.9 UI (Slice 10d) added the ambient strip to this screen —
 * story 3.5's own framing ("account facts visible before I enter") points
 * squarely at "before I enter a trade," and this is this repo's only such
 * screen today. `getAmbientAccountState` is called once here, server-side,
 * for the default (first) manual account, so the strip has real data on
 * first paint rather than a loading flash — `ManualEntryScreen.tsx` (the
 * client half) re-fetches via a Server Action every time the trader
 * switches which account they're entering against, since that selection
 * is made inside the client-rendered form.
 *
 * **SSR ambient read is wrapped, deliberately mirroring `fetchAmbientState`'s
 * own catch (`app/(app)/rules/actions.ts`) rather than a new approach** —
 * `getAmbientAccountState` (`lib/rules/ambient-state.ts`) deliberately does
 * NOT catch `RuleEvaluationError` internally (see that file's own header: a
 * malformed rule is a real, if rare, data-corruption signal meant to
 * surface loudly, not be silently absorbed). Left unwrapped here, that
 * throw would hit Next's default RSC error page and take down the ENTIRE
 * manual-entry screen — directly contradicting §5.9's "rules never block
 * trading" premise at the page level (this repo has no `error.tsx`
 * anywhere, so there is no framework-level safety net for that today; see
 * `docs/runbook.md`'s ambient-strip entry, flagged as a real gap by both
 * the coder and the independent tester before this fix). The catch below
 * degrades ONLY the ambient section (`ManualEntryScreen` already renders
 * `initialAmbientError` through the SAME `ambientError` UI its live
 * account-switch re-fetch already uses) — the rest of the form (account
 * picker, instrument/size/price fields, submit) stays fully usable.
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

  const defaultAccountId = manualAccounts[0].id;

  let initialAmbient: AmbientAccountState | null = null;
  let initialAmbientError: string | null = null;
  try {
    initialAmbient = await getAmbientAccountState(user.id, defaultAccountId);
  } catch (err) {
    // Same mapping `fetchAmbientState` already uses, verbatim -- see this
    // file's own header for why this exists and why it's a mirror, not a
    // new pattern.
    if (err instanceof AmbientAccountNotFoundError) {
      initialAmbientError = "We couldn't find that account.";
    } else {
      console.error('[trades/manual-entry:page] initial getAmbientAccountState read failed:', err);
      initialAmbientError = 'Account state is unavailable right now. Please try again.';
    }
  }

  return (
    <section className="flex flex-col gap-6" aria-labelledby="manual-entry-h">
      <h1 id="manual-entry-h" className="rq-h1">
        Log a trade by hand
      </h1>
      <ManualEntryScreen
        accounts={manualAccounts.map((a) => ({ id: a.id, label: a.label }))}
        initialAccountId={defaultAccountId}
        initialAmbient={initialAmbient}
        initialAmbientError={initialAmbientError}
      />
    </section>
  );
}
