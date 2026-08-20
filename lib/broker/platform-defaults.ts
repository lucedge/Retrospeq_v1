import type { CredentialKind, Platform } from './adapter';

/**
 * Shared per-platform display/defaulting logic for the connect flow and
 * account list — Module 01 §5.2's reference markup and story 3.1/3.2's
 * rollover defaults. Kept separate from `lib/broker/accounts-repository.ts`
 * (pure domain lookups, no DB access) so both
 * `app/(app)/accounts/actions.ts` (writes) and `app/(app)/accounts/page.tsx`
 * (reads/display) share one source instead of duplicating the mapping.
 */

export const PLATFORM_LABELS: Record<Platform, string> = {
  mt4: 'MetaTrader 4',
  mt5: 'MetaTrader 5',
  ctrader: 'cTrader',
  binance: 'Binance',
  bybit: 'Bybit',
  manual: 'Manual (no API)',
};

/** Story 2.7: manual accounts never ask for a credential — every other
 *  platform in this list requires one before the fixture adapter runs. */
export const CREDENTIALED_PLATFORMS = ['mt4', 'mt5', 'ctrader', 'binance', 'bybit'] as const;

export function isCredentialedPlatform(
  platform: Platform,
): platform is (typeof CREDENTIALED_PLATFORMS)[number] {
  return (CREDENTIALED_PLATFORMS as readonly string[]).includes(platform);
}

/** Story 2.1/2.3: MT-style platforms ask for an investor password;
 *  exchange-style platforms ask for a read-only API key. */
export function credentialKindForPlatform(platform: Platform): CredentialKind {
  switch (platform) {
    case 'mt4':
    case 'mt5':
    case 'ctrader':
      return 'investor_password';
    case 'binance':
    case 'bybit':
      return 'api_key';
    case 'manual':
      throw new Error('credentialKindForPlatform: manual accounts have no credential.');
  }
}

/**
 * Module 01 §4.1 step 8 / stories 3.1-3.2: "Default from adapter;
 * editable" (forex) / "Default for crypto accounts; editable" (crypto).
 * No real adapter exists yet to ask (00-foundation §10.1's vendor gap),
 * so this is a per-platform-class default — the same broker-class
 * reasoning the account-list reference markup's own worked example uses
 * ("17:00 New York" for an MT5/FTMO account). Editing this value is
 * story 3.1/3.2's own settings screen, out of scope for this connect-flow
 * slice.
 */
export function defaultDayRolloverForPlatform(platform: Platform): string {
  switch (platform) {
    case 'mt4':
    case 'mt5':
    case 'ctrader':
      return 'America/New_York 17:00';
    case 'binance':
    case 'bybit':
    case 'manual':
      return '00:00:00 UTC';
  }
}

/**
 * No real adapter exposes account-level currency yet (`TierFlags` has no
 * currency field — 00-foundation §10.1's `BrokerAdapter` interface only
 * carries currency per-`Fill`/`Position`, not per-account). USD is a
 * placeholder default, editable via story 3.x's account settings screen
 * once it exists — not a claim that every trader's base currency is USD.
 */
export function defaultBaseCurrencyForPlatform(_platform: Platform): string {
  return 'USD';
}

export function defaultLabelForPlatform(platform: Platform): string {
  return `${PLATFORM_LABELS[platform]} account`;
}

/**
 * Module 01 §3.1's `trading_accounts.account_kind` values (migration
 * comment: `personal | prop | demo`). Defined here, not in
 * `lib/broker/accounts-repository.ts`, so client components (e.g. the
 * account-settings form, story 3.1-3.4) can import it without pulling in
 * that file's `import 'server-only'` + direct-`pg` dependency chain —
 * this file is deliberately "pure domain lookups, no DB access" (see its
 * own header comment) and safe for both server and client bundles.
 * `accounts-repository.ts` re-exports these rather than redefining them,
 * so there is exactly one source of truth.
 */
export const ACCOUNT_KINDS = ['personal', 'prop', 'demo'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];
