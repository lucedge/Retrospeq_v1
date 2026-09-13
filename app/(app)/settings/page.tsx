import Link from 'next/link';
import { signOut } from '../../(auth)/actions';

/**
 * Settings index — the one entry point for account-level screens that
 * don't belong in Module 08 §7.5's four tabs (accounts, plan, security,
 * privacy) plus sign-out, which moved here from the old header chrome.
 * No new behaviour: every row links to an existing, already-reviewed
 * route; sign-out is the same `signOut` Server Action as before.
 */

const ROWS = [
  { href: '/accounts', label: 'Trading accounts', hint: 'Connected brokers and manual accounts' },
  { href: '/plan', label: 'Plan', hint: 'Free or Pro, and what you’re using' },
  { href: '/security', label: 'Security', hint: 'Two-factor authentication and sessions' },
  { href: '/privacy', label: 'Privacy', hint: 'Export, delete, telemetry' },
];

export default function SettingsPage() {
  return (
    <section aria-labelledby="settings-h" className="flex flex-col gap-6">
      <h1 id="settings-h" className="rq-h1">
        Settings
      </h1>

      <ul className="flex flex-col">
        {ROWS.map((row) => (
          <li key={row.href} className="border-b border-line first:border-t">
            <Link href={row.href} className="flex min-h-14 items-center justify-between gap-4 py-3">
              <span className="flex flex-col">
                <span className="rq-body font-semibold text-ink">{row.label}</span>
                <span className="rq-sub">{row.hint}</span>
              </span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-ink-faint" aria-hidden="true">
                <path d="m9 6 6 6-6 6" />
              </svg>
            </Link>
          </li>
        ))}
      </ul>

      <form action={signOut}>
        <button type="submit" className="rq-btn rq-btn--ghost rq-btn--block">
          Sign out
        </button>
      </form>
    </section>
  );
}
