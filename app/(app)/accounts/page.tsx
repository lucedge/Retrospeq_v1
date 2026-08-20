import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { listTradingAccounts, type TradingAccountRow } from '@/lib/broker/accounts-repository';
import { PLATFORM_LABELS } from '@/lib/broker/platform-defaults';
import { disconnectAccount } from './actions';

/**
 * Module 01 §5.1/§5.2 "Account list" — one card per connected account:
 * label, platform, status chip, last sync, base currency, rollover.
 * Reads via `lib/broker/accounts-repository.ts` (direct Postgres, ADR
 * 0006) rather than `lib/supabase/server.ts`'s `.from()` — see that ADR
 * for why the latter would 404 against the `retrospeq` schema today.
 *
 * This slice only ever produces `connected`/`disconnected` rows (Module
 * 02's sync worker is what would move an account to `syncing`/
 * `attention` — doesn't exist yet). `StatusChip` still handles every
 * status the column can hold, so it never silently mislabels a future
 * status it wasn't specifically written for.
 */

const ERROR_MESSAGES: Record<string, string> = {
  ACCOUNT_NOT_FOUND: "We couldn't find that account.",
  ACCOUNT_RATE_LIMITED: 'Too many attempts. Please wait a few minutes and try again.',
};

export default async function AccountsPage(props: PageProps<'/accounts'>) {
  const searchParams = await props.searchParams;
  const errorCode = typeof searchParams.error === 'string' ? searchParams.error : undefined;

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

  const accounts = await listTradingAccounts(user.id);

  return (
    <section className="flex flex-col gap-6" aria-labelledby="accounts-h">
      <div className="flex items-center justify-between">
        <h1 id="accounts-h" className="rq-h1">
          Your accounts
        </h1>
        <Link href="/accounts/connect" className="rq-btn">
          Connect an account
        </Link>
      </div>

      {errorCode && (
        <p className="rq-sub" role="alert">
          {ERROR_MESSAGES[errorCode] ?? 'Something went wrong. Please try again.'}
        </p>
      )}

      {accounts.length === 0 ? (
        <p className="rq-sub">
          No accounts yet. Connect a broker or add a manual account to get started.
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {accounts.map((account) => (
            <AccountCard key={account.id} account={account} />
          ))}
        </ul>
      )}
    </section>
  );
}

function AccountCard({ account }: { account: TradingAccountRow }) {
  const disconnected = account.status === 'disconnected';
  return (
    <li className="rq-card flex flex-col gap-3" data-status={account.status}>
      <div className="flex items-center justify-between">
        <h3 className="rq-h2">{account.label}</h3>
        <StatusChip status={account.status} statusDetail={account.status_detail} />
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <div>
          <dt className="rq-label">Platform</dt>
          <dd className="rq-body">{PLATFORM_LABELS[account.platform as keyof typeof PLATFORM_LABELS] ?? account.platform}</dd>
        </div>
        <div>
          <dt className="rq-label">Currency</dt>
          <dd className="rq-num">{account.base_currency}</dd>
        </div>
        <div>
          <dt className="rq-label">Day ends</dt>
          <dd className="rq-body">{account.day_rollover}</dd>
        </div>
        <div>
          <dt className="rq-label">Last sync</dt>
          <dd className="rq-sub">
            {account.last_sync_at ? account.last_sync_at : 'n/a'}
          </dd>
        </div>
      </dl>

      {disconnected && (
        <p className="rq-sub">
          Disconnected. Imported trade history, if any, is retained.
        </p>
      )}

      {!disconnected && (
        <div className="flex justify-end">
          <form action={disconnectAccount.bind(null, account.id)}>
            <button type="submit" className="rq-btn rq-btn--ghost">
              Disconnect
            </button>
          </form>
        </div>
      )}
    </li>
  );
}

/** Module 01 §5.3: "every status chip carries text, never colour alone."
 *  Built on `.rq-tag` (retrospeq-design-system/brand/css/components.css)
 *  — there is no dedicated chip component in the design system, and no
 *  red/green pair to build a status chip out of by design (AGENTS.md). */
function StatusChip({ status, statusDetail }: { status: string; statusDetail: string | null }) {
  const isConnected = status === 'connected';
  const label =
    status === 'connected'
      ? 'Connected'
      : status === 'syncing'
        ? 'Syncing'
        : status === 'attention'
          ? 'Needs attention'
          : status === 'disconnected'
            ? 'Disconnected'
            : 'Pending';

  return (
    <span
      className={isConnected ? 'rq-tag rq-tag--on' : 'rq-tag rq-tag--muted'}
      data-status={status}
      title={statusDetail ?? undefined}
    >
      {label}
    </span>
  );
}
