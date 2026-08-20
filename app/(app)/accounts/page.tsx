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
        <div className="flex justify-end gap-2">
          <Link href={`/accounts/${account.id}/settings`} className="rq-btn rq-btn--ghost">
            Settings
          </Link>
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
  // Flagged by retrospeq-qa (2026-08-21): the fallback previously
  // hardcoded 'Pending' for ANY unrecognised status, including the real
  // 'plan_limited' value story 4.4's downgrade path now writes
  // (lib/entitlements/downgrade.ts) — 'Pending' implies "still
  // connecting," which is actively misleading for a downgraded account.
  // Falls back to a readable version of the raw status string instead,
  // so an unrecognised value degrades honestly (never silently wrong)
  // rather than being mislabeled as something more reassuring than the
  // truth. `plan_limited` specifically reads as "Plan limited" this way
  // until a dedicated chip/copy exists for it (no module yet renders one
  // — same honest-degradation posture noted in downgrade.ts's own
  // doc comment).
  const KNOWN_LABELS: Record<string, string> = {
    connected: 'Connected',
    syncing: 'Syncing',
    attention: 'Needs attention',
    disconnected: 'Disconnected',
  };
  const label = KNOWN_LABELS[status] ?? humanizeStatus(status);

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

/** `'plan_limited'` -> `'Plan limited'`; `'some_future_status'` ->
 *  `'Some future status'`. A readable fallback for any status value
 *  this component doesn't have a dedicated label for yet — never
 *  crashes, never silently mislabels, per StatusChip's own comment.
 *  Exported for a direct unit test (`__tests__/humanize-status.test.ts`)
 *  — this repo has no React-rendering test infra (jsdom/testing-library
 *  aren't dependencies; UI is verified via the screenshot self-check
 *  convention instead), so the pure string-transformation logic that
 *  was the actual bug (mislabeling `plan_limited` as `'Pending'`) is
 *  what gets direct coverage, not a full component render. */
export function humanizeStatus(status: string): string {
  const words = status.split('_').filter(Boolean);
  if (words.length === 0) return status;
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');
}
