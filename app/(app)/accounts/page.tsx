import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { listTradingAccounts, type TradingAccountRow } from '@/lib/broker/accounts-repository';
import { PLATFORM_LABELS } from '@/lib/broker/platform-defaults';
import { disconnectAccount } from './actions';
import { attentionReason, formatDayRollover, formatLastSync } from './format';

/**
 * Module 01 §5.1/§5.2 "Account list", built against frame 6.5
 * (`brand/docs/screens/account.html#6.5`): one `.account-card` per
 * account carrying label, platform, a text status chip, and the meta
 * grid; "Needs attention" is an ink ring with a specific reason and its
 * fix as the card's one primary. Reads via
 * `lib/broker/accounts-repository.ts` (direct Postgres, ADR 0006)
 * rather than `lib/supabase/server.ts`'s `.from()` — see that ADR for
 * why the latter would 404 against the `retrospeq` schema today.
 *
 * Nothing in the app writes `syncing`/`attention` or a `status_detail`
 * code yet (Module 02's sync worker is what would — it doesn't exist).
 * Both states are rendered for real from the column anyway, so the
 * screen never mislabels a status it wasn't specifically written for,
 * and the reason copy degrades honestly when no code is present (see
 * `format.ts`).
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

  const rawAccounts = await listTradingAccounts(user.id);
  // Anything needing the trader's attention comes first. The repository
  // orders by `created_at desc` for its other callers, which buried the
  // one actionable card under disconnected ones (qa, 2026-09-17); sorting
  // a copy here leaves that shared order alone.
  const accounts = [...rawAccounts].sort((a, b) => {
    const rank = (status: string) => (status === 'attention' ? 0 : status === 'syncing' ? 1 : status === 'connected' ? 2 : 3);
    return rank(a.status) - rank(b.status);
  });

  return (
    <section className="accounts flex flex-col gap-5" aria-labelledby="accounts-h">
      <h1 id="accounts-h" className="rq-h1">
        Trading accounts
      </h1>

      {errorCode && (
        <div className="alert alert--blocking" role="alert">
          <p>{ERROR_MESSAGES[errorCode] ?? 'Something went wrong. Please try again.'}</p>
        </div>
      )}

      {accounts.length === 0 ? (
        <p className="rq-sub">
          No accounts yet. Connect a broker, or add a manual account and log your trades
          yourself.
        </p>
      ) : (
        <ul className="account-list">
          {accounts.map((account) => (
            <AccountCard key={account.id} account={account} />
          ))}
        </ul>
      )}

      {/* Ghost, not the primary: on a screen where an account needs
          attention, the fix on that card is the one thing worth doing
          (frame 6.5). */}
      <Link href="/accounts/connect" className="rq-btn rq-btn--ghost rq-btn--block">
        Add an account
      </Link>
    </section>
  );
}

function AccountCard({ account }: { account: TradingAccountRow }) {
  const needsAttention = account.status === 'attention';
  const disconnected = account.status === 'disconnected';
  const platformLabel =
    PLATFORM_LABELS[account.platform as keyof typeof PLATFORM_LABELS] ?? account.platform;

  return (
    <li className="account-card" data-status={account.status}>
      <div className="account-card__head">
        <h2 className="account-card__label">{account.label}</h2>
        <StatusChip status={account.status} statusDetail={account.status_detail} />
      </div>

      {needsAttention ? (
        <>
          <p className="account-card__reason">{attentionReason(account.status_detail)}</p>
          {/* NOT a "Reconnect" primary: no reconnect capability exists
              (qa FAIL, 2026-09-17). Re-submitting the same platform +
              `provider_ref` hits the unique index and is refused as
              `CONNECT_DUPLICATE_ACCOUNT`, and on Free the broken account
              still occupies the one-account cap, so the connect flow
              refuses before it starts. Offering a button that cannot
              work is worse than offering the one screen that can act on
              this account — inventory row 6.5 is ◐ until a real
              reconnect action exists. */}
          <Link href={`/accounts/${account.id}/settings`} className="link">
            Account settings
          </Link>
        </>
      ) : (
        <>
          <dl className="account-card__meta">
            <div>
              <dt>Platform</dt>
              <dd>{platformLabel}</dd>
            </div>
            <div>
              <dt>Currency</dt>
              <dd className="rq-num">{account.base_currency}</dd>
            </div>
            <div>
              <dt>Day ends</dt>
              <dd className="rq-num">{formatDayRollover(account.day_rollover)}</dd>
            </div>
            <div>
              <dt>Last sync</dt>
              <dd className="rq-num">
                {account.last_sync_at ? (
                  <time dateTime={account.last_sync_at}>{formatLastSync(account.last_sync_at)}</time>
                ) : (
                  formatLastSync(null)
                )}
              </dd>
            </div>
          </dl>

          {disconnected ? (
            <p className="account-card__reason">
              Disconnected. Your imported history and findings are kept.
            </p>
          ) : (
            <div className="account-card__actions">
              <Link href={`/accounts/${account.id}/settings`} className="link">
                Settings
              </Link>
              <form action={disconnectAccount.bind(null, account.id)}>
                <button type="submit" className="link">
                  Disconnect
                </button>
              </form>
            </div>
          )}
        </>
      )}
    </li>
  );
}

/** Module 01 §5.3: "every status chip carries text, never colour alone."
 *  `.chip` + `--ok`/`--attention`/`--syncing`/`--muted` (frame 6.5) —
 *  weight and edge only, no hue, since no red/green pair exists by
 *  design (AGENTS.md). */
function StatusChip({ status, statusDetail }: { status: string; statusDetail: string | null }) {
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
  const MODIFIERS: Record<string, string> = {
    connected: 'chip--ok',
    syncing: 'chip--syncing',
    attention: 'chip--attention',
    disconnected: 'chip--muted',
  };
  const label = KNOWN_LABELS[status] ?? humanizeStatus(status);
  const modifier = MODIFIERS[status] ?? 'chip--muted';

  return (
    // `status_detail` is an internal code — surfacing it as a tooltip
    // leaked vocabulary no trader should read (qa, 2026-09-17). The
    // human-readable reason is already rendered on the card itself.
    <span className={`chip ${modifier}`} data-status={status}>
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
