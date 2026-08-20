import 'server-only';
import { withServiceRoleConnection } from '@/lib/supabase/direct';
import { countUnusedRecoveryCodes } from '@/lib/auth/mfa-recovery-repository';
import { RECOVERY_CODE_COUNT } from '@/lib/auth/mfa-recovery-codes';

/**
 * Module 01 story 5.1: "JSON + CSV bundle ... of all user-owned rows"
 * (00-foundation §5.4). Pure-ish bundle-assembly logic, deliberately
 * separated from `export-job.ts`'s I/O orchestration (Storage upload,
 * signed URL, `data_requests` status updates) per this slice's own
 * dispatch: "keep the actual 'assemble the bundle' logic as a separate,
 * callable function that a future queue worker could call unchanged"
 * once Module 02 adds real trade-volume data and this can no longer run
 * synchronously inside a Server Action (§11's "< 5 min p95" budget).
 *
 * HONEST SCOPE, stated explicitly rather than left implicit: this repo
 * has no `fills`/`trades` tables yet (Module 02 isn't built) — the
 * export bundle below is every real, existing user-owned row today:
 * profile, trading accounts (credentials excluded — they are, by
 * design, unreadable even to the service role's own application code
 * path here; `account_credentials` is never queried by this function at
 * all), subscription, and MFA recovery-code metadata (a count, never the
 * codes themselves — those are one-way-hashed and were never retrievable
 * even before erasure). AGENTS.md "never invent fake export content" —
 * when Module 02 lands, this function grows a `trades`/`fills` section;
 * it does not fabricate one now.
 *
 * Runs under `withServiceRoleConnection` with an explicit `userId`
 * filter on every query (00-foundation §3.2) — this is what makes the
 * function callable by a future background worker with no live user
 * session, per the dispatch note above, not because the data itself
 * needs RLS bypassing (every table below has a working owner SELECT
 * policy `withUserConnection` could use instead).
 */

export interface ExportBundle {
  generatedAt: string;
  userId: string;
  profile: {
    displayName: string | null;
    locale: string;
    timezone: string;
    telemetryOptOut: boolean;
    onboardingStage: string;
    createdAt: string;
  } | null;
  tradingAccounts: Array<{
    id: string;
    label: string;
    platform: string;
    accountKind: string;
    baseCurrency: string;
    dayRollover: string;
    syncTier: string;
    status: string;
    connectedAt: string | null;
    disconnectedAt: string | null;
    createdAt: string;
  }>;
  subscription: {
    plan: string;
    status: string;
    currentPeriodEnd: string | null;
  } | null;
  mfa: {
    recoveryCodesRemaining: number;
    recoveryCodesIssued: number;
  };
}

export async function buildExportBundle(userId: string): Promise<ExportBundle> {
  const profile = await withServiceRoleConnection(async (client) => {
    const res = await client.query(
      `select display_name, locale, timezone, telemetry_opt_out, onboarding_stage, created_at
         from retrospeq.profiles
        where id = $1`,
      [userId],
    );
    return res.rows[0] ?? null;
  });

  const tradingAccounts = await withServiceRoleConnection(async (client) => {
    const res = await client.query(
      `select id, label, platform, account_kind, base_currency, day_rollover,
              sync_tier, status, connected_at, disconnected_at, created_at
         from retrospeq.trading_accounts
        where user_id = $1
        order by created_at asc`,
      [userId],
    );
    return res.rows;
  });

  const subscription = await withServiceRoleConnection(async (client) => {
    const res = await client.query(
      `select plan, status, current_period_end from retrospeq.subscriptions where user_id = $1`,
      [userId],
    );
    return res.rows[0] ?? null;
  });

  // `countUnusedRecoveryCodes` runs under `withUserConnection`, not
  // `withServiceRoleConnection` — safe here because `userId` is always
  // sourced from the export request's own `data_requests.user_id`
  // (itself written by that user's RLS-enforced INSERT), never a
  // client-supplied value at this call site.
  const recoveryCodesRemaining = await countUnusedRecoveryCodes(userId);

  return {
    generatedAt: new Date().toISOString(),
    userId,
    profile: profile
      ? {
          displayName: profile.display_name,
          locale: profile.locale,
          timezone: profile.timezone,
          telemetryOptOut: profile.telemetry_opt_out,
          onboardingStage: profile.onboarding_stage,
          createdAt: profile.created_at,
        }
      : null,
    tradingAccounts: tradingAccounts.map((a) => ({
      id: a.id,
      label: a.label,
      platform: a.platform,
      accountKind: a.account_kind,
      baseCurrency: a.base_currency,
      dayRollover: a.day_rollover,
      syncTier: a.sync_tier,
      status: a.status,
      connectedAt: a.connected_at,
      disconnectedAt: a.disconnected_at,
      createdAt: a.created_at,
    })),
    subscription: subscription
      ? {
          plan: subscription.plan,
          status: subscription.status,
          currentPeriodEnd: subscription.current_period_end,
        }
      : null,
    mfa: {
      recoveryCodesRemaining,
      // Only ever 0 or RECOVERY_CODE_COUNT in this codebase today
      // (`replaceRecoveryCodes` always issues a full fresh batch) — not
      // itself queried, since `recoveryCodesRemaining > 0` already
      // implies a full batch exists.
      recoveryCodesIssued: recoveryCodesRemaining > 0 ? RECOVERY_CODE_COUNT : 0,
    },
  };
}

/** `tradingAccounts` is the only genuinely tabular section today — the
 *  CSV half of story 5.1's "JSON + CSV bundle." Once Module 02 exists,
 *  `trades`/`fills` become the natural CSV export target instead/as
 *  well; this function's shape (one flat table -> one CSV string) is
 *  written to extend, not to be replaced. */
export function tradingAccountsToCsv(bundle: ExportBundle): string {
  const headers = [
    'id',
    'label',
    'platform',
    'accountKind',
    'baseCurrency',
    'dayRollover',
    'syncTier',
    'status',
    'connectedAt',
    'disconnectedAt',
    'createdAt',
  ] as const;

  const escape = (value: unknown): string => {
    const s = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [headers.join(',')];
  for (const account of bundle.tradingAccounts) {
    lines.push(headers.map((h) => escape(account[h])).join(','));
  }
  return lines.join('\n');
}
